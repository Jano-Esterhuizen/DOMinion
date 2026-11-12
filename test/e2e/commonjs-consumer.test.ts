import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import { projectPaths } from "../../src/core/config/resolve";
import { ensureSetupFile, managedEntries, patchPlaywrightConfig } from "../../src/core/playwright/patch";
import { loadPlaywright } from "../../src/core/playwright/resolve";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, linkDominionPackage, makeFixtureConsumer, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { removeDir, writeFiles } from "../helpers/tmp";

// Most Playwright projects have no "type": "module" (`npm init playwright` does not add it), so
// Playwright compiles their tests and config to require() calls. The generated dominion.setup.ts
// imports `@yourorg/dominion/setup`, which therefore needs a CommonJS build.
let fixture: FixtureApp;
let root: string;

beforeAll(async () => {
  buildCli();
  fixture = await startFixtureApp();
  root = makeFixtureConsumer("cjs", fixture.url, {
    files: {
      "package.json": JSON.stringify({ name: "commonjs-consumer", private: true }, null, 2),
      "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG,
    },
  });
  linkDominionPackage(root);
});

afterAll(async () => {
  await fixture?.close();
  if (root) removeDir(root);
});

describe("a CommonJS consumer project", () => {
  it("can require() both public entry points", () => {
    const check = spawnSync(
      process.execPath,
      ["-e", "const s = require('@yourorg/dominion/setup'); const d = require('@yourorg/dominion'); if (typeof s.setupSession !== 'function' || typeof s.sessionHeaders !== 'function' || typeof d.defineConfig !== 'function') process.exit(2);"],
      { cwd: root, encoding: "utf8" },
    );
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("runs DOMinion's setup project and a logged-in generated test through Playwright", async () => {
    const loaded = await loadConfig({ cwd: root });
    expect(patchPlaywrightConfig(join(root, "playwright.config.ts"), managedEntries(loaded, root)).status).toBe("patched");
    ensureSetupFile(projectPaths(loaded).testDir);
    writeFiles(root, {
      "tests/agent/account.spec.ts": [
        'import { test, expect } from "@playwright/test";',
        "",
        'test.describe("Account @dominion @flow:account @role:customer", () => {',
        '  test("opens the account page with the saved session", async ({ page }) => {',
        '    await page.goto("/account");',
        "    await expect(page).not.toHaveURL(/\\/login/);",
        "  });",
        "});",
        "",
      ].join("\n"),
    });
    const { cliPath } = await loadPlaywright(root);
    // Async: the fixture app runs in this process, so a blocking spawn would starve it.
    const run = await new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, "test", "--project=dominion-staging-customer", "--reporter=line"], {
        cwd: root,
        env: { ...process.env, ...FIXTURE_ENV, FORCE_COLOR: "0" },
      });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      child.on("close", (status) => resolve({ status, output }));
    });
    const output = run.output;
    expect(output).not.toContain("is not defined by \"exports\"");
    expect(run.status, output).toBe(0);
    expect(output).toContain("2 passed");
    expect(existsSync(join(root, ".auth", "staging-customer.json"))).toBe(true);
  });
});
