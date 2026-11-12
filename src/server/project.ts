import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type LoadedConfig, loadConfig, loadEnvFile } from "../core/config/loader";
import { DominionError } from "../core/errors";
import { redactorFor, redactorFromConfig, setActiveRedactor } from "../core/redact";
import { RunManager, type RunManagerOptions } from "../core/runs/manager";

/** The project folder for `dominion ui`: where dominion.config.ts is, else the nearest package.json. */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/**
 * What the server knows about the consumer project. dominion.config.ts may not exist yet (the
 * Setup tab creates it), and the Setup tab edits it and .env.local while the server runs, so
 * routes ask for the current config on every request.
 */
export class ProjectContext {
  private config: LoadedConfig | undefined;
  private runManager: RunManager | undefined;

  constructor(
    readonly root: string,
    loaded?: LoadedConfig,
    private readonly managerOptions: RunManagerOptions = {},
    manager?: RunManager,
  ) {
    this.config = loaded;
    this.runManager = manager ?? (loaded ? new RunManager(loaded, managerOptions) : undefined);
    if (!loaded) loadEnvFile(root); // the API key can be set before any config exists
    setActiveRedactor(loaded ? redactorFor(loaded) : redactorFromConfig(undefined));
  }

  get loaded(): LoadedConfig | undefined {
    return this.config;
  }

  get manager(): RunManager | undefined {
    return this.runManager;
  }

  /** The config, or a 409 telling the UI to finish setup first. */
  requireLoaded(): LoadedConfig {
    if (!this.config) {
      throw new DominionError("This project has no dominion.config.ts yet.", { code: "SETUP_REQUIRED", hint: "Create it on the Setup tab (or run `npx dominion init`)." });
    }
    return this.config;
  }

  requireManager(): RunManager {
    this.requireLoaded();
    return this.runManager!;
  }

  /** Re-reads dominion.config.ts and .env.local after the Setup tab changed them. */
  async reload(loaded?: LoadedConfig): Promise<LoadedConfig | undefined> {
    let next = loaded;
    if (!next) {
      try {
        next = await loadConfig({ cwd: this.root });
      } catch (error) {
        if (error instanceof DominionError && error.code === "CONFIG_NOT_FOUND") next = undefined;
        else throw error;
      }
    }
    this.config = next;
    if (next) {
      if (this.runManager) this.runManager.setLoaded(next);
      else this.runManager = new RunManager(next, this.managerOptions);
      setActiveRedactor(redactorFor(next));
    } else {
      setActiveRedactor(redactorFromConfig(undefined));
    }
    return next;
  }

  /** Secrets changed: rebuild redaction without reloading the config file. */
  refreshSecrets(): void {
    if (this.config) {
      this.runManager?.setLoaded(this.config);
      setActiveRedactor(redactorFor(this.config));
    }
  }
}
