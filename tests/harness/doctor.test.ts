import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { installedCommandCheck } from "../../src/harness/doctor";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-harness-doctor-"));
  directories.push(directory);
  return directory;
}

const runner = { type: "codex", command: "codex" };

describe("installedCommandCheck", () => {
  test("a command that is not on PATH fails with how to install it", () => {
    expect(installedCommandCheck({ runnerName: "kaveh", runner, findTool: () => null })).toEqual({
      name: "harness kaveh",
      status: "fail",
      detail: "codex is not on PATH",
      fix: "install codex and authenticate it as the account Conveyor runs under",
    });
  });

  test("a command that resolves to no executable fails, naming where it was found", async () => {
    const root = await temporary();
    const dangling = path.join(root, "codex");
    await symlink(path.join(root, "removed-release", "codex"), dangling);
    expect(installedCommandCheck({ runnerName: "kaveh", runner, findTool: () => dangling })).toEqual({
      name: "harness kaveh",
      status: "fail",
      detail: `codex (${dangling}) cannot be resolved to an installed executable for confined launch`,
      fix: "point the runner's command at a working install: repair or reinstall codex (a broken symlink is the usual cause), or set the command to its absolute path",
    });
  });

  test("an installed command passes with its location", async () => {
    const executable = path.join(await temporary(), "codex");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    expect(installedCommandCheck({ runnerName: "kaveh", runner, findTool: () => executable })).toEqual({ name: "harness kaveh", status: "ok", detail: executable });
  });
});
