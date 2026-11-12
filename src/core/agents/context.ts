import { readSessionHeaders } from "../auth/headers";
import type { LoadedConfig } from "../config/loader";
import type { ProjectPaths, ResolvedEnvironment } from "../config/resolve";
import { referencedEnvVars } from "../config/resolve";
import type { RoleConfig } from "../config/schema";
import { buildMcpLaunch, type McpLaunch } from "../mcp";
import type { RunHandle } from "../orchestrator/store";
import type { Redactor } from "../redact";
import type { AgentRunner } from "./runner";

/** Everything an agent module needs from the running pipeline. */
export interface AgentContext {
  loaded: LoadedConfig;
  paths: ProjectPaths;
  env: ResolvedEnvironment;
  roleName: string;
  role: RoleConfig;
  /** Absolute path of the role's storage state; undefined for guests. */
  storageState?: string;
  run: RunHandle;
  runner: AgentRunner;
  redactor: Redactor;
  model: string;
  signal: AbortSignal;
  /** USD left in the run's budget. */
  remainingBudget: () => number;
  /** Records a proposed change to a hand-written file (existing projects, modifyExisting: false). */
  onProposal?: (absPath: string, before: string, after: string, flowId?: string) => void;
}

/** The Playwright MCP server for this run (writes .dominion/runs/<id>/mcp.json). */
export function mcpForRun(ctx: AgentContext, secretsFile?: string): McpLaunch {
  return buildMcpLaunch({
    env: ctx.env,
    storageState: ctx.storageState,
    extraHTTPHeaders: readSessionHeaders(ctx.storageState),
    configPath: ctx.run.path("mcp.json"),
    outputDir: ctx.run.path("mcp-output"),
    testIdAttribute: ctx.loaded.config.testIdAttribute,
    agentBrowser: ctx.loaded.config.agentBrowser,
    secretsFile,
  });
}

/** Credential env var names hidden from agent processes. */
export function credentialEnvVars(ctx: AgentContext): string[] {
  return [...new Set([...referencedEnvVars(ctx.loaded.config).map((r) => r.name), ...ctx.loaded.config.secretEnv])];
}

/** The irreversible-action rule for prompts (spec: Security and safety). */
export function destructiveRule(env: ResolvedEnvironment): string {
  return env.allowDestructive
    ? `Irreversible actions (pay, place order, submit, delete, send) ARE allowed in "${env.name}", but only when the flow needs them. Mark scenarios that perform one with "(destructive)" in their title.`
    : `Irreversible actions are NOT allowed in "${env.name}". Never click the final button of a pay, place order, submit order, delete, send or similar irreversible action. End any such scenario right before that action and say so explicitly in the plan, for example: 'Stop before clicking "Place order" (irreversible; not allowed in ${env.name}).'`;
}

/** How every generated test starts: the seed test the planner and generator are shown. */
export function seedTest(ctx: AgentContext, importLine: string): string {
  const session = ctx.storageState
    ? `// The project's storageState is the saved "${ctx.roleName}" session, so the page is already logged in.`
    : `// "${ctx.roleName}" is a guest role: the page starts logged out with a fresh context.`;
  return [
    importLine,
    "",
    `test("seed", async ({ page }) => {`,
    `  // baseURL is ${ctx.env.baseURL}; navigate with relative paths.`,
    `  ${session}`,
    `  await page.goto("/");`,
    "});",
  ].join("\n");
}

export function roleDescription(ctx: AgentContext): string {
  return ctx.storageState ? `logged in with the saved "${ctx.roleName}" session` : `"${ctx.roleName}" (guest, not logged in)`;
}
