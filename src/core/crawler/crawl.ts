import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { isExcludedPath } from "../agents/guard";
import { readSessionHeaders } from "../auth/headers";
import { matchesLoggedOutPattern, type ResolvedEnvironment } from "../config/resolve";
import { explainLaunchError, type PlaywrightTestModule } from "../playwright/resolve";
import { DENIED_LINK_TEXT, normalizeUrl } from "./normalize";

export interface PageRecord {
  url: string;
  pattern: string;
  title: string;
  status: number;
  depth: number;
  /** page.locator("body").ariaSnapshot(), truncated. */
  ariaSnapshot: string;
  counts: { forms: number; inputs: number; buttons: number; links: number };
  buttons: string[];
  headings: string[];
  /** Patterns of the same-origin pages this page links to. */
  links: string[];
  /** Run-relative path of a small screenshot. */
  thumbnail?: string;
}

export type CrawlStopReason = "max-pages" | "complete" | "session-lost" | "bot-challenge" | "stopped";

export interface Sitemap {
  baseURL: string;
  role: string;
  startedAt: string;
  finishedAt: string;
  stoppedReason: CrawlStopReason;
  /** Details for session-lost / bot-challenge stops. */
  stopDetail?: string;
  pages: PageRecord[];
  /** [from pattern, to pattern] */
  edges: Array<[string, string]>;
}

export interface CrawlOptions {
  playwright: PlaywrightTestModule;
  env: ResolvedEnvironment;
  role: string;
  storageState?: string;
  maxPages: number;
  maxDepth: number;
  exclude: readonly string[];
  keepQueryParams: readonly string[];
  /** Folder for thumbnails (inside the run folder). */
  thumbnailDir: string;
  /** Run folder, to make thumbnail paths relative. */
  runDir: string;
  signal?: AbortSignal;
  headless?: boolean;
  onPage?: (page: PageRecord) => void;
  /** Concrete URLs visited per pattern (spec: at most 2). */
  maxPerPattern?: number;
}

export const ARIA_SNAPSHOT_LIMIT = 4_000;

/** Signs of a CAPTCHA or bot challenge; the crawler never tries to solve them. */
export async function detectBotChallenge(page: Page): Promise<string | undefined> {
  const title = (await page.title().catch(() => "")) ?? "";
  if (/just a moment|attention required|verify you are (a )?human|are you a robot|captcha|access denied|security check/i.test(title)) return `page title "${title}"`;
  const selector = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
    "#cf-challenge-running",
    "#challenge-form",
    "[data-sitekey]",
  ].join(", ");
  const found = await page.locator(selector).count().catch(() => 0);
  return found ? "a CAPTCHA widget on the page" : undefined;
}

interface Extracted {
  counts: PageRecord["counts"];
  buttons: string[];
  headings: string[];
  links: Array<{ href: string; text: string }>;
}

async function extract(page: Page): Promise<Extracted> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const name = (el: Element) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("value") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')].filter(visible).map(name).filter(Boolean);
    const headings = [...document.querySelectorAll("h1, h2, h3, [role=heading]")].filter(visible).map(name).filter(Boolean);
    const links = [...document.querySelectorAll('a[href], [role="link"][href]')].map((a) => ({ href: (a as HTMLAnchorElement).href || a.getAttribute("href") || "", text: name(a) }));
    return {
      counts: {
        forms: document.querySelectorAll("form").length,
        inputs: document.querySelectorAll("input:not([type=hidden]), textarea, select").length,
        buttons: buttons.length,
        links: links.length,
      },
      buttons: [...new Set(buttons)].slice(0, 25),
      headings: [...new Set(headings)].slice(0, 15),
      links,
    };
  });
}

/**
 * Deterministic breadth-first crawl (spec: Crawl mode, phase 1). Starts at baseURL with the role's
 * session, follows only same-origin links with GET navigations, never submits forms or clicks
 * buttons, skips excluded paths and deny-listed link text, and stops on session loss or a bot
 * challenge.
 */
export async function crawlSite(options: CrawlOptions): Promise<Sitemap> {
  const { env } = options;
  const origin = new URL(env.baseURL).origin;
  const maxPerPattern = options.maxPerPattern ?? 2;
  const startedAt = new Date().toISOString();
  const pages: PageRecord[] = [];
  const edges = new Set<string>();
  const perPattern = new Map<string, number>();
  const queued = new Set<string>();
  const queue: Array<{ url: string; depth: number; from?: string }> = [];
  let stoppedReason: CrawlStopReason = "complete";
  let stopDetail: string | undefined;

  const start = normalizeUrl(env.baseURL, env.baseURL, options.keepQueryParams);
  if (start) {
    queue.push({ url: start.url, depth: 0 });
    queued.add(start.url);
  }
  mkdirSync(options.thumbnailDir, { recursive: true });

  let browser;
  try {
    browser = await options.playwright.chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    throw explainLaunchError(error);
  }
  try {
    const context = await browser.newContext({
      baseURL: env.baseURL,
      storageState: options.storageState,
      extraHTTPHeaders: readSessionHeaders(options.storageState),
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    while (queue.length) {
      if (options.signal?.aborted) {
        stoppedReason = "stopped";
        break;
      }
      if (pages.length >= options.maxPages) {
        stoppedReason = "max-pages";
        break;
      }
      const item = queue.shift()!;
      const target = normalizeUrl(item.url, env.baseURL, options.keepQueryParams)!;
      if ((perPattern.get(target.pattern) ?? 0) >= maxPerPattern) continue;

      let status = 0;
      try {
        const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        status = response?.status() ?? 0;
        await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
      } catch {
        continue; // unreachable page: skip it, keep crawling
      }
      const landed = normalizeUrl(page.url(), env.baseURL, options.keepQueryParams);
      if (!landed || new URL(landed.url).origin !== origin) continue; // redirected off the app

      if (options.storageState && env.auth.validate && matchesLoggedOutPattern(page.url(), env.auth.validate.loggedOutPattern, env.baseURL)) {
        stoppedReason = "session-lost";
        stopDetail = `${target.url} redirected to ${page.url()}`;
        break;
      }
      const challenge = await detectBotChallenge(page);
      if (challenge) {
        stoppedReason = "bot-challenge";
        stopDetail = `${challenge} at ${page.url()}`;
        break;
      }
      const count = perPattern.get(landed.pattern) ?? 0;
      if (count >= maxPerPattern) continue;
      perPattern.set(landed.pattern, count + 1);

      const info = await extract(page).catch(() => ({ counts: { forms: 0, inputs: 0, buttons: 0, links: 0 }, buttons: [], headings: [], links: [] }) as Extracted);
      let aria = "";
      try {
        aria = await page.locator("body").ariaSnapshot({ timeout: 5_000 });
      } catch {
        aria = "";
      }
      const thumbFile = join(options.thumbnailDir, `${String(pages.length + 1).padStart(3, "0")}.jpg`);
      let thumbnail: string | undefined;
      try {
        await page.screenshot({ path: thumbFile, type: "jpeg", quality: 40, scale: "css" });
        thumbnail = thumbFile.slice(options.runDir.length + 1).replace(/\\/g, "/");
      } catch {
        thumbnail = undefined;
      }

      const linkPatterns = new Set<string>();
      for (const link of info.links) {
        const next = normalizeUrl(link.href, page.url(), options.keepQueryParams);
        if (!next || new URL(next.url).origin !== origin) continue;
        if (isExcludedPath(next.pathname, options.exclude) || DENIED_LINK_TEXT.test(link.text)) continue;
        linkPatterns.add(next.pattern);
        edges.add(`${landed.pattern}\u0000${next.pattern}`);
        if (item.depth + 1 > options.maxDepth || queued.has(next.url)) continue;
        if ((perPattern.get(next.pattern) ?? 0) >= maxPerPattern) continue;
        queued.add(next.url);
        queue.push({ url: next.url, depth: item.depth + 1, from: landed.pattern });
      }

      const record: PageRecord = {
        url: landed.url,
        pattern: landed.pattern,
        title: await page.title().catch(() => ""),
        status,
        depth: item.depth,
        ariaSnapshot: aria.length > ARIA_SNAPSHOT_LIMIT ? `${aria.slice(0, ARIA_SNAPSHOT_LIMIT)}\n... (truncated)` : aria,
        counts: info.counts,
        buttons: info.buttons,
        headings: info.headings,
        links: [...linkPatterns],
        thumbnail,
      };
      pages.push(record);
      options.onPage?.(record);
    }
    if (stoppedReason === "complete" && queue.length && pages.length >= options.maxPages) stoppedReason = "max-pages";
  } finally {
    await browser.close();
  }
  return {
    baseURL: env.baseURL,
    role: options.role,
    startedAt,
    finishedAt: new Date().toISOString(),
    stoppedReason,
    stopDetail,
    pages,
    edges: [...edges].map((e) => e.split("\u0000") as [string, string]),
  };
}
