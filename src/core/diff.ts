/**
 * Line-based unified diff (Myers' O(ND) algorithm). Used for proposed changes to hand-written files
 * and for the Results screen; avoids a diff dependency.
 */

type Op = { type: "equal" | "delete" | "insert"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Array<number>(2 * max + 2).fill(0);
  const trace: number[][] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return [];
}

function backtrack(trace: number[][], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "insert", line: b[y - 1]! });
      else ops.push({ type: "delete", line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Unified diff of two texts with `context` lines around each change. Empty string when equal. */
export function unifiedDiff(before: string, after: string, path: string, options: { context?: number; isNew?: boolean } = {}): string {
  const context = options.context ?? 3;
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = myers(a, b);
  if (!ops.some((op) => op.type !== "equal")) return "";
  const header = [`--- ${options.isNew ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  const hunks: string[] = [];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  const positions = ops.map((op) => {
    const pos = { a: aLine, b: bLine };
    if (op.type !== "insert") aLine++;
    if (op.type !== "delete") bLine++;
    return pos;
  });
  while (i < ops.length) {
    if (ops[i]!.type === "equal") {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while changes are within 2*context of each other.
    for (;;) {
      while (end < ops.length && ops[end]!.type !== "equal") end++;
      let next = end;
      while (next < ops.length && ops[next]!.type === "equal" && next - end < context * 2) next++;
      if (next < ops.length && ops[next]!.type !== "equal") {
        end = next;
        continue;
      }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((op) => op.type !== "insert").length;
    const bCount = slice.filter((op) => op.type !== "delete").length;
    const aStart = aCount ? positions[start]!.a : positions[start]!.a - 1;
    const bStart = bCount ? positions[start]!.b : positions[start]!.b - 1;
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) hunks.push(`${op.type === "equal" ? " " : op.type === "delete" ? "-" : "+"}${op.line}`);
    i = end;
    start = end;
  }
  return `${[...header, ...hunks].join("\n")}\n`;
}

export function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
