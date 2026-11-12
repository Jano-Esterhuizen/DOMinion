import { useMemo, useState } from "react";
import type { DominionEvent } from "../api";
import { ApiError, api, useRun } from "../api";
import { ErrorNote, formatUsd, StatusPill, Timeline } from "../components";
import { Link } from "../router";
import { FlowsPanel } from "./FlowsPanel";
import { PlanReview } from "./PlanReview";
import { Results } from "./Results";

const TERMINAL = new Set(["done", "failed", "stopped"]);

function describe(event: DominionEvent): { text: string; tone?: string } | undefined {
  switch (event.type) {
    case "run.stage_changed":
      return TERMINAL.has(event.stage) ? undefined : { text: `▸ ${event.stage.replace(/_/g, " ")}${event.flowId ? ` (${event.flowId})` : ""}`, tone: "stage" };
    case "session.ready":
      return { text: `session for ${event.role}: ${event.action}${event.state ? ` (${event.state})` : ""}` };
    case "agent.started":
      return { text: `${event.agent} started`, tone: "muted" };
    case "agent.tool_call":
      return /^(Read|Glob|Grep)$/.test(event.tool) ? undefined : { text: `${event.agent}: ${event.summary}` };
    case "agent.tool_result":
      if (!event.ok) return { text: `  ✗ ${event.summary ?? "failed"}`, tone: "warn" };
      return event.summary?.startsWith("verified") || event.summary?.startsWith("navigated") ? { text: `  ✓ ${event.summary}`, tone: "good" } : undefined;
    case "agent.denied":
      return { text: `  blocked ${event.tool}: ${event.reason.split("\n")[0]}`, tone: "warn" };
    case "agent.finished":
      return { text: `${event.agent} finished: ${event.subtype}, ${event.turns} turns, ${formatUsd(event.costUsd)}`, tone: "muted" };
    case "plan.ready":
      return { text: `plan ready: ${event.planPath}`, tone: "good" };
    case "plan.approved":
      return { text: `plan approved: ${event.planPath}`, tone: "good" };
    case "plan.rejected":
      return { text: `plan rejected${event.feedback ? `: ${event.feedback}` : ""}`, tone: "warn" };
    case "files.changed":
      return { text: `files: ${event.files.map((f) => `${f.kind} ${f.path}`).join(", ")}` };
    case "lint.result":
      return event.errors.length || event.warnings.length ? { text: `lint ${event.file}: ${[...event.errors, ...event.warnings].length} issue(s)`, tone: event.errors.length ? "bad" : "warn" } : undefined;
    case "test.result":
      return { text: `${event.status}: ${event.title}${event.error && event.status !== "passed" ? ` (${event.error.split("\n")[0]})` : ""}`, tone: event.status === "passed" ? "good" : event.status === "fixme" ? "warn" : "bad" };
    case "heal.attempt":
      return { text: `healing ${event.title} (attempt ${event.attempt}/${event.max})` };
    case "heal.result":
      return { text: `heal ${event.outcome}: ${event.title}${event.reason ? ` (${event.reason})` : ""}`, tone: event.outcome === "fixed" ? "good" : "warn" };
    case "crawl.page":
      return { text: `crawled ${event.pattern} (${event.status})`, tone: "muted" };
    case "crawl.finished":
      return { text: `crawl finished: ${event.pages} pages, ${event.patterns} patterns${event.stoppedReason ? ` (stopped: ${event.stoppedReason})` : ""}` };
    case "flows.discovered":
      return { text: `discovered ${event.flows.length} flows`, tone: "good" };
    case "run.error":
      return { text: `error: ${event.message}${event.hint ? ` — ${event.hint.split("\n")[0]}` : ""}`, tone: "bad" };
    case "run.paused":
      return { text: `paused: ${event.reason}`, tone: "warn" };
    case "run.finished":
      return { text: `run ${event.status}: ${event.summary}`, tone: event.status === "done" ? "good" : "warn" };
    case "log":
      return { text: event.message, tone: event.level === "info" ? "muted" : event.level === "warn" ? "warn" : "bad" };
    default:
      return undefined;
  }
}

export function RunScreen({ runId }: { runId: string }) {
  const { run, live, events, error, connected, refresh } = useRun(runId);
  const [actionError, setActionError] = useState<{ message: string; hint?: string }>();

  const reached = useMemo(() => new Set(events.filter((e) => e.type === "run.stage_changed").map((e) => (e as { stage: string }).stage)), [events]);
  const screenshot = useMemo(() => [...events].reverse().find((e) => e.type === "browser.screenshot") as { path: string } | undefined, [events]);
  const log = useMemo(() => events.map((e) => ({ seq: e.seq, ...describe(e) })).filter((l) => l.text), [events]);

  if (error && !run) return <ErrorNote error={error} hint="Go back to the start screen to see all runs." />;
  if (!run) return <p className="muted">Loading run…</p>;

  const finished = TERMINAL.has(run.status);
  const reviewing = live ? run.flows.filter((f) => f.status === "awaiting_approval") : [];
  const hasResults = run.flows.some((f) => f.results?.length) || run.changedFiles.length > 0 || finished;

  async function act(path: string) {
    setActionError(undefined);
    try {
      await api(path, { method: "POST", json: {} });
      await refresh();
    } catch (e) {
      setActionError({ message: (e as Error).message, hint: (e as ApiError).hint });
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <div>
            <h2>
              Run {run.id} <StatusPill status={run.status} />
            </h2>
            <p className="muted">
              {run.mode} · {run.env}/{run.role} · {run.model}
              {run.request ? ` · “${run.request}”` : ""}
            </p>
          </div>
          <div className="row">
            <span className="cost" aria-label="Cost">
              {formatUsd(run.costUsd)} / {formatUsd(run.budgetUsd)}
            </span>
            {live && !finished ? (
              <button type="button" className="danger" onClick={() => void act(`/api/runs/${run.id}/stop`)}>
                Stop
              </button>
            ) : null}
          </div>
        </div>
        <Timeline mode={run.mode} reached={reached} current={run.status} finished={finished} />
        {!live && !finished ? <div className="note note-warn">This run is no longer active (the server restarted). Its plan and artifacts are kept; start a new run or generate from its plan.</div> : null}
        {run.pause && live ? (
          <div className="note note-warn" role="status">
            <p>{run.pause.reason}</p>
            <button type="button" className="primary" onClick={() => void act(`/api/runs/${run.id}/continue`)}>
              Continue
            </button>
          </div>
        ) : null}
        {run.error ? <ErrorNote error={run.error.message} hint={run.error.hint} /> : null}
        <ErrorNote error={actionError?.message} hint={actionError?.hint} />
      </section>

      {run.status === "awaiting_flow_selection" && live ? <FlowsPanel run={run} onDone={refresh} /> : null}

      {reviewing.map((flow) => (
        <PlanReview key={flow.id} runId={run.id} flow={flow} onDecided={refresh} />
      ))}

      <div className="split">
        <section className="card log-card">
          <div className="row spread">
            <h3>Activity</h3>
            <span className="muted">{connected ? "live" : finished ? "finished" : "reconnecting…"}</span>
          </div>
          <ol className="log" aria-label="Run log">
            {log.map((line) => (
              <li key={line.seq} className={line.tone ? `tone-${line.tone}` : undefined}>
                {line.text}
              </li>
            ))}
          </ol>
        </section>
        <section className="card shot-card">
          <h3>Browser</h3>
          {screenshot ? <img alt="Latest browser screenshot" src={`/api/files?path=${encodeURIComponent(screenshot.path)}`} /> : <p className="muted">Screenshots appear here when an agent takes one.</p>}
          <p className="muted">
            Flows:{" "}
            {run.flows.map((f) => (
              <span key={f.id} className="flow-chip">
                {f.name} <StatusPill status={f.status} />
              </span>
            ))}
          </p>
        </section>
      </div>

      {hasResults ? <Results run={run} live={live} /> : null}
      <p>
        <Link to="/">← Start screen</Link>
      </p>
    </div>
  );
}
