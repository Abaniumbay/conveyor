import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("item.dependenciesMet after is documented", () => {
  for (const file of ["docs/configuration.md", "docs/tasks.md"]) {
    test(`AC-9.1 ${file} states the option, the default, the cross-pipeline rule and the sent-back rule`, async () => {
      const text = await readFile(file, "utf8");
      expect(text).toContain("`after`");
      expect(text).toContain("closed or done");
      expect(text).toMatch(/pipeline (has|lacks) (no|the) stage/);
      expect(text).toContain("sent back");
      expect(text).toContain("already past the check is not stopped");
    });
  }
});
