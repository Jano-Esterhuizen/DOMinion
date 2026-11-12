import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { listEnvironments } from "../core/config/resolve";
import { DominionError } from "../core/errors";
import { findPlaywrightConfigs } from "../core/init/detect";
import { playwrightCommandEnv } from "../core/orchestrator/pipeline";
import { testProjectName } from "../core/playwright/patch";
import { stripAnsi } from "../core/playwright/report";
import { loadPlaywright, locatePlaywrightTest } from "../core/playwright/resolve";
import { findPlaywrightConfigsInRepo } from "../core/project/scan";
import { activeRedactor } from "../core/redact";
import type { ProjectContext } from "./project";

const MAX_LOG_LINES = 200;

export interface PlaywrightUiStatus {
  /** False until the project has a Playwright config and @playwright/test. */
  available: boolean;
  /** Why it cannot open yet. */
  reason?: string;
  /** The Playwright config it opens (repo-relative). */
  config?: string;
  /** The equivalent terminal command. */
  command?: string;
  running: boolean;
  startedAt?: string;
  /** How the last Playwright UI ended. */
  last?: { code: number | null; at: string; closedFromHere: boolean; error?: string; hint?: string };
  /** Output from the current or last Playwright UI (redacted). */
  log: string[];
  /** DOMinion's projects in the config, where generated tests run in a new setup. */
  dominionProjects: string[];
}

export interface UiModeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Starts the Playwright UI process (a seam for tests). */
export type UiModeLauncher = (launch: UiModeLaunch) => ChildProcess;

export const launchUiMode: UiModeLauncher = ({ command, args, cwd, env }) =>
  spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

interface Target {
  config: string;
  dominionProjects: string[];
}

/**
 * Opens Playwright's UI mode (`playwright test --ui`) for the project in its own window, with the
 * project's own Playwright and config, so people can see and run every test, generated or not.
 * One at a time; it is closed when the window closes, from the tab, or when the server stops.
 */
export class PlaywrightUi {
  private child: ChildProcess | undefined;
  private running = false;
  private closingFromHere = false;
  private startedAt: string | undefined;
  private last: PlaywrightUiStatus["last"];
  private log: string[] = [];

  constructor(private readonly launch: UiModeLauncher = launchUiMode) {}

  status(ctx: ProjectContext): PlaywrightUiStatus {
    const target = this.target(ctx);
    const base = { running: this.running, startedAt: this.running ? this.startedAt : undefined, last: this.last, log: [...this.log] };
    if ("reason" in target) return { ...base, available: false, reason: target.reason, dominionProjects: [] };
    return { ...base, available: true, config: target.config, command: `npx playwright test --ui --config=${target.config}`, dominionProjects: target.dominionProjects };
  }

  async start(ctx: ProjectContext): Promise<PlaywrightUiStatus> {
    if (this.running) return this.status(ctx);
    const target = this.target(ctx);
    if ("reason" in target) {
      throw new DominionError(target.reason, { code: "PLAYWRIGHT_UI_UNAVAILABLE", hint: "Finish step 1 (Playwright) in the Setup tab first." });
    }
    const { cliPath } = await loadPlaywright(ctx.root);
    this.log = [];
    this.last = undefined;
    this.closingFromHere = false;
    const child = this.launch({
      command: process.execPath,
      args: [cliPath, "test", "--ui", `--config=${target.config}`],
      cwd: ctx.root,
      // Like running it in a terminal: the user's env (with .env.local) minus API keys. Credentials
      // stay, because setup projects (DOMinion's and the suite's own) log in with them.
      env: playwrightCommandEnv(ctx.loaded),
    });
    this.child = child;
    this.running = true;
    this.startedAt = new Date().toISOString();
    const onData = (chunk: Buffer) => {
      for (const line of stripAnsi(chunk.toString()).split(/\r?\n/)) {
        if (line.trim()) this.log.push(activeRedactor().redact(line));
      }
      if (this.log.length > MAX_LOG_LINES) this.log.splice(0, this.log.length - MAX_LOG_LINES);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => this.finish(child, null, error));
    child.once("exit", (code) => this.finish(child, code));
    return this.status(ctx);
  }

  /** Closes the Playwright UI window and its test server. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.running) return;
    this.closingFromHere = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (process.platform === "win32" && child.pid) {
      // Kill the whole tree: the test server and the browser window it opened.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
    if (!done) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  }

  private finish(child: ChildProcess, code: number | null, error?: Error): void {
    if (child !== this.child || !this.running) return;
    this.running = false;
    const closedFromHere = this.closingFromHere;
    const failed = !closedFromHere && (error !== undefined || (code !== 0 && code !== null));
    this.last = {
      code,
      at: new Date().toISOString(),
      closedFromHere,
      ...(failed
        ? {
            error: error ? `Could not start Playwright UI: ${activeRedactor().redact(error.message)}` : `Playwright UI stopped with exit code ${code}.`,
            hint: "The output below says why. Running the same command in a terminal shows the same thing.",
          }
        : {}),
    };
  }

  private target(ctx: ProjectContext): Target | { reason: string } {
    const root = ctx.root;
    const loaded = ctx.loaded;
    const config = loaded?.config.project?.playwrightConfig ?? findPlaywrightConfigs(root)[0] ?? findPlaywrightConfigsInRepo(root)[0];
    if (!config) return { reason: "This project has no Playwright config yet." };
    if (!locatePlaywrightTest(root)) return { reason: "@playwright/test is not installed in this project." };
    const dominionProjects: string[] = [];
    if (loaded && !loaded.config.project) {
      let text = "";
      try {
        text = readFileSync(join(root, config), "utf8");
      } catch {
        // the status still works without the project names
      }
      for (const env of listEnvironments(loaded)) {
        for (const role of Object.keys(env.roles)) {
          const name = testProjectName(env.name, role);
          if (text.includes(`"${name}"`)) dominionProjects.push(name);
        }
      }
    }
    return { config, dominionProjects };
  }
}

export function registerPlaywrightUiRoutes(app: FastifyInstance, ctx: ProjectContext, ui: PlaywrightUi): void {
  app.get("/api/playwright-ui", async () => ui.status(ctx));
  app.post("/api/playwright-ui", async () => ui.start(ctx));
  app.delete("/api/playwright-ui", async () => {
    await ui.stop();
    return ui.status(ctx);
  });
}
