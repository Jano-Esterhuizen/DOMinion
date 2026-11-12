import { useEffect, useState } from "react";
import { api, type PlaywrightUiStatus, usePoll } from "../api";
import { ErrorNote, useAction } from "../components";
import { Link } from "../router";

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The Playwright UI tab: opens Playwright's UI mode for the project in its own window. */
export function PlaywrightUiScreen() {
  const [status, setStatus] = useState<PlaywrightUiStatus>();
  const [loadError, setLoadError] = useState<{ message: string; hint?: string }>();
  const action = useAction();
  // While it is open, notice when the window is closed.
  const polled = usePoll<PlaywrightUiStatus>("/api/playwright-ui", 1500, Boolean(status?.running));

  useEffect(() => {
    api<PlaywrightUiStatus>("/api/playwright-ui")
      .then(setStatus)
      .catch((e: unknown) => setLoadError({ message: (e as Error).message, hint: (e as { hint?: string }).hint }));
  }, []);
  useEffect(() => {
    if (polled) setStatus(polled);
  }, [polled]);

  const call = (method: "POST" | "DELETE") =>
    void action.run(async () => {
      setStatus(await api<PlaywrightUiStatus>("/api/playwright-ui", { method }));
    });

  return (
    <section className="card" aria-labelledby="pw-ui-title">
      <h2 id="pw-ui-title">Playwright UI</h2>
      <p>
        See and run every test in this project in Playwright's UI mode: your own tests and the ones DOMinion generated, with watch mode, traces and the locator picker. It opens in its own
        window.
      </p>
      {loadError ? <ErrorNote error={loadError.message} hint={loadError.hint} /> : null}
      {!status ? (
        loadError ? null : <p className="muted">Loading…</p>
      ) : !status.available ? (
        <p>
          {status.reason} <Link to="/setup">Go to Setup</Link>
        </p>
      ) : (
        <>
          <p className="muted">
            Same as running <code>{status.command}</code> in the project folder.
          </p>
          {status.dominionProjects.length ? (
            <p className="muted">
              DOMinion's tests run in {status.dominionProjects.map((p, i) => <span key={p}>{i ? ", " : ""}<code>{p}</code></span>)}, which log in first. If you don't see them in the list, turn that
              project on in the Playwright UI's filter.
            </p>
          ) : null}
          <div className="row">
            {status.running ? (
              <>
                <span role="status">Open in its own window since {status.startedAt ? time(status.startedAt) : "just now"}. Closing that window stops it.</span>
                <button type="button" disabled={action.busy} onClick={() => call("DELETE")}>
                  Close Playwright UI
                </button>
              </>
            ) : (
              <button type="button" className="primary" disabled={action.busy} onClick={() => call("POST")}>
                {action.busy ? "Opening…" : "Open Playwright UI"}
              </button>
            )}
          </div>
          {status.last?.error ? <ErrorNote error={status.last.error} hint={status.last.hint} /> : null}
          {status.log.length && (status.running || status.last?.error) ? (
            <pre className="joblog" aria-label="Playwright UI output">
              {status.log.join("\n")}
            </pre>
          ) : null}
        </>
      )}
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </section>
  );
}
