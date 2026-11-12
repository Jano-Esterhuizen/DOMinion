import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

/** Credentials handed to the consumer's login script. Values come only from environment variables. */
export interface LoginCredentials {
  username: string;
  password: string;
  /** Present only for roles with `totpEnv`. Returns a fresh one-time code on each call. */
  totp?: () => string;
}

/** The environment as seen by a login script. `baseURL` never has a trailing slash. */
export interface LoginEnvironment {
  name: string;
  baseURL: string;
  auth: {
    loginUrl: string;
  };
}

/** Argument of the default export of dominion/auth/login.ts (the `form` strategy). */
export interface LoginContext {
  page: Page;
  context: BrowserContext;
  env: LoginEnvironment;
  role: string;
  credentials: LoginCredentials;
}

/** A cookie returned by an `api` login module. */
export interface ApiLoginCookie {
  name: string;
  value: string;
  /** Defaults to the baseURL host. */
  domain?: string;
  path?: string;
  /** Unix time in seconds; -1 or omitted for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Argument of the default export of an `api` login module. */
export interface ApiLoginContext {
  env: LoginEnvironment;
  role: string;
  /** Whatever the role's userEnv/passEnv/totpEnv/tokenEnv resolve to. */
  credentials: Partial<LoginCredentials> & { token?: string };
  /** Playwright API request context with baseURL set to the environment. */
  request: APIRequestContext;
}

/** What an `api` login module returns; written into the role's storage state. */
export interface ApiLoginResult {
  cookies?: ApiLoginCookie[];
  /** Extra HTTP headers (for example Authorization) sent by agents and generated tests. */
  headers?: Record<string, string>;
  /** localStorage entries per origin. */
  localStorage?: Record<string, Record<string, string>>;
}
