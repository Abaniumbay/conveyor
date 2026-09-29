import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("ConveyorService steering", () => {
  test("runs one configured agent and persists progress plus the final report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-steering-service-"));
    temporaryDirectories.push(root);
    const instructions = path.join(root, "operator.md");
    await writeFile(instructions, "Inspect first and report clearly.");
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: {
        workspaces: path.join(root, "worktrees"),
        artifacts: path.join(root, "artifacts"),
        interruptGraceMs: 100,
      },
      web: {
        listen: "127.0.0.1:4300",
        steering: { agent: "operator", workspace: root },
      },
      runners: {
        codex: {
          type: "codex",
          command: "codex",
          sandbox: "workspace-write",
          automaticApprovals: true,
        },
      },
      agents: {
        operator: {
          runner: "codex",
          effort: "medium",
          instructions,
          workspaceAccess: "workspace-write",
          tools: ["run.report_progress", "run.report_result"],
        },
      },
      pipelines: {},
      repositories: {},
      sources: {},
      checks: {},
    } as unknown as ConveyorConfig;
    const service = new ConveyorService(config, store, {} as never, {
      steering: async (input) => {
        expect(input.mcp).toMatchObject({ command: process.execPath });
        input.onEvent?.({
          type: "item.started",
          item: { type: "command_execution", command: "git status" },
        });
        return {
          summary: "Updated the board and verified the tests.",
          sessionId: "thread-1",
          usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50 },
          durationMs: 1500,
          exitCode: 0,
          stderr: "",
        };
      },
    });

    const runId = await service.startSteering("Make the board clearer");
    for (let attempt = 0; attempt < 20 && service.getSteeringRun(runId)?.status === "running"; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(service.getSteeringRun(runId)).toEqual({ id: runId, status: "succeeded" });
    expect(service.getSteeringEvents(runId, 0).map((event) => [event.type, event.text])).toEqual([
      ["user", "Make the board clearer"],
      ["activity", "Running: git status"],
      ["report", "Updated the board and verified the tests."],
    ]);
    expect(store.costSummary()).toMatchObject({ runs: 1, unavailableRuns: 1 });
    await service.close();
  });
});
