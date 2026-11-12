import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type PublicConfig, type SetupResponse } from "./api";
import { ErrorNote } from "./components";
import { Link, navigate, usePath } from "./router";
import { RunScreen } from "./screens/RunScreen";
import { SetupScreen } from "./screens/Setup";
import { StartScreen } from "./screens/StartScreen";
import "./styles.css";

/** Minion runner before setup is finished: say what is left instead of a half-working screen. */
function Locked({ setup }: { setup: SetupResponse }) {
  return (
    <section className="card" aria-labelledby="locked-title">
      <h2 id="locked-title">Minion runner</h2>
      <p>
        Minion runner unlocks when setup is done: {setup.remaining} item{setup.remaining === 1 ? "" : "s"} left. <Link to="/setup">Go to Setup</Link>
      </p>
    </section>
  );
}

function App() {
  const path = usePath();
  const [setup, setSetup] = useState<SetupResponse>();
  const [config, setConfig] = useState<PublicConfig>();
  const [error, setError] = useState<{ message: string; hint?: string }>();
  const landed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api<SetupResponse>("/api/setup");
      setSetup(next);
      setConfig(next.config && !next.config.error ? await api<PublicConfig>("/api/config") : undefined);
      setError(undefined);
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as { hint?: string }).hint });
    }
  }, []);

  const onSetup = path === "/setup" || path === "/settings";
  // Re-read on every tab switch: the other tab (or the terminal) may have changed things.
  useEffect(() => {
    void refresh();
  }, [refresh, onSetup]);

  // First visit with setup unfinished: start on the Setup tab.
  useEffect(() => {
    if (!setup || landed.current) return;
    landed.current = true;
    if (!setup.ready && path === "/") navigate("/setup");
  }, [setup, path]);

  const runMatch = /^\/runs\/([\w-]+)/.exec(path);
  let screen;
  if (error && !setup) screen = <ErrorNote error={error.message} hint={error.hint ?? "Open the link printed by `npx dominion ui` (it carries the access token)."} />;
  else if (!setup) screen = <p className="muted">Loading…</p>;
  else if (onSetup) screen = <SetupScreen setup={setup} config={config} refresh={refresh} />;
  else if (!config) screen = <Locked setup={setup} />;
  else if (runMatch) screen = <RunScreen runId={runMatch[1]!} />;
  else screen = <StartScreen config={config} setup={setup} onSetupChanged={refresh} />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          DOMinion
        </Link>
        <nav aria-label="Main" className="tabs">
          <Link to="/setup" current={onSetup}>
            Setup
            {setup && !setup.ready ? (
              <span className="count" aria-label={`${setup.remaining} left`}>
                {setup.remaining}
              </span>
            ) : null}
          </Link>
          <Link to="/" current={!onSetup}>
            Minion runner
          </Link>
        </nav>
      </header>
      <main>{screen}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
