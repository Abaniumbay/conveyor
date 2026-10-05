import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  test("shows explicit MCP progress and the final report without raw harness activity", async () => {
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
          tasks: ["agent.reportProgress", "agent.reportRationale", "agent.reportResult"],
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
        const contextIndex = input.mcp!.args.indexOf("--context") + 1;
        const context = JSON.parse(await readFile(input.mcp!.args[contextIndex]!, "utf8")) as {
          control: { token: string };
        };
        await service.handleMcp({
          tool: "run.report_progress",
          input: { message: "I found the stale labels and am applying the narrow fix." },
        }, context.control.token);
        await service.handleMcp({
          tool: "run.report_rationale",
          input: { message: "Internal reasoning that must not appear in the Agent tab." },
        }, context.control.token);
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
      ["report_progress", "I found the stale labels and am applying the narrow fix."],
      ["report", "Updated the board and verified the tests."],
    ]);
    expect(store.listRunEvents(runId).some((event) => event.type === "activity")).toBe(false);
    expect(store.listRunEvents(runId).some((event) => event.type === "report_rationale")).toBe(true);
    expect(store.costSummary()).toMatchObject({ runs: 1, unavailableRuns: 1 });
    await service.close();
  });

  test("gives a fresh Operator run scoped board diagnostics, durable controls, and skill guidance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-operator-steering-"));
    temporaryDirectories.push(root);
    const instructions = path.resolve(import.meta.dir, "../../skills/conveyor-operator/SKILL.md");
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "worktrees"), artifacts: path.join(root, "artifacts"), interruptGraceMs: 100 },
      web: { listen: "127.0.0.1:4300", steering: { agent: "operator", workspace: root } },
      runners: { codex: { type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true } },
      labels: { enrollment: "conveyor" },
      agents: {
        operator: {
          runner: "codex", effort: "medium", instructions, workspaceAccess: "workspace-write",
          tasks: ["operator.getBoard", "operator.getItemHistory", "operator.retryItem", "operator.moveBacklogItem"],
        },
      },
      pipelines: { default: { stages: [{ id: "backlog" }] } },
      repositories: { repo: { address: "owner/repo", pipeline: "default" } },
      sources: {}, checks: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    store.upsertIssue({
      id: "item-1", repositoryId: "repo", sourceNumber: 87, sourceUrl: "https://example.test/87", title: "Operator item",
      body: "", sourceState: "open", labels: ["conveyor", "conveyor:backlog"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("item-1", { stage: "backlog", state: "active", warning: null });
    store.setQueueRank("item-1", 10);
    store.setStageState({ issueId: "item-1", stageId: "backlog", status: "ready", feedbackCycle: 0, configHash: config.hash });
    store.createRun({ id: "item-run", issueId: "item-1", stageId: "backlog", attempt: 1, kind: "implementation", status: "succeeded", configHash: config.hash, startedAt: "2026-01-01T00:00:00Z" });
    store.appendRunEvent("item-run", "checks", { status: "pending" });

    let retries = 0;
    let service!: ConveyorService;
    service = new ConveyorService(config, store, {} as never, {
      steering: async (input) => {
        expect(input.prompt).toContain("Inspect first, before mutation.");
        expect(input.prompt).toContain("authenticated owner’s explicit steering request");
        const contextIndex = input.mcp!.args.indexOf("--context") + 1;
        const context = JSON.parse(await readFile(input.mcp!.args[contextIndex]!, "utf8")) as {
          control: { token: string };
          allowedTools: string[];
        };
        expect(context.allowedTools).toEqual(["operator.getBoard", "operator.getItemHistory", "operator.retryItem", "operator.moveBacklogItem"]);
        const board = await service.handleMcp({ tool: "operator.getBoard", input: {} }, context.control.token) as { repositories: Array<{ id: string; address: string; health: string; lastReconciledAt: string | null }>; items: Array<{ id: string; queue: { status: string; rank: number | null } }> };
        expect(board.repositories).toEqual([{ id: "repo", address: "owner/repo", health: "healthy", lastReconciledAt: null }]);
        expect(board.items).toContainEqual(expect.objectContaining({ id: "item-1", queue: { status: "queued", rank: 10 } }));
        expect(JSON.stringify(board)).not.toContain(context.control.token);
        const history = await service.handleMcp({ tool: "operator.getItemHistory", input: { itemId: "item-1" } }, context.control.token) as { runs: Array<{ id: string; events: unknown[] }> };
        expect(history.runs).toEqual([expect.objectContaining({ id: "item-run", events: [expect.objectContaining({ type: "checks" })] })]);
        await expect(service.handleMcp({ tool: "operator.getItemHistory", input: { itemId: "missing" } }, context.control.token)).rejects.toThrow("item is not on this configured board");
        const retry = await service.handleMcp({ tool: "operator.retryItem", input: { itemId: "item-1", note: "owner asked" } }, context.control.token);
        expect(await service.handleMcp({ tool: "operator.retryItem", input: { itemId: "item-1", note: "owner asked" } }, context.control.token)).toEqual(retry);
        const first = await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-1", position: "end" } }, context.control.token);
        const repeated = await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-1", position: "end" } }, context.control.token);
        expect(repeated).toEqual(first);
        return { summary: "Done", sessionId: "thread-operator", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, durationMs: 1, exitCode: 0, stderr: "" };
      },
    });
    Object.assign(service as object, {
      retryIssue: async () => {
        retries += 1;
        return { status: "queued", stageId: "backlog" };
      },
    });

    const runId = await service.startSteering("Inspect the board, then move #87 to the end.");
    for (let attempt = 0; attempt < 20 && service.getSteeringRun(runId)?.status === "running"; attempt += 1) await Bun.sleep(5);
    expect(store.getRun(runId)?.result).toEqual({ summary: "Done" });
    expect(service.getSteeringRun(runId)).toEqual({ id: runId, status: "succeeded" });
    expect(retries).toBe(1);
    expect(store.listRunEvents(runId).filter((event) => event.type === "operator.control")).toHaveLength(2);
    await service.close();
  });
});
