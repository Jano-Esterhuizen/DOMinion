import { Fragment, type ReactNode } from "react";

const STATUS_TONE: Record<string, string> = {
  done: "good",
  passed: "good",
  approved: "good",
  "session-valid": "good",
  "no-session-needed": "muted",
  running: "busy",
  planning: "busy",
  generating: "busy",
  healing: "busy",
  crawling: "busy",
  discovering: "busy",
  created: "busy",
  awaiting_approval: "warn",
  awaiting_flow_selection: "warn",
  fixme: "warn",
  skipped: "muted",
  stopped: "warn",
  rejected: "muted",
  "session-expired": "warn",
  "never-logged-in": "warn",
  "session-unverified": "warn",
  failed: "bad",
  timedOut: "bad",
  "credentials-missing": "bad",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`pill pill-${STATUS_TONE[status] ?? "muted"}`} data-status={status}>
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

const BADGE_LABEL: Record<string, string> = {
  "no-session-needed": "guest, no login",
  "credentials-missing": "credentials missing",
  "never-logged-in": "never logged in",
  "session-valid": "session valid",
  "session-expired": "session expired",
  "session-unverified": "session saved (not verified)",
};

export function AuthBadge({ badge }: { badge: string }) {
  return <StatusPill status={badge} label={BADGE_LABEL[badge] ?? badge} />;
}

/** Unified diff with added/removed lines highlighted. */
export function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="muted">No changes.</p>;
  return (
    <pre className="diff" aria-label="diff">
      {diff.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        return (
          <span key={i} className={`diff-${kind}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function inline(text: string): ReactNode[] {
  // **bold** and `code`, rendered as elements (never as HTML).
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    parts.push(token.startsWith("**") ? <strong key={key++}>{token.slice(2, -2)}</strong> : <code key={key++}>{token.slice(1, -1)}</code>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Minimal Markdown preview for plans: headings, lists, paragraphs, code fences. */
export function MarkdownPreview({ source }: { source: string }) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const blocks: ReactNode[] = [];
  const lines = body.split(/\r?\n/);
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++}>{code.join("\n")}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = (`h${Math.min(level + 1, 5)}` as unknown) as "h2";
      blocks.push(<Tag key={key++}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(\d+[.)]|[-*])\s+/.test(line)) {
      const items: Array<{ depth: number; text: string; ordered: boolean }> = [];
      while (i < lines.length && /^\s*(\d+[.)]|[-*])\s+/.test(lines[i]!)) {
        const m = /^(\s*)(\d+[.)]|[-*])\s+(.*)$/.exec(lines[i]!)!;
        items.push({ depth: m[1]!.length >= 2 ? 1 : 0, text: m[3]!, ordered: /\d/.test(m[2]!) });
        i++;
      }
      blocks.push(
        <ul key={key++} className="plan-list">
          {items.map((item, j) => (
            <li key={j} className={item.depth ? "nested" : undefined}>
              {item.ordered && !item.depth ? <span className="muted">{j + 1}. </span> : null}
              {inline(item.text)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim()) blocks.push(<p key={key++}>{inline(line)}</p>);
    i++;
  }
  return <div className="markdown">{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>;
}

const STAGES: Array<{ id: string; label: string; matches: string[] }> = [
  { id: "crawl", label: "Crawl", matches: ["crawling"] },
  { id: "discover", label: "Discover", matches: ["discovering", "awaiting_flow_selection"] },
  { id: "plan", label: "Plan", matches: ["planning", "awaiting_approval"] },
  { id: "generate", label: "Generate", matches: ["generating"] },
  { id: "run", label: "Run", matches: ["running"] },
  { id: "heal", label: "Heal", matches: ["healing"] },
];

/** Stage-by-stage timeline (crawl, discover, plan, generate, run, heal). */
export function Timeline({ mode, reached, current, finished }: { mode: string; reached: Set<string>; current?: string; finished: boolean }) {
  const stages = mode === "crawl" ? STAGES : STAGES.slice(2);
  return (
    <ol className="timeline" aria-label="Run stages">
      {stages.map((stage) => {
        const isCurrent = !finished && current !== undefined && stage.matches.includes(current);
        const done = stage.matches.some((m) => reached.has(m)) && !isCurrent;
        return (
          <li key={stage.id} className={isCurrent ? "current" : done ? "done" : undefined} aria-current={isCurrent ? "step" : undefined}>
            {stage.label}
          </li>
        );
      })}
    </ol>
  );
}

export function ErrorNote({ error, hint }: { error?: string; hint?: string }) {
  if (!error) return null;
  return (
    <div className="note note-bad" role="alert">
      <strong>{error}</strong>
      {hint ? <div className="muted">{hint}</div> : null}
    </div>
  );
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
