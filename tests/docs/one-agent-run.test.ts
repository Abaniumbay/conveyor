import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("one agent.run per stage documentation", () => {
  test("docs/configuration.md states the rule and its reasons", async () => {
    const text = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");
    expect(text).toContain("A stage holds at most one `agent.run` action");
    expect(text).toContain("One stage is one role");
    expect(text).toContain("a retry reruns the whole action list");
    expect(text).toContain("attribute work by stage");
  });
});
