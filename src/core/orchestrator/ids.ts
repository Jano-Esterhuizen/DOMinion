import { randomBytes } from "node:crypto";

/** Run IDs look like 2026-11-11-a1b2: sortable by day, short enough to type. */
export function newRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${day}-${randomBytes(2).toString("hex")}`;
}

export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{4,}$/;

/** Kebab-case slug for flow ids, file names and tags. */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = slug.length > maxLength ? slug.slice(0, maxLength).replace(/-[^-]*$/, "") : slug;
  return trimmed || "flow";
}

const LEADING_REQUEST =
  /^(?:please\s+)?(?:(?:write|generate|create|add|make)\s+)?(?:(?:an?|the|some)\s+)?(?:(?:e2e|end-to-end|playwright|automated)\s+)?(?:tests?|specs?)\s+(?:for|of|covering|that\s+covers?|around)\s+/;
const ARTICLES = new Set(["a", "an", "the"]);
const TRAILING = new Set(["workflow", "flow", "journey", "feature", "scenario", "scenarios", "tests", "test"]);

/**
 * Derives a flow slug from a task request:
 * "write tests for the add to cart workflow" -> "add-to-cart", "add a product to the cart" -> "add-product-to-cart".
 */
export function flowSlugFromRequest(request: string): string {
  const stripped = request
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_REQUEST, "")
    .replace(/^test\s+/, "");
  const words = stripped.split(" ").filter((w) => w && !ARTICLES.has(w));
  while (words.length > 1 && TRAILING.has(words[words.length - 1]!)) words.pop();
  return slugify(words.slice(0, 8).join(" "));
}
