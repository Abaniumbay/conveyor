import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const configuration = async (): Promise<string> => readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");

test("AC-13.1: the configuration guide says only the `claude login` credential is refreshed, on the host", async () => {
  const text = await configuration();
  expect(text).toMatch(/only the `claude login` credential is refreshed/);
  expect(text).toMatch(/`CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are not refreshed/);
  expect(text).toMatch(/Conveyor refreshes it on the host/);
  expect(text).toMatch(/the login must be renewed with `claude login`/);
  expect(text).not.toMatch(/each run gets a private copy of (it|a stored login)\b/i);
});
