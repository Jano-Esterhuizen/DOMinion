import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type DominionServer, startServer } from "../../src/server";
import { launchUiMode, type PlaywrightUiStatus, type UiModeLaunch, type UiModeLauncher } from "../../src/server/playwright-ui";
import { setEnv } from "../helpers/consumer";
import { makePlaywrightProject, makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

const FAKE_KEY = "sk-ant-pw-ui-not-a-real-key";
const FAKE_PASS = "fixture-pass-not-real";

let server: DominionServer | undefined;
let root: string | undefined;
let restoreEnv: (() => void) | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  restoreEnv?.();
  restoreEnv = undefined;
  if (root) {
    try {
      removeDir(root);
    } catch (error) {
      // GitHub's Windows runners can keep a folder locked well after the processes using it are
      // gone (EBUSY, often antivirus scanning). The tests above already checked that Playwright UI
      // stopped; a leftover temp folder under test/.tmp is harmless.
      if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBUSY")) throw error;
    }
  }
  root = undefined;
});

async function call(method: "GET" | "POST" | "DELETE"): Promise<{ status: number; body: PlaywrightUiStatus & { error?: string; code?: string; hint?: string } }> {
  const res = await fetch(`${server!.url}/api/playwright-ui`, { method, headers: { authorization: `Bearer ${server!.token}` } });
  return { status: res.status, body: (await res.json()) as PlaywrightUiStatus & { error?: string; code?: string } };
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting");
}

/** Records every launch and starts a stand-in process instead of Playwright. */
function fakeLauncher(script: string) {
  const launches: UiModeLaunch[] = [];
  const pids: number[] = [];
  const launch: UiModeLauncher = (input) => {
    launches.push(input);
    const child = spawn(process.execPath, ["-e", script], { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) pids.push(child.pid);
    return child;
  };
  return { launch, launches, pids };
}

describe("Playwright UI tab", () => {
  it("says what is missing before Playwright is set up", async () => {
    root = makeTempDir("pw-ui-none");
    writeFiles(root, { "package.json": JSON.stringify({ name: "no-playwright", private: true }) });
    server = await startServer({ root, port: 0 });
    const status = await call("GET");
    expect(status.body).toMatchObject({ available: false, running: false, reason: "This project has no Playwright config yet." });
    const start = await call("POST");
    expect(start.status).toBe(409);
    expect(start.body.code).toBe("PLAYWRIGHT_UI_UNAVAILABLE");
  });

  it("opens Playwright's UI mode for the project once, and closes it with its browser", async () => {
    root = makePlaywrightProject("pw-ui-real", { "tests/one.spec.ts": 'import { test, expect } from "@playwright/test";\ntest("one", () => expect(1).toBe(1));\n' });
    // PWTEST_UNDER_TEST makes Playwright open the UI mode window headless.
    restoreEnv = setEnv({ PWTEST_UNDER_TEST: "1", ANTHROPIC_API_KEY: FAKE_KEY });
    const launches: UiModeLaunch[] = [];
    let pid: number | undefined;
    server = await startServer({
      root,
      port: 0,
      launchPlaywrightUi: (input) => {
        launches.push(input);
        const child = launchUiMode(input);
        pid = child.pid;
        return child;
      },
    });
    expect((await call("GET")).body).toMatchObject({ available: true, running: false, config: "playwright.config.ts", command: "npx playwright test --ui --config=playwright.config.ts" });

    const opened = await call("POST");
    expect(opened.status).toBe(200);
    expect(opened.body.running).toBe(true);
    expect(launches[0]!.args.slice(1)).toEqual(["test", "--ui", "--config=playwright.config.ts"]);
    expect(launches[0]!.args[0]).toMatch(/cli\.js$/);
    expect(launches[0]!.cwd).toBe(root);
    expect(launches[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();

    // A second click does not open a second window.
    expect((await call("POST")).body.running).toBe(true);
    expect(launches).toHaveLength(1);

    // Still up a few seconds later (a bad flag or config would have ended it by now).
    await new Promise((r) => setTimeout(r, 4_000));
    const running = await call("GET");
    expect(running.body.running).toBe(true);
    expect(running.body.last).toBeUndefined();
    expect(alive(pid)).toBe(true);

    const closed = await call("DELETE");
    expect(closed.body.running).toBe(false);
    expect(closed.body.last).toMatchObject({ closedFromHere: true });
    expect(closed.body.last?.error).toBeUndefined();
    await until(async () => !alive(pid));
  });

  it("keeps credentials for setup projects but removes API keys", async () => {
    root = makePlaywrightProject("pw-ui-env");
    restoreEnv = setEnv({ ANTHROPIC_API_KEY: FAKE_KEY, STAGING_CUSTOMER_PASS: FAKE_PASS });
    const fake = fakeLauncher("setInterval(() => {}, 1000)");
    server = await startServer({ root, port: 0, launchPlaywrightUi: fake.launch });
    await call("POST");
    expect(fake.launches[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(fake.launches[0]!.env.STAGING_CUSTOMER_PASS).toBe(FAKE_PASS);
    await call("DELETE");
  });

  it("shows why Playwright UI stopped when it fails, with secrets redacted", async () => {
    root = makePlaywrightProject("pw-ui-fail");
    restoreEnv = setEnv({ ANTHROPIC_API_KEY: FAKE_KEY });
    const fake = fakeLauncher(`console.error("Error: cannot load config, key ${FAKE_KEY}"); process.exit(3)`);
    server = await startServer({ root, port: 0, launchPlaywrightUi: fake.launch });
    await call("POST");
    await until(async () => !(await call("GET")).body.running);
    const status = (await call("GET")).body;
    expect(status.last).toMatchObject({ code: 3, closedFromHere: false, error: "Playwright UI stopped with exit code 3." });
    expect(status.log.join("\n")).toContain("Error: cannot load config");
    expect(status.log.join("\n")).not.toContain(FAKE_KEY);
  });

  it("closes Playwright UI when the DOMinion server stops", async () => {
    root = makePlaywrightProject("pw-ui-close");
    const fake = fakeLauncher("setInterval(() => {}, 1000)");
    server = await startServer({ root, port: 0, launchPlaywrightUi: fake.launch });
    await call("POST");
    expect(alive(fake.pids[0])).toBe(true);
    await server.close();
    server = undefined;
    await until(async () => !alive(fake.pids[0]));
  });
});
