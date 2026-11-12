import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitignore, isIgnored, REQUIRED_GITIGNORE_ENTRIES } from "../../src/core/init/gitignore";
import { makeTempDir, removeDir } from "../helpers/tmp";

describe("isIgnored", () => {
  it.each([
    [[".env.local"], ".env.local", true],
    [["/.env.local"], ".env.local", true],
    [[".env*"], ".env.local", true],
    [[".env.*"], ".env.local", true],
    [["*.local"], ".env.local", true],
    [[".env"], ".env.local", false],
    [[".auth"], ".auth/", true],
    [[".auth/"], ".auth/", true],
    [["/.auth/"], ".auth/", true],
    [[".auth/*"], ".auth/", true],
    [[".auth/**"], ".auth/", true],
    [["**/.auth"], ".auth/", true],
    [[".auth/"], ".auth", false], // dir-only pattern does not match a file
    [[".dominion/", "!.dominion/"], ".dominion/", false],
    [["# .dominion/"], ".dominion/", false],
    [["src/.dominion/"], ".dominion/", false],
    [["  ", ".dominion   "], ".dominion/", true],
  ] as const)("%j covers %s -> %s", (lines, entry, expected) => {
    expect(isIgnored(lines, entry)).toBe(expected);
  });
});

describe("ensureGitignore", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) removeDir(dir);
    dir = undefined;
  });

  it("creates .gitignore with all required entries when missing", () => {
    dir = makeTempDir("gitignore");
    const result = ensureGitignore(dir);
    expect(result.created).toBe(true);
    expect(result.added).toEqual([...REQUIRED_GITIGNORE_ENTRIES]);
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    for (const entry of REQUIRED_GITIGNORE_ENTRIES) expect(content).toContain(entry);
  });

  it("appends only missing entries, preserving existing content and CRLF line endings", () => {
    dir = makeTempDir("gitignore");
    writeFileSync(join(dir, ".gitignore"), "node_modules\r\n.env*\r\n.auth", "utf8");
    const result = ensureGitignore(dir);
    expect(result.added).toEqual([".dominion/"]);
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(content.startsWith("node_modules\r\n.env*\r\n.auth\r\n")).toBe(true);
    expect(content).toContain(".dominion/\r\n");
    expect(content).not.toMatch(/[^\r]\n/);
  });

  it("is idempotent", () => {
    dir = makeTempDir("gitignore");
    ensureGitignore(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf8");
    const second = ensureGitignore(dir);
    expect(second.added).toEqual([]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(first);
  });
});
