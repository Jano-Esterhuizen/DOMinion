import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ResolvedEnvironment } from "../config/resolve";
import type { AgentBrowserConfig } from "../config/schema";
import { DominionError } from "../errors";
import { writeFileAtomic } from "../fs";

/** Name the Playwright MCP server is registered under; its tools are mcp__playwright__<tool>. */
export const MCP_SERVER_NAME = "playwright";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Known payment-provider origins, blocked unless the environment lists them in allowedOrigins
 * (spec: Security and safety, "No irreversible actions by default").
 */
export const PAYMENT_PROVIDER_ORIGINS = [
  "https://js.stripe.com",
  "https://api.stripe.com",
  "https://checkout.stripe.com",
  "https://hooks.stripe.com",
  "https://m.stripe.network",
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
  "https://api-m.paypal.com",
  "https://api.braintreegateway.com",
  "https://checkoutshopper-live.adyen.com",
  "https://checkoutshopper-test.adyen.com",
  "https://pay.google.com",
  "https://apple-pay-gateway.apple.com",
  "https://js.squareup.com",
  "https://connect.squareup.com",
  "https://js.klarna.com",
  "https://x.klarnacdn.net",
  "https://checkout.razorpay.com",
  "https://api.razorpay.com",
  "https://accept.authorize.net",
  "https://secure.authorize.net",
] as const;

/** stdio MCP server entry as accepted by the Agent SDK's `mcpServers` option. */
export interface McpStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface McpLaunch {
  serverName: typeof MCP_SERVER_NAME;
  server: McpStdioServer;
  /** Absolute path of the per-run mcp.json. */
  configPath: string;
  config: McpConfigFile;
}

/** The subset of Playwright MCP's config file DOMinion writes. */
export interface McpConfigFile {
  browser: {
    isolated: boolean;
    launchOptions: { headless: boolean };
    contextOptions: { storageState?: string; extraHTTPHeaders?: Record<string, string> };
  };
  capabilities: string[];
  network: { allowedOrigins: string[]; blockedOrigins: string[] };
  testIdAttribute: string;
  outputDir: string;
  imageResponses: "allow" | "omit";
  codegen: "typescript";
  timeouts: { action: number; navigation: number };
}

export interface BuildMcpOptions {
  env: ResolvedEnvironment;
  /** Saved session for the role; omitted for guests. */
  storageState?: string;
  /** Headers saved with an `api` session (Authorization and the like); mcp.json lives under .dominion/, which agents cannot read. */
  extraHTTPHeaders?: Record<string, string>;
  /** Where mcp.json is written (inside the run folder). */
  configPath: string;
  /** Where MCP writes screenshots and snapshots. */
  outputDir: string;
  testIdAttribute: string;
  agentBrowser: AgentBrowserConfig;
  /** Temporary dotenv file of secrets (login-script generation only). */
  secretsFile?: string;
}

/** Absolute path of the pinned @playwright/mcp CLI, launched with `node` (no npx, no network). */
export function resolveMcpCli(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@playwright/mcp/package.json");
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: Record<string, string> };
  return join(dirname(pkgJson), pkg.bin?.["playwright-mcp"] ?? "cli.js");
}

export function mcpVersion(): string {
  const require = createRequire(import.meta.url);
  return (JSON.parse(readFileSync(require.resolve("@playwright/mcp/package.json"), "utf8")) as { version: string }).version;
}

export function buildMcpConfig(options: BuildMcpOptions): McpConfigFile {
  const allowed = options.env.allowedOrigins;
  return {
    browser: {
      isolated: true,
      launchOptions: { headless: options.agentBrowser.headless },
      contextOptions: {
        ...(options.storageState ? { storageState: options.storageState } : {}),
        ...(options.extraHTTPHeaders ? { extraHTTPHeaders: options.extraHTTPHeaders } : {}),
      },
    },
    // "testing" adds browser_generate_locator and the browser_verify_* assertion tools.
    capabilities: ["testing"],
    network: {
      allowedOrigins: [...allowed],
      blockedOrigins: PAYMENT_PROVIDER_ORIGINS.filter((origin) => !allowed.includes(origin)),
    },
    testIdAttribute: options.testIdAttribute,
    outputDir: options.outputDir,
    imageResponses: "allow",
    codegen: "typescript",
    timeouts: { action: 5_000, navigation: 30_000 },
  };
}

/**
 * Writes the per-run mcp.json and returns the stdio launch for the Agent SDK. Equivalent to
 * `npx @playwright/mcp@<pinned> --isolated --storage-state=... --config=...` (spec: How agents get
 * the session), but runs the pinned dependency directly so it works offline and on Windows.
 */
/**
 * Removes session headers (bearer tokens from an `api` login) from a run's mcp.json once no agent
 * needs it, so the run folder can be kept or uploaded as an artifact without live tokens.
 */
export function scrubMcpConfig(configPath: string): void {
  if (!existsSync(configPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfigFile;
    if (!config.browser?.contextOptions?.extraHTTPHeaders) return;
    delete config.browser.contextOptions.extraHTTPHeaders;
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // unreadable: remove it rather than leave a token behind
    rmSync(configPath, { force: true });
  }
}

export function buildMcpLaunch(options: BuildMcpOptions): McpLaunch {
  const config = buildMcpConfig(options);
  writeFileAtomic(options.configPath, `${JSON.stringify(config, null, 2)}\n`);
  const args = [resolveMcpCli(), "--isolated", `--config=${options.configPath}`, `--browser=${options.agentBrowser.browser}`];
  if (options.storageState) args.push(`--storage-state=${options.storageState}`);
  if (options.agentBrowser.headless) args.push("--headless");
  if (options.secretsFile) args.push(`--secrets=${options.secretsFile}`);
  return {
    serverName: MCP_SERVER_NAME,
    server: { type: "stdio", command: process.execPath, args, timeout: 120_000 },
    configPath: options.configPath,
    config,
  };
}

let ensured: Promise<void> | undefined;

/**
 * Installs the browser build the pinned Playwright MCP needs (it can differ from the consumer's
 * Playwright). Idempotent and fast once installed. System channels (chrome, msedge) need nothing.
 */
export function ensureMcpBrowser(agentBrowser: AgentBrowserConfig): Promise<void> {
  if (agentBrowser.browser !== "chromium") return Promise.resolve();
  ensured ??= new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [resolveMcpCli(), "install-browser", "chromium"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new DominionError("Could not install the browser DOMinion's agents use.", {
            code: "MCP_BROWSER_INSTALL_FAILED",
            hint: `Run \`npx @playwright/mcp@${mcpVersion()} install-browser chromium\` and try again, or set agentBrowser.browser to "chrome" to use your installed Chrome. Output: ${output.trim().slice(-400)}`,
          }),
        );
    });
  }).catch((error: unknown) => {
    ensured = undefined;
    throw error;
  });
  return ensured;
}
