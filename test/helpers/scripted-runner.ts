import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { evaluateToolCall } from "../../src/core/agents/guard";
import type { AgentEventSink, AgentRequest, AgentResult, AgentRunner } from "../../src/core/agents/runner";
import type { AgentName } from "../../src/core/events";

export interface ScriptApi {
  request: AgentRequest;
  /** Attempts a Write through the real tool guard; returns the denial reason, if any. */
  write(path: string, content: string): string | undefined;
  /** Attempts an Edit through the real tool guard; applies it when allowed. */
  edit(path: string, oldString: string, newString: string): string | undefined;
  /** Attempts any tool call through the guard. */
  tryTool(tool: string, input: Record<string, unknown>): string | undefined;
  emit: AgentEventSink;
}

export type AgentScript = (api: ScriptApi) => Promise<Partial<AgentResult> | void> | Partial<AgentResult> | void;

/**
 * A stand-in for the Claude Agent SDK: each agent role runs a script that performs tool calls
 * through the same guard the real runner enforces, so lint and scope rules are exercised.
 */
export function scriptedRunner(scripts: Partial<Record<AgentName, AgentScript>>, options: { costPerCall?: number } = {}) {
  const calls: AgentRequest[] = [];
  const runner: AgentRunner = {
    async run(request, emit) {
      calls.push(request);
      emit({ type: "agent.started", agent: request.agent, model: request.model, flowId: request.flowId });
      let toolId = 0;
      const tryTool = (tool: string, input: Record<string, unknown>) => {
        const id = `t${++toolId}`;
        emit({ type: "agent.tool_call", agent: request.agent, tool, summary: `${tool} ${JSON.stringify(input).slice(0, 60)}`, toolUseId: id, flowId: request.flowId });
        const decision = evaluateToolCall(request.policy, tool, input);
        if (!decision.allow) {
          emit({ type: "agent.denied", agent: request.agent, tool, reason: decision.reason, flowId: request.flowId });
          return decision.reason;
        }
        emit({ type: "agent.tool_result", agent: request.agent, tool, ok: true, toolUseId: id, flowId: request.flowId });
        return undefined;
      };
      const api: ScriptApi = {
        request,
        emit,
        tryTool,
        write(path, content) {
          const abs = isAbsolute(path) ? path : resolve(request.cwd, path);
          const denied = tryTool("Write", { file_path: abs, content });
          if (!denied) {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content, "utf8");
          }
          return denied;
        },
        edit(path, oldString, newString) {
          const abs = isAbsolute(path) ? path : resolve(request.cwd, path);
          const denied = tryTool("Edit", { file_path: abs, old_string: oldString, new_string: newString });
          if (!denied) {
            const current = readFileSync(abs, "utf8");
            if (!current.includes(oldString)) return `old_string not found in ${path}`;
            writeFileSync(abs, current.replace(oldString, () => newString), "utf8");
          }
          return denied;
        },
      };
      const script = scripts[request.agent];
      const partial = script ? ((await script(api)) ?? {}) : {};
      const result: AgentResult = {
        ok: true,
        subtype: "success",
        text: "done",
        costUsd: options.costPerCall ?? 0.05,
        turns: 3,
        errors: [],
        ...partial,
      };
      emit({ type: "agent.finished", agent: request.agent, ok: result.ok, turns: result.turns, costUsd: result.costUsd, subtype: result.subtype, flowId: request.flowId });
      return result;
    },
  };
  return { runner, calls };
}
