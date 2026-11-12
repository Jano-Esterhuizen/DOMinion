import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { coverageFor, coveragePromptSection, type FlowCoverage } from "../project/coverage";
import { scanSources } from "../project/scan";
import { DominionError } from "../errors";
import { relativePosix } from "../fs";
import type { FlowRun } from "../orchestrator/types";
import { normalizePlanFile, parsePlan } from "../plans";
import { type AgentContext, credentialEnvVars, destructiveRule, mcpForRun, roleDescription, seedTest } from "./context";
import { BROWSER_INPUT_TOOLS, BROWSER_READ_TOOLS } from "./guard";
import { renderPrompt } from "./prompts";
import type { AgentResult } from "./runner";

export interface PlannerOutput {
  /** True when the planner finished without writing a plan. */
  noPlan?: boolean;
  planPath: string;
  coverage: FlowRun["coverage"];
  title?: string;
  area?: string;
  scenarios: string[];
  result: AgentResult;
}

/** specs/<flow-slug>.md */
export function planPathFor(ctx: Pick<AgentContext, "paths">, flowId: string): string {
  return join(ctx.paths.specsDir, `${flowId}.md`);
}

/** Existing tests that already cover a flow (spec: Coverage awareness). */
export function flowCoverage(ctx: AgentContext, flow: FlowRun): { coverage: FlowCoverage; section?: string } {
  const profile = ctx.loaded.config.project;
  const dir = profile ? resolve(ctx.paths.root, profile.testDir) : ctx.paths.testDir;
  const testFiles = scanSources(ctx.paths.root, dir).testFiles;
  const coverage = coverageFor({ id: flow.id, name: flow.name, request: flow.request, startUrl: flow.startUrl }, testFiles);
  return { coverage, section: coveragePromptSection(coverage, testFiles) };
}

export function buildPlannerPrompt(ctx: AgentContext, flow: FlowRun, planRel: string, createdAt: string, previousPlan?: string, coverageSection?: string): string {
  const lines = [
    `Plan the "${flow.name}" flow.`,
    "",
    `Request: ${flow.request}`,
    `Environment: ${ctx.env.name} (base URL ${ctx.env.baseURL})`,
    `Role: ${roleDescription(ctx)}`,
    `Start URL: ${flow.startUrl ?? ctx.env.baseURL}`,
    "",
    `Save the plan with the Write tool to exactly: ${planRel}`,
    "Use this frontmatter:",
    "```yaml",
    `env: ${ctx.env.name}`,
    `role: ${ctx.roleName}`,
    `flow: ${flow.id}`,
    `area: <short feature folder name, for example cart>`,
    `runId: ${ctx.run.id}`,
    `createdAt: ${createdAt}`,
    "status: draft",
    "```",
    "",
    `Irreversible actions: ${destructiveRule(ctx.env)}`,
    `Excluded paths (never visit): ${ctx.loaded.config.crawl.exclude.join(", ") || "none configured"}.`,
    `Allowed origins: ${ctx.env.allowedOrigins.join(", ")}.`,
    "",
    "Seed test (every generated test starts like this, and so does your browser):",
    "```ts",
    seedTest(ctx, 'import { test, expect } from "@playwright/test";'),
    "```",
  ];
  if (coverageSection) lines.push("", coverageSection);
  if (flow.feedback.length) {
    lines.push("", "A reviewer rejected the previous version of this plan. Address every point of their feedback:");
    for (const item of flow.feedback) lines.push(`- ${item}`);
  }
  if (previousPlan) {
    lines.push("", "Previous version of the plan, for reference:", "```markdown", previousPlan.trim(), "```");
  }
  return lines.join("\n");
}

/** Runs the planner agent for one flow and normalizes the plan file it writes. */
export async function runPlanner(ctx: AgentContext, flow: FlowRun): Promise<PlannerOutput> {
  const planPath = planPathFor(ctx, flow.id);
  const planRel = relativePosix(ctx.paths.root, planPath);
  mkdirSync(dirname(planPath), { recursive: true });
  const previousPlan = flow.feedback.length && existsSync(planPath) ? parsePlan(readFileSync(planPath, "utf8")).body : undefined;
  const createdAt = new Date().toISOString();
  const before = existsSync(planPath) ? readFileSync(planPath, "utf8") : undefined;
  const { coverage, section } = flowCoverage(ctx, flow);
  const coverageSummary = { status: coverage.status, tests: coverage.tests.map((t) => ({ file: t.file, title: t.title })) };

  const result = await ctx.runner.run(
    {
      agent: "planner",
      flowId: flow.id,
      model: ctx.model,
      systemPrompt: renderPrompt("planner", { testIdAttribute: ctx.loaded.config.testIdAttribute }, ctx.paths.promptOverridesDir, ctx.paths.root),
      prompt: buildPlannerPrompt(ctx, flow, planRel, createdAt, previousPlan, section),
      maxTurns: ctx.loaded.config.budgets.maxTurnsPerAgent,
      maxBudgetUsd: ctx.remainingBudget(),
      cwd: ctx.paths.root,
      mcp: mcpForRun(ctx),
      screenshotDir: ctx.run.path("screenshots"),
      hiddenEnvVars: credentialEnvVars(ctx),
      signal: ctx.signal,
      policy: {
        agent: "planner",
        root: ctx.paths.root,
        builtinTools: ["Write"],
        mcpTools: [...BROWSER_READ_TOOLS, ...BROWSER_INPUT_TOOLS],
        readRoots: [],
        writeRoots: [planPath],
        writeExtensions: [".md"],
        env: ctx.env,
        excludePatterns: ctx.loaded.config.crawl.exclude,
        redactor: ctx.redactor,
      },
    },
    (payload) => ctx.run.emit(payload),
  );

  const written = existsSync(planPath) ? readFileSync(planPath, "utf8") : undefined;
  if (!written || written === before) {
    // Fall back to a plan returned as the final message instead of written to disk.
    const text = result.text.trim();
    if (result.ok && /^(---|#|```)/.test(text) && /###\s/.test(text)) {
      writeFileSync(planPath, text, "utf8");
    } else if (!result.ok) {
      return { planPath, scenarios: [], result, coverage: coverageSummary };
    } else {
      return { noPlan: true, planPath, scenarios: [], result, coverage: coverageSummary };
    }
  }
  const meta = normalizePlanFile(
    planPath,
    { env: ctx.env.name, role: ctx.roleName, flow: flow.id, runId: ctx.run.id, createdAt, status: "draft" },
    ctx.redactor,
  );
  return { planPath, ...meta, result, coverage: coverageSummary };
}
