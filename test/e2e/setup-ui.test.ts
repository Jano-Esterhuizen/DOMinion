import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as pwExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DominionServer, startServer } from "../../src/server";
import { type FixtureApp, FIXTURE_USERS, startFixtureApp } from "../fixture-app/server.mjs";
import { setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { multiPlannerScript } from "../helpers/fixture-scripts";
import { scriptedRunner } from "../helpers/scripted-runner";
import { http } from "../helpers/server";
import { makeTempDir, REPO_ROOT, removeDir, writeFiles } from "../helpers/tmp";

const API_KEY = "sk-ant-fixture-not-a-real-key";
const CUSTOMER = FIXTURE_USERS.plain;

let fixture: FixtureApp;
let browser: Browser;
let restoreEnv: () => void;
const roots: string[] = [];
const servers: DominionServer[] = [];

beforeAll(async () => {
  const ui = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "src/ui/vite.config.ts"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (ui.status !== 0) throw new Error(`UI build failed:\n${ui.stdout}\n${ui.stderr}`);
  fixture = await startFixtureApp();
  // A clean slate: nothing is configured until the Setup tab saves it.
  restoreEnv = setEnv({ ANTHROPIC_API_KEY: undefined, STAGING_CUSTOMER_USER: undefined, STAGING_CUSTOMER_PASS: undefined, STAGING_ADMIN_USER: undefined, STAGING_ADMIN_PASS: undefined, STAGING_ADMIN_TOTP: undefined });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  for (const server of servers) await server.close();
  restoreEnv?.();
  await fixture?.close();
  for (const root of roots) removeDir(root);
});

function project(prefix: string, files: Record<string, string>): string {
  const root = makeTempDir(prefix);
  roots.push(root);
  writeFiles(root, { "package.json": JSON.stringify({ name: "shop", private: true, type: "module" }, null, 2), ...files });
  return root;
}

async function open(server: DominionServer): Promise<Page> {
  const page = await browser.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(server.openUrl);
  return page;
}

const region = (page: Page, name: RegExp) => page.getByRole("region", { name });

describe("Setup tab: a Playwright project without DOMinion", () => {
  it("walks from nothing to a first planning run in Minion runner", async () => {
    const root = project("setup-ui", { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG });
    const scripted = scriptedRunner({ planner: multiPlannerScript });
    const server = await startServer({ root, port: 0, managerOptions: { runner: scripted.runner, skipPreflight: true } });
    servers.push(server);

    // Before setup, run endpoints say what is missing instead of failing obscurely.
    const config = await http(server.url, server.token, "/api/config");
    expect(config.status).toBe(409);
    expect(config.body.code).toBe("SETUP_REQUIRED");

    const page = await open(server);
    await pwExpect(page).toHaveURL(`${server.url}/setup`);
    await pwExpect(page.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Minion runner" }).click();
    await pwExpect(page.getByText(/Minion runner unlocks when setup is done: \d+ items? left/)).toBeVisible();
    await page.getByRole("link", { name: "Go to Setup" }).click();

    // 1. Playwright is already there.
    await pwExpect(region(page, /1\. Playwright/)).toContainText("Found playwright.config.ts");

    // 2. API key: saved to .env.local (gitignored first), never shown again.
    const apiStep = region(page, /2\. Claude API key/);
    await apiStep.getByLabel(/^API key/).fill(API_KEY);
    await apiStep.getByRole("button", { name: "Save key" }).click();
    await pwExpect(apiStep.getByRole("status")).toHaveText("Saved to .env.local");
    await pwExpect(apiStep.getByLabel(/^API key/)).toHaveValue("");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".env.local");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toContain(`ANTHROPIC_API_KEY=${API_KEY}`);

    // 3. Create the DOMinion setup (init) for the fixture shop.
    const projectStep = region(page, /3\. DOMinion project/);
    await projectStep.getByLabel("App base URL").fill(fixture.url);
    await projectStep.getByRole("button", { name: "Create DOMinion setup" }).click();
    await pwExpect(projectStep.getByRole("list", { name: "Created files" })).toContainText("dominion.config.ts");
    await pwExpect(projectStep).toContainText("is set up (new setup)");
    expect(readFileSync(join(root, "playwright.config.ts"), "utf8")).toContain('testIgnore: "**/tests/agent/**"');

    // 4. The app settings come prefilled from the template; saving an unchanged form changes nothing.
    const appStep = region(page, /4\. Your app/);
    await pwExpect(appStep.getByLabel("Base URL")).toHaveValue(fixture.url);
    await pwExpect(appStep.getByLabel("A page only logged-in users can open")).toHaveValue("/account");
    await appStep.getByLabel("Test id attribute").fill("data-testid");
    await appStep.getByRole("button", { name: "Save app settings" }).click();
    await pwExpect(appStep.getByRole("status")).toHaveText("Saved to dominion.config.ts");

    // 5. Credentials (write-only) and roles.
    const rolesStep = region(page, /5\. Roles and credentials/);
    const customer = rolesStep.getByRole("group", { name: "Role customer" });
    await customer.getByLabel(/customer username/).fill(CUSTOMER.email);
    await customer.getByLabel(/customer password/).fill(CUSTOMER.password);
    await customer.getByRole("button", { name: "Save customer credentials" }).click();
    await pwExpect(customer.getByRole("status")).toHaveText("Saved to .env.local");
    await pwExpect(customer).toContainText("STAGING_CUSTOMER_PASS, saved");
    const envLocal = readFileSync(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`STAGING_CUSTOMER_USER=${CUSTOMER.email}`);
    expect(envLocal).toContain("STAGING_CUSTOMER_PASS=");

    await rolesStep.getByLabel("New role name").fill("admin");
    await rolesStep.getByLabel("Uses a one-time code").check();
    await rolesStep.getByRole("button", { name: "Add role" }).click();
    const admin = rolesStep.getByRole("group", { name: "Role admin" });
    await pwExpect(admin.getByLabel(/admin TOTP secret/)).toBeVisible();
    expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toContain('admin: { strategy: "form", userEnv: "STAGING_ADMIN_USER", passEnv: "STAGING_ADMIN_PASS", totpEnv: "STAGING_ADMIN_TOTP" }');
    await admin.getByRole("button", { name: "Remove admin" }).click();
    await pwExpect(admin).toHaveCount(0);

    // 6. Login script: detected from the real login page, then saved by the builder.
    const scriptStep = region(page, /6\. Login script/);
    await pwExpect(scriptStep).toContainText("still the template");
    // Step 7 warns before anyone tests a login with the untouched template.
    const templateWarning = region(page, /7\. Test login/).getByText("The login script is still DOMinion's template");
    await pwExpect(templateWarning).toBeVisible();
    await scriptStep.getByRole("button", { name: "Detect from login page" }).click();
    await pwExpect(scriptStep.getByLabel("Username field: text")).toHaveValue("Email");
    await pwExpect(scriptStep.getByLabel("Password field: text")).toHaveValue("Password");
    await pwExpect(scriptStep.getByLabel("Sign-in button: text")).toHaveValue("Sign in");
    await scriptStep.getByRole("button", { name: "Save login script" }).click();
    await pwExpect(scriptStep.getByRole("status")).toHaveText("Saved dominion/auth/login.ts");
    expect(readFileSync(join(root, "dominion", "auth", "login.ts"), "utf8")).toContain('await page.getByLabel("Email", { exact: true }).fill(credentials.username);');
    await pwExpect(templateWarning).toHaveCount(0);

    // 7. Test login.
    const loginStep = region(page, /7\. Test login/);
    const customerLogin = loginStep.getByRole("listitem", { name: "Login customer" });
    await customerLogin.getByRole("button", { name: "Test login" }).click();
    await pwExpect(customerLogin.getByRole("status")).toHaveText("Logged in; the session works.", { timeout: 60_000 });
    await pwExpect(customerLogin.locator('[data-status="session-valid"]')).toBeVisible();

    // Done: the checklist is ready and no secret ever reached the page or the setup API.
    await pwExpect(region(page, /Setup checklist/).locator('[data-status="done"]').filter({ hasText: "ready" })).toBeVisible();
    const html = await page.content();
    const setupJson = JSON.stringify((await http(server.url, server.token, "/api/setup")).body);
    for (const secret of [API_KEY, CUSTOMER.password, CUSTOMER.email]) {
      expect(html).not.toContain(secret);
      expect(setupJson).not.toContain(secret);
    }

    // Minion runner is unlocked and runs with what Setup configured.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Minion runner" }).click();
    await page.getByLabel("What should DOMinion test?").fill("write tests for the add to cart workflow");
    await page.getByLabel("Stop after planning").check();
    await page.getByRole("button", { name: "Start" }).click();
    await pwExpect(page.locator(".pill").first()).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await pwExpect(page.getByRole("list", { name: "Run log" })).toContainText("plan ready: specs/add-to-cart.md");
    await page.close();
  });

  it("refuses secrets the config does not name", async () => {
    const server = servers[0]!;
    const res = await http(server.url, server.token, "/api/setup/secrets", { method: "PUT", json: { values: { PATH: "x" } }, headers: { origin: server.url } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SETUP_UNKNOWN_SECRET");
  });
});

describe("Setup tab: a project with an existing Playwright suite", () => {
  it("shows the detected layout, stores the suite's own credentials and logs in through its setup project", async () => {
    const root = makeTempDir("setup-existing");
    roots.push(root);
    cpSync(join(REPO_ROOT, "test", "fixture-existing-suite"), root, { recursive: true });
    const restoreBase = setEnv({ BASE_URL: fixture.url, E2E_USER: undefined, E2E_PASS: undefined });
    const analyzed: string[] = [];
    const server = await startServer({
      root,
      port: 0,
      setup: {
        analyzeConventions: async ({ profile }) => {
          analyzed.push(profile.testDir);
          return "- Tests get page objects from fixtures.";
        },
      },
    });
    servers.push(server);
    try {
      const page = await open(server);
      const projectStep = region(page, /3\. DOMinion project/);
      await pwExpect(projectStep).toContainText("DOMinion found an existing Playwright suite");
      await pwExpect(projectStep.getByLabel("Detected project layout")).toContainText('testDir: "e2e"');
      await pwExpect(projectStep).toContainText("Your suite reads E2E_PASS, E2E_USER");
      await pwExpect(projectStep.getByLabel("App base URL")).toHaveValue(fixture.url);
      await projectStep.getByRole("button", { name: "Create DOMinion setup" }).click();
      await pwExpect(projectStep).toContainText("following your existing suite's layout");
      expect(analyzed).toEqual(["e2e"]);
      const configText = readFileSync(join(root, "dominion.config.ts"), "utf8");
      expect(configText).toContain('secretEnv: ["E2E_PASS", "E2E_USER"]');
      expect(configText).toContain("- Tests get page objects from fixtures.");

      // The suite's own credentials, saved write-only.
      const secrets = region(page, /Your suite's credentials/);
      await secrets.getByLabel(/^E2E_USER/).fill(CUSTOMER.email);
      await secrets.getByLabel(/^E2E_PASS/).fill(CUSTOMER.password);
      await secrets.getByRole("button", { name: "Save" }).click();
      await pwExpect(secrets).toContainText("E2E_PASS, saved");

      // Existing-suite configs start without session checks; the app step adds them.
      const appStep = region(page, /4\. Your app/);
      await appStep.getByLabel("A page only logged-in users can open").fill("/account");
      await appStep.getByLabel("Where logged-out users land").fill("/login");
      await appStep.getByRole("button", { name: "Save app settings" }).click();
      await pwExpect(appStep.getByRole("status")).toHaveText("Saved to dominion.config.ts");
      expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toMatch(/auth: \{ validate: \{ url: "\/account", loggedOutPattern: "\/login" \} \}/);

      // No login script for an existing suite: its own setup project logs in.
      await pwExpect(region(page, /6\. Login script/)).toHaveCount(0);
      await pwExpect(region(page, /5\. Roles and credentials/)).toContainText("Logs in with your suite's own setup project");
      const userLogin = region(page, /7\. Test login/).getByRole("listitem", { name: "Login user" });
      await userLogin.getByRole("button", { name: "Test login" }).click();
      await pwExpect(userLogin.getByRole("status")).toHaveText("Logged in; the session works.", { timeout: 90_000 });
      await pwExpect(region(page, /Setup checklist/).locator('[data-status="done"]').filter({ hasText: "ready" })).toBeVisible();
      // Hand-written files are untouched.
      expect(readFileSync(join(root, "playwright.config.ts"), "utf8")).toBe(readFileSync(join(REPO_ROOT, "test", "fixture-existing-suite", "playwright.config.ts"), "utf8"));
      await page.close();
    } finally {
      restoreBase();
    }
  });
});

describe("Setup tab: a project without Playwright", () => {
  it("sets up Playwright from the UI and shows the installer's output", async () => {
    const root = project("setup-pw", {});
    const calls: string[][] = [];
    const server = await startServer({
      root,
      port: 0,
      setup: {
        runCommand: async (command, args, options) => {
          calls.push([command, ...args]);
          options.onLine("Installing Playwright Test (npm install --save-dev @playwright/test)…");
          writeFileSync(join(options.cwd, "playwright.config.js"), "export default { testDir: './tests' };\n");
          options.onLine("Writing playwright.config.js.");
          return 0;
        },
      },
    });
    servers.push(server);
    const page = await open(server);
    const step = region(page, /1\. Playwright/);
    await pwExpect(step).toContainText("This project has no Playwright yet");
    await pwExpect(region(page, /3\. DOMinion project/)).toContainText("Set up Playwright first");
    await step.locator("label", { hasText: "JavaScript" }).click();
    await step.getByRole("button", { name: "Set up Playwright" }).click();
    await pwExpect(step).toContainText("Found playwright.config.js", { timeout: 30_000 });
    expect(calls).toEqual([["npm", "init", "playwright@latest", "--", "--quiet", "--lang=js", "--browser=chromium"]]);
    expect(existsSync(join(root, "playwright.config.js"))).toBe(true);
    await pwExpect(region(page, /3\. DOMinion project/).getByRole("button", { name: "Create DOMinion setup" })).toBeVisible();
    await page.close();
  });
});
