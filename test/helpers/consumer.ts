import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXTURE_USERS } from "../fixture-app/server.mjs";
import { makeTempDir, REPO_ROOT, writeFiles } from "./tmp";

/** Env var values for the fixture app's fake test accounts. */
export const FIXTURE_ENV: Record<string, string> = {
  FX_USER: FIXTURE_USERS.plain.email,
  FX_PASS: FIXTURE_USERS.plain.password,
  FX_ADMIN_USER: FIXTURE_USERS.totp.email,
  FX_ADMIN_PASS: FIXTURE_USERS.totp.password,
  FX_ADMIN_TOTP: FIXTURE_USERS.totp.totpSecret,
};

/** Every credential value, for "no secret leaked" assertions. */
export const FIXTURE_SECRET_VALUES = Object.values(FIXTURE_ENV);

/** Login script for the fixture app's two-step (password, then code) flow. */
export const FIXTURE_LOGIN_SCRIPT = `import type { LoginContext } from "dominion-playwright";

export default async function login({ page, env, credentials }: LoginContext) {
  await page.goto(env.baseURL + env.auth.loginUrl);
  await page.getByLabel("Email").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (credentials.totp) {
    await page.getByLabel("Authentication code").fill(credentials.totp());
    await page.getByRole("button", { name: "Verify" }).click();
  }
}
`;

export function fixtureConfigSource(baseURL: string, extraRoles = ""): string {
  return `import { defineConfig } from "dominion-playwright";

export default defineConfig({
  environments: {
    staging: {
      baseURL: "${baseURL}",
      auth: {
        loginUrl: "/login",
        loginScript: "./dominion/auth/login.ts",
        validate: { url: "/account", loggedOutPattern: "/login" },
      },
      roles: {
        guest: { strategy: "none" },
        customer: { strategy: "form", userEnv: "FX_USER", passEnv: "FX_PASS" },
        admin: { strategy: "form", userEnv: "FX_ADMIN_USER", passEnv: "FX_ADMIN_PASS", totpEnv: "FX_ADMIN_TOTP" },
        ${extraRoles}
      },
    },
  },
});
`;
}

/** A consumer repo (inside test/.tmp so @playwright/test resolves) configured against the fixture app. */
export function makeFixtureConsumer(prefix: string, baseURL: string, options: { extraRoles?: string; files?: Record<string, string> } = {}): string {
  const root = makeTempDir(prefix);
  writeFiles(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": JSON.stringify({ name: "fixture-consumer", private: true, type: "module" }, null, 2),
    "playwright.config.ts": 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./tests" });\n',
    ".gitignore": ".env.local\n.auth/\n.dominion/\n",
    "dominion.config.ts": fixtureConfigSource(baseURL, options.extraRoles),
    "dominion/auth/login.ts": FIXTURE_LOGIN_SCRIPT,
    ...options.files,
  });
  return root;
}

/** A stock `npm init playwright` style config with a projects array. */
export const STOCK_PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "html",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
`;

/**
 * Installs this repo as node_modules/dominion-playwright in a consumer (a directory junction), so
 * generated files that import the package (dominion.setup.ts) resolve exactly as when installed.
 * Requires a build (dist/).
 */
export function linkDominionPackage(root: string): void {
  const target = join(root, "node_modules", "dominion-playwright");
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(REPO_ROOT, target, "junction");
}

/** Sets env vars and returns a function that restores the previous values. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
