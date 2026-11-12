import { existsSync } from "node:fs";
import type { LoadedConfig } from "../config/loader";
import { getEnvironment, getRole, missingRoleEnvVars, projectPaths, sessionFile } from "../config/resolve";
import type { RoleStrategy } from "../config/schema";
import { DominionError } from "../errors";
import { loadPlaywright } from "../playwright/resolve";
import type { Prompter } from "../prompter";
import { activeRedactor, type Redactor } from "../redact";
import { loginWithApi } from "./api";
import { ensureExistingSession, existingSessionFile } from "./existing";
import { addSessionSecrets } from "./headers";
import { inspectStorageState, type SessionCheck, type SessionState, validateSession } from "./session";
import { type AuthTestHooks, loginManually, loginWithForm, type StrategyContext } from "./strategies";

export interface EnsureSessionOptions {
  loaded: LoadedConfig;
  envName: string;
  roleName: string;
  prompter: Prompter;
  /** Log in again even if the saved session is valid. */
  force?: boolean;
  /** Show the browser during form login. */
  headed?: boolean;
  /** Re-authenticate automatically when the session is missing or invalid (default true). */
  autoLogin?: boolean;
  /** A run's redactor: session header tokens are registered with it as well as the process-wide one. */
  redactor?: Redactor;
  testHooks?: AuthTestHooks;
}

export type SessionAction = "not-needed" | "reused" | "logged-in";

export interface EnsureSessionResult {
  env: string;
  role: string;
  strategy: RoleStrategy;
  action: SessionAction;
  /** Absolute path of the storage state file, or undefined for `none`. */
  file?: string;
  check?: SessionCheck;
}

/** Path of the storage state a role's agents and tests start from, or undefined for guests. */
export function storageStatePathFor(loaded: LoadedConfig, envName: string, roleName: string): string | undefined {
  const env = getEnvironment(loaded, envName);
  const role = getRole(env, roleName);
  if (role.strategy === "none") return undefined;
  if (role.strategy === "existing") return existingSessionFile(loaded, role).file;
  return sessionFile(projectPaths(loaded), envName, roleName);
}

function registerSecrets(options: EnsureSessionOptions, file: string): void {
  addSessionSecrets(activeRedactor(), file);
  if (options.redactor) addSessionSecrets(options.redactor, file);
}

/**
 * Makes sure a role has a valid saved session before a run (spec: Session lifecycle). form/api
 * roles re-authenticate automatically; manual roles prompt the user and wait.
 */
export async function ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult> {
  const { loaded, envName, roleName } = options;
  const env = getEnvironment(loaded, envName);
  const role = getRole(env, roleName);
  const base = { env: envName, role: roleName, strategy: role.strategy };
  if (role.strategy === "none") return { ...base, action: "not-needed" };

  if (role.strategy === "existing") {
    const result = await ensureExistingSession({ loaded, env, roleName, role, force: options.force });
    return { ...base, ...result };
  }
  const file = sessionFile(projectPaths(loaded), envName, roleName);
  const { module: playwright } = await loadPlaywright(loaded.root);

  if (!options.force && existsSync(file)) {
    const check = await validateSession({ playwright, env, file });
    if (check.state === "valid" || check.state === "unverified" || options.autoLogin === false) {
      registerSecrets(options, file);
      return { ...base, action: "reused", file, check };
    }
  } else if (options.autoLogin === false) {
    return { ...base, action: "reused", file, check: { state: "missing" } };
  }

  const ctx: StrategyContext = {
    loaded,
    env,
    roleName,
    file,
    playwright,
    prompter: options.prompter,
    headed: options.headed,
    testHooks: options.testHooks,
  };
  if (role.strategy === "form") await loginWithForm(ctx, role);
  else if (role.strategy === "api") await loginWithApi(ctx, role);
  else await loginManually(ctx, role);
  registerSecrets(options, file);

  const check = await validateSession({ playwright, env, file });
  if (check.state === "expired") {
    throw new DominionError(
      `Logged in to ${envName}/${roleName}, but ${env.auth.validate?.url ?? "the validation page"} still lands on ${check.landedUrl}.`,
      {
        code: "SESSION_NOT_VALID_AFTER_LOGIN",
        hint: "Check auth.validate in dominion.config.ts: validate.url must be a page only logged-in users can open, and loggedOutPattern must match where logged-out users are sent.",
      },
    );
  }
  return { ...base, action: "logged-in", file, check };
}

/** Badge states shown per role in the UI and doctor (spec: Session lifecycle, step 4). */
export type RoleBadge =
  | "no-session-needed"
  | "credentials-missing"
  | "never-logged-in"
  | "session-valid"
  | "session-expired"
  | "session-unverified";

export interface RoleStatus {
  env: string;
  role: string;
  strategy: RoleStrategy;
  /** Env var names that are not set (never values). */
  missingEnvVars: string[];
  session: SessionState | "not-needed";
  badge: RoleBadge;
  sessionFile?: string;
  savedAt?: string;
  detail?: string;
}

export interface RoleStatusOptions {
  loaded: LoadedConfig;
  envName: string;
  roleName: string;
  /** Open a browser to check the session (slower). Otherwise only file presence is checked. */
  validate?: boolean;
}

export async function roleStatus(options: RoleStatusOptions): Promise<RoleStatus> {
  const { loaded, envName, roleName } = options;
  const env = getEnvironment(loaded, envName);
  const role = getRole(env, roleName);
  const missingEnvVars = missingRoleEnvVars(loaded.config, envName, roleName);
  const base = { env: envName, role: roleName, strategy: role.strategy, missingEnvVars };
  if (role.strategy === "none") return { ...base, session: "not-needed", badge: "no-session-needed" };
  const file = role.strategy === "existing" ? existingSessionFile(loaded, role).file : sessionFile(projectPaths(loaded), envName, roleName);
  let check: SessionCheck = { state: existsSync(file) ? "unverified" : "missing" };
  if (check.state !== "missing" && options.validate) {
    if (env.auth.validate) {
      const { module: playwright } = await loadPlaywright(loaded.root);
      check = await validateSession({ playwright, env, file });
    } else {
      const pre = inspectStorageState(file);
      check = pre.ok ? { state: "unverified", detail: `environment "${env.name}" has no auth.validate, so the session cannot be checked` } : { state: "expired", detail: pre.detail };
    }
  }
  const badge: RoleBadge =
    check.state === "valid"
      ? "session-valid"
      : check.state === "expired"
        ? "session-expired"
        : check.state === "unverified"
          ? "session-unverified"
          : missingEnvVars.length > 0
            ? "credentials-missing"
            : "never-logged-in";
  return {
    ...base,
    session: check.state,
    badge: missingEnvVars.length > 0 && check.state !== "valid" ? "credentials-missing" : badge,
    sessionFile: file,
    savedAt: check.savedAt?.toISOString(),
    detail: check.detail,
  };
}

export { addSessionSecrets, readSessionHeaders, sessionHeadersFile } from "./headers";
export type { SessionCheck, SessionState } from "./session";
