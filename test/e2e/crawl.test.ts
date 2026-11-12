import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureSession } from "../../src/core/auth";
import { loadConfig } from "../../src/core/config/loader";
import { getEnvironment } from "../../src/core/config/resolve";
import { crawlSite, type Sitemap } from "../../src/core/crawler/crawl";
import { runCrawl } from "../../src/core/orchestrator/crawl";
import { autoApproveInteraction } from "../../src/core/orchestrator/pipeline";
import { loadPlaywright } from "../../src/core/playwright/resolve";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { discoveryScript, multiGeneratorScript, multiPlannerScript } from "../helpers/fixture-scripts";
import { scriptedRunner } from "../helpers/scripted-runner";
import { removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let restoreEnv: () => void;
const roots: string[] = [];

beforeAll(async () => {
  buildCli();
  fixture = await startFixtureApp();
  restoreEnv = setEnv({ ...FIXTURE_ENV });
});

afterAll(async () => {
  restoreEnv?.();
  await fixture?.close();
  for (const root of roots) removeDir(root);
});

beforeEach(() => {
  fixture.resetFlags();
  fixture.requestLog.length = 0;
});

function consumer(crawl = 'crawl: { exclude: ["/logout"], keepQueryParams: ["category"] },'): string {
  const root = makeFixtureConsumer("crawl", fixture.url, { files: { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG } });
  const path = join(root, "dominion.config.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace("environments: {", `${crawl}\n  environments: {`));
  linkDominionPackage(root);
  roots.push(root);
  return root;
}

async function crawlAs(root: string, overrides: { maxPages?: number } = {}): Promise<Sitemap> {
  const loaded = await loadConfig({ cwd: root });
  const session = await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
  const { module: playwright } = await loadPlaywright(root);
  fixture.requestLog.length = 0; // only the crawl itself, not the login above
  return crawlSite({
    playwright,
    env: getEnvironment(loaded, "staging"),
    role: "customer",
    storageState: session.file,
    maxPages: overrides.maxPages ?? loaded.config.crawl.maxPages,
    maxDepth: loaded.config.crawl.maxDepth,
    exclude: loaded.config.crawl.exclude,
    keepQueryParams: loaded.config.crawl.keepQueryParams,
    thumbnailDir: join(root, ".dominion", "crawl-test"),
    runDir: join(root, ".dominion"),
  });
}

describe("deterministic crawler (real browser, fixture app)", () => {
  it("crawls same-origin pages breadth-first with GET only, deduplicating by pattern", async () => {
    const root = consumer();
    fixture.requestLog.length = 0;
    const sitemap = await crawlAs(root);
    expect(sitemap.stoppedReason).toBe("complete");
    const patterns = sitemap.pages.map((p) => p.pattern.replace(fixture.url, ""));
    expect(patterns).toEqual(expect.arrayContaining(["/", "/products", "/products?category=gear", "/products?category=clothing", "/products/:id", "/cart", "/account", "/account/orders"]));
    expect(sitemap.pages.filter((p) => p.pattern.endsWith("/products/:id")).length).toBeLessThanOrEqual(2);
    expect(patterns).not.toContain("/logout");
    // Never submits forms or clicks buttons: the crawl itself only sends GET requests.
    expect(fixture.requestLog.filter((r) => !r.startsWith("GET "))).toEqual([]);
    expect(fixture.requestLog.some((r) => r.startsWith("GET /logout"))).toBe(false);
    const products = sitemap.pages.find((p) => p.pattern.endsWith("/products"))!;
    expect(products).toMatchObject({ status: 200, title: "Products - Fixture Shop" });
    expect(products.headings).toContain("Products");
    expect(products.buttons).toContain("Add to cart");
    expect(products.counts.buttons).toBeGreaterThanOrEqual(5);
    expect(products.ariaSnapshot).toContain('heading "Products"');
    expect(products.thumbnail).toMatch(/\.jpg$/);
    expect(sitemap.edges.length).toBeGreaterThan(5);
    // The session is still valid afterwards: nothing logged the role out.
    const loaded = await loadConfig({ cwd: root });
    expect((await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() })).action).toBe("reused");
  });

  it("respects maxPages", async () => {
    const sitemap = await crawlAs(consumer(), { maxPages: 3 });
    expect(sitemap.pages).toHaveLength(3);
    expect(sitemap.stoppedReason).toBe("max-pages");
  });

  it("stops and reports a CAPTCHA or bot challenge", async () => {
    const root = consumer();
    fixture.setFlags({ captchaOnProducts: true });
    const sitemap = await crawlAs(root);
    expect(sitemap.stoppedReason).toBe("bot-challenge");
    expect(sitemap.stopDetail).toMatch(/Just a moment|CAPTCHA/);
  });

  it("stops and reports when the session is lost", async () => {
    const root = consumer();
    const loaded = await loadConfig({ cwd: root });
    await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
    fixture.expireSessions();
    const { module: playwright } = await loadPlaywright(root);
    const sitemap = await crawlSite({
      playwright,
      env: getEnvironment(loaded, "staging"),
      role: "customer",
      storageState: join(root, ".auth", "staging-customer.json"),
      maxPages: 50,
      maxDepth: 4,
      exclude: ["/logout"],
      keepQueryParams: [],
      thumbnailDir: join(root, ".dominion", "t"),
      runDir: join(root, ".dominion"),
    });
    expect(sitemap.stoppedReason).toBe("session-lost");
  });
});

describe("crawl mode end to end (scripted agents)", () => {
  it("discovers flows, plans the selected ones two at a time, and generates passing tests", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ discovery: discoveryScript(fixture.url, { invalidFirst: true }), planner: multiPlannerScript, generator: multiGeneratorScript });
    const run = await runCrawl(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", flowIds: ["add-to-cart", "search"], autoApprove: true },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status, run.error?.message).toBe("done");
    expect(scripted.calls.filter((c) => c.agent === "discovery")).toHaveLength(2); // retried once on a schema failure
    expect(run.discoveredFlows?.map((f) => f.id)).toEqual(["add-to-cart", "checkout", "login", "search"]);
    expect(run.crawl?.pages).toBeGreaterThan(5);
    expect(existsSync(join(root, ".dominion", "runs", run.id, "sitemap.json"))).toBe(true);
    const flows = Object.fromEntries(run.flows.map((f) => [f.id, f]));
    expect(Object.keys(flows).sort()).toEqual(["add-to-cart", "search"]);
    expect(flows["add-to-cart"]!.specFiles).toEqual(["tests/agent/cart/add-to-cart.spec.ts"]);
    expect(flows.search!.specFiles).toEqual(["tests/agent/search/search.spec.ts"]);
    for (const flow of run.flows) {
      expect(flow.status).toBe("done");
      expect(flow.results?.every((r) => r.status === "passed"), flow.id).toBe(true);
    }
    // Each flow's request is machine-written from discovery: crawl mode is task mode.
    expect(scripted.calls.find((c) => c.agent === "planner" && c.flowId === "search")!.prompt).toContain("Search products: Search the catalog by product name.");
  });

  it("with --auto-approve --plan-only, plans every critical flow and generates nothing", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ discovery: discoveryScript(fixture.url), planner: multiPlannerScript });
    const run = await runCrawl(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", autoApprove: true, planOnly: true },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("done");
    expect(run.flows.map((f) => f.id).sort()).toEqual(["add-to-cart", "checkout", "login"]);
    expect(scripted.calls.filter((c) => c.agent === "generator")).toHaveLength(0);
    for (const id of ["add-to-cart", "checkout", "login"]) expect(existsSync(join(root, "specs", `${id}.md`)), id).toBe(true);
  });

  it("asks a person to choose flows when not auto-approving", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ discovery: discoveryScript(fixture.url), planner: multiPlannerScript });
    let offered: string[] = [];
    const run = await runCrawl(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", planOnly: true },
      {
        runner: scripted.runner,
        interaction: {
          approvePlan: async () => ({ action: "approve" }),
          selectFlows: async ({ flows }) => {
            offered = flows.map((f) => `${f.id}:${f.coverage?.status}`);
            return ["login"];
          },
        },
        prompter: nonInteractivePrompter(),
        skipPreflight: true,
      },
    );
    expect(offered).toEqual(["add-to-cart:none", "checkout:none", "login:none", "search:none"]);
    expect(run.flows.map((f) => f.id)).toEqual(["login"]);
  });

  it("fails clearly when the crawl hits a bot challenge in CI", async () => {
    const root = consumer();
    fixture.setFlags({ captchaOnProducts: true });
    const scripted = scriptedRunner({ discovery: discoveryScript(fixture.url) });
    const run = await runCrawl(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", autoApprove: true },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("CRAWL_BOT_CHALLENGE");
    expect(run.error?.hint).toMatch(/never solves CAPTCHAs/);
    expect(scripted.calls).toHaveLength(0);
  });
});
