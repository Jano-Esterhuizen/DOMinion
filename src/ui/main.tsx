import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type PublicConfig } from "./api";
import { ErrorNote } from "./components";
import { Link, usePath } from "./router";
import { RunScreen } from "./screens/RunScreen";
import { Settings } from "./screens/Settings";
import { StartScreen } from "./screens/StartScreen";
import "./styles.css";

function App() {
  const path = usePath();
  const [config, setConfig] = useState<PublicConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<PublicConfig>("/api/config")
      .then(setConfig)
      .catch((e: Error) => setError(e.message));
  }, []);

  const runMatch = /^\/runs\/([\w-]+)/.exec(path);
  let screen;
  if (error) screen = <ErrorNote error={error} hint="Open the link printed by `npx dominion ui` (it carries the access token)." />;
  else if (!config) screen = <p className="muted">Loading…</p>;
  else if (runMatch) screen = <RunScreen runId={runMatch[1]!} />;
  else if (path === "/settings") screen = <Settings config={config} />;
  else screen = <StartScreen config={config} />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          DOMinion
        </Link>
        <nav aria-label="Main">
          <Link to="/">Start</Link>
          <Link to="/settings">Settings</Link>
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
