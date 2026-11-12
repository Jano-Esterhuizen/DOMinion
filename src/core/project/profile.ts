import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { Node, type ObjectLiteralExpression, Project } from "ts-morph";
import type { ProjectProfile } from "../config/schema";
import { relativePosix, toPosix } from "../fs";
import type { ProjectScan } from "./scan";

export interface ProfileDraft {
  profile: ProjectProfile;
  /** What was detected vs defaulted, shown to the user before confirming. */
  notes: string[];
}

function commonDir(files: string[]): string | undefined {
  if (!files.length) return undefined;
  const parts = files.map((f) => posix.dirname(f).split("/"));
  const common: string[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    const segment = parts[0]![i]!;
    if (parts.every((p) => p[i] === segment)) common.push(segment);
    else break;
  }
  return common.join("/") || undefined;
}

/** Import specifier from a folder to a module file, e.g. "../fixtures". */
export function importSpecifier(fromDir: string, toFile: string): string {
  let rel = posix.relative(fromDir, toFile).replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/, "");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Builds the `project` profile from a scan (spec: Project profile). */
export function buildProfile(root: string, scan: ProjectScan): ProfileDraft {
  const notes: string[] = [];
  const { config, source } = scan;
  const playwrightConfig = relativePosix(root, config.configPath);
  const testDir = relativePosix(root, config.testDir);
  const outputDir = `${testDir}/generated`;
  notes.push(`outputDir defaults to ${outputDir} (inside your testDir, so your existing CI runs the generated tests).`);

  const language = source.language;
  const preferTest = source.naming.test > source.naming.spec;
  const ext = language === "ts" ? "ts" : "js";
  const fileNaming = `{flow}.${preferTest ? "test" : "spec"}.${ext}`;
  if (source.naming.test + source.naming.spec === 0) notes.push(`No tests found to detect file naming; using ${fileNaming}.`);

  let testImport = 'import { test, expect } from "@playwright/test"';
  const fixture = source.fixtures.find((f) => f.exportName === "test") ?? source.fixtures[0];
  if (fixture) {
    const spec = importSpecifier(outputDir, fixture.file);
    testImport = fixture.exportsExpect
      ? `import { ${fixture.exportName === "test" ? "test" : `${fixture.exportName} as test`}, expect } from "${spec}"`
      : `import { ${fixture.exportName === "test" ? "test" : `${fixture.exportName} as test`} } from "${spec}";\nimport { expect } from "@playwright/test"`;
  } else {
    notes.push("No custom fixtures (test.extend) found; generated tests import from @playwright/test.");
  }

  const poDir = commonDir(source.pageObjects.map((p) => p.file));
  if (!poDir) notes.push("No class-based page objects found.");

  const setup = config.projects.find((p) => p.isSetup);
  const runProject = config.projects.find((p) => setup && p.dependencies.includes(setup.name)) ?? config.projects.find((p) => !p.isSetup);
  const storageState = runProject?.storageState ?? config.storageState;
  let auth: ProjectProfile["auth"];
  if (storageState && setup) {
    auth = { strategy: "existing", setupProject: setup.name, storageState };
  } else if (storageState && config.globalSetup) {
    auth = { strategy: "existing", globalSetup: relativePosix(root, config.globalSetup), storageState };
  } else {
    notes.push("No setup project or globalSetup with a storage state found; configure a form or manual role for logged-in flows.");
  }

  const profile: ProjectProfile = {
    playwrightConfig,
    testDir,
    outputDir,
    fileNaming,
    language,
    moduleFormat: source.moduleFormat,
    testImport,
    ...(poDir ? { pageObjects: { dir: poDir, style: "class" as const, reuse: true } } : {}),
    exemplars: scan.exemplars,
    ...(auth ? { auth } : {}),
    modifyExisting: false,
    ...(runProject ? { runProject: runProject.name } : {}),
  };
  return { profile, notes };
}

function tsString(value: string): string {
  if (value.includes("\n")) return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
  return value.includes('"') && !value.includes("'") ? `'${value}'` : JSON.stringify(value);
}

function tsValue(value: unknown, indent: string): string {
  if (typeof value === "string") return tsString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => tsValue(v, indent)).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{ ${entries.map(([k, v]) => `${k}: ${tsValue(v, indent)}`).join(", ")} }`;
  }
  return "undefined";
}

/** Renders `project: { ... },` as TypeScript for dominion.config.ts. */
export function renderProfile(profile: ProjectProfile, indent = "  "): string {
  const inner = `${indent}  `;
  const lines = Object.entries(profile)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => `${inner}${key}: ${tsValue(value, inner)},`);
  return `${indent}project: {\n${lines.join("\n")}\n${indent}},`;
}

function configObjectOf(text: string): ObjectLiteralExpression | undefined {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile("dominion.config.ts", text, { overwrite: true });
  const exported = sf.getExportAssignment((e) => !e.isExportEquals())?.getExpression();
  if (!exported) return undefined;
  if (Node.isCallExpression(exported)) {
    const arg = exported.getArguments()[0];
    return arg && Node.isObjectLiteralExpression(arg) ? arg : undefined;
  }
  return Node.isObjectLiteralExpression(exported) ? exported : undefined;
}

/** Adds a project section to an existing dominion.config.ts. Returns false if it cannot or already has one. */
export function insertProfileIntoConfig(configPath: string, profile: ProjectProfile): boolean {
  const text = readFileSync(configPath, "utf8");
  const obj = configObjectOf(text);
  if (!obj || obj.getProperty("project")) return false;
  const props = obj.getProperties();
  const last = props[props.length - 1];
  const insertAt = last ? last.getEnd() + (text.slice(last.getEnd()).trimStart().startsWith(",") ? text.slice(last.getEnd()).indexOf(",") + 1 : 0) : obj.getStart() + 1;
  const needsComma = last && !text.slice(last.getEnd()).trimStart().startsWith(",");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = `${needsComma ? "," : ""}${eol}${eol}${renderProfile(profile).replace(/\n/g, eol)}`;
  writeFileSync(configPath, text.slice(0, insertAt) + block + text.slice(insertAt), "utf8");
  return true;
}

export interface DriftIssue {
  severity: "warn" | "error";
  message: string;
  hint?: string;
}

/** Compares the saved profile with a fresh scan (spec: doctor warns when the profile has drifted). */
export function profileDrift(root: string, profile: ProjectProfile, scan: ProjectScan | undefined): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const rerun = "Re-run `npx dominion init` to detect the project again, or update the project section of dominion.config.ts.";
  if (!existsSync(resolve(root, profile.playwrightConfig))) {
    return [{ severity: "error", message: `project.playwrightConfig ${profile.playwrightConfig} no longer exists.`, hint: rerun }];
  }
  if (!scan) return issues;
  const detectedTestDir = relativePosix(root, scan.config.testDir);
  if (toPosix(profile.testDir) !== detectedTestDir) {
    issues.push({ severity: "warn", message: `testDir moved: the profile says ${profile.testDir}, the Playwright config says ${detectedTestDir}.`, hint: rerun });
  }
  const importMatch = /from\s+["']([^"']+)["']/.exec(profile.testImport)?.[1];
  if (importMatch?.startsWith(".")) {
    const base = join(root, profile.outputDir, importMatch);
    if (![".ts", ".tsx", ".js", ".mjs", ".mts", "/index.ts", "/index.js"].some((ext) => existsSync(base + ext))) {
      issues.push({ severity: "warn", message: `The fixture module in testImport (${importMatch}) was not found from ${profile.outputDir}; was it renamed or moved?`, hint: rerun });
    }
  }
  if (profile.pageObjects && !existsSync(join(root, profile.pageObjects.dir))) {
    issues.push({ severity: "warn", message: `Page object folder ${profile.pageObjects.dir} no longer exists.`, hint: rerun });
  }
  const missingExemplars = profile.exemplars.filter((e) => !existsSync(join(root, e)));
  if (missingExemplars.length) issues.push({ severity: "warn", message: `Exemplar tests missing: ${missingExemplars.join(", ")}.`, hint: rerun });
  const projectNames = scan.config.projects.map((p) => p.name);
  if (profile.auth?.setupProject && !projectNames.includes(profile.auth.setupProject)) {
    issues.push({ severity: "error", message: `Setup project "${profile.auth.setupProject}" is not in ${profile.playwrightConfig} anymore.`, hint: rerun });
  }
  if (profile.runProject && !projectNames.includes(profile.runProject)) {
    issues.push({ severity: "error", message: `Project "${profile.runProject}" (project.runProject) is not in ${profile.playwrightConfig} anymore.`, hint: rerun });
  }
  const runProject = scan.config.projects.find((p) => p.name === profile.runProject);
  if (profile.auth?.storageState && runProject?.storageState && toPosix(runProject.storageState) !== toPosix(profile.auth.storageState)) {
    issues.push({ severity: "warn", message: `Storage state changed: the profile says ${profile.auth.storageState}, project "${runProject.name}" uses ${runProject.storageState}.`, hint: rerun });
  }
  const preferTest = scan.source.naming.test > scan.source.naming.spec;
  if (scan.source.naming.test + scan.source.naming.spec > 0 && profile.fileNaming.includes(preferTest ? ".spec." : ".test.")) {
    issues.push({ severity: "warn", message: `Most tests are now named *.${preferTest ? "test" : "spec"}.*, but the profile generates ${profile.fileNaming}.` });
  }
  return issues;
}

/** Absolute path of a profile path (relative to the repo root). */
export function profilePath(root: string, path: string): string {
  return resolve(root, path);
}

export function profileConfigDir(root: string, profile: ProjectProfile): string {
  return dirname(resolve(root, profile.playwrightConfig));
}
