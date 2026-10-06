import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderCliDocs } from "../../scripts/generate-cli-docs";

describe("docs/cli.md", () => {
  test("matches the generator output", async () => {
    const actual = await readFile(path.join(import.meta.dir, "../../docs/cli.md"), "utf8");
    if (actual !== renderCliDocs()) throw new Error("docs/cli.md is out of date: run `bun run docs:cli`");
  });

  test("documents every visible command and the exit codes", () => {
    const text = renderCliDocs();
    for (const command of ["init", "doctor", "config migrate", "service install", "item retry", "questions answer", "upgrade", "rollback", "logs", "diagnostics export"]) {
      expect(text).toContain(`### \`conveyor ${command}`);
    }
    expect(text).not.toContain("check-config");
    expect(text).toContain("| 5 | The service refused the request");
  });
});
