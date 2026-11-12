import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ArrayLiteralExpression, Node, type ObjectLiteralExpression, Project, SyntaxKind } from "ts-morph";
import type { LoadedConfig } from "../config/loader";
import { listEnvironments, projectPaths, sessionFile } from "../config/resolve";
import { relativePosix } from "../fs";
import { packageName } from "../package-info";
import { renderTemplate } from "../templates";

export const MANAGED_START = "// --- dominion:start (managed, do not edit by hand) ---";
export const MANAGED_END = "// --- dominion:end ---";
export const SETUP_FILE_NAME = "dominion.setup.ts";

export interface ManagedProjectEntry {
  env: string;
  role: string;
  baseURL: string;
  /** Storage state path relative to the config file's folder; absent for guests. */
  storageState?: string;
  /** testDir relative to the config file's folder. */
  testDir: string;
  /** Matches the attribute the agents verified getByTestId locators with. */
  testIdAttribute?: string;
  /** `api` roles: also send the headers saved with the session (read when Playwright loads the config). */
  sessionHeaders?: boolean;
}

/** The import the managed block needs when an `api` role sends session headers. */
export function sessionHeadersImport(): string {
  return `import { sessionHeaders } from ${JSON.stringify(`${packageName()}/setup`)};`;
}

export function setupProjectName(env: string, role: string): string {
  return `dominion-setup-${env}-${role}`;
}

/** The test project generated tests run in for an env and role. */
export function testProjectName(env: string, role: string): string {
  return `dominion-${env}-${role}`;
}

function regexLiteral(text: string): string {
  return `/${text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;
}

/** Tag regex that matches @role:admin but not @role:admin-readonly. */
function tagRegex(tag: string): string {
  return `/${tag.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])/`;
}

/** Project entries for every env and role in the config, so the block is deterministic. */
export function managedEntries(loaded: LoadedConfig, configDir: string): ManagedProjectEntry[] {
  const paths = projectPaths(loaded);
  const entries: ManagedProjectEntry[] = [];
  for (const env of listEnvironments(loaded)) {
    for (const [role, roleConfig] of Object.entries(env.roles)) {
      entries.push({
        env: env.name,
        role,
        baseURL: env.baseURL,
        storageState: roleConfig.strategy === "none" ? undefined : relativePosix(configDir, sessionFile(paths, env.name, role)),
        testDir: relativePosix(configDir, paths.testDir),
        testIdAttribute: loaded.config.testIdAttribute,
        ...(roleConfig.strategy === "api" ? { sessionHeaders: true } : {}),
      });
    }
  }
  return entries;
}

/** Renders the managed block (spec: How generated tests get the session). */
export function renderManagedBlock(entries: readonly ManagedProjectEntry[], indent: string): string {
  const lines = [MANAGED_START];
  for (const e of entries) {
    const tag = tagRegex(`@role:${e.role}`);
    const testId = e.testIdAttribute ? `, testIdAttribute: ${JSON.stringify(e.testIdAttribute)}` : "";
    if (e.storageState) {
      const headers = e.sessionHeaders ? `, extraHTTPHeaders: sessionHeaders(${JSON.stringify(e.storageState)})` : "";
      lines.push(
        `{ name: ${JSON.stringify(setupProjectName(e.env, e.role))}, testDir: ${JSON.stringify(e.testDir)}, testMatch: /dominion\\.setup\\.ts/,`,
        `  metadata: { env: ${JSON.stringify(e.env)}, role: ${JSON.stringify(e.role)} } },`,
        `{ name: ${JSON.stringify(testProjectName(e.env, e.role))}, testDir: ${JSON.stringify(e.testDir)},`,
        `  use: { baseURL: ${JSON.stringify(e.baseURL)}, storageState: ${JSON.stringify(e.storageState)}${headers}${testId} },`,
        `  dependencies: [${JSON.stringify(setupProjectName(e.env, e.role))}], grep: ${tag} },`,
      );
    } else {
      lines.push(
        `{ name: ${JSON.stringify(testProjectName(e.env, e.role))}, testDir: ${JSON.stringify(e.testDir)},`,
        `  use: { baseURL: ${JSON.stringify(e.baseURL)}${testId} }, grep: ${tag} },`,
      );
    }
  }
  lines.push(MANAGED_END);
  return lines.map((line) => `${indent}${line}`).join("\n");
}

export interface PatchResult {
  status: "patched" | "unchanged" | "manual";
  configPath: string;
  /** For "manual": why the file could not be edited safely, and the snippet to add. */
  reason?: string;
  snippet?: string;
}

function configObject(text: string, fileName: string): ObjectLiteralExpression | undefined {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile(fileName, text, { overwrite: true });
  const unwrap = (node: Node | undefined): ObjectLiteralExpression | undefined => {
    if (!node) return undefined;
    if (Node.isObjectLiteralExpression(node)) return node;
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) return unwrap(node.getExpression());
    if (Node.isCallExpression(node) && /defineConfig$/.test(node.getExpression().getText())) {
      // defineConfig(base, { ... }) merges; the last object literal is where projects usually live.
      const objects = node.getArguments().filter((a) => Node.isObjectLiteralExpression(a)) as ObjectLiteralExpression[];
      return objects.find((o) => o.getProperty("projects")) ?? objects[objects.length - 1];
    }
    if (Node.isIdentifier(node)) {
      const decl = sf.getVariableDeclaration(node.getText());
      return unwrap(decl?.getInitializer());
    }
    return undefined;
  };
  const exported = sf.getExportAssignment((e) => !e.isExportEquals());
  if (exported) return unwrap(exported.getExpression());
  for (const stmt of sf.getStatements()) {
    const expr = Node.isExpressionStatement(stmt) ? stmt.getExpression() : undefined;
    if (expr && Node.isBinaryExpression(expr) && expr.getLeft().getText() === "module.exports") return unwrap(expr.getRight());
  }
  return undefined;
}

function needsHeadersImport(entries: readonly ManagedProjectEntry[]): boolean {
  return entries.some((e) => e.sessionHeaders && e.storageState);
}

/**
 * Adds the sessionHeaders import after the config's last import when an `api` role needs it.
 * Returns undefined when it cannot be added safely (a CommonJS config).
 */
function withHeadersImport(text: string, eol: string, entries: readonly ManagedProjectEntry[], fileName: string): string | undefined {
  if (!needsHeadersImport(entries)) return text;
  const line = sessionHeadersImport();
  if (text.includes(line)) return text;
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const imports = project.createSourceFile(fileName, text, { overwrite: true }).getImportDeclarations();
  if (imports.length === 0) {
    if (/\brequire\s*\(|module\.exports/.test(text)) return undefined;
    return `${line}${eol}${text}`;
  }
  const end = imports[imports.length - 1]!.getEnd();
  return `${text.slice(0, end)}${eol}${line}${text.slice(end)}`;
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Adds or refreshes the managed block of setup + test projects in a new project's
 * playwright.config.ts. Configs that cannot be edited safely (no literal projects array, projects
 * built dynamically) are left alone and the snippet is returned for the user to add.
 */
export function patchPlaywrightConfig(configPath: string, entries: readonly ManagedProjectEntry[]): PatchResult {
  const text = readFileSync(configPath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const startIdx = text.indexOf(MANAGED_START);
  const endIdx = text.indexOf(MANAGED_END);
  const fileName = configPath.endsWith(".ts") ? "playwright.config.ts" : "playwright.config.js";
  const snippet = `${needsHeadersImport(entries) ? `    // Also add at the top of the file: ${sessionHeadersImport()}\n` : ""}${renderManagedBlock(entries, "    ")}`;
  const manual = (reason: string): PatchResult => ({ status: "manual", configPath, reason, snippet });
  const commonJs = "it is a CommonJS config, so DOMinion cannot add the sessionHeaders import an api role needs";

  if (startIdx !== -1 && endIdx > startIdx) {
    const lineStart = text.lastIndexOf("\n", startIdx - 1) + 1;
    const indent = lineIndent(text, startIdx);
    const endLineEnd = endIdx + MANAGED_END.length;
    const block = renderManagedBlock(entries, indent).replace(/\n/g, eol);
    const next = withHeadersImport(text.slice(0, lineStart) + block + text.slice(endLineEnd), eol, entries, fileName);
    if (next === undefined) return manual(commonJs);
    if (next === text) return { status: "unchanged", configPath };
    writeFileSync(configPath, next, "utf8");
    return { status: "patched", configPath };
  }

  let obj: ObjectLiteralExpression | undefined;
  try {
    obj = configObject(text, fileName);
  } catch {
    return manual("the config could not be parsed");
  }
  if (!obj) return manual("the default export is not a literal defineConfig({ ... }) object");
  const prop = obj.getProperty("projects");
  if (!prop || !Node.isPropertyAssignment(prop)) {
    return manual("the config has no `projects` array; adding one would change which tests run");
  }
  const initializer = prop.getInitializer();
  if (!initializer || !Node.isArrayLiteralExpression(initializer)) {
    return manual("`projects` is built dynamically, so DOMinion cannot edit it safely");
  }
  const array = initializer as ArrayLiteralExpression;
  const elements = array.getElements();
  const indent = elements.length ? lineIndent(text, elements[0]!.getStart()) : `${lineIndent(text, array.getStart())}  `;
  const block = renderManagedBlock(entries, indent).replace(/\n/g, eol);
  const closePos = array.getEnd() - 1; // position of "]"
  const closingIndent = lineIndent(text, closePos);
  // Insert the block just before "]" (after any trailing comments), replacing the whitespace there.
  let wsStart = closePos;
  while (wsStart > 0 && /\s/.test(text[wsStart - 1]!)) wsStart--;
  let next = `${text.slice(0, wsStart)}${eol}${block}${eol}${closingIndent}${text.slice(closePos)}`;
  if (elements.length) {
    // A separating comma is a real token after the last element, never a comma inside a comment.
    const last = elements[elements.length - 1]!;
    if (!last.getNextSiblingIfKind(SyntaxKind.CommaToken)) next = `${next.slice(0, last.getEnd())},${next.slice(last.getEnd())}`;
  }
  const withImport = withHeadersImport(next, eol, entries, fileName);
  if (withImport === undefined) return manual(commonJs);
  next = withImport;
  // Re-parse before writing: anything ambiguous is left for the user instead of breaking their config.
  try {
    const check = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
    const sf = check.createSourceFile(configPath.endsWith(".ts") ? "check.ts" : "check.js", next, { overwrite: true });
    const syntaxErrors = check.getProgram().getSyntacticDiagnostics(sf);
    const projects = configObject(next, configPath.endsWith(".ts") ? "check.ts" : "check.js")?.getProperty("projects");
    const insideArray = projects && Node.isPropertyAssignment(projects) && projects.getInitializer()?.getText().includes(MANAGED_START) && projects.getInitializer()?.getText().includes(MANAGED_END);
    if (syntaxErrors.length || !insideArray) return manual("the patched file did not parse cleanly");
  } catch {
    return manual("the patched file could not be verified");
  }
  writeFileSync(configPath, next, "utf8");
  return { status: "patched", configPath };
}

export interface IgnoreResult {
  /** Projects that now ignore DOMinion's tests. */
  patched: string[];
  /** Projects left alone, with why (they already set testIgnore, or are not literal objects). */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Adds `testIgnore: "<pattern>"` to the named projects of a new project's Playwright config, so
 * projects such as create-playwright's "chromium" stop running DOMinion's generated tests
 * without DOMinion's baseURL and session. Projects that already set testIgnore are left alone.
 */
export function ignoreTestsInProjects(configPath: string, projectNames: readonly string[], pattern: string): IgnoreResult {
  const text = readFileSync(configPath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const fileName = configPath.endsWith(".ts") ? "playwright.config.ts" : "playwright.config.js";
  const result: IgnoreResult = { patched: [], skipped: [] };
  const skipAll = (reason: string): IgnoreResult => ({ patched: [], skipped: projectNames.map((name) => ({ name, reason })) });
  let obj: ObjectLiteralExpression | undefined;
  try {
    obj = configObject(text, fileName);
  } catch {
    return skipAll("the config could not be parsed");
  }
  const prop = obj?.getProperty("projects");
  const array = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
  if (!array || !Node.isArrayLiteralExpression(array)) return skipAll("`projects` is not a literal array");

  const inserts: Array<{ pos: number; text: string }> = [];
  for (const element of array.getElements()) {
    if (!Node.isObjectLiteralExpression(element)) continue;
    const nameProp = element.getProperty("name");
    const nameInit = nameProp && Node.isPropertyAssignment(nameProp) ? nameProp.getInitializer() : undefined;
    if (!nameProp || !nameInit || !(Node.isStringLiteral(nameInit) || Node.isNoSubstitutionTemplateLiteral(nameInit))) continue;
    const name = nameInit.getLiteralText();
    if (!projectNames.includes(name)) continue;
    if (element.getProperty("testIgnore")) {
      result.skipped.push({ name, reason: "it already sets testIgnore" });
      continue;
    }
    const property = `testIgnore: ${JSON.stringify(pattern)}`;
    const comma = nameProp.getNextSiblingIfKind(SyntaxKind.CommaToken);
    const anchor = comma ? comma.getEnd() : nameProp.getEnd();
    const lineEnd = text.indexOf("\n", anchor);
    const restOfLine = text.slice(anchor, lineEnd === -1 ? text.length : lineEnd);
    const insert = !comma ? `, ${property}` : restOfLine.trim() === "" ? `${eol}${lineIndent(text, nameProp.getStart())}${property},` : ` ${property},`;
    inserts.push({ pos: anchor, text: insert });
    result.patched.push(name);
  }
  for (const name of projectNames) {
    if (!result.patched.includes(name) && !result.skipped.some((s) => s.name === name)) result.skipped.push({ name, reason: "it is not a literal { name: ... } entry in `projects`" });
  }
  if (inserts.length === 0) return result;

  let next = text;
  for (const { pos, text: insert } of inserts.sort((a, b) => b.pos - a.pos)) next = next.slice(0, pos) + insert + next.slice(pos);
  const check = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const sf = check.createSourceFile(fileName, next, { overwrite: true });
  if (check.getProgram().getSyntacticDiagnostics(sf).length) return skipAll("the patched file did not parse cleanly");
  writeFileSync(configPath, next, "utf8");
  return result;
}

/** Writes <testDir>/dominion.setup.ts, which refreshes saved sessions before generated tests run. */
export function ensureSetupFile(testDir: string): { path: string; status: "created" | "updated" | "unchanged" | "foreign" } {
  const path = join(testDir, SETUP_FILE_NAME);
  const content = renderTemplate("dominion.setup.ts.tmpl", { packageName: packageName() });
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) return { path, status: "unchanged" };
    if (!current.startsWith("// Generated by DOMinion")) return { path, status: "foreign" };
    writeFileSync(path, content, "utf8");
    return { path, status: "updated" };
  }
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path, content, "utf8");
  return { path, status: "created" };
}

export function configDirOf(configPath: string): string {
  return dirname(configPath);
}
