import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("toolchain path documentation", () => {
  test("documents agentToolchainPaths and its read-only visibility rule", async () => {
    const configuration = await readFile(path.join(root, "docs/configuration.md"), "utf8");

    expect(configuration).toContain("agentToolchainPaths");
    expect(configuration).toMatch(/absolute path/);
    expect(configuration).toMatch(/\*\*read-only\*\*/);
    expect(configuration).toContain("`writableRoots`");
  });
});
