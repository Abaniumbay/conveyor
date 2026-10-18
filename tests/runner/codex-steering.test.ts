import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodexSteering } from "../../src/runner/codex-steering";
import { bwrapUnavailableReason } from "../support/bwrap";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("runCodexSteering", () => {
  const confinedTest = bwrapUnavailableReason() ? test.skip : test;

  test("streams Codex events and retains the final agent report", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-steering-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const executable = path.join(directory, "fake-codex");
    const capture = path.join(directory, "capture.json");
    await mkdir(workspace);
    await writeFile(executable, `#!/usr/bin/env bun
      const args = process.argv.slice(2);
      const prompt = await new Response(Bun.stdin.stream()).text();
      await Bun.write(process.env.TMPDIR + "/steering-marker", "temporary");
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ args, prompt, tmpdir: process.env.TMPDIR, home: process.env.HOME }));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-steer" }));
      console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Changed the board and ran tests." } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 90, cached_input_tokens: 50, output_tokens: 20 } }));
    `);
    await chmod(executable, 0o755);
    const events: unknown[] = [];

    const result = await runCodexSteering({
      command: executable,
      workspace,
      artifactsDirectory: path.join(directory, "artifacts", "run-1"),
      prompt: "Make the requested UI change",
      model: "gpt-test",
      effort: "medium",
      sandbox: "workspace-write",
      automaticApprovals: true,
      mcp: { command: "bun", args: ["run", "mcp.ts"] },
      env: { CAPTURE: capture },
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      summary: "Changed the board and ran tests.",
      sessionId: "thread-steer",
      usage: { inputTokens: 90, outputTokens: 20, cachedTokens: 50 },
      exitCode: 0,
    });
    expect(events).toHaveLength(4);
    const invocation = JSON.parse(await readFile(capture, "utf8")) as { args: string[]; prompt: string; tmpdir: string; home: string };
    expect(invocation.prompt).toBe("Make the requested UI change");
    expect(invocation.args).toContain("--approve-for-me");
    expect(invocation.args).toContain("--skip-git-repo-check");
    expect(invocation.args).not.toContain("--output-schema");
    expect(invocation.args).toContain("mcp_servers.conveyor.required=true");
    expect(invocation.args).toContain('mcp_servers.conveyor.command="bun"');
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(existsSync(invocation.tmpdir)).toBe(false);
    expect(existsSync(invocation.home)).toBe(false);
  });

  confinedTest("confines a steering run to its fresh scratch directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-steering-confined-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const otherHome = path.join(directory, "another-conveyor-home");
    const database = path.join(otherHome, "conveyor.sqlite");
    const executable = path.join(directory, "fake-codex");
    await mkdir(workspace);
    await mkdir(otherHome);
    await writeFile(database, "database that must not be readable");
    await writeFile(executable, `#!/bin/sh
      test -z "$(ls -A \"$TMPDIR\")" || exit 11
      if cat "$HOST_DATABASE" >/dev/null 2>&1; then exit 12; fi
      printf usable > "$TMPDIR/operator-file"
      test -f "$TMPDIR/operator-file" || exit 13
      printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"confined"}}'
    `);
    await chmod(executable, 0o755);

    const result = await runCodexSteering({
      command: executable,
      workspace,
      artifactsDirectory: path.join(directory, "artifacts", "run-1"),
      prompt: "Inspect the board",
      sandbox: "read-only",
      automaticApprovals: false,
      filesystem: "scratch",
      env: { HOST_DATABASE: database },
    });

    expect(result.summary).toBe("confined");
    expect(await Bun.file(database).text()).toBe("database that must not be readable");
  });
});
