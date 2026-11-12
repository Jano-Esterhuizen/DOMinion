import type { DominionUserConfig } from "./schema";

/**
 * Typed helper for dominion.config.ts. It returns the config unchanged; validation happens when
 * DOMinion loads the file, so errors are reported with the config path and the offending key.
 */
export function defineConfig(config: DominionUserConfig): DominionUserConfig {
  return config;
}
