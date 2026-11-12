import { Command } from "commander";
import { packageVersion } from "../core/package-info";
import { registerAuthCommand } from "./commands/auth";
import { registerCrawlCommand } from "./commands/crawl";
import { registerDoctorCommand } from "./commands/doctor";
import { registerHealCommand } from "./commands/heal";
import { registerInitCommand } from "./commands/init";
import { registerPromptsCommand } from "./commands/prompts";
import { registerRunCommand } from "./commands/run";
import { registerRunsCommand } from "./commands/runs";
import { registerTaskCommands } from "./commands/task";
import { registerUiCommand } from "./commands/ui";

/** Builds the `dominion` CLI. Commands are thin: they parse flags and call src/core. */
export function createProgram(): Command {
  const program = new Command();
  program
    .name("dominion")
    .description("DOMinion: AI-driven Playwright test authoring")
    .version(packageVersion(), "-v, --version", "print the DOMinion version")
    .showHelpAfterError();

  registerInitCommand(program);
  registerDoctorCommand(program);
  registerAuthCommand(program);
  registerTaskCommands(program);
  registerCrawlCommand(program);
  registerHealCommand(program);
  registerRunCommand(program);
  registerRunsCommand(program);
  registerPromptsCommand(program);
  registerUiCommand(program);
  return program;
}
