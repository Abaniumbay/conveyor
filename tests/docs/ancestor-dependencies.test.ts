import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const read = (file: string) => readFile(path.join(import.meta.dir, "../..", file), "utf8");

describe("ancestor dependencies documentation", () => {
  test("AC-7.5 SPEC.md states the scheduler rule, own-only dependencies and the status line", async () => {
    const specification = await read("SPEC.md");
    expect(specification).toContain("The scheduler does not start an item while any ancestor has an unmet dependency");
    expect(specification).toContain("A child's dependencies are only the ones it declares");
    expect(specification).toContain("\"Waiting: parent #12 is blocked by #9\"");
    expect(specification).not.toContain("the dependencies of every ancestor are satisfied");
    expect(specification).not.toContain("inheritedDependencies");
  });

  test("AC-7.5 architecture.md describes the scheduler row with the same rule", async () => {
    const architecture = await read("docs/architecture.md");
    expect(architecture).toContain("holds back an item while an ancestor has an unmet dependency");
    expect(architecture).not.toContain("every ancestor's must be met");
  });
});
