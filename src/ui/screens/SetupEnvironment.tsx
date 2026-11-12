import { useEffect, useMemo, useState } from "react";
import { api, type DetectedLoginForm, type EnvironmentSetup, type LoginFormSpec, type LoginState, type RoleSetup, type RoleStatusResponse, type SetupResponse, usePoll } from "../api";
import { AuthBadge, ErrorNote, useAction } from "../components";
import { SecretField, Step, sectionStatus } from "./setup-parts";

type Props = { setup: SetupResponse; env: EnvironmentSetup; multiple: boolean; refresh: () => Promise<void> };

const KIND_LABEL: Record<string, string> = { user: "username", pass: "password", totp: "TOTP secret", token: "token" };
const STRATEGY_LABEL: Record<string, string> = {
  form: "username and password",
  manual: "logs in by hand (SSO, MFA)",
  none: "guest, no login",
  api: "logs in through an API",
  existing: "your suite's own login setup",
};

function AppStep({ setup, env, multiple, refresh }: Props) {
  const initial = useMemo(
    () => ({
      baseURL: env.baseURL,
      loginUrl: env.loginUrl,
      validateUrl: env.validate?.url ?? "",
      loggedOutPattern: env.validate?.loggedOutPattern ?? "",
      testIdAttribute: setup.config?.testIdAttribute ?? "data-testid",
    }),
    [env.baseURL, env.loginUrl, env.validate?.url, env.validate?.loggedOutPattern, setup.config?.testIdAttribute],
  );
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  useEffect(() => setForm(initial), [initial]);
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setSaved(false);
    },
  });
  return (
    <Step id={`app-${env.name}`} title={`4. Your app${multiple ? ` (${env.name})` : ""}`} status={sectionStatus(setup, "app", env.name)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(`/api/setup/environments/${env.name}`, { method: "PUT", json: form });
            setSaved(true);
            await refresh();
          });
        }}
      >
        <div className="grid2">
          <label>
            Base URL
            <input type="text" {...field("baseURL")} />
          </label>
          <label>
            Login page
            <input type="text" {...field("loginUrl")} placeholder="/login" />
          </label>
          <label>
            A page only logged-in users can open
            <input type="text" {...field("validateUrl")} placeholder="/account" />
          </label>
          <label>
            Where logged-out users land
            <input type="text" {...field("loggedOutPattern")} placeholder="/login" />
          </label>
          <label>
            Test id attribute
            <input type="text" {...field("testIdAttribute")} placeholder="data-testid" />
          </label>
        </div>
        <p className="muted">DOMinion opens the logged-in page with the saved session; landing on the logged-out page means the session expired and it logs in again.</p>
        <div className="row">
          <button type="submit" disabled={action.busy}>
            Save app settings
          </button>
          {saved ? <span className="muted" role="status">Saved to {setup.config?.path}</span> : null}
        </div>
      </form>
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

function RoleCredentials({ env, role, removable, refresh }: { env: string; role: RoleSetup; removable: boolean; refresh: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
  return (
    <fieldset className="role" aria-label={`Role ${role.name}`}>
      <legend>
        <strong>{role.name}</strong> <span className="muted">{STRATEGY_LABEL[role.strategy] ?? role.strategy}</span>
      </legend>
      {role.envVars.length ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api("/api/setup/secrets", { method: "PUT", json: { values: filled } });
              setValues({});
              setSaved(true);
              await refresh();
            });
          }}
        >
          <div className="grid2">
            {role.envVars.map((v) => (
              <SecretField
                key={v.name}
                label={`${role.name} ${KIND_LABEL[v.kind] ?? v.kind}`}
                name={v.name}
                set={v.set}
                fromShell={v.fromShell}
                value={values[v.name] ?? ""}
                onChange={(value) => {
                  setValues((prev) => ({ ...prev, [v.name]: value }));
                  setSaved(false);
                }}
              />
            ))}
          </div>
          <div className="row">
            <button type="submit" disabled={action.busy || !Object.keys(filled).length}>
              Save {role.name} credentials
            </button>
            {saved ? <span className="muted" role="status">Saved to .env.local</span> : null}
          </div>
        </form>
      ) : (
        <p className="muted">
          {role.strategy === "none"
            ? "Nothing to store."
            : role.strategy === "manual"
              ? "You log in by hand in a browser DOMinion opens; nothing to store."
              : role.strategy === "existing"
                ? "Logs in with your suite's own setup project, using the credentials under “Your suite's credentials”."
                : "Logs in through the API login module named in dominion.config.ts."}
        </p>
      )}
      {removable ? (
        <button
          type="button"
          className="link"
          disabled={action.busy}
          onClick={() => {
            if (window.confirm(`Remove the "${role.name}" role from dominion.config.ts?`)) void action.run(async () => {
              await api(`/api/setup/environments/${env}/roles/${role.name}`, { method: "DELETE" });
              await refresh();
            });
          }}
        >
          Remove {role.name}
        </button>
      ) : null}
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </fieldset>
  );
}

function RolesStep({ setup, env, multiple, refresh }: Props) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<"form" | "manual" | "none">("form");
  const [totp, setTotp] = useState(false);
  const action = useAction();
  return (
    <Step id={`roles-${env.name}`} title={`5. Roles and credentials${multiple ? ` (${env.name})` : ""}`} status={sectionStatus(setup, "roles", env.name)}>
      <p className="muted">
        Use dedicated test accounts. Values are saved to <code>.env.local</code> (gitignored) and never shown again; DOMinion's agents never see them.
      </p>
      {env.roles.map((role) => (
        <RoleCredentials key={role.name} env={env.name} role={role} removable={env.roles.length > 1} refresh={refresh} />
      ))}
      <form
        className="row bottom"
        aria-label="Add a role"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(`/api/setup/environments/${env.name}/roles`, { method: "POST", json: { name, strategy, totp } });
            setName("");
            setTotp(false);
            await refresh();
          });
        }}
      >
        <label>
          New role name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="admin" />
        </label>
        <label>
          How it logs in
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
            <option value="form">Username and password</option>
            <option value="manual">By hand (SSO, push MFA)</option>
            <option value="none">Guest (no login)</option>
          </select>
        </label>
        {strategy === "form" ? (
          <label className="checkbox">
            <input type="checkbox" checked={totp} onChange={(e) => setTotp(e.target.checked)} /> Uses a one-time code
          </label>
        ) : null}
        <button type="submit" disabled={action.busy || !name.trim()}>
          Add role
        </button>
      </form>
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

type Locator = { by: string; value: string; attribute?: string };

function LocatorInput({ label, locator, kinds, onChange }: { label: string; locator: Locator; kinds: Array<[string, string]>; onChange: (l: Locator) => void }) {
  return (
    <div className="locator">
      <span>{label}</span>
      <select aria-label={`${label}: find by`} value={locator.by} onChange={(e) => onChange({ ...locator, by: e.target.value })}>
        {kinds.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      <input type="text" aria-label={`${label}: text`} value={locator.value} onChange={(e) => onChange({ ...locator, value: e.target.value })} />
    </div>
  );
}

const FIELD_KINDS: Array<[string, string]> = [
  ["label", "Label"],
  ["placeholder", "Placeholder"],
  ["testId", "Test id"],
];
const BUTTON_KINDS: Array<[string, string]> = [
  ["role", "Button text"],
  ["testId", "Test id"],
];

const EMPTY_SPEC: LoginFormSpec = { username: { by: "label", value: "" }, password: { by: "label", value: "" }, submit: { by: "role", value: "" } };

function LoginScriptStep({ setup, env, multiple, refresh }: Props) {
  // Roles that share a script share the builder; the first one is used for the API calls.
  const role = env.roles.find((r) => r.loginScript);
  const needsTotp = env.roles.some((r) => r.totp);
  const script = role?.loginScript;
  const attribute = setup.config?.testIdAttribute ?? "data-testid";
  const [spec, setSpec] = useState<LoginFormSpec>(script?.spec ?? EMPTY_SPEC);
  const [useTotp, setUseTotp] = useState(Boolean(script?.spec?.totp) || needsTotp);
  const [secondScreen, setSecondScreen] = useState(Boolean(script?.spec?.totp?.submit));
  const [notes, setNotes] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  if (!role || !script) return null;

  const totp = spec.totp ?? { field: { by: "label" as const, value: "" }, submit: { by: "role" as const, value: "" } };
  const withAttr = (l: Locator) => (l.by === "testId" ? { ...l, attribute: l.attribute ?? attribute } : { by: l.by, value: l.value });
  const update = (patch: Partial<LoginFormSpec>) => {
    setSpec((s) => ({ ...s, ...patch }));
    setSaved(false);
  };
  const toSave = (): LoginFormSpec => ({
    username: withAttr(spec.username) as LoginFormSpec["username"],
    password: withAttr(spec.password) as LoginFormSpec["password"],
    submit: withAttr(spec.submit) as LoginFormSpec["submit"],
    ...(useTotp ? { totp: { field: withAttr(totp.field) as LoginFormSpec["username"], ...(secondScreen && totp.submit ? { submit: withAttr(totp.submit) as LoginFormSpec["submit"] } : {}) } } : {}),
  });
  const base = `/api/setup/environments/${env.name}/roles/${role.name}/login-script`;
  const kindText: Record<string, string> = {
    missing: `${script.path} does not exist yet.`,
    template: `${script.path} is still the template from setup. It only works if your page uses Email / Password labels and a Sign in button.`,
    builder: `${script.path} was written by this builder.`,
    custom: `${script.path} was written or edited by hand.`,
  };

  return (
    <Step id={`login-script-${env.name}`} title={`6. Login script${multiple ? ` (${env.name})` : ""}`} status={sectionStatus(setup, "login-script", env.name)}>
      <p className="muted">
        DOMinion logs in with a small Playwright script that reads the credentials above, so agents never see a password. {kindText[script.kind]}
      </p>
      <div className="row">
        <button
          type="button"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const res = await api<DetectedLoginForm>(`${base}/detect`, { method: "POST", json: {} });
              if (res.spec) update({ username: res.spec.username, password: res.spec.password, submit: res.spec.submit });
              setNotes(res.spec ? [`Found the login form on ${res.url}. Check the fields, then save.`, ...res.notes] : res.notes);
            })
          }
        >
          {action.busy ? "Looking…" : "Detect from login page"}
        </button>
        <span className="muted">Opens {env.baseURL + env.loginUrl} in a browser without logging in, and reads the form.</span>
      </div>
      {notes.length ? (
        <ul className="notes" aria-label="Detection notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(base, { method: "PUT", json: { spec: toSave(), overwrite } });
            setSaved(true);
            setOverwrite(false);
            await refresh();
          });
        }}
      >
        <LocatorInput label="Username field" locator={spec.username} kinds={FIELD_KINDS} onChange={(l) => update({ username: l as LoginFormSpec["username"] })} />
        <LocatorInput label="Password field" locator={spec.password} kinds={FIELD_KINDS} onChange={(l) => update({ password: l as LoginFormSpec["password"] })} />
        <LocatorInput label="Sign-in button" locator={spec.submit} kinds={BUTTON_KINDS} onChange={(l) => update({ submit: l as LoginFormSpec["submit"] })} />
        <label className="checkbox">
          <input type="checkbox" checked={useTotp} onChange={(e) => setUseTotp(e.target.checked)} /> Asks for a one-time code (TOTP)
        </label>
        {useTotp ? (
          <>
            <LocatorInput label="Code field" locator={totp.field} kinds={FIELD_KINDS} onChange={(l) => update({ totp: { ...totp, field: l as LoginFormSpec["username"] } })} />
            <label className="checkbox">
              <input type="checkbox" checked={secondScreen} onChange={(e) => setSecondScreen(e.target.checked)} /> The code is asked on a second screen
            </label>
            {secondScreen ? (
              <LocatorInput label="Code button" locator={totp.submit ?? { by: "role", value: "" }} kinds={BUTTON_KINDS} onChange={(l) => update({ totp: { ...totp, submit: l as LoginFormSpec["submit"] } })} />
            ) : null}
          </>
        ) : null}
        {script.kind === "custom" ? (
          <label className="checkbox">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Replace my login script
          </label>
        ) : null}
        <div className="row">
          <button type="submit" disabled={action.busy || (script.kind === "custom" && !overwrite)}>
            Save login script
          </button>
          {saved ? <span className="muted" role="status">Saved {script.path}</span> : null}
        </div>
      </form>
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </Step>
  );
}

function RoleLogin({ env, role, refresh }: { env: string; role: RoleSetup; refresh: () => Promise<void> }) {
  const [login, setLogin] = useState<LoginState>(null);
  const [checked, setChecked] = useState<RoleStatusResponse>();
  const action = useAction();
  const active = login?.state === "running" || login?.state === "waiting_for_user";
  const polled = usePoll<{ login: LoginState }>(`/api/envs/${env}/roles/${role.name}/login`, 1000, active);

  useEffect(() => {
    if (!polled) return;
    setLogin(polled.login);
    if (polled.login?.state === "done") {
      void api<RoleStatusResponse>(`/api/envs/${env}/roles/${role.name}/status?validate=1`)
        .then(setChecked)
        .finally(() => void refresh());
    }
  }, [polled, env, role.name, refresh]);

  const manual = role.strategy === "manual";
  const template = role.strategy === "form" && role.loginScript?.kind === "template";
  return (
    <li className="role-login" aria-label={`Login ${role.name}`}>
      {template && login?.state !== "done" ? (
        <p className="note note-warn">
          The login script is still DOMinion's template, which looks for an “Email” field. Set it up in <a href={`#login-script-${env}`}>step 6</a> first (Detect from login page, then Save
          login script), unless your login page matches it.
        </p>
      ) : null}
      <div className="row">
        <strong>{role.name}</strong>
        <AuthBadge badge={checked?.badge ?? role.badge} />
        <button
          type="button"
          disabled={active || action.busy}
          onClick={() =>
            void action.run(async () => {
              setChecked(undefined);
              const res = await api<{ login: LoginState }>(`/api/envs/${env}/roles/${role.name}/login`, { method: "POST", json: { force: true } });
              setLogin(res.login);
            })
          }
        >
          {active ? "Logging in…" : manual ? "Log in" : "Test login"}
        </button>
      </div>
      {login?.state === "waiting_for_user" ? (
        <div className="note note-warn" role="status">
          <p>{login.message}</p>
          <button type="button" className="primary" onClick={() => void api(`/api/envs/${env}/roles/${role.name}/login/done`, { method: "POST", json: {} })}>
            Done, I have logged in
          </button>
        </div>
      ) : null}
      {login?.state === "failed" ? <ErrorNote error={login.error} hint={login.hint} /> : null}
      {login?.state === "done" && checked ? (
        <p className="muted" role="status">
          {checked.badge === "session-valid" ? "Logged in; the session works." : checked.badge === "session-unverified" ? "Logged in. Set the logged-in page in step 4 so DOMinion can check sessions." : `Logged in, but the check says: ${checked.detail ?? checked.badge}.`}
        </p>
      ) : null}
      <ErrorNote error={action.error?.message} hint={action.error?.hint} />
    </li>
  );
}

function TestLoginStep({ setup, env, multiple, refresh }: Props) {
  const roles = env.roles.filter((r) => r.strategy !== "none");
  if (!roles.length) return null;
  return (
    <Step id={`test-login-${env.name}`} title={`7. Test login${multiple ? ` (${env.name})` : ""}`} status={sectionStatus(setup, "test-login", env.name)}>
      <p className="muted">DOMinion runs the login script with the saved credentials and keeps the session in .auth/ (gitignored). One working login is enough to start; runs log the other roles in when they need them.</p>
      <ul className="role-logins">
        {roles.map((role) => (
          <RoleLogin key={role.name} env={env.name} role={role} refresh={refresh} />
        ))}
      </ul>
    </Step>
  );
}

/** Steps 4-7 for one environment: the app, roles and credentials, the login script, a test login. */
export function EnvironmentSteps(props: Props) {
  return (
    <>
      <AppStep {...props} />
      <RolesStep {...props} />
      <LoginScriptStep {...props} />
      <TestLoginStep {...props} />
    </>
  );
}
