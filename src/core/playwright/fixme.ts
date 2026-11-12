import { readFileSync, writeFileSync } from "node:fs";
import { type CallExpression, Node, Project } from "ts-morph";

export interface FixmeTarget {
  /** 1-based line and column of the test call (from the JSON report). */
  line: number;
  column: number;
  /** Test title, used when the position no longer matches (the file changed). */
  title: string;
}

/** Single-line, comment-safe reason text. */
export function fixmeComment(reason: string): string {
  return `// DOMinion: ${reason.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim().slice(0, 300)}`;
}

function isTestCall(call: CallExpression): boolean {
  const callee = call.getExpression().getText();
  return /^(test|it)(\.(only|skip|fixme|slow))?$/.test(callee) && call.getArguments().length >= 2;
}

function titleOf(call: CallExpression): string | undefined {
  const first = call.getArguments()[0];
  if (first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first))) return first.getLiteralText();
  return undefined;
}

/**
 * Turns `test("title", ...)` into `test.fixme("title", ...)` with a comment explaining why
 * (spec: Runner and healer: after maxHealAttempts the test is marked fixme and reported).
 * Returns false when the test could not be found or is already fixme.
 */
export function markTestFixme(file: string, target: FixmeTarget, reason: string): boolean {
  const text = readFileSync(file, "utf8");
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile("spec.ts", text, { overwrite: true });
  const calls = sf.getDescendants().filter((n): n is CallExpression => Node.isCallExpression(n) && isTestCall(n));
  const byPosition = calls.find((call) => {
    const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
    return line === target.line && column === target.column;
  });
  const leafTitle = target.title.split(" > ").pop()!;
  const call = byPosition ?? calls.find((c) => titleOf(c) === leafTitle);
  if (!call) return false;
  const callee = call.getExpression();
  if (callee.getText().endsWith(".fixme")) return false;

  const statement = call.getFirstAncestor((a) => Node.isExpressionStatement(a)) ?? call;
  const start = statement.getStart();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const base = callee.getText().split(".")[0]!;
  const next =
    text.slice(0, lineStart) +
    `${indent}${fixmeComment(reason)}${eol}` +
    text.slice(lineStart, callee.getStart()) +
    `${base}.fixme` +
    text.slice(callee.getEnd());
  writeFileSync(file, next, "utf8");
  return true;
}

/** Titles of test() calls in a file, for "the healer must not rename tests" checks. */
export function testTitles(source: string): string[] {
  return [...source.matchAll(/\b(?:test|it)(?:\.(?:only|skip|fixme|slow))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
}

/** Number of expect() assertions, for "the healer must not remove checks" checks. */
export function assertionCount(source: string): number {
  return (source.replace(/\/\/.*$/gm, "").match(/\bexpect(?:\.soft)?\s*\(/g) ?? []).length;
}
