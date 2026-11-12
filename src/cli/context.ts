import { type LoadedConfig, loadConfig } from "../core/config/loader";
import { redactorFor, redactorFromConfig, setActiveRedactor } from "../core/redact";

/**
 * Loads dominion.config.ts (and .env.local) for a command and switches on redaction of every
 * secret the config references before anything is printed.
 */
export async function loadCommandContext(): Promise<LoadedConfig> {
  setActiveRedactor(redactorFromConfig(undefined));
  const loaded = await loadConfig();
  setActiveRedactor(redactorFor(loaded));
  return loaded;
}
