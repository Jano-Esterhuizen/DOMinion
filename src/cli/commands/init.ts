import type { Command } from "commander";
import { analyzeConventions } from "../../core/agents/analysis";
import { createSdkAgentRunner } from "../../core/agents/runner";
import { detectApiCredential } from "../../core/doctor";
import { AUTHORIZED_USE_NOTICE, type InitResult, runInit } from "../../core/init";
import { runInheritedCommand } from "../../core/process";
import { color, line, warn } from "../output";
import { terminalPrompter } from "../prompter";

interface InitFlags {
  baseUrl?: string;
  yes?: boolean;
  playwrightConfig?: string;
  analyze?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("scaffold dominion.config.ts, the login script, .env.local, .gitignore entries and folders; adopts an existing Playwright suite's conventions")
    .option("--base-url <url>", "base URL of the environment to test, e.g. https://staging.example.com")
    .option("--playwright-config <path>", "which playwright.config to adopt when the repo has several")
    .option("--no-analyze", "skip the conventions analysis agent for existing suites")
    .option("-y, --yes", "accept defaults without prompting (for CI)")
    .action(async (flags: InitFlags) => {
      const prompter = terminalPrompter({ yes: flags.yes });
      const credential = detectApiCredential();
      const result = await runInit({
        root: process.cwd(),
        baseURL: flags.baseUrl,
        yes: flags.yes,
        playwrightConfig: flags.playwrightConfig,
        prompter,
        runCommand: runInheritedCommand,
        onProfile: (source, notes) => {
          line();
          line(color.bold("Detected project profile (your suite's conventions):"));
          line(color.cyan(source));
          for (const note of notes) line(color.gray(`  note: ${note}`));
          line();
        },
        analyzeConventions:
          flags.analyze !== false && credential
            ? async (input) => {
                const go = await prompter.confirm("Run a short analysis agent to summarise your test conventions (costs a few cents)?", true);
                if (!go) return undefined;
                line(color.gray("Analysing your suite's conventions..."));
                return analyzeConventions({ ...input, runner: createSdkAgentRunner(), model: "claude-sonnet-5-5" });
              }
            : undefined,
      });
      printInitResult(result);
    });
}

const STATUS_COLOR = { created: color.green, updated: color.blue, skipped: color.gray } as const;

export function printInitResult(result: InitResult): void {
  const context = [result.packageManager, result.playwrightConfig ?? "no Playwright config", result.mode === "existing" ? "existing suite" : "new setup"].join(", ");
  line(`${color.bold("DOMinion init")} ${color.gray(`(${context})`)}`);
  line();
  const width = Math.max(...result.files.map((f) => f.path.length));
  for (const file of result.files) {
    const status = STATUS_COLOR[file.status](file.status.padEnd(7));
    const path = file.detail ? file.path.padEnd(width) : file.path;
    const detail = file.detail ? color.gray(`  ${file.detail}`) : "";
    line(`  ${status}  ${path}${detail}`);
  }
  if (result.warnings.length) {
    line();
    for (const message of result.warnings) warn(message);
  }
  line();
  line(color.yellow(AUTHORIZED_USE_NOTICE));
  line();
  line(color.bold("Next steps"));
  result.nextSteps.forEach((step, index) => line(`  ${index + 1}. ${step}`));
}
