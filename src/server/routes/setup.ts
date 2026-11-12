import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { analyzeConventions } from "../../core/agents/analysis";
import { createSdkAgentRunner } from "../../core/agents/runner";
import { getEnvironment, referencedEnvVars } from "../../core/config/resolve";
import { detectApiCredential } from "../../core/doctor";
import { DominionError } from "../../core/errors";
import { type InitOptions, runInit } from "../../core/init";
import { detectPackageManager, findDominionConfig, playwrightInitCommand } from "../../core/init/detect";
import { packageName } from "../../core/package-info";
import { type CapturedCommandRunner, runCapturedCommand } from "../../core/process";
import { findPlaywrightConfigsInRepo } from "../../core/project/scan";
import { loadPlaywright } from "../../core/playwright/resolve";
import { nonInteractivePrompter } from "../../core/prompter";
import { writeEnvValues } from "../../core/setup/env-file";
import { detectLoginForm, type LoginFormSpec, readLoginScriptState, writeLoginScript } from "../../core/setup/login-builder";
import { addRole, type EnvironmentUpdate, type NewRole, removeRole, updateEnvironment } from "../../core/setup/project";
import { getSetupState, loginScriptPathFor } from "../../core/setup/state";
import type { SetupJobs } from "../jobs";
import type { ProjectContext } from "../project";

export interface SetupRouteOptions {
  /** Runs `npm init playwright@latest` and the like (tests inject a stand-in). */
  runCommand?: CapturedCommandRunner;
  /** Conventions summary for existing suites (tests inject a stand-in; default: a Claude agent). */
  analyzeConventions?: InitOptions["analyzeConventions"];
}

const badRequest = (message: string) => new DominionError(message, { code: "BAD_REQUEST" });

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string.`);
  return value;
}

/**
 * The Setup tab (spec addition: UI-first onboarding). Each route maps to a CLI equivalent
 * (`init`, editing dominion.config.ts / .env.local, `auth`, `doctor`) and calls the same core code.
 * Secret values only ever travel browser -> server -> .env.local; no route returns them.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: ProjectContext, jobs: SetupJobs, options: SetupRouteOptions = {}): void {
  const root = ctx.root;
  const runCommand = options.runCommand ?? runCapturedCommand;

  app.get("/api/setup", async () => ({
    ...(await getSetupState(root, { loaded: ctx.loaded })),
    jobs: { playwright: jobs.latest("playwright") ?? null },
  }));

  app.get<{ Params: { id: string } }>("/api/setup/jobs/:id", async (request) => ({ job: jobs.get(request.params.id) }));

  /** Sets up Playwright the way `npm init playwright@latest` does, without its questions. */
  app.post<{ Body: { lang?: string } }>("/api/setup/playwright", async (request, reply) => {
    if (!existsSync(join(root, "package.json"))) throw new DominionError("This folder has no package.json.", { code: "SETUP_NO_PACKAGE_JSON", hint: "Run `npm init -y` in the project folder first." });
    if (findPlaywrightConfigsInRepo(root).length) throw new DominionError("This project already has a Playwright config.", { code: "SETUP_PLAYWRIGHT_EXISTS" });
    const lang = request.body?.lang === "js" ? "js" : "ts";
    const cmd = playwrightInitCommand(detectPackageManager(root), true);
    const args = cmd.args.map((a) => (a === "--lang=ts" ? `--lang=${lang}` : a));
    const display = `${cmd.command} ${args.join(" ")}`;
    const job = jobs.start("playwright", async (log) => {
      log(`$ ${display}`);
      const code = await runCommand(cmd.command, args, { cwd: root, onLine: log });
      if (code !== 0) throw new DominionError(`\`${display}\` exited with code ${code}.`, { code: "SETUP_PLAYWRIGHT_FAILED", hint: `Run \`${display}\` in a terminal in ${root} to see why.` });
      if (!findPlaywrightConfigsInRepo(root).length) throw new DominionError("Playwright finished, but no playwright.config was written.", { code: "SETUP_PLAYWRIGHT_FAILED" });
      log("Playwright is set up.");
    });
    return reply.code(202).send({ job });
  });

  /** Creates dominion.config.ts and friends: `npx dominion init` with the answers from the form. */
  app.post<{ Body: Record<string, unknown> }>("/api/setup/init", async (request) => {
    if (findDominionConfig(root)) throw new DominionError("This project already has a dominion.config.ts.", { code: "SETUP_CONFIG_EXISTS" });
    const body = request.body ?? {};
    const baseURL = stringField(body, "baseURL");
    if (!baseURL?.trim()) throw badRequest("Enter the base URL of the app to test.");
    const analyze = body.analyze === true && Boolean(detectApiCredential());
    const result = await runInit({
      root,
      baseURL,
      envName: stringField(body, "envName")?.trim() || undefined,
      playwrightConfig: stringField(body, "playwrightConfig"),
      yes: true,
      prompter: nonInteractivePrompter(),
      ignoreOverlap: body.ignoreOverlap !== false,
      analyzeConventions: analyze
        ? (options.analyzeConventions ?? ((input) => analyzeConventions({ ...input, runner: createSdkAgentRunner(), model: "claude-sonnet-5-5" })))
        : undefined,
    });
    await ctx.reload();
    return { mode: result.mode, files: result.files, warnings: result.warnings };
  });

  /** Saves credentials and the API key to .env.local. Write-only: values are never sent back. */
  app.put<{ Body: { values?: Record<string, unknown> } }>("/api/setup/secrets", async (request) => {
    const values = request.body?.values;
    if (!values || typeof values !== "object" || Object.values(values).some((v) => typeof v !== "string")) throw badRequest("Body must be { values: { NAME: string } }.");
    const loaded = ctx.loaded;
    const allowed = new Set(["ANTHROPIC_API_KEY", ...(loaded ? [...referencedEnvVars(loaded.config).map((r) => r.name), ...loaded.config.secretEnv] : [])]);
    const unknown = Object.keys(values).filter((name) => !allowed.has(name));
    if (unknown.length) {
      throw new DominionError(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not used by dominion.config.ts.`, {
        code: "SETUP_UNKNOWN_SECRET",
        hint: "Only the API key and env vars your roles or secretEnv name can be saved here.",
      });
    }
    const result = writeEnvValues(root, values as Record<string, string>);
    ctx.refreshSecrets();
    return result;
  });

  app.put<{ Params: { env: string }; Body: Record<string, unknown> }>("/api/setup/environments/:env", async (request) => {
    const body = request.body ?? {};
    const update: EnvironmentUpdate = {
      baseURL: stringField(body, "baseURL"),
      loginUrl: stringField(body, "loginUrl"),
      validateUrl: stringField(body, "validateUrl"),
      loggedOutPattern: stringField(body, "loggedOutPattern"),
      testIdAttribute: stringField(body, "testIdAttribute"),
      ...(typeof body.allowDestructive === "boolean" ? { allowDestructive: body.allowDestructive } : {}),
    };
    await ctx.reload(await updateEnvironment(ctx.requireLoaded(), request.params.env, update));
    return { ok: true };
  });

  app.post<{ Params: { env: string }; Body: Record<string, unknown> }>("/api/setup/environments/:env/roles", async (request, reply) => {
    const body = request.body ?? {};
    const strategy = stringField(body, "strategy");
    if (strategy !== "form" && strategy !== "manual" && strategy !== "none") throw badRequest('strategy must be "form", "manual" or "none".');
    const role: NewRole = { name: stringField(body, "name") ?? "", strategy, totp: body.totp === true };
    await ctx.reload(await addRole(ctx.requireLoaded(), request.params.env, role));
    return reply.code(201).send({ ok: true });
  });

  app.delete<{ Params: { env: string; role: string } }>("/api/setup/environments/:env/roles/:role", async (request) => {
    await ctx.reload(await removeRole(ctx.requireLoaded(), request.params.env, request.params.role));
    return { ok: true };
  });

  app.get<{ Params: { env: string; role: string } }>("/api/setup/environments/:env/roles/:role/login-script", async (request) => {
    const path = loginScriptPathFor(ctx.requireLoaded(), request.params.env, request.params.role);
    return readLoginScriptState(path, packageName());
  });

  /** Opens the login page (no session, nothing typed) and suggests how to find its fields. */
  app.post<{ Params: { env: string; role: string } }>("/api/setup/environments/:env/roles/:role/login-script/detect", async (request) => {
    const loaded = ctx.requireLoaded();
    loginScriptPathFor(loaded, request.params.env, request.params.role);
    const env = getEnvironment(loaded, request.params.env);
    const { module: playwright } = await loadPlaywright(root);
    return detectLoginForm({ playwright, baseURL: env.baseURL, loginUrl: env.auth.loginUrl, testIdAttribute: loaded.config.testIdAttribute });
  });

  app.put<{ Params: { env: string; role: string }; Body: { spec?: LoginFormSpec; overwrite?: boolean } }>("/api/setup/environments/:env/roles/:role/login-script", async (request) => {
    const spec = request.body?.spec;
    if (!spec || typeof spec !== "object") throw badRequest("Body must be { spec: { username, password, submit, totp? } }.");
    const path = loginScriptPathFor(ctx.requireLoaded(), request.params.env, request.params.role);
    return writeLoginScript(path, spec, packageName(), { overwrite: request.body?.overwrite === true });
  });
}
