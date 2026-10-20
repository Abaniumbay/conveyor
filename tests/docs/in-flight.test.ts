import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("in-flight documentation", () => {
  test("documents the in-flight limit, its interval, waiting, release and relation to concurrency", async () => {
    const [configuration, specification] = await Promise.all([
      readFile(path.join(root, "docs/configuration.md"), "utf8"),
      readFile(path.join(root, "SPEC.md"), "utf8"),
    ]);

    for (const text of [configuration, specification]) {
      expect(text).toContain("inFlight");
      expect(text).toContain("`concurrency`");
      expect(text).toMatch(/in-progress slot/);
      expect(text).toMatch(/offboarded/);
      expect(text).toMatch(/repository pause/i);
    }
  });
});
