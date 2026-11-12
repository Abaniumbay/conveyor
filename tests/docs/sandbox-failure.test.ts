import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("sandbox setup failure documentation", () => {
  test("SPEC.md and docs/architecture.md state that sandbox setup failures inside a run are infrastructure failures", async () => {
    for (const file of ["SPEC.md", "docs/architecture.md"]) {
      const text = await readFile(path.join(root, file), "utf8");
      expect(text).toMatch(/sandbox setup failure inside a run.*is an infrastructure failure/i);
      expect(text).toContain("bwrap: No permissions to create a new namespace");
    }
  });
});
