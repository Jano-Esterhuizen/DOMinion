import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type Browser, chromium, expect as pwExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import { type DominionServer, startServer } from "../../src/server";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { discoveryScript, generatorScript, multiPlannerScript } from "../helpers/fixture-scripts";
import { scriptedRunner } from "../helpers/scripted-runner";
import { REPO_ROOT, removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let root: string;
let server: DominionServer;
let browser: Browser;
let page: Page;
let restoreEnv: () => void;
const SPEC = "tests/agent/cart/add-to-cart.spec.ts";

beforeAll(async () => {
  buildCli();
  const ui = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "src/ui/vite.config.ts"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (ui.status !== 0) throw new Error(`UI build failed:\n${ui.stdout}\n${ui.stderr}`);
  fixture = await startFixtureApp();
  restoreEnv = setEnv({ ...FIXTURE_ENV, ANTHROPIC_API_KEY: "sk-ant-fixture-not-a-real-key" });
  root = makeFixtureConsumer("ui", fixture.url, { files: { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG } });
  linkDominionPackage(root);
  const runner = scriptedRunner({
    planner: multiPlannerScript,
    discovery: (api) => discoveryScript(fixture.url)(api),
    generator: generatorScript(),
    healer: ({ edit }) => {
      if (fixture.flags.brokenCartBadge) {
        expect(
          edit(SPEC, '  test("add a product from the listing page"', '  // DOMinion: adding the backpack never updates the cart badge (app bug)\n  test.fixme("add a product from the listing page"'),
        ).toBeUndefined();
      } else if (fixture.flags.renameAddToCart) {
        expect(edit(SPEC, 'name: "Add to cart" }).click()', 'name: "Add to basket" }).click()')).toBeUndefined();
      }
    },
  });
  server = await startServer({ loaded: await loadConfig({ cwd: root }), port: 0, managerOptions: { runner: runner.runner, skipPreflight: true } });
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

describe("the local UI", () => {
  it("opens with the token link and refuses without it", async () => {
    const anonymous = await browser.newPage();
    const response = await anonymous.goto(server.url);
    expect(response?.status()).toBe(401);
    await anonymous.close();

    // Nobody has logged in yet, so the first visit lands on the Setup tab.
    await page.goto(server.openUrl);
    await pwExpect(page).toHaveURL(`${server.url}/setup`);
    await pwExpect(page.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
  });

  it("logs a role in from the Start screen, which finishes setup", async () => {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Minion runner" }).click();
    await pwExpect(page.getByRole("heading", { name: "New run" })).toBeVisible();
    await pwExpect(page.getByRole("status").filter({ hasText: "Finish setup first" })).toBeVisible();
    await pwExpect(page.getByRole("button", { name: "Start" })).toBeDisabled();
    await page.getByRole("button", { name: "Log in" }).click();
    await pwExpect(page.locator('[data-status="session-valid"]')).toBeVisible({ timeout: 60_000 });
    await pwExpect(page.getByRole("status").filter({ hasText: "Finish setup first" })).toHaveCount(0);
  });

  it("runs task mode entirely from the UI, surviving a reload mid-run", async () => {
    await page.getByLabel("What should DOMinion test?").fill("write tests for the add to cart workflow");
    await page.getByRole("button", { name: "Start" }).click();
    await pwExpect(page).toHaveURL(/\/runs\/\d{4}-\d{2}-\d{2}-[0-9a-f]+$/);
    const review = page.getByRole("region", { name: "Plan review: Add to cart" });
    await pwExpect(review).toBeVisible({ timeout: 60_000 });

    // Reloading mid-run rebuilds the same view from the server (no client state).
    await page.reload();
    await pwExpect(review).toBeVisible();
    await pwExpect(page.getByRole("list", { name: "Run log" })).toContainText("plan ready: specs/add-to-cart.md");

    await review.getByRole("button", { name: "Edit Markdown" }).click();
    const editor = review.getByLabel("Plan Markdown");
    await editor.fill((await editor.inputValue()).replace("## Overview", "## Overview\nApproved from the UI."));
    await review.getByRole("button", { name: "Approve and generate" }).click();

    const results = page.getByRole("region", { name: "Results" });
    await pwExpect(results.locator("tbody tr")).toHaveCount(2, { timeout: 120_000 });
    await pwExpect(results.locator('tbody [data-status="passed"]')).toHaveCount(2);
    await pwExpect(page.locator(".pill").first()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await pwExpect(results).toContainText("tests/agent/cart/add-to-cart.spec.ts");
    await pwExpect(results.getByLabel("Commit message")).toHaveValue(/^test\(dominion\): add add to cart tests/);
    const planDiff = results.locator("details").filter({ has: page.locator("summary").filter({ hasText: /specs\/add-to-cart\.md$/ }) });
    await pwExpect(planDiff).toContainText("+Approved from the UI.");
  });

  it("heals a broken locator from the UI", async () => {
    fixture.setFlags({ renameAddToCart: true });
    await page.goto(`${server.url}/`);
    await page.getByRole("button", { name: /Heal generated tests/ }).click();
    await pwExpect(page).toHaveURL(/\/runs\//);
    const results = page.getByRole("region", { name: "Results" });
    await pwExpect(results.locator('tbody [data-status="passed"]')).toHaveCount(2, { timeout: 120_000 });
    await pwExpect(results).toContainText("healed 1×");
    await pwExpect(page.getByRole("list", { name: "Run log" })).toContainText("heal fixed");
    fixture.resetFlags();
  });

  it("marks broken app behaviour as fixme with the reason, from the UI", async () => {
    fixture.setFlags({ brokenCartBadge: true, renameAddToCart: true });
    await page.goto(`${server.url}/`);
    await page.getByRole("button", { name: /Heal generated tests/ }).click();
    const results = page.getByRole("region", { name: "Results" });
    await pwExpect(results.locator('tbody [data-status="fixme"]')).toHaveCount(1, { timeout: 120_000 });
    await pwExpect(results).toContainText("fixme: adding the backpack never updates the cart badge (app bug)");
    fixture.resetFlags();
  });

  it("crawls from the UI and plans the flows selected on the Flows screen", async () => {
    await page.goto(`${server.url}/`);
    await page.getByText("Crawl", { exact: true }).click();
    await page.getByLabel("Stop after planning").check();
    await page.getByRole("button", { name: "Start" }).click();
    const flows = page.getByRole("region", { name: "Discovered flows" });
    await pwExpect(flows).toBeVisible({ timeout: 120_000 });
    // Coverage gap view: add to cart is already covered by the test generated earlier.
    const addToCart = flows.getByRole("listitem").filter({ hasText: "Add to cart" });
    await pwExpect(addToCart).toContainText("covered");
    await pwExpect(addToCart.getByRole("checkbox")).not.toBeChecked();
    await pwExpect(flows.getByRole("listitem").filter({ hasText: "Log in" }).getByRole("checkbox")).toBeChecked();
    await flows.getByRole("listitem").filter({ hasText: "Checkout" }).getByRole("checkbox").uncheck();
    await flows.getByRole("button", { name: "Plan selected (1)" }).click();
    await pwExpect(page.locator(".pill").first()).toHaveAttribute("data-status", "done", { timeout: 120_000 });
    await pwExpect(page.getByRole("list", { name: "Run log" })).toContainText("plan ready: specs/login.md");
  });

  it("shows settings without secret values", async () => {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Setup/ }).click();
    await pwExpect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).toContain("FX_PASS");
    for (const value of Object.values(FIXTURE_ENV)) expect(text).not.toContain(value);
  });
});
