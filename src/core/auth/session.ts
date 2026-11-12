import { existsSync, readFileSync, statSync } from "node:fs";
import type { ResolvedEnvironment } from "../config/resolve";
import { matchesLoggedOutPattern } from "../config/resolve";
import { DominionError } from "../errors";
import { explainLaunchError, type PlaywrightTestModule } from "../playwright/resolve";
import { redactText } from "../redact";
import { readSessionHeaders } from "./headers";

/**
 * valid: validate.url stayed off loggedOutPattern. expired: it landed on loggedOutPattern (or every
 * cookie has expired). missing: no session file. unverified: a session exists but the environment
 * has no auth.validate, so it cannot be checked.
 */
export type SessionState = "valid" | "expired" | "missing" | "unverified";

export interface SessionCheck {
  state: SessionState;
  /** URL the browser landed on (redacted), when validation ran. */
  landedUrl?: string;
  detail?: string;
  /** When the session file was last written. */
  savedAt?: Date;
}

interface StorageStateFile {
  cookies?: Array<{ expires?: number }>;
  origins?: unknown[];
}

/** Cheap pre-check: an unreadable file, or one whose cookies have all expired, cannot be valid. */
export function inspectStorageState(file: string, nowSeconds = Date.now() / 1000): { ok: boolean; detail?: string } {
  let parsed: StorageStateFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as StorageStateFile;
  } catch {
    return { ok: false, detail: "the session file is not valid JSON" };
  }
  const cookies = parsed.cookies ?? [];
  const persistent = cookies.filter((c) => typeof c.expires === "number" && c.expires > 0);
  if (cookies.length > 0 && persistent.length === cookies.length && persistent.every((c) => c.expires! < nowSeconds)) {
    return { ok: false, detail: "every cookie in the session has expired" };
  }
  return { ok: true };
}

export interface ValidateSessionOptions {
  playwright: PlaywrightTestModule;
  env: ResolvedEnvironment;
  file: string;
  headless?: boolean;
  timeoutMs?: number;
}

/**
 * Opens auth.validate.url with the saved session and fails validation if the browser lands on a
 * URL matching loggedOutPattern (spec: Session lifecycle, step 2).
 */
export async function validateSession(options: ValidateSessionOptions): Promise<SessionCheck> {
  const { env, file } = options;
  if (!existsSync(file)) return { state: "missing" };
  const savedAt = statSync(file).mtime;
  const pre = inspectStorageState(file);
  if (!pre.ok) return { state: "expired", detail: pre.detail, savedAt };
  const validate = env.auth.validate;
  if (!validate) {
    return {
      state: "unverified",
      savedAt,
      detail: `environment "${env.name}" has no auth.validate, so the session cannot be checked`,
    };
  }

  let browser;
  try {
    browser = await options.playwright.chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    throw explainLaunchError(error);
  }
  try {
    const context = await browser.newContext({ storageState: file, baseURL: env.baseURL, extraHTTPHeaders: readSessionHeaders(file) });
    const page = await context.newPage();
    const timeout = options.timeoutMs ?? 30_000;
    try {
      await page.goto(validate.url, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      const firstLine = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
      throw new DominionError(`Could not open ${redactText(validate.url)} to check the session: ${redactText(firstLine)}`, {
        code: "ENV_UNREACHABLE",
        cause: error,
        hint: `Check that ${env.baseURL} is up and reachable from this machine.`,
      });
    }
    // Client-side apps often redirect after the first paint; give them a moment to settle.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const landed = page.url();
    const expired = matchesLoggedOutPattern(landed, validate.loggedOutPattern, env.baseURL);
    return { state: expired ? "expired" : "valid", landedUrl: redactText(landed), savedAt };
  } finally {
    await browser.close();
  }
}
