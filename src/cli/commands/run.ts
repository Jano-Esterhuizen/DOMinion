import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { specTags } from "../../core/agents/healer";
import { projectPaths } from "../../core/config/resolve";
import { DominionError } from "../../core/errors";
import { relativePosix } from "../../core/fs";
import { findPlaywrightConfigs } from "../../core/init/detect";
import { snapshotFiles } from "../../core/orchestrator/changes";
import { secretEnvVarNames } from "../../core/orchestrator/pipeline";
import { hasDominionHeader } from "../../core/playwright/lint";
import { testProjectName } from "../../core/playwright/patch";
import { loadPlaywright } from "../../core/playwright/resolve";
import { dominionPlaywrightConfigPath, ensureDominionPlaywrightConfig } from "../../core/project/wiring";
import { loadCommandContext } from "../context";

interface RunFlags {
  env?: string;
}

/**
 * `dominion run [...args]`: runs the generated tests through the consumer's Playwright config.
 * New projects run DOMinion's managed projects for the roles the generated specs are tagged with;
 * existing projects run the profile's project through playwright.dominion.config.ts with
 * --grep @dominion. Extra arguments are passed to `playwright test` unchanged.
 */
export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("run generated tests through your Playwright config; extra args go to `playwright test`")
    .option("--env <env>", "environment whose DOMinion projects to run (default: the only one configured)")
    .allowUnknownOption(true)
    .argument("[args...]", "arguments passed to playwright test")
    .action(async (args: string[] = [], flags: RunFlags) => {
      const loaded = await loadCommandContext();
      const paths = projectPaths(loaded);
      const { cliPath } = await loadPlaywright(loaded.root);
      const userArgs = [...args];
      const has = (flag: string) => userArgs.some((a) => a === flag || a.startsWith(`${flag}=`));
      let configPath: string;
      const selection: string[] = [];

      const profile = loaded.config.project;
      if (profile) {
        configPath = ensureDominionPlaywrightConfig(loaded.root, profile).path ?? dominionPlaywrightConfigPath(loaded.root, profile);
        if (!has("--project") && profile.runProject) selection.push(`--project=${profile.runProject}`);
        if (!has("--grep")) {
          const testDir = resolve(loaded.root, profile.testDir);
          const generated = [...snapshotFiles(loaded.root, [testDir])].some(([file, state]) => /\.(spec|test)\.(ts|js|mjs|cjs)$/.test(file) && hasDominionHeader(state.content));
          if (!generated) {
            throw new DominionError(`No DOMinion-generated tests were found in ${relativePosix(loaded.root, testDir)}.`, {
              code: "NO_DOMINION_TESTS",
              hint: "Generate tests first with `npx dominion task <env> \"<request>\"`. To run your whole suite, use `npx playwright test`.",
            });
          }
          selection.push("--grep=@dominion");
        }
      } else {
        const configFile = findPlaywrightConfigs(loaded.root)[0];
        if (!configFile) {
          throw new DominionError("No playwright.config.* was found next to dominion.config.ts.", { code: "PLAYWRIGHT_CONFIG_MISSING", hint: "Run `npm init playwright@latest` first." });
        }
        configPath = join(loaded.root, configFile);
        if (!has("--project")) {
          const envNames = Object.keys(loaded.config.environments);
          const envName = flags.env ?? (envNames.length === 1 ? envNames[0] : undefined);
          if (!envName) throw new DominionError("Several environments are configured; choose one with --env.", { code: "ENV_REQUIRED", hint: `Environments: ${envNames.join(", ")}.` });
          const roles = new Set<string>();
          for (const [file, state] of snapshotFiles(loaded.root, [paths.testDir])) {
            if (/\.(spec|test)\.(ts|js|mjs|cjs)$/.test(file) && hasDominionHeader(state.content)) {
              const role = specTags(state.content).role;
              if (role) roles.add(role);
            }
          }
          const configText = readFileSync(configPath, "utf8");
          const projects = [...roles].map((role) => testProjectName(envName, role)).filter((name) => configText.includes(`"${name}"`));
          if (!projects.length) {
            throw new DominionError(
              roles.size ? `The Playwright config has no DOMinion projects for ${envName} (${[...roles].join(", ")}).` : `No DOMinion-generated tests were found in ${relativePosix(loaded.root, paths.testDir)}.`,
              {
                code: "NO_DOMINION_PROJECTS",
                hint: roles.size
                  ? "Run `npx dominion task` (or `generate`) once so DOMinion adds its projects, or add the managed block it printed."
                  : "Generate tests first with `npx dominion task <env> \"<request>\"`.",
              },
            );
          }
          selection.push(...projects.map((p) => `--project=${p}`));
        }
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      // The setup projects need credentials to log in; only API keys are removed from the test env.
      for (const name of secretEnvVarNames(loaded)) if (/^(ANTHROPIC|CLAUDE_CODE_OAUTH|AWS_|ANTHROPIC_FOUNDRY)/.test(name)) delete env[name];
      const child = spawn(process.execPath, [cliPath, "test", `--config=${configPath}`, ...selection, ...userArgs], { cwd: loaded.root, stdio: "inherit", env });
      process.exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    });
}
