import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor";
import type { RunRecord } from "../../src/core/orchestrator/types";
import { buildCli, runCli } from "../helpers/cli";
import { FIXTURE_ENV, makeFixtureConsumer, setEnv } from "../helpers/consumer";
import { REPO_ROOT, removeDir, writeFiles } from "../helpers/tmp";

let root: string;
let restoreEnv: () => void;

const record = (partial: Partial<RunRecord> & Pick<RunRecord, "id" | "status" | "createdAt">): RunRecord => ({
  mode: "task",
  env: "staging",
  role: "customer",
  model: "claude-sonnet-5-5",
  updatedAt: partial.createdAt,
  costUsd: 0,
  budgetUsd: 10,
  options: { autoApprove: false, planOnly: false },
  flows: [],
  changedFiles: [],
  ...partial,
});

const RUNS: RunRecord[] = [
  record({
    id: "2026-11-10-aaaa01",
    status: "done",
    createdAt: "2026-11-10T09:00:00.000Z",
    finishedAt: "2026-11-10T09:04:00.000Z",
    request: "write tests for the add to cart workflow",
    costUsd: 1.25,
    flows: [
      {
        id: "add-to-cart",
        name: "Add to cart",
        request: "write tests for the add to cart workflow",
        status: "done",
        feedback: [],
        specFiles: ["tests/agent/cart/add-to-cart.spec.ts"],
        supportFiles: [],
        costUsd: 1.25,
        results: [
          { file: "tests/agent/cart/add-to-cart.spec.ts", title: "add a product", status: "passed", durationMs: 900 },
          { file: "tests/agent/cart/add-to-cart.spec.ts", title: "empty cart", status: "fixme", durationMs: 0 },
        ],
      },
    ],
  }),
  record({
    id: "2026-11-11-bbbb02",
    mode: "crawl",
    status: "failed",
    createdAt: "2026-11-11T09:00:00.000Z",
    costUsd: 0.5,
    error: { message: "The run hit its budget cap", code: "BUDGET_EXCEEDED" },
  }),
  record({ id: "2026-11-12-cccc03", status: "awaiting_approval", createdAt: "2026-11-12T09:00:00.000Z", request: "search", costUsd: 0.1 }),
];

beforeAll(() => {
  buildCli();
  root = makeFixtureConsumer("polish", "http://127.0.0.1:1");
  writeFiles(root, Object.fromEntries(RUNS.map((r) => [`.dominion/runs/${r.id}/run.json`, JSON.stringify(r, null, 2)])));
  restoreEnv = setEnv({ ...FIXTURE_ENV });
});

afterAll(() => {
  restoreEnv?.();
  if (root) removeDir(root);
});

describe("dominion runs", () => {
  it("lists past runs newest first with status, tests and cost", async () => {
    const result = await runCli(["runs"], { cwd: root });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split(/\r?\n/);
    expect(lines[0]).toMatch(/^RUN\s+MODE\s+ENV\/ROLE\s+STATUS\s+TESTS\s+COST\s+STARTED\s+REQUEST$/);
    expect(lines[1]).toMatch(/^2026-11-12-cccc03\s+task\s+staging\/customer\s+awaiting approval\s+-\s+\$0\.10/);
    expect(lines[2]).toMatch(/^2026-11-11-bbbb02\s+crawl\s+staging\/customer\s+failed\s+-\s+\$0\.50\s+.*0 flows$/);
    expect(lines[3]).toMatch(/^2026-11-10-aaaa01\s+task\s+staging\/customer\s+done\s+1 passed, 1 fixme\s+\$1\.25\s+.*write tests for the add to cart workflow$/);
    expect(result.stdout).toContain("3 of 3 runs, $1.85 total");
  });

  it("filters, limits and prints JSON for scripts", async () => {
    const json = await runCli(["runs", "--json", "--limit", "2"], { cwd: root });
    expect(json.status, json.stderr).toBe(0);
    const runs = JSON.parse(json.stdout) as Array<{ id: string; active: boolean; tests: Record<string, number>; durationMs?: number }>;
    expect(runs.map((r) => r.id)).toEqual(["2026-11-12-cccc03", "2026-11-11-bbbb02"]);
    expect(runs[0]!.active).toBe(true);

    const done = JSON.parse((await runCli(["runs", "--json", "--status", "done"], { cwd: root })).stdout) as typeof runs;
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: "2026-11-10-aaaa01", active: false, tests: { passed: 1, fixme: 1 }, durationMs: 240_000 });

    const bad = await runCli(["runs", "--limit", "many"], { cwd: root });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("--limit must be a whole number");
  });

  it("says how to start when there are no runs", async () => {
    const empty = makeFixtureConsumer("polish-empty", "http://127.0.0.1:1");
    try {
      const result = await runCli(["runs"], { cwd: empty });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No runs yet");
    } finally {
      removeDir(empty);
    }
  });
});

describe("prompt overrides", () => {
  it("ejects defaults without overwriting and lists which prompts are overridden", async () => {
    const eject = await runCli(["prompts", "eject", "planner"], { cwd: root });
    expect(eject.status, eject.stderr).toBe(0);
    expect(eject.stdout).toContain("created dominion/prompts/planner.md");
    const path = join(root, "dominion", "prompts", "planner.md");
    expect(readFileSync(path, "utf8")).toBe(readFileSync(join(REPO_ROOT, "src", "prompts", "planner.md"), "utf8"));
    writeFiles(root, { "dominion/prompts/planner.md": `${readFileSync(path, "utf8")}\nAlways plan an accessibility check.\n` });
    const again = await runCli(["prompts", "eject", "planner"], { cwd: root });
    expect(again.stdout).toContain("kept    dominion/prompts/planner.md (already exists)");
    expect(readFileSync(path, "utf8")).toContain("Always plan an accessibility check.");

    const list = await runCli(["prompts"], { cwd: root });
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/planner\s+override: dominion\/prompts\/planner\.md/);
    expect(list.stdout).toMatch(/generator\s+default/);

    const unknown = await runCli(["prompts", "eject", "planer"], { cwd: root });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown prompt: planer");
  });

  it("doctor reports overrides, unknown placeholders and misnamed files", async () => {
    writeFiles(root, {
      "dominion/prompts/healer.md": "Heal with {{testIdAttribute}} and {{appName}}.\n",
      "dominion/prompts/planer.md": "typo\n",
    });
    const report = await runDoctor({ cwd: root, validateSessions: false });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["prompt:planner"]).toMatchObject({ status: "ok", detail: "dominion/prompts/planner.md replaces the default planner prompt" });
    expect(byId["prompt:healer"]?.status).toBe("error");
    expect(byId["prompt:healer"]?.detail).toContain("unknown placeholder {{appName}}");
    expect(byId["prompt:planer"]?.status).toBe("warn");
    expect(byId["prompt:planer"]?.detail).toContain("not a DOMinion prompt");
    expect(existsSync(join(root, "dominion", "prompts", "generator.md"))).toBe(false);
  });
});
