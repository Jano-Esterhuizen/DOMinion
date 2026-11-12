import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type AgentContext } from "../agents/context";
import { generationTarget, runGenerator } from "../agents/generator";
import { runHealer, specTags } from "../agents/healer";
import { runPlanner } from "../agents/planner";
import { type AgentResult, type AgentRunner, createSdkAgentRunner } from "../agents/runner";
import { ensureSession, storageStatePathFor } from "../auth";
import type { LoadedConfig } from "../config/loader";
import { defaultRole, getEnvironment, getRole, projectPaths } from "../config/resolve";
import { detectApiCredential } from "../doctor";
import { DominionError, errorMessage, isDominionError } from "../errors";
import type { DominionEvent, RunStage } from "../events";
import { relativePosix } from "../fs";
import { findPlaywrightConfigs } from "../init/detect";
import { ensureMcpBrowser, scrubMcpConfig } from "../mcp";
import { markTestFixme } from "../playwright/fixme";
import { formatLintIssues, hasDominionHeader, lintGeneratedFile } from "../playwright/lint";
import type { TestOutcome } from "../playwright/report";
import { ensureSetupFile, managedEntries, type PatchResult, patchPlaywrightConfig, SETUP_FILE_NAME, testProjectName } from "../playwright/patch";
import { runPlaywrightTests } from "../playwright/runner";
import { readPlan, setPlanStatus } from "../plans";
import type { Prompter } from "../prompter";
import { type Redactor, redactorFor, WELL_KNOWN_SECRET_ENV_VARS } from "../redact";
import { referencedEnvVars } from "../config/resolve";
import { unifiedDiff } from "../diff";
import { dominionPlaywrightConfigPath, ensureDominionPlaywrightConfig } from "../project/wiring";
import { diffSnapshots, saveBeforeCopy, type Snapshot, snapshotFiles } from "./changes";
import { flowSlugFromRequest, newRunId, slugify } from "./ids";
import { type RunHandle, RunStore } from "./store";
import type { DiscoveredFlow, FlowRun, Proposal, RunMode, RunRecord, TestResultSummary } from "./types";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type PlanDecision = { action: "approve" } | { action: "reject"; feedback?: string } | { action: "regenerate"; feedback: string };

/** How a run asks a person for decisions: the terminal, the UI, or auto-approve in CI. */
export interface RunInteraction {
  approvePlan(input: { run: RunRecord; flow: FlowRun; planPath: string; scenarios: string[] }): Promise<PlanDecision>;
  /** Crawl mode: which discovered flows to plan. */
  selectFlows?(input: { run: RunRecord; flows: DiscoveredFlow[] }): Promise<string[]>;
}

export const autoApproveInteraction: RunInteraction = {
  async approvePlan() {
    return { action: "approve" };
  },
};

export interface PipelineDeps {
  runner?: AgentRunner;
  interaction: RunInteraction;
  /** Used when a manual-login role needs a person. */
  prompter: Prompter;
  signal?: AbortSignal;
  onEvent?: (event: DominionEvent) => void;
  /** Called as soon as the run exists (the UI needs the id before the run finishes). */
  onRunCreated?: (run: RunHandle) => void;
  /** Tests with a scripted runner skip the API credential check and the MCP browser install. */
  skipPreflight?: boolean;
}

export interface TaskOptions {
  loaded: LoadedConfig;
  envName: string;
  roleName?: string;
  request: string;
  model?: string;
  autoApprove?: boolean;
  planOnly?: boolean;
}

export interface GenerateOptions {
  loaded: LoadedConfig;
  /** Path of an existing plan (absolute or relative to the repo root). */
  planPath: string;
  envName?: string;
  roleName?: string;
  model?: string;
  autoApprove?: boolean;
}

/** One test run of a flow: summaries for run.json and raw outcomes for healing. */
export interface FlowTestRun {
  summaries: TestResultSummary[];
  outcomes: TestOutcome[];
}

export interface HealOptions {
  loaded: LoadedConfig;
  /** A spec file to heal; default: every DOMinion-generated spec for the role. */
  file?: string;
  envName?: string;
  roleName?: string;
  model?: string;
  maxAttempts?: number;
  includeManual?: boolean;
}

/** The `// DOMinion: ...` comment the healer leaves above a test it marked fixme. */
export function fixmeReasonFromSource(file: string, line: number): string | undefined {
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const comments: string[] = [];
  for (let i = line - 2; i >= 0 && /^\s*\/\//.test(lines[i]!); i--) comments.unshift(lines[i]!.trim().replace(/^\/\/\s*/, ""));
  const dominion = comments.find((c) => c.startsWith("DOMinion:"));
  return (dominion ?? comments.join(" ")).replace(/^DOMinion:\s*/, "") || undefined;
}

/** Env vars stripped from processes that run generated code: credentials and API keys. */
export function secretEnvVarNames(loaded: LoadedConfig): string[] {
  return [...new Set([...WELL_KNOWN_SECRET_ENV_VARS, ...referencedEnvVars(loaded.config).map((r) => r.name)])];
}

class BudgetExceeded extends DominionError {
  constructor(spent: number, budget: number) {
    super(`The run hit its budget cap: $${spent.toFixed(2)} of $${budget.toFixed(2)} spent.`, {
      code: "BUDGET_EXCEEDED",
      hint: "Artifacts are kept. Raise budgets.maxUsdPerRun in dominion.config.ts to allow more, or narrow the request.",
    });
  }
}

class RunStopped extends Error {}

/** One pipeline execution. Task mode has one flow; crawl mode (M6) adds more. */
export class Pipeline {
  readonly run: RunHandle;
  readonly redactor: Redactor;
  private readonly controller = new AbortController();
  private readonly runner: AgentRunner;
  private readonly start: Snapshot;
  /** Playwright config files whose changes are reported (the user's config, playwright.dominion.config.ts). */
  private readonly watched: Array<{ path: string; content?: string }> = [];
  /** The Playwright config tests run with. */
  private runConfig?: string;
  private patch?: PatchResult;
  private proposalCount = 0;

  private constructor(
    readonly loaded: LoadedConfig,
    readonly envName: string,
    readonly roleName: string,
    readonly model: string,
    run: RunHandle,
    redactor: Redactor,
    readonly deps: PipelineDeps,
  ) {
    this.run = run;
    this.redactor = redactor;
    this.runner = deps.runner ?? createSdkAgentRunner();
    if (deps.signal) {
      if (deps.signal.aborted) this.controller.abort();
      else deps.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
    const paths = projectPaths(loaded);
    this.start = snapshotFiles(paths.root, [paths.testDir, paths.specsDir]);
    const profile = loaded.config.project;
    const watch = (path: string) => this.watched.push({ path, content: existsSync(path) ? readFileSync(path, "utf8") : undefined });
    if (profile) {
      watch(resolve(paths.root, profile.playwrightConfig));
      watch(dominionPlaywrightConfigPath(paths.root, profile));
    } else {
      const configFile = findPlaywrightConfigs(paths.root)[0];
      if (configFile) watch(join(paths.root, configFile));
    }
  }

  static create(
    options: { loaded: LoadedConfig; envName: string; roleName?: string; model?: string; mode: RunMode; request?: string; autoApprove?: boolean; planOnly?: boolean },
    deps: PipelineDeps,
  ): Pipeline {
    const { loaded } = options;
    const env = getEnvironment(loaded, options.envName);
    const roleName = options.roleName ?? defaultRole(env);
    getRole(env, roleName);
    const model = options.model ?? loaded.config.model;
    const redactor = redactorFor(loaded);
    const store = new RunStore(projectPaths(loaded), redactor);
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: newRunId(),
      mode: options.mode,
      env: env.name,
      role: roleName,
      request: options.request,
      model,
      status: "created",
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      budgetUsd: loaded.config.budgets.maxUsdPerRun,
      options: { autoApprove: options.autoApprove ?? false, planOnly: options.planOnly ?? false },
      flows: [],
      changedFiles: [],
    };
    const run = store.create(record);
    if (deps.onEvent) run.bus.subscribe(deps.onEvent);
    deps.onRunCreated?.(run);
    run.emit({ type: "run.created", mode: options.mode, env: env.name, role: roleName, request: options.request, model });
    return new Pipeline(loaded, env.name, roleName, model, run, redactor, deps);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stop(): void {
    this.controller.abort();
  }

  private remainingBudget = () => Math.max(this.run.record.budgetUsd - this.run.record.costUsd, 0);

  checkStopped(): void {
    if (this.controller.signal.aborted) throw new RunStopped("stopped");
  }

  setStage(stage: RunStage, flow?: FlowRun, message?: string): void {
    this.run.update((r) => {
      r.status = stage;
    });
    this.run.emit({ type: "run.stage_changed", stage, flowId: flow?.id, message });
  }

  updateFlow(flow: FlowRun, change: Partial<FlowRun>): void {
    Object.assign(flow, change);
    this.run.update((r) => {
      const index = r.flows.findIndex((f) => f.id === flow.id);
      if (index === -1) r.flows.push(flow);
      else r.flows[index] = flow;
    });
  }

  /** Charges an agent call to the run and turns failures into errors (or warnings when not fatal). */
  charge(result: AgentResult, flow: FlowRun | undefined, label: string, fatal = true): void {
    this.run.update((r) => {
      r.costUsd += result.costUsd;
    });
    if (flow) this.updateFlow(flow, { costUsd: flow.costUsd + result.costUsd });
    this.run.emit({ type: "cost.updated", totalUsd: this.run.record.costUsd, deltaUsd: result.costUsd, budgetUsd: this.run.record.budgetUsd });
    if (result.subtype === "aborted") throw new RunStopped("stopped");
    if (result.subtype === "error_max_budget_usd" || this.run.record.costUsd >= this.run.record.budgetUsd) {
      throw new BudgetExceeded(this.run.record.costUsd, this.run.record.budgetUsd);
    }
    if (!result.ok) {
      const detail = result.errors.join("; ") || result.text || result.subtype;
      if (!fatal) {
        this.run.emit({ type: "log", level: "warn", message: `The ${label} stopped early (${result.subtype}): ${detail.slice(0, 300)}`, flowId: flow?.id });
        return;
      }
      throw new DominionError(`The ${label} stopped before finishing (${result.subtype}): ${detail.slice(0, 500)}`, {
        code: result.subtype === "error_max_turns" ? "AGENT_MAX_TURNS" : "AGENT_FAILED",
        hint:
          result.subtype === "error_max_turns"
            ? "Raise budgets.maxTurnsPerAgent in dominion.config.ts or narrow the request."
            : "Check the run log; if the API key or network is the problem, `npx dominion doctor` will say so.",
      });
    }
  }

  async agentContext(): Promise<AgentContext> {
    const env = getEnvironment(this.loaded, this.envName);
    return {
      loaded: this.loaded,
      paths: projectPaths(this.loaded),
      env,
      roleName: this.roleName,
      role: getRole(env, this.roleName),
      storageState: storageStatePathFor(this.loaded, this.envName, this.roleName),
      run: this.run,
      runner: this.runner,
      redactor: this.redactor,
      model: this.model,
      signal: this.controller.signal,
      remainingBudget: this.remainingBudget,
      onProposal: (absPath, before, after, flowId) => this.recordProposal(absPath, before, after, flowId),
    };
  }

  /** API key, agent browser and a valid session for the role. */
  async preflight(): Promise<void> {
    if (!this.deps.skipPreflight) {
      if (!detectApiCredential()) {
        throw new DominionError("No Claude API credential is configured.", {
          code: "API_KEY_MISSING",
          hint: "Add ANTHROPIC_API_KEY=... to .env.local (gitignored) or export it; in CI use a secret.",
        });
      }
      await ensureMcpBrowser(this.loaded.config.agentBrowser);
    }
    // Header tokens from an api login are secrets too: ensureSession registers them with the run's redactor.
    const session = await ensureSession({ loaded: this.loaded, envName: this.envName, roleName: this.roleName, prompter: this.deps.prompter, redactor: this.redactor });
    this.run.emit({ type: "session.ready", role: this.roleName, action: session.action, state: session.check?.state });
  }

  newFlow(request: string, id = flowSlugFromRequest(request), startUrl?: string): FlowRun {
    const flow: FlowRun = { id, name: request.length > 80 ? `${request.slice(0, 77)}...` : request, request, startUrl, status: "pending", feedback: [], specFiles: [], supportFiles: [], costUsd: 0 };
    this.updateFlow(flow, {});
    return flow;
  }

  /** Plans a flow, looping on reviewer feedback until it is approved or rejected. */
  async planFlow(flow: FlowRun): Promise<"approved" | "rejected" | "skipped"> {
    const ctx = await this.agentContext();
    for (;;) {
      this.checkStopped();
      this.updateFlow(flow, { status: "planning" });
      this.setStage("planning", flow);
      const output = await runPlanner(ctx, flow);
      this.charge(output.result, flow, "planner");
      if (output.noPlan) {
        throw new DominionError(`The planner did not write ${relativePosix(ctx.paths.root, output.planPath)}.`, {
          code: "PLANNER_NO_PLAN",
          hint: "Run the task again; if it keeps happening, check the run log for denied tool calls.",
        });
      }
      const planRel = relativePosix(ctx.paths.root, output.planPath);
      this.updateFlow(flow, { status: "awaiting_approval", planPath: planRel, area: output.area ?? flow.area, name: output.title ?? flow.name, coverage: output.coverage });
      if (output.scenarios.length === 0) {
        setPlanStatus(output.planPath, "covered");
        this.updateFlow(flow, { status: "skipped" });
        this.run.emit({ type: "log", level: "info", message: `Skipping "${flow.name}": existing tests already cover it (see ${planRel}).`, flowId: flow.id });
        return "skipped";
      }
      this.run.emit({ type: "plan.ready", flowId: flow.id, planPath: planRel });

      if (this.run.record.options.autoApprove) {
        setPlanStatus(output.planPath, "approved");
        this.updateFlow(flow, { status: "approved" });
        this.run.emit({ type: "plan.approved", flowId: flow.id, planPath: planRel });
        return "approved";
      }
      if (this.run.record.options.planOnly) return "approved";

      this.setStage("awaiting_approval", flow);
      const decision = await this.deps.interaction.approvePlan({ run: this.run.record, flow, planPath: output.planPath, scenarios: output.scenarios });
      this.checkStopped();
      if (decision.action === "approve") {
        setPlanStatus(output.planPath, "approved");
        this.updateFlow(flow, { status: "approved" });
        this.run.emit({ type: "plan.approved", flowId: flow.id, planPath: planRel });
        return "approved";
      }
      if (decision.action === "reject") {
        setPlanStatus(output.planPath, "rejected");
        this.updateFlow(flow, { status: "rejected", feedback: decision.feedback ? [...flow.feedback, decision.feedback] : flow.feedback });
        this.run.emit({ type: "plan.rejected", flowId: flow.id, planPath: planRel, feedback: decision.feedback });
        return "rejected";
      }
      this.updateFlow(flow, { feedback: [...flow.feedback, decision.feedback] });
      this.run.emit({ type: "plan.rejected", flowId: flow.id, planPath: planRel, feedback: decision.feedback });
    }
  }

  /**
   * New projects: adds the managed setup/test projects and the setup file to playwright.config.ts.
   * Existing projects: writes playwright.dominion.config.ts and never touches the user's config.
   */
  ensurePlaywrightWiring(): PatchResult | undefined {
    if (this.patch) return this.patch;
    const paths = projectPaths(this.loaded);
    const profile = this.loaded.config.project;
    if (profile) {
      if (!existsSync(resolve(paths.root, profile.playwrightConfig))) {
        throw new DominionError(`project.playwrightConfig ${profile.playwrightConfig} does not exist.`, {
          code: "PLAYWRIGHT_CONFIG_MISSING",
          hint: "Re-run `npx dominion init` to detect the project again, or fix project.playwrightConfig in dominion.config.ts.",
        });
      }
      const result = ensureDominionPlaywrightConfig(paths.root, profile);
      if (result.status === "foreign") {
        throw new DominionError(`${relativePosix(paths.root, result.path)} exists but was not written by DOMinion.`, {
          code: "DOMINION_CONFIG_FOREIGN",
          hint: "Rename or delete it so DOMinion can create its own extension of your Playwright config.",
        });
      }
      if (result.status === "created") {
        this.run.emit({ type: "log", level: "info", message: `Created ${relativePosix(paths.root, result.path)}, which extends your Playwright config (your config is unchanged).` });
      }
      this.runConfig = result.path;
      this.patch = { status: result.status === "unchanged" ? "unchanged" : "patched", configPath: result.path };
      return this.patch;
    }
    const userConfig = this.watched[0];
    if (!userConfig?.content) {
      throw new DominionError("No playwright.config.* was found next to dominion.config.ts.", {
        code: "PLAYWRIGHT_CONFIG_MISSING",
        hint: "Run `npm init playwright@latest` so DOMinion can run the tests it generates.",
      });
    }
    const configDir = paths.root;
    this.runConfig = userConfig.path;
    this.patch = patchPlaywrightConfig(userConfig.path, managedEntries(this.loaded, configDir));
    const setup = ensureSetupFile(paths.testDir);
    if (setup.status === "foreign") {
      this.run.emit({ type: "log", level: "warn", message: `${relativePosix(paths.root, setup.path)} exists but was not written by DOMinion; leaving it alone.` });
    }
    if (this.patch.status === "manual") {
      this.run.emit({
        type: "run.error",
        message: `DOMinion could not add its projects to ${basename(this.patch.configPath)}: ${this.patch.reason}.`,
        hint: `Add this inside the projects array of ${basename(this.patch.configPath)}:\n${this.patch.snippet}`,
        code: "CONFIG_PATCH_MANUAL",
      });
    } else if (this.patch.status === "patched") {
      this.run.emit({ type: "log", level: "info", message: `Added DOMinion's setup and test projects to ${basename(this.patch.configPath)}.` });
    }
    return this.patch;
  }

  /** Runs the generator, then records and lints what it wrote. */
  async generateFlow(flow: FlowRun): Promise<void> {
    this.checkStopped();
    const ctx = await this.agentContext();
    if (!flow.planPath) throw new DominionError(`Flow ${flow.id} has no plan.`, { code: "PLAN_NOT_FOUND" });
    const planAbs = join(ctx.paths.root, flow.planPath);
    this.ensurePlaywrightWiring();
    const before = snapshotFiles(ctx.paths.root, [ctx.paths.testDir]);
    this.updateFlow(flow, { status: "generating" });
    this.setStage("generating", flow);
    const { result, target } = await runGenerator(ctx, flow, planAbs, flow.name);
    this.charge(result, flow, "generator");

    const after = snapshotFiles(ctx.paths.root, [ctx.paths.testDir]);
    const diff = diffSnapshots(before, after);
    const touched = [...diff.added, ...diff.modified].filter((p) => basename(p) !== SETUP_FILE_NAME);
    const specFiles = touched.filter((p) => /\.(spec|test)\.(ts|js|mjs|cjs)$/.test(p));
    const supportFiles = touched.filter((p) => !specFiles.includes(p));
    const expected = relativePosix(ctx.paths.root, target.specPath);
    if (!specFiles.length) {
      throw new DominionError(`The generator did not write ${expected}.`, {
        code: "GENERATOR_NO_SPEC",
        hint: "Check the run log for rejected writes (lint errors) or denied tool calls, then run `npx dominion generate` with the plan again.",
      });
    }
    this.updateFlow(flow, { specFiles, supportFiles });
    for (const file of touched) {
      const content = after.get(file)!.content;
      const isSpec = specFiles.includes(file);
      const issues = lintGeneratedFile(content, {
        kind: file.includes("/pages/") ? "page-object" : isSpec ? "spec" : "support",
        flowSlug: isSpec ? flow.id : undefined,
        role: isSpec ? this.roleName : undefined,
        testImport: isSpec ? target.testImport : undefined,
        redactor: this.redactor,
        baseURL: ctx.env.baseURL,
      });
      this.run.emit({
        type: "lint.result",
        file,
        flowId: flow.id,
        errors: issues.filter((i) => i.severity === "error").map((i) => formatLintIssues(file, [i])),
        warnings: issues.filter((i) => i.severity === "warning").map((i) => formatLintIssues(file, [i])),
      });
    }
    this.recordChanges(flow);
  }

  /** Recomputes changed files since the run started and keeps pre-run copies for diffs. */
  recordChanges(flow?: FlowRun): void {
    const paths = projectPaths(this.loaded);
    const now = snapshotFiles(paths.root, [paths.testDir, paths.specsDir]);
    const diff = diffSnapshots(this.start, now);
    const changes = [
      ...diff.added.map((path) => ({ path, kind: "added" as const })),
      ...diff.modified.map((path) => ({ path, kind: "modified" as const, before: saveBeforeCopy(this.run.dir, path, this.start.get(path)!.content) })),
    ];
    for (const file of this.watched) {
      if (!existsSync(file.path)) continue;
      const current = readFileSync(file.path, "utf8");
      if (current === file.content) continue;
      const rel = relativePosix(paths.root, file.path);
      if (file.content === undefined) changes.push({ path: rel, kind: "added" });
      else changes.push({ path: rel, kind: "modified", before: saveBeforeCopy(this.run.dir, rel, file.content) });
    }
    const previous = new Set(this.run.record.changedFiles.map((c) => `${c.kind}:${c.path}`));
    this.run.update((r) => {
      r.changedFiles = changes.map((c) => ({ ...c, flowId: r.changedFiles.find((p) => p.path === c.path)?.flowId ?? flow?.id }));
    });
    const fresh = changes.filter((c) => !previous.has(`${c.kind}:${c.path}`));
    if (fresh.length) this.run.emit({ type: "files.changed", flowId: flow?.id, files: fresh.map((c) => ({ path: c.path, kind: c.kind })) });
  }

  /** Runs the flow's specs through the consumer's Playwright in the role's DOMinion project. */
  async runFlowTests(flow: FlowRun, attempt = 0): Promise<FlowTestRun> {
    this.checkStopped();
    const paths = projectPaths(this.loaded);
    const patch = this.ensurePlaywrightWiring();
    if (patch?.status === "manual") {
      this.run.emit({ type: "log", level: "warn", message: "Skipping the test run until DOMinion's projects are added to the Playwright config (see the error above)." });
      return { summaries: [], outcomes: [] };
    }
    this.updateFlow(flow, { status: "running" });
    this.setStage("running", flow);
    // The session was ensured in preflight; refresh it if it expired, then run the tests without
    // their setup dependencies and without credentials or API keys in the test process's env.
    await ensureSession({ loaded: this.loaded, envName: this.envName, roleName: this.roleName, prompter: this.deps.prompter, redactor: this.redactor });
    const project = this.testProject();
    const result = await runPlaywrightTests({
      root: paths.root,
      configPath: this.runConfig!,
      files: flow.specFiles.map((f) => join(paths.root, f)),
      projects: [project],
      reportPath: this.run.path(`report-${flow.id}-${attempt}.json`),
      trace: "retain-on-failure",
      extraArgs: ["--no-deps"],
      unsetEnv: secretEnvVarNames(this.loaded),
      redactor: this.redactor,
      signal: this.controller.signal,
    });
    this.checkStopped();
    const outcomes = result.tests.filter((t) => t.project === project && basename(t.file) !== SETUP_FILE_NAME);
    const otherFailures = result.tests.filter((t) => t.project !== project && (t.status === "failed" || t.status === "timedOut"));
    if (result.globalErrors.length || otherFailures.length || (flow.specFiles.length > 0 && outcomes.length === 0)) {
      const detail = result.globalErrors[0]?.split("\n")[0] ?? otherFailures[0]?.error?.split("\n")[0] ?? "Playwright ran no tests from the generated files";
      throw new DominionError(`The test run failed before any generated test could run: ${this.redactor.redact(detail)}`, {
        code: "TEST_RUN_FAILED",
        hint: `Check ${flow.specFiles.join(", ")} for syntax or import errors, and that project "${project}" runs them (its testDir, testMatch and grep). Report: ${relativePosix(paths.root, this.run.path(`report-${flow.id}-${attempt}.json`))}`,
      });
    }
    const summaries: TestResultSummary[] = outcomes
      .map((t) => ({
        file: relativePosix(paths.root, t.file),
        title: t.titlePath.join(" > "),
        status: t.status,
        durationMs: t.durationMs,
        error: t.error ? this.redactor.redact(t.error).slice(0, 4000) : undefined,
        tracePath: t.tracePath ? relativePosix(paths.root, t.tracePath) : undefined,
        fixmeReason: t.fixmeReason,
      }));
    for (const s of summaries) {
      this.run.emit({ type: "test.result", file: s.file, title: s.title, status: s.status, durationMs: s.durationMs, error: s.error?.split("\n").slice(0, 6).join("\n"), tracePath: s.tracePath, flowId: flow.id });
    }
    this.updateFlow(flow, { results: summaries });
    return { summaries, outcomes };
  }

  /** The Playwright project generated tests run in. */
  private testProject(): string {
    const profile = this.loaded.config.project;
    if (!profile) return testProjectName(this.envName, this.roleName);
    if (!profile.runProject) {
      throw new DominionError("project.runProject is not set, so DOMinion does not know which Playwright project to run generated tests in.", {
        code: "RUN_PROJECT_MISSING",
        hint: 'Set project.runProject in dominion.config.ts to the project your tests normally run in (for example "chromium").',
      });
    }
    return profile.runProject;
  }

  /** Saves a proposed change to a hand-written file as a diff for a person to review (never applied here). */
  recordProposal(absPath: string, before: string, after: string, flowId?: string): void {
    const paths = projectPaths(this.loaded);
    const rel = relativePosix(paths.root, absPath);
    const existing = this.run.record.proposals?.find((p) => p.path === rel && p.status === "pending");
    const id = existing?.id ?? `p${++this.proposalCount}`;
    const diffFile = `proposals/${id}.diff`;
    const afterFile = `proposals/${id}.after`;
    mkdirSync(this.run.path("proposals"), { recursive: true });
    writeFileSync(this.run.path(diffFile), this.redactor.redact(unifiedDiff(before, after, rel)), "utf8");
    writeFileSync(this.run.path(afterFile), after, "utf8");
    const proposal: Proposal = { id, path: rel, diffFile, afterFile, beforeHash: sha256(before), status: "pending", flowId };
    this.run.update((r) => {
      r.proposals = [...(r.proposals ?? []).filter((p) => p.id !== id), proposal];
    });
    this.run.emit({ type: "log", level: "info", message: `Proposed a change to ${rel} (not applied; review it before applying).`, flowId });
  }

  /** Whether the healer may touch a file: DOMinion-generated, or any file with --include-manual. */
  private healable(file: string, includeManual: boolean): boolean {
    return includeManual || (existsSync(file) && hasDominionHeader(readFileSync(file, "utf8")));
  }

  /**
   * Heals failing tests: each failing test goes to the healer with its error, trace and failure
   * snapshot, up to maxHealAttempts times; after that the framework marks it fixme with a reason
   * (spec: Runner and healer).
   */
  async healFlow(flow: FlowRun, initial: FlowTestRun, options: { maxAttempts?: number; includeManual?: boolean } = {}): Promise<TestResultSummary[]> {
    const max = options.maxAttempts ?? this.loaded.config.budgets.maxHealAttempts;
    const includeManual = options.includeManual ?? false;
    const paths = projectPaths(this.loaded);
    const keyOf = (t: TestOutcome) => `${relativePosix(paths.root, t.file)}::${t.titlePath.join(" > ")}`;
    const attempts = new Map<string, number>();
    const verdicts = new Map<string, { outcome: "fixed" | "fixme" | "failed"; reason?: string }>();
    let current = initial;
    const seen = new Set<string>();

    for (let round = 1; ; round++) {
      const failing = current.outcomes.filter((t) => (t.status === "failed" || t.status === "timedOut") && this.healable(t.file, includeManual));
      for (const test of failing) seen.add(keyOf(test));
      // Every failing test gets up to max attempts plus one round to be marked fixme.
      if (!failing.length || round > (max + 1) * Math.max(seen.size, 1) + 1) break;
      this.updateFlow(flow, { status: "healing" });
      this.setStage("healing", flow);
      const ctx = await this.agentContext();
      let changed = false;
      for (const test of failing) {
        this.checkStopped();
        const key = keyOf(test);
        const file = relativePosix(paths.root, test.file);
        const title = test.titlePath.join(" > ");
        const used = attempts.get(key) ?? 0;
        if (used >= max) {
          const reason = this.redactor.redact(`still failing after ${used} heal attempt${used === 1 ? "" : "s"}: ${(test.error ?? "unknown error").split("\n")[0]}`);
          if (markTestFixme(test.file, { line: test.line, column: test.column, title: test.title }, reason)) changed = true;
          verdicts.set(key, { outcome: "fixme", reason });
          this.run.emit({ type: "heal.result", file, title, outcome: "fixme", reason, flowId: flow.id });
          continue;
        }
        attempts.set(key, used + 1);
        this.run.emit({ type: "heal.attempt", file, title, attempt: used + 1, max, flowId: flow.id });
        const result = await runHealer(
          ctx,
          { file: test.file, title, line: test.line, column: test.column, error: test.error, tracePath: test.tracePath, errorContextPath: test.errorContextPath },
          { attempt: used + 1, max, flowId: flow.id, includeManual },
        );
        this.charge(result, flow, "healer", false);
        changed = true;
      }
      if (!changed) break;
      current = await this.runFlowTests(flow, round);
      for (const test of current.outcomes) {
        const key = keyOf(test);
        if (!attempts.has(key) && !verdicts.has(key)) continue;
        const title = test.titlePath.join(" > ");
        const file = relativePosix(paths.root, test.file);
        if (test.status === "passed" && verdicts.get(key)?.outcome !== "fixed") {
          verdicts.set(key, { outcome: "fixed" });
          this.run.emit({ type: "heal.result", file, title, outcome: "fixed", flowId: flow.id });
        } else if (test.status === "fixme" && verdicts.get(key)?.outcome !== "fixme") {
          const reason = test.fixmeReason ?? fixmeReasonFromSource(test.file, test.line);
          verdicts.set(key, { outcome: "fixme", reason });
          this.run.emit({ type: "heal.result", file, title, outcome: "fixme", reason, flowId: flow.id });
        }
      }
    }

    for (const test of current.outcomes) {
      const key = keyOf(test);
      if ((test.status === "failed" || test.status === "timedOut") && attempts.has(key) && !verdicts.has(key)) {
        verdicts.set(key, { outcome: "failed" });
        this.run.emit({ type: "heal.result", file: relativePosix(paths.root, test.file), title: test.titlePath.join(" > "), outcome: "failed", flowId: flow.id });
      }
    }
    const summaries = current.summaries.map((s, i) => {
      const key = keyOf(current.outcomes[i]!);
      return { ...s, healAttempts: attempts.get(key), fixmeReason: s.fixmeReason ?? (s.status === "fixme" ? verdicts.get(key)?.reason : undefined) };
    });
    this.updateFlow(flow, { results: summaries });
    return summaries;
  }

  finish(status: "done" | "failed" | "stopped", summary: string, error?: unknown): RunRecord {
    try {
      this.recordChanges(this.run.record.flows[this.run.record.flows.length - 1]);
    } catch {
      // never let bookkeeping hide the real outcome
    }
    // The run folder is kept as an artifact: drop session header tokens from the agents' MCP config.
    scrubMcpConfig(this.run.path("mcp.json"));
    this.run.update((r) => {
      r.status = status;
      r.finishedAt = new Date().toISOString();
      if (error) {
        r.error = isDominionError(error)
          ? { message: this.redactor.redact(error.message), hint: error.hint ? this.redactor.redact(error.hint) : undefined, code: error.code }
          : { message: this.redactor.redact(errorMessage(error)) };
      }
    });
    if (error) {
      this.run.emit({
        type: "run.error",
        message: errorMessage(error),
        hint: isDominionError(error) ? error.hint : undefined,
        code: isDominionError(error) ? error.code : undefined,
      });
    }
    this.run.emit({ type: "run.stage_changed", stage: status });
    this.run.emit({ type: "run.finished", status, summary });
    return this.run.record;
  }

  /** Classifies an exception into a final status. */
  fail(error: unknown): RunRecord {
    if (error instanceof RunStopped || this.controller.signal.aborted) {
      for (const flow of this.run.record.flows) if (!["done", "rejected", "failed"].includes(flow.status)) this.updateFlow(flow, { status: "stopped" });
      return this.finish("stopped", "Stopped by the user; artifacts are kept.");
    }
    if (error instanceof BudgetExceeded) {
      for (const flow of this.run.record.flows) if (!["done", "rejected", "failed"].includes(flow.status)) this.updateFlow(flow, { status: "stopped" });
      return this.finish("stopped", error.message, error);
    }
    for (const flow of this.run.record.flows) if (!["done", "rejected"].includes(flow.status)) this.updateFlow(flow, { status: "failed", error: errorMessage(error) });
    return this.finish("failed", errorMessage(error), error);
  }
}

export function summarizeResults(results: readonly TestResultSummary[]): string {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const parts = [`${count("passed")} passed`];
  if (count("failed") + count("timedOut")) parts.push(`${count("failed") + count("timedOut")} failed`);
  if (count("fixme")) parts.push(`${count("fixme")} fixme`);
  if (count("skipped")) parts.push(`${count("skipped")} skipped`);
  return parts.join(", ");
}

/** Task mode: plan, approve, generate, run (spec: dominion task <env> "<request>"). */
export async function runTask(options: TaskOptions, deps: PipelineDeps): Promise<RunRecord> {
  const pipeline = Pipeline.create(
    { loaded: options.loaded, envName: options.envName, roleName: options.roleName, model: options.model, mode: "task", request: options.request, autoApprove: options.autoApprove, planOnly: options.planOnly },
    deps,
  );
  return executeTask(pipeline, options.request);
}

export async function executeTask(pipeline: Pipeline, request: string): Promise<RunRecord> {
  try {
    await pipeline.preflight();
    const flow = pipeline.newFlow(request);
    const outcome = await pipeline.planFlow(flow);
    pipeline.recordChanges(flow);
    if (outcome === "rejected") return pipeline.finish("done", "The plan was rejected; nothing was generated.");
    if (outcome === "skipped") return pipeline.finish("done", "Existing tests already cover this flow; nothing was generated.");
    if (pipeline.run.record.options.planOnly) {
      pipeline.updateFlow(flow, { status: pipeline.run.record.options.autoApprove ? "approved" : "awaiting_approval" });
      return pipeline.finish("done", `Plan saved to ${flow.planPath} (--plan-only).`);
    }
    await pipeline.generateFlow(flow);
    const results = await pipeline.healFlow(flow, await pipeline.runFlowTests(flow));
    pipeline.recordChanges(flow);
    pipeline.updateFlow(flow, { status: "done" });
    return pipeline.finish("done", `${flow.specFiles.join(", ")}: ${summarizeResults(results)}`);
  } catch (error) {
    return pipeline.fail(error);
  }
}

/** `dominion heal [file]`: run DOMinion's tests for a role and heal the failures. */
export async function runHeal(options: HealOptions, deps: PipelineDeps): Promise<RunRecord> {
  const { loaded } = options;
  const paths = projectPaths(loaded);
  const envNames = Object.keys(loaded.config.environments);
  const envName = options.envName ?? (envNames.length === 1 ? envNames[0]! : undefined);
  if (!envName) {
    throw new DominionError("Several environments are configured; choose one with --env.", { code: "ENV_REQUIRED", hint: `Environments: ${envNames.join(", ")}.` });
  }
  let files: string[];
  if (options.file) {
    const candidates = isAbsolute(options.file) ? [options.file] : [resolve(process.cwd(), options.file), resolve(paths.root, options.file)];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new DominionError(`Test file not found: ${options.file}`, { code: "SPEC_NOT_FOUND" });
    files = [found];
  } else {
    files = Array.from(snapshotFiles(paths.root, [paths.testDir]).entries())
      .filter(([path, state]) => /\.(spec|test)\.(ts|js|mjs|cjs)$/.test(path) && (options.includeManual || hasDominionHeader(state.content)))
      .map(([path]) => join(paths.root, path));
  }
  const roleOf = (file: string) => specTags(readFileSync(file, "utf8")).role;
  const roles = [...new Set(files.map(roleOf).filter((r): r is string => Boolean(r)))];
  const roleName = options.roleName ?? (roles.length === 1 ? roles[0] : undefined);
  if (!roleName) {
    throw new DominionError(roles.length ? "These tests use several roles; choose one with --role." : "Could not tell which role the tests use.", {
      code: "ROLE_REQUIRED",
      hint: roles.length ? `Roles found: ${roles.join(", ")}.` : "Pass --role <role>.",
    });
  }
  const untagged = files.filter((f) => !roleOf(f));
  if (options.file && untagged.length && !loaded.config.project) {
    throw new DominionError(`${relativePosix(paths.root, untagged[0]!)} has no @role:<role> tag, so it cannot run in DOMinion's test projects.`, {
      code: "SPEC_UNTAGGED",
      hint: 'Add "@role:<role>" to its test.describe title, or run it with your own Playwright command.',
    });
  }
  files = files.filter((f) => roleOf(f) === roleName || (loaded.config.project !== undefined && !roleOf(f)));
  if (!files.length) throw new DominionError(`No DOMinion tests for role "${roleName}" were found.`, { code: "SPEC_NOT_FOUND" });

  const pipeline = Pipeline.create(
    { loaded, envName, roleName, model: options.model, mode: "task", request: `Heal ${files.map((f) => relativePosix(paths.root, f)).join(", ")}`, autoApprove: true },
    deps,
  );
  try {
    await pipeline.preflight();
    const summaries: TestResultSummary[] = [];
    for (const file of files) {
      const id = slugify(relativePosix(paths.testDir, file).replace(/\.(spec|test)\.(ts|js|mjs|cjs)$/, "").replace(/\//g, " "));
      const flow = pipeline.newFlow(`Heal ${relativePosix(paths.root, file)}`, id);
      pipeline.updateFlow(flow, { specFiles: [relativePosix(paths.root, file)], status: "running" });
      summaries.push(...(await pipeline.healFlow(flow, await pipeline.runFlowTests(flow), { maxAttempts: options.maxAttempts, includeManual: options.includeManual })));
      pipeline.recordChanges(flow);
      pipeline.updateFlow(flow, { status: "done" });
    }
    return pipeline.finish("done", summarizeResults(summaries));
  } catch (error) {
    return pipeline.fail(error);
  }
}

/** `dominion generate <spec.md>`: generate and run tests from an existing plan. */
export async function runGenerate(options: GenerateOptions, deps: PipelineDeps): Promise<RunRecord> {
  const paths = projectPaths(options.loaded);
  const candidates = isAbsolute(options.planPath) ? [options.planPath] : [resolve(process.cwd(), options.planPath), resolve(paths.root, options.planPath)];
  const resolvedPlan = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  if (!existsSync(resolvedPlan)) {
    throw new DominionError(`Plan not found: ${options.planPath}`, { code: "PLAN_NOT_FOUND", hint: "Pass the path of a plan under specs/, for example specs/add-to-cart.md." });
  }
  const plan = readPlan(resolvedPlan);
  const envName = options.envName ?? plan.frontmatter.env;
  const roleName = options.roleName ?? plan.frontmatter.role;
  if (!envName) throw new DominionError("The plan has no env in its frontmatter.", { code: "PLAN_NO_ENV", hint: "Pass --env <env>." });
  const flowId = plan.frontmatter.flow ?? basename(resolvedPlan).replace(/\.md$/, "");
  const pipeline = Pipeline.create(
    { loaded: options.loaded, envName, roleName, model: options.model, mode: "task", request: `Generate tests from ${relativePosix(paths.root, resolvedPlan)}`, autoApprove: options.autoApprove },
    deps,
  );
  try {
    await pipeline.preflight();
    const flow = pipeline.newFlow(plan.frontmatter.flow ?? flowId, flowId);
    const title = /^#\s+(.+)$/m.exec(plan.body)?.[1]?.trim();
    pipeline.updateFlow(flow, { name: title ?? flow.name, planPath: relativePosix(paths.root, resolvedPlan), area: plan.frontmatter.area || undefined });
    if (plan.frontmatter.status !== "approved") {
      if (pipeline.run.record.options.autoApprove) {
        setPlanStatus(resolvedPlan, "approved");
      } else {
        pipeline.updateFlow(flow, { status: "awaiting_approval" });
        pipeline.setStage("awaiting_approval", flow);
        const decision = await deps.interaction.approvePlan({ run: pipeline.run.record, flow, planPath: resolvedPlan, scenarios: [] });
        if (decision.action === "reject") {
          setPlanStatus(resolvedPlan, "rejected");
          pipeline.updateFlow(flow, { status: "rejected", feedback: decision.feedback ? [decision.feedback] : [] });
          pipeline.run.emit({ type: "plan.rejected", flowId: flow.id, planPath: flow.planPath!, feedback: decision.feedback });
          return pipeline.finish("done", "The plan was rejected; nothing was generated.");
        }
        if (decision.action === "regenerate") {
          // Re-plan with the reviewer's feedback (the planner sees the previous plan), then continue.
          pipeline.updateFlow(flow, { feedback: [decision.feedback], request: title ?? flow.request });
          pipeline.run.emit({ type: "plan.rejected", flowId: flow.id, planPath: flow.planPath!, feedback: decision.feedback });
          const outcome = await pipeline.planFlow(flow);
          if (outcome === "rejected") return pipeline.finish("done", "The plan was rejected; nothing was generated.");
          if (outcome === "skipped") return pipeline.finish("done", "Existing tests already cover this flow; nothing was generated.");
        }
        setPlanStatus(resolvedPlan, "approved");
      }
    }
    pipeline.updateFlow(flow, { status: "approved" });
    pipeline.run.emit({ type: "plan.approved", flowId: flow.id, planPath: flow.planPath! });
    await pipeline.generateFlow(flow);
    const results = await pipeline.healFlow(flow, await pipeline.runFlowTests(flow));
    pipeline.recordChanges(flow);
    pipeline.updateFlow(flow, { status: "done" });
    return pipeline.finish("done", `${flow.specFiles.join(", ")}: ${summarizeResults(results)}`);
  } catch (error) {
    return pipeline.fail(error);
  }
}

export { generationTarget };
