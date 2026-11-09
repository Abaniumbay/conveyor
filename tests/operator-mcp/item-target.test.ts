import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { operatorItemTarget } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-operator-target-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor", retention: { runHistoryMs: null, artifactsMs: null } },
    web: {}, sources: { github: { type: "github" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: {} },
    pipelines: {
      delivery: {
        successStatuses: ["done"], failureStatuses: ["blocked"],
        stages: [
          { id: "build", run: { type: "agent", agent: "worker" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] },
          { id: "deploy", run: { type: "script", runner: "process", script: "./deploy.ts" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] },
        ],
      },
    },
    agents: {},
    repositories: { app: { source: "github", address: "owner/app", folder: root, baseBranch: "main", pipeline: "delivery", concurrency: 1 } },
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const service = new ConveyorService(config, store, {} as never);
  const add = (number: number, stage: string, state: string) => {
    const id = `issue-${number}`;
    store.upsertIssue({ id, repositoryId: "app", sourceNumber: number, sourceUrl: `https://x/${number}`, title: `Item ${number}`, body: "", sourceState: "open", sourceStateReason: null, labels: [], sourceUpdatedAt: "2026-10-01T00:00:00Z" });
    store.setIssueProjection(id, { stage, state, warning: null });
    return id;
  };
  const startRun = (issueId: string, stageId: string) =>
    store.createRun({ id: `run-${issueId}-${stageId}`, issueId, stageId, attempt: 1, kind: "producer", status: "running", configHash: "h", startedAt: new Date().toISOString() });
  return { service, store, add, startRun };
}

describe("operatorItemTarget", () => {
  test("resolves repository references and rejects unknown and offboarded ones", async () => {
    const { service, store, add } = await setup();
    const id = add(1, "build", "blocked");
    const gone = add(2, "build", "unlisted");
    expect(operatorItemTarget(service, "app:1")).toEqual({ issueId: id, running: false });
    expect(operatorItemTarget(service, "app#1")?.issueId).toBe(id);
    expect(operatorItemTarget(service, "app:99")).toBeNull();
    expect(operatorItemTarget(service, "nope:1")).toBeNull();
    expect(operatorItemTarget(service, `app:${gone.split("-")[1]}`)).toBeNull();
    store.close();
  });

  test("an agent stage with a live run is running; a script stage is not", async () => {
    const { service, store, add, startRun } = await setup();
    const agent = add(1, "build", "active");
    const script = add(2, "deploy", "active");
    const idle = add(3, "build", "active");
    startRun(agent, "build");
    startRun(script, "deploy");
    expect(operatorItemTarget(service, "app:1")).toEqual({ issueId: agent, running: true });
    expect(operatorItemTarget(service, "app:2")).toEqual({ issueId: script, running: false });
    expect(operatorItemTarget(service, "app:3")).toEqual({ issueId: idle, running: false });
    store.close();
  });
});
