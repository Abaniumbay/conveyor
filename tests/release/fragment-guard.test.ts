import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const TESTS = path.join(import.meta.dir, "..");
// Release tests build their own temporary repositories with a changes/ directory; that is allowed.
const EXEMPT = path.join(TESTS, "release");

// A quoted or relative path into changes/<issue>-…, or a path.join(…, "changes", …) segment.
const READS_FRAGMENTS = [/(["'`]|\.\.\/)changes\/\d/, /,\s*["'`]changes["'`]\s*[,)]/];

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return full === EXEMPT ? [] : testFiles(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  }));
  return nested.flat();
}

describe("release-note fragments", () => {
  // Releasing consumes every fragment in changes/, so a test that reads one fails on the release
  // commit and nowhere else. CI validates the fragments themselves with `bun run changelog`.
  test("no test outside tests/release reads the repository's changes/ fragments", async () => {
    const offenders: string[] = [];
    for (const file of await testFiles(TESTS)) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (READS_FRAGMENTS.some((pattern) => pattern.test(line))) offenders.push(`${path.relative(TESTS, file)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the guard recognises the ways a test reaches a fragment", () => {
    for (const line of [
      'readFile(path.join(root, "changes/332-drawn-workflow-graph.md"), "utf8")',
      'readFile(path.join(import.meta.dir, "../../changes/343-pre-change-lease-push.md"), "utf8")',
      'readFile(path.join(root, "changes", "343-pre-change-lease-push.md"), "utf8")',
      "Bun.file(`changes/12-x.md`)",
    ]) expect(READS_FRAGMENTS.some((pattern) => pattern.test(line))).toBe(true);
    for (const line of ['url: "https://code.example/repo/changes/23"', 'expect(text).toContain("uncommitted changes")']) {
      expect(READS_FRAGMENTS.some((pattern) => pattern.test(line))).toBe(false);
    }
  });
});
