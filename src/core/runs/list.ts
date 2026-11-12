import type { LoadedConfig } from "../config/loader";
import { projectPaths } from "../config/resolve";
import { type RunStage, TERMINAL_STAGES, type TestStatus } from "../events";
import { RunStore } from "../orchestrator/store";
import type { RunMode, RunRecord } from "../orchestrator/types";
import { redactorFor } from "../redact";

/** One line of `dominion runs`: what a run did, what it cost and how its tests ended. */
export interface RunSummary {
  id: string;
  mode: RunMode;
  env: string;
  role: string;
  status: RunStage;
  /** True while the run is not done, failed or stopped (or its process died mid-run). */
  active: boolean;
  request?: string;
  model: string;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  costUsd: number;
  budgetUsd: number;
  flows: number;
  specFiles: string[];
  tests: Partial<Record<TestStatus, number>>;
  error?: { message: string; code?: string };
}

export interface ListRunsOptions {
  /** Newest first; at most this many (default: all). */
  limit?: number;
  env?: string;
  status?: RunStage;
}

export function summarizeRun(record: RunRecord): RunSummary {
  const tests: Partial<Record<TestStatus, number>> = {};
  for (const flow of record.flows) {
    for (const result of flow.results ?? []) tests[result.status] = (tests[result.status] ?? 0) + 1;
  }
  const finished = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
  const started = Date.parse(record.createdAt);
  return {
    id: record.id,
    mode: record.mode,
    env: record.env,
    role: record.role,
    status: record.status,
    active: !TERMINAL_STAGES.has(record.status),
    request: record.request,
    model: record.model,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
    durationMs: Number.isFinite(finished) && Number.isFinite(started) ? Math.max(finished - started, 0) : undefined,
    costUsd: record.costUsd,
    budgetUsd: record.budgetUsd,
    flows: record.flows.length,
    specFiles: [...new Set(record.flows.flatMap((f) => f.specFiles))],
    tests,
    error: record.error ? { message: record.error.message, code: record.error.code } : undefined,
  };
}

/** Past runs from .dominion/runs, newest first (spec: `dominion runs`). Unreadable runs are skipped. */
export function listRuns(loaded: LoadedConfig, options: ListRunsOptions = {}): RunSummary[] {
  const store = new RunStore(projectPaths(loaded), redactorFor(loaded));
  let records = store.list();
  if (options.env) records = records.filter((r) => r.env === options.env);
  if (options.status) records = records.filter((r) => r.status === options.status);
  if (options.limit !== undefined) records = records.slice(0, options.limit);
  // Run files are redacted when written; redact again in case secrets changed since.
  return records.map((r) => store.redactor.redactDeep(summarizeRun(r)));
}
