import type { Command } from "commander";
import { DominionError } from "../../core/errors";
import { detectPackageManager } from "../../core/init/detect";
import { packageName } from "../../core/package-info";
import { runInheritedCommand } from "../../core/process";
import { applyUninstall, planUninstall, removePackageCommand } from "../../core/uninstall";
import { findProjectRoot } from "../../server/project";
import { terminalPrompter } from "../prompter";
import { color, line, warn } from "../output";

interface UninstallFlags {
  dryRun?: boolean;
  yes?: boolean;
  keepTests?: boolean;
  keepPackage?: boolean;
}

/**
 * `dominion uninstall`: removes what DOMinion added to the project (its config, folders, saved
 * logins, generated files and its edits to the Playwright config), then the package itself.
 * Shows the list and asks first; hand-written files are never touched.
 */
export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("remove everything DOMinion added to this project, then the package itself")
    .option("--dry-run", "only list what would be removed")
    .option("-y, --yes", "remove without asking")
    .option("--keep-tests", "keep the generated tests and test plans")
    .option("--keep-package", "keep the package installed (remove only DOMinion's files)")
    .action(async (flags: UninstallFlags) => {
      const root = findProjectRoot(process.cwd());
      const plan = await planUninstall(root, { keepTests: flags.keepTests });
      const pkg = packageName();
      const removeCommand = removePackageCommand(detectPackageManager(root), pkg);
      const removesPackage = plan.packageInstalled && !flags.keepPackage;

      if (!plan.steps.length && !removesPackage) {
        line(`Nothing of DOMinion's is left in ${root}.`);
        for (const warning of plan.warnings) warn(warning);
        return;
      }

      line(`${flags.dryRun ? "Would remove" : "DOMinion will remove"} from ${color.bold(root)}:`);
      for (const step of plan.steps) {
        line(`  ${step.action === "edit" ? color.yellow("edit  ") : color.red("delete")} ${step.path}${step.detail ? color.gray(`  ${step.detail}`) : ""}`);
      }
      if (removesPackage) line(`  ${color.red("then  ")} ${removeCommand.command} ${removeCommand.args.join(" ")}`);
      if (plan.kept.length) {
        line("Left in place:");
        for (const item of plan.kept) line(color.gray(`  ${item}`));
      }
      for (const warning of plan.warnings) warn(warning);
      if (flags.dryRun) return;

      if (!flags.yes) {
        const prompter = terminalPrompter();
        if (!prompter.interactive) {
          throw new DominionError("dominion uninstall needs confirmation.", { code: "CONFIRMATION_REQUIRED", hint: "Run it in a terminal, or add --yes to remove the files listed above without asking." });
        }
        line(color.gray("Stop `npx dominion ui` first if it is running. Files are deleted, not moved to the recycle bin; commit first if unsure."));
        if (!(await prompter.confirm("Remove these?", false))) {
          line("Nothing was removed.");
          return;
        }
      }

      const result = applyUninstall(plan);
      for (const { step, error } of result.failed) warn(`Could not ${step.action} ${step.path}: ${error}`);
      line(`${color.green("removed")} ${result.done.length} of ${plan.steps.length} item${plan.steps.length === 1 ? "" : "s"}.`);

      let packageOk = true;
      if (removesPackage) {
        line(`Running ${removeCommand.command} ${removeCommand.args.join(" ")}...`);
        packageOk = (await runInheritedCommand(removeCommand.command, removeCommand.args, { cwd: root })) === 0;
        if (!packageOk) warn(`Could not remove the package. Run \`${removeCommand.command} ${removeCommand.args.join(" ")}\` yourself.`);
      }
      if (result.failed.length || !packageOk) {
        process.exitCode = 1;
        return;
      }
      line(flags.keepPackage || !plan.packageInstalled ? "DOMinion's files are gone." : "DOMinion is uninstalled.");
    });
}
