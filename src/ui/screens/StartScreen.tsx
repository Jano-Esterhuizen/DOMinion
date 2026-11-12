import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type PublicConfig, type RoleStatusResponse, type RunSummary, usePoll } from "../api";
import { AuthBadge, ErrorNote, formatUsd, StatusPill } from "../components";
import { Link, navigate } from "../router";

export function StartScreen({ config }: { config: PublicConfig }) {
  const environments = config.config.environments;
  const envNames = Object.keys(environments);
  const [env, setEnv] = useState(envNames[0]!);
  const roleNames = Object.keys(environments[env]?.roles ?? {});
  const defaultRole = roleNames.find((r) => environments[env]!.roles[r]!.strategy !== "none") ?? roleNames[0]!;
  const [role, setRole] = useState(defaultRole);
  const [mode, setMode] = useState<"task" | "crawl">("task");
  const [request, setRequest] = useState("");
  const [planOnly, setPlanOnly] = useState(false);
  const [status, setStatus] = useState<RoleStatusResponse>();
  const [error, setError] = useState<{ message: string; hint?: string }>();
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [specs, setSpecs] = useState<{ plans: Array<{ path: string; status: string; title?: string; env?: string }>; tests: string[] }>({ plans: [], tests: [] });
  const [planPath, setPlanPath] = useState("");

  useEffect(() => {
    if (!roleNames.includes(role)) setRole(defaultRole);
  }, [env]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadStatus = useCallback(
    async (validate = false) => {
      try {
        setStatus(await api<RoleStatusResponse>(`/api/envs/${env}/roles/${role}/status${validate ? "?validate=1" : ""}`));
      } catch (e) {
        setError({ message: (e as Error).message, hint: (e as ApiError).hint });
      }
    },
    [env, role],
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void api<{ runs: RunSummary[] }>("/api/runs").then((r) => setRuns(r.runs)).catch(() => undefined);
    void api<typeof specs>("/api/specs").then(setSpecs).catch(() => undefined);
  }, []);

  const loginActive = status?.login?.state === "running" || status?.login?.state === "waiting_for_user";
  const polled = usePoll<{ login: RoleStatusResponse["login"] }>(`/api/envs/${env}/roles/${role}/login`, 1000, loginActive);
  useEffect(() => {
    if (!polled?.login) return;
    // After a login finishes, check the saved session for real so the badge says "session valid".
    if (polled.login.state === "done") void loadStatus(true);
    else if (polled.login.state === "failed") void loadStatus();
    else setStatus((s) => (s ? { ...s, login: polled.login } : s));
  }, [polled, loadStatus]);

  const login = status?.login;
  const strategy = environments[env]?.roles[role]?.strategy ?? "none";
  const budget = config.config.budgets.maxUsdPerRun;

  async function startLogin() {
    setError(undefined);
    try {
      await api(`/api/envs/${env}/roles/${role}/login`, { method: "POST", json: { force: true } });
      await loadStatus();
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as ApiError).hint });
    }
  }

  async function loginDone() {
    await api(`/api/envs/${env}/roles/${role}/login/done`, { method: "POST", json: {} });
  }

  async function start(body: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ runId: string }>("/api/runs", { method: "POST", json: body });
      navigate(`/runs/${result.runId}`);
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as ApiError).hint });
    } finally {
      setBusy(false);
    }
  }

  const draftsAndApproved = useMemo(() => specs.plans.filter((p) => p.status !== "covered"), [specs]);

  return (
    <div className="stack">
      <section className="card">
        <h2>New run</h2>
        <div className="grid2">
          <label>
            Environment
            <select value={env} onChange={(e) => setEnv(e.target.value)}>
              {envNames.map((name) => (
                <option key={name} value={name}>
                  {name} ({environments[name]!.baseURL})
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roleNames.map((name) => (
                <option key={name} value={name}>
                  {name} ({environments[env]!.roles[name]!.strategy})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row" aria-label="Session status">
          {status ? <AuthBadge badge={status.badge} /> : <span className="muted">checking session…</span>}
          {status?.missingEnvVars.length ? <span className="muted">set {status.missingEnvVars.join(", ")} in .env.local</span> : null}
          {strategy !== "none" ? (
            <>
              <button type="button" onClick={() => void startLogin()} disabled={loginActive}>
                {loginActive ? "Logging in…" : "Log in"}
              </button>
              <button type="button" className="link" onClick={() => void loadStatus(true)}>
                Check session
              </button>
            </>
          ) : null}
        </div>
        {login?.state === "waiting_for_user" ? (
          <div className="note note-warn" role="status">
            <p>{login.message}</p>
            <button type="button" className="primary" onClick={() => void loginDone()}>
              Done, I have logged in
            </button>
          </div>
        ) : null}
        {login?.state === "failed" ? <ErrorNote error={login.error} hint={login.hint} /> : null}

        <fieldset className="segmented" aria-label="Mode">
          <label className={mode === "task" ? "active" : undefined}>
            <input type="radio" name="mode" checked={mode === "task"} onChange={() => setMode("task")} /> Task
          </label>
          <label className={mode === "crawl" ? "active" : undefined}>
            <input type="radio" name="mode" checked={mode === "crawl"} onChange={() => setMode("crawl")} /> Crawl
          </label>
        </fieldset>

        {mode === "task" ? (
          <label>
            What should DOMinion test?
            <textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="write tests for the add to cart workflow" />
          </label>
        ) : (
          <p className="muted">Crawl explores {environments[env]!.baseURL} (up to {config.config.crawl.maxPages} pages), proposes the critical flows, and plans the ones you select.</p>
        )}

        <label className="checkbox">
          <input type="checkbox" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} /> Stop after planning
        </label>
        <div className="row">
          <button type="button" className="primary" disabled={busy || (mode === "task" && !request.trim())} onClick={() => void start({ mode, env, role, request: request.trim(), planOnly })}>
            Start
          </button>
          <span className="muted">
            Budget cap {formatUsd(budget)} per run · model {config.config.model}
            {environments[env]!.allowDestructive ? " · destructive actions allowed" : " · stops before irreversible actions"}
          </span>
        </div>
        <ErrorNote error={error?.message} hint={error?.hint} />
      </section>

      <section className="card">
        <h2>From existing files</h2>
        <div className="row">
          <select aria-label="Plan" value={planPath} onChange={(e) => setPlanPath(e.target.value)}>
            <option value="">Choose a plan…</option>
            {draftsAndApproved.map((p) => (
              <option key={p.path} value={p.path}>
                {p.title ?? p.path} ({p.status})
              </option>
            ))}
          </select>
          <button type="button" disabled={!planPath || busy} onClick={() => void start({ mode: "generate", planPath })}>
            Generate tests
          </button>
          <button type="button" disabled={busy || !specs.tests.length} onClick={() => void start({ mode: "heal", env, role })}>
            Heal generated tests ({specs.tests.length})
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Recent runs</h2>
        {runs.length === 0 ? <p className="muted">No runs yet.</p> : null}
        <ul className="runs">
          {runs.slice(0, 15).map((r) => (
            <li key={r.id}>
              <Link to={`/runs/${r.id}`}>{r.id}</Link> <StatusPill status={r.status} /> <span className="muted">{r.mode}</span> {r.request ?? r.flows.map((f) => f.name).join(", ")}{" "}
              <span className="muted">{formatUsd(r.costUsd)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
