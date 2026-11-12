import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import type { DominionEvent } from "../../src/core/events";
import { autoApproveInteraction, type PlanDecision, type RunInteraction, runGenerate, runTask } from "../../src/core/orchestrator/pipeline";
import { MANAGED_START } from "../../src/core/playwright/patch";
import { readPlan } from "../../src/core/plans";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, FIXTURE_SECRET_VALUES, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { generatorScript, plannerScript } from "../helpers/fixture-scripts";
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

function consumer(extraConfig = ""): string {
  const root = makeFixtureConsumer("pipeline", fixture.url, { files: { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG } });
  if (extraConfig) {
    const path = join(root, "dominion.config.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("environments: {", `${extraConfig}\n  environments: {`));
  }
  linkDominionPackage(root);
  roots.push(root);
  return root;
}

function scriptedInteraction(decisions: PlanDecision[]): RunInteraction & { asked: number } {
  const state = {
    asked: 0,
    async approvePlan() {
      state.asked += 1;
      return decisions.shift() ?? { action: "approve" as const };
    },
  };
  return state;
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? allFiles(abs) : [abs];
  });
}

describe("task mode end to end (scripted agents, real Playwright)", () => {
  let root: string;
  let events: DominionEvent[];
  let run: Awaited<ReturnType<typeof runTask>>;
  let calls: ReturnType<typeof scriptedRunner>["calls"];

  beforeAll(async () => {
    root = consumer();
    events = [];
    const scripted = scriptedRunner({ planner: plannerScript, generator: generatorScript() });
    calls = scripted.calls;
    run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "write tests for the add to cart workflow" },
      {
        runner: scripted.runner,
        interaction: scriptedInteraction([{ action: "regenerate", feedback: "Also cover the empty cart." }, { action: "approve" }]),
        prompter: nonInteractivePrompter(),
        skipPreflight: true,
        onEvent: (e) => events.push(e),
      },
    );
  });

  it("finishes the run with passing tests", () => {
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    const flow = run.flows[0]!;
    expect(flow.id).toBe("add-to-cart");
    expect(flow.status).toBe("done");
    expect(flow.specFiles).toEqual(["tests/agent/cart/add-to-cart.spec.ts"]);
    expect(flow.results?.map((r) => [r.title, r.status])).toEqual([
      ["Add to cart @dominion @flow:add-to-cart @role:customer > add a product from the listing page", "passed"],
      ["Add to cart @dominion @flow:add-to-cart @role:customer > empty cart message", "passed"],
    ]);
  });

  it("re-planned on reviewer feedback and passed the feedback to the planner", () => {
    const planners = calls.filter((c) => c.agent === "planner");
    expect(planners).toHaveLength(2);
    expect(planners[1]!.prompt).toContain("Also cover the empty cart.");
    expect(run.flows[0]!.feedback).toEqual(["Also cover the empty cart."]);
  });

  it("wrote an approved plan with frontmatter set by the framework", () => {
    const plan = readPlan(join(root, "specs", "add-to-cart.md"));
    expect(plan.frontmatter).toMatchObject({ env: "staging", role: "customer", flow: "add-to-cart", area: "cart", runId: run.id, status: "approved" });
    expect(plan.frontmatter.createdAt).not.toBe("2026-11-11T00:00:00.000Z");
    expect(plan.body).toMatch(/^# Add to cart/);
  });

  it("patched playwright.config.ts with a managed block and wrote dominion.setup.ts", () => {
    const config = readFileSync(join(root, "playwright.config.ts"), "utf8");
    expect(config).toContain(MANAGED_START);
    expect(config).toContain('name: "dominion-staging-customer"');
    expect(config).toContain('dependencies: ["dominion-setup-staging-customer"], grep: /@role:customer(?![\\w-])/');
    expect(config).toContain('testIdAttribute: "data-testid"');
    expect(config).toContain('name: "chromium"');
    expect(existsSync(join(root, "tests", "agent", "dominion.setup.ts"))).toBe(true);
  });

  it("enforced the tool policy: secret reads, foreign origins and rule-breaking writes were blocked", () => {
    const denied = events.filter((e) => e.type === "agent.denied").map((e) => (e as { reason: string }).reason);
    expect(denied.some((r) => /secrets/.test(r))).toBe(true);
    expect(denied.some((r) => /outside the application/.test(r))).toBe(true);
    expect(denied.some((r) => /waitForTimeout is not allowed/.test(r))).toBe(true);
    const generator = calls.find((c) => c.agent === "generator")!;
    expect(generator.policy.writeRoots).toEqual([join(root, "tests", "agent")]);
    expect(generator.mcp?.config.capabilities).toContain("testing");
    expect(generator.hiddenEnvVars).toEqual(expect.arrayContaining(["FX_USER", "FX_PASS"]));
  });

  it("recorded changed files, events and costs on disk", () => {
    expect(run.changedFiles.map((c) => `${c.kind} ${c.path}`).sort()).toEqual(
      ["added specs/add-to-cart.md", "added tests/agent/cart/add-to-cart.spec.ts", "added tests/agent/dominion.setup.ts", "modified playwright.config.ts"].sort(),
    );
    const configChange = run.changedFiles.find((c) => c.path === "playwright.config.ts")!;
    expect(readFileSync(join(root, ".dominion", "runs", run.id, configChange.before!), "utf8")).toBe(STOCK_PLAYWRIGHT_CONFIG);
    const types = new Set(readFileSync(join(root, ".dominion", "runs", run.id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type));
    for (const type of ["run.created", "run.stage_changed", "agent.tool_call", "plan.ready", "plan.approved", "files.changed", "test.result", "cost.updated", "run.finished"]) {
      expect(types.has(type), type).toBe(true);
    }
    expect(run.costUsd).toBeCloseTo(0.15);
  });

  it("never wrote a credential value into any log, event, plan or generated file", () => {
    const files = [...allFiles(join(root, ".dominion")), ...allFiles(join(root, "specs")), ...allFiles(join(root, "tests"))].filter(
      (f) => !/\.(png|jpg|zip|webm)$/.test(f),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const secret of FIXTURE_SECRET_VALUES) expect(content.includes(secret), `${file} contains a secret`).toBe(false);
    }
  });

  it("`dominion generate` regenerates tests from the approved plan", async () => {
    const scripted = scriptedRunner({ generator: generatorScript() });
    const again = await runGenerate(
      { loaded: await loadConfig({ cwd: root }), planPath: "specs/add-to-cart.md" },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(again.status, again.error?.message).toBe("done");
    expect(scripted.calls.map((c) => c.agent)).toEqual(["generator"]);
    expect(again.flows[0]!.results?.every((r) => r.status === "passed")).toBe(true);
  });
});

describe("pipeline controls", () => {
  it("rejecting the plan generates nothing", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ planner: plannerScript });
    const run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart" },
      { runner: scripted.runner, interaction: scriptedInteraction([{ action: "reject", feedback: "wrong flow" }]), prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("done");
    expect(run.flows[0]!.status).toBe("rejected");
    expect(scripted.calls.map((c) => c.agent)).toEqual(["planner"]);
    expect(readPlan(join(root, "specs", "add-to-cart.md")).frontmatter.status).toBe("rejected");
    expect(readFileSync(join(root, "playwright.config.ts"), "utf8")).toBe(STOCK_PLAYWRIGHT_CONFIG);
  });

  it("--plan-only with --auto-approve stops after an approved plan", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ planner: plannerScript });
    const run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart", autoApprove: true, planOnly: true },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("done");
    expect(scripted.calls.map((c) => c.agent)).toEqual(["planner"]);
    expect(readPlan(join(root, "specs", "add-to-cart.md")).frontmatter.status).toBe("approved");
  });

  it("stops cleanly at the budget cap and keeps artifacts", async () => {
    const root = consumer("budgets: { maxUsdPerRun: 0.5 },");
    const scripted = scriptedRunner({ planner: plannerScript }, { costPerCall: 0.75 });
    const run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart" },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("stopped");
    expect(run.error?.code).toBe("BUDGET_EXCEEDED");
    expect(scripted.calls[0]!.maxBudgetUsd).toBe(0.5);
    expect(existsSync(join(root, "specs", "add-to-cart.md"))).toBe(true);
    expect(existsSync(join(root, ".dominion", "runs", run.id, "events.jsonl"))).toBe(true);
  });

  it("stops when the user stops the run during review", async () => {
    const root = consumer();
    const controller = new AbortController();
    const scripted = scriptedRunner({ planner: plannerScript });
    const run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart" },
      {
        runner: scripted.runner,
        interaction: {
          async approvePlan() {
            controller.abort();
            return { action: "approve" };
          },
        },
        prompter: nonInteractivePrompter(),
        signal: controller.signal,
        skipPreflight: true,
      },
    );
    expect(run.status).toBe("stopped");
    expect(scripted.calls.map((c) => c.agent)).toEqual(["planner"]);
  });

  it("fails clearly when an agent runs out of turns", async () => {
    const root = consumer();
    const scripted = scriptedRunner({ planner: () => ({ ok: false, subtype: "error_max_turns", errors: ["max turns"] }) });
    const run = await runTask(
      { loaded: await loadConfig({ cwd: root }), envName: "staging", roleName: "customer", request: "add to cart" },
      { runner: scripted.runner, interaction: autoApproveInteraction, prompter: nonInteractivePrompter(), skipPreflight: true },
    );
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("AGENT_MAX_TURNS");
    expect(run.error?.hint).toMatch(/maxTurnsPerAgent/);
  });
});
