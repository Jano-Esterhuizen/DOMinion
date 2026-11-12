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

/** Quotes an argument for cmd.exe when it contains spaces or shell metacharacters. */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
