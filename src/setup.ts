/**
 * `@yourorg/dominion/setup`: used by the generated dominion.setup.ts so that Playwright's setup
 * projects refresh sessions with exactly the same logic as `npx dominion auth`.
 */
import { resolve } from "node:path";
import { ensureSession } from "./core/auth";
import { readSessionHeaders } from "./core/auth/headers";
import { loadConfig } from "./core/config/loader";
import { DominionError } from "./core/errors";
import { nonInteractivePrompter } from "./core/prompter";
import { redactorFor, setActiveRedactor } from "./core/redact";

export interface SetupSessionMetadata {
  env: string;
  role: string;
}

/**
 * Headers saved with an `api` role's session (for example Authorization), for the role's project in
 * playwright.config.ts: `use: { storageState, extraHTTPHeaders: sessionHeaders(storageState) }`.
 * The path resolves like `storageState` (against the working directory). Playwright worker
 * processes load the config after setup projects finish, so tests see the refreshed headers.
 * Returns undefined when the session has no headers.
 */
export function sessionHeaders(storageState: string): Record<string, string> | undefined {
  return readSessionHeaders(resolve(storageState));
}

/** Makes sure .auth/<env>-<role>.json holds a valid session, logging in again for form and api roles. */
export async function setupSession(metadata: SetupSessionMetadata): Promise<void> {
  if (!metadata?.env || !metadata?.role) {
    throw new DominionError("dominion.setup.ts ran without env/role project metadata.", {
      code: "SETUP_METADATA_MISSING",
      hint: "Run it through a dominion-setup-<env>-<role> project from the managed block in playwright.config.ts.",
    });
  }
  const loaded = await loadConfig();
  setActiveRedactor(redactorFor(loaded));
  await ensureSession({ loaded, envName: metadata.env, roleName: metadata.role, prompter: nonInteractivePrompter() });
}
