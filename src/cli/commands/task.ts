import type { Command } from "commander";
import { autoApproveInteraction, runGenerate, runTask } from "../../core/orchestrator/pipeline";
import { join } from "node:path";
import { applyProposal, proposalDiff, rejectProposal } from "../../core/orchestrator/proposals";
import { RunStore } from "../../core/orchestrator/store";
import type { RunRecord } from "../../core/orchestrator/types";
import type { Prompter } from "../../core/prompter";
import { Redactor } from "../../core/redact";
import { color, line } from "../output";
import { loadCommandContext } from "../context";
import { terminalPrompter } from "../prompter";
import { exitCodeFor, printEvent, printRunSummary, requireApprovalMode, terminalInteraction } from "../run-view";

interface TaskFlags {
  role?: string;
  autoApprove?: boolean;
  planOnly?: boolean;
  model?: string;
  verbose?: boolean;
}

/** Ctrl+C stops the run cleanly (artifacts kept); a second Ctrl+C exits immediately. */
export function abortOnSigint(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let pressed = false;
  const handler = () => {
    if (pressed) process.exit(130);
    pressed = true;
    process.stderr.write("\nStopping the run (press Ctrl+C again to exit immediately)...\n");
    controller.abort();
  };
  process.on("SIGINT", handler);
  return { signal: controller.signal, dispose: () => process.off("SIGINT", handler) };
}

async function finish(run: RunRecord, root: string, prompter: Prompter): Promise<void> {
  printRunSummary(run, root);
  await reviewProposals(run, root, prompter);
  process.exitCode = exitCodeFor(run);
}

/** Shows each change the generator proposed for a hand-written file and applies it on "y". */
export async function reviewProposals(run: RunRecord, root: string, prompter: Prompter): Promise<void> {
  const pending = (run.proposals ?? []).filter((p) => p.status === "pending");
  if (!pending.length) return;
  const handle = new RunStore({ runsDir: join(root, ".dominion", "runs") }, new Redactor()).get(run.id);
  line();
  line(color.bold(`The generator proposed ${pending.length} change${pending.length === 1 ? "" : "s"} to hand-written files (not applied):`));
  for (const proposal of pending) {
    line();
    line(color.cyan(proposal.path));
    line(proposalDiff(handle, proposal.id).trimEnd());
    if (!prompter.interactive) continue;
    if (await prompter.confirm(`Apply this change to ${proposal.path}?`, false)) {
      try {
        applyProposal(handle, root, proposal.id);
        line(color.green(`applied ${proposal.path}`));
      } catch (error) {
        line(color.yellow(error instanceof Error ? error.message : String(error)));
      }
    } else {
      rejectProposal(handle, proposal.id);
    }
  }
  if (!prompter.interactive) line(color.gray(`Proposals are saved under .dominion/runs/${run.id}/proposals/; review them in the UI.`));
}

export function registerTaskCommands(program: Command): void {
  program
    .command("task")
    .description("task mode: plan a flow from a natural-language request, then generate, run and heal its tests")
    .argument("<env>", "environment name from dominion.config.ts")
    .argument("<request>", 'what to test, e.g. "write tests for the add to cart workflow"')
    .option("--role <role>", "role to run as (default: the environment's only logged-in role)")
    .option("--auto-approve", "approve plans without asking (required in CI)")
    .option("--plan-only", "stop after planning")
    .option("--model <model>", "Claude model for the agents (default: config.model)")
    .option("--verbose", "show every agent action and message")
    .action(async (envName: string, request: string, flags: TaskFlags) => {
      requireApprovalMode(flags.autoApprove, flags.planOnly);
      const loaded = await loadCommandContext();
      const prompter = terminalPrompter();
      const sigint = abortOnSigint();
      try {
        const run = await runTask(
          { loaded, envName, roleName: flags.role, request, model: flags.model, autoApprove: flags.autoApprove, planOnly: flags.planOnly },
          {
            interaction: flags.autoApprove ? autoApproveInteraction : terminalInteraction(prompter, loaded.root),
            prompter,
            signal: sigint.signal,
            onEvent: (event) => printEvent(event, { verbose: flags.verbose }),
          },
        );
        await finish(run, loaded.root, prompter);
      } finally {
        sigint.dispose();
      }
    });

  program
    .command("generate")
    .description("generate tests from an existing plan (asks for approval if it is not approved yet)")
    .argument("<spec>", "plan file, e.g. specs/add-to-cart.md")
    .option("--env <env>", "environment (default: the plan's env)")
    .option("--role <role>", "role (default: the plan's role)")
    .option("--auto-approve", "approve the plan without asking if it is still a draft")
    .option("--model <model>", "Claude model for the agents")
    .option("--verbose", "show every agent action and message")
    .action(async (spec: string, flags: TaskFlags & { env?: string }) => {
      const loaded = await loadCommandContext();
      const prompter = terminalPrompter();
      const sigint = abortOnSigint();
      try {
        const run = await runGenerate(
          { loaded, planPath: spec, envName: flags.env, roleName: flags.role, model: flags.model, autoApprove: flags.autoApprove },
          {
            interaction: flags.autoApprove ? autoApproveInteraction : terminalInteraction(prompter, loaded.root),
            prompter,
            signal: sigint.signal,
            onEvent: (event) => printEvent(event, { verbose: flags.verbose }),
          },
        );
        await finish(run, loaded.root, prompter);
      } finally {
        sigint.dispose();
      }
    });
}
