// Regressions for what the packaged-install walkthroughs (greenfield and existing suite) found.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envVarsReferencedBy } from "../../src/core/init";
import { ignoreTestsInProjects } from "../../src/core/playwright/patch";
import { globToRegExp, matcherMatches, type PlaywrightProjectInfo, projectRunsFile } from "../../src/core/project/scan";
import { credentialEnvVarsUsedBy } from "../../src/core/project/secrets";
import { redactorFor } from "../../src/core/redact";
import { validateConfig } from "../../src/core/config/loader";
import { makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

const dirs: string[] = [];
const tmp = (name: string) => {
  const dir = makeTempDir(name);
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach(removeDir));

/** What `npm init playwright@latest` writes (single quotes, multi-line projects, comments). */
const CREATE_PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    {
      name: 'webkit', // Safari
      use: { ...devices['Desktop Safari'] },
    },
    { name: 'already', testIgnore: /legacy/, use: {} },
  ],
});
`;

describe("keeping stock projects away from generated tests", () => {
  it("adds testIgnore after the project name, keeping the file's layout", () => {
    const dir = tmp("ignore");
    const config = join(dir, "playwright.config.ts");
    writeFileSync(config, CREATE_PLAYWRIGHT_CONFIG.replace(/\n/g, "\r\n"));
    const result = ignoreTestsInProjects(config, ["chromium", "webkit", "already", "missing"], "**/tests/agent/**");
    expect(result.patched).toEqual(["chromium", "webkit"]);
    expect(result.skipped).toEqual([
      { name: "already", reason: "it already sets testIgnore" },
      { name: "missing", reason: "it is not a literal { name: ... } entry in `projects`" },
    ]);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("      name: 'chromium',\r\n      testIgnore: \"**/tests/agent/**\",\r\n      use:");
    expect(text).toContain("      name: 'webkit', testIgnore: \"**/tests/agent/**\", // Safari");
    expect(text).toContain("    // {\r\n    //   name: 'firefox',"); // comments untouched
    expect(text.split("\r\n").length).toBe(CREATE_PLAYWRIGHT_CONFIG.split("\n").length + 1);
  });

  it("knows which projects would run a generated spec", () => {
    const project = (partial: Partial<PlaywrightProjectInfo>): PlaywrightProjectInfo => ({ name: "p", testDir: "/repo/tests", dependencies: [], isSetup: false, matchers: {}, ...partial });
    const spec = "/repo/tests/agent/cart/add-to-cart.spec.ts";
    expect(projectRunsFile(project({}), spec)).toBe(true);
    expect(projectRunsFile(project({ testDir: "/repo/e2e" }), spec)).toBe(false);
    expect(projectRunsFile(project({ matchers: { testIgnore: ["**/tests/agent/**"] } }), spec)).toBe(false);
    expect(projectRunsFile(project({ matchers: { testIgnore: [/agent/] } }), spec)).toBe(false);
    expect(projectRunsFile(project({ matchers: { testMatch: [/.*\.setup\.ts/] } }), spec)).toBe(false);
    expect(projectRunsFile(project({ matchers: { testMatch: ["**/*.spec.ts"] } }), spec)).toBe(true);
  });

  it("converts Playwright globs like Playwright does", () => {
    expect(globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)").test("/r/tests/a.spec.ts")).toBe(true);
    expect(globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)").test("/r/tests/a.test.mjs")).toBe(true);
    expect(globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)").test("/r/tests/helpers.ts")).toBe(false);
    expect(globToRegExp("agent/**").test("/r/tests/agent/x.spec.ts")).toBe(true); // relative: anywhere
    expect(globToRegExp("*.{spec,e2e}.ts").test("/r/a.e2e.ts")).toBe(true);
    expect(matcherMatches(["C:/repo/tests/agent/**"], "C:\\repo\\tests\\agent\\x.spec.ts")).toBe(true);
  });
});

describe("credentials an existing suite reads", () => {
  it("finds credential-like env vars in its sources, not settings", () => {
    const dir = tmp("secrets");
    writeFiles(dir, {
      "e2e/auth.setup.ts": 'await login(process.env.E2E_USER ?? "", process.env["E2E_PASS"]!);\nconst url = process.env.BASE_URL;',
      "e2e/api.ts": "headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }, ci: process.env.CI, key: process.env.ANTHROPIC_API_KEY",
    });
    expect(credentialEnvVarsUsedBy(dir, ["e2e/auth.setup.ts", "e2e/api.ts", "e2e/missing.ts"])).toEqual(["API_TOKEN", "E2E_PASS", "E2E_USER"]);
  });

  it("lists secretEnv names in .env.local", () => {
    expect(envVarsReferencedBy('  secretEnv: ["E2E_PASS", "E2E_USER"],\n  // secretEnv: ["NOPE"],\n  roles: { a: { strategy: "form", userEnv: "U", passEnv: "P" } }')).toEqual(["U", "P", "E2E_PASS", "E2E_USER"]);
  });

  it("redacts secretEnv values and credential-like .env.local entries, but not settings", () => {
    const dir = tmp("redact-env");
    const envFile = join(dir, ".env.local");
    writeFileSync(envFile, "E2E_PASS=hunter2-local-pass\nAPI_TOKEN=tok-local-123456\nBASE_URL=https://staging.example.com\n");
    const config = validateConfig({ secretEnv: ["SUITE_SECRET"], environments: { staging: { baseURL: "https://staging.example.com", roles: { guest: { strategy: "none" } } } } }, "test");
    const redactor = redactorFor({ config, envFile }, { SUITE_SECRET: "suite-secret-value", API_TOKEN: "tok-from-ci-999999" });
    expect(redactor.redact("a suite-secret-value b hunter2-local-pass c tok-from-ci-999999 d https://staging.example.com")).toBe(
      "a [REDACTED] b [REDACTED] c [REDACTED] d https://staging.example.com",
    );
  });
});
