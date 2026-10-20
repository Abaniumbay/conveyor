import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

const guidance = async () => readFile(path.join(root, "AGENTS.md"), "utf8");

describe("agent guidance", () => {
  test("identifies uncovered changed production code as a missing test case", async () => {
    expect(await guidance()).toContain("Changed production code that no test executes is a missing test case.");
  });

  test("requires real assertions for changed production code", async () => {
    expect(await guidance()).toContain("Test its behaviour with real\n  assertions");
  });

  test("forbids tests added solely to raise coverage", async () => {
    expect(await guidance()).toContain("never add a test solely to raise coverage.");
  });
});
