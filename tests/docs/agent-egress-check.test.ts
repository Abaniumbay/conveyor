import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("operations guide shows how to run the egress check against an installed home", async () => {
  const operations = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

  expect(operations).toContain("scripts/check-agent-egress.ts <repository-id> --config ~/.conveyor/config/conveyor.yaml --home ~/.conveyor --runner <runner-id>");
  expect(operations).toContain('"$CLAUDE_CODE_SHELL_PREFIX" <command>');
});
