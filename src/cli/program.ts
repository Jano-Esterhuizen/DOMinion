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
import { registerUninstallCommand } from "./commands/uninstall";

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
  registerUninstallCommand(program);
  // `npx dominion` on its own: say how to get started instead of a wall of help.
  program.allowExcessArguments(true).action(() => {
    if (program.args.length) {
      program.error(`error: unknown command '${program.args[0]}'. Run \`npx dominion --help\` to see the commands.`, { code: "commander.unknownCommand" });
    }
    process.stdout.write(
      [
        `DOMinion ${packageVersion()}: AI-driven Playwright test authoring.`,
        "",
        "Get started:",
        "  npx dominion ui      open the browser UI; its Setup tab walks you through everything",
        "  npx dominion init    or set up from the terminal",
        "",
        "All commands: npx dominion --help",
        "",
      ].join("\n"),
    );
  });
  return program;
}
