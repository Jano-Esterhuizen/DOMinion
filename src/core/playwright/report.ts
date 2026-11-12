import { isAbsolute, resolve } from "node:path";
import type { TestStatus } from "../events";

/** The parts of Playwright's JSON reporter output DOMinion reads (@playwright/test >= 1.56). */
export interface JsonReport {
  config: { rootDir: string; configFile?: string; projects?: Array<{ name: string; testDir: string }> };
  suites: JsonSuite[];
  errors: Array<{ message?: string }>;
  stats?: { expected: number; unexpected: number; skipped: number; flaky: number; duration: number };
}

export interface JsonSuite {
  title: string;
  file: string;
  line?: number;
  column?: number;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

export interface JsonSpec {
  title: string;
  file: string;
  line: number;
  column: number;
  tags?: string[];
  tests: Array<{
    projectName: string;
    status: "expected" | "unexpected" | "flaky" | "skipped";
    annotations?: Array<{ type: string; description?: string }>;
    results: Array<{
      status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
      duration: number;
      error?: { message?: string; stack?: string };
      errors?: Array<{ message?: string }>;
      attachments?: Array<{ name: string; path?: string; contentType?: string }>;
    }>;
  }>;
}

export interface TestOutcome {
  /** Absolute path of the spec file. */
  file: string;
  title: string;
  /** Describe titles plus the test title. */
  titlePath: string[];
  line: number;
  column: number;
  project: string;
  tags: string[];
  status: TestStatus;
  durationMs: number;
  /** First error message, ANSI codes stripped. */
  error?: string;
  tracePath?: string;
  /** Playwright's error-context.md (page snapshot at the failure). */
  errorContextPath?: string;
  /** fixme annotation description, if any. */
  fixmeReason?: string;
}

// biome-ignore lint: control characters are the point of this regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Flattens the suite tree into one outcome per test and project (last retry wins). */
export function parseJsonReport(report: JsonReport): TestOutcome[] {
  const rootDir = report.config.rootDir;
  const outcomes: TestOutcome[] = [];
  const walk = (suite: JsonSuite, titles: string[], isFileSuite = false) => {
    // Top-level suites are file suites (their title is the file path, with OS separators).
    const path = isFileSuite || !suite.title ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const fixme = test.annotations?.find((a) => a.type === "fixme");
        // Playwright's verdict (expected / unexpected / flaky / skipped) accounts for test.fail().
        const bad = [...test.results].reverse().find((r) => r.status !== "passed" && r.status !== "skipped");
        const result = test.status === "unexpected" ? (bad ?? test.results[test.results.length - 1]) : test.results[test.results.length - 1];
        let status: TestStatus;
        if (test.status === "skipped") status = fixme ? "fixme" : "skipped";
        else if (test.status === "expected" || test.status === "flaky") status = result?.status === "skipped" ? "skipped" : "passed";
        else status = result?.status === "timedOut" ? "timedOut" : result?.status === "interrupted" ? "interrupted" : "failed";
        const attachments = result?.attachments ?? [];
        const message = status === "passed" ? undefined : (result?.error?.message ?? result?.errors?.[0]?.message);
        outcomes.push({
          file: isAbsolute(spec.file) ? spec.file : resolve(rootDir, spec.file),
          title: spec.title,
          titlePath: [...path, spec.title],
          line: spec.line,
          column: spec.column,
          project: test.projectName,
          tags: spec.tags ?? [],
          status,
          durationMs: Math.round(result?.duration ?? 0),
          error: message ? stripAnsi(message).trim() : undefined,
          tracePath: attachments.find((a) => a.name === "trace")?.path,
          errorContextPath: attachments.find((a) => a.name === "error-context")?.path,
          fixmeReason: fixme?.description,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report.suites) walk(suite, [], true);
  return outcomes;
}
