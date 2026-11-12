import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { relativePosix } from "../fs";
import { assertionCount, testTitles } from "../playwright/fixme";
import { formatLintIssues, hasDominionHeader, lintErrors, lintGeneratedFile } from "../playwright/lint";
import { SETUP_FILE_NAME } from "../playwright/patch";
import { type AgentContext, credentialEnvVars, destructiveRule, mcpForRun, roleDescription } from "./context";
import { BROWSER_INPUT_TOOLS, BROWSER_READ_TOOLS, BROWSER_VERIFY_TOOLS } from "./guard";
import { renderPrompt } from "./prompts";
import type { AgentResult } from "./runner";

export interface FailingTest {
  /** Absolute path of the spec file. */
  file: string;
  /** Full title path joined with " > ". */
  title: string;
  line: number;
  column: number;
  error?: string;
  tracePath?: string;
  errorContextPath?: string;
}

const MAX_CONTEXT_CHARS = 12_000;

/** Flow and role tags from a spec's describe title ("@flow:x @role:y"). */
export function specTags(source: string): { flow?: string; role?: string } {
  const describe = /\btest\.describe(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(source)?.[2] ?? "";
  return { flow: /@flow:([\w-]+)/.exec(describe)?.[1], role: /@role:([\w-]+)/.exec(describe)?.[1] };
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (x: string[]) => [...x].sort().join("\u0000");
  return sorted(a) === sorted(b);
}

/**
 * Content check for healer edits: the rules still apply, hand-written files are off-limits unless
 * --include-manual, and an edit may not remove assertions or tests (spec: "must not change what a
 * test checks") unless it marks the test fixme.
 */
export function healerContentCheck(ctx: AgentContext, includeManual: boolean) {
  return (absPath: string, next: string): string | undefined => {
    const rel = relativePosix(ctx.paths.root, absPath);
    if (basename(absPath).toLowerCase() === SETUP_FILE_NAME) return `${rel} is managed by DOMinion and cannot be edited.`;
    const current = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
    const owned = hasDominionHeader(current);
    if (current && !owned && !includeManual) {
      return `${rel} was written by a person (no DOMinion header). The healer only edits DOMinion-generated files; run \`dominion heal --include-manual\` to allow it.`;
    }
    const isSpec = /\.(spec|test)\.(ts|js|mjs|cjs)$/.test(absPath);
    const tags = specTags(current);
    const issues = lintGeneratedFile(next, {
      kind: !owned ? "support" : isSpec ? "spec" : "page-object",
      flowSlug: owned && isSpec ? tags.flow : undefined,
      role: owned && isSpec ? tags.role : undefined,
      redactor: ctx.redactor,
      baseURL: ctx.env.baseURL,
    });
    const problems = lintErrors(issues).map((i) => formatLintIssues(rel, [i]));
    if (isSpec && current) {
      const addsFixme = (next.match(/\.fixme\s*\(/g) ?? []).length > (current.match(/\.fixme\s*\(/g) ?? []).length;
      if (assertionCount(next) < assertionCount(current) && !addsFixme) {
        problems.push(`${rel}: the edit removes assertions. Fix locators, waits or volatile values instead, or mark the test test.fixme() with a reason.`);
      }
      if (!sameMultiset(testTitles(next), testTitles(current))) {
        problems.push(`${rel}: the edit renames, adds or removes tests. Keep every test and its title.`);
      }
    }
    return problems.length ? problems.join("\n") : undefined;
  };
}

function readContext(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)` : text;
}

export function buildHealerPrompt(ctx: AgentContext, failing: FailingTest, attempt: number, max: number): string {
  const rel = relativePosix(ctx.paths.root, failing.file);
  const source = readFileSync(failing.file, "utf8");
  const errorContext = readContext(failing.errorContextPath);
  const lines = [
    `Heal this failing test (attempt ${attempt} of ${max}).`,
    "",
    `File: ${rel} (line ${failing.line})`,
    `Test: ${failing.title}`,
    `Environment: ${ctx.env.name} (base URL ${ctx.env.baseURL}); role: ${roleDescription(ctx)}.`,
    `Irreversible actions: ${destructiveRule(ctx.env)}`,
    failing.tracePath ? `Trace (for humans; you cannot open it): ${relativePosix(ctx.paths.root, failing.tracePath)}` : "",
    "",
    "Error:",
    "```",
    ctx.redactor.redact((failing.error ?? "unknown error").slice(0, 4000)),
    "```",
  ];
  if (errorContext) lines.push("", "Page snapshot and context captured when the test failed:", "```", ctx.redactor.redact(errorContext), "```");
  lines.push("", `Current content of ${rel}:`, "```ts", source, "```");
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/** Runs the healer agent once for one failing test. DOMinion re-runs the test afterwards. */
export async function runHealer(
  ctx: AgentContext,
  failing: FailingTest,
  options: { attempt: number; max: number; flowId?: string; includeManual?: boolean },
): Promise<AgentResult> {
  const profile = ctx.loaded.config.project;
  const pageObjectsDir = profile?.pageObjects ? resolve(ctx.paths.root, profile.pageObjects.dir) : join(ctx.paths.testDir, "pages");
  return ctx.runner.run(
    {
      agent: "healer",
      flowId: options.flowId,
      model: ctx.model,
      systemPrompt: renderPrompt("healer", { testIdAttribute: ctx.loaded.config.testIdAttribute }, ctx.paths.promptOverridesDir, ctx.paths.root),
      prompt: buildHealerPrompt(ctx, failing, options.attempt, options.max),
      maxTurns: ctx.loaded.config.budgets.maxTurnsPerAgent,
      maxBudgetUsd: ctx.remainingBudget(),
      cwd: ctx.paths.root,
      mcp: mcpForRun(ctx),
      screenshotDir: ctx.run.path("screenshots"),
      hiddenEnvVars: credentialEnvVars(ctx),
      signal: ctx.signal,
      policy: {
        agent: "healer",
        root: ctx.paths.root,
        builtinTools: ["Read", "Edit", "MultiEdit", "Glob", "Grep"],
        mcpTools: [...BROWSER_READ_TOOLS, ...BROWSER_INPUT_TOOLS, ...BROWSER_VERIFY_TOOLS],
        readRoots: [ctx.paths.testDir, dirname(failing.file), ...(ctx.loaded.config.project ? [resolve(ctx.paths.root, ctx.loaded.config.project.testDir)] : [])],
        writeRoots: [failing.file, pageObjectsDir],
        writeExtensions: [".ts", ".js", ".mjs", ".cjs"],
        checkContent: healerContentCheck(ctx, options.includeManual ?? false),
        env: ctx.env,
        excludePatterns: ctx.loaded.config.crawl.exclude,
        redactor: ctx.redactor,
      },
    },
    (payload) => ctx.run.emit(payload),
  );
}
