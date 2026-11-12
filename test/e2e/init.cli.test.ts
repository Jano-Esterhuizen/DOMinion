import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCli } from "../helpers/cli";
import { makePlaywrightProject, REPO_ROOT, removeDir, snapshotTree } from "../helpers/tmp";

const CLI = join(REPO_ROOT, "dist", "cli", "index.js");

function runCli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("dominion CLI (built bin)", () => {
  let root: string;

  beforeAll(() => {
    buildCli();
    root = makePlaywrightProject("cli-init");
  });
  afterAll(() => removeDir(root));

  it("prints its version", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    const result = runCli(["--version"], root);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("init produces the expected files, and running it twice changes nothing", () => {
    const first = runCli(["init", "--yes", "--base-url", "https://staging.example.com"], root);
    expect(first.code, first.stderr).toBe(0);
    for (const path of ["dominion.config.ts", "dominion/auth/login.ts", ".env.local", ".gitignore", "specs", "tests/agent"]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(first.stdout).toContain("created");
    expect(first.stdout).toMatch(/authorized to test/);

    const before = snapshotTree(root);
    const second = runCli(["init", "--yes", "--base-url", "https://staging.example.com"], root);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).not.toMatch(/^\s+created/m);
    expect(second.stdout).toMatch(/skipped\s+dominion\.config\.ts/);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("exits non-zero with a hint on invalid input", () => {
    const fresh = makePlaywrightProject("cli-init-bad");
    try {
      const result = runCli(["init", "--yes", "--base-url", "not a url"], fresh);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/not a valid URL/);
      expect(result.stderr).toMatch(/--base-url/);
      expect(existsSync(join(fresh, "dominion.config.ts"))).toBe(false);
    } finally {
      removeDir(fresh);
    }
  });
});
