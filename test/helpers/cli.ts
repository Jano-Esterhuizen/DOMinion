import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./tmp";

export const CLI_PATH = join(REPO_ROOT, "dist", "cli", "index.js");

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI asynchronously. Never use spawnSync for commands that talk to a server running
 * in the test process (such as the fixture app): it blocks the event loop and deadlocks.
 */
export function runCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", CI: "1", ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Builds dist/ with tsup (synchronous; safe because nothing else runs in the test process yet). */
export function buildCli(): void {
  const build = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules", "tsup", "dist", "cli-default.js")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
}
