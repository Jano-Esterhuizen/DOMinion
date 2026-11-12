import { resolve } from "node:path";
import type { ProjectProfile } from "../config/schema";
import type { DominionEventPayload } from "../events";
import type { ProjectScan } from "../project/scan";
import { Redactor } from "../redact";
import { renderPrompt } from "./prompts";
import type { AgentRunner } from "./runner";

export interface AnalyzeConventionsOptions {
  root: string;
  scan: ProjectScan;
  profile: ProjectProfile;
  runner: AgentRunner;
  model: string;
  signal?: AbortSignal;
  onEvent?: (payload: DominionEventPayload) => void;
  maxBudgetUsd?: number;
}

/**
 * The short analysis agent `init` runs on an existing suite (spec: Detection during init): reads
 * the exemplars and fixtures and summarises page object style, tagging, test.step use and
 * assertion habits. Returns undefined if the agent fails; the profile works without it.
 */
export async function analyzeConventions(options: AnalyzeConventionsOptions): Promise<string | undefined> {
  const { root, scan, profile } = options;
  const testDir = resolve(root, profile.testDir);
  const prompt = [
    `Summarise the conventions of the Playwright suite in ${profile.testDir}.`,
    "",
    `Style exemplars: ${profile.exemplars.join(", ") || "none detected; pick two typical tests"}.`,
    `Fixture files: ${scan.source.fixtures.map((f) => `${f.file} (${f.fixtures.join(", ")})`).join("; ") || "none"}.`,
    `Page objects: ${scan.source.pageObjects.map((p) => `${p.className} (${p.file})`).join(", ") || "none"}.`,
  ].join("\n");
  const result = await options.runner.run(
    {
      agent: "analysis",
      model: options.model,
      systemPrompt: renderPrompt("analysis", {}, resolve(root, "dominion", "prompts"), root),
      prompt,
      maxTurns: 20,
      maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
      cwd: root,
      signal: options.signal ?? new AbortController().signal,
      policy: {
        agent: "analysis",
        root,
        builtinTools: ["Read", "Glob", "Grep"],
        mcpTools: [],
        readRoots: [testDir],
        writeRoots: [],
        writeExtensions: [],
        excludePatterns: [],
        redactor: new Redactor(),
      },
    },
    options.onEvent ?? (() => undefined),
  );
  const text = result.ok ? result.text.trim() : "";
  return text ? text.slice(0, 2500) : undefined;
}
