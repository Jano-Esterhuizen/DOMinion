import { useEffect, useState } from "react";
import { api, type PublicConfig, type SetupJob, type SetupResponse, usePoll } from "../api";
import { ErrorNote, SetupPill, StatusPill, useAction } from "../components";
import { Link } from "../router";
import { EnvironmentSteps } from "./SetupEnvironment";
import { SecretField, Step, sectionStatus } from "./setup-parts";
import { Settings } from "./Settings";

function Checklist({ setup }: { setup: SetupResponse }) {
  const open = setup.items.filter((i) => i.status !== "done");
  return (
    <section className="card" aria-labelledby="checklist-title">
      <div className="row spread">
        <h2 id="checklist-title">Setup checklist</h2>
        {setup.ready ? <StatusPill status="done" label="ready" /> : <StatusPill status="todo" label={`${setup.remaining} left`} />}
      </div>
      {setup.ready ? (
        <p>
          Everything a run needs is in place. <Link to="/">Open Minion runner</Link>
          {open.length ? <span className="muted"> · {open.length} recommended item{open.length === 1 ? "" : "s"} below</span> : null}
        </p>
      ) : (
        <p className="muted">Work through the steps below. Minion runner unlocks when nothing is left to do.</p>
      )}
      <ul className="checklist" aria-label="Setup items">
        {setup.items.map((item) => (
          <li key={item.id} data-status={item.status}>
            <SetupPill status={item.status} /> <a href={`#${item.env ? `${item.section}-${item.env}` : item.section}`}>{item.title}</a>
            {item.detail ? <span className="muted"> · {item.detail}</span> : null}
          </li>
        ))}
        {setup.checks.map((check) => (
          <li key={check.id} data-status={check.status === "error" ? "todo" : "optional"}>
            <SetupPill status={check.status === "error" ? "todo" : "optional"} /> <a href="#checks">{check.title}</a>
            {check.detail ? <span className="muted"> · {check.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlaywrightStep({ setup, refresh }: { setup: SetupResponse; refresh: () => Promise<void> }) {
  const [lang, setLang] = useState<"ts" | "js">("ts");
  const latest = setup.jobs.playwright;
  const [jobId, setJobId] = useState<string | undefined>(latest?.state === "running" ? latest.id : undefined);
  const polled = usePoll<{ job: SetupJob }>(jobId ? `/api/setup/jobs/${jobId}` : undefined, 1000, Boolean(jobId));
  const job = polled?.job ?? latest;
  const action = useAction();

  useEffect(() => {
    if (polled?.job && polled.job.state !== "running") {
      setJobId(undefined);
      void refresh();
    }
  }, [polled, refresh]);

  const status = sectionStatus(setup, "playwright");
  const { configs, installed } = setup.playwright;
  return (
    <Step id="playwright" title="1. Playwright" status={status}>
      {configs.length && installed ? (
        <p>
          Found <code>{configs.join(", ")}</code> and <code>@playwright/test</code>. DOMinion runs the tests it writes with your Playwright.
        </p>
      ) : configs.length ? (
        <p>
          <code>{configs[0]}</code> exists but <code>@playwright/test</code> is not installed. Run <code>npm install -D @playwright/test</code> in {setup.root}, then refresh.
        </p>
      ) : !setup.packageJson ? (
        <ErrorNote error="This folder has no package.json." hint={`Run \`npm init -y\` in ${setup.root}, then reload this page.`} />
      ) : (
        <>
          <p>This project has no Playwright yet. DOMinion sets it up the way <code>npm init playwright@latest</code> does, with Chromium only.</p>
          <fieldset className="segmented" aria-label="Test language">
            <label className={lang === "ts" ? "active" : undefined}>
              <input type="radio" name="lang" checked={lang === "ts"} onChange={() => setLang("ts")} /> TypeScript
            </label>
            <label className={lang === "js" ? "active" : undefined}>
              <input type="radio" name="lang" checked={lang === "js"} onChange={() => setLang("js")} /> JavaScript
            </label>
          </fieldset>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={action.busy || Boolean(jobId)}
              onClick={() =>
                void action.run(async () => {
                  const res = await api<{ job: SetupJob }>("/api/setup/playwright", { method: "POST", json: { lang } });
                  setJobId(res.job.id);
                })
              }
            >
              {jobId ? "Setting up Playwright…" : "Set up Playwright"}
            </button>
            <span className="muted">Downloads Playwright and Chromium; takes a minute or two.</span>
          </div>
        </>
      )}
      {job && (jobId || job.state === "failed") ? (
        <>
          <pre className="joblog" aria-label="Playwright setup log">
            {job.log.join("\n")}
          </pre>
          {job.state === "failed" ? <ErrorNote error={job.error} hint={job.hint} /> : null}
        </>
      ) : null}
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

function ApiKeyStep({ setup, refresh }: { setup: SetupResponse; refresh: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  return (
    <Step id="api-key" title="2. Claude API key" status={sectionStatus(setup, "api-key")}>
      <p className="muted">
        DOMinion's agents plan, write and heal tests with Claude. The key is saved to <code>.env.local</code> (gitignored) and never shown again; in CI, set it as a secret instead.
      </p>
      {setup.apiKey.fromShell ? <p className="muted">Your shell already sets {setup.apiKey.credential}; that value wins over .env.local.</p> : null}
      <form
        className="row bottom"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api("/api/setup/secrets", { method: "PUT", json: { values: { ANTHROPIC_API_KEY: value.trim() } } });
            setValue("");
            setSaved(true);
            await refresh();
          });
        }}
      >
        <SecretField label="API key" name="ANTHROPIC_API_KEY" set={setup.apiKey.inFile || setup.apiKey.fromShell} fromShell={setup.apiKey.fromShell} value={value} onChange={(v) => { setValue(v); setSaved(false); }} />
        <button type="submit" disabled={action.busy || !value.trim()}>
          Save key
        </button>
        {saved ? <span className="muted" role="status">Saved to .env.local</span> : null}
      </form>
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

interface InitResponse {
  mode: "new" | "existing";
  files: Array<{ path: string; status: string; detail?: string }>;
  warnings: string[];
}

function ProjectStep({ setup, refresh }: { setup: SetupResponse; refresh: () => Promise<void> }) {
  const detection = setup.detection;
  const [baseURL, setBaseURL] = useState(detection?.suggestedBaseURL ?? "http://localhost:3000");
  const [touched, setTouched] = useState(false);
  const [envName, setEnvName] = useState("staging");
  const [ignoreOverlap, setIgnoreOverlap] = useState(true);
  const [analyze, setAnalyze] = useState(true);
  const [result, setResult] = useState<InitResponse>();
  const action = useAction();

  useEffect(() => {
    if (!touched && detection?.suggestedBaseURL) setBaseURL(detection.suggestedBaseURL);
  }, [detection?.suggestedBaseURL, touched]);

  const playwrightReady = setup.playwright.configs.length > 0 && setup.playwright.installed;
  return (
    <Step id="project" title="3. DOMinion project" status={sectionStatus(setup, "project")}>
      {setup.config?.error ? (
        <>
          <ErrorNote error={setup.config.error.message} hint={setup.config.error.hint} />
          <p className="muted">Fix {setup.config.path} in your editor, then refresh.</p>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </>
      ) : setup.config ? (
        <p>
          <code>{setup.config.path}</code> is set up ({setup.config.mode === "existing" ? "following your existing suite's layout" : "new setup"}). Commit it; it names env vars but holds no secrets.
        </p>
      ) : !playwrightReady ? (
        <p className="muted">Set up Playwright first (step 1).</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              setResult(await api<InitResponse>("/api/setup/init", { method: "POST", json: { baseURL, envName, playwrightConfig: detection?.playwrightConfig, ignoreOverlap, analyze } }));
              await refresh();
            });
          }}
        >
          {detection?.mode === "existing" ? (
            <>
              <p>
                DOMinion found an existing Playwright suite. Generated tests will follow its layout, fixtures, page objects and login setup, and it will never edit your hand-written files:
              </p>
              <pre className="config" aria-label="Detected project layout">
                {detection.profileSource}
              </pre>
              {detection.notes.map((note) => (
                <p key={note} className="muted">
                  {note}
                </p>
              ))}
              {detection.secretEnv.length ? (
                <p className="muted">
                  Your suite reads {detection.secretEnv.join(", ")}: DOMinion will treat them as secrets (redacted, hidden from its agents).
                </p>
              ) : null}
              <label className="checkbox">
                <input type="checkbox" checked={analyze && setup.apiKey.set} disabled={!setup.apiKey.set} onChange={(e) => setAnalyze(e.target.checked)} /> Summarize the suite's conventions with Claude (up to $0.50){setup.apiKey.set ? "" : " (needs the API key)"}
              </label>
            </>
          ) : (
            <>
              <p>DOMinion will create <code>dominion.config.ts</code>, a login script template, <code>.env.local</code> for credentials, and folders for plans and tests.</p>
              <label className="checkbox">
                <input type="checkbox" checked={ignoreOverlap} onChange={(e) => setIgnoreOverlap(e.target.checked)} /> Keep your other Playwright projects from running DOMinion's tests (recommended; they would run without DOMinion's login)
              </label>
            </>
          )}
          <div className="grid2">
            <label>
              App base URL
              <input type="text" value={baseURL} onChange={(e) => { setBaseURL(e.target.value); setTouched(true); }} placeholder="http://localhost:3000" />
            </label>
            <label>
              Environment name
              <input type="text" value={envName} onChange={(e) => setEnvName(e.target.value)} />
            </label>
          </div>
          <p className="muted">Only use DOMinion on apps you own or are authorized to test, ideally a non-production environment with dedicated test accounts.</p>
          <button type="submit" className="primary" disabled={action.busy || !baseURL.trim()}>
            {action.busy ? "Creating…" : "Create DOMinion setup"}
          </button>
        </form>
      )}
      {result ? (
        <ul className="files" aria-label="Created files">
          {result.files.map((f) => (
            <li key={f.path}>
              <span className="muted">{f.status}</span> <code>{f.path}</code> {f.detail ? <span className="muted">{f.detail}</span> : null}
            </li>
          ))}
          {result.warnings.map((w) => (
            <li key={w} className="tone-warn">
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

/** Existing suites: the credentials their own setup project reads (secretEnv). */
function SecretEnvStep({ setup, refresh }: { setup: SetupResponse; refresh: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const action = useAction();
  if (!setup.secretEnv.length) return null;
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  return (
    <Step id="secret-env" title="Your suite's credentials" status={sectionStatus(setup, "secret-env")}>
      <p className="muted">Your Playwright setup reads these to log in. Saved to .env.local, redacted from everything DOMinion writes, and hidden from its agents.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api("/api/setup/secrets", { method: "PUT", json: { values: filled } });
            setValues({});
            await refresh();
          });
        }}
      >
        <div className="grid2">
          {setup.secretEnv.map((v) => (
            <SecretField key={v.name} label={v.name} name={v.name} set={v.set} fromShell={v.fromShell} value={values[v.name] ?? ""} onChange={(value) => setValues((prev) => ({ ...prev, [v.name]: value }))} />
          ))}
        </div>
        <button type="submit" disabled={action.busy || !Object.keys(filled).length}>
          Save
        </button>
      </form>
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

function OtherChecks({ setup }: { setup: SetupResponse }) {
  if (!setup.checks.length) return null;
  return (
    <Step id="checks" title="Other checks" status={setup.checks.some((c) => c.status === "error") ? "todo" : "optional"}>
      <ul className="checklist">
        {setup.checks.map((check) => (
          <li key={check.id}>
            <SetupPill status={check.status === "error" ? "todo" : "optional"} /> <strong>{check.title}</strong> {check.detail}
            {check.hint ? <div className="muted">{check.hint}</div> : null}
          </li>
        ))}
      </ul>
    </Step>
  );
}

/** The Setup tab: everything `init` and its next steps do, as a checklist that ends in Minion runner. */
export function SetupScreen({ setup, config, refresh }: { setup: SetupResponse; config?: PublicConfig; refresh: () => Promise<void> }) {
  const configured = Boolean(setup.config && !setup.config.error);
  return (
    <div className="stack">
      <Checklist setup={setup} />
      <PlaywrightStep setup={setup} refresh={refresh} />
      <ApiKeyStep setup={setup} refresh={refresh} />
      <ProjectStep setup={setup} refresh={refresh} />
      {configured
        ? setup.environments.map((env) => <EnvironmentSteps key={env.name} setup={setup} env={env} multiple={setup.environments.length > 1} refresh={refresh} />)
        : null}
      {configured ? <SecretEnvStep setup={setup} refresh={refresh} /> : null}
      <OtherChecks setup={setup} />
      {configured && config ? <Settings config={config} /> : null}
    </div>
  );
}
