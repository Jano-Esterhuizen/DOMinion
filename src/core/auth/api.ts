import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { importConsumerModule } from "../config/loader";
import { missingRoleEnvVars } from "../config/resolve";
import type { ApiRoleConfig } from "../config/schema";
import { DominionError, errorMessage } from "../errors";
import { relativePosix, writeFileAtomic } from "../fs";
import { redactText } from "../redact";
import { writeSessionHeaders } from "./headers";
import { loginEnvironment, type StrategyContext } from "./strategies";
import { generateTotp } from "./totp";
import type { ApiLoginContext } from "./types";

const apiCookieSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});

const apiLoginResultSchema = z
  .strictObject({
    cookies: z.array(apiCookieSchema).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    localStorage: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .optional();

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** Reads whichever credentials an `api` role names; every env var it names must be set. */
export function readApiCredentials(ctx: StrategyContext, role: ApiRoleConfig): ApiLoginContext["credentials"] {
  const missing = missingRoleEnvVars(ctx.loaded.config, ctx.env.name, ctx.roleName);
  if (missing.length > 0) {
    throw new DominionError(
      `Missing credentials for ${ctx.env.name}/${ctx.roleName}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
      {
        code: "CREDENTIALS_MISSING",
        hint: `Add ${missing.map((m) => `${m}=...`).join(" and ")} to ${relativePosix(process.cwd(), join(ctx.loaded.root, ".env.local"))} (gitignored) or export ${missing.length === 1 ? "it" : "them"} in your shell or CI secrets.`,
      },
    );
  }
  const totpSecret = role.totpEnv ? process.env[role.totpEnv]! : undefined;
  return {
    ...(role.userEnv ? { username: process.env[role.userEnv]! } : {}),
    ...(role.passEnv ? { password: process.env[role.passEnv]! } : {}),
    ...(role.tokenEnv ? { token: process.env[role.tokenEnv]! } : {}),
    ...(totpSecret ? { totp: () => generateTotp(totpSecret) } : {}),
  };
}

/** Where an `api` role's login module lives: the role's own apiLogin, else the environment's auth.apiLogin. */
export function apiLoginPath(ctx: Pick<StrategyContext, "loaded" | "env">, role: ApiRoleConfig): string | undefined {
  if (role.apiLogin) return isAbsolute(role.apiLogin) ? role.apiLogin : resolve(ctx.loaded.root, role.apiLogin);
  return ctx.env.auth.apiLogin;
}

function toStorageCookie(cookie: z.output<typeof apiCookieSchema>, baseURL: URL): StorageStateCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? baseURL.hostname,
    path: cookie.path ?? "/",
    expires: cookie.expires ?? -1,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? baseURL.protocol === "https:",
    sameSite: cookie.sameSite ?? "Lax",
  };
}

async function loadApiLogin(ctx: StrategyContext, role: ApiRoleConfig): Promise<{ fn: (arg: ApiLoginContext) => Promise<unknown>; label: string }> {
  const modulePath = apiLoginPath(ctx, role);
  if (!modulePath) {
    throw new DominionError(`${ctx.env.name}/${ctx.roleName} uses the api strategy, but no login module is configured.`, {
      code: "API_LOGIN_NOT_CONFIGURED",
      hint: `Set auth.apiLogin for the "${ctx.env.name}" environment (or apiLogin on the role) in dominion.config.ts, for example "./dominion/auth/api-login.ts", and default-export an async function that returns { cookies?, headers?, localStorage? }.`,
    });
  }
  const label = relativePosix(ctx.loaded.root, modulePath);
  if (!existsSync(modulePath)) {
    throw new DominionError(`API login module not found: ${label}`, {
      code: "API_LOGIN_MISSING",
      hint: "Create it, or fix auth.apiLogin in dominion.config.ts. The README's api strategy section has an example.",
    });
  }
  let fn: unknown;
  try {
    fn = await importConsumerModule(modulePath);
  } catch (error) {
    throw new DominionError(`Could not load ${label}: ${redactText(errorMessage(error))}`, {
      code: "API_LOGIN_INVALID",
      cause: error,
      hint: "Fix the error above in your API login module.",
    });
  }
  if (typeof fn !== "function") {
    throw new DominionError(`${label} must default-export an async function.`, {
      code: "API_LOGIN_INVALID",
      hint: "Use `export default async function login({ request, env, credentials }: ApiLoginContext): Promise<ApiLoginResult> { ... }`.",
    });
  }
  return { fn: fn as (arg: ApiLoginContext) => Promise<unknown>, label };
}

/**
 * `api` strategy: calls the consumer's login module (no browser) with env-var credentials and a
 * Playwright request context, then saves what it returns as the role's session. Cookies the
 * request context picked up (a Set-Cookie from a login endpoint) are kept too; returned cookies
 * win on clashes. Headers are saved beside the storage state (see headers.ts).
 */
export async function loginWithApi(ctx: StrategyContext, role: ApiRoleConfig): Promise<void> {
  const credentials = readApiCredentials(ctx, role);
  const { fn, label } = await loadApiLogin(ctx, role);
  const baseURL = new URL(ctx.env.baseURL);
  const request = await ctx.playwright.request.newContext({ baseURL: ctx.env.baseURL });
  try {
    let raw: unknown;
    try {
      raw = await fn({ env: loginEnvironment(ctx.env), role: ctx.roleName, credentials, request });
    } catch (error) {
      throw new DominionError(`The API login failed for ${ctx.env.name}/${ctx.roleName}: ${redactText(errorMessage(error))}`, {
        code: "LOGIN_FAILED",
        cause: error,
        hint: `Check the credentials in .env.local and the requests in ${label}.`,
      });
    }
    const parsed = apiLoginResultSchema.safeParse(raw ?? undefined);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.join(".") || "result"}: ${issue.message}` : "invalid result";
      throw new DominionError(`${label} returned something DOMinion cannot save (${where}).`, {
        code: "API_LOGIN_INVALID",
        hint: "Return { cookies?: [{ name, value, ... }], headers?: { Authorization: \"...\" }, localStorage?: { [origin]: { key: value } } }.",
      });
    }
    const result = parsed.data ?? {};

    const jar = (await request.storageState()).cookies as StorageStateCookie[];
    const returned = (result.cookies ?? []).map((c) => toStorageCookie(c, baseURL));
    const byKey = new Map<string, StorageStateCookie>();
    for (const cookie of [...jar, ...returned]) byKey.set(`${cookie.name}\u0000${cookie.domain.replace(/^\./, "")}\u0000${cookie.path}`, cookie);
    const cookies = [...byKey.values()];

    const origins = Object.entries(result.localStorage ?? {}).map(([origin, entries]) => {
      let resolved: string;
      try {
        resolved = new URL(origin, ctx.env.baseURL).origin;
      } catch {
        throw new DominionError(`${label} returned localStorage for "${origin}", which is not an origin.`, {
          code: "API_LOGIN_INVALID",
          hint: `Key localStorage by origin, for example { "${baseURL.origin}": { token: "..." } }.`,
        });
      }
      return { origin: resolved, localStorage: Object.entries(entries).map(([name, value]) => ({ name, value })) };
    });
    const headers = result.headers && Object.keys(result.headers).length ? result.headers : undefined;

    if (cookies.length === 0 && origins.length === 0 && !headers) {
      throw new DominionError(`${label} finished but produced no session: no cookies, headers or localStorage.`, {
        code: "API_LOGIN_EMPTY",
        hint: "Return the session from the module (cookies, headers or localStorage), or make the login request with the `request` argument so its Set-Cookie is captured.",
      });
    }

    writeFileAtomic(ctx.file, `${JSON.stringify({ cookies, origins }, null, 2)}\n`);
    if (process.platform !== "win32") {
      try {
        chmodSync(ctx.file, 0o600);
      } catch {
        // best effort: sessions are secrets, but a failed chmod should not fail the login
      }
    }
    writeSessionHeaders(ctx.file, headers);
  } finally {
    await request.dispose().catch(() => undefined);
  }
}
