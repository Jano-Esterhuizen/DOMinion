import type { PublicConfig } from "../api";

/** Read-only settings: the loaded config and which env vars are set (never their values). */
export function Settings({ config }: { config: PublicConfig }) {
  return (
    <div className="stack">
      <section className="card">
        <h2>Settings</h2>
        <p className="muted">
          Read-only. Edit {config.configPath} to change anything. DOMinion {config.version}.
        </p>
        <dl className="facts">
          <dt>Project root</dt>
          <dd>{config.root}</dd>
          <dt>Claude API credential</dt>
          <dd>{config.apiCredential ? `${config.apiCredential} is set` : "not set: add ANTHROPIC_API_KEY to .env.local"}</dd>
        </dl>
        <h3>Environment variables</h3>
        <table className="results">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {config.envVars.map((v) => (
              <tr key={v.name}>
                <td>
                  <code>{v.name}</code>
                </td>
                <td>{v.set ? <span className="pill pill-good">set</span> : <span className="pill pill-bad">missing</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Loaded config</h3>
        <pre className="config">{JSON.stringify(config.config, null, 2)}</pre>
      </section>
    </div>
  );
}
