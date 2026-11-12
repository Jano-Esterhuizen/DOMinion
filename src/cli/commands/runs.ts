import type { Command } from "commander";
import { DominionError } from "../../core/errors";
import type { RunStage } from "../../core/events";
import { listRuns, type RunSummary } from "../../core/runs/list";
import { loadCommandContext } from "../context";
import { color, line } from "../output";

interface RunsFlags {
  json?: boolean;
  limit?: string;
  env?: string;
  status?: string;
}

const STAGES: readonly RunStage[] = ["created", "crawling", "discovering", "awaiting_flow_selection", "planning", "awaiting_approval", "generating", "running", "healing", "done", "failed", "stopped"];

function statusText(summary: RunSummary): string {
  if (summary.status === "done") return color.green("done");
  if (summary.status === "failed") return color.red("failed");
  if (summary.status === "stopped") return color.yellow("stopped");
  return color.cyan(summary.status.replace(/_/g, " "));
}

function testsText(summary: RunSummary): string {
  const t = summary.tests;
  const parts = [
    t.passed ? color.green(`${t.passed} passed`) : "",
    t.failed || t.timedOut ? color.red(`${(t.failed ?? 0) + (t.timedOut ?? 0)} failed`) : "",
    t.fixme ? color.yellow(`${t.fixme} fixme`) : "",
    t.skipped ? `${t.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.join(", ") || color.gray("-");
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Column widths ignore ANSI color codes.
const visible = (text: string) => text.replace(/\u001b\[\d+m/g, "");
const pad = (text: string, width: number) => text + " ".repeat(Math.max(width - visible(text).length, 0));

/** Prints runs as an aligned table: ID, mode, env/role, status, tests, cost, started, request. */
export function printRunsTable(runs: readonly RunSummary[]): void {
  const rows = runs.map((r) => [
    r.id,
    r.mode,
    `${r.env}/${r.role}`,
    statusText(r),
    testsText(r),
    `$${r.costUsd.toFixed(2)}`,
    when(r.createdAt),
    r.request ? (r.request.length > 50 ? `${r.request.slice(0, 47)}...` : r.request) : r.mode === "crawl" ? `${r.flows} flow${r.flows === 1 ? "" : "s"}` : "",
  ]);
  const header = ["RUN", "MODE", "ENV/ROLE", "STATUS", "TESTS", "COST", "STARTED", "REQUEST"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => visible(row[i]!).length)));
  line(color.bold(header.map((h, i) => pad(h, widths[i]!)).join("  ").trimEnd()));
  for (const row of rows) line(row.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd());
}

/** `dominion runs`: lists past runs with status and cost (spec: CLI). */
export function registerRunsCommand(program: Command): void {
  program
    .command("runs")
    .description("list past runs with status, test results and cost")
    .option("--json", "print the runs as JSON")
    .option("--limit <n>", "show at most n runs (default 20; 0 for all)")
    .option("--env <env>", "only runs against this environment")
    .option("--status <status>", `only runs with this status (${STAGES.join(", ")})`)
    .action(async (flags: RunsFlags) => {
      const limit = flags.limit === undefined ? 20 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        throw new DominionError(`--limit must be a whole number, got "${flags.limit}".`, { code: "INVALID_FLAG", hint: "For example --limit 50, or --limit 0 for every run." });
      }
      if (flags.status && !STAGES.includes(flags.status as RunStage)) {
        throw new DominionError(`Unknown run status "${flags.status}".`, { code: "INVALID_FLAG", hint: `Use one of: ${STAGES.join(", ")}.` });
      }
      const loaded = await loadCommandContext();
      const all = listRuns(loaded, { env: flags.env, status: flags.status as RunStage | undefined });
      const runs = limit === 0 ? all : all.slice(0, limit);
      if (flags.json) {
        line(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        line(all.length === 0 && !flags.env && !flags.status ? "No runs yet. Start one with `npx dominion task <env> \"<request>\"` or `npx dominion crawl <env>`." : "No runs match.");
        return;
      }
      printRunsTable(runs);
      const total = runs.reduce((sum, r) => sum + r.costUsd, 0);
      line();
      line(
        color.gray(
          `${runs.length} of ${all.length} run${all.length === 1 ? "" : "s"}, $${total.toFixed(2)} total${runs.length < all.length ? ` (use --limit 0 to see all)` : ""}. Details: .dominion/runs/<id>/run.json, or open the run in \`npx dominion ui\`.`,
        ),
      );
    });
}
