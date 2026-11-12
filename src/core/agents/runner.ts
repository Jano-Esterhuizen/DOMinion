import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentName, DominionEventPayload } from "../events";
import { errorMessage } from "../errors";
import type { McpLaunch } from "../mcp";
import { packageVersion } from "../package-info";
import { evaluateToolCall, type ToolPolicy } from "./guard";
import { parseToolResultText, shortToolName, summarizeToolCall, summarizeToolResult, toolResultContent } from "./messages";

/** One agent invocation: a single query() call (spec: Agent SDK usage). */
export interface AgentRequest {
  agent: AgentName;
  flowId?: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  maxTurns: number;
  /** USD cap for this call (the run's remaining budget). */
  maxBudgetUsd?: number;
  cwd: string;
  mcp?: McpLaunch;
  policy: ToolPolicy;
  /** JSON Schema for structured output (flow discovery). */
  outputSchema?: Record<string, unknown>;
  /** Where screenshots from tool results are saved. */
  screenshotDir?: string;
  /** Env var names removed from the agent process environment (credentials). */
  hiddenEnvVars?: string[];
  signal: AbortSignal;
}

export type AgentOutcome =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution"
  | "error_max_structured_output_retries"
  | "aborted"
  | "crashed";

export interface AgentResult {
  ok: boolean;
  subtype: AgentOutcome;
  /** Final assistant text (success) or the error text. */
  text: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  errors: string[];
}

export type AgentEventSink = (payload: DominionEventPayload) => void;

/** The seam between orchestration and the model. Tests use a scripted implementation. */
export interface AgentRunner {
  run(request: AgentRequest, emit: AgentEventSink): Promise<AgentResult>;
}

/** Built-in Claude Code tools no DOMinion agent may use. */
export const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookEdit",
  "TodoWrite",
  "Skill",
  "SlashCommand",
  "ExitPlanMode",
  "LS",
];

function sanitizedEnv(hidden: readonly string[] = []): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of hidden) delete env[name];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `dominion/${packageVersion()}`;
  return env;
}

/** Agent runner backed by the Claude Agent SDK's query(). */
export function createSdkAgentRunner(): AgentRunner {
  return {
    async run(request, emit) {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const { agent, flowId, policy } = request;
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (request.signal.aborted) abortController.abort();
      else request.signal.addEventListener("abort", onAbort, { once: true });

      const toolNames = new Map<string, string>();
      let screenshotCount = 0;
      const stderrTail: string[] = [];

      const decide = (toolName: string, input: Record<string, unknown>) => {
        const decision = evaluateToolCall(policy, toolName, input);
        if (!decision.allow) emit({ type: "agent.denied", agent, tool: shortToolName(toolName), reason: decision.reason, flowId });
        return decision;
      };

      emit({ type: "agent.started", agent, model: request.model, flowId });
      const result: AgentResult = { ok: false, subtype: "crashed", text: "", costUsd: 0, turns: 0, errors: [] };

      try {
        const stream = query({
          // Secret values never reach the model (spec: Secrets rules, never placed in prompts).
          prompt: policy.redactor.redact(request.prompt),
          options: {
            systemPrompt: policy.redactor.redact(request.systemPrompt),
            model: request.model,
            maxTurns: request.maxTurns,
            ...(request.maxBudgetUsd !== undefined ? { maxBudgetUsd: Math.max(request.maxBudgetUsd, 0.01) } : {}),
            cwd: request.cwd,
            env: sanitizedEnv(request.hiddenEnvVars),
            tools: policy.builtinTools,
            disallowedTools: DISALLOWED_BUILTIN_TOOLS.filter((t) => !policy.builtinTools.includes(t)),
            permissionMode: "default",
            settingSources: [],
            strictMcpConfig: true,
            persistSession: false,
            mcpServers: request.mcp ? { [request.mcp.serverName]: request.mcp.server } : {},
            ...(request.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: request.outputSchema } } : {}),
            abortController,
            stderr: (data: string) => {
              stderrTail.push(data);
              if (stderrTail.length > 40) stderrTail.shift();
            },
            hooks: {
              PreToolUse: [
                {
                  onFailure: "block",
                  hooks: [
                    async (input) => {
                      if (input.hook_event_name !== "PreToolUse") return {};
                      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                      const decision = decide(input.tool_name, toolInput);
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: decision.allow ? ("allow" as const) : ("deny" as const),
                          ...(decision.allow ? {} : { permissionDecisionReason: decision.reason }),
                        },
                      };
                    },
                  ],
                },
              ],
            },
            canUseTool: async (toolName, input) => {
              const decision = evaluateToolCall(policy, toolName, input);
              return decision.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.reason };
            },
          },
        });

        for await (const message of stream) {
          if (message.type === "system" && message.subtype === "init") {
            const failed = (message.mcp_servers ?? []).filter((s) => s.status !== "connected");
            if (failed.length) {
              emit({ type: "log", level: "warn", message: `MCP server ${failed.map((s) => `${s.name} (${s.status})`).join(", ")} did not connect`, flowId });
            }
          } else if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) {
                emit({ type: "agent.message", agent, text: block.text.trim().slice(0, 4000), flowId });
              } else if (block.type === "tool_use") {
                toolNames.set(block.id, block.name);
                const input = (block.input ?? {}) as Record<string, unknown>;
                emit({ type: "agent.tool_call", agent, tool: shortToolName(block.name), summary: summarizeToolCall(block.name, input), toolUseId: block.id, flowId });
              }
            }
          } else if (message.type === "user") {
            const content = message.message.content;
            if (!Array.isArray(content)) continue;
            for (const block of content as unknown as Array<Record<string, unknown>>) {
              if (block.type !== "tool_result") continue;
              const toolUseId = String(block.tool_use_id ?? "");
              const tool = shortToolName(toolNames.get(toolUseId) ?? "tool");
              const { text, images } = toolResultContent(block.content);
              const isError = block.is_error === true;
              const parsed = parseToolResultText(text);
              emit({
                type: "agent.tool_result",
                agent,
                tool,
                ok: !isError,
                summary: summarizeToolResult(tool, parsed, isError) ?? (isError ? text.split("\n")[0]?.slice(0, 300) : undefined),
                code: parsed.code,
                toolUseId,
                flowId,
              });
              if (request.screenshotDir) {
                for (const image of images) {
                  mkdirSync(request.screenshotDir, { recursive: true });
                  const ext = image.mediaType.includes("jpeg") ? "jpg" : "png";
                  const file = join(request.screenshotDir, `${agent}-${String(++screenshotCount).padStart(3, "0")}.${ext}`);
                  writeFileSync(file, Buffer.from(image.data, "base64"));
                  emit({ type: "browser.screenshot", path: file, flowId });
                }
              }
            }
          } else if (message.type === "result") {
            result.costUsd = message.total_cost_usd ?? 0;
            result.turns = message.num_turns ?? 0;
            result.subtype = message.subtype;
            if (message.subtype === "success") {
              result.ok = !message.is_error;
              result.text = message.result ?? "";
              result.structured = message.structured_output;
            } else {
              result.ok = false;
              result.errors = message.errors ?? [];
              result.text = result.errors.join("\n");
            }
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          result.subtype = "aborted";
          result.text = "stopped";
        } else {
          result.subtype = "crashed";
          const tail = stderrTail.join("").trim().split("\n").slice(-5).join("\n");
          result.text = `${errorMessage(error)}${tail ? `\n${tail}` : ""}`;
          result.errors.push(result.text);
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }

      emit({ type: "agent.finished", agent, ok: result.ok, turns: result.turns, costUsd: result.costUsd, subtype: result.subtype, flowId });
      return result;
    },
  };
}
