import { spawn } from "node:child_process";
import type { CommandRunner } from "./prompter";

const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]);

/**
 * Runs a package-manager command with inherited stdio. On Windows these are .cmd shims, which
 * Node can only start through a shell; arguments are quoted to survive that.
 */
export const runInheritedCommand: CommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const useShell = process.platform === "win32" && WINDOWS_SHIMS.has(command);
    // With a shell, pass one pre-quoted command line (Node deprecates args + shell: DEP0190).
    const child = useShell
      ? spawn([command, ...args.map(quoteForCmd)].join(" "), { cwd: options.cwd, stdio: "inherit", shell: true })
      : spawn(command, [...args], { cwd: options.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });

/** A command whose output is captured line by line (the UI shows it while it runs). */
export type CapturedCommandRunner = (command: string, args: readonly string[], options: { cwd: string; onLine: (line: string) => void }) => Promise<number>;

/** Like runInheritedCommand, but streams output lines to `onLine` and gives the command no stdin. */
export const runCapturedCommand: CapturedCommandRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const useShell = process.platform === "win32" && WINDOWS_SHIMS.has(command);
    const env = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
    const child = useShell
      ? spawn([command, ...args.map(quoteForCmd)].join(" "), { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], shell: true, env })
      : spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let pending = "";
    const onData = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLine(line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.trim()) options.onLine(pending);
      resolvePromise(code ?? 1);
    });
  });

/** Quotes an argument for cmd.exe when it contains spaces or shell metacharacters. */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
