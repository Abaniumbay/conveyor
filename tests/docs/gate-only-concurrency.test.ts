import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("gate-only concurrency documentation", () => {
  test("states that repository concurrency limits only agent or script executions and gate-only ones count toward the runner limit", async () => {
    const [configuration, specification] = await Promise.all([
      readFile(path.join(root, "docs/configuration.md"), "utf8"),
      readFile(path.join(root, "SPEC.md"), "utf8"),
    ]);

    for (const text of [configuration, specification]) {
      expect(text).toMatch(/limits only (the )?executions that start an agent or script process/);
      expect(text).toMatch(/only `check` tasks remain/);
      expect(text).toMatch(/counts toward (the global runner limit|`settings.runners`)/);
    }
  });
});
