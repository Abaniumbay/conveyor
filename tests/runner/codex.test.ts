import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexRunnerError, runCodex } from "../../src/runner/codex";

const temporaryDirectories: string[] = [];

async function fixture(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-codex-"));
  temporaryDirectories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts");
  const executable = path.join(directory, "fake-codex");
  const capture = path.join(directory, "capture.json");
  await mkdir(workspace);
  await mkdir(artifacts);
  await writeFile(executable, `#!/usr/bin/env bun\n${source}`);
  await chmod(executable, 0o755);
  return { directory, workspace, artifacts, executable, capture };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runCodex", () => {
  test("builds a fail-closed non-interactive run and parses JSONL usage", async () => {
    const files = await fixture(`
      const args = process.argv.slice(2);
      const prompt = await new Response(Bun.stdin.stream()).text();
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ args, prompt }));
      const output = args[args.indexOf("-o") + 1];
      await Bun.write(output, JSON.stringify({
        version: 1,
        outcome: "success",
        status: "done",
        summary: "implemented",
        reason: null,
        metrics: { tests: 4 },
        artifacts: []
      }));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }));
      console.log(JSON.stringify({
        type: "item.completed",
        item: { id: "item-1", type: "command_execution", command: "bun test", status: "completed" }
      }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 25 }
      }));
    `);
    const events: unknown[] = [];

    const result = await runCodex({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Implement the issue",
      model: "gpt-test",
      effort: "high",
      sandbox: "workspace-write",
      automaticApprovals: true,
      mcp: {
        command: "bun",
        args: ["run", "/opt/conveyor/mcp.ts", "--context", "/tmp/context.json"],
      },
      env: { CAPTURE: files.capture },
      onEvent: (event) => events.push(event),
    });

    expect(result.stageResult).toMatchObject({ status: "done", summary: "implemented" });
    expect(result.sessionId).toBe("thread-123");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 60,
    });
    expect(result.cost.source).toBe("unavailable");
    expect(events).toHaveLength(3);

    const invocation = JSON.parse(await readFile(files.capture, "utf8")) as {
      args: string[];
      prompt: string;
    };
    expect(invocation.prompt).toBe("Implement the issue");
    expect(invocation.args).toContain("--json");
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args).toContain("--approve-for-me");
    expect(invocation.args).not.toContain("--full-auto");
    expect(invocation.args).toContain('mcp_servers.conveyor.required=true');
  });

  test("classifies usage-limit failures for automatic retry", async () => {
    const files = await fixture(`
      console.error("You have hit your usage limit. Try again later.");
      process.exit(1);
    `);

    try {
      await runCodex({
        command: files.executable,
        workspace: files.workspace,
        artifactsDirectory: files.artifacts,
        prompt: "Implement",
        sandbox: "workspace-write",
        automaticApprovals: true,
        mcp: { command: "bun", args: ["mcp.ts"] },
      });
      throw new Error("expected Codex failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexRunnerError);
      expect(error).toMatchObject({ kind: "usage-limit", exitCode: 1 });
    }
  });
});
