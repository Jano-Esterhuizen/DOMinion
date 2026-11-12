import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { type ClassDeclaration, Node, Project, Scope, type SourceFile, SyntaxKind } from "ts-morph";
import { importConsumerModule } from "../config/loader";
import { DominionError, errorMessage } from "../errors";
import { isInside, relativePosix, toPosix } from "../fs";
import { PLAYWRIGHT_CONFIG_NAMES } from "../init/detect";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".dominion", ".auth", "test-results", "playwright-report"]);
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE_RE = /\.(spec|test)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Every playwright.config.* in the repo (monorepos have several), as repo-relative paths. */
export function findPlaywrightConfigsInRepo(root: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const names = new Set<string>(PLAYWRIGHT_CONFIG_NAMES);
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), depth + 1);
      } else if (names.has(entry.name)) {
        found.push(relativePosix(root, join(dir, entry.name)));
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

export interface PlaywrightProjectInfo {
  name: string;
  /** Absolute test directory. */
  testDir: string;
  dependencies: string[];
  /** use.storageState when it is a path (relative to the config folder). */
  storageState?: string;
  testMatch?: string;
  /** Looks like a setup project (matches *.setup.* or is a dependency of another project). */
  isSetup: boolean;
  /** testMatch and testIgnore as Playwright applies them (the project's, else the config's). */
  matchers: { testMatch?: FileMatcher; testIgnore?: FileMatcher };
}

/** A Playwright testMatch / testIgnore value: globs and regular expressions. */
export type FileMatcher = Array<string | RegExp>;

function toMatcher(value: unknown): FileMatcher | undefined {
  const list = (Array.isArray(value) ? value : [value]).filter((v): v is string | RegExp => typeof v === "string" || v instanceof RegExp);
  return list.length ? list : undefined;
}

function escapeRe(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts a Playwright glob to a RegExp the way Playwright applies it: against the absolute
 * path, with relative globs anchored anywhere (a `**\/` prefix), case-insensitive. Supports `**`,
 * `*`, `?`, `{a,b}`, character classes and the `@(a|b)` / `?(a|b)` / `+(a|b)` extglobs.
 */
export function globToRegExp(glob: string): RegExp {
  let g = toPosix(glob);
  if (!/^([A-Za-z]:)?\//.test(g) && !g.startsWith("**/")) g = `**/${g}`;
  const alternatives = (body: string) => body.split("|").map((alt) => alt.split("*").map(escapeRe).join("[^/]*")).join("|");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    const next = g[i + 1];
    if ((c === "@" || c === "?" || c === "+") && next === "(") {
      const end = g.indexOf(")", i);
      const group = `(?:${alternatives(g.slice(i + 2, end))})`;
      re += c === "@" ? group : c === "?" ? `${group}?` : `${group}+`;
      i = end;
    } else if (c === "*" && next === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      re += `(?:${g.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      re += g.slice(i, end + 1);
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, "i");
}

/** Whether a Playwright matcher matches an absolute file path. */
export function matcherMatches(matcher: FileMatcher, absFile: string): boolean {
  const posix = toPosix(absFile);
  return matcher.some((m) => {
    if (m instanceof RegExp) {
      m.lastIndex = 0;
      const native = m.test(absFile);
      m.lastIndex = 0;
      return native || m.test(posix);
    }
    return globToRegExp(m).test(posix);
  });
}

/** Playwright's default testMatch. */
const DEFAULT_TEST_MATCH: FileMatcher = ["**/*.@(spec|test).?(c|m)[jt]s?(x)"];

/** Whether a project would run a test file (inside its testDir, matched by testMatch, not ignored). */
export function projectRunsFile(project: PlaywrightProjectInfo, absFile: string): boolean {
  if (!isInside(project.testDir, absFile)) return false;
  if (!matcherMatches(project.matchers.testMatch ?? DEFAULT_TEST_MATCH, absFile)) return false;
  return !(project.matchers.testIgnore && matcherMatches(project.matchers.testIgnore, absFile));
}

export interface PlaywrightConfigInfo {
  configPath: string;
  /** Absolute top-level testDir. */
  testDir: string;
  projects: PlaywrightProjectInfo[];
  baseURL?: string;
  testIdAttribute?: string;
  globalSetup?: string;
  storageState?: string;
}

interface RawProject {
  name?: string;
  testDir?: string;
  testMatch?: unknown;
  testIgnore?: unknown;
  dependencies?: string[];
  use?: { storageState?: unknown; baseURL?: string; testIdAttribute?: string };
}

interface RawConfig {
  testDir?: string;
  testMatch?: unknown;
  testIgnore?: unknown;
  globalSetup?: string | string[];
  use?: { storageState?: unknown; baseURL?: string; testIdAttribute?: string };
  projects?: RawProject[];
}

function matcherText(value: unknown): string | undefined {
  if (value instanceof RegExp) return value.source;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(matcherText).filter(Boolean).join(" | ");
  return undefined;
}

/**
 * Loads the user's Playwright config without modifying it (jiti, like Playwright's own TS
 * loading) and records testDir, projects, baseURL, testIdAttribute, globalSetup and storage state.
 */
export async function readPlaywrightConfig(configPath: string): Promise<PlaywrightConfigInfo> {
  let raw: RawConfig;
  try {
    raw = (await importConsumerModule<RawConfig>(configPath)) ?? {};
  } catch (error) {
    throw new DominionError(`Could not load ${basename(configPath)}: ${errorMessage(error)}`, {
      code: "PLAYWRIGHT_CONFIG_LOAD_FAILED",
      hint: "Make sure `npx playwright test --list` works in this project.",
    });
  }
  const configDir = dirname(configPath);
  const testDir = resolve(configDir, raw.testDir ?? ".");
  const dependedOn = new Set((raw.projects ?? []).flatMap((p) => p.dependencies ?? []));
  const projects = (raw.projects ?? []).map((p, index): PlaywrightProjectInfo => {
    const name = p.name ?? `project-${index + 1}`;
    const testMatch = matcherText(p.testMatch);
    const storage = p.use?.storageState ?? raw.use?.storageState;
    return {
      name,
      testDir: p.testDir ? resolve(configDir, p.testDir) : testDir,
      dependencies: p.dependencies ?? [],
      storageState: typeof storage === "string" ? toPosix(storage) : undefined,
      testMatch,
      isSetup: /setup/i.test(testMatch ?? "") || dependedOn.has(name),
      matchers: { testMatch: toMatcher(p.testMatch ?? raw.testMatch), testIgnore: toMatcher(p.testIgnore ?? raw.testIgnore) },
    };
  });
  const globalSetup = Array.isArray(raw.globalSetup) ? raw.globalSetup[0] : raw.globalSetup;
  return {
    configPath,
    testDir,
    projects,
    baseURL: raw.use?.baseURL ?? raw.projects?.find((p) => p.use?.baseURL)?.use?.baseURL,
    testIdAttribute: raw.use?.testIdAttribute ?? raw.projects?.find((p) => p.use?.testIdAttribute)?.use?.testIdAttribute,
    globalSetup: globalSetup ? resolve(configDir, globalSetup) : undefined,
    storageState: typeof raw.use?.storageState === "string" ? toPosix(raw.use.storageState) : undefined,
  };
}

export interface FixtureInfo {
  /** Repo-relative file. */
  file: string;
  /** Exported test object name, usually "test". */
  exportName: string;
  /** Whether the same module exports expect. */
  exportsExpect: boolean;
  fixtures: string[];
}

export interface PageObjectInfo {
  file: string;
  className: string;
  methods: string[];
  /** Locator members: name -> the locator expression. */
  locators: Array<{ name: string; locator: string }>;
}

export interface HelperInfo {
  file: string;
  name: string;
}

export interface TestFileInfo {
  file: string;
  titles: string[];
  describes: string[];
  steps: string[];
  urls: string[];
  /** Module specifiers the file imports from. */
  imports: string[];
  lines: number;
  mtimeMs: number;
}

export interface SourceScan {
  fixtures: FixtureInfo[];
  pageObjects: PageObjectInfo[];
  helpers: HelperInfo[];
  testFiles: TestFileInfo[];
  naming: { spec: number; test: number };
  language: "ts" | "js";
  moduleFormat: "esm" | "cjs";
}

export function walkSources(dir: string, out: string[] = [], limit = 2000): string[] {
  if (!existsSync(dir) || out.length >= limit) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkSources(abs, out, limit);
    } else if (SOURCE_RE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
  return out;
}

function stringArg(node: Node | undefined): string | undefined {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralText();
  return undefined;
}

function playwrightImportNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sf.getImportDeclarations()) {
    if (!/^@playwright\/test$/.test(decl.getModuleSpecifierValue())) continue;
    for (const named of decl.getNamedImports()) names.add((named.getAliasNode() ?? named.getNameNode()).getText());
  }
  return names;
}

function pageObjectOf(cls: ClassDeclaration, file: string): PageObjectInfo | undefined {
  const ctor = cls.getConstructors()[0];
  const takesPage = ctor?.getParameters().some((p) => /\bPage\b/.test(p.getTypeNode()?.getText() ?? ""));
  if (!takesPage || !cls.getName()) return undefined;
  const locators: Array<{ name: string; locator: string }> = [];
  for (const prop of cls.getProperties()) {
    const init = prop.getInitializer()?.getText();
    if (init && /\b(getBy\w+|locator)\(/.test(init)) locators.push({ name: prop.getName(), locator: init.replace(/\s+/g, " ") });
  }
  ctor?.getDescendants().forEach((node) => {
    if (!Node.isBinaryExpression(node) || node.getOperatorToken().getText() !== "=") return;
    const left = node.getLeft().getText();
    const right = node.getRight().getText();
    if (left.startsWith("this.") && /\b(getBy\w+|locator)\(/.test(right)) {
      locators.push({ name: left.slice(5), locator: right.replace(/\s+/g, " ") });
    }
  });
  const methods = cls
    .getMethods()
    .filter((m) => m.getScope() !== Scope.Private && !m.getName().startsWith("#"))
    .map((m) => m.getName());
  return { file, className: cls.getName()!, methods, locators };
}

/**
 * Scans test sources with ts-morph: custom fixtures (calls to <playwright test>.extend), page objects
 * (classes whose constructor takes a Page), helpers (exported functions taking a Page), and each
 * test file's titles, steps and visited URLs.
 */
export function scanSources(root: string, testDir: string, packageType?: string): SourceScan {
  const files = walkSources(testDir);
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: true } });
  const scan: SourceScan = { fixtures: [], pageObjects: [], helpers: [], testFiles: [], naming: { spec: 0, test: 0 }, language: "ts", moduleFormat: "esm" };
  let tsCount = 0;
  let requireCount = 0;
  for (const abs of files) {
    let sf: SourceFile;
    try {
      sf = project.addSourceFileAtPath(abs);
    } catch {
      continue;
    }
    const file = relativePosix(root, abs);
    if (/\.(ts|tsx|mts|cts)$/.test(abs)) tsCount++;
    if (/\brequire\(\s*["']@playwright\/test["']\s*\)/.test(sf.getFullText())) requireCount++;
    const pwNames = playwrightImportNames(sf);

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === "extend" && pwNames.has(callee.getExpression().getText())) {
        const decl = call.getFirstAncestor((a) => Node.isVariableDeclaration(a));
        const exportName = decl && Node.isVariableDeclaration(decl) ? decl.getName() : "test";
        const arg = call.getArguments()[0];
        const fixtures = arg && Node.isObjectLiteralExpression(arg) ? arg.getProperties().map((p) => (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) ? p.getName() : p.getText().split(/[:(]/)[0]!.trim())) : [];
        const text = sf.getFullText();
        scan.fixtures.push({ file, exportName, exportsExpect: /export\s*\{[^}]*\bexpect\b[^}]*\}|export\s+(const|let)\s+expect\b/.test(text), fixtures });
      }
    }
    for (const cls of sf.getClasses()) {
      const po = pageObjectOf(cls, file);
      if (po) scan.pageObjects.push(po);
    }
    for (const fn of sf.getFunctions()) {
      if (fn.isExported() && fn.getName() && fn.getParameters().some((p) => /\bPage\b/.test(p.getTypeNode()?.getText() ?? ""))) {
        scan.helpers.push({ file, name: fn.getName()! });
      }
    }

    if (TEST_FILE_RE.test(abs)) {
      if (/\.spec\./.test(abs)) scan.naming.spec++;
      else scan.naming.test++;
      const info: TestFileInfo = { file, titles: [], describes: [], steps: [], urls: [], imports: sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue()), lines: sf.getEndLineNumber(), mtimeMs: statSync(abs).mtimeMs };
      for (const call of sf.getDescendants().filter(Node.isCallExpression)) {
        const callee = call.getExpression().getText();
        const first = stringArg(call.getArguments()[0]);
        if (!first) continue;
        if (/^(test|it)(\.(only|skip|fixme|slow|fail))?$/.test(callee) && call.getArguments().length >= 2) info.titles.push(first);
        else if (/\.describe(\.(serial|parallel|only|skip|fixme))?$/.test(callee)) info.describes.push(first);
        else if (/\.step$/.test(callee)) info.steps.push(first);
        else if (/\.goto$/.test(callee)) info.urls.push(first);
      }
      scan.testFiles.push(info);
    }
  }
  scan.language = tsCount >= files.length / 2 || files.length === 0 ? "ts" : "js";
  scan.moduleFormat = packageType === "module" || requireCount === 0 ? "esm" : "cjs";
  return scan;
}

/** 2-3 representative tests: use the detected fixtures, typical length, recently modified. */
export function pickExemplars(scan: SourceScan, max = 3): string[] {
  const candidates = scan.testFiles.filter((t) => t.titles.length > 0);
  if (candidates.length === 0) return [];
  const sortedLines = [...candidates].map((c) => c.lines).sort((a, b) => a - b);
  const median = sortedLines[Math.floor(sortedLines.length / 2)]!;
  const fixtureFiles = scan.fixtures.map((f) => f.file.replace(/\.(ts|js|mts|mjs)$/, ""));
  const usesFixtures = (t: TestFileInfo) =>
    t.imports.some((spec) => spec.startsWith(".") && fixtureFiles.some((f) => toPosix(join(dirname(t.file), spec)).replace(/\.(ts|js)$/, "") === f));
  const newest = Math.max(...candidates.map((c) => c.mtimeMs));
  const oldest = Math.min(...candidates.map((c) => c.mtimeMs));
  const score = (t: TestFileInfo) =>
    (usesFixtures(t) ? 2 : 0) + (1 - Math.min(Math.abs(t.lines - median) / Math.max(median, 1), 1)) + (newest > oldest ? (t.mtimeMs - oldest) / (newest - oldest) : 0) * 0.5 + (t.steps.length ? 0.5 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.file.localeCompare(b.file)).slice(0, max).map((t) => t.file);
}

export interface ProjectScan {
  config: PlaywrightConfigInfo;
  source: SourceScan;
  exemplars: string[];
}

/** Deterministic scan of an existing Playwright setup (spec: Detection during init). */
export async function scanProject(root: string, configPath: string): Promise<ProjectScan> {
  const absConfig = isAbsolute(configPath) ? configPath : resolve(root, configPath);
  const config = await readPlaywrightConfig(absConfig);
  let packageType: string | undefined;
  try {
    packageType = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { type?: string }).type;
  } catch {
    packageType = undefined;
  }
  const testDirs = [...new Set([config.testDir, ...config.projects.map((p) => p.testDir)])].filter((d) => !relative(config.testDir, d).startsWith("..") || d === config.testDir);
  const source = scanSources(root, testDirs[0] ?? config.testDir, packageType);
  return { config, source, exemplars: pickExemplars(source) };
}

export function extensionOf(file: string): string {
  return extname(file);
}
