import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSession, roleStatus } from "../../src/core/auth";
import { sessionHeadersFile } from "../../src/core/auth/headers";
import { validateSession } from "../../src/core/auth/session";
import { loadConfig } from "../../src/core/config/loader";
import { getEnvironment } from "../../src/core/config/resolve";
import { runDoctor } from "../../src/core/doctor";
import { DominionError } from "../../src/core/errors";
import { buildMcpLaunch, scrubMcpConfig } from "../../src/core/mcp";
import { ensureSetupFile, managedEntries, patchPlaywrightConfig } from "../../src/core/playwright/patch";
import { loadPlaywright } from "../../src/core/playwright/resolve";
import { runPlaywrightTests } from "../../src/core/playwright/runner";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { activeRedactor, Redactor, setActiveRedactor } from "../../src/core/redact";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, FIXTURE_SECRET_VALUES, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { removeDir } from "../helpers/tmp";

/** Logs in through the fixture's JSON endpoint and returns a bearer header (no cookies). */
const API_LOGIN = `import type { ApiLoginContext, ApiLoginResult } from "@yourorg/dominion";

export default async function login({ request, credentials }: ApiLoginContext): Promise<ApiLoginResult> {
  const response = await request.post("/api/login", {
    data: { email: credentials.username, password: credentials.password, code: credentials.totp?.() },
  });
  if (!response.ok()) throw new Error(\`login failed: \${response.status()} \${await response.text()}\`);
  const { token } = (await response.json()) as { token: string };
  return { headers: { Authorization: \`Bearer \${token}\` } };
}
`;

/** Posts the HTML login form with the request context; the Set-Cookie it gets back is the session. */
const API_COOKIE_LOGIN = `import type { ApiLoginContext } from "@yourorg/dominion";

export default async function login({ request, credentials }: ApiLoginContext) {
  const response = await request.post("/login", { form: { email: credentials.username!, password: credentials.password! } });
  if (!response.ok()) throw new Error(\`login failed: \${response.status()}\`);
}
`;

const API_EMPTY_LOGIN = `export default async function login() {
  return {};
}
`;

const API_LEAKY_LOGIN = `import type { ApiLoginContext } from "@yourorg/dominion";

export default async function login({ credentials }: ApiLoginContext) {
  throw new Error("the server rejected password " + credentials.password);
}
`;

const ACCOUNT_SPEC = `import { test, expect } from "@playwright/test";

test.describe("Account @dominion @flow:account @role:apiuser", () => {
  test("shows the signed-in user", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByText("Signed in as Fixture Customer")).toBeVisible();
  });
});
`;

const API_ROLES = `
        apiuser: { strategy: "api", userEnv: "FX_USER", passEnv: "FX_PASS", apiLogin: "./dominion/auth/api-login.ts" },
        apiadmin: { strategy: "api", userEnv: "FX_ADMIN_USER", passEnv: "FX_ADMIN_PASS", totpEnv: "FX_ADMIN_TOTP", apiLogin: "./dominion/auth/api-login.ts" },
        apicookie: { strategy: "api", userEnv: "FX_USER", passEnv: "FX_PASS", apiLogin: "./dominion/auth/api-cookie.ts" },
        apinone: { strategy: "api" },
        apiempty: { strategy: "api", apiLogin: "./dominion/auth/api-empty.ts" },
        apileaky: { strategy: "api", userEnv: "FX_USER", passEnv: "FX_PASS", apiLogin: "./dominion/auth/api-leaky.ts" },`;

let fixture: FixtureApp;
let root: string;
let restoreEnv: () => void;
let previousRedactor: Redactor;

beforeAll(async () => {
  buildCli();
  fixture = await startFixtureApp();
  root = makeFixtureConsumer("api-auth", fixture.url, {
    extraRoles: API_ROLES,
    files: {
      "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG,
      "dominion/auth/api-login.ts": API_LOGIN,
      "dominion/auth/api-cookie.ts": API_COOKIE_LOGIN,
      "dominion/auth/api-empty.ts": API_EMPTY_LOGIN,
      "dominion/auth/api-leaky.ts": API_LEAKY_LOGIN,
    },
  });
  linkDominionPackage(root);
  restoreEnv = setEnv({ ...FIXTURE_ENV, ANTHROPIC_API_KEY: "sk-ant-fixture-not-a-real-key" });
  previousRedactor = activeRedactor();
  setActiveRedactor(new Redactor(Object.entries(FIXTURE_ENV).map(([name, value]) => ({ name, value }))));
});

afterAll(async () => {
  setActiveRedactor(previousRedactor);
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

const load = () => loadConfig({ cwd: root });
const login = async (roleName: string, force = false) =>
  ensureSession({ loaded: await load(), envName: "staging", roleName, prompter: nonInteractivePrompter(), force });
const savedHeaders = (role: string) =>
  (JSON.parse(readFileSync(sessionHeadersFile(join(root, ".auth", `staging-${role}.json`)), "utf8")) as { headers: Record<string, string> }).headers;

async function expectError(promise: Promise<unknown>, code: string): Promise<DominionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DominionError);
  expect((error as DominionError).code).toBe(code);
  return error as DominionError;
}

describe("api strategy", () => {
  it("logs in through a login endpoint and keeps the bearer header beside the storage state", async () => {
    const result = await login("apiuser");
    expect(result.action).toBe("logged-in");
    expect(result.check?.state).toBe("valid");
    expect(result.file).toBe(join(root, ".auth", "staging-apiuser.json"));
    const headers = savedHeaders("apiuser");
    expect(headers.Authorization).toMatch(/^Bearer [0-9a-f]{48}$/);
    // The token is a secret from now on, like any credential from an env var.
    const token = headers.Authorization!.slice("Bearer ".length);
    expect(activeRedactor().redact(`sent ${token}`)).toBe("sent [REDACTED]");

    const again = await login("apiuser");
    expect(again.action).toBe("reused");
    expect(again.check?.state).toBe("valid");
  });

  it("needs the saved headers: the same storage state without them is logged out", async () => {
    const loaded = await load();
    const { module: playwright } = await loadPlaywright(root);
    const copy = join(root, ".auth", "staging-copy.json");
    copyFileSync(join(root, ".auth", "staging-apiuser.json"), copy);
    const check = await validateSession({ playwright, env: getEnvironment(loaded, "staging"), file: copy });
    expect(check.state).toBe("expired");
  });

  it("passes a TOTP generator for MFA accounts", async () => {
    const result = await login("apiadmin");
    expect(result.check?.state).toBe("valid");
  });

  it("keeps cookies the request context picked up when the module returns nothing", async () => {
    const result = await login("apicookie");
    expect(result.check?.state).toBe("valid");
    const state = JSON.parse(readFileSync(result.file!, "utf8")) as { cookies: Array<{ name: string; domain: string }> };
    expect(state.cookies.map((c) => c.name)).toContain("fixture_sid");
    expect(existsSync(sessionHeadersFile(result.file!))).toBe(false);
  });

  it("logs in again automatically when the token has expired", async () => {
    const before = savedHeaders("apiuser").Authorization;
    fixture.expireSessions();
    const result = await login("apiuser");
    expect(result.action).toBe("logged-in");
    expect(result.check?.state).toBe("valid");
    expect(savedHeaders("apiuser").Authorization).not.toBe(before);
  });

  it("explains a missing module, an empty result and a failing module without leaking credentials", async () => {
    const none = await expectError(login("apinone"), "API_LOGIN_NOT_CONFIGURED");
    expect(none.hint).toMatch(/auth\.apiLogin/);
    await expectError(login("apiempty"), "API_LOGIN_EMPTY");
    const leaky = await expectError(login("apileaky"), "LOGIN_FAILED");
    for (const secret of FIXTURE_SECRET_VALUES) expect(leaky.message).not.toContain(secret);
    expect(leaky.message).toContain("[REDACTED]");
  });

  it("shows session badges and lets doctor point at the missing module", async () => {
    const loaded = await load();
    expect((await roleStatus({ loaded, envName: "staging", roleName: "apiuser", validate: true })).badge).toBe("session-valid");
    expect((await roleStatus({ loaded, envName: "staging", roleName: "apiempty" })).badge).toBe("never-logged-in");
    const report = await runDoctor({ cwd: root, envName: "staging" });
    const apiNone = report.checks.find((c) => c.id === "role:staging/apinone:api-login");
    expect(apiNone?.status).toBe("error");
    expect(apiNone?.hint).toMatch(/auth\.apiLogin/);
  });

  it("gives the agents' browser the session headers, and scrubs them from the run folder afterwards", async () => {
    const loaded = await load();
    const file = join(root, ".auth", "staging-apiuser.json");
    const headers = savedHeaders("apiuser");
    const configPath = join(root, ".dominion", "runs", "x", "mcp.json");
    const launch = buildMcpLaunch({
      env: getEnvironment(loaded, "staging"),
      storageState: file,
      extraHTTPHeaders: headers,
      configPath,
      outputDir: join(root, ".dominion", "out"),
      testIdAttribute: "data-testid",
      agentBrowser: loaded.config.agentBrowser,
    });
    expect(launch.config.browser.contextOptions).toEqual({ storageState: file, extraHTTPHeaders: headers });
    expect(readFileSync(configPath, "utf8")).toContain(headers.Authorization!);
    scrubMcpConfig(configPath);
    const scrubbed = readFileSync(configPath, "utf8");
    expect(scrubbed).not.toContain(headers.Authorization!);
    expect(JSON.parse(scrubbed).browser.contextOptions).toEqual({ storageState: file });
  });

  it("generated tests send the headers: the setup project logs in and the role's project picks them up", async () => {
    const loaded = await load();
    const configPath = join(root, "playwright.config.ts");
    const patched = patchPlaywrightConfig(configPath, managedEntries(loaded, root));
    expect(patched.status).toBe("patched");
    const configText = readFileSync(configPath, "utf8");
    expect(configText).toContain('import { sessionHeaders } from "@yourorg/dominion/setup";');
    expect(configText).toContain('extraHTTPHeaders: sessionHeaders(".auth/staging-apiuser.json")');
    // Re-patching is a no-op (the import is not added twice).
    expect(patchPlaywrightConfig(configPath, managedEntries(loaded, root)).status).toBe("unchanged");
    ensureSetupFile(join(root, "tests", "agent"));

    // No session at all and a revoked token: the setup project must log in before the test runs,
    // and the test's worker must see the fresh headers.
    rmSync(join(root, ".auth", "staging-apiuser.json"), { force: true });
    rmSync(sessionHeadersFile(join(root, ".auth", "staging-apiuser.json")), { force: true });
    fixture.expireSessions();
    const spec = join(root, "tests", "agent", "account.spec.ts");
    writeFileSync(spec, ACCOUNT_SPEC, "utf8");
    const result = await runPlaywrightTests({
      root,
      configPath,
      files: [spec],
      projects: ["dominion-staging-apiuser"],
      reportPath: join(root, ".dominion", "api-report.json"),
    });
    const outcome = result.tests.find((t) => t.title === "shows the signed-in user");
    expect(outcome?.status, `${outcome?.error ?? ""}\n${result.output.slice(-1500)}`).toBe("passed");
    expect(existsSync(sessionHeadersFile(join(root, ".auth", "staging-apiuser.json")))).toBe(true);
  });
});
