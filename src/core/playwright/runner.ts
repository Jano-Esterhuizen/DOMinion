import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DominionError } from "../errors";
import { relativePosix } from "../fs";
import type { Redactor } from "../redact";
import { type JsonReport, parseJsonReport, stripAnsi, type TestOutcome } from "./report";
import { loadPlaywright } from "./resolve";

export interface RunTestsOptions {
  /** Consumer repo root (used to find @playwright/test). */
  root: string;
  /** The Playwright config to use; its folder is the working directory. */
  configPath: string;
  files: string[];
  projects?: string[];
  grep?: string;
  /** Where the JSON report is written. */
  reportPath: string;
  trace?: "retain-on-failure" | "on" | "off";
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Env vars removed from the test process (credentials and API keys). */
  unsetEnv?: string[];
  /** Rewrites the JSON report on disk with secrets redacted. */
  redactor?: Redactor;
  signal?: AbortSignal;
  /** Called with output lines as they arrive (for live logs). */
  onOutput?: (line: string) => void;
}

export interface TestRunResult {
  exitCode: number;
  tests: TestOutcome[];
  report?: JsonReport;
  /** Errors Playwright reported outside tests (config errors, missing files). */
  globalErrors: string[];
  output: string;
}

/**
 * Playwright treats file arguments as regular expressions, so absolute Windows paths (backslashes)
 * never match. Pass the path relative to the config folder, with forward slashes, regex-escaped.
 */
export function fileFilter(configDir: string, file: string): string {
  const rel = isAbsolute(file) ? relativePosix(configDir, file) : file.replace(/\\/g, "/");
  return rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Runs tests with the consumer's Playwright (`playwright test <files> --project=... --reporter=json`)
 * and parses the JSON report. The framework, not an agent, runs tests (spec: Runner and healer).
 */
export async function runPlaywrightTests(options: RunTestsOptions): Promise<TestRunResult> {
  const { cliPath } = await loadPlaywright(options.root);
  const cwd = dirname(options.configPath);
  mkdirSync(dirname(options.reportPath), { recursive: true });
  const args = [cliPath, "test", ...options.files.map((f) => fileFilter(cwd, f)), `--config=${options.configPath}`, "--reporter=json"];
  for (const project of options.projects ?? []) args.push(`--project=${project}`);
  if (options.grep) args.push(`--grep=${options.grep}`);
  if (options.trace) args.push(`--trace=${options.trace}`);
  args.push(...(options.extraArgs ?? []));

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: options.reportPath,
    PLAYWRIGHT_JSON_OUTPUT_FILE: options.reportPath,
    FORCE_COLOR: "0",
  };
  for (const name of options.unsetEnv ?? []) delete childEnv[name];
  const output = await new Promise<{ code: number; text: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv,
      signal: options.signal,
    });
    let text = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      text += s;
      if (options.onOutput) for (const line of s.split(/\r?\n/)) if (line.trim()) options.onOutput(stripAnsi(line));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => (options.signal?.aborted ? resolvePromise({ code: 130, text }) : reject(error)));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, text }));
  });

  if (!existsSync(options.reportPath)) {
    if (options.signal?.aborted) return { exitCode: output.code, tests: [], globalErrors: ["stopped"], output: output.text };
    throw new DominionError("Playwright did not produce a JSON report.", {
      code: "TEST_RUN_NO_REPORT",
      hint: `Playwright output:\n${stripAnsi(output.text).trim().slice(-1500)}`,
    });
  }
  let report = JSON.parse(readFileSync(options.reportPath, "utf8")) as JsonReport;
  if (options.redactor) {
    report = options.redactor.redactDeep(report);
    writeFileSync(options.reportPath, JSON.stringify(report), "utf8");
  }
  return {
    exitCode: output.code,
    tests: parseJsonReport(report),
    report,
    globalErrors: (report.errors ?? []).map((e) => stripAnsi(e.message ?? "")).filter(Boolean),
    output: options.redactor ? options.redactor.redact(output.text) : output.text,
  };
}
