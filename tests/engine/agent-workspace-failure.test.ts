import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExecutionStore } from "../../src/engine/journal";
import { StageExecutor } from "../../src/engine/stage-executor";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { Harness } from "../../src/harness/types";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { TaskContext } from "../../src/tasks/context";
import { InfrastructureError } from "../../src/tasks/contract";
import type { CompiledPipeline } from "../../src/tasks/plan";
import { WorkspaceError } from "../../src/workspace/manager";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("agent.run under the stage executor", () => {
  test("a WorkspaceError preparing the workspace reaches the caller as an infrastructure error and starts no agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-agent-ws-"));
    directories.push(root);
    const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
    store.recordConfigSnapshot("hash", {});
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "hash" });
    store.upsertIssue({
      id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix it", body: "Body",
      sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.activateEnrollment("i1");
    const instructions = path.join(root, "a.md");
    await writeFile(instructions, "Agent.");
    await mkdir(path.join(root, "artifacts"));
    const config = {
      hash: "hash",
      settings: { artifacts: path.join(root, "artifacts"), interruptGraceMs: 100, agentRunTokenWarning: 15_000_000 },
      agents: {
        first: { runner: "codex", instructions, tasks: [], name: "First", title: "T", workspaceAccess: "write" },
        second: { runner: "codex", instructions, tasks: [], name: "Second", title: "T", workspaceAccess: "write" },
      },
      runners: { codex: { type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true } },
    } as unknown as ConveyorConfig;
    let harnessRuns = 0;
    const harness: Harness = { id: "fake", capabilities: { sessionResume: false }, async run() { harnessRuns++; throw new Error("must not run"); } };
    const deps = {
      store, config, items: {} as never, git: {} as never,
      workspaces: { create: async () => { throw new WorkspaceError("cannot fetch origin/main: incorrect old value provided"); } },
      repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
      issueId: "i1", sourceGuidance: "G", harnesses: { codex: harness },
      mcp: { create: async () => ({ configuration: { command: "bun", args: [] }, close() {} }) },
    };
    const registry = createTaskRegistry();
    const def = registry.require("agent.run");
    const plan: CompiledPipeline = {
      id: "p", repositoryId: "repo",
      stages: [{
        id: "implementation", concurrency: 1, retries: 2, childrenStartAt: null, legacy: false, skipped: false, exitGate: [],
        actions: [{
          id: "implement", task: "agent.run", kind: def.kind, with: { agents: ["first", "second"] },
          wait: { timeoutMs: null, pollMs: 60_000 }, onFail: null,
          reads: [...def.reads], writes: [...def.writes], invalidates: [...def.invalidates], implicitLoads: [],
        }],
      }],
    };
    const clock = () => new Date("2026-01-01T00:00:00Z");
    const journal = new ExecutionStore(store.sqlite(), { now: clock });
    const executor = new StageExecutor({
      registry, journal, clock, notify: () => {}, setStatus: () => {}, settings: { maxReturns: 5 },
    });
    journal.bumpStageEpoch("i1");
    const baseContext = {
      schemaVersion: 1, configHash: "hash",
      run: { stage: "", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "", enteredAt: "2026-01-01T00:00:00.000Z", feedback: null },
      repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main", ciMode: "required", systemLabels: [] },
      item: { id: "i1", number: 7, title: "Fix it", body: "Body", url: "u", labels: [], state: "open", criteria: [], children: [], dependencies: [], systemLabels: [] },
      checkpoints: { ciPassed: null, reviewPassed: null },
    } as unknown as TaskContext;

    const thrown = await executor.execute({ issueId: "i1", pipeline: plan, stageId: "implementation", baseContext, deps }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(InfrastructureError);
    expect((thrown as Error).message).toContain("incorrect old value provided");
    expect(harnessRuns).toBe(0);
    expect(store.listConversationMessages("i1", 100).filter((m) => m.actorName === "Conveyor")).toEqual([]);
  });
});
