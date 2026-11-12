import type { RunStage, TestStatus } from "../events";

export type RunMode = "task" | "crawl";

export type FlowStatus =
  | "pending"
  /** Existing tests already cover the flow; nothing was generated. */
  | "skipped"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "generating"
  | "running"
  | "healing"
  | "done"
  | "failed"
  | "stopped";

export interface TestResultSummary {
  file: string;
  title: string;
  status: TestStatus;
  durationMs: number;
  error?: string;
  tracePath?: string;
  /** Why the healer marked it fixme. */
  fixmeReason?: string;
  healAttempts?: number;
}

export interface FlowRun {
  /** Slug used for file names and tags (@flow:<id>). */
  id: string;
  name: string;
  /** The natural-language request the planner works from. */
  request: string;
  startUrl?: string;
  /** Folder under testDir the generator writes into. */
  area?: string;
  status: FlowStatus;
  /** Repo-relative path of the Markdown plan. */
  planPath?: string;
  /** Reviewer feedback from rejections, oldest first. */
  feedback: string[];
  /** Repo-relative spec files written for this flow. */
  specFiles: string[];
  /** Page objects and other helpers written for this flow. */
  supportFiles: string[];
  results?: TestResultSummary[];
  costUsd: number;
  error?: string;
  /** How well existing tests already cover the flow (coverage awareness). */
  coverage?: { status: "covered" | "partly" | "none"; tests: Array<{ file: string; title: string }> };
}

export interface ChangedFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  kind: "added" | "modified";
  /** Run-relative path of the snapshot taken before the first modification. */
  before?: string;
  flowId?: string;
}

/** A flow proposed by the flow discovery agent (crawl mode). */
export interface DiscoveredFlow {
  id: string;
  name: string;
  priority: "critical" | "high" | "medium";
  startUrl: string;
  pagesInvolved: string[];
  description: string;
  destructive: boolean;
  /** Coverage by existing tests (coverage gap view). */
  coverage?: { status: "covered" | "partly" | "none"; tests: Array<{ file: string; title: string }> };
}

/** A change the generator wanted to make to a hand-written file (modifyExisting: false). */
export interface Proposal {
  id: string;
  /** Repo-relative path of the hand-written file. */
  path: string;
  /** Run-relative paths of the unified diff and the proposed full content. */
  diffFile: string;
  afterFile: string;
  /** sha256 of the file when the proposal was made, to refuse applying onto a changed file. */
  beforeHash: string;
  status: "pending" | "applied" | "rejected";
  flowId?: string;
}

export interface RunOptions {
  autoApprove: boolean;
  planOnly: boolean;
  maxPages?: number;
  flowIds?: string[];
}

export interface RunRecord {
  id: string;
  mode: RunMode;
  env: string;
  role: string;
  request?: string;
  model: string;
  status: RunStage;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  costUsd: number;
  budgetUsd: number;
  options: RunOptions;
  flows: FlowRun[];
  changedFiles: ChangedFile[];
  proposals?: Proposal[];
  /** Crawl mode: flows the discovery agent proposed, for selection. */
  discoveredFlows?: DiscoveredFlow[];
  /** Crawl mode: pages crawled and patterns found. */
  crawl?: { pages: number; patterns: number; stoppedReason?: string };
  error?: { message: string; hint?: string; code?: string };
  /** Set while the run waits for a person (manual login, CAPTCHA). */
  pause?: { reason: string; since: string };
}
