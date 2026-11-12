import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LoadedConfig } from "../config/loader";
import { projectPaths, type ResolvedEnvironment } from "../config/resolve";
import type { ExistingRoleConfig } from "../config/schema";
import { DominionError } from "../errors";
import { relativePosix } from "../fs";
import { findPlaywrightConfigs } from "../init/detect";
import { runPlaywrightTests } from "../playwright/runner";
import { loadPlaywright } from "../playwright/resolve";
import { inspectStorageState, type SessionCheck, validateSession } from "./session";

/** The project's own Playwright config and the storage state file its setup writes. */
export function existingSessionFile(loaded: LoadedConfig, role: ExistingRoleConfig): { configPath: string; file: string } {
  const profile = loaded.config.project;
  const storage = role.storageState ?? profile?.auth?.storageState;
  const configRel = profile?.playwrightConfig ?? findPlaywrightConfigs(loaded.root)[0];
  if (!storage || !configRel) {
    throw new DominionError("This role uses the existing auth strategy, but no storage state file is configured.", {
      code: "EXISTING_AUTH_UNCONFIGURED",
      hint: "Run `npx dominion init` to detect your setup project, or set project.auth.storageState (and setupProject) in dominion.config.ts.",
    });
  }
  const configPath = resolve(loaded.root, configRel);
  return { configPath, file: resolve(dirname(configPath), storage) };
}

async function check(loaded: LoadedConfig, env: ResolvedEnvironment, file: string): Promise<SessionCheck> {
  if (!existsSync(file)) return { state: "missing" };
  if (!env.auth.validate) {
    const pre = inspectStorageState(file);
    return pre.ok ? { state: "unverified", detail: "auth.validate is not configured" } : { state: "expired", detail: pre.detail };
  }
  const { module: playwright } = await loadPlaywright(loaded.root);
  return validateSession({ playwright, env, file });
}

/**
 * `existing` strategy (spec: Existing projects, Auth reuse): reuse the project's setup project or
 * globalSetup and its storage state. DOMinion runs that setup when the session is missing or
 * expired and never creates a second login mechanism.
 */
export async function ensureExistingSession(options: {
  loaded: LoadedConfig;
  env: ResolvedEnvironment;
  roleName: string;
  role: ExistingRoleConfig;
  force?: boolean;
}): Promise<{ action: "reused" | "logged-in"; file: string; check: SessionCheck }> {
  const { loaded, env, role } = options;
  const { configPath, file } = existingSessionFile(loaded, role);
  const fileLabel = relativePosix(loaded.root, file);
  if (!options.force) {
    const current = await check(loaded, env, file);
    if (current.state === "valid" || current.state === "unverified") return { action: "reused", file, check: current };
  }
  const profile = loaded.config.project;
  const setupProject = role.setupProject ?? profile?.auth?.setupProject;
  if (!setupProject) {
    throw new DominionError(`The session in ${fileLabel} is missing or expired, and it is created by your globalSetup.`, {
      code: "EXISTING_AUTH_GLOBAL_SETUP",
      hint: "Run your normal test command once (for example `npx playwright test`) to recreate it, then try again.",
    });
  }
  const result = await runPlaywrightTests({
    root: loaded.root,
    configPath,
    files: [],
    projects: [setupProject],
    reportPath: join(projectPaths(loaded).dominionDir, "auth", `${env.name}-${options.roleName}-setup.json`),
  });
  const failed = result.tests.find((t) => t.status === "failed" || t.status === "timedOut");
  if (result.exitCode !== 0 || failed) {
    throw new DominionError(`Your setup project "${setupProject}" failed${failed?.error ? `: ${failed.error.split("\n")[0]}` : ""}.`, {
      code: "EXISTING_AUTH_SETUP_FAILED",
      hint: `Run \`npx playwright test --project=${setupProject}\` to see why. DOMinion reuses your setup and never logs in on its own.`,
    });
  }
  if (!existsSync(file)) {
    throw new DominionError(`Your setup project "${setupProject}" ran but did not write ${fileLabel}.`, {
      code: "EXISTING_AUTH_NO_STATE",
      hint: "Check project.auth.storageState in dominion.config.ts against the path your setup saves to.",
    });
  }
  const after = await check(loaded, env, file);
  if (after.state === "expired") {
    throw new DominionError(`Your setup project "${setupProject}" ran, but the session in ${fileLabel} is still not valid.`, {
      code: "SESSION_NOT_VALID_AFTER_LOGIN",
      hint: "Check auth.validate in dominion.config.ts (validate.url must need a login; loggedOutPattern must match the login page).",
    });
  }
  return { action: "logged-in", file, check: after };
}
