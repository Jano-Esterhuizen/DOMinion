/**
 * Typed run events shared by the CLI and the server. Every event is redacted, appended to
 * .dominion/runs/<runId>/events.jsonl and broadcast to subscribers (the WebSocket in the UI).
 */

export type RunStage =
  | "created"
  | "crawling"
  | "discovering"
  | "awaiting_flow_selection"
  | "planning"
  | "awaiting_approval"
  | "generating"
  | "running"
  | "healing"
  | "done"
  | "failed"
  | "stopped";

export const TERMINAL_STAGES: ReadonlySet<RunStage> = new Set(["done", "failed", "stopped"]);

export type AgentName = "planner" | "generator" | "healer" | "discovery" | "analysis" | "login";

export type TestStatus = "passed" | "failed" | "skipped" | "fixme" | "timedOut" | "interrupted";

export type DominionEventPayload =
  | { type: "run.created"; mode: "task" | "crawl"; env: string; role: string; request?: string; model: string }
  | { type: "run.stage_changed"; stage: RunStage; flowId?: string; message?: string }
  | { type: "run.error"; message: string; hint?: string; code?: string; flowId?: string }
  | { type: "run.paused"; reason: string; flowId?: string }
  | { type: "run.finished"; status: "done" | "failed" | "stopped"; summary: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; flowId?: string }
  | { type: "session.ready"; role: string; action: string; state?: string }
  | { type: "agent.started"; agent: AgentName; model: string; flowId?: string }
  | { type: "agent.message"; agent: AgentName; text: string; flowId?: string }
  | { type: "agent.tool_call"; agent: AgentName; tool: string; summary: string; toolUseId: string; flowId?: string }
  | {
      type: "agent.tool_result";
      agent: AgentName;
      tool: string;
      ok: boolean;
      summary?: string;
      /** Playwright code the browser tool actually ran ("verified locator ..."). */
      code?: string;
      toolUseId: string;
      flowId?: string;
    }
  | { type: "agent.denied"; agent: AgentName; tool: string; reason: string; flowId?: string }
  | { type: "agent.finished"; agent: AgentName; ok: boolean; turns: number; costUsd: number; subtype: string; flowId?: string }
  | { type: "browser.screenshot"; path: string; flowId?: string }
  | { type: "crawl.page"; url: string; pattern: string; status: number; depth: number }
  | { type: "crawl.finished"; pages: number; patterns: number; stoppedReason?: string }
  | { type: "flows.discovered"; flows: Array<{ id: string; name: string; priority: string }> }
  | { type: "flows.selected"; flowIds: string[] }
  | { type: "plan.ready"; flowId: string; planPath: string }
  | { type: "plan.approved"; flowId: string; planPath: string }
  | { type: "plan.rejected"; flowId: string; planPath: string; feedback?: string }
  | { type: "files.changed"; flowId?: string; files: Array<{ path: string; kind: "added" | "modified" }> }
  | { type: "lint.result"; file: string; errors: string[]; warnings: string[]; flowId?: string }
  | {
      type: "test.result";
      file: string;
      title: string;
      status: TestStatus;
      durationMs: number;
      error?: string;
      tracePath?: string;
      flowId?: string;
    }
  | { type: "heal.attempt"; file: string; title: string; attempt: number; max: number; flowId?: string }
  | { type: "heal.result"; file: string; title: string; outcome: "fixed" | "fixme" | "failed"; reason?: string; flowId?: string }
  | { type: "cost.updated"; totalUsd: number; deltaUsd: number; budgetUsd: number; agent?: AgentName };

export type DominionEventType = DominionEventPayload["type"];

export type DominionEvent = DominionEventPayload & {
  /** 1-based position in events.jsonl. */
  seq: number;
  ts: string;
  runId: string;
};

export type EventListener = (event: DominionEvent) => void;

/** Minimal synchronous pub/sub; listener errors never break the run. */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: DominionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (for example a closed WebSocket) must not stop the run.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
