import type { Command } from "commander";
import { DominionError } from "../../core/errors";
import { runCrawl } from "../../core/orchestrator/crawl";
import { autoApproveInteraction, type RunInteraction } from "../../core/orchestrator/pipeline";
import type { DiscoveredFlow } from "../../core/orchestrator/types";
import type { Prompter } from "../../core/prompter";
import { loadCommandContext } from "../context";
import { color, line } from "../output";
import { canPrompt, terminalPrompter } from "../prompter";
import { exitCodeFor, printEvent, printRunSummary, terminalInteraction } from "../run-view";
import { abortOnSigint, reviewProposals } from "./task";

interface CrawlFlags {
  role?: string;
  maxPages?: string;
  flows?: string;
  autoApprove?: boolean;
  planOnly?: boolean;
  model?: string;
  verbose?: boolean;
}

/** Parses "1,3", "critical", "all" or "none" against the discovered flows. */
export function parseFlowSelection(answer: string, flows: readonly DiscoveredFlow[]): string[] | undefined {
  const value = answer.trim().toLowerCase();
  if (!value || value === "critical") return flows.filter((f) => f.priority === "critical").map((f) => f.id);
  if (value === "all") return flows.map((f) => f.id);
  if (value === "none") return [];
  const ids: string[] = [];
  for (const part of value.split(/[\s,]+/).filter(Boolean)) {
    const index = Number(part);
    const byNumber = Number.isInteger(index) ? flows[index - 1] : undefined;
    const flow = byNumber ?? flows.find((f) => f.id === part);
    if (!flow) return undefined;
    if (!ids.includes(flow.id)) ids.push(flow.id);
  }
  return ids;
}

/** Terminal flow selection (the Flows screen's CLI equivalent). */
export function terminalFlowSelection(prompter: Prompter): Pick<RunInteraction, "selectFlows"> {
  return {
    async selectFlows({ flows }) {
      line();
      line(color.bold("Discovered flows:"));
      flows.forEach((flow, i) => {
        const coverage = flow.coverage?.status === "covered" ? color.green("covered") : flow.coverage?.status === "partly" ? color.yellow("partly covered") : color.gray("not covered");
        line(`  ${String(i + 1).padStart(2)}. ${flow.name} ${color.gray(`[${flow.priority}${flow.destructive ? ", destructive" : ""}]`)} ${coverage}`);
        line(color.gray(`      ${flow.id} · ${flow.startUrl} · ${flow.description}`));
      });
      for (;;) {
        const answer = await prompter.input("Which flows should DOMinion plan? (numbers like 1,3 · critical · all · none)", "critical");
        const ids = parseFlowSelection(answer, flows);
        if (ids) return ids;
        line(color.yellow("Use flow numbers or ids from the list, or critical / all / none."));
      }
    },
  };
}

export function registerCrawlCommand(program: Command): void {
  program
    .command("crawl")
    .description("crawl mode: crawl the site, discover its critical flows, then plan (and generate) the selected ones")
    .argument("<env>", "environment name from dominion.config.ts")
    .option("--role <role>", "role to crawl as")
    .option("--max-pages <n>", "maximum pages to crawl (default: crawl.maxPages)")
    .option("--flows <ids>", "comma-separated flow ids to plan, skipping the selection prompt")
    .option("--auto-approve", "plan all critical flows (unless --flows) and approve plans without asking (CI)")
    .option("--plan-only", "stop after planning (recommended for scheduled discovery jobs)")
    .option("--model <model>", "Claude model for the agents")
    .option("--verbose", "show every agent action and message")
    .action(async (envName: string, flags: CrawlFlags) => {
      let maxPages: number | undefined;
      if (flags.maxPages !== undefined) {
        maxPages = Number(flags.maxPages);
        if (!Number.isInteger(maxPages) || maxPages < 1) throw new DominionError(`--max-pages must be a positive whole number (got "${flags.maxPages}").`, { code: "BAD_FLAG" });
      }
      const flowIds = flags.flows?.split(",").map((s) => s.trim()).filter(Boolean);
      if (!canPrompt() && !flags.autoApprove && !(flowIds?.length && flags.planOnly)) {
        throw new DominionError("No terminal to choose flows and approve plans in.", {
          code: "AUTO_APPROVE_REQUIRED",
          hint: "In CI pass --auto-approve (and --plan-only for scheduled discovery jobs), or --flows <ids> --plan-only.",
        });
      }
      const loaded = await loadCommandContext();
      const prompter = terminalPrompter();
      const sigint = abortOnSigint();
      try {
        const interaction: RunInteraction = flags.autoApprove ? autoApproveInteraction : { ...terminalInteraction(prompter, loaded.root), ...terminalFlowSelection(prompter) };
        const run = await runCrawl(
          { loaded, envName, roleName: flags.role, maxPages, flowIds, autoApprove: flags.autoApprove, planOnly: flags.planOnly, model: flags.model },
          { interaction, prompter, signal: sigint.signal, onEvent: (event) => printEvent(event, { verbose: flags.verbose }) },
        );
        printRunSummary(run, loaded.root);
        if (run.discoveredFlows?.length) {
          line(color.gray(`Discovered flows: ${run.discoveredFlows.map((f) => `${f.id} (${f.priority})`).join(", ")}`));
        }
        await reviewProposals(run, loaded.root, prompter);
        process.exitCode = exitCodeFor(run);
      } finally {
        sigint.dispose();
      }
    });
}
