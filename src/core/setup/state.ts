import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type RoleBadge, roleStatus } from "../auth";
import { type LoadedConfig, loadConfig } from "../config/loader";
import { getEnvironment, getRole, listEnvironments, referencedEnvVars } from "../config/resolve";
import { type DoctorCheck, detectApiCredential, runDoctor } from "../doctor";
import { DominionError, errorMessage, isDominionError } from "../errors";
import { relativePosix } from "../fs";
import { DEFAULT_BASE_URL, isExistingSuite } from "../init";
import { detectPackageManager, findDominionConfig, hasPlaywrightTest, type PackageManager } from "../init/detect";
import { packageName, packageVersion } from "../package-info";
import { buildProfile, renderProfile } from "../project/profile";
import { findPlaywrightConfigsInRepo, scanProject } from "../project/scan";
import { credentialEnvVarsUsedBy, scannedFiles } from "../project/secrets";
import { type EnvVarState, envVarStates } from "./env-file";
import { type LoginFormSpec, type LoginScriptKind, readLoginScriptState } from "./login-builder";

/** What `init` would do in this repo, worked out without writing anything. */
export interface ProjectDetection {
  playwrightConfigs: string[];
  playwrightConfig?: string;
  /** "existing": a hand-written Playwright suite was found; DOMinion adopts its conventions. */
  mode: "new" | "existing";
  /** The detected project profile, as it would be written into dominion.config.ts. */
  profileSource?: string;
  notes: string[];
  /** Credentials the suite reads (become secretEnv). */
  secretEnv: string[];
  suggestedBaseURL: string;
  error?: string;
}

export async function detectProject(root: string, playwrightConfig?: string): Promise<ProjectDetection> {
  const playwrightConfigs = findPlaywrightConfigsInRepo(root);
  const chosen = playwrightConfig ?? playwrightConfigs[0];
  const base: ProjectDetection = { playwrightConfigs, playwrightConfig: chosen, mode: "new", notes: [], secretEnv: [], suggestedBaseURL: DEFAULT_BASE_URL };
  if (!chosen || !hasPlaywrightTest(root)) return base;
  try {
    const scan = await scanProject(root, chosen);
    const suggestedBaseURL = scan.config.baseURL && /^https?:\/\//.test(scan.config.baseURL) ? scan.config.baseURL.replace(/\/+$/, "") : DEFAULT_BASE_URL;
    if (!isExistingSuite(scan)) return { ...base, suggestedBaseURL };
    const draft = buildProfile(root, scan);
    return {
      ...base,
      mode: "existing",
      profileSource: renderProfile(draft.profile),
      notes: draft.notes,
      secretEnv: credentialEnvVarsUsedBy(root, scannedFiles(scan, chosen)),
      suggestedBaseURL,
    };
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
}

/** "todo" blocks Minion runner; "optional" is recommended but not required. */
export type SetupItemStatus = "done" | "todo" | "optional";

export interface SetupItem {
  id: string;
  title: string;
  status: SetupItemStatus;
  detail?: string;
  hint?: string;
  /** The Setup tab section that fixes it. */
  section: "playwright" | "api-key" | "project" | "app" | "roles" | "login-script" | "test-login" | "secret-env" | "checks";
  /** For per-environment sections. */
  env?: string;
}

export interface RoleSetup {
  name: string;
  strategy: string;
  envVars: Array<EnvVarState & { kind: string }>;
  badge: RoleBadge;
  detail?: string;
  savedAt?: string;
  /** Form roles: the login script they use. */
  loginScript?: { path: string; kind: LoginScriptKind; spec?: LoginFormSpec };
  totp: boolean;
}

export interface EnvironmentSetup {
  name: string;
  baseURL: string;
  loginUrl: string;
  validate?: { url: string; loggedOutPattern: string };
  roles: RoleSetup[];
}

export interface SetupState {
  root: string;
  version: string;
  packageName: string;
  packageJson: boolean;
  packageManager: PackageManager;
  playwright: { configs: string[]; installed: boolean };
  /** Present once dominion.config.ts exists. */
  config?: { path: string; mode: "new" | "existing"; testIdAttribute: string; error?: { message: string; hint?: string } };
  /** Present while there is no dominion.config.ts. */
  detection?: ProjectDetection;
  apiKey: { set: boolean; credential?: string; inFile: boolean; fromShell: boolean };
  /** Credentials an existing suite reads (secretEnv). */
  secretEnv: EnvVarState[];
  environments: EnvironmentSetup[];
  items: SetupItem[];
  /** Other doctor findings (git hygiene, prompt overrides, profile drift...). Errors block. */
  checks: DoctorCheck[];
  ready: boolean;
  /** Blocking items and errors left. */
  remaining: number;
}

/** Doctor checks the Setup items already cover, by id or id prefix. */
const COVERED = [/^config$/, /^playwright$/, /^playwright-config$/, /^api-key$/, /^validate:/, /^login-script:/, /^role:[^:]+$/];

function scriptPath(loaded: LoadedConfig, envScript: string, roleScript?: string): string {
  if (!roleScript) return envScript;
  return isAbsolute(roleScript) ? roleScript : resolve(loaded.root, roleScript);
}

/** The login script a form role runs (its own loginScript, else the environment's). */
export function loginScriptPathFor(loaded: LoadedConfig, envName: string, roleName: string): string {
  const env = getEnvironment(loaded, envName);
  const role = getRole(env, roleName);
  if (role.strategy !== "form") {
    throw new DominionError(`${envName}/${roleName} is a ${role.strategy} role; only form roles use a login script.`, { code: "SETUP_NOT_FORM_ROLE" });
  }
  return scriptPath(loaded, env.auth.loginScript, role.loginScript);
}

/**
 * Everything the Setup tab shows, computed from disk: Playwright, the API key, the config, each
 * role's credentials, login script and session, plus doctor's other findings. Never contains a
 * secret value. Minion runner unlocks when `ready`.
 */
export async function getSetupState(root: string, options: { loaded?: LoadedConfig } = {}): Promise<SetupState> {
  const items: SetupItem[] = [];
  const playwrightConfigs = findPlaywrightConfigsInRepo(root);
  const installed = hasPlaywrightTest(root);
  const packageJson = existsSync(join(root, "package.json"));
  const api = envVarStates(root, ["ANTHROPIC_API_KEY"])[0]!;
  const credential = detectApiCredential();
  const state: SetupState = {
    root,
    version: packageVersion(),
    packageName: packageName(),
    packageJson,
    packageManager: detectPackageManager(root),
    playwright: { configs: playwrightConfigs, installed },
    apiKey: { set: Boolean(credential), credential, inFile: api.inFile, fromShell: api.fromShell },
    secretEnv: [],
    environments: [],
    items,
    checks: [],
    ready: false,
    remaining: 0,
  };

  items.push(
    playwrightConfigs.length && installed
      ? { id: "playwright", title: "Playwright", status: "done", detail: playwrightConfigs.join(", "), section: "playwright" }
      : {
          id: "playwright",
          title: "Playwright",
          status: "todo",
          detail: playwrightConfigs.length ? "@playwright/test is not installed" : "this project has no playwright.config yet",
          hint: packageJson ? undefined : "This folder has no package.json. Run `npm init -y` here first.",
          section: "playwright",
        },
  );
  items.push(
    credential
      ? { id: "api-key", title: "Claude API key", status: "done", detail: `${credential} is set${api.fromShell ? " (from your shell)" : ""}`, section: "api-key" }
      : { id: "api-key", title: "Claude API key", status: "todo", detail: "needed for planning, generating and healing tests", section: "api-key" },
  );

  let loaded = options.loaded;
  const configFile = findDominionConfig(root);
  if (!loaded && configFile) {
    try {
      loaded = await loadConfig({ cwd: root });
    } catch (error) {
      state.config = { path: configFile, mode: "new", testIdAttribute: "data-testid", error: { message: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined } };
      items.push({ id: "dominion", title: "DOMinion config", status: "todo", detail: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined, section: "project" });
    }
  }
  if (!loaded) {
    if (!configFile) {
      state.detection = await detectProject(root);
      items.push({ id: "dominion", title: "DOMinion config", status: "todo", detail: "not created yet", section: "project" });
    }
    return finish(state);
  }

  const config = loaded.config;
  state.config = { path: relativePosix(root, loaded.configPath), mode: config.project ? "existing" : "new", testIdAttribute: config.testIdAttribute };
  items.push({ id: "dominion", title: "DOMinion config", status: "done", detail: `${state.config.path} (${config.project ? "existing suite" : "new setup"})`, section: "project" });

  const refs = referencedEnvVars(config);
  for (const env of listEnvironments(loaded)) {
    const rawEnv = config.environments[env.name]!;
    const validate = rawEnv.auth?.validate;
    const envSetup: EnvironmentSetup = {
      name: env.name,
      baseURL: env.baseURL,
      loginUrl: env.auth.loginUrl,
      validate: validate ? { url: validate.url, loggedOutPattern: String(validate.loggedOutPattern) } : undefined,
      roles: [],
    };
    state.environments.push(envSetup);
    items.push(
      validate
        ? { id: `app:${env.name}`, title: `${env.name}: your app`, status: "done", detail: env.baseURL, section: "app", env: env.name }
        : {
            id: `app:${env.name}`,
            title: `${env.name}: your app`,
            status: "optional",
            detail: "session checks are off",
            hint: "Set a page only logged-in users can open, so DOMinion notices expired sessions.",
            section: "app",
            env: env.name,
          },
    );

    const missing: string[] = [];
    const loginRoles: string[] = [];
    const loggedIn: string[] = [];
    const scripts = new Map<string, { roles: string[]; working: boolean }>();
    for (const [roleName, role] of Object.entries(env.roles)) {
      const roleRefs = refs.filter((r) => r.env === env.name && r.role === roleName);
      const states = envVarStates(root, roleRefs.map((r) => r.name));
      const status = await roleStatus({ loaded, envName: env.name, roleName });
      const roleSetup: RoleSetup = {
        name: roleName,
        strategy: role.strategy,
        envVars: states.map((s) => ({ ...s, kind: roleRefs.find((r) => r.name === s.name)!.kind })),
        badge: status.badge,
        detail: status.detail,
        savedAt: status.savedAt,
        totp: role.strategy === "form" && Boolean(role.totpEnv),
      };
      missing.push(...states.filter((s) => !s.set).map((s) => s.name));
      const hasSession = status.badge === "session-valid" || status.badge === "session-unverified";
      if (role.strategy === "form") {
        const path = scriptPath(loaded, env.auth.loginScript, role.loginScript);
        const script = readLoginScriptState(path, packageName());
        roleSetup.loginScript = { path: relativePosix(root, path), ...script };
        const entry = scripts.get(path) ?? { roles: [], working: false };
        entry.roles.push(roleName);
        entry.working ||= hasSession;
        scripts.set(path, entry);
      }
      if (role.strategy !== "none") {
        loginRoles.push(roleName);
        if (hasSession) loggedIn.push(roleName);
        // Runs log form/api roles in on their own, so testing every role is recommended, not required.
        items.push(
          hasSession
            ? { id: `session:${env.name}/${roleName}`, title: `${env.name}/${roleName}: login`, status: "done", detail: status.badge === "session-valid" ? "session valid" : "session saved", section: "test-login", env: env.name }
            : {
                id: `session:${env.name}/${roleName}`,
                title: `${env.name}/${roleName}: login`,
                status: "optional",
                detail: status.badge === "session-expired" ? "session expired" : "not logged in yet",
                hint: role.strategy === "manual" ? "Click Log in and sign in by hand in the browser that opens." : "Click Test login.",
                section: "test-login",
                env: env.name,
              },
        );
      }
      envSetup.roles.push(roleSetup);
    }
    // One successful login per environment proves the login flow works before any run.
    if (loginRoles.length) {
      items.push(
        loggedIn.length
          ? { id: `login:${env.name}`, title: `${env.name}: first login`, status: "done", detail: `logged in as ${loggedIn.join(", ")}`, section: "test-login", env: env.name }
          : {
              id: `login:${env.name}`,
              title: `${env.name}: first login`,
              status: "todo",
              detail: "no role has logged in yet",
              hint: "Click Test login for one of the roles.",
              section: "test-login",
              env: env.name,
            },
      );
    }
    items.push(
      missing.length
        ? { id: `credentials:${env.name}`, title: `${env.name}: credentials`, status: "todo", detail: `${missing.join(", ")} not set`, section: "roles", env: env.name }
        : { id: `credentials:${env.name}`, title: `${env.name}: credentials`, status: "done", section: "roles", env: env.name },
    );
    for (const [path, entry] of scripts) {
      const script = readLoginScriptState(path, packageName());
      const file = relativePosix(root, path);
      const done = script.kind === "builder" || script.kind === "custom" || (script.kind === "template" && entry.working);
      items.push(
        done
          ? { id: `login-script:${file}`, title: `Login script (${entry.roles.join(", ")})`, status: "done", detail: file, section: "login-script", env: env.name }
          : {
              id: `login-script:${file}`,
              title: `Login script (${entry.roles.join(", ")})`,
              status: "todo",
              detail: script.kind === "missing" ? `${file} does not exist` : `${file} is still the template`,
              hint: "Use Detect from login page, check the fields, then Save.",
              section: "login-script",
              env: env.name,
            },
      );
    }
  }

  state.secretEnv = envVarStates(root, config.secretEnv);
  const unsetSecrets = state.secretEnv.filter((s) => !s.set).map((s) => s.name);
  if (state.secretEnv.length) {
    items.push(
      unsetSecrets.length
        ? { id: "secret-env", title: "Your suite's credentials", status: "optional", detail: `${unsetSecrets.join(", ")} not set`, hint: "Your setup project reads these.", section: "secret-env" }
        : { id: "secret-env", title: "Your suite's credentials", status: "done", section: "secret-env" },
    );
  }

  const report = await runDoctor({ cwd: root, validateSessions: false });
  state.checks = report.checks.filter((c) => c.status !== "ok" && c.status !== "skip" && !COVERED.some((re) => re.test(c.id)));
  return finish(state);
}

function finish(state: SetupState): SetupState {
  const blocking = state.items.filter((i) => i.status === "todo").length + state.checks.filter((c) => c.status === "error").length;
  state.remaining = blocking;
  state.ready = blocking === 0 && Boolean(state.config) && !state.config?.error;
  return state;
}
