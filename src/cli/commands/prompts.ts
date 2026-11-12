import type { Command } from "commander";
import { ejectPrompts, inspectPromptOverrides, PROMPT_NAMES, PROMPT_PLACEHOLDERS, type PromptName } from "../../core/agents/prompts";
import { projectPaths } from "../../core/config/resolve";
import { DominionError } from "../../core/errors";
import { relativePosix } from "../../core/fs";
import { loadCommandContext } from "../context";
import { color, line } from "../output";

const DESCRIPTIONS: Record<PromptName, string> = {
  planner: "explores the app and writes the Markdown test plan",
  generator: "turns an approved plan into a Playwright spec",
  healer: "fixes failing generated tests or marks them fixme",
  discovery: "proposes user flows from the crawl sitemap",
  analysis: "summarizes an existing suite's conventions (init)",
  rules: "the test generation rules, inserted where a prompt says {{rules}}",
};

/**
 * `dominion prompts`: shows which agent prompts the repo overrides in dominion/prompts/, and
 * `dominion prompts eject [names...]` copies defaults there to start from (never overwriting).
 */
export function registerPromptsCommand(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("list the agent prompts and which ones dominion/prompts/ overrides")
    .action(async () => {
      const loaded = await loadCommandContext();
      const dir = projectPaths(loaded).promptOverridesDir;
      const overrides = new Map(inspectPromptOverrides(dir).map((o) => [o.name, o]));
      for (const name of PROMPT_NAMES) {
        const override = overrides.get(name);
        const source = override
          ? override.problems.length
            ? color.red(`override with problems: ${override.problems.join("; ")}`)
            : color.cyan(`override: ${relativePosix(loaded.root, override.path)}`)
          : color.gray("default");
        const placeholders = PROMPT_PLACEHOLDERS[name].map((p) => `{{${p}}}`).join(" ") || "none";
        line(`${color.bold(name.padEnd(10))} ${source}`);
        line(color.gray(`           ${DESCRIPTIONS[name]}; placeholders: ${placeholders}`));
      }
      for (const [name, override] of overrides) {
        if (!(PROMPT_NAMES as string[]).includes(name)) line(color.yellow(`warning ${relativePosix(loaded.root, override.path)}: ${override.problems.join("; ")}`));
      }
      line();
      line(color.gray("Override a prompt by saving dominion/prompts/<name>.md (commit it). `npx dominion prompts eject planner` copies the default to start from."));
    });

  prompts
    .command("eject")
    .description("copy default prompts into dominion/prompts/ to customize them (existing files are kept)")
    .argument("[names...]", `prompts to copy (default: all of ${PROMPT_NAMES.join(", ")})`)
    .action(async (names: string[] = []) => {
      const unknown = names.filter((n) => !(PROMPT_NAMES as string[]).includes(n));
      if (unknown.length) {
        throw new DominionError(`Unknown prompt${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`, { code: "INVALID_FLAG", hint: `Prompts: ${PROMPT_NAMES.join(", ")}.` });
      }
      const loaded = await loadCommandContext();
      const results = ejectPrompts(projectPaths(loaded).promptOverridesDir, names.length ? (names as PromptName[]) : PROMPT_NAMES);
      for (const result of results) {
        const file = relativePosix(loaded.root, result.path);
        line(result.status === "created" ? `${color.green("created")} ${file}` : `${color.gray("kept   ")} ${file} (already exists)`);
      }
      line();
      line(color.gray("Edit these files to change how the agents behave; delete one to go back to the default. Default prompts change between DOMinion versions (see the changelog), so re-check ejected copies after upgrading."));
    });
}
