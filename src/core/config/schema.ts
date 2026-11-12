import { z } from "zod";

/**
 * The dominion.config.ts schema. The config names environment variables; it never holds secret
 * values. Validation happens at load time (see loader.ts) and produces messages that point at the
 * offending key.
 */

/** Names used in file names (.auth/<env>-<role>.json), Playwright project names and tags. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const nameKey = z
  .string()
  .regex(NAME_RE, "use letters, digits, '-' or '_' (it is used in file names, project names and tags)");

/** The config stores env var NAMES. Rejecting values that do not look like names catches pasted secrets. */
export const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envVarName = z
  .string()
  .regex(
    ENV_VAR_NAME_RE,
    "must be the NAME of an environment variable (for example STAGING_CUSTOMER_USER), never the secret value itself",
  );

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value.replace(/\/$/, "");
  } catch {
    return false;
  }
}

const httpUrl = z.string().refine(isHttpUrl, "must be an absolute http(s) URL, for example https://staging.example.com");
const origin = z
  .string()
  .refine(isOrigin, "must be an origin (scheme, host and optional port, no path), for example https://auth.example.com");
const relativeOrAbsolutePath = z.string().min(1);

/** A URL path ("/login") or RegExp. Strings match when the landed URL's path starts with them. */
export const loggedOutPatternSchema = z.union([z.string().min(1), z.instanceof(RegExp)]);

export const sessionValidationSchema = z.strictObject({
  /** A page only logged-in users can open, relative to baseURL (e.g. "/account"). */
  url: z.string().min(1),
  /** Where the app sends logged-out users. Landing on it means the session is invalid. */
  loggedOutPattern: loggedOutPatternSchema,
});

export const environmentAuthSchema = z.strictObject({
  /** Login page, relative to baseURL. */
  loginUrl: z.string().min(1).default("/login"),
  /** Consumer-owned login script for the `form` strategy. */
  loginScript: relativeOrAbsolutePath.default("./dominion/auth/login.ts"),
  /** Consumer-owned module for the `api` strategy; default export returns cookies and/or headers. */
  apiLogin: relativeOrAbsolutePath.optional(),
  validate: sessionValidationSchema.optional(),
});

export const noneRoleSchema = z.strictObject({ strategy: z.literal("none") });

export const formRoleSchema = z.strictObject({
  strategy: z.literal("form"),
  userEnv: envVarName,
  passEnv: envVarName,
  totpEnv: envVarName.optional(),
  /** Optional per-role login script; defaults to the environment's auth.loginScript. */
  loginScript: relativeOrAbsolutePath.optional(),
});

export const manualRoleSchema = z.strictObject({
  strategy: z.literal("manual"),
  /** Optional per-role login page; defaults to the environment's auth.loginUrl. */
  loginUrl: z.string().min(1).optional(),
});

export const apiRoleSchema = z.strictObject({
  strategy: z.literal("api"),
  userEnv: envVarName.optional(),
  passEnv: envVarName.optional(),
  totpEnv: envVarName.optional(),
  tokenEnv: envVarName.optional(),
  /** Optional per-role module; defaults to the environment's auth.apiLogin. */
  apiLogin: relativeOrAbsolutePath.optional(),
});

export const existingRoleSchema = z.strictObject({
  strategy: z.literal("existing"),
  /** Name of the project's own setup project (overrides project.auth.setupProject). */
  setupProject: z.string().min(1).optional(),
  /** Storage state file written by the project's own setup (overrides project.auth.storageState). */
  storageState: relativeOrAbsolutePath.optional(),
});

export const roleSchema = z.discriminatedUnion("strategy", [
  noneRoleSchema,
  formRoleSchema,
  manualRoleSchema,
  apiRoleSchema,
  existingRoleSchema,
]);

export const environmentSchema = z.strictObject({
  baseURL: httpUrl,
  /** Origins the agent's browser may request. Defaults to the baseURL origin. */
  allowedOrigins: z.array(origin).optional(),
  /** When false, agents stop before final submit/pay/delete actions. */
  allowDestructive: z.boolean().default(false),
  auth: environmentAuthSchema.optional(),
  roles: z
    .record(nameKey, roleSchema)
    .refine((roles) => Object.keys(roles).length > 0, "define at least one role, for example guest: { strategy: \"none\" }"),
});

export const crawlSchema = z.strictObject({
  maxPages: z.number().int().positive().default(200),
  maxDepth: z.number().int().nonnegative().default(4),
  /** URL paths or globs the crawler and agents never visit ("/logout", "**\/admin/users/*\/delete"). */
  exclude: z.array(z.string().min(1)).default([]),
  /** Query params kept when normalizing URLs into patterns. */
  keepQueryParams: z.array(z.string().min(1)).default([]),
});

export const budgetsSchema = z.strictObject({
  maxTurnsPerAgent: z.number().int().positive().default(80),
  maxUsdPerRun: z.number().positive().default(10),
  maxHealAttempts: z.number().int().nonnegative().default(3),
});

/** Browser used by the agents' Playwright MCP server. */
export const agentBrowserSchema = z.strictObject({
  headless: z.boolean().default(true),
  /** "chromium" uses Playwright's bundled build (installed on demand); "chrome"/"msedge" use the system browser. */
  browser: z.enum(["chromium", "chrome", "msedge"]).default("chromium"),
});

/** Existing-project profile written by `init` after scanning an existing Playwright suite (M4). */
export const projectProfileSchema = z.strictObject({
  playwrightConfig: relativeOrAbsolutePath,
  testDir: relativeOrAbsolutePath,
  /** Where DOMinion writes new specs. */
  outputDir: relativeOrAbsolutePath,
  fileNaming: z.string().min(1).default("{flow}.spec.ts"),
  language: z.enum(["ts", "js"]).default("ts"),
  moduleFormat: z.enum(["esm", "cjs"]).optional(),
  testImport: z.string().min(1).default('import { test, expect } from "@playwright/test"'),
  pageObjects: z
    .strictObject({
      dir: relativeOrAbsolutePath,
      style: z.enum(["class", "object", "function"]).default("class"),
      reuse: z.boolean().default(true),
    })
    .optional(),
  exemplars: z.array(relativeOrAbsolutePath).default([]),
  auth: z
    .strictObject({
      strategy: z.literal("existing"),
      setupProject: z.string().min(1).optional(),
      globalSetup: relativeOrAbsolutePath.optional(),
      storageState: relativeOrAbsolutePath,
    })
    .optional(),
  modifyExisting: z.boolean().default(false),
  /** Project generated tests run in (defaults to the first project that depends on the setup project). */
  runProject: z.string().min(1).optional(),
  /** Conventions summary written by the analysis agent during init. */
  conventions: z.string().optional(),
});

export const configSchema = z.strictObject({
  model: z.string().min(1).default("claude-sonnet-5-5"),
  testDir: relativeOrAbsolutePath.default("tests/agent"),
  specsDir: relativeOrAbsolutePath.default("specs"),
  pageObjects: z.boolean().default(true),
  testIdAttribute: z.string().min(1).default("data-testid"),
  /**
   * Other env vars that hold credentials, such as the ones an existing suite's setup project
   * reads. Their values are redacted like role credentials and hidden from agents, but still
   * passed to your tests and setup projects.
   */
  secretEnv: z.array(envVarName).default([]),
  environments: z
    .record(nameKey, environmentSchema)
    .refine((envs) => Object.keys(envs).length > 0, "define at least one environment"),
  crawl: crawlSchema.prefault({}),
  budgets: budgetsSchema.prefault({}),
  agentBrowser: agentBrowserSchema.prefault({}),
  project: projectProfileSchema.optional(),
}).superRefine((config, ctx) => {
  // Env and role names are joined with "-" in .auth/<env>-<role>.json and project names.
  const seen = new Map<string, string>();
  for (const [envName, env] of Object.entries(config.environments)) {
    for (const roleName of Object.keys(env.roles)) {
      const key = `${envName}-${roleName}`.toLowerCase();
      const other = seen.get(key);
      if (other) {
        ctx.addIssue({
          code: "custom",
          path: ["environments", envName, "roles", roleName],
          message: `env "${envName}" + role "${roleName}" and ${other} both map to "${key}" (session file and project name); rename one`,
        });
      } else {
        seen.set(key, `env "${envName}" + role "${roleName}"`);
      }
    }
  }
});

/** What users write in dominion.config.ts (defaults optional). */
export type DominionUserConfig = z.input<typeof configSchema>;
/** The validated config with defaults applied. */
export type DominionConfig = z.output<typeof configSchema>;
export type EnvironmentConfig = z.output<typeof environmentSchema>;
export type EnvironmentAuthConfig = z.output<typeof environmentAuthSchema>;
export type SessionValidationConfig = z.output<typeof sessionValidationSchema>;
export type RoleConfig = z.output<typeof roleSchema>;
export type RoleStrategy = RoleConfig["strategy"];
export type FormRoleConfig = z.output<typeof formRoleSchema>;
export type ManualRoleConfig = z.output<typeof manualRoleSchema>;
export type ApiRoleConfig = z.output<typeof apiRoleSchema>;
export type ExistingRoleConfig = z.output<typeof existingRoleSchema>;
export type CrawlConfig = z.output<typeof crawlSchema>;
export type BudgetsConfig = z.output<typeof budgetsSchema>;
export type AgentBrowserConfig = z.output<typeof agentBrowserSchema>;
export type ProjectProfile = z.output<typeof projectProfileSchema>;
