import { useEffect, useState } from "react";
import type { RunRecord } from "../api";
import { ApiError, api, type PlanFile } from "../api";
import { ErrorNote, MarkdownPreview } from "../components";

type Flow = RunRecord["flows"][number];

/** Plan review: edit the Markdown, then approve, reject, or regenerate with feedback. */
export function PlanReview({ runId, flow, onDecided }: { runId: string; flow: Flow; onDecided: () => void }) {
  const [plan, setPlan] = useState<PlanFile>();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(true);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string }>();

  useEffect(() => {
    void api<PlanFile>(`/api/runs/${runId}/plans/${flow.id}`).then((p) => {
      setPlan(p);
      setDraft(p.content);
    });
  }, [runId, flow.id]);

  const dirty = plan !== undefined && draft !== plan.content;

  async function call(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onDecided();
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as ApiError).hint });
    } finally {
      setBusy(false);
    }
  }

  const save = async () => {
    const saved = await api<PlanFile>(`/api/runs/${runId}/plans/${flow.id}`, { method: "PUT", json: { content: draft } });
    setPlan(saved);
  };

  return (
    <section className="card review" aria-label={`Plan review: ${flow.name}`}>
      <div className="row spread">
        <h2>Review the plan: {flow.name}</h2>
        <span className="muted">{plan?.path}</span>
      </div>
      <p className="muted">Nothing is generated until you approve. Edit the plan if needed; DOMinion generates exactly what it describes.</p>
      {flow.coverage && flow.coverage.status !== "none" ? (
        <div className="note note-warn">
          Existing tests already {flow.coverage.status === "covered" ? "cover" : "partly cover"} this flow: {flow.coverage.tests.map((t) => `${t.file} › ${t.title}`).join("; ")}
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="link" onClick={() => setPreview((p) => !p)}>
          {preview ? "Edit Markdown" : "Show preview"}
        </button>
        {dirty ? <span className="muted">unsaved changes</span> : null}
      </div>
      {preview ? <MarkdownPreview source={draft} /> : <textarea aria-label="Plan Markdown" className="plan-editor" rows={24} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      <div className="row">
        <button type="button" disabled={busy || !dirty} onClick={() => void call(save)}>
          Save edits
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            void call(async () => {
              if (dirty) await save();
              await api(`/api/runs/${runId}/plans/${flow.id}/approve`, { method: "POST", json: {} });
            })
          }
        >
          Approve and generate
        </button>
      </div>
      <label>
        Feedback (required to regenerate, optional when rejecting)
        <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Also cover an invalid coupon" />
      </label>
      <div className="row">
        <button type="button" disabled={busy || !feedback.trim()} onClick={() => void call(() => api(`/api/runs/${runId}/plans/${flow.id}/regenerate`, { method: "POST", json: { feedback } }))}>
          Regenerate with feedback
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void call(() => api(`/api/runs/${runId}/plans/${flow.id}/reject`, { method: "POST", json: { feedback } }))}>
          Reject
        </button>
      </div>
      <ErrorNote error={error?.message} hint={error?.hint} />
    </section>
  );
}
