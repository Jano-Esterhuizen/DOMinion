import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
] as const;

export const DOMINION_CONFIG_NAMES = [
  "dominion.config.ts",
  "dominion.config.mts",
  "dominion.config.js",
  "dominion.config.mjs",
] as const;

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function fromPackageManagerField(dir: string): PackageManager | undefined {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const field = (JSON.parse(readFileSync(pkgPath, "utf8")) as { packageManager?: unknown }).packageManager;
    if (typeof field === "string") {
      const name = field.split("@")[0];
      if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
    }
  } catch {
    // An unreadable package.json is reported elsewhere; detection just falls through.
  }
  return undefined;
}

/**
 * Detects the consumer's package manager: the `packageManager` field, then lockfiles walking up
 * to the repository root (monorepos keep the lockfile at the workspace root), then the user agent
 * of the running package manager, then npm.
 */
export function detectPackageManager(root: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
  let dir = root;
  for (;;) {
    const fromField = fromPackageManagerField(dir);
    if (fromField) return fromField;
    for (const [file, pm] of LOCKFILES) {
      if (existsSync(join(dir, file))) return pm;
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const agent = env.npm_config_user_agent ?? "";
  if (agent.startsWith("pnpm/")) return "pnpm";
  if (agent.startsWith("yarn/")) return "yarn";
  if (agent.startsWith("bun/")) return "bun";
  return "npm";
}

/** Playwright config files directly inside `root`. */
export function findPlaywrightConfigs(root: string): string[] {
  return PLAYWRIGHT_CONFIG_NAMES.filter((name) => existsSync(join(root, name)));
}

/** The dominion.config.* file inside `root`, if any. */
export function findDominionConfig(root: string): string | undefined {
  return DOMINION_CONFIG_NAMES.find((name) => existsSync(join(root, name)));
}

export interface ShellCommand {
  command: string;
  args: string[];
}

/** Command that scaffolds Playwright for the given package manager (create-playwright). */
export function playwrightInitCommand(pm: PackageManager, nonInteractive: boolean): ShellCommand {
  const flags = nonInteractive ? ["--quiet", "--lang=ts", "--browser=chromium"] : [];
  switch (pm) {
    case "pnpm":
      return { command: "pnpm", args: ["create", "playwright", ...flags] };
    case "yarn":
      return { command: "yarn", args: ["create", "playwright", ...flags] };
    case "bun":
      return { command: "bun", args: ["create", "playwright", ...flags] };
    case "npm":
    default:
      return { command: "npm", args: ["init", "playwright@latest", ...(flags.length ? ["--", ...flags] : [])] };
  }
}

/** True when @playwright/test is resolvable from the consumer root. */
export function hasPlaywrightTest(root: string): boolean {
  let dir = root;
  for (;;) {
    if (existsSync(join(dir, "node_modules", "@playwright", "test", "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
