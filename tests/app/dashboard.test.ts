import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { RuntimeIssueContext, ScopedMcpFactory } from "../../src/app/runtime";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("ConveyorService dashboard", () => {
  test("a user conversation message clears a recoverable stop and queues the current stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-resume-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1 },
      web: { listen: "127.0.0.1:4300" },
      sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: {
          done: "conveyor:done",
          blocked: "conveyor:blocked",
          rejected: "conveyor:reject",
          "needs-input": "conveyor:needs-input",
        },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          successStatuses: ["done"],
          failureStatuses: ["blocked"],
          stages: [{
            id: "implementation",
            run: { type: "agent", agent: "kaveh" },
            concurrency: 1,
            failurePolicies: {},
            afterSuccess: [],
          }],
        },
      },
      repositories: {
        repo: {
          source: "github",
          address: "owner/repo",
          folder: root,
          baseBranch: "main",
          pipeline: "default",
          concurrency: 1,
          systemLabels: [],
        },
      },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    const sourceIssues = [
      {
        id: "issue",
        number: 1,
        url: "https://github.com/owner/repo/issues/1",
        title: "Feature",
        body: "",
        state: "open",
        stateReason: null,
        labels: ["conveyor", "conveyor:implementation", "conveyor:blocked", "conveyor:order:3"],
        updatedAt: "2026-09-29T00:00:00Z",
      },
      {
        id: "blocker",
        number: 2,
        url: "https://github.com/owner/repo/issues/2",
        title: "Dependency",
        body: "",
        state: "open",
        stateReason: null,
        labels: [],
        updatedAt: "2026-09-29T00:00:00Z",
      },
    ];
    for (const sourceIssue of sourceIssues) {
      store.upsertIssue({
        id: sourceIssue.id,
        repositoryId: "repo",
        sourceNumber: sourceIssue.number,
        sourceUrl: sourceIssue.url,
        title: sourceIssue.title,
        body: sourceIssue.body,
        sourceState: sourceIssue.state,
        sourceStateReason: sourceIssue.stateReason,
        labels: sourceIssue.labels,
        sourceUpdatedAt: sourceIssue.updatedAt,
      });
    }
    store.setQueueRank("issue", 10);
    store.setIssueProjection("issue", { stage: "implementation", state: "blocked", warning: null });
    store.setStageState({ issueId: "issue", stageId: "implementation", status: "blocked", feedbackCycle: 2, configHash: config.hash });
    store.setIssueProjection("blocker", { stage: null, state: "offboarded", warning: null });
    store.replaceRelationships("issue", null, ["blocker"]);
    const replaced: string[][] = [];
    const github = {
      async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) {
        replaced.push([...labels]);
        sourceIssues[0]!.labels = [...labels];
      },
      async listIssues() { return sourceIssues; },
      async listSubIssues() { return []; },
      async listDependencies(_address: string, number: number) {
        return number === 1 ? [sourceIssues[1]!] : [];
      },
      async upsertStatusComment() { return 1; },
    };
    const service = new ConveyorService(config, store, github as never);

    await expect(service.postIssueMessage("issue", "The API access blocker is resolved; please continue.", "operator")).resolves.toMatchObject({
      status: "queued",
      stageId: "implementation",
    });

    expect(replaced).toEqual([["conveyor", "conveyor:implementation", "conveyor:order:3"]]);
    expect(store.getIssue("issue")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
    expect(store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready", feedbackCycle: 0 });
    expect(store.listConversationMessages("issue").map((message) => ({ actor: message.actorName, message: message.message }))).toEqual([
      { actor: "operator", message: "The API access blocker is resolved; please continue." },
      { actor: "Conveyor", message: expect.stringContaining("Queued implementation") },
    ]);
    expect(service.dashboard("csrf").activeWork.runnerCount).toBe(0);
    store.close();
  });

  test("a conversation message answers an open structured question before resuming", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-answer-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1 },
      web: { listen: "127.0.0.1:4300" },
      sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", "needs-input": "conveyor:needs-input" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          successStatuses: ["done"],
          failureStatuses: ["needs-input"],
          stages: [{ id: "refinement", run: { type: "agent", agent: "darya" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }],
        },
      },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
      },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    const sourceIssue = {
      id: "issue",
      number: 1,
      url: "https://github.com/owner/repo/issues/1",
      title: "Feature",
      body: "",
      state: "open",
      stateReason: null,
      labels: ["conveyor", "conveyor:refinement", "conveyor:needs-input"],
      updatedAt: "2026-09-29T00:00:00Z",
    };
    store.upsertIssue({ id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: sourceIssue.url, title: sourceIssue.title, body: "", sourceState: "open", labels: sourceIssue.labels, sourceUpdatedAt: sourceIssue.updatedAt });
    store.setIssueProjection("issue", { stage: "refinement", state: "needs-input", warning: null });
    store.setStageState({ issueId: "issue", stageId: "refinement", status: "needs-input", feedbackCycle: 0, configHash: config.hash });
    const question = store.openQuestion({ issueId: "issue", runId: null, prompt: "Which layout?", reason: "A choice is required", options: [], allowFreeText: true });
    const comments: string[] = [];
    const github = {
      async addComment(_address: string, _number: number, markdown: string) { comments.push(markdown); return 1; },
      async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) { sourceIssue.labels = [...labels]; },
      async listIssues() { return [sourceIssue]; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
      async upsertStatusComment() { return 1; },
    };
    const service = new ConveyorService(config, store, github as never);

    await service.postIssueMessage("issue", "Use the compact layout.", "operator");

    expect(store.getQuestion(question.id)).toMatchObject({ status: "answered", answer: { answer: "Use the compact layout." } });
    expect(comments[0]).toContain("Use the compact layout.");
    expect(store.listConversationMessages("issue")[0]).toMatchObject({ actorType: "user", message: "Use the compact layout." });
    await service.close();
  });

  test("turns explicit MCP progress into shared conversation and exposes live handoff context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-conversation-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces") },
      web: { listen: "127.0.0.1:4300" },
      repositories: {},
      pipelines: {},
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "issue",
      repositoryId: "repo",
      sourceNumber: 1,
      sourceUrl: "https://github.com/owner/repo/issues/1",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.createRun({
      id: "run-1",
      issueId: "issue",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: config.hash,
      startedAt: "2026-09-29T00:00:00Z",
    });
    const issue = store.getIssue("issue")!;
    const context: RuntimeIssueContext = {
      issue,
      repository: { id: "repo", address: "owner/repo", folder: root, baseBranch: "main" },
      workspace: { path: root, branch: "conveyor/1" },
      sourceGuidance: "Never close issues.",
    };
    const service = new ConveyorService(config, store, {} as never);
    const factory = (service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-1",
      stageId: "implementation",
      context,
      allowedTools: ["conversation.get", "run.report_progress"],
      actor: { id: "kaveh", name: "Kaveh", title: "Senior Developer" },
    });
    const control = JSON.parse(await readFile(path.join(root, "artifacts/run-1/mcp-context.json"), "utf8")) as {
      control: { token: string };
    };
    service.postIssueMessage("issue", "Keep this backward compatible.", "operator");
    await service.handleMcp({
      tool: "run.report_progress",
      input: { message: "Compatibility is preserved; focused tests pass." },
    }, control.control.token);
    expect(await service.handleMcp({ tool: "conversation.get", input: {} }, control.control.token)).toMatchObject({
      messages: [
        { actorType: "user", message: "Keep this backward compatible." },
        { actorName: "Kaveh", actorTitle: "Senior Developer", message: "Compatibility is preserved; focused tests pass." },
      ],
    });
    expect(store.listRunEvents("run-1")).toMatchObject([
      { type: "report_progress", payload: { message: "Compatibility is preserved; focused tests pass." } },
    ]);
    await lease.close();
    store.close();
  });

  test("persists blocked children so tracking parents remain roll-up only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-relationships-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 3 },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: { default: { stages: [{ id: "implementation" }] } },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
      },
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    for (const issue of [
      { id: "parent", number: 1, state: "active", labels: ["conveyor", "conveyor:implementation"] },
      { id: "child", number: 2, state: "blocked", labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"] },
    ]) {
      store.upsertIssue({
        id: issue.id,
        repositoryId: "repo",
        sourceNumber: issue.number,
        sourceUrl: `https://github.com/owner/repo/issues/${issue.number}`,
        title: issue.id,
        body: "",
        sourceState: "open",
        labels: issue.labels,
        sourceUpdatedAt: "2026-09-29T00:00:00Z",
      });
      store.setIssueProjection(issue.id, {
        stage: "implementation",
        state: issue.state,
        warning: null,
      });
    }
    const source = {
      async listSubIssues(_address: string, number: number) {
        return number === 1
          ? [{
              id: "child",
              number: 2,
              url: "https://github.com/owner/repo/issues/2",
              title: "child",
              body: "",
              state: "open",
              stateReason: null,
              labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"],
              updatedAt: "2026-09-29T00:00:00Z",
            }]
          : [];
      },
      async listDependencies() { return []; },
      async replaceConveyorLabels() { throw new Error("parent is not complete"); },
    };
    const service = new ConveyorService(config, store, source as never);

    await (service as unknown as {
      reconcileRelationships(repositoryId: string, address: string): Promise<void>;
    }).reconcileRelationships("repo", "owner/repo");

    expect(store.listChildren("parent")).toEqual([{ issueId: "child", siblingOrder: 1 }]);
    expect(store.getIssue("child")?.parentId).toBe("parent");
    store.close();
  });

  test("places untouched, staged, closed, and invalid issues in distinct lanes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 3 },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          stages: [
            { id: "refinement", run: { type: "agent", agent: "darya" } },
            { id: "implementation", run: { type: "agent", agent: "kaveh" } },
          ],
        },
      },
      agents: {
        darya: { name: "Darya", title: "Product Owner" },
        kaveh: { name: "Kaveh", title: "Senior Developer" },
      },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
      },
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    for (let number = 1; number <= 25; number += 1) {
      const id = `github:owner/repo#${number}`;
      store.upsertIssue({
        id,
        repositoryId: "repo",
        sourceNumber: number,
        sourceUrl: `https://github.com/owner/repo/issues/${number}`,
        title: `Done issue ${number}`,
        body: "",
        sourceState: "closed",
        sourceStateReason: "completed",
        labels: ["conveyor", "conveyor:done"],
        sourceUpdatedAt: "2026-09-29T00:00:00Z",
      });
      store.setIssueProjection(id, {
        stage: null,
        state: "done",
        warning: number === 1
          ? "issue was closed before a correlated Conveyor PR merge"
          : null,
      });
    }
    store.replaceRelationships(
      "github:owner/repo#25",
      { parentId: "github:owner/repo#1", siblingOrder: 1 },
      [],
    );
    store.upsertIssue({
      id: "github:owner/repo#26",
      repositoryId: "repo",
      sourceNumber: 26,
      sourceUrl: "https://github.com/owner/repo/issues/26",
      title: "Untouched backlog issue",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#26", {
      stage: "refinement",
      state: "active",
      warning: null,
    });
    store.setStageState({
      issueId: "github:owner/repo#26",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "github:owner/repo#27",
      repositoryId: "repo",
      sourceNumber: 27,
      sourceUrl: "https://github.com/owner/repo/issues/27",
      title: "Implementation issue",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#27", {
      stage: "implementation",
      state: "active",
      warning: null,
    });
    store.replaceRelationships(
      "github:owner/repo#27",
      null,
      ["github:owner/repo#1"],
    );
    store.createRun({
      id: "active-run",
      issueId: "github:owner/repo#27",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: config.hash,
      startedAt: "2026-09-29T00:01:00Z",
    });
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      store.appendRunEvent("active-run", "progress", { message: `Step ${sequence}` });
    }
    store.createRun({
      id: "older-run",
      issueId: "github:owner/repo#27",
      stageId: "implementation",
      attempt: 0,
      kind: "producer",
      status: "succeeded",
      configHash: config.hash,
      startedAt: "2026-09-29T00:00:30Z",
    });
    store.upsertIssue({
      id: "github:owner/repo#28",
      repositoryId: "repo",
      sourceNumber: 28,
      sourceUrl: "https://github.com/owner/repo/issues/28",
      title: "Open done issue without a stage",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:done"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#28", {
      stage: null,
      state: "done",
      warning: null,
    });

    const service = new ConveyorService(config, store, {} as never);
    const dashboard = service.dashboard("csrf", {
      view: "board",
      column: null,
      page: 1,
      doneLimit: 20,
      runId: null,
      issueId: "github:owner/repo#27",
    });
    const implementation = dashboard.stages.find((column) => column.id === "stage:implementation");

    expect(dashboard.stages.map((column) => column.name)).toEqual(["Refinement", "Implementation"]);
    expect(implementation).toMatchObject({
      actors: [{ type: "agent", name: "Kaveh", title: "Senior Developer" }],
      totalIssues: 1,
      page: 1,
      totalPages: 1,
      issues: [{ dependencies: [{ number: 1, satisfied: true }], working: true }],
    });
    expect(dashboard.activeWork).toMatchObject({
      runnerCount: 1,
      runnerCapacity: 3,
      runs: [{ id: "active-run", issueNumber: 27, stageId: "implementation", kind: "producer" }],
    });
    expect(dashboard.selectedIssue).toMatchObject({
      id: "github:owner/repo#27",
      repository: "repo",
    });
    expect(service.issueActivity("github:owner/repo#27")).toMatchObject({
      issueId: "github:owner/repo#27",
      runs: [{ id: "active-run" }],
      nextRunBefore: "active-run",
    });
    expect(service.issueActivity("github:owner/repo#27")?.runs).toHaveLength(1);
    expect(service.issueActivity("github:owner/repo#27")?.runs[0]?.events).toHaveLength(5);
    expect(service.issueActivity("github:owner/repo#27")?.runs[0]?.events[0]).toMatchObject({
      type: "progress",
      payload: { message: "Step 7" },
    });
    expect(dashboard.backlog.map((issue) => issue.number)).toEqual([26]);
    expect(dashboard.done).toMatchObject({ totalIssues: 25 });
    expect(dashboard.done.issues).toHaveLength(20);
    expect(dashboard.done.issues[0]).toMatchObject({
      state: "completed",
      tone: "success",
      inconsistent: false,
    });
    expect(dashboard.attention).toMatchObject({ totalIssues: 1 });
    expect(dashboard.attention.issues[0]).toMatchObject({
      number: 28,
      reason: "No valid configured stage label is present.",
    });
    expect(dashboard.counts).toEqual({ board: 27, attention: 1 });

    const expanded = service.dashboard("csrf", {
      view: "board",
      column: null,
      page: 1,
      doneLimit: 40,
      runId: null,
      issueId: null,
    });
    expect(expanded.done.issues).toHaveLength(25);
    store.close();
  });
});
