import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { createJiti } from "jiti";
import type { z } from "zod";
import { DominionError, errorMessage } from "../errors";
import { relativePosix } from "../fs";
import { DOMINION_CONFIG_NAMES } from "../init/detect";
import { packageName, packageRoot, runningFromDist } from "../package-info";
import { configSchema, type DominionConfig } from "./schema";

export interface LoadedConfig {
  /** Consumer repo root: the directory that contains dominion.config.ts. */
  root: string;
  /** Absolute path of the config file. */
  configPath: string;
  config: DominionConfig;
  /** Absolute path of the .env.local that was read, if one exists. */
  envFile?: string;
}

export interface LoadConfigOptions {
  /** Where to start searching for dominion.config.*; defaults to process.cwd(). */
  cwd?: string;
  /** Explicit config file path (skips the search). */
  configPath?: string;
  /** Read <root>/.env.local into process.env (process env wins). Default true. */
  loadEnvFile?: boolean;
}

/** Walks up from `startDir` to the repository root (a folder with .git) looking for dominion.config.*. */
export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of DOMINION_CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads <root>/.env.local into process.env without overriding variables that are already set, so
 * CI secrets and shell exports win. Returns the names it set (never values).
 */
export function loadEnvFile(root: string, env: NodeJS.ProcessEnv = process.env): { path?: string; loaded: string[] } {
  const path = join(root, ".env.local");
  if (!existsSync(path)) return { loaded: [] };
  const parsed = parseDotenv(readFileSync(path));
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return { path, loaded };
}

/** The module consumers import in dominion.config.ts resolves to this running copy of DOMinion. */
function ownEntryPoint(): string {
  return runningFromDist() ? join(packageRoot(), "dist", "index.js") : join(packageRoot(), "src", "index.ts");
}

/** Imports a TypeScript or JavaScript module from the consumer repo without a build step. */
export async function importConsumerModule<T = unknown>(absPath: string): Promise<T> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    interopDefault: true,
    alias: { [packageName()]: ownEntryPoint() },
  });
  return (await jiti.import(absPath, { default: true })) as T;
}

/** Formats zod issues as "path: message" lines that point at the offending key. */
export function formatZodIssues(issues: ReadonlyArray<z.core.$ZodIssue>): string[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    let message = issue.message;
    if (issue.code === "unrecognized_keys") {
      message = `unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
    }
    return path ? `${path}: ${message}` : message;
  });
}

export function validateConfig(raw: unknown, configLabel: string): DominionConfig {
  if (raw === null || typeof raw !== "object") {
    throw new DominionError(`${configLabel} must export a config object (export default defineConfig({ ... })).`, {
      code: "CONFIG_NO_DEFAULT_EXPORT",
      hint: `Check that ${configLabel} has \`export default defineConfig({ ... })\`.`,
    });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = formatZodIssues(parsed.error.issues);
    throw new DominionError(`${configLabel} is invalid:\n${lines.map((l) => `  - ${l}`).join("\n")}`, {
      code: "CONFIG_INVALID",
      hint: `Fix the keys listed above in ${configLabel}. The config names env vars; it never holds secret values.`,
    });
  }
  return parsed.data;
}

/** Finds, loads (via jiti) and validates dominion.config.ts, after reading .env.local. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  let configPath: string | undefined;
  if (options.configPath) {
    configPath = isAbsolute(options.configPath) ? options.configPath : resolve(cwd, options.configPath);
    if (!existsSync(configPath)) {
      throw new DominionError(`Config file not found: ${configPath}`, {
        code: "CONFIG_NOT_FOUND",
        hint: "Check the path, or run `npx dominion init` to create dominion.config.ts.",
      });
    }
  } else {
    configPath = findConfigFile(cwd);
    if (!configPath) {
      throw new DominionError(`No dominion.config.ts found in ${cwd} or its parent folders.`, {
        code: "CONFIG_NOT_FOUND",
        hint: "Run `npx dominion init` in your project root to create one.",
      });
    }
  }

  const root = dirname(configPath);
  const label = relativePosix(cwd, configPath).startsWith("..") ? configPath : relativePosix(cwd, configPath);
  const envFile = options.loadEnvFile === false ? undefined : loadEnvFile(root).path;

  let raw: unknown;
  try {
    raw = await importConsumerModule(configPath);
  } catch (error) {
    throw new DominionError(`Could not load ${label}: ${errorMessage(error)}`, {
      code: "CONFIG_LOAD_FAILED",
      cause: error,
      hint: "Fix the syntax or import error above. The config is loaded with jiti, so TypeScript is supported.",
    });
  }

  return { root, configPath, config: validateConfig(raw, label), envFile };
}
