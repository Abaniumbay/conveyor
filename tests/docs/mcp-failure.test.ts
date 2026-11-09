import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("operations guide names the user-namespace cause of an unavailable MCP server and its fix", async () => {
  const operations = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

  expect(operations).toContain("mcp.failure");
  expect(operations).toContain("kernel.apparmor_restrict_unprivileged_userns");
  expect(operations).toContain("Codex's own bubblewrap");
  expect(operations).toContain("AppArmor profile for bwrap");
});
