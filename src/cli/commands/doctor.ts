import type { Command } from "commander";
import { type CheckStatus, runDoctor } from "../../core/doctor";
import { redactorFor, redactorFromConfig, setActiveRedactor } from "../../core/redact";
import { color, line } from "../output";

interface DoctorFlags {
  env?: string;
  sessions?: boolean;
}

const ICON: Record<CheckStatus, string> = {
  ok: color.green("ok   "),
  warn: color.yellow("warn "),
  error: color.red("error"),
  skip: color.gray("skip "),
};

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("check Node and Playwright versions, config, env vars, sessions and the API key")
    .option("--env <env>", "only check this environment")
    .option("--no-sessions", "do not open a browser to validate saved sessions")
    .action(async (flags: DoctorFlags) => {
      setActiveRedactor(redactorFromConfig(undefined));
      const report = await runDoctor({ envName: flags.env, validateSessions: flags.sessions !== false });
      if (report.loaded) setActiveRedactor(redactorFor(report.loaded));
      line(color.bold("DOMinion doctor"));
      line();
      for (const check of report.checks) {
        line(`  ${ICON[check.status]}  ${check.title}${check.detail ? color.gray(`  ${check.detail}`) : ""}`);
        if (check.hint && check.status !== "ok") line(`         ${color.gray(`-> ${check.hint}`)}`);
      }
      line();
      const errors = report.checks.filter((c) => c.status === "error").length;
      const warnings = report.checks.filter((c) => c.status === "warn").length;
      if (report.ok) {
        line(color.green(`All required checks passed${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`));
      } else {
        line(color.red(`${errors} check${errors === 1 ? "" : "s"} failed.`));
        process.exitCode = 1;
      }
    });
}
