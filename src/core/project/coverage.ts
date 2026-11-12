import type { TestFileInfo } from "./scan";

/**
 * Coverage awareness (spec: Existing projects, Coverage awareness): existing tests are matched to
 * flows by title, test.step names and URLs visited. Deterministic token overlap; no model calls.
 */
export type CoverageStatus = "covered" | "partly" | "none";

export interface CoverageMatch {
  file: string;
  title: string;
  score: number;
}

export interface FlowCoverage {
  status: CoverageStatus;
  /** Matching tests, best first. */
  tests: CoverageMatch[];
}

export interface FlowDescription {
  id: string;
  name: string;
  request: string;
  startUrl?: string;
}

const STOP = new Set([
  "a", "an", "the", "to", "for", "of", "and", "or", "in", "on", "with", "from", "by", "as", "at", "is", "it", "its", "into",
  "write", "tests", "test", "workflow", "flow", "flows", "user", "users", "page", "pages", "should", "can", "via", "when", "then", "be",
  "open", "opens", "see", "sees", "shows", "show", "visible", "dominion", "role", "e2e", "spec",
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/@[\w:-]+/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
      .map(stem),
  );
}

function urlTokens(url: string): Set<string> {
  try {
    return tokens(new URL(url, "http://x").pathname.replace(/\//g, " "));
  } catch {
    return tokens(url);
  }
}

/** Scores every test against a flow. A test covers the flow when it shares most of its key words. */
export function coverageFor(flow: FlowDescription, testFiles: readonly TestFileInfo[]): FlowCoverage {
  const flowTokens = new Set([...tokens(flow.id.replace(/-/g, " ")), ...tokens(flow.name), ...(flow.startUrl ? urlTokens(flow.startUrl) : [])]);
  const requestTokens = tokens(flow.request);
  const key = flowTokens.size ? flowTokens : requestTokens;
  if (!key.size) return { status: "none", tests: [] };

  const matches: CoverageMatch[] = [];
  for (const file of testFiles) {
    const fileTokens = new Set([...tokens(file.file.split("/").pop()!.replace(/\.(spec|test)\.\w+$/, "")), ...file.describes.flatMap((d) => [...tokens(d)])]);
    const steps = new Set(file.steps.flatMap((s) => [...tokens(s)]));
    const urls = new Set(file.urls.flatMap((u) => [...urlTokens(u)]));
    for (const title of file.titles) {
      const testTokens = new Set([...tokens(title), ...fileTokens, ...steps, ...urls]);
      const hit = [...key].filter((t) => testTokens.has(t)).length;
      const score = hit / key.size;
      if (score > 0) matches.push({ file: file.file, title, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0]?.score ?? 0;
  const status: CoverageStatus = best >= 0.75 ? "covered" : best >= 0.4 ? "partly" : "none";
  return { status, tests: matches.filter((m) => m.score >= 0.4).slice(0, 5) };
}

/** Planner prompt section listing tests that already cover a flow. */
export function coveragePromptSection(coverage: FlowCoverage, testFiles: readonly TestFileInfo[]): string | undefined {
  if (coverage.status === "none" || !coverage.tests.length) return undefined;
  const lines = [
    `Existing tests already ${coverage.status === "covered" ? "cover" : "partly cover"} this flow:`,
  ];
  for (const match of coverage.tests) {
    const file = testFiles.find((f) => f.file === match.file);
    const extras = [file?.steps.length ? `steps: ${file.steps.slice(0, 6).join("; ")}` : "", file?.urls.length ? `visits: ${file.urls.slice(0, 4).join(", ")}` : ""].filter(Boolean).join(" | ");
    lines.push(`- ${match.file} > "${match.title}"${extras ? ` (${extras})` : ""}`);
  }
  lines.push(
    "Do not plan scenarios these tests already cover. If they cover everything the request asks for, write the plan file with an empty Scenarios section and an Overview that names the covering tests: DOMinion will then skip this flow.",
  );
  return lines.join("\n");
}
