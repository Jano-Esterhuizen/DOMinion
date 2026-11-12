import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSession, roleStatus } from "../../src/core/auth";
import { validateSession } from "../../src/core/auth/session";
import { loadConfig } from "../../src/core/config/loader";
import { getEnvironment } from "../../src/core/config/resolve";
import { runDoctor } from "../../src/core/doctor";
import { DominionError } from "../../src/core/errors";
import { loadPlaywright } from "../../src/core/playwright/resolve";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { FIXTURE_ENV, FIXTURE_SECRET_VALUES, makeFixtureConsumer, setEnv } from "../helpers/consumer";
import { scriptedPrompter } from "../helpers/prompter";
import { buildCli, runCli } from "../helpers/cli";
import { removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let root: string;
let restoreEnv: () => void;

beforeAll(async () => {
  fixture = await startFixtureApp();
  root = makeFixtureConsumer("auth", fixture.url, { extraRoles: 'sso_user: { strategy: "manual" },' });
  restoreEnv = setEnv({ ...FIXTURE_ENV, ANTHROPIC_API_KEY: "sk-ant-fixture-not-a-real-key" });
});

afterAll(async () => {
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

const load = () => loadConfig({ cwd: root });

describe("form strategy", () => {
  it("logs in a plain user, saves .auth/<env>-<role>.json and validates it", async () => {
    const loaded = await load();
    const result = await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
    expect(result.action).toBe("logged-in");
    expect(result.check?.state).toBe("valid");
    expect(result.file).toBe(join(root, ".auth", "staging-customer.json"));
    expect(existsSync(result.file!)).toBe(true);

    const again = await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
    expect(again.action).toBe("reused");
    expect(again.check?.state).toBe("valid");
  });

  it("logs in a TOTP user through the second factor", async () => {
    const loaded = await load();
    const result = await ensureSession({ loaded, envName: "staging", roleName: "admin", prompter: nonInteractivePrompter() });
    expect(result.action).toBe("logged-in");
    expect(result.check?.state).toBe("valid");
  });

  it("detects an expired session and refreshes it automatically", async () => {
    const loaded = await load();
    const env = getEnvironment(loaded, "staging");
    const { module: playwright } = await loadPlaywright(root);
    const file = join(root, ".auth", "staging-customer.json");
    fixture.expireSessions();
    const check = await validateSession({ playwright, env, file });
    expect(check.state).toBe("expired");
    expect(check.landedUrl).toContain("/login");

    const result = await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
    expect(result.action).toBe("logged-in");
    expect((await validateSession({ playwright, env, file })).state).toBe("valid");
  });

  it("reports wrong credentials with the page's message and no secret values", async () => {
    const restore = setEnv({ FX_PASS: "wrong-password-value-123" });
    try {
      const loaded = await load();
      const error = await ensureSession({
        loaded,
        envName: "staging",
        roleName: "customer",
        prompter: nonInteractivePrompter(),
        force: true,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DominionError);
      expect((error as DominionError).code).toBe("LOGIN_FAILED");
      expect((error as DominionError).message).toContain("Invalid email or password");
      expect((error as DominionError).hint).toMatch(/failed\.png/);
      expect(existsSync(join(root, ".dominion", "auth", "staging-customer-failed.png"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("names missing env vars instead of failing obscurely", async () => {
    const restore = setEnv({ FX_ADMIN_TOTP: undefined, FX_ADMIN_PASS: undefined });
    try {
      const loaded = await load();
      await expect(
        ensureSession({ loaded, envName: "staging", roleName: "admin", prompter: nonInteractivePrompter(), force: true }),
      ).rejects.toMatchObject({ code: "CREDENTIALS_MISSING", message: expect.stringContaining("FX_ADMIN_PASS, FX_ADMIN_TOTP") });
    } finally {
      restore();
    }
  });
});

describe("manual strategy", () => {
  it("refuses to run without a person at the keyboard", async () => {
    const loaded = await load();
    await expect(
      ensureSession({ loaded, envName: "staging", roleName: "sso_user", prompter: nonInteractivePrompter() }),
    ).rejects.toMatchObject({ code: "MANUAL_LOGIN_NEEDS_USER" });
  });

  it("saves the session after the user logs in and confirms", async () => {
    const loaded = await load();
    const { prompter, asked } = scriptedPrompter();
    const result = await ensureSession({
      loaded,
      envName: "staging",
      roleName: "sso_user",
      prompter,
      testHooks: {
        headless: true,
        onManualPage: async (page) => {
          await page.getByLabel("Email").fill(FIXTURE_ENV.FX_USER!);
          await page.getByLabel("Password").fill(FIXTURE_ENV.FX_PASS!);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.waitForURL("**/account");
        },
      },
    });
    expect(asked.some((q) => q.startsWith("wait: Log in to staging"))).toBe(true);
    expect(result.action).toBe("logged-in");
    expect(result.check?.state).toBe("valid");
  });

  it("does not save a session when the user continues without logging in", async () => {
    const loaded = await load();
    const { prompter } = scriptedPrompter();
    await expect(
      ensureSession({ loaded, envName: "staging", roleName: "sso_user", prompter, force: true, testHooks: { headless: true } }),
    ).rejects.toMatchObject({ code: "MANUAL_LOGIN_INCOMPLETE" });
  });
});

describe("status and doctor", () => {
  it("reports one badge per role", async () => {
    const loaded = await load();
    const badge = async (roleName: string) => (await roleStatus({ loaded, envName: "staging", roleName, validate: true })).badge;
    expect(await badge("guest")).toBe("no-session-needed");
    expect(await badge("customer")).toBe("session-valid");
    const restore = setEnv({ FX_ADMIN_USER: undefined });
    try {
      const status = await roleStatus({ loaded, envName: "staging", roleName: "admin", validate: false });
      expect(status.missingEnvVars).toEqual(["FX_ADMIN_USER"]);
    } finally {
      restore();
    }
  });

  it("doctor reports valid when config, env vars, sessions and API key are in place", async () => {
    // An earlier test expired every server-side session; form roles refresh automatically.
    const refreshed = await ensureSession({ loaded: await load(), envName: "staging", roleName: "admin", prompter: nonInteractivePrompter() });
    expect(refreshed.action).toBe("logged-in");
    const report = await runDoctor({ cwd: root, envName: "staging" });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["config"]?.status).toBe("ok");
    expect(byId["playwright"]?.status).toBe("ok");
    expect(byId["api-key"]).toMatchObject({ status: "ok", detail: "ANTHROPIC_API_KEY is set" });
    expect(byId["role:staging/customer"]).toMatchObject({ status: "ok", detail: "session valid" });
    expect(byId["role:staging/admin"]).toMatchObject({ status: "ok" });
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report.checks)).not.toContain("sk-ant-fixture");
  });

  it("doctor fails with an actionable message when the API key is missing", async () => {
    const report = await runDoctor({ cwd: root, envName: "staging", validateSessions: false, env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "api-key")).toMatchObject({ status: "error" });
  });
});

describe("CLI", () => {
  const run = (args: string[]) => runCli(args, { cwd: root });

  beforeAll(() => buildCli());

  it("`dominion auth staging --role customer --force` logs in and reports the session file", async () => {
    const result = await run(["auth", "staging", "--role", "customer", "--force"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/staging\/customer: logged in, session saved to \.auth\/staging-customer\.json \(valid\)/);
  });

  it("`dominion doctor --env staging` reports valid and exits 0", async () => {
    const result = await run(["doctor", "--env", "staging"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok\s+staging\/customer\s+session valid/);
    expect(result.stdout).toMatch(/All required checks passed/);
  });

  it("exits non-zero with a hint for an unknown environment", async () => {
    const result = await run(["auth", "prod"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown environment "prod"/);
    expect(result.stderr).toMatch(/Configured environments: staging/);
  });

  it("never prints or stores credential values outside .auth", async () => {
    const outputs = [await run(["doctor", "--env", "staging"]), await run(["auth", "staging", "--role", "admin"])]
      .map((r) => r.stdout + r.stderr)
      .join("\n");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (!abs.endsWith(".png")) files.push(readFileSync(abs, "utf8"));
      }
    };
    if (existsSync(join(root, ".dominion"))) walk(join(root, ".dominion"));
    for (const secret of FIXTURE_SECRET_VALUES) {
      expect(outputs).not.toContain(secret);
      for (const content of files) expect(content).not.toContain(secret);
    }
  });
});
