import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { projectPaths } from "../../core/config/resolve";
import { DominionError } from "../../core/errors";
import { relativePosix } from "../../core/fs";
import type { RunRecord } from "../../core/orchestrator/types";
import { hasDominionHeader } from "../../core/playwright/lint";
import { loadPlaywright } from "../../core/playwright/resolve";
import { readPlan } from "../../core/plans";
import type { StartRunInput } from "../../core/runs/manager";
import type { ProjectContext } from "../project";
import { servableFile } from "../security";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".webm": "video/webm",
  ".json": "application/json",
  ".html": "text/plain; charset=utf-8",
};

export function runSummary(run: RunRecord, live: boolean) {
  return {
    id: run.id,
    mode: run.mode,
    env: run.env,
    role: run.role,
    request: run.request,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    costUsd: run.costUsd,
    budgetUsd: run.budgetUsd,
    flows: run.flows.map((f) => ({ id: f.id, name: f.name, status: f.status })),
    live,
  };
}

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(abs, match, out);
    } else if (match(entry.name)) out.push(abs);
  }
  return out;
}

export function registerRunRoutes(app: FastifyInstance, ctx: ProjectContext): void {
  // The Setup tab can create or change the config while the server runs: read it per request.
  const m = () => ctx.requireManager();
  const p = () => projectPaths(ctx.requireLoaded());

  app.get("/api/runs", async () => ({ runs: m().list().map((r) => runSummary(r, m().isLive(r.id))) }));

  app.post<{ Body: StartRunInput }>("/api/runs", async (request, reply) => {
    const body = request.body as StartRunInput | undefined;
    if (!body || !["task", "crawl", "generate", "heal"].includes(body.mode)) {
      throw new DominionError('Body must be { mode: "task" | "crawl" | "generate" | "heal", env, role, ... }.', { code: "BAD_REQUEST" });
    }
    const run = await m().start(body);
    return reply.code(201).send({ runId: run.id, run: runSummary(run, true) });
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => ({ run: m().get(request.params.id), live: m().isLive(request.params.id) }));

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (request) => {
    m().stop(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/continue", async (request) => {
    m().continue(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { flowIds?: string[] } }>("/api/runs/:id/flows/select", async (request) => {
    const flowIds = request.body?.flowIds;
    if (!Array.isArray(flowIds) || flowIds.some((f) => typeof f !== "string")) throw new DominionError("Body must be { flowIds: string[] }.", { code: "BAD_REQUEST" });
    m().selectFlows(request.params.id, flowIds);
    return { ok: true };
  });

  app.get<{ Params: { id: string; planId: string } }>("/api/runs/:id/plans/:planId", async (request) => m().readPlanFile(request.params.id, request.params.planId));

  app.put<{ Params: { id: string; planId: string }; Body: { content?: string } }>("/api/runs/:id/plans/:planId", async (request) => {
    if (typeof request.body?.content !== "string") throw new DominionError("Body must be { content: string }.", { code: "BAD_REQUEST" });
    m().savePlanFile(request.params.id, request.params.planId, request.body.content);
    return m().readPlanFile(request.params.id, request.params.planId);
  });

  app.post<{ Params: { id: string; planId: string } }>("/api/runs/:id/plans/:planId/approve", async (request) => {
    m().decidePlan(request.params.id, request.params.planId, { action: "approve" });
    return { ok: true };
  });

  app.post<{ Params: { id: string; planId: string }; Body: { feedback?: string } }>("/api/runs/:id/plans/:planId/reject", async (request) => {
    const feedback = request.body?.feedback?.trim();
    m().decidePlan(request.params.id, request.params.planId, { action: "reject", feedback: feedback || undefined });
    return { ok: true };
  });

  app.post<{ Params: { id: string; planId: string }; Body: { feedback?: string } }>("/api/runs/:id/plans/:planId/regenerate", async (request) => {
    const feedback = request.body?.feedback?.trim();
    if (!feedback) throw new DominionError("Say what should change in the plan.", { code: "FEEDBACK_REQUIRED" });
    m().decidePlan(request.params.id, request.params.planId, { action: "regenerate", feedback });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", async (request) => m().diff(request.params.id));

  app.post<{ Params: { id: string; pid: string; action: string } }>("/api/runs/:id/proposals/:pid/:action", async (request) => {
    const action = request.params.action;
    if (action !== "apply" && action !== "reject") throw new DominionError("Action must be apply or reject.", { code: "BAD_REQUEST" });
    m().decideProposal(request.params.id, request.params.pid, action);
    return { ok: true };
  });

  /** Plans and DOMinion specs on disk, for Generate and Heal from the Start screen. */
  app.get("/api/specs", async () => ({
    plans: walk(p().specsDir, (n) => n.endsWith(".md")).map((abs) => {
      const plan = readPlan(abs);
      return { path: relativePosix(p().root, abs), status: plan.frontmatter.status ?? "draft", env: plan.frontmatter.env, role: plan.frontmatter.role, title: /^#\s+(.+)$/m.exec(plan.body)?.[1] };
    }),
    tests: walk(p().testDir, (n) => /\.(spec|test)\.(ts|js)$/.test(n))
      .filter((abs) => statSync(abs).size < 1_000_000 && hasDominionHeader(readFileSync(abs, "utf8")))
      .map((abs) => relativePosix(p().root, abs)),
  }));

  app.get<{ Querystring: { path?: string } }>("/api/files", async (request, reply) => {
    const abs = servableFile(p().root, request.query.path ?? "");
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return reply.code(404).send({ error: "File not found or not allowed." });
    const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? "text/plain; charset=utf-8";
    return reply.type(type).header("x-content-type-options", "nosniff").send(createReadStream(abs));
  });

  /** Opens a Playwright trace in the local Trace Viewer (spec: links to Playwright traces). */
  app.post<{ Body: { path?: string } }>("/api/traces/open", async (request, reply) => {
    const abs = servableFile(p().root, request.body?.path ?? "");
    if (!abs || !abs.endsWith(".zip") || !existsSync(abs)) return reply.code(404).send({ error: "Trace not found." });
    const { cliPath } = await loadPlaywright(p().root);
    spawn(process.execPath, [cliPath, "show-trace", abs], { cwd: p().root, detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  });
}
