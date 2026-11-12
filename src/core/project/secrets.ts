import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CREDENTIAL_NAME_RE, WELL_KNOWN_SECRET_ENV_VARS } from "../redact";
import { type ProjectScan, walkSources } from "./scan";

const ENV_READ_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;

/**
 * Env vars an existing suite reads that look like credentials (E2E_USER, E2E_PASS, API_TOKEN):
 * its setup project and fixtures need them, so DOMinion lists them as `secretEnv` to redact them
 * and keep them away from agents. BASE_URL-style settings are not credentials and are left out.
 */
export function credentialEnvVarsUsedBy(root: string, files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const abs = isAbsolute(file) ? file : resolve(root, file);
    if (!existsSync(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(ENV_READ_RE)) {
      const name = match[1] ?? match[2]!;
      if (CREDENTIAL_NAME_RE.test(name) && !(WELL_KNOWN_SECRET_ENV_VARS as readonly string[]).includes(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Every source file under the suite's test folders (setup files such as auth.setup.ts included,
 * which is where credentials are usually read), plus the Playwright config and its globalSetup.
 */
export function scannedFiles(scan: ProjectScan, playwrightConfig: string): string[] {
  const testDirs = [...new Set([scan.config.testDir, ...scan.config.projects.map((p) => p.testDir)])];
  return [
    playwrightConfig,
    ...(scan.config.globalSetup ? [scan.config.globalSetup] : []),
    ...testDirs.flatMap((dir) => walkSources(dir)),
    ...scan.source.fixtures.map((f) => f.file),
    ...scan.source.pageObjects.map((f) => f.file),
    ...scan.source.helpers.map((f) => f.file),
  ];
}
