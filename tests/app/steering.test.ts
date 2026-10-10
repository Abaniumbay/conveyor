import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { createGitHubCodeHostRegistry } from "../../src/source/github/codehost-registry";

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
      settings: {
        workspaces: path.join(root, "worktrees"), artifacts: path.join(root, "artifacts"), interruptGraceMs: 100, labelPrefix: "conveyor",
        retries: { infrastructureAttempts: 5, usageLimitAttempts: "unlimited", minBackoff: 30_000, maxBackoff: 1_800_000 },
      },
      web: { listen: "127.0.0.1:4300", steering: { agent: "operator", workspace: root } },
      runners: { codex: { type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true } },
      labels: {
        enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      agents: {
        operator: {
          runner: "codex", effort: "medium", instructions, workspaceAccess: "workspace-write",
          tasks: ["operator.getBoard", "operator.getItemHistory", "operator.retryItem", "operator.moveBacklogItem"],
        },
      },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "backlog" }, { id: "implementation" }] } },
      repositories: { repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
      sources: { github: { type: "github" } }, checks: {}, ci: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    store.upsertIssue({
      id: "item-1", repositoryId: "repo", sourceNumber: 87, sourceUrl: "https://example.test/87", title: "Operator item",
      body: "", sourceState: "open", labels: ["conveyor", "conveyor:backlog"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("item-1", { stage: "backlog", state: "active", warning: null });
    store.setQueueRank("item-1", 10);
    store.setStageState({ issueId: "item-1", stageId: "backlog", status: "ready", feedbackCycle: 0, configHash: config.hash });
    for (const [id, number, stage] of [["item-2", 88, "backlog"], ["item-3", 89, "backlog"], ["child", 90, "backlog"], ["not-backlog", 91, "implementation"], ["offboarded", 92, null]] as const) {
      store.upsertIssue({
        id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: id,
        body: "", sourceState: "open",
        labels: id === "offboarded"
          ? []
          : id === "not-backlog"
            ? ["conveyor", "conveyor:implementation"]
            : ["conveyor", "conveyor:backlog"],
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      });
      store.setIssueProjection(id, { stage, state: id === "offboarded" ? "offboarded" : "active", warning: null });
      if (stage) store.setStageState({ issueId: id, stageId: stage, status: "ready", feedbackCycle: 0, configHash: config.hash });
      if (id === "item-2") store.setQueueRank(id, 20);
      if (id === "item-3") store.setQueueRank(id, 30);
      if (id === "child") store.setQueueRank(id, 40);
    }
    store.replaceRelationships("child", { parentId: "item-1", siblingOrder: 1 }, []);
    store.upsertIssue({
      id: "retry-item", repositoryId: "repo", sourceNumber: 93, sourceUrl: "https://example.test/93", title: "retry-item",
      body: "", sourceState: "open", labels: ["conveyor", "conveyor:backlog", "conveyor:blocked"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("retry-item", { stage: "backlog", state: "blocked", warning: null });
    store.setStageState({ issueId: "retry-item", stageId: "backlog", status: "blocked", feedbackCycle: 0, configHash: config.hash });
    store.setQueueRank("retry-item", 50);
    store.upsertIssue({
      id: "active-retry", repositoryId: "repo", sourceNumber: 94, sourceUrl: "https://example.test/94", title: "active-retry",
      body: "", sourceState: "open", labels: ["conveyor", "conveyor:backlog"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("active-retry", { stage: "backlog", state: "active", warning: null });
    store.setStageState({ issueId: "active-retry", stageId: "backlog", status: "running", feedbackCycle: 0, configHash: config.hash });
    store.activateEnrollment("active-retry");
    store.createRun({ id: "active-retry-run", issueId: "active-retry", stageId: "backlog", attempt: 1, kind: "implementation", status: "running", configHash: config.hash, startedAt: "2026-01-01T00:00:00Z" });
    store.upsertIssue({
      id: "closed-retry", repositoryId: "repo", sourceNumber: 95, sourceUrl: "https://example.test/95", title: "closed-retry",
      body: "", sourceState: "closed", labels: ["conveyor", "conveyor:backlog", "conveyor:blocked"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("closed-retry", { stage: "backlog", state: "blocked", warning: null });
    store.setStageState({ issueId: "closed-retry", stageId: "backlog", status: "blocked", feedbackCycle: 0, configHash: config.hash });
    store.activateEnrollment("closed-retry");
    store.createRun({ id: "item-run", issueId: "item-1", stageId: "backlog", attempt: 1, kind: "implementation", status: "succeeded", configHash: config.hash, startedAt: "2026-01-01T00:00:00Z" });
    store.appendRunEvent("item-run", "progress", { message: "first" });
    store.appendRunEvent("item-run", "progress", { message: "second" });
    store.appendRunEvent("item-run", "progress", { message: "third" });
    store.activateEnrollment("item-1");
    store.activateEnrollment("retry-item");
    store.upsertPullRequest({ issueId: "item-1", id: "pr-1", number: 89, url: "https://example.test/pull/89", state: "open" });

    const sourceIssues = new Map(store.listIssues("repo").map((issue) => [issue.sourceNumber, {
      id: issue.id, number: issue.sourceNumber, url: issue.sourceUrl, title: issue.title, body: issue.body,
      state: issue.sourceState as "open" | "closed", stateReason: issue.sourceStateReason, labels: [...issue.labels], updatedAt: issue.sourceUpdatedAt,
    }]));
    const github = {
      async getIssue(_address: string, number: number) {
        const issue = sourceIssues.get(number);
        if (!issue) throw new Error("not found");
        return issue;
      },
      async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
        const issue = sourceIssues.get(number)!;
        issue.labels = [...labels];
      },
      async listIssues() { return [...sourceIssues.values()]; },
      async listSubIssues(_address: string, number: number) { return number === 87 ? [sourceIssues.get(90)!] : []; },
      async listDependencies() { return []; },
      async getPullRequestDelivery() {
        return {
          pullRequest: {
            number: 89, url: "https://example.test/pull/89", state: "open", merged: false, mergedAt: null,
            mergeCommitSha: null, draft: false, mergeState: "clean", headBranch: "operator", headSha: "abc123", baseBranch: "main",
          },
          checks: [],
        };
      },
    };
    let service!: ConveyorService;
    let steeringRunId = "";
    service = new ConveyorService(config, store, github as never, {
      codeHosts: createGitHubCodeHostRegistry(config, github as never),
      steering: async (input) => {
        expect(input.prompt).toContain("Inspect first, before mutation.");
        expect(input.prompt).toContain("operator.getBoard → tools.mcp__conveyor__operator_getBoard");
        expect(input.prompt).not.toContain("tools.mcp__conveyor__change_merge");
        expect(input.prompt).toContain("authenticated owner’s explicit steering and maintenance request");
        expect(input.prompt).toContain("must not silently bypass or replace the normal issue pipeline");
        const contextIndex = input.mcp!.args.indexOf("--context") + 1;
        steeringRunId = path.basename(path.dirname(input.mcp!.args[contextIndex]!));
        const context = JSON.parse(await readFile(input.mcp!.args[contextIndex]!, "utf8")) as {
          control: { token: string };
          allowedTools: string[];
        };
        expect(context.allowedTools).toEqual(["operator.getBoard", "operator.getItemHistory", "operator.retryItem", "operator.moveBacklogItem"]);
        await expect(service.handleMcp({ tool: "operator.getBoard", input: {} }, "expired-token")).rejects.toThrow("expired MCP grant");
        const limitedLease = await (service as unknown as {
          steeringMcpLease(runId: string, workspace: string, allowedTools: string[]): Promise<{ configuration: { args: string[] }; close(): Promise<void> }>;
        }).steeringMcpLease("limited-operator-run", root, ["operator.getBoard"]);
        const limitedContext = JSON.parse(await readFile(limitedLease.configuration.args.at(-1)!, "utf8")) as { control: { token: string } };
        await expect(service.handleMcp({ tool: "operator.retryItem", input: { itemId: "retry-item", note: "owner asked" } }, limitedContext.control.token)).rejects.toThrow("not granted");
        await limitedLease.close();
        await expect(service.handleMcp({ tool: "operator.getBoard", input: {} }, limitedContext.control.token)).rejects.toThrow("expired MCP grant");
        const board = await service.handleMcp({ tool: "operator.getBoard", input: {} }, context.control.token) as { repositories: Array<{ id: string; address: string; health: string; lastReconciledAt: string | null }>; items: Array<{ id: string; queue: { status: string; rank: number | null } }> };
        expect(board.repositories).toEqual([{ id: "repo", address: "owner/repo", health: "healthy", lastReconciledAt: null }]);
        expect(board.items).toContainEqual(expect.objectContaining({ id: "item-1", queue: { status: "queued", rank: 10 } }));
        expect(JSON.stringify(board)).not.toContain(context.control.token);
        const history = await service.handleMcp({ tool: "operator.getItemHistory", input: { itemId: "item-1", eventLimit: 2 } }, context.control.token) as {
          delivery: { status: string; pullRequest: { number: number }; checks: Array<{ state: string }> };
          runs: Array<{ id: string; events: Array<{ sequence: number }>; nextEventBefore: number | null }>;
        };
        expect(history.delivery).toMatchObject({ status: "available", pullRequest: { number: 89 }, checks: [{ state: "running" }, { state: "failed" }] });
        const eventPage = history.runs[0]!;
        expect(eventPage.events).toHaveLength(2);
        expect(eventPage.nextEventBefore).not.toBeNull();
        const continued = await service.handleMcp({ tool: "operator.getItemHistory", input: {
          itemId: "item-1", eventRunId: eventPage.id, beforeEventSequence: eventPage.nextEventBefore, eventLimit: 2,
        } }, context.control.token) as { runs: Array<{ events: Array<{ sequence: number }> }> };
        expect(continued.runs[0]!.events.map((event) => event.sequence)).not.toEqual(eventPage.events.map((event) => event.sequence));
        await expect(service.handleMcp({ tool: "operator.getItemHistory", input: { itemId: "missing" } }, context.control.token)).rejects.toThrow("item is not on this configured board");
        const retry = await service.handleMcp({ tool: "operator.retryItem", input: { itemId: "retry-item", note: "owner asked" } }, context.control.token);
        expect(await service.handleMcp({ tool: "operator.retryItem", input: { itemId: "retry-item", note: "owner asked" } }, context.control.token)).toEqual(retry);
        const auditsBeforeRetryReject = store.listRunEvents(steeringRunId).filter((event) => event.type === "operator.control").length;
        await expect(service.handleMcp({ tool: "operator.retryItem", input: { itemId: "active-retry", note: "owner asked" } }, context.control.token)).rejects.toThrow("already running");
        await expect(service.handleMcp({ tool: "operator.retryItem", input: { itemId: "closed-retry", note: "owner asked" } }, context.control.token)).rejects.toThrow("closed or offboarded");
        expect(store.getIssue("active-retry")).toMatchObject({ projectedState: "active", projectedStage: "backlog" });
        expect(store.getIssue("closed-retry")).toMatchObject({ projectedState: "blocked", projectedStage: "backlog" });
        expect(store.listRunEvents(steeringRunId).filter((event) => event.type === "operator.control")).toHaveLength(auditsBeforeRetryReject);
        await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-2", position: "up" } }, context.control.token);
        expect((await service.handleMcp({ tool: "operator.getBoard", input: {} }, context.control.token) as { items: Array<{ id: string; queue: { rank?: number } }> }).items
          .filter((item) => ["item-1", "item-2", "item-3"].includes(item.id)).sort((left, right) => left.queue.rank! - right.queue.rank!).map((item) => item.id)).toEqual(["item-2", "item-1", "item-3"]);
        await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-2", position: "down" } }, context.control.token);
        await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-3", position: "before", beforeItemId: "item-1" } }, context.control.token);
        const first = await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-3", position: "end" } }, context.control.token);
        const repeated = await service.handleMcp({ tool: "operator.moveBacklogItem", input: { itemId: "item-3", position: "end" } }, context.control.token);
        expect(repeated).toEqual(first);
        const auditsBeforeReject = store.listRunEvents(steeringRunId).filter((event) => event.type === "operator.control").length;
        const rejectMove = async (input: Record<string, string>) => {
          try {
            await service.handleMcp({ tool: "operator.moveBacklogItem", input }, context.control.token);
          } catch {
            return;
          }
          throw new Error(`unexpectedly moved ${JSON.stringify(input)}`);
        };
        await rejectMove({ itemId: "missing", position: "end" });
        await rejectMove({ itemId: "child", position: "end" });
        await rejectMove({ itemId: "not-backlog", position: "end" });
        await rejectMove({ itemId: "item-1", position: "before", beforeItemId: "offboarded" });
        expect(store.listRunEvents(steeringRunId).filter((event) => event.type === "operator.control")).toHaveLength(auditsBeforeReject);
        return { summary: "Done", sessionId: "thread-operator", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, durationMs: 1, exitCode: 0, stderr: "" };
      },
    });
    Object.assign(service as object, {
      schedule: () => {},
      ciProvider: () => ({ list: async () => [
        { id: "pending", name: "Tests", url: null, state: "running", canRerun: false, hasLog: false },
        { id: "failed", name: "Typecheck", url: null, state: "failed", canRerun: true, hasLog: true },
      ] }),
    });

    const runId = await service.startSteering("Inspect the board, then move #87 to the end.");
    for (let attempt = 0; attempt < 20 && service.getSteeringRun(runId)?.status === "running"; attempt += 1) await Bun.sleep(5);
    expect(store.getRun(runId)?.result).toEqual({ summary: "Done" });
    expect(service.getSteeringRun(runId)).toEqual({ id: runId, status: "succeeded" });
    expect(store.getIssue("retry-item")).toMatchObject({ projectedState: "active", projectedStage: "backlog" });
    expect(store.listRunEvents(runId).filter((event) => event.type === "operator.control")).toHaveLength(5);
    await service.close();
  });
});
