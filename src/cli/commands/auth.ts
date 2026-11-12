import type { Command } from "commander";
import { ensureSession } from "../../core/auth";
import { getEnvironment, getRole } from "../../core/config/resolve";
import { DominionError } from "../../core/errors";
import { relativePosix } from "../../core/fs";
import { loadCommandContext } from "../context";
import { color, line } from "../output";
import { terminalPrompter } from "../prompter";

interface AuthFlags {
  role?: string;
  headed?: boolean;
  force?: boolean;
}

export function registerAuthCommand(program: Command): void {
  program
    .command("auth")
    .description("log in and save a session to .auth/<env>-<role>.json")
    .argument("<env>", "environment name from dominion.config.ts")
    .option("--role <role>", "role to log in as (default: every role that needs a session)")
    .option("--headed", "show the browser during form login")
    .option("--force", "log in again even if the saved session is still valid")
    .action(async (envName: string, flags: AuthFlags) => {
      const loaded = await loadCommandContext();
      const env = getEnvironment(loaded, envName);
      let roles: string[];
      if (flags.role) {
        getRole(env, flags.role);
        roles = [flags.role];
      } else {
        roles = Object.keys(env.roles).filter((name) => env.roles[name]!.strategy !== "none");
        if (roles.length === 0) {
          throw new DominionError(`Environment "${envName}" has only guest roles; there is nothing to log in to.`, {
            code: "NO_LOGIN_ROLES",
          });
        }
      }

      const prompter = terminalPrompter();
      for (const roleName of roles) {
        const result = await ensureSession({
          loaded,
          envName,
          roleName,
          prompter,
          force: flags.force,
          headed: flags.headed,
        });
        const where = result.file ? relativePosix(process.cwd(), result.file) : "";
        const label = `${envName}/${roleName}`;
        if (result.action === "not-needed") {
          line(`${color.gray("-")} ${label}: guest role, no session needed`);
        } else if (result.action === "reused") {
          line(`${color.green("ok")} ${label}: existing session is ${result.check?.state ?? "present"} (${where}); use --force to log in again`);
        } else {
          const state = result.check?.state === "valid" ? "valid" : (result.check?.state ?? "saved");
          line(`${color.green("ok")} ${label}: logged in, session saved to ${where} (${state})`);
        }
      }
    });
}
