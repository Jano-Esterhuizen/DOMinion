import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import type { DominionEvent } from "../../src/core/events";
import { autoApproveInteraction, runHeal, runTask } from "../../src/core/orchestrator/pipeline";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { ADD_TO_CART_SPEC, generatorScript, plannerScript } from "../helpers/fixture-scripts";
import { type AgentScript, scriptedRunner } from "../helpers/scripted-runner";
import { removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let root: string;
let restoreEnv: () => void;
const SPEC = "tests/agent/cart/add-to-cart.spec.ts";
const spec = () => readFileSync(join(root, SPEC), "utf8");

beforeAll(async () => {
  buildCli();
  fixture = await startFixtureApp();
  restoreEnv = setEnv({ ...FIXTURE_ENV });
  root = makeFixtureConsumer("heal", fixture.url, { files: { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG } });
  linkDominionPackage(root);
  const scripted = scriptedRunner({ planner: plannerScript, generator: generatorScript() });
  const run = await runTask(
    { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart", autoApprove: true },
    { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
  );
  if (run.status !== "done") throw new Error(`setup run failed: ${run.error?.message}`);
});

afterAll(async () => {
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

beforeEach(() => fixture.resetFlags());

async function heal(healer: AgentScript, maxAttempts?: number) {
  const events: DominionEvent[] = [];
  const scripted = scriptedRunner({ healer });
  const run = await runHeal(
    { loaded: await loadConfig({ cwd: root }), envName: "staging", maxAttempts },
    { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true, onEvent: (e) => events.push(e) },
  );
  return { run, events, calls: scripted.calls };
}

const results = (run: Awaited<ReturnType<typeof runHeal>>) => run.flows.flatMap((f) => f.results ?? []).map((r) => [r.title.split(" > ").pop(), r.status]);

describe("healing (scripted healer, real Playwright and fixture app)", () => {
  it("heals a deliberately broken locator", async () => {
    fixture.setFlags({ renameAddToCart: true });
    const { run, events, calls } = await heal(({ request, edit }) => {
      expect(request.prompt).toContain("add a product from the listing page");
      expect(request.prompt).toMatch(/Page snapshot and context captured when the test failed/);
      expect(edit(SPEC, 'name: "Add to cart" }).click()', 'name: "Add to basket" }).click()')).toBeUndefined();
    });
    expect(run.status).toBe("done");
    expect(calls.map((c) => c.agent)).toEqual(["healer"]);
    expect(results(run)).toEqual([
      ["add a product from the listing page", "passed"],
      ["empty cart message", "passed"],
    ]);
    expect(events.find((e) => e.type === "heal.result")).toMatchObject({ outcome: "fixed", title: expect.stringContaining("add a product") });
    expect(spec()).toContain('name: "Add to basket" }).click()');
    expect(run.flows[0]!.results!.find((r) => r.title.includes("add a product"))!.healAttempts).toBe(1);
  });

  it("marks deliberately broken app behaviour as fixme with the healer's reason", async () => {
    fixture.setFlags({ brokenCartBadge: true });
    const { run, events } = await heal(({ edit }) => {
      // Weakening the test is refused...
      expect(edit(SPEC, "      await expect(badge).toHaveText(String(before + 1));\n", "")).toMatch(/removes assertions/);
      // ...so the healer reports the app bug instead.
      expect(
        edit(SPEC, '  test("add a product from the listing page"', '  // DOMinion: clicking "Add to basket" does not add the product; the cart badge stays the same\n  test.fixme("add a product from the listing page"'),
      ).toBeUndefined();
    });
    expect(run.status).toBe("done");
    expect(results(run)).toEqual([
      ["add a product from the listing page", "fixme"],
      ["empty cart message", "passed"],
    ]);
    const fixmeResult = events.find((e) => e.type === "heal.result" && e.outcome === "fixme");
    expect(fixmeResult).toMatchObject({ reason: 'clicking "Add to basket" does not add the product; the cart badge stays the same' });
    expect(run.flows[0]!.results![0]!.fixmeReason).toContain("cart badge stays the same");
  });

  it("marks a test fixme itself after maxHealAttempts and reports why", async () => {
    // Restore a passing spec, then break the app in a way the healer cannot fix.
    const { writeFileSync } = await import("node:fs");
    const runId = /\(run ([\w-]+)\)/.exec(spec())![1]!;
    writeFileSync(join(root, SPEC), ADD_TO_CART_SPEC(runId, "Add to cart"));
    fixture.setFlags({ brokenCartBadge: true });
    const { run, events, calls } = await heal(() => ({ text: "I could not find a fix." }), 2);
    expect(calls.filter((c) => c.agent === "healer")).toHaveLength(2);
    expect(events.filter((e) => e.type === "heal.attempt").map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(results(run)).toEqual([
      ["add a product from the listing page", "fixme"],
      ["empty cart message", "passed"],
    ]);
    expect(spec()).toMatch(/\/\/ DOMinion: still failing after 2 heal attempts: .*\n\s+test\.fixme\("add a product from the listing page"/);
    expect(run.flows[0]!.results![0]!.fixmeReason).toMatch(/^still failing after 2 heal attempts/);
  });
});
