import type { FastifyInstance } from "fastify";
import { ensureSession, roleStatus } from "../../core/auth";
import type { LoadedConfig } from "../../core/config/loader";
import { getEnvironment, getRole, referencedEnvVars } from "../../core/config/resolve";
import { detectApiCredential } from "../../core/doctor";
import { errorMessage, isDominionError } from "../../core/errors";
import type { Choice, Prompter } from "../../core/prompter";
import { packageVersion } from "../../core/package-info";

type LoginState =
  | { state: "running"; strategy: string }
  | { state: "waiting_for_user"; strategy: string; message: string }
  | { state: "done"; strategy: string; action: string }
  | { state: "failed"; strategy: string; error: string; hint?: string };

/** JSON-safe config with no secret values (it only ever names env vars). */
export function publicConfig(loaded: LoadedConfig) {
  const replacer = (_key: string, value: unknown) => (value instanceof RegExp ? value.toString() : value);
  const config = JSON.parse(JSON.stringify(loaded.config, replacer)) as unknown;
  const envVars = [...new Set([...referencedEnvVars(loaded.config).map((r) => r.name)])].map((name) => ({ name, set: Boolean(process.env[name]) }));
  return { config, root: loaded.root, configPath: loaded.configPath, envVars, apiCredential: detectApiCredential() ?? null, version: packageVersion() };
}

export function registerEnvRoutes(app: FastifyInstance, loaded: LoadedConfig): void {
  const logins = new Map<string, LoginState>();
  const waiters = new Map<string, () => void>();

  app.get("/api/config", async () => publicConfig(loaded));

  app.get<{ Params: { env: string; role: string }; Querystring: { validate?: string } }>("/api/envs/:env/roles/:role/status", async (request) => {
    const { env, role } = request.params;
    const status = await roleStatus({ loaded, envName: env, roleName: role, validate: request.query.validate === "1" });
    return { ...status, login: logins.get(`${env}/${role}`) ?? null };
  });

  app.post<{ Params: { env: string; role: string }; Body: { force?: boolean; headed?: boolean } }>("/api/envs/:env/roles/:role/login", async (request, reply) => {
    const { env, role } = request.params;
    const key = `${env}/${role}`;
    const roleConfig = getRole(getEnvironment(loaded, env), role);
    const current = logins.get(key);
    if (current && (current.state === "running" || current.state === "waiting_for_user")) return reply.code(409).send({ error: "A login for this role is already in progress.", login: current });
    const strategy = roleConfig.strategy;
    logins.set(key, { state: "running", strategy });
    const prompter: Prompter = {
      interactive: true,
      confirm: async (_m: string, d: boolean) => d,
      input: async (_m: string, d?: string) => d ?? "",
      select: async <T extends string>(_m: string, choices: ReadonlyArray<Choice<T>>, d?: T) => d ?? choices[0]!.value,
      waitForUser: (message: string) =>
        new Promise<void>((resolve) => {
          logins.set(key, { state: "waiting_for_user", strategy, message });
          waiters.set(key, resolve);
        }),
    };
    ensureSession({ loaded, envName: env, roleName: role, prompter, force: request.body?.force ?? true, headed: request.body?.headed })
      .then((result) => logins.set(key, { state: "done", strategy, action: result.action }))
      .catch((error: unknown) =>
        logins.set(key, { state: "failed", strategy, error: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined }),
      );
    return reply.code(202).send({ login: logins.get(key) });
  });

  /** Manual strategy: the user logged in in the opened browser and clicked Done. */
  app.post<{ Params: { env: string; role: string } }>("/api/envs/:env/roles/:role/login/done", async (request, reply) => {
    const key = `${request.params.env}/${request.params.role}`;
    const resolve = waiters.get(key);
    if (!resolve) return reply.code(409).send({ error: "No login is waiting for you for this role." });
    waiters.delete(key);
    logins.set(key, { state: "running", strategy: "manual" });
    resolve();
    return { ok: true };
  });

  app.get<{ Params: { env: string; role: string } }>("/api/envs/:env/roles/:role/login", async (request) => ({
    login: logins.get(`${request.params.env}/${request.params.role}`) ?? null,
  }));
}
