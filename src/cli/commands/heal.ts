import type { Command } from "commander";
import { autoApproveInteraction, runHeal } from "../../core/orchestrator/pipeline";
import { DominionError } from "../../core/errors";
import { loadCommandContext } from "../context";
import { terminalPrompter } from "../prompter";
import { exitCodeFor, printEvent, printRunSummary } from "../run-view";
import { abortOnSigint } from "./task";

interface HealFlags {
  env?: string;
  role?: string;
  maxAttempts?: string;
  includeManual?: boolean;
  model?: string;
  verbose?: boolean;
}

export function registerHealCommand(program: Command): void {
  program
    .command("heal")
    .description("run DOMinion's tests and heal failures (broken locators, waits, assertions); broken app behaviour becomes test.fixme")
    .argument("[file]", "a spec file to heal (default: every DOMinion-generated spec for the role)")
    .option("--env <env>", "environment (default: the only one configured)")
    .option("--role <role>", "role (default: from the specs' @role tag)")
    .option("--max-attempts <n>", "heal attempts per test (default: budgets.maxHealAttempts)")
    .option("--include-manual", "also heal hand-written tests (files without the DOMinion header)")
    .option("--model <model>", "Claude model for the healer")
    .option("--verbose", "show every agent action and message")
    .action(async (file: string | undefined, flags: HealFlags) => {
      let maxAttempts: number | undefined;
      if (flags.maxAttempts !== undefined) {
        maxAttempts = Number(flags.maxAttempts);
        if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
          throw new DominionError(`--max-attempts must be a whole number (got "${flags.maxAttempts}").`, { code: "BAD_FLAG" });
        }
      }
      const loaded = await loadCommandContext();
      const sigint = abortOnSigint();
      try {
        const run = await runHeal(
          { loaded, file, envName: flags.env, roleName: flags.role, model: flags.model, maxAttempts, includeManual: flags.includeManual },
          { interaction: autoApproveInteraction, prompter: terminalPrompter(), signal: sigint.signal, onEvent: (event) => printEvent(event, { verbose: flags.verbose }) },
        );
        printRunSummary(run, loaded.root);
        process.exitCode = exitCodeFor(run);
      } finally {
        sigint.dispose();
      }
    });
}
