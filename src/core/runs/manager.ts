import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunner } from "../agents/runner";
import type { LoadedConfig } from "../config/loader";
import { getEnvironment, getRole, projectPaths } from "../config/resolve";
import { unifiedDiff } from "../diff";
import { DominionError } from "../errors";
import type { DominionEvent, EventListener } from "../events";
import { isInside } from "../fs";
import { runCrawl } from "../orchestrator/crawl";
import { type PipelineDeps, type PlanDecision, type RunInteraction, runGenerate, runHeal, runTask } from "../orchestrator/pipeline";
import { applyProposal, rejectProposal } from "../orchestrator/proposals";
import { type RunHandle, RunStore } from "../orchestrator/store";
import type { RunRecord } from "../orchestrator/types";
import { readPlan } from "../plans";
import type { Choice, Prompter } from "../prompter";
import { redactorFor } from "../redact";

export type StartRunInput =
  | { mode: "task"; env: string; role?: string; request: string; model?: string; autoApprove?: boolean; planOnly?: boolean }
  | { mode: "generate"; planPath: string; env?: string; role?: string; model?: string }
  | { mode: "heal"; env?: string; role?: string; file?: string; maxAttempts?: number; includeManual?: boolean; model?: string }
  | { mode: "crawl"; env: string; role?: string; maxPages?: number; model?: string; autoApprove?: boolean; planOnly?: boolean };

interface LiveRun {
  handle: RunHandle;
  controller: AbortController;
  done: Promise<RunRecord>;
  pendingPlans: Map<string, (decision: PlanDecision) => void>;
  pendingFlowSelection?: (flowIds: string[]) => void;
  pendingContinue?: () => void;
}

export interface ChangedFileDiff {
  path: string;
  kind: "added" | "modified";
  diff: string;
}

export interface RunManagerOptions {
  /** Scripted agents in tests; the Claude Agent SDK by default. */
  runner?: AgentRunner;
  skipPreflight?: boolean;
}

/**
 * Runs started from the UI live in the server process. The browser UI holds no state of its own:
 * it reads run.json / events from here, and its decisions (plan approval, flow selection, "I have
 * logged in") resolve the promises the pipeline is waiting on.
 */
export class RunManager {
  readonly store: RunStore;
  private readonly live = new Map<string, LiveRun>();

  private current: LoadedConfig;

  constructor(
    loaded: LoadedConfig,
    private readonly options: RunManagerOptions = {},
  ) {
    this.current = loaded;
    this.store = new RunStore(projectPaths(loaded), redactorFor(loaded));
  }

  get loaded(): LoadedConfig {
    return this.current;
  }

  /** The Setup tab changed dominion.config.ts or .env.local: new runs use the new config and secrets. */
  setLoaded(loaded: LoadedConfig): void {
    this.current = loaded;
    this.store.redactor = redactorFor(loaded);
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  /** Starts a run in the background and resolves as soon as it has an id. */
  async start(input: StartRunInput): Promise<RunRecord> {
    if (input.mode === "task" || input.mode === "crawl") {
      const env = getEnvironment(this.loaded, input.env);
      if (input.role) getRole(env, input.role);
    }
    if (input.mode === "task" && !input.request?.trim()) {
      throw new DominionError("Describe the flow to test.", { code: "REQUEST_REQUIRED", hint: 'For example: "write tests for the add to cart workflow".' });
    }
    const controller = new AbortController();
    const pendingPlans = new Map<string, (decision: PlanDecision) => void>();
    let entry: LiveRun | undefined;
    let resolveHandle!: (handle: RunHandle) => void;
    let rejectHandle!: (error: unknown) => void;
    const handlePromise = new Promise<RunHandle>((resolve, reject) => {
      resolveHandle = resolve;
      rejectHandle = reject;
    });

    const interaction: RunInteraction = {
      approvePlan: ({ flow }) =>
        new Promise<PlanDecision>((resolve) => {
          pendingPlans.set(flow.id, resolve);
        }),
      selectFlows: () =>
        new Promise<string[]>((resolve) => {
          if (entry) entry.pendingFlowSelection = resolve;
        }),
    };
    const prompter = this.uiPrompter(() => entry);
    const deps: PipelineDeps & { selectFlows?: (flowIds: string[]) => void } = {
      runner: this.options.runner,
      interaction,
      prompter,
      signal: controller.signal,
      skipPreflight: this.options.skipPreflight,
      onRunCreated: (handle) => resolveHandle(handle),
    };

    let done: Promise<RunRecord>;
    switch (input.mode) {
      case "task":
        done = runTask({ loaded: this.loaded, envName: input.env, roleName: input.role, request: input.request, model: input.model, autoApprove: input.autoApprove, planOnly: input.planOnly }, deps);
        break;
      case "generate":
        done = runGenerate({ loaded: this.loaded, planPath: input.planPath, envName: input.env, roleName: input.role, model: input.model }, deps);
        break;
      case "heal":
        done = runHeal({ loaded: this.loaded, envName: input.env, roleName: input.role, file: input.file, maxAttempts: input.maxAttempts, includeManual: input.includeManual, model: input.model }, deps);
        break;
      case "crawl":
        done = runCrawl({ loaded: this.loaded, envName: input.env, roleName: input.role, maxPages: input.maxPages, model: input.model, autoApprove: input.autoApprove, planOnly: input.planOnly }, deps);
        break;
    }
    done.catch((error: unknown) => rejectHandle(error));
    const handle = await handlePromise;
    entry = { handle, controller, done, pendingPlans };
    this.live.set(handle.id, entry);
    done.finally(() => this.live.delete(handle.id)).catch(() => undefined);
    return handle.record;
  }

  /** A prompter whose waits are answered from the UI (manual login inside a run, CAPTCHA pauses). */
  private uiPrompter(current: () => LiveRun | undefined): Prompter {
    return {
      interactive: true,
      async confirm(_message: string, defaultValue: boolean) {
        return defaultValue;
      },
      async input(_message: string, defaultValue?: string) {
        return defaultValue ?? "";
      },
      async select<T extends string>(_message: string, choices: ReadonlyArray<Choice<T>>, defaultValue?: T) {
        return defaultValue ?? choices[0]!.value;
      },
      waitForUser: (message: string) =>
        new Promise<void>((resolve) => {
          const run = current();
          if (!run) {
            resolve();
            return;
          }
          run.pendingContinue = resolve;
          run.handle.update((r) => {
            r.pause = { reason: message, since: new Date().toISOString() };
          });
          run.handle.emit({ type: "run.paused", reason: message });
        }),
    };
  }

  private requireLive(runId: string): LiveRun {
    const live = this.live.get(runId);
    if (!live) {
      throw new DominionError(`Run ${runId} is not active (it finished, or the server restarted).`, {
        code: "RUN_NOT_ACTIVE",
        hint: "Start a new run; an approved plan can be turned into tests with Generate.",
      });
    }
    return live;
  }

  get(runId: string): RunRecord {
    return this.live.get(runId)?.handle.record ?? this.store.get(runId).record;
  }

  list(): RunRecord[] {
    return this.store.list();
  }

  events(runId: string, afterSeq = 0): DominionEvent[] {
    return (this.live.get(runId)?.handle ?? this.store.get(runId)).events(afterSeq);
  }

  /** Live events for an active run; returns an unsubscribe function (no-op for finished runs). */
  subscribe(runId: string, listener: EventListener): () => void {
    const live = this.live.get(runId);
    return live ? live.handle.bus.subscribe(listener) : () => undefined;
  }

  stop(runId: string): void {
    const live = this.requireLive(runId);
    live.pendingContinue?.();
    for (const resolve of live.pendingPlans.values()) resolve({ action: "reject" });
    live.controller.abort();
  }

  /** Resumes a run paused for a person (manual login done, CAPTCHA cleared). */
  continue(runId: string): void {
    const live = this.requireLive(runId);
    if (!live.pendingContinue) throw new DominionError(`Run ${runId} is not waiting for you.`, { code: "RUN_NOT_PAUSED" });
    const resume = live.pendingContinue;
    live.pendingContinue = undefined;
    live.handle.update((r) => {
      r.pause = undefined;
    });
    resume();
  }

  decidePlan(runId: string, flowId: string, decision: PlanDecision): void {
    const live = this.requireLive(runId);
    const resolve = live.pendingPlans.get(flowId);
    if (!resolve) throw new DominionError(`No plan is waiting for review in flow "${flowId}".`, { code: "PLAN_NOT_PENDING" });
    live.pendingPlans.delete(flowId);
    resolve(decision);
  }

  selectFlows(runId: string, flowIds: string[]): void {
    const live = this.requireLive(runId);
    if (!live.pendingFlowSelection) throw new DominionError(`Run ${runId} is not waiting for a flow selection.`, { code: "FLOWS_NOT_PENDING" });
    const resolve = live.pendingFlowSelection;
    live.pendingFlowSelection = undefined;
    resolve(flowIds);
  }

  private planFile(runId: string, flowId: string): string {
    const run = this.get(runId);
    const flow = run.flows.find((f) => f.id === flowId);
    if (!flow?.planPath) throw new DominionError(`Flow "${flowId}" has no plan.`, { code: "PLAN_NOT_FOUND" });
    const paths = projectPaths(this.loaded);
    const abs = join(paths.root, ...flow.planPath.split("/"));
    if (!isInside(paths.specsDir, abs)) throw new DominionError("The plan is outside the specs folder.", { code: "PLAN_OUTSIDE_SPECS" });
    return abs;
  }

  readPlanFile(runId: string, flowId: string): { path: string; content: string; frontmatter: Record<string, string> } {
    const abs = this.planFile(runId, flowId);
    const content = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    return { path: this.get(runId).flows.find((f) => f.id === flowId)!.planPath!, content, frontmatter: content ? readPlan(abs).frontmatter : {} };
  }

  /** Saves the reviewer's edits to a plan that has not been generated from yet. */
  savePlanFile(runId: string, flowId: string, content: string): void {
    const flow = this.get(runId).flows.find((f) => f.id === flowId);
    if (!flow || !["awaiting_approval", "approved", "rejected", "skipped"].includes(flow.status)) {
      throw new DominionError("This plan can no longer be edited (generation has started).", { code: "PLAN_LOCKED" });
    }
    writeFileSync(this.planFile(runId, flowId), content.replace(/\r\n/g, "\n"), "utf8");
  }

  /** Changed files with unified diffs (spec: GET /api/runs/:id/diff), plus proposals. */
  diff(runId: string): { files: ChangedFileDiff[]; proposals: Array<{ id: string; path: string; status: string; diff: string }> } {
    const run = this.get(runId);
    const handle = this.live.get(runId)?.handle ?? this.store.get(runId);
    const paths = projectPaths(this.loaded);
    const files = run.changedFiles.map((change) => {
      const abs = join(paths.root, ...change.path.split("/"));
      const after = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      const before = change.before && existsSync(handle.path(...change.before.split("/"))) ? readFileSync(handle.path(...change.before.split("/")), "utf8") : "";
      return { path: change.path, kind: change.kind, diff: this.store.redactor.redact(unifiedDiff(before, after, change.path, { isNew: change.kind === "added" })) };
    });
    const proposals = (run.proposals ?? []).map((p) => ({
      id: p.id,
      path: p.path,
      status: p.status,
      diff: existsSync(handle.path(...p.diffFile.split("/"))) ? readFileSync(handle.path(...p.diffFile.split("/")), "utf8") : "",
    }));
    return { files, proposals };
  }

  decideProposal(runId: string, proposalId: string, action: "apply" | "reject"): void {
    const handle = this.live.get(runId)?.handle ?? this.store.get(runId);
    if (action === "apply") applyProposal(handle, this.loaded.root, proposalId);
    else rejectProposal(handle, proposalId);
  }

  /** Waits for active runs to finish (used on shutdown and in tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map((l) => l.done));
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id);
  }
}
