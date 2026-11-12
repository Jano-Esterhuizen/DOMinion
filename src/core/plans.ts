import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Redactor } from "./redact";

/**
 * Markdown plans with YAML frontmatter (spec: Planner output). Frontmatter is flat key: value
 * pairs, so a tiny parser is enough and avoids a YAML dependency.
 */
/** "covered": existing tests already cover the flow, so nothing is generated. */
export type PlanStatus = "draft" | "approved" | "rejected" | "covered";

export interface PlanFrontmatter {
  env: string;
  role: string;
  flow: string;
  area?: string;
  runId: string;
  createdAt: string;
  status: PlanStatus;
  [key: string]: string | undefined;
}

export interface ParsedPlan {
  frontmatter: Record<string, string>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1).replace(/''/g, "'");
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

function quoteIfNeeded(value: string): string {
  return /^[\w./@:+-][\w ./@:+-]*$/.test(value) && !/:\s/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

/** Splits frontmatter from the body. Tolerates a leading code fence the model may wrap the plan in. */
export function parsePlan(text: string): ParsedPlan {
  let source = text.replace(/^﻿/, "");
  const fenced = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```\s*$/.exec(source.trim());
  if (fenced) source = fenced[1]!;
  const match = FENCE.exec(source.trimStart());
  if (!match) return { frontmatter: {}, body: source.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) frontmatter[m[1]!] = unquote(m[2]!);
  }
  return { frontmatter, body: source.trimStart().slice(match[0].length).trim() };
}

export function serializePlan(frontmatter: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${quoteIfNeeded(value!)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** The plan's "# Title" heading, if any. */
export function planTitle(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

/** Scenario headings ("### 1. Title") in order. */
export function planScenarios(body: string): string[] {
  return [...body.matchAll(/^###\s+(?:\d+[.)]\s*)?(.+)$/gm)].map((m) => m[1]!.trim());
}

const AREA_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Rewrites a plan file the planner produced: fixed fields (env, role, flow, runId, createdAt,
 * status) come from the run, not the model; secret values are redacted.
 */
export function normalizePlanFile(path: string, expected: PlanFrontmatter, redactor: Redactor): { title?: string; area?: string; scenarios: string[] } {
  const parsed = parsePlan(readFileSync(path, "utf8"));
  const areaCandidate = (parsed.frontmatter.area ?? expected.area ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const area = AREA_RE.test(areaCandidate) ? areaCandidate : undefined;
  const frontmatter: Record<string, string | undefined> = {
    env: expected.env,
    role: expected.role,
    flow: expected.flow,
    area,
    runId: expected.runId,
    createdAt: expected.createdAt,
    status: expected.status,
  };
  const body = redactor.redact(parsed.body);
  writeFileSync(path, serializePlan(frontmatter, body), "utf8");
  return { title: planTitle(body), area, scenarios: planScenarios(body) };
}

export function readPlan(path: string): ParsedPlan {
  return parsePlan(readFileSync(path, "utf8"));
}

export function setPlanStatus(path: string, status: PlanStatus): void {
  if (!existsSync(path)) return;
  const parsed = readPlan(path);
  writeFileSync(path, serializePlan({ ...parsed.frontmatter, status }, parsed.body), "utf8");
}
