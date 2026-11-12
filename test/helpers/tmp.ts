import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_ROOT = join(REPO_ROOT, "test", ".tmp");

/**
 * Creates a temp directory inside the repo (test/.tmp, gitignored) so that bare imports such as
 * "@playwright/test" resolve to the repo's node_modules exactly as they would in a consumer repo.
 */
export function makeTempDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `${prefix}-`));
}

export function removeDir(dir: string): void {
  if (process.env.DOMINION_KEEP_TMP) return; // keep temp consumers around for debugging
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

/** A minimal consumer project with Playwright already set up. */
export function makePlaywrightProject(prefix: string, extra: Record<string, string> = {}): string {
  const root = makeTempDir(prefix);
  writeFiles(root, {
    "package.json": JSON.stringify({ name: "consumer-app", private: true, type: "module" }, null, 2),
    "playwright.config.ts": [
      'import { defineConfig, devices } from "@playwright/test";',
      "",
      "export default defineConfig({",
      '  testDir: "./tests",',
      "  projects: [",
      '    { name: "chromium", use: { ...devices["Desktop Chrome"] } },',
      "  ],",
      "});",
      "",
    ].join("\n"),
    ...extra,
  });
  return root;
}

export interface FileSnapshot {
  hash: string;
  mtimeMs: number;
}

/** Content hash and mtime of every file under `root` (node_modules excluded). */
export function snapshotTree(root: string): Record<string, FileSnapshot> {
  const out: Record<string, FileSnapshot> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(root, abs).replace(/\\/g, "/")}/`] = { hash: "dir", mtimeMs: 0 };
        walk(abs);
      } else {
        out[relative(root, abs).replace(/\\/g, "/")] = {
          hash: createHash("sha256").update(readFileSync(abs)).digest("hex"),
          mtimeMs: statSync(abs).mtimeMs,
        };
      }
    }
  };
  walk(root);
  return out;
}
