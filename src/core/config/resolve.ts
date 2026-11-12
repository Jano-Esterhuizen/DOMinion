import { isAbsolute, join, resolve } from "node:path";
import { DominionError } from "../errors";
import type { LoadedConfig } from "./loader";
import type { DominionConfig, EnvironmentConfig, RoleConfig } from "./schema";

/** An environment with defaults applied and paths/URLs made absolute. */
export interface ResolvedEnvironment {
  name: string;
  /** Base URL without a trailing slash. */
  baseURL: string;
  origin: string;
  allowedOrigins: string[];
  allowDestructive: boolean;
  auth: {
    loginUrl: string;
    /** Absolute path of the login script. */
    loginScript: string;
    /** Absolute path of the api login module, if configured. */
    apiLogin?: string;
    validate?: {
      /** Absolute URL of a page only logged-in users can open. */
      url: string;
      loggedOutPattern: string | RegExp;
    };
  };
  roles: Record<string, RoleConfig>;
}

/** Absolute paths DOMinion reads and writes in the consumer repo. */
export interface ProjectPaths {
  root: string;
  configPath: string;
  testDir: string;
  specsDir: string;
  /** .auth/ (gitignored): saved sessions. */
  authDir: string;
  /** .dominion/ (gitignored): run logs, crawl output, traces. */
  dominionDir: string;
  runsDir: string;
  /** dominion/: committed consumer-owned files (login script, prompt overrides). */
  consumerDir: string;
  promptOverridesDir: string;
}

export function projectPaths(loaded: LoadedConfig): ProjectPaths {
  const { root, config } = loaded;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  return {
    root,
    configPath: loaded.configPath,
    testDir: abs(config.project?.outputDir ?? config.testDir),
    specsDir: abs(config.specsDir),
    authDir: join(root, ".auth"),
    dominionDir: join(root, ".dominion"),
    runsDir: join(root, ".dominion", "runs"),
    consumerDir: join(root, "dominion"),
    promptOverridesDir: join(root, "dominion", "prompts"),
  };
}

/** Joins a path ("/login") or absolute URL onto a base URL. */
export function absoluteUrl(baseURL: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseURL.replace(/\/+$/, "")}/${pathOrUrl.replace(/^\/+/, "")}`;
}

function resolveEnvironment(name: string, env: EnvironmentConfig, root: string): ResolvedEnvironment {
  const baseURL = env.baseURL.replace(/\/+$/, "");
  const origin = new URL(baseURL).origin;
  const auth = env.auth;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  return {
    name,
    baseURL,
    origin,
    allowedOrigins: env.allowedOrigins?.length ? env.allowedOrigins.map((o) => o.replace(/\/+$/, "")) : [origin],
    allowDestructive: env.allowDestructive,
    auth: {
      loginUrl: auth?.loginUrl ?? "/login",
      loginScript: abs(auth?.loginScript ?? "./dominion/auth/login.ts"),
      apiLogin: auth?.apiLogin ? abs(auth.apiLogin) : undefined,
      validate: auth?.validate
        ? { url: absoluteUrl(baseURL, auth.validate.url), loggedOutPattern: auth.validate.loggedOutPattern }
        : undefined,
    },
    roles: env.roles,
  };
}

/** Looks up an environment by name, with an error that lists the configured ones. */
export function getEnvironment(loaded: LoadedConfig, name: string): ResolvedEnvironment {
  const env = loaded.config.environments[name];
  if (!env) {
    const known = Object.keys(loaded.config.environments);
    throw new DominionError(`Unknown environment "${name}".`, {
      code: "UNKNOWN_ENV",
      hint: `Configured environments: ${known.join(", ")}. Add "${name}" under environments in dominion.config.ts or pick one of those.`,
    });
  }
  return resolveEnvironment(name, env, loaded.root);
}

export function listEnvironments(loaded: LoadedConfig): ResolvedEnvironment[] {
  return Object.keys(loaded.config.environments).map((name) => getEnvironment(loaded, name));
}

/** Looks up a role, with an error that lists the environment's roles. */
export function getRole(env: ResolvedEnvironment, roleName: string): RoleConfig {
  const role = env.roles[roleName];
  if (!role) {
    throw new DominionError(`Unknown role "${roleName}" in environment "${env.name}".`, {
      code: "UNKNOWN_ROLE",
      hint: `Roles in ${env.name}: ${Object.keys(env.roles).join(", ")}.`,
    });
  }
  return role;
}

/**
 * Picks the role to use when --role is omitted: the only role, or the only role that needs a
 * session. Otherwise the user has to choose.
 */
export function defaultRole(env: ResolvedEnvironment): string {
  const names = Object.keys(env.roles);
  if (names.length === 1) return names[0]!;
  const loggedIn = names.filter((n) => env.roles[n]!.strategy !== "none");
  if (loggedIn.length === 1) return loggedIn[0]!;
  throw new DominionError(`Environment "${env.name}" has several roles; choose one with --role.`, {
    code: "ROLE_REQUIRED",
    hint: `Roles in ${env.name}: ${names.join(", ")}.`,
  });
}

/** `.auth/<env>-<role>.json`, the saved session for a role. */
export function sessionFile(paths: Pick<ProjectPaths, "authDir">, envName: string, roleName: string): string {
  return join(paths.authDir, `${envName}-${roleName}.json`);
}

/**
 * Whether a landed URL matches loggedOutPattern. A RegExp is tested against the full URL. A string
 * that is an absolute URL matches by prefix. A path string ("/login") matches that path and paths
 * below it ("/login/mfa", "/login?next=/x"); "/" matches only the root path. Strings containing "*"
 * are globs over the path.
 */
export function matchesLoggedOutPattern(landedUrl: string, pattern: string | RegExp, baseURL?: string): boolean {
  if (typeof pattern === "string" && baseURL && !/^https?:\/\//i.test(pattern)) {
    // Apps served under a sub-path (https://host/app): "/login" also means "/app/login".
    try {
      const basePath = new URL(baseURL).pathname.replace(/\/+$/, "");
      const landed = new URL(landedUrl);
      if (basePath && (landed.pathname === basePath || landed.pathname.startsWith(`${basePath}/`))) {
        const stripped = new URL(landed.href);
        stripped.pathname = landed.pathname.slice(basePath.length) || "/";
        if (matchesLoggedOutPattern(stripped.href, pattern)) return true;
      }
    } catch {
      // fall through to the plain comparison
    }
  }
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(landedUrl);
  }
  if (/^https?:\/\//i.test(pattern)) return landedUrl.startsWith(pattern);
  let pathname: string;
  try {
    pathname = new URL(landedUrl).pathname;
  } catch {
    return false;
  }
  if (pattern.includes("*")) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    return new RegExp(`^${source}$`).test(pathname);
  }
  const normalized = pattern.length > 1 ? pattern.replace(/\/+$/, "") : pattern;
  if (normalized === "/") return pathname === "/";
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export type EnvVarKind = "user" | "pass" | "totp" | "token";

export interface EnvVarReference {
  env: string;
  role: string;
  kind: EnvVarKind;
  name: string;
}

/** Every env var name the config references for credentials. */
export function referencedEnvVars(config: DominionConfig): EnvVarReference[] {
  const refs: EnvVarReference[] = [];
  for (const [envName, env] of Object.entries(config.environments)) {
    for (const [roleName, role] of Object.entries(env.roles)) {
      const push = (kind: EnvVarKind, name: string | undefined) => {
        if (name) refs.push({ env: envName, role: roleName, kind, name });
      };
      if (role.strategy === "form") {
        push("user", role.userEnv);
        push("pass", role.passEnv);
        push("totp", role.totpEnv);
      } else if (role.strategy === "api") {
        push("user", role.userEnv);
        push("pass", role.passEnv);
        push("totp", role.totpEnv);
        push("token", role.tokenEnv);
      }
    }
  }
  return refs;
}

/** Env vars a role needs that are unset or empty. */
export function missingRoleEnvVars(
  config: DominionConfig,
  envName: string,
  roleName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return referencedEnvVars(config)
    .filter((ref) => ref.env === envName && ref.role === roleName)
    .filter((ref) => !env[ref.name])
    .map((ref) => ref.name);
}

export type { DominionConfig };
