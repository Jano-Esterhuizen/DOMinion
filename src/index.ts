/**
 * Public API of DOMinion: `defineConfig` and the types consumers use in dominion.config.ts and
 * their login scripts. Everything else is internal and may change between minor versions.
 */
export { defineConfig } from "./core/config/define";
export type {
  AgentBrowserConfig,
  ApiRoleConfig,
  BudgetsConfig,
  CrawlConfig,
  DominionConfig,
  DominionUserConfig,
  EnvironmentAuthConfig,
  EnvironmentConfig,
  ExistingRoleConfig,
  FormRoleConfig,
  ManualRoleConfig,
  ProjectProfile,
  RoleConfig,
  RoleStrategy,
  SessionValidationConfig,
} from "./core/config/schema";
export type {
  ApiLoginContext,
  ApiLoginCookie,
  ApiLoginResult,
  LoginContext,
  LoginCredentials,
  LoginEnvironment,
} from "./core/auth/types";
