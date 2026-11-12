import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DominionError } from "../core/errors";
import type { DominionEvent } from "../core/events";
import { relativePosix } from "../core/fs";
import { type PlanDecision, type RunInteraction, summarizeResults } from "../core/orchestrator/pipeline";
import type { RunRecord } from "../core/orchestrator/types";
import { readPlan } from "../core/plans";
import type { Prompter } from "../core/prompter";
import { color, line } from "./output";
import { canPrompt } from "./prompter";

/** Prints run events as a compact live log. */
export function printEvent(event: DominionEvent, options: { verbose?: boolean } = {}): void {
  const flow = "flowId" in event && event.flowId ? color.gray(`[${event.flowId}] `) : "";
  switch (event.type) {
    case "run.created":
      line(`${color.bold("DOMinion")} run ${color.cyan(event.runId)} ${color.gray(`(${event.env}/${event.role}, ${event.model})`)}`);
      break;
    case "run.stage_changed":
      if (!["done", "failed", "stopped"].includes(event.stage)) line(`\n${flow}${color.bold(`> ${event.stage.replace(/_/g, " ")}`)}${event.message ? ` ${event.message}` : ""}`);
      break;
    case "session.ready":
      line(`${color.gray("  session")} ${event.role}: ${event.action}${event.state ? ` (${event.state})` : ""}`);
      break;
    case "agent.started":
      line(`${color.gray(`  ${event.agent} started`)}`);
      break;
    case "agent.tool_call":
      if (options.verbose || !/^(Read|Glob|Grep)$/.test(event.tool)) line(`${color.gray("  ·")} ${flow}${event.summary}`);
      break;
    case "agent.tool_result":
      if (!event.ok && event.summary) line(`    ${color.yellow("!")} ${event.summary}`);
      else if (event.summary && /^verified/.test(event.summary)) line(`    ${color.green("✓")} ${color.gray(event.summary)}`);
      break;
    case "agent.denied":
      line(`    ${color.yellow("blocked")} ${event.tool}: ${event.reason.split("\n")[0]}`);
      break;
    case "agent.message":
      if (options.verbose) line(color.gray(`  ${event.agent}: ${event.text.split("\n")[0]?.slice(0, 160)}`));
      break;
    case "agent.finished":
      line(color.gray(`  ${event.agent} finished: ${event.subtype}, ${event.turns} turns, $${event.costUsd.toFixed(2)}`));
      break;
    case "plan.ready":
      line(`  ${color.green("plan")} ${event.planPath}`);
      break;
    case "plan.approved":
      line(`  ${color.green("approved")} ${event.planPath}`);
      break;
    case "plan.rejected":
      line(`  ${color.yellow("rejected")} ${event.planPath}${event.feedback ? `: ${event.feedback}` : ""}`);
      break;
    case "files.changed":
      for (const f of event.files) line(`  ${color.blue(f.kind.padEnd(8))} ${f.path}`);
      break;
    case "lint.result":
      for (const w of event.warnings) line(`  ${color.yellow("lint")} ${w}`);
      for (const e of event.errors) line(`  ${color.red("lint")} ${e}`);
      break;
    case "test.result": {
      const mark =
        event.status === "passed" ? color.green("passed") : event.status === "fixme" ? color.yellow("fixme ") : event.status === "skipped" ? color.gray("skipped") : color.red(event.status.padEnd(6));
      line(`  ${mark} ${event.title} ${color.gray(`(${event.durationMs} ms)`)}`);
      if (event.error && event.status !== "passed") line(color.gray(`         ${event.error.split("\n")[0]}`));
      break;
    }
    case "heal.attempt":
      line(`  ${color.blue("heal")} ${event.title} (attempt ${event.attempt}/${event.max})`);
      break;
    case "heal.result":
      line(`  ${event.outcome === "fixed" ? color.green("healed") : color.yellow(event.outcome)} ${event.title}${event.reason ? `: ${event.reason}` : ""}`);
      break;
    case "cost.updated":
      line(color.gray(`  cost $${event.totalUsd.toFixed(2)} of $${event.budgetUsd.toFixed(2)}`));
      break;
    case "run.error":
      line(`${color.red("error")} ${flow}${event.message}`);
      if (event.hint) line(color.gray(`  -> ${event.hint}`));
      break;
    case "run.paused":
      line(`${color.yellow("paused")} ${event.reason}`);
      break;
    case "crawl.page":
      line(`${color.gray("  crawled")} ${event.pattern} ${color.gray(`(${event.status}, depth ${event.depth})`)}`);
      break;
    case "crawl.finished":
      line(`  ${color.green("crawl")} ${event.pages} pages, ${event.patterns} patterns${event.stoppedReason && event.stoppedReason !== "complete" ? ` (stopped: ${event.stoppedReason})` : ""}`);
      break;
    case "flows.discovered":
      line(`  ${color.green("discovered")} ${event.flows.map((f) => `${f.id} [${f.priority}]`).join(", ")}`);
      break;
    case "flows.selected":
      line(`  ${color.green("selected")} ${event.flowIds.join(", ") || "none"}`);
      break;
    case "log":
      line(`  ${event.level === "warn" ? color.yellow("warn") : event.level === "error" ? color.red("error") : color.gray("info")} ${event.message}`);
      break;
    default:
      break;
  }
}

function openInEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  return new Promise((resolve, reject) => {
    const child = spawn(`${editor} "${path}"`, { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

/** Terminal plan approval: y / n / edit / regenerate with feedback (spec: CLI). */
export function terminalInteraction(prompter: Prompter, root: string): RunInteraction {
  return {
    async approvePlan({ flow, planPath, scenarios }): Promise<PlanDecision> {
      const rel = relativePosix(root, planPath);
      if (!prompter.interactive) {
        throw new DominionError(`${rel} needs approval, but there is no terminal to approve it in.`, {
          code: "AUTO_APPROVE_REQUIRED",
          hint: "Approve it in the UI, run the command in a terminal, or pass --auto-approve (CI).",
        });
      }
      for (;;) {
        const list = scenarios.length ? scenarios : existsSync(planPath) ? [...readPlan(planPath).body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]!) : [];
        line();
        line(`${color.bold("Plan ready for review:")} ${rel} ${color.gray(`(${flow.name})`)}`);
        list.forEach((s) => line(`  - ${s}`));
        const answer = (await prompter.input("Approve? [y]es / [n]o (reject) / [e]dit / [r]egenerate with feedback", "")).trim().toLowerCase();
        if (["y", "yes"].includes(answer)) return { action: "approve" };
        if (["n", "no"].includes(answer)) {
          const feedback = (await prompter.input("Why? (optional, saved with the run)", "")).trim();
          return { action: "reject", feedback: feedback || undefined };
        }
        if (["e", "edit"].includes(answer)) {
          line(color.gray(`Opening ${rel}; save and close the editor to continue.`));
          await openInEditor(planPath);
          scenarios = [];
          continue;
        }
        if (["r", "regenerate"].includes(answer)) {
          const feedback = (await prompter.input("What should change?", "")).trim();
          if (feedback) return { action: "regenerate", feedback };
        }
      }
    },
  };
}

/** CI needs --auto-approve: there is nobody to answer the approval prompt. */
export function requireApprovalMode(autoApprove: boolean | undefined, planOnly: boolean | undefined): void {
  if (!autoApprove && !planOnly && !canPrompt()) {
    throw new DominionError("No terminal to approve plans in.", {
      code: "AUTO_APPROVE_REQUIRED",
      hint: "In CI pass --auto-approve (and --plan-only for scheduled discovery jobs).",
    });
  }
}

export function printRunSummary(run: RunRecord, root: string): void {
  line();
  const status = run.status === "done" ? color.green("done") : run.status === "stopped" ? color.yellow("stopped") : color.red(run.status);
  line(`${color.bold("Run")} ${run.id}: ${status} ${color.gray(`($${run.costUsd.toFixed(2)} of $${run.budgetUsd.toFixed(2)})`)}`);
  for (const flow of run.flows) {
    line(`  ${flow.name} ${color.gray(`[${flow.status}]`)}`);
    if (flow.planPath) line(`    plan   ${flow.planPath}`);
    for (const spec of flow.specFiles) line(`    spec   ${spec}`);
    for (const support of flow.supportFiles) line(`    file   ${support}`);
    if (flow.results?.length) line(`    tests  ${summarizeResults(flow.results)}`);
  }
  if (run.error) {
    line(`  ${color.red("error")} ${run.error.message}`);
    if (run.error.hint) line(color.gray(`    -> ${run.error.hint}`));
  }
  if (run.changedFiles.length) {
    line();
    line(color.gray(`Review the changes (${run.changedFiles.map((c) => c.path).join(", ")}) and commit them through your normal git workflow.`));
  }
  line(color.gray(`Run log: ${relativePosix(process.cwd(), `${root}/.dominion/runs/${run.id}`)}`));
}

/** Exit code: failed/stopped runs and failing tests are non-zero so CI notices. */
export function exitCodeFor(run: RunRecord): number {
  if (run.status !== "done") return 1;
  const failing = run.flows.flatMap((f) => f.results ?? []).some((r) => r.status === "failed" || r.status === "timedOut");
  // Generated tests that never ran (for example, the Playwright config could not be patched) are not a success.
  const notRun = !run.options.planOnly && run.flows.some((f) => f.specFiles.length > 0 && !(f.results?.length));
  return failing || notRun ? 1 : 0;
}
