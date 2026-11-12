import { Node, type StringLiteral } from "ts-morph";
import type { LoadedConfig } from "../config/loader";
import { getEnvironment } from "../config/resolve";
import { DominionError } from "../errors";
import { envPrefix, normalizeBaseURL } from "../init";
import { editConfig, propertyName } from "./config-edit";

/** Fields of an environment the Setup tab can change. Omitted fields are left as they are. */
export interface EnvironmentUpdate {
  baseURL?: string;
  loginUrl?: string;
  /** A page only logged-in users can open. Empty (with loggedOutPattern empty) turns checks off. */
  validateUrl?: string;
  /** Where logged-out users are sent, for example "/login". */
  loggedOutPattern?: string;
  testIdAttribute?: string;
  allowDestructive?: boolean;
}

export async function updateEnvironment(loaded: LoadedConfig, envName: string, update: EnvironmentUpdate): Promise<LoadedConfig> {
  const resolved = getEnvironment(loaded, envName);
  const raw = loaded.config.environments[envName]!;
  const path = ["environments", envName];
  const baseURL = update.baseURL !== undefined ? normalizeBaseURL(update.baseURL) : undefined;
  if (baseURL && !/^https?:\/\//.test(baseURL)) {
    throw new DominionError(`"${update.baseURL}" is not an http(s) URL.`, { code: "SETUP_BAD_URL", hint: "For example http://localhost:3000 or https://staging.example.com" });
  }
  const validateUrl = (update.validateUrl ?? raw.auth?.validate?.url ?? "").trim();
  const currentPattern = raw.auth?.validate?.loggedOutPattern;
  const pattern = update.loggedOutPattern !== undefined ? update.loggedOutPattern.trim() : typeof currentPattern === "string" ? currentPattern : undefined;
  const validateTouched = update.validateUrl !== undefined || update.loggedOutPattern !== undefined;
  if (validateTouched && Boolean(validateUrl) !== Boolean(pattern)) {
    throw new DominionError("Set both the logged-in page and where logged-out users land, or leave both empty.", {
      code: "SETUP_VALIDATE_INCOMPLETE",
      hint: 'For example "/account" and "/login".',
    });
  }

  return editConfig(loaded, (doc) => {
    const env = doc.environment(envName);
    if (baseURL !== undefined) {
      doc.setString(env, "baseURL", baseURL, path);
      // Keep allowedOrigins in step: the old app origin is replaced by the new one.
      const newOrigin = new URL(baseURL).origin;
      const prop = doc.property(env, "allowedOrigins");
      const init = prop?.getInitializer();
      if (prop && init && Node.isArrayLiteralExpression(init)) {
        const elements = init.getElements();
        if (elements.every((e) => Node.isStringLiteral(e))) {
          const values = elements.map((e) => (e as StringLiteral).getLiteralText()).map((v) => (v === resolved.origin ? newOrigin : v));
          if (!values.includes(newOrigin)) values.unshift(newOrigin);
          doc.setLiteral(env, "allowedOrigins", `[${values.map((v) => JSON.stringify(v)).join(", ")}]`, path);
        }
      }
    }
    if (update.allowDestructive !== undefined) doc.setLiteral(env, "allowDestructive", String(update.allowDestructive), path);
    if (update.loginUrl !== undefined || validateTouched) {
      const authPath = [...path, "auth"];
      const loginUrl: Array<[string, string]> = update.loginUrl !== undefined ? [["loginUrl", JSON.stringify(update.loginUrl.trim() || "/login")]] : [];
      const validate: Array<[string, string]> = [
        ["url", JSON.stringify(validateUrl)],
        ["loggedOutPattern", JSON.stringify(pattern ?? "")],
      ];
      const auth = doc.object(env, "auth", path);
      if (!auth) {
        // Existing-suite configs have no auth section yet: add it whole.
        const entries = [...loginUrl, ...(validateTouched && validateUrl ? [["validate", `{ ${validate.map(([k, v]) => `${k}: ${v}`).join(", ")} }`] as [string, string]] : [])];
        if (entries.length) doc.addProperty(env, "auth", `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")} }`);
      } else {
        for (const [k, v] of loginUrl) doc.setLiteral(auth, k, v, authPath);
        if (validateTouched) {
          if (!validateUrl) doc.remove(auth, "validate", authPath);
          else doc.setObject(auth, "validate", validate, authPath);
        }
      }
    }
    if (update.testIdAttribute !== undefined) {
      const value = update.testIdAttribute.trim();
      if (!value) throw new DominionError("The test id attribute cannot be empty.", { code: "SETUP_BAD_VALUE", hint: 'Most apps use "data-testid".' });
      doc.setString(doc.root, "testIdAttribute", value, []);
    }
  });
}

export type NewRoleStrategy = "form" | "manual" | "none";

export interface NewRole {
  name: string;
  strategy: NewRoleStrategy;
  /** Form roles: the account uses a one-time code (TOTP). */
  totp?: boolean;
}

const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Env var names for a new form role: STAGING_ADMIN_USER, STAGING_ADMIN_PASS, STAGING_ADMIN_TOTP. */
export function roleEnvVarNames(envName: string, roleName: string, totp = false): { userEnv: string; passEnv: string; totpEnv?: string } {
  const base = `${envPrefix(envName)}_${roleName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return { userEnv: `${base}_USER`, passEnv: `${base}_PASS`, ...(totp ? { totpEnv: `${base}_TOTP` } : {}) };
}

export async function addRole(loaded: LoadedConfig, envName: string, role: NewRole): Promise<LoadedConfig> {
  const name = role.name.trim();
  if (!ROLE_NAME_RE.test(name)) {
    throw new DominionError(`"${role.name}" is not a valid role name.`, { code: "SETUP_BAD_ROLE", hint: "Use letters, digits, '-' or '_', for example admin or support-agent." });
  }
  if (loaded.config.environments[envName]?.roles[name]) throw new DominionError(`Role "${name}" already exists in ${envName}.`, { code: "SETUP_ROLE_EXISTS" });
  let initializer: string;
  if (role.strategy === "form") {
    const vars = roleEnvVarNames(envName, name, role.totp);
    initializer = `{ strategy: "form", userEnv: ${JSON.stringify(vars.userEnv)}, passEnv: ${JSON.stringify(vars.passEnv)}${vars.totpEnv ? `, totpEnv: ${JSON.stringify(vars.totpEnv)}` : ""} }`;
  } else if (role.strategy === "manual" || role.strategy === "none") {
    initializer = `{ strategy: ${JSON.stringify(role.strategy)} }`;
  } else {
    throw new DominionError(`The Setup tab can add form, manual and guest roles.`, { code: "SETUP_BAD_ROLE", hint: "Add api and existing roles in dominion.config.ts (see the README)." });
  }
  return editConfig(loaded, (doc) => {
    const env = doc.environment(envName);
    const roles = doc.object(env, "roles", ["environments", envName]);
    if (roles) doc.addProperty(roles, name, initializer);
    else doc.addProperty(env, "roles", `{ ${propertyName(name)}: ${initializer} }`);
  });
}

export async function removeRole(loaded: LoadedConfig, envName: string, roleName: string): Promise<LoadedConfig> {
  const roles = loaded.config.environments[envName]?.roles ?? {};
  if (!roles[roleName]) throw new DominionError(`Role "${roleName}" is not defined in ${envName}.`, { code: "UNKNOWN_ROLE" });
  if (Object.keys(roles).length === 1) throw new DominionError(`"${roleName}" is the only role in ${envName}.`, { code: "SETUP_LAST_ROLE", hint: "Add another role first." });
  return editConfig(loaded, (doc) => {
    const env = doc.environment(envName);
    const rolesObj = doc.object(env, "roles", ["environments", envName])!;
    doc.remove(rolesObj, roleName, ["environments", envName, "roles"]);
  });
}
