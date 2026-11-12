import { useState } from "react";
import type { RunRecord } from "../api";
import { ApiError, api } from "../api";
import { ErrorNote, StatusPill } from "../components";

const COVERAGE_LABEL = { covered: "covered", partly: "partly covered", none: "not covered" } as const;

/** Flows screen (crawl mode): discovered flows as a checklist with the coverage gap view. */
export function FlowsPanel({ run, onDone }: { run: RunRecord; onDone: () => void }) {
  const flows = run.discoveredFlows ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(flows.filter((f) => f.priority === "critical" && f.coverage?.status !== "covered").map((f) => f.id)));
  const [error, setError] = useState<{ message: string; hint?: string }>();
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function planSelected() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/runs/${run.id}/flows/select`, { method: "POST", json: { flowIds: [...selected] } });
      onDone();
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as ApiError).hint });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Discovered flows">
      <h2>Discovered flows</h2>
      <p className="muted">
        Crawled {run.crawl?.pages ?? 0} pages ({run.crawl?.patterns ?? 0} page patterns). Select the flows to plan; each one gets its own plan to review.
      </p>
      <ul className="flows">
        {flows.map((flow) => (
          <li key={flow.id}>
            <label className="checkbox">
              <input type="checkbox" checked={selected.has(flow.id)} onChange={() => toggle(flow.id)} />
              <strong>{flow.name}</strong>
            </label>{" "}
            <StatusPill status={flow.priority === "critical" ? "failed" : flow.priority === "high" ? "awaiting_approval" : "skipped"} label={flow.priority} />{" "}
            {flow.destructive ? <StatusPill status="stopped" label="destructive" /> : null}{" "}
            <StatusPill status={flow.coverage?.status === "covered" ? "done" : flow.coverage?.status === "partly" ? "awaiting_approval" : "skipped"} label={COVERAGE_LABEL[flow.coverage?.status ?? "none"]} />
            <div className="muted">
              {flow.startUrl} — {flow.description}
            </div>
            {flow.coverage?.tests.length ? <div className="muted">existing tests: {flow.coverage.tests.map((t) => `${t.file} › ${t.title}`).join("; ")}</div> : null}
          </li>
        ))}
      </ul>
      <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={() => void planSelected()}>
        Plan selected ({selected.size})
      </button>
      <ErrorNote error={error?.message} hint={error?.hint} />
    </section>
  );
}
