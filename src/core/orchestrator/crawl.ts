import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverFlows } from "../agents/flowDiscovery";
import { ensureSession, storageStatePathFor } from "../auth";
import type { LoadedConfig } from "../config/loader";
import { getEnvironment } from "../config/resolve";
import { crawlSite, type Sitemap } from "../crawler/crawl";
import { DominionError } from "../errors";
import { loadPlaywright } from "../playwright/resolve";
import { coverageFor } from "../project/coverage";
import { scanSources } from "../project/scan";
import { Pipeline, type PipelineDeps, summarizeResults } from "./pipeline";
import type { DiscoveredFlow, FlowRun, RunRecord, TestResultSummary } from "./types";

export interface CrawlRunOptions {
  loaded: LoadedConfig;
  envName: string;
  roleName?: string;
  maxPages?: number;
  /** Flow ids to plan (CLI --flows); skips the selection step. */
  flowIds?: string[];
  autoApprove?: boolean;
  planOnly?: boolean;
  model?: string;
}

/** Flows planned at the same time (spec: up to two flows in parallel). */
export const PARALLEL_FLOWS = 2;

/** Serializes the steps that write to the test folder, so each flow's diff is exactly its own. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

async function crawlWithRecovery(pipeline: Pipeline, options: CrawlRunOptions, deps: PipelineDeps): Promise<Sitemap> {
  const { loaded } = options;
  const env = getEnvironment(loaded, pipeline.envName);
  const { module: playwright } = await loadPlaywright(loaded.root);
  const crawl = () =>
    crawlSite({
      playwright,
      env,
      role: pipeline.roleName,
      storageState: storageStatePathFor(loaded, pipeline.envName, pipeline.roleName),
      maxPages: options.maxPages ?? loaded.config.crawl.maxPages,
      maxDepth: loaded.config.crawl.maxDepth,
      exclude: loaded.config.crawl.exclude,
      keepQueryParams: loaded.config.crawl.keepQueryParams,
      thumbnailDir: pipeline.run.path("crawl"),
      runDir: pipeline.run.dir,
      signal: pipeline.signal,
      headless: loaded.config.agentBrowser.headless,
      onPage: (page) => pipeline.run.emit({ type: "crawl.page", url: page.url, pattern: page.pattern, status: page.status, depth: page.depth }),
    });

  for (let attempt = 1; ; attempt++) {
    const sitemap = await crawl();
    pipeline.checkStopped();
    if (sitemap.stoppedReason === "session-lost" && attempt === 1) {
      // Form/api/existing roles re-authenticate automatically; manual roles ask the person.
      pipeline.run.emit({ type: "log", level: "warn", message: `The session was lost during the crawl (${sitemap.stopDetail}); logging in again and restarting the crawl.` });
      await ensureSession({ loaded, envName: pipeline.envName, roleName: pipeline.roleName, prompter: deps.prompter, force: true, redactor: pipeline.redactor });
      continue;
    }
    if (sitemap.stoppedReason === "bot-challenge" && attempt === 1 && deps.prompter.interactive) {
      const reason = `A CAPTCHA or bot challenge appeared (${sitemap.stopDetail}). DOMinion never solves or bypasses these: disable bot protection for this test environment or allowlist this machine, then continue.`;
      pipeline.run.emit({ type: "run.paused", reason });
      await deps.prompter.waitForUser(reason);
      pipeline.checkStopped();
      continue;
    }
    return sitemap;
  }
}

/**
 * Crawl mode (spec: Crawl mode): crawl deterministically, let the discovery agent propose flows,
 * select some, then send each selected flow down the task-mode path (crawl mode is task mode with
 * machine-written requests).
 */
export async function runCrawl(options: CrawlRunOptions, deps: PipelineDeps): Promise<RunRecord> {
  const pipeline = Pipeline.create(
    { loaded: options.loaded, envName: options.envName, roleName: options.roleName, model: options.model, mode: "crawl", autoApprove: options.autoApprove, planOnly: options.planOnly },
    deps,
  );
  try {
    await pipeline.preflight();

    // Phase 1: crawl
    pipeline.setStage("crawling");
    const sitemap = await crawlWithRecovery(pipeline, options, deps);
    writeFileSync(pipeline.run.path("sitemap.json"), JSON.stringify(pipeline.redactor.redactDeep(sitemap), null, 2), "utf8");
    pipeline.run.update((r) => {
      r.crawl = { pages: sitemap.pages.length, patterns: new Set(sitemap.pages.map((p) => p.pattern)).size, stoppedReason: sitemap.stoppedReason };
    });
    pipeline.run.emit({ type: "crawl.finished", pages: sitemap.pages.length, patterns: pipeline.run.record.crawl!.patterns, stoppedReason: sitemap.stoppedReason });
    if (sitemap.stoppedReason === "session-lost") {
      throw new DominionError(`The session was lost during the crawl again (${sitemap.stopDetail}).`, {
        code: "CRAWL_SESSION_LOST",
        hint: "Something on the site logs this role out. Add that path to crawl.exclude in dominion.config.ts, then crawl again.",
      });
    }
    if (sitemap.stoppedReason === "bot-challenge") {
      throw new DominionError(`The crawl stopped at a CAPTCHA or bot challenge (${sitemap.stopDetail}).`, {
        code: "CRAWL_BOT_CHALLENGE",
        hint: "DOMinion never solves CAPTCHAs. Disable bot protection for the test environment, or log in manually and crawl again.",
      });
    }
    if (sitemap.pages.length === 0) {
      throw new DominionError(`The crawler could not open ${sitemap.baseURL}.`, { code: "CRAWL_EMPTY", hint: "Check that the environment is up and the base URL is right." });
    }

    // Phase 2: discover
    pipeline.setStage("discovering");
    const ctx = await pipeline.agentContext();
    const discovered = await discoverFlows(ctx, sitemap, (result) => pipeline.charge(result, undefined, "flow discovery"));
    const profile = options.loaded.config.project;
    const testFiles = scanSources(options.loaded.root, profile ? resolve(options.loaded.root, profile.testDir) : ctx.paths.testDir).testFiles;
    const flows: DiscoveredFlow[] = discovered.map((flow) => {
      const coverage = coverageFor({ id: flow.id, name: flow.name, request: flow.description, startUrl: flow.startUrl }, testFiles);
      return { ...flow, coverage: { status: coverage.status, tests: coverage.tests.map((t) => ({ file: t.file, title: t.title })) } };
    });
    pipeline.run.update((r) => {
      r.discoveredFlows = flows;
    });
    pipeline.run.emit({ type: "flows.discovered", flows: flows.map((f) => ({ id: f.id, name: f.name, priority: f.priority })) });

    // Selection: --flows, all critical flows with --auto-approve, or the person (UI / terminal).
    let selected: string[];
    if (options.flowIds?.length) {
      const unknown = options.flowIds.filter((id) => !flows.some((f) => f.id === id));
      if (unknown.length) {
        throw new DominionError(`Unknown flow id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`, { code: "UNKNOWN_FLOW", hint: `Discovered flows: ${flows.map((f) => f.id).join(", ")}.` });
      }
      selected = options.flowIds;
    } else if (options.autoApprove) {
      selected = flows.filter((f) => f.priority === "critical").map((f) => f.id);
    } else if (deps.interaction.selectFlows) {
      pipeline.setStage("awaiting_flow_selection");
      selected = await deps.interaction.selectFlows({ run: pipeline.run.record, flows });
      pipeline.checkStopped();
    } else {
      throw new DominionError("No way to choose which flows to plan.", { code: "FLOWS_REQUIRED", hint: "Pass --flows <ids> or --auto-approve." });
    }
    pipeline.run.emit({ type: "flows.selected", flowIds: selected });
    if (!selected.length) return pipeline.finish("done", `Discovered ${flows.length} flows; none were selected.`);

    // Each selected flow follows the task-mode path; two plan at a time, generation is serialized.
    const writer = new Mutex();
    const results: TestResultSummary[] = [];
    const queue = selected.map((id) => flows.find((f) => f.id === id)!);
    const worker = async () => {
      for (let discoveredFlow = queue.shift(); discoveredFlow; discoveredFlow = queue.shift()) {
        const flow: FlowRun = pipeline.newFlow(`${discoveredFlow.name}: ${discoveredFlow.description}`, discoveredFlow.id, discoveredFlow.startUrl);
        pipeline.updateFlow(flow, { name: discoveredFlow.name, coverage: discoveredFlow.coverage });
        const outcome = await pipeline.planFlow(flow);
        if (outcome !== "approved" || pipeline.run.record.options.planOnly) {
          if (outcome === "approved") pipeline.updateFlow(flow, { status: pipeline.run.record.options.autoApprove ? "approved" : "awaiting_approval" });
          continue;
        }
        await writer.run(async () => {
          await pipeline.generateFlow(flow);
          results.push(...(await pipeline.healFlow(flow, await pipeline.runFlowTests(flow))));
          pipeline.recordChanges(flow);
          pipeline.updateFlow(flow, { status: "done" });
        });
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL_FLOWS, queue.length) }, () => worker()));
    const failure = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    if (failure) throw failure.reason;
    const planned = pipeline.run.record.flows.filter((f) => f.planPath).length;
    return pipeline.finish("done", results.length ? summarizeResults(results) : `Planned ${planned} flow${planned === 1 ? "" : "s"}.`);
  } catch (error) {
    return pipeline.fail(error);
  }
}
