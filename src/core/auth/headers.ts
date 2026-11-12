import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../fs";
import type { Redactor } from "../redact";

/**
 * Extra HTTP headers saved by an `api` login (for example `Authorization: Bearer ...`). A Playwright
 * storage state only holds cookies and localStorage, so headers live next to it in
 * `.auth/<env>-<role>.headers.json` and are applied wherever that storage state is used: session
 * validation, the crawler, the agents' browser and the role's Playwright project.
 */
export function sessionHeadersFile(storageState: string): string {
  return storageState.replace(/(\.json)?$/i, ".headers.json");
}

/** The headers saved with a session, or undefined when there are none (or the file is unreadable). */
export function readSessionHeaders(storageState: string | undefined): Record<string, string> | undefined {
  if (!storageState) return undefined;
  const file = sessionHeadersFile(storageState);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { headers?: unknown };
    const headers = parsed.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
    const entries = Object.entries(headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
    return entries.length ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

/** Saves (or, with no headers, removes) the headers that belong to a session. */
export function writeSessionHeaders(storageState: string, headers: Record<string, string> | undefined): void {
  const file = sessionHeadersFile(storageState);
  if (!headers || Object.keys(headers).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ headers }, null, 2)}\n`);
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort, like the storage state itself
    }
  }
}

/**
 * Registers a session's header values (bearer tokens and the like) as secrets, so they are
 * redacted from logs, events and agent transcripts like any credential from an env var.
 */
export function addSessionSecrets(redactor: Redactor, storageState: string | undefined): void {
  const headers = readSessionHeaders(storageState);
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    redactor.add(`session header ${name}`, value);
    // "Bearer abc" -> also redact the bare token, which is what usually leaks.
    const token = /^\s*\w+\s+(\S{8,})\s*$/.exec(value)?.[1];
    if (token) redactor.add(`session header ${name} token`, token);
  }
}
