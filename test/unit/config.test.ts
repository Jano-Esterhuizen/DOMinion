import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findConfigFile, loadConfig, loadEnvFile, validateConfig } from "../../src/core/config/loader";
import {
  absoluteUrl,
  defaultRole,
  getEnvironment,
  getRole,
  matchesLoggedOutPattern,
  missingRoleEnvVars,
  projectPaths,
  referencedEnvVars,
  sessionFile,
} from "../../src/core/config/resolve";
import { DominionError } from "../../src/core/errors";
import { makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

const MINIMAL = {
  environments: {
    staging: {
      baseURL: "https://staging.example.com/",
      auth: { validate: { url: "/account", loggedOutPattern: "/login" } },
      roles: {
        guest: { strategy: "none" },
        customer: { strategy: "form", userEnv: "STAGING_CUSTOMER_USER", passEnv: "STAGING_CUSTOMER_PASS" },
        admin: {
          strategy: "form",
          userEnv: "STAGING_ADMIN_USER",
          passEnv: "STAGING_ADMIN_PASS",
          totpEnv: "STAGING_ADMIN_TOTP",
        },
      },
    },
    qa: { baseURL: "https://qa.example.com", roles: { sso_user: { strategy: "manual" } } },
  },
};

function expectConfigError(raw: unknown, pattern: RegExp) {
  try {
    validateConfig(raw, "dominion.config.ts");
  } catch (error) {
    expect(error).toBeInstanceOf(DominionError);
    expect((error as DominionError).message).toMatch(pattern);
    return;
  }
  throw new Error("expected validateConfig to throw");
}

describe("validateConfig", () => {
  it("applies defaults, including nested crawl and budget defaults", () => {
    const config = validateConfig(MINIMAL, "dominion.config.ts");
    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.testDir).toBe("tests/agent");
    expect(config.specsDir).toBe("specs");
    expect(config.pageObjects).toBe(true);
    expect(config.testIdAttribute).toBe("data-testid");
    expect(config.crawl).toEqual({ maxPages: 200, maxDepth: 4, exclude: [], keepQueryParams: [] });
    expect(config.budgets).toEqual({ maxTurnsPerAgent: 80, maxUsdPerRun: 10, maxHealAttempts: 3 });
    expect(config.agentBrowser).toEqual({ headless: true, browser: "chromium" });
    expect(config.environments.staging!.allowDestructive).toBe(false);
    expect(config.environments.staging!.auth!.loginUrl).toBe("/login");
    expect(config.environments.staging!.auth!.loginScript).toBe("./dominion/auth/login.ts");
  });

  it("keeps partial nested overrides", () => {
    const config = validateConfig({ ...MINIMAL, budgets: { maxUsdPerRun: 2 } }, "c");
    expect(config.budgets).toEqual({ maxTurnsPerAgent: 80, maxUsdPerRun: 2, maxHealAttempts: 3 });
  });

  it("rejects a secret value where an env var name belongs, pointing at the key", () => {
    const raw = structuredClone(MINIMAL) as any;
    raw.environments.staging.roles.customer.passEnv = "hunter2!";
    expectConfigError(raw, /environments\.staging\.roles\.customer\.passEnv: must be the NAME of an environment variable/);
  });

  it("rejects unknown keys", () => {
    expectConfigError({ ...MINIMAL, modle: "x" }, /unknown key "modle"/);
    const raw = structuredClone(MINIMAL) as any;
    raw.environments.staging.roles.customer.password = "x";
    expectConfigError(raw, /environments\.staging\.roles\.customer: unknown key "password"/);
  });

  it("rejects unknown strategies, bad URLs, bad origins and empty roles", () => {
    const badStrategy = structuredClone(MINIMAL) as any;
    badStrategy.environments.staging.roles.guest.strategy = "magic";
    expectConfigError(badStrategy, /environments\.staging\.roles\.guest/);
    expectConfigError({ environments: { s: { baseURL: "staging.example.com", roles: { g: { strategy: "none" } } } } }, /baseURL: must be an absolute http\(s\) URL/);
    expectConfigError(
      { environments: { s: { baseURL: "https://a.example.com", allowedOrigins: ["https://a.example.com/path"], roles: { g: { strategy: "none" } } } } },
      /allowedOrigins\.0: must be an origin/,
    );
    expectConfigError({ environments: { s: { baseURL: "https://a.example.com", roles: {} } } }, /define at least one role/);
    expectConfigError({ environments: {} }, /define at least one environment/);
    expectConfigError({ environments: { "bad name": { baseURL: "https://a.example.com", roles: { g: { strategy: "none" } } } } }, /environments/);
  });

  it("requires an object export", () => {
    expect(() => validateConfig(undefined, "dominion.config.ts")).toThrow(/must export a config object/);
  });

  it("accepts RegExp loggedOutPattern", () => {
    const raw = structuredClone(MINIMAL) as any;
    raw.environments.staging.auth.validate.loggedOutPattern = /\/(login|signin)/;
    const config = validateConfig(raw, "c");
    expect(config.environments.staging!.auth!.validate!.loggedOutPattern).toBeInstanceOf(RegExp);
  });
});

describe("loadConfig", () => {
  const dirs: string[] = [];
  const envKeys: string[] = [];
  afterEach(() => {
    while (dirs.length) removeDir(dirs.pop()!);
    while (envKeys.length) delete process.env[envKeys.pop()!];
  });

  it("loads a TypeScript config that imports defineConfig from the package name", async () => {
    const root = makeTempDir("load-config");
    dirs.push(root);
    writeFiles(root, {
      "package.json": '{"name":"consumer","type":"module"}',
      "dominion.config.ts": [
        'import { defineConfig } from "@yourorg/dominion";',
        "const base: string = 'https://staging.example.com';",
        "export default defineConfig({",
        "  model: 'claude-sonnet-5-5',",
        "  environments: { staging: { baseURL: base, roles: { guest: { strategy: 'none' } } } },",
        "});",
      ].join("\n"),
    });
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    const loaded = await loadConfig({ cwd: join(root, "nested", "deeper") });
    expect(loaded.root).toBe(root);
    expect(loaded.configPath).toBe(join(root, "dominion.config.ts"));
    expect(loaded.config.environments.staging!.baseURL).toBe("https://staging.example.com");
  });

  it("reads .env.local without overriding variables already in the environment", async () => {
    const root = makeTempDir("load-env");
    dirs.push(root);
    envKeys.push("DOMINION_TEST_A", "DOMINION_TEST_B");
    process.env.DOMINION_TEST_B = "from-process";
    writeFiles(root, {
      "dominion.config.ts": "export default { environments: { s: { baseURL: 'https://a.example.com', roles: { g: { strategy: 'none' } } } } };",
      ".env.local": "DOMINION_TEST_A=from-file\nDOMINION_TEST_B=from-file\n",
    });
    const loaded = await loadConfig({ cwd: root });
    expect(loaded.envFile).toBe(join(root, ".env.local"));
    expect(process.env.DOMINION_TEST_A).toBe("from-file");
    expect(process.env.DOMINION_TEST_B).toBe("from-process");
  });

  it("reports load errors and missing configs clearly", async () => {
    const root = makeTempDir("load-bad");
    dirs.push(root);
    writeFiles(root, { ".git/HEAD": "x", "dominion.config.ts": "export default {{{ broken" });
    await expect(loadConfig({ cwd: root })).rejects.toMatchObject({ code: "CONFIG_LOAD_FAILED" });
    const empty = makeTempDir("load-none");
    dirs.push(empty);
    writeFiles(empty, { ".git/HEAD": "x" });
    await expect(loadConfig({ cwd: empty })).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    expect(findConfigFile(empty)).toBeUndefined();
  });

  it("loadEnvFile returns names, never values", () => {
    const root = makeTempDir("env-file");
    dirs.push(root);
    writeFiles(root, { ".env.local": "X_USER=alice\nX_PASS='p@ss w0rd'\n" });
    const env: NodeJS.ProcessEnv = { X_USER: "bob" };
    const result = loadEnvFile(root, env);
    expect(result.loaded).toEqual(["X_PASS"]);
    expect(env).toEqual({ X_USER: "bob", X_PASS: "p@ss w0rd" });
  });
});

describe("resolution helpers", () => {
  const loaded = { root: "/repo", configPath: "/repo/dominion.config.ts", config: validateConfig(MINIMAL, "c") };

  it("resolves environments with defaults and absolute URLs", () => {
    const env = getEnvironment(loaded, "staging");
    expect(env.baseURL).toBe("https://staging.example.com");
    expect(env.allowedOrigins).toEqual(["https://staging.example.com"]);
    expect(env.auth.validate?.url).toBe("https://staging.example.com/account");
    expect(env.auth.loginScript.replace(/\\/g, "/")).toMatch(/\/repo\/dominion\/auth\/login\.ts$/);
    expect(getEnvironment(loaded, "qa").auth.validate).toBeUndefined();
  });

  it("lists known names in lookup errors", () => {
    expect(() => getEnvironment(loaded, "prod")).toThrow(DominionError);
    try {
      getEnvironment(loaded, "prod");
    } catch (error) {
      expect((error as DominionError).hint).toContain("staging, qa");
    }
    expect(() => getRole(getEnvironment(loaded, "staging"), "root")).toThrow(/Unknown role "root"/);
  });

  it("picks a default role only when unambiguous", () => {
    expect(defaultRole(getEnvironment(loaded, "qa"))).toBe("sso_user");
    expect(() => defaultRole(getEnvironment(loaded, "staging"))).toThrow(/choose one with --role/);
  });

  it("builds session file paths and absolute URLs", () => {
    const paths = projectPaths(loaded);
    expect(sessionFile(paths, "staging", "customer").replace(/\\/g, "/")).toMatch(/\/repo\/\.auth\/staging-customer\.json$/);
    expect(absoluteUrl("https://a.example.com/", "/x")).toBe("https://a.example.com/x");
    expect(absoluteUrl("https://a.example.com", "y")).toBe("https://a.example.com/y");
    expect(absoluteUrl("https://a.example.com", "https://b.example.com/z")).toBe("https://b.example.com/z");
  });

  it("lists referenced and missing env vars", () => {
    expect(referencedEnvVars(loaded.config).map((r) => r.name)).toEqual([
      "STAGING_CUSTOMER_USER",
      "STAGING_CUSTOMER_PASS",
      "STAGING_ADMIN_USER",
      "STAGING_ADMIN_PASS",
      "STAGING_ADMIN_TOTP",
    ]);
    expect(missingRoleEnvVars(loaded.config, "staging", "admin", { STAGING_ADMIN_USER: "a" })).toEqual([
      "STAGING_ADMIN_PASS",
      "STAGING_ADMIN_TOTP",
    ]);
    expect(missingRoleEnvVars(loaded.config, "staging", "guest", {})).toEqual([]);
  });
});

describe("matchesLoggedOutPattern", () => {
  it.each([
    ["https://a.example.com/login", "/login", true],
    ["https://a.example.com/login/", "/login", true],
    ["https://a.example.com/login?next=/account", "/login", true],
    ["https://a.example.com/login/mfa", "/login", true],
    ["https://auth.example.com/login", "/login", true],
    ["https://a.example.com/loginhelp", "/login", false],
    ["https://a.example.com/account", "/login", false],
    ["https://a.example.com/", "/", true],
    ["https://a.example.com/inventory.html", "/", false],
    ["https://a.example.com/sso/start", "/sso/*", true],
    ["https://a.example.com/a/b/signin", "**/signin", true],
    ["https://auth.example.com/x", "https://auth.example.com", true],
    ["https://a.example.com/x", "https://auth.example.com", false],
  ])("%s vs %s -> %s", (url, pattern, expected) => {
    expect(matchesLoggedOutPattern(url, pattern)).toBe(expected);
  });

  it("supports RegExp, including global regexes", () => {
    const re = /\/signin/g;
    expect(matchesLoggedOutPattern("https://a.example.com/signin", re)).toBe(true);
    expect(matchesLoggedOutPattern("https://a.example.com/signin", re)).toBe(true);
    expect(matchesLoggedOutPattern("https://a.example.com/home", re)).toBe(false);
  });
});
