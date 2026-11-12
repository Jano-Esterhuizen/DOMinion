import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DominionError, errorMessage } from "../errors";
import { relativePosix } from "../fs";
import { defaultPromptsDir } from "../package-info";
import { renderString } from "../templates";

export type PromptName = "planner" | "generator" | "healer" | "discovery" | "analysis" | "rules";

/**
 * Placeholders each prompt is rendered with. `{{rules}}` inserts the shared test generation rules
 * (rules.md, itself overridable), which are rendered with the variables of the including prompt.
 */
export const PROMPT_PLACEHOLDERS: Readonly<Record<PromptName, readonly string[]>> = {
  planner: ["testIdAttribute", "rules"],
  generator: ["testIdAttribute", "rules"],
  healer: ["testIdAttribute", "rules"],
  discovery: [],
  analysis: [],
  rules: ["testIdAttribute"],
};

export const PROMPT_NAMES = Object.keys(PROMPT_PLACEHOLDERS) as PromptName[];

export interface PromptOverride {
  name: string;
  /** Absolute path of the override file. */
  path: string;
  /** Problems that would make a run fail or the override be ignored; empty when it is usable. */
  problems: string[];
}

/** The consumer's prompt overrides in dominion/prompts/, with anything that would go wrong at run time. */
export function inspectPromptOverrides(overridesDir: string): PromptOverride[] {
  if (!existsSync(overridesDir)) return [];
  const overrides: PromptOverride[] = [];
  for (const file of readdirSync(overridesDir).sort()) {
    const path = join(overridesDir, file);
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!(PROMPT_NAMES as string[]).includes(name)) {
      overrides.push({ name, path, problems: [`not a DOMinion prompt, so it is ignored (prompts: ${PROMPT_NAMES.join(", ")})`] });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const allowed = PROMPT_PLACEHOLDERS[name as PromptName];
    const unknown = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))].filter((p) => !allowed.includes(p));
    const problems = [];
    if (!text.trim()) problems.push("is empty");
    if (unknown.length) problems.push(`uses unknown placeholder${unknown.length === 1 ? "" : "s"} ${unknown.map((p) => `{{${p}}}`).join(", ")} (available: ${allowed.map((p) => `{{${p}}}`).join(", ") || "none"})`);
    overrides.push({ name, path, problems });
  }
  return overrides;
}

/** Copies default prompts into the overrides folder so a team can edit them; never overwrites. */
export function ejectPrompts(overridesDir: string, names: readonly PromptName[] = PROMPT_NAMES): Array<{ name: PromptName; path: string; status: "created" | "exists" }> {
  mkdirSync(overridesDir, { recursive: true });
  return names.map((name) => {
    const path = join(overridesDir, `${name}.md`);
    if (existsSync(path)) return { name, path, status: "exists" as const };
    writeFileSync(path, readFileSync(join(defaultPromptsDir(), `${name}.md`), "utf8"), "utf8");
    return { name, path, status: "created" as const };
  });
}

export interface LoadedPrompt {
  name: PromptName;
  text: string;
  source: "default" | "override";
  path: string;
}

/** Reads a prompt: the consumer's dominion/prompts/<name>.md when present, else the packaged default. */
export function loadPrompt(name: PromptName, overridesDir?: string): LoadedPrompt {
  const override = overridesDir ? join(overridesDir, `${name}.md`) : undefined;
  if (override && existsSync(override)) return { name, text: readFileSync(override, "utf8"), source: "override", path: override };
  const path = join(defaultPromptsDir(), `${name}.md`);
  return { name, text: readFileSync(path, "utf8"), source: "default", path };
}

/**
 * Renders a system prompt. `{{rules}}` expands to the shared test generation rules (itself
 * overridable); other `{{placeholders}}` come from `vars`.
 */
export function renderPrompt(name: PromptName, vars: Record<string, string>, overridesDir?: string, root?: string): string {
  const prompt = loadPrompt(name, overridesDir);
  const allVars = { ...vars };
  if (prompt.text.includes("{{rules}}") || /\{\{\s*rules\s*\}\}/.test(prompt.text)) {
    const rules = loadPrompt("rules", overridesDir);
    allVars.rules = render(rules, vars, root);
  }
  return render(prompt, allVars, root);
}

function render(prompt: LoadedPrompt, vars: Record<string, string>, root?: string): string {
  try {
    return renderString(prompt.text, vars, prompt.name).trim();
  } catch (error) {
    const where = root ? relativePosix(root, prompt.path) : prompt.path;
    throw new DominionError(`Prompt ${where} could not be rendered: ${errorMessage(error)}`, {
      code: "PROMPT_INVALID",
      hint: `Available placeholders for ${prompt.name}: ${Object.keys(vars).map((k) => `{{${k}}}`).join(", ") || "none"}.`,
    });
  }
}
