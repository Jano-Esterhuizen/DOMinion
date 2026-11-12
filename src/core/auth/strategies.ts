import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { importConsumerModule, type LoadedConfig } from "../config/loader";
import {
  matchesLoggedOutPattern,
  missingRoleEnvVars,
  projectPaths,
  type ResolvedEnvironment,
} from "../config/resolve";
import type { FormRoleConfig, ManualRoleConfig } from "../config/schema";
import { DominionError, errorMessage } from "../errors";
import { relativePosix } from "../fs";
import { packageName } from "../package-info";
import { explainLaunchError, type PlaywrightTestModule } from "../playwright/resolve";
import type { Prompter } from "../prompter";
import { readLoginScriptState } from "../setup/login-builder";
import { redactText } from "../redact";
import { generateTotp } from "./totp";
import type { LoginContext, LoginCredentials, LoginEnvironment } from "./types";

export interface StrategyContext {
  loaded: LoadedConfig;
  env: ResolvedEnvironment;
  roleName: string;
  /** Where the session is saved (.auth/<env>-<role>.json). */
  file: string;
  playwright: PlaywrightTestModule;
  prompter: Prompter;
  headed?: boolean;
  /** How long to wait for the app to leave the login page. */
  timeoutMs?: number;
  testHooks?: AuthTestHooks;
}

/** Seams for automated tests only; never set by the CLI or server. */
export interface AuthTestHooks {
  /** Run the manual strategy's browser headless. */
  headless?: boolean;
  /** Called while the manual strategy waits for the user, to perform the "manual" login. */
  onManualPage?: (page: Page) => Promise<void>;
}

export function loginEnvironment(env: ResolvedEnvironment, loginUrl?: string): LoginEnvironment {
  return { name: env.name, baseURL: env.baseURL, auth: { loginUrl: loginUrl ?? env.auth.loginUrl } };
}

/** The pattern that means "still logged out": auth.validate.loggedOutPattern, else the login URL path. */
export function loggedOutPatternFor(env: ResolvedEnvironment, loginUrl?: string): string | RegExp {
  return env.auth.validate?.loggedOutPattern ?? (loginUrl ?? env.auth.loginUrl);
}

/** Reads the role's credentials from env vars; never from config or prompts. */
export function readFormCredentials(ctx: StrategyContext, role: FormRoleConfig): LoginCredentials {
  const missing = missingRoleEnvVars(ctx.loaded.config, ctx.env.name, ctx.roleName);
  if (missing.length > 0) {
    throw new DominionError(
      `Missing credentials for ${ctx.env.name}/${ctx.roleName}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      {
        code: "CREDENTIALS_MISSING",
        hint: `Add ${missing.map((m) => `${m}=...`).join(" and ")} to ${relativePosix(process.cwd(), join(ctx.loaded.root, ".env.local"))} (gitignored) or export ${missing.length === 1 ? "it" : "them"} in your shell or CI secrets.`,
      },
    );
  }
  const totpSecret = role.totpEnv ? process.env[role.totpEnv]! : undefined;
  return {
    username: process.env[role.userEnv]!,
    password: process.env[role.passEnv]!,
    ...(totpSecret ? { totp: () => generateTotp(totpSecret) } : {}),
  };
}

async function launch(ctx: StrategyContext, headless: boolean): Promise<Browser> {
  try {
    return await ctx.playwright.chromium.launch({ headless });
  } catch (error) {
    throw explainLaunchError(error);
  }
}

async function saveSession(context: BrowserContext, file: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  await context.storageState({ path: file });
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort: sessions are secrets, but a failed chmod should not fail the login
    }
  }
}

/** Saves a screenshot next to the run artifacts so a failed login can be diagnosed. */
async function failureScreenshot(ctx: StrategyContext, page: Page): Promise<string | undefined> {
  try {
    const path = join(projectPaths(ctx.loaded).dominionDir, "auth", `${ctx.env.name}-${ctx.roleName}-failed.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: true, mask: [page.locator("input, textarea, [contenteditable]")] });
    return relativePosix(ctx.loaded.root, path);
  } catch {
    return undefined;
  }
}

async function visibleAlerts(page: Page): Promise<string | undefined> {
  try {
    const texts = await page.getByRole("alert").allInnerTexts();
    const joined = texts.map((t) => t.trim()).filter(Boolean).join(" | ");
    return joined ? redactText(joined.slice(0, 300)) : undefined;
  } catch {
    return undefined;
  }
}

/** Waits until the URL no longer matches the logged-out pattern. */
async function waitUntilLoggedIn(page: Page, pattern: string | RegExp, timeoutMs: number, baseURL?: string): Promise<boolean> {
  try {
    await page.waitForURL((url) => !matchesLoggedOutPattern(url.href, pattern, baseURL), { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** `form` strategy: run the consumer's login script with env-var credentials, then save the session. */
export async function loginWithForm(ctx: StrategyContext, role: FormRoleConfig): Promise<void> {
  const credentials = readFormCredentials(ctx, role);
  const scriptPath = role.loginScript ? (isAbsolute(role.loginScript) ? role.loginScript : resolve(ctx.loaded.root, role.loginScript)) : ctx.env.auth.loginScript;
  const scriptLabel = relativePosix(ctx.loaded.root, scriptPath);
  if (!existsSync(scriptPath)) {
    throw new DominionError(`Login script not found: ${scriptLabel}`, {
      code: "LOGIN_SCRIPT_MISSING",
      hint: "Run `npx dominion init` to create dominion/auth/login.ts from the template, or set auth.loginScript in dominion.config.ts.",
    });
  }
  let loginFn: unknown;
  try {
    loginFn = await importConsumerModule(scriptPath);
  } catch (error) {
    throw new DominionError(`Could not load ${scriptLabel}: ${redactText(errorMessage(error))}`, {
      code: "LOGIN_SCRIPT_INVALID",
      cause: error,
      hint: "Fix the error above in your login script.",
    });
  }
  if (typeof loginFn !== "function") {
    throw new DominionError(`${scriptLabel} must default-export an async function.`, {
      code: "LOGIN_SCRIPT_INVALID",
      hint: "Use `export default async function login({ page, env, credentials }: LoginContext) { ... }`.",
    });
  }

  const browser = await launch(ctx, !ctx.headed);
  try {
    const context = await browser.newContext({ baseURL: ctx.env.baseURL });
    const page = await context.newPage();
    const loginContext: LoginContext = {
      page,
      context,
      env: loginEnvironment(ctx.env),
      role: ctx.roleName,
      credentials,
    };
    try {
      await (loginFn as (arg: LoginContext) => Promise<void>)(loginContext);
    } catch (error) {
      const shot = await failureScreenshot(ctx, page);
      const template = readLoginScriptState(scriptPath, packageName()).kind === "template";
      throw new DominionError(`The login script failed for ${ctx.env.name}/${ctx.roleName}: ${redactText(errorMessage(error))}`, {
        code: "LOGIN_FAILED",
        cause: error,
        hint: template
          ? `${scriptLabel} is still DOMinion's template, which looks for an "Email" field. Set it up for your login page first: in \`npx dominion ui\`, Setup step 6 (Detect from login page, then Save login script), or edit the lines marked ADJUST.${shot ? ` Screenshot: ${shot}` : ""}`
          : `Check the selectors in ${scriptLabel}${shot ? `; a screenshot was saved to ${shot}` : ""}. Tip: npx playwright codegen ${ctx.env.baseURL}${ctx.env.auth.loginUrl}`,
      });
    }
    const pattern = loggedOutPatternFor(ctx.env);
    const left = await waitUntilLoggedIn(page, pattern, ctx.timeoutMs ?? 30_000, ctx.env.baseURL);
    if (!left) {
      const alerts = await visibleAlerts(page);
      const shot = await failureScreenshot(ctx, page);
      throw new DominionError(
        `Login did not complete for ${ctx.env.name}/${ctx.roleName}: the browser is still at ${redactText(page.url())}${alerts ? ` ("${alerts}")` : ""}.`,
        {
          code: "LOGIN_FAILED",
          hint: `Check the credentials in .env.local and the steps in ${scriptLabel}${shot ? `; screenshot: ${shot}` : ""}. If login succeeded, check auth.validate.loggedOutPattern in dominion.config.ts.`,
        },
      );
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await saveSession(context, ctx.file);
  } finally {
    await browser.close();
  }
}

/**
 * `manual` strategy: a person logs in by hand in a headed browser (SSO, hardware keys, push MFA),
 * then confirms in the terminal or UI. DOMinion only saves the resulting session.
 */
export async function loginManually(ctx: StrategyContext, role: ManualRoleConfig): Promise<void> {
  if (!ctx.prompter.interactive) {
    throw new DominionError(
      `${ctx.env.name}/${ctx.roleName} uses manual login, which needs a person at the keyboard.`,
      {
        code: "MANUAL_LOGIN_NEEDS_USER",
        hint: `Run \`npx dominion auth ${ctx.env.name} --role ${ctx.roleName}\` locally (or click Log in in the UI). In CI use a form or api role instead.`,
      },
    );
  }
  const loginUrl = role.loginUrl ?? ctx.env.auth.loginUrl;
  const browser = await launch(ctx, ctx.testHooks?.headless ?? false);
  try {
    const context = await browser.newContext({ baseURL: ctx.env.baseURL });
    const page = await context.newPage();
    await page.goto(loginUrl);
    if (ctx.testHooks?.onManualPage) await ctx.testHooks.onManualPage(page);
    await ctx.prompter.waitForUser(
      `Log in to ${ctx.env.name} as "${ctx.roleName}" in the browser window that just opened, then come back here and continue`,
    );
    if (!browser.isConnected() || page.isClosed()) {
      throw new DominionError("The browser window was closed before the session was saved.", {
        code: "MANUAL_LOGIN_ABORTED",
        hint: `Run \`npx dominion auth ${ctx.env.name} --role ${ctx.roleName}\` again and keep the window open until you continue.`,
      });
    }
    const pattern = loggedOutPatternFor(ctx.env, loginUrl);
    if (!(await waitUntilLoggedIn(page, pattern, 5_000, ctx.env.baseURL))) {
      throw new DominionError(`The browser is still on the login page (${redactText(page.url())}); nothing was saved.`, {
        code: "MANUAL_LOGIN_INCOMPLETE",
        hint: "Finish logging in before continuing, or adjust auth.validate.loggedOutPattern in dominion.config.ts.",
      });
    }
    await saveSession(context, ctx.file);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
