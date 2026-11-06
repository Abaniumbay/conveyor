import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("stage script temporary failure documentation", () => {
  test("docs/configuration.md documents exit code 75 and transient: true", async () => {
    const configuration = await readFile(path.join(root, "docs/configuration.md"), "utf8");
    const section = configuration.slice(configuration.indexOf("## Temporary script failures"));
    expect(section).toMatch(/exit(s|ing)?\s+(with\s+)?(code\s+)?`?75/i);
    expect(section).toContain("transient");
  });
});
