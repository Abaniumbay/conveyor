import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("docs/configuration.md", () => {
  test("documents the shell field, its default, its Claude Code effect and the Codex error", async () => {
    const text = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");
    expect(text).toContain("`shell` (default `true`)");
    expect(text).toContain("a Claude Code agent is launched without `Bash` in both `--tools` and `--allowedTools`");
    expect(text).toContain("Codex reaches files only through its shell, so `shell: false` on a Codex agent fails `config check`");
  });
});
