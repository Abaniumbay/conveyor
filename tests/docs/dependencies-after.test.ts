import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

async function expectDocumented(file: string): Promise<void> {
  const text = await readFile(file, "utf8");
  expect(text).toContain("`after`");
  expect(text).toContain("closed or done");
  expect(text).toMatch(/pipeline (has|lacks) (no|the) stage/);
  expect(text).toContain("sent back");
  expect(text).toContain("already past the check is not stopped");
}

describe("item.dependenciesMet after is documented", () => {
  test("AC-9.1 docs/configuration.md states the option, the default, the cross-pipeline rule and the sent-back rule", async () => {
    await expectDocumented("docs/configuration.md");
  });

  test("AC-9.1 docs/tasks.md states the option, the default, the cross-pipeline rule and the sent-back rule", async () => {
    await expectDocumented("docs/tasks.md");
  });
});
