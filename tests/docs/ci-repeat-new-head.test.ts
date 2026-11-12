import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("required-CI repeated failure documentation", () => {
  test("SPEC.md and the task catalogue state that a repeat requires a new head", async () => {
    const [specification, tasks] = await Promise.all([
      readFile(path.join(root, "SPEC.md"), "utf8"),
      readFile(path.join(root, "docs/tasks.md"), "utf8"),
    ]);

    expect(specification).toMatch(/counts as repeated only when it is observed on a different head/);
    expect(tasks).toMatch(/same head observed again never counts as a repeat/);
  });
});
