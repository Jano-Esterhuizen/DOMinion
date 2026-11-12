import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import { type DominionServer, startServer } from "../../src/server";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { buildCli } from "../helpers/cli";
import { FIXTURE_ENV, FIXTURE_SECRET_VALUES, linkDominionPackage, makeFixtureConsumer, setEnv, STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { generatorScript, plannerScript } from "../helpers/fixture-scripts";
import { scriptedRunner } from "../helpers/scripted-runner";
import { http, openSocket, readEventStream, waitFor } from "../helpers/server";
import { removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let root: string;
let server: DominionServer;
let restoreEnv: () => void;
const runner = scriptedRunner({ planner: plannerScript, generator: generatorScript() });

beforeAll(async () => {
  buildCli();
  fixture = await startFixtureApp();
  restoreEnv = setEnv({ ...FIXTURE_ENV });
  root = makeFixtureConsumer("server", fixture.url, { files: { "playwright.config.ts": STOCK_PLAYWRIGHT_CONFIG } });
  linkDominionPackage(root);
  server = await startServer({ loaded: await loadConfig({ cwd: root }), port: 0, managerOptions: { runner: runner.runner, skipPreflight: true } });
});

afterAll(async () => {
  await server?.close();
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

describe("server security", () => {
  it("binds to 127.0.0.1 only", () => {
    const address = server.app.server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });

  it("rejects requests without the token, accepts header, bearer and cookie", async () => {
    expect((await http(server.url, undefined, "/api/config")).status).toBe(401);
    expect((await http(server.url, "wrong-token", "/api/config")).status).toBe(401);
    expect((await http(server.url, server.token, "/api/config")).status).toBe(200);
    expect((await http(server.url, undefined, "/api/config", { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
    expect((await http(server.url, undefined, "/api/config", { headers: { cookie: `dominion_token=${server.token}` } })).status).toBe(200);
    expect((await http(server.url, undefined, `/api/config?token=${server.token}`)).status).toBe(401);
    expect((await http(server.url, undefined, "/")).status).toBe(401);
  });

  it("turns ?token= on page load into an HttpOnly cookie and strips it from the URL", async () => {
    const response = await http(server.url, undefined, `/runs/x?token=${server.token}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/runs/x");
    expect(response.headers.get("set-cookie")).toMatch(/dominion_token=\w+; Path=\/; HttpOnly; SameSite=Strict/);
  });

  it("rejects other hosts (DNS rebinding) and cross-origin writes (CSRF)", async () => {
    // fetch() cannot override Host (a forbidden header), so use node:http for this one.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/api/config", headers: { host: "evil.example.com", "x-dominion-token": server.token } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await http(server.url, server.token, "/api/runs", { method: "POST", json: { mode: "task" }, headers: { origin: "https://evil.example.com" } })).status).toBe(403);
  });

  it("protects the WebSocket with the same token", async () => {
    expect(await openSocket(server.url, {}, "2026-01-01-0000")).toBe(401);
  });

  it("never returns secret values and never serves secret files or files outside the repo", async () => {
    const config = await http(server.url, server.token, "/api/config");
    const text = JSON.stringify(config.body);
    for (const secret of FIXTURE_SECRET_VALUES) expect(text).not.toContain(secret);
    expect(config.body.envVars).toContainEqual({ name: "FX_PASS", set: true });
    writeFileSync(join(root, ".env.local"), "FX_PASS=x\n");
    mkdirSync(join(root, ".auth"), { recursive: true });
    writeFileSync(join(root, ".auth", "staging-customer.json"), "{}");
    for (const path of [".env.local", ".auth/staging-customer.json", "../package.json", join(root, "..", "..", "..", "package.json"), "node_modules/x.json", "dominion.config.ts.exe"]) {
      expect((await http(server.url, server.token, `/api/files?path=${encodeURIComponent(path)}`)).status, path).toBe(404);
    }
    expect((await http(server.url, server.token, "/api/files?path=playwright.config.ts")).status).toBe(200);
    expect((await http(server.url, server.token, "/api/nope")).status).toBe(404);
  });
});

describe("runs through the API", () => {
  it("runs task mode end to end with plan review over REST and replays events over WebSocket", async () => {
    const started = await http(server.url, server.token, "/api/runs", { method: "POST", json: { mode: "task", env: "staging", role: "customer", request: "write tests for the add to cart workflow" } });
    expect(started.status).toBe(201);
    const runId = started.body.runId as string;

    const pending = await waitFor(async () => {
      const r = await http(server.url, server.token, `/api/runs/${runId}`);
      return r.body.run.status === "awaiting_approval" ? r.body : undefined;
    }, 60_000, "plan review");
    expect(pending.live).toBe(true);

    const plan = await http(server.url, server.token, `/api/runs/${runId}/plans/add-to-cart`);
    expect(plan.body.path).toBe("specs/add-to-cart.md");
    const edited = plan.body.content.replace("## Overview", "## Overview\nReviewed in the UI.");
    expect((await http(server.url, server.token, `/api/runs/${runId}/plans/add-to-cart`, { method: "PUT", json: { content: edited } })).status).toBe(200);
    expect((await http(server.url, server.token, `/api/runs/${runId}/plans/nope/approve`, { method: "POST", json: {} })).status).toBe(409);
    expect((await http(server.url, server.token, `/api/runs/${runId}/plans/add-to-cart/approve`, { method: "POST", json: {} })).status).toBe(200);

    const done = await waitFor(async () => {
      const r = await http(server.url, server.token, `/api/runs/${runId}`);
      return ["done", "failed", "stopped"].includes(r.body.run.status) ? r.body.run : undefined;
    }, 120_000, "run to finish");
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    expect(done.flows[0].results.map((r: { status: string }) => r.status)).toEqual(["passed", "passed"]);

    const diff = await http(server.url, server.token, `/api/runs/${runId}/diff`);
    const files = diff.body.files.map((f: { path: string }) => f.path);
    expect(files).toEqual(expect.arrayContaining(["specs/add-to-cart.md", "tests/agent/cart/add-to-cart.spec.ts", "playwright.config.ts"]));
    expect(diff.body.files.find((f: { path: string }) => f.path === "specs/add-to-cart.md").diff).toContain("+Reviewed in the UI.");

    const stream = await readEventStream(server.url, server.token, runId);
    expect(stream.ready.live).toBe(false);
    expect(stream.events.map((e) => e.seq)).toEqual(stream.events.map((_, i) => i + 1));
    expect(stream.events.some((e) => e.type === "plan.approved")).toBe(true);
    const tail = await readEventStream(server.url, server.token, runId, stream.events.length - 3);
    expect(tail.events).toHaveLength(3);

    const list = await http(server.url, server.token, "/api/runs");
    expect(list.body.runs[0]).toMatchObject({ id: runId, status: "done", live: false });
  });

  it("stops a run that is waiting for review", async () => {
    const started = await http(server.url, server.token, "/api/runs", { method: "POST", json: { mode: "task", env: "staging", role: "customer", request: "add to cart" } });
    const runId = started.body.runId as string;
    await waitFor(async () => (await http(server.url, server.token, `/api/runs/${runId}`)).body.run.status === "awaiting_approval", 60_000, "review");
    expect((await http(server.url, server.token, `/api/runs/${runId}/stop`, { method: "POST", json: {} })).status).toBe(200);
    const stopped = await waitFor(async () => {
      const r = (await http(server.url, server.token, `/api/runs/${runId}`)).body.run;
      return r.status === "stopped" ? r : undefined;
    }, 30_000, "stop");
    expect(stopped.status).toBe("stopped");
    expect((await http(server.url, server.token, `/api/runs/${runId}/stop`, { method: "POST", json: {} })).status).toBe(409);
  });

  it("explains bad requests clearly", async () => {
    const bad = await http(server.url, server.token, "/api/runs", { method: "POST", json: { mode: "task", env: "prod", request: "x" } });
    expect(bad.status).toBe(404);
    expect(bad.body.hint).toContain("staging");
    const empty = await http(server.url, server.token, "/api/runs", { method: "POST", json: { mode: "task", env: "staging", request: " " } });
    expect(empty.status).toBe(400);
    expect((await http(server.url, server.token, "/api/runs/2026-01-01-ffff")).status).toBe(404);
  });
});
