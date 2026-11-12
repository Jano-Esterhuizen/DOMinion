import { z } from "zod";
import type { Sitemap } from "../crawler/crawl";
import { DominionError } from "../errors";
import { slugify } from "../orchestrator/ids";
import type { DiscoveredFlow } from "../orchestrator/types";
import { type AgentContext, credentialEnvVars } from "./context";
import { renderPrompt } from "./prompts";
import type { AgentResult } from "./runner";

/** The discovery agent's output (spec: Flow discovery). */
export const discoveredFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  priority: z.enum(["critical", "high", "medium"]),
  startUrl: z.string().min(1),
  pagesInvolved: z.array(z.string()),
  description: z.string().min(1),
  destructive: z.boolean(),
});

export const discoveryOutputSchema = z.object({
  flows: z.array(discoveredFlowSchema).min(1).max(30),
});

export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;

/** JSON Schema handed to the Agent SDK's structured output. */
export function discoveryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(discoveryOutputSchema, { target: "draft-7" }) as Record<string, unknown>;
}

const MAX_PROMPT_CHARS = 120_000;

/** The compact sitemap the agent reads: everything but full snapshots and thumbnails. */
export function compactSitemap(sitemap: Sitemap): string {
  const pages = sitemap.pages.map((p, index) => ({
    pattern: p.pattern,
    url: p.url,
    title: p.title,
    status: p.status,
    headings: p.headings.slice(0, 8),
    buttons: p.buttons.slice(0, 12),
    counts: p.counts,
    links: p.links.slice(0, 15),
    snapshot: index < 60 ? p.ariaSnapshot.slice(0, 600) : undefined,
  }));
  let text = JSON.stringify({ baseURL: sitemap.baseURL, role: sitemap.role, pages }, null, 1);
  if (text.length > MAX_PROMPT_CHARS) {
    const lean = pages.map(({ snapshot: _snapshot, ...rest }) => rest);
    text = JSON.stringify({ baseURL: sitemap.baseURL, role: sitemap.role, pages: lean, note: "snapshots omitted to fit" }, null, 1);
    if (text.length > MAX_PROMPT_CHARS) text = `${text.slice(0, MAX_PROMPT_CHARS)}\n... (truncated: ${sitemap.pages.length} pages in total)`;
  }
  return text;
}

/** Parses the agent output (structured output or JSON text) and validates it. */
export function parseDiscovery(result: AgentResult): { ok: true; value: DiscoveryOutput } | { ok: false; error: string } {
  let candidate: unknown = result.structured;
  if (candidate === undefined) {
    const text = result.text.trim();
    const match = /\{[\s\S]*\}/.exec(text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, ""));
    if (!match) return { ok: false, error: "the reply contained no JSON object" };
    try {
      candidate = JSON.parse(match[0]);
    } catch (error) {
      return { ok: false, error: `the JSON did not parse: ${(error as Error).message}` };
    }
  }
  const parsed = discoveryOutputSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  return { ok: true, value: parsed.data };
}

/** Normalizes ids (unique kebab-case) and start URLs (absolute, on the app). */
export function normalizeDiscovered(output: DiscoveryOutput, baseURL: string): DiscoveredFlow[] {
  const seen = new Set<string>();
  const origin = new URL(baseURL).origin;
  return output.flows.map((flow) => {
    let id = slugify(flow.id || flow.name);
    for (let n = 2; seen.has(id); n++) id = `${slugify(flow.id || flow.name)}-${n}`;
    seen.add(id);
    let startUrl: string;
    try {
      const url = new URL(flow.startUrl.replace(/:id\b/g, "1"), `${baseURL}/`);
      startUrl = url.origin === origin ? url.href : baseURL;
    } catch {
      startUrl = baseURL;
    }
    return { ...flow, id, startUrl };
  });
}

/**
 * Flow discovery (spec: a separate agent call with no browser tools; it reads sitemap.json and
 * returns JSON matching a zod schema; validate the response and retry once on schema failure).
 */
export async function discoverFlows(ctx: AgentContext, sitemap: Sitemap, charge: (result: AgentResult) => void): Promise<DiscoveredFlow[]> {
  const base = [
    `Propose the critical user flows for ${sitemap.baseURL} (crawled as role "${sitemap.role}", ${sitemap.pages.length} page patterns).`,
    "",
    "Sitemap (JSON):",
    compactSitemap(sitemap),
  ].join("\n");
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? base : `${base}\n\nYour previous reply was rejected because ${lastError}. Reply again with JSON that matches the schema exactly.`;
    const result = await ctx.runner.run(
      {
        agent: "discovery",
        model: ctx.model,
        systemPrompt: renderPrompt("discovery", {}, ctx.paths.promptOverridesDir, ctx.paths.root),
        prompt,
        maxTurns: 6,
        maxBudgetUsd: ctx.remainingBudget(),
        cwd: ctx.paths.root,
        outputSchema: discoveryJsonSchema(),
        hiddenEnvVars: credentialEnvVars(ctx),
        signal: ctx.signal,
        policy: {
          agent: "discovery",
          root: ctx.paths.root,
          builtinTools: [],
          mcpTools: [],
          readRoots: [],
          writeRoots: [],
          writeExtensions: [],
          excludePatterns: [],
          redactor: ctx.redactor,
        },
      },
      (payload) => ctx.run.emit(payload),
    );
    charge(result);
    const parsed = parseDiscovery(result);
    if (parsed.ok) return normalizeDiscovered(parsed.value, ctx.env.baseURL);
    lastError = parsed.error;
    ctx.run.emit({ type: "log", level: "warn", message: `Flow discovery output was invalid (${lastError}).${attempt === 1 ? " Retrying once." : ""}` });
  }
  throw new DominionError(`Flow discovery did not return valid flows: ${lastError}.`, {
    code: "DISCOVERY_INVALID",
    hint: "Run the crawl again; if it keeps failing, try a more capable model with --model.",
  });
}
