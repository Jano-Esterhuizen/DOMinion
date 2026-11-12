import { randomBytes, timingSafeEqual } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isInside, relativePosix } from "../core/fs";

export const TOKEN_COOKIE = "dominion_token";
export const TOKEN_HEADER = "x-dominion-token";

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokensEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** The token a request presents: header, bearer, or cookie (never the query string, except on page load). */
export function requestToken(request: FastifyRequest): string | undefined {
  const header = request.headers[TOKEN_HEADER];
  if (typeof header === "string") return header;
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return cookieValue(request.headers.cookie, TOKEN_COOKIE);
}

/** Only 127.0.0.1/localhost on our port: blocks DNS-rebinding attacks from other sites. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Same-origin check for state-changing requests (CSRF), when the browser sends an Origin. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function sendError(reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, ...extra });
}

const BLOCKED_SEGMENTS = new Set([".auth", ".git", "node_modules"]);
const SERVABLE = /\.(png|jpe?g|webp|gif|zip|md|json|ts|js|txt|diff|webm|html|yml|yaml|log)$/i;

/**
 * Resolves a requested file and refuses anything outside the repo or holding secrets (spec: the
 * server never serves files outside the consumer repo).
 */
export function servableFile(root: string, requested: string): string | undefined {
  if (!requested || requested.includes("\0")) return undefined;
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!isInside(root, abs)) return undefined;
  const parts = relativePosix(root, abs).toLowerCase().split("/");
  if (parts.some((p) => BLOCKED_SEGMENTS.has(p))) return undefined;
  const name = basename(abs).toLowerCase();
  if (name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key")) return undefined;
  if (parts[0] === ".dominion" && parts[1] === "auth") return undefined;
  if (!SERVABLE.test(name)) return undefined;
  return abs;
}
