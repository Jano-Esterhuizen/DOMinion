import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { LoadedConfig } from "../core/config/loader";
import { DominionError, errorMessage, isDominionError } from "../core/errors";
import { packageRoot } from "../core/package-info";
import { activeRedactor } from "../core/redact";
import type { RunManager, RunManagerOptions } from "../core/runs/manager";
import { SetupJobs } from "./jobs";
import { PlaywrightUi, registerPlaywrightUiRoutes, type UiModeLauncher } from "./playwright-ui";
import { findProjectRoot, ProjectContext } from "./project";
import { registerEnvRoutes } from "./routes/envs";
import { registerRunRoutes } from "./routes/runs";
import { registerSetupRoutes, type SetupRouteOptions } from "./routes/setup";
import { hostAllowed, newToken, originAllowed, requestToken, sendError, TOKEN_COOKIE, tokensEqual } from "./security";
import { registerEventStream } from "./ws";

export const DEFAULT_PORT = 4555;

export interface StartServerOptions {
  /** The project config; omit it when the project has no dominion.config.ts yet (Setup tab). */
  loaded?: LoadedConfig;
  /** Project folder when there is no config yet (default: the nearest package.json from cwd). */
  root?: string;
  /** Default 4555; 0 picks a free port (tests). */
  port?: number;
  token?: string;
  manager?: RunManager;
  managerOptions?: RunManagerOptions;
  /** Folder with the built UI (default: dist/ui of this package). */
  uiDir?: string;
  /** Setup tab seams (tests). */
  setup?: SetupRouteOptions;
  /** Starts the Playwright UI process (tests). */
  launchPlaywrightUi?: UiModeLauncher;
}

export interface DominionServer {
  app: FastifyInstance;
  project: ProjectContext;
  /** Undefined until the project has a dominion.config.ts. */
  manager: RunManager | undefined;
  port: number;
  token: string;
  /** Base URL (no token). */
  url: string;
  /** URL to open in the browser; sets the token cookie on first load. */
  openUrl: string;
  close(): Promise<void>;
}

const STATUS_BY_CODE: Record<string, number> = {
  RUN_NOT_FOUND: 404,
  UNKNOWN_ENV: 404,
  UNKNOWN_ROLE: 404,
  PLAN_NOT_FOUND: 404,
  RUN_NOT_ACTIVE: 409,
  PLAN_NOT_PENDING: 409,
  FLOWS_NOT_PENDING: 409,
  RUN_NOT_PAUSED: 409,
  PLAN_LOCKED: 409,
  PROPOSAL_STALE: 409,
  PROPOSAL_NOT_PENDING: 409,
  SETUP_REQUIRED: 409,
  SETUP_CONFIG_EXISTS: 409,
  SETUP_PLAYWRIGHT_EXISTS: 409,
  SETUP_NO_PACKAGE_JSON: 409,
  SETUP_ROLE_EXISTS: 409,
  JOB_RUNNING: 409,
  JOB_NOT_FOUND: 404,
  LOGIN_SCRIPT_CUSTOM: 409,
  CONFIG_NOT_EDITABLE: 409,
  PLAYWRIGHT_UI_UNAVAILABLE: 409,
  PLAYWRIGHT_MISSING: 409,
  PLAYWRIGHT_TOO_OLD: 409,
};

/**
 * The local UI server (spec: Local UI, Server security): Fastify bound to 127.0.0.1 only, a random
 * per-start token required on every request (header or cookie), no files served from outside the
 * consumer repo.
 */
export async function startServer(options: StartServerOptions): Promise<DominionServer> {
  const token = options.token ?? newToken();
  const root = options.loaded?.root ?? options.root ?? findProjectRoot(process.cwd());
  const project = new ProjectContext(root, options.loaded, options.managerOptions, options.manager);
  const uiDir = options.uiDir ?? join(packageRoot(), "dist", "ui");
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  let port = options.port ?? DEFAULT_PORT;

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  app.addHook("onRequest", async (request, reply) => {
    if (!hostAllowed(request.headers.host, port)) return sendError(reply, 403, "This server only answers on 127.0.0.1.");
    if (request.method !== "GET" && request.method !== "HEAD" && !originAllowed(request.headers.origin, port)) {
      return sendError(reply, 403, "Cross-origin requests are not allowed.");
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    // First page load: ?token=... becomes an HttpOnly cookie and is removed from the address bar.
    const queryToken = url.searchParams.get("token");
    if (request.method === "GET" && !url.pathname.startsWith("/api/") && queryToken && tokensEqual(queryToken, token)) {
      url.searchParams.delete("token");
      reply.header("set-cookie", `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return reply.redirect(`${url.pathname}${url.search}`, 302);
    }
    if (!tokensEqual(requestToken(request), token)) {
      return sendError(reply, 401, "Missing or invalid DOMinion token. Open the URL printed by `npx dominion ui`.");
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const redact = (s: string) => activeRedactor().redact(s);
    if (isDominionError(error)) {
      return reply.code(STATUS_BY_CODE[error.code] ?? 400).send({ error: redact(error.message), hint: error.hint ? redact(error.hint) : undefined, code: error.code });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: redact(errorMessage(error)) });
  });

  registerSetupRoutes(app, project, new SetupJobs(), options.setup);
  const playwrightUi = new PlaywrightUi(options.launchPlaywrightUi);
  registerPlaywrightUiRoutes(app, project, playwrightUi);
  registerEnvRoutes(app, project);
  registerRunRoutes(app, project);
  registerEventStream(app, project);
  app.all("/api/*", async (_request, reply) => sendError(reply, 404, "No such API endpoint."));

  if (existsSync(join(uiDir, "index.html"))) {
    await app.register(fastifyStatic, { root: uiDir, prefix: "/", decorateReply: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.type("text/html").sendFile("index.html");
      return sendError(reply, 404, "Not found.");
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply.type("text/html").send("<!doctype html><title>DOMinion</title><p>The DOMinion UI is not built. Run <code>npm run build:ui</code> in the DOMinion repo.</p>"),
    );
  }

  const address = await app.listen({ host: "127.0.0.1", port });
  port = Number(new URL(address).port);
  const url = `http://127.0.0.1:${port}`;
  return {
    app,
    project,
    get manager() {
      return project.manager;
    },
    port,
    token,
    url,
    openUrl: `${url}/?token=${token}`,
    async close() {
      const manager = project.manager;
      manager?.stopAll();
      if (manager) await Promise.race([manager.idle(), new Promise((r) => setTimeout(r, 5_000))]);
      await playwrightUi.stop();
      await app.close();
    },
  };
}

export { DominionError };
