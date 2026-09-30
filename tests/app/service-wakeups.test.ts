import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const MESSAGE = "Waiting for CI at abc1234: Tests.";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-wakeups-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const open = async () => {
    const store = await ConveyorStore.open(config.settings.database);
    const executed: string[] = [];
    const service = new ConveyorService(config, store, {} as GitHubAdapter);
    (service as unknown as { execute(issue: StoredIssue): Promise<void> }).execute = async (issue) => {
      executed.push(issue.id);
    };
    return { store, service, executed };
  };
  const first = await open();
  first.store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash,
  });
  first.store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  first.store.setQueueRank("issue", first.store.nextQueueRank());
  first.store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  return { config, first, open };
}

/** What StageExecutor leaves behind when a task returns pending. */
function park(store: ConveyorStore, config: ConveyorConfig, wakeAt: string) {
  const journal = store.executions();
  const epoch = journal.stageEpoch("issue");
  const { record } = journal.planExecution({
    itemId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, list: "actions", taskInstanceId: "legacy.produce",
  });
  journal.markPending(record.id, { wakeAt, deadlineAt: null, message: MESSAGE }, epoch);
  journal.saveCursor({
    issueId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, returns: 0, list: "actions",
    taskInstanceId: "legacy.produce", state: "pending", feedback: null, pendingSince: wakeAt, wakeAt, deadlineAt: null,
  }, epoch);
  void config;
}

const schedule = (service: ConveyorService) => (service as unknown as { schedule(): void }).schedule();

describe("persisted wake-ups", () => {
  test("a parked item keeps its wake-up across a restart and is scheduled when due", async () => {
    const { config, first, open } = await setup();
    const wakeAt = new Date(Date.now() + 400).toISOString();
    park(first.store, config, wakeAt);
    schedule(first.service);
    expect(first.executed).toEqual([]);
    await first.service.close();

    const second = await open();
    expect(second.store.executions().wakeAt("issue")).toBe(wakeAt);
    schedule(second.service);
    expect(second.executed).toEqual([]);

    // The armed timer fires a schedule pass at the wake-up time.
    await Bun.sleep(700);
    expect(second.executed).toEqual(["issue"]);
    await second.service.close();
  });

  test("an item whose wake-up has passed is schedulable immediately", async () => {
    const { config, first } = await setup();
    park(first.store, config, new Date(Date.now() - 1_000).toISOString());
    schedule(first.service);
    expect(first.executed).toEqual(["issue"]);
    await first.service.close();
  });

  test("reconciliation resetting the warning does not lose a parked item's status line", async () => {
    const { config, first } = await setup();
    park(first.store, config, new Date(Date.now() + 60_000).toISOString());
    first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
    (first.service as unknown as { restorePendingStatus(id: string): void }).restorePendingStatus("repo");
    expect(first.store.getIssue("issue")?.warning).toBe(MESSAGE);
    await first.service.close();
  });
});
