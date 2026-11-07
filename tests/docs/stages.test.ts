import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("stages documentation", () => {
  test("configuration, operations and README describe the stage list, overrides.stages and skip", async () => {
    for (const file of ["docs/configuration.md", "docs/operations.md", "README.md"]) {
      const text = await read(file);
      expect(text).toContain("stages");
      expect(text).toContain("overrides.stages.");
      expect(text).toContain("skip: true");
    }
  });

  test("configuration has the migration section with its five steps and pipelines are described nowhere else", async () => {
    const config = await read("docs/configuration.md");
    const start = config.indexOf("## Migrating from pipelines");
    expect(start).toBeGreaterThan(-1);
    const next = config.indexOf("\n## ", start + 1);
    const section = config.slice(start, next === -1 ? undefined : next);
    expect(section).toContain("config check");
    expect(section).toContain("config migrate --stages");
    expect(section).toContain("--drain");
    expect(section.match(/^\d+\. /gm)?.length).toBeGreaterThanOrEqual(5);
    const outside = config.slice(0, start) + (next === -1 ? "" : config.slice(next));
    for (const text of [outside, await read("README.md"), await read("docs/dashboard.md"), (await read("docs/operations.md")).replace(/A configuration that still\s+uses `pipelines:` follows \[Migrating from pipelines\]\(configuration\.md#migrating-from-pipelines\)\./, "")]) {
      expect(text).not.toMatch(/pipelines?:/);
    }
  });
});
