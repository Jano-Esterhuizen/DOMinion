/**
 * URL normalization for the crawler (spec: Crawl mode, phase 1, step 5): drop the hash, drop query
 * params not in keepQueryParams, and replace numeric IDs, UUIDs and long slugs in path segments
 * with ":id" before deduplicating.
 */
export interface NormalizedUrl {
  /** The concrete URL to visit (hash removed, only kept query params, sorted). */
  url: string;
  /** The pattern pages are deduplicated by, e.g. https://shop.example.com/products/:id */
  pattern: string;
  pathname: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;

/** Whether a path segment is an identifier rather than a route name. */
export function isIdSegment(segment: string): boolean {
  const s = decodeURIComponentSafe(segment);
  if (/^\d+$/.test(s)) return true;
  if (UUID_RE.test(s)) return true;
  if (HEX_ID_RE.test(s)) return true;
  // Mixed letters and digits that look generated (a1b2c3d4, SKU-12345-XL).
  if (s.length >= 8 && /\d/.test(s) && /[a-z]/i.test(s) && !/^v\d+$/i.test(s) && (s.match(/\d/g)?.length ?? 0) >= 3) return true;
  // Long slugs: many words joined by hyphens, typical for product or article titles.
  if (s.length >= 25 && (s.match(/-/g)?.length ?? 0) >= 3) return true;
  return false;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeUrl(raw: string, base: string, keepQueryParams: readonly string[] = []): NormalizedUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  url.username = "";
  url.password = "";
  const kept = new URLSearchParams();
  const keep = new Set(keepQueryParams);
  [...url.searchParams.entries()]
    .filter(([key]) => keep.has(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .forEach(([key, value]) => kept.append(key, value));
  url.search = kept.toString() ? `?${kept.toString()}` : "";
  const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  url.pathname = pathname;
  const patternPath = pathname
    .split("/")
    .map((segment) => (segment && isIdSegment(segment) ? ":id" : segment))
    .join("/");
  return { url: url.href, pattern: `${url.origin}${patternPath}${url.search}`, pathname };
}

/** Deny-listed link text the crawler never follows (log out, sign out, delete, remove account, unsubscribe). */
export const DENIED_LINK_TEXT = /\b(log\s*-?\s*out|sign\s*-?\s*out|delete|remove\s+(my\s+)?account|close\s+(my\s+)?account|unsubscribe|deactivate)\b/i;
