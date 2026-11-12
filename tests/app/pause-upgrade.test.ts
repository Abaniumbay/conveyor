import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import { UNDO_EVENT_CLASSES } from "../support/schema-rollback";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function config(root: string): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "conveyor.sqlite"), logs: path.join(root, "logs"), artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"), runners: 1, reconcileInterval: "1m",
    },
    sources: { github: { type: "github" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" } },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", concurrency: 1, actions: [], "exit-gate": [{ id: "acknowledge", task: "item.followUps", manual: true }] }] } },
    repositories: { app: { source: "github", address: "owner/my-app", folder: root, pipeline: "default" } },
    agents: {},
  });
  return { ...parsed, hash: "upgrade-test", root, plans: [] };
}

test("a database upgraded from the paused_by_conveyor marker drops the column and relabels old-style paused items once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-pause-upgrade-"));
  directories.push(root);
  const settings = config(root);
  const database = settings.settings.database;

  // A database as the previous release left it: the marker column exists and migration 46 has not run.
  let store = await ConveyorStore.open(database);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/my-app", folder: root, configHash: settings.hash });
  const issues = [
    { id: "staged", number: 1, labels: ["conveyor:implementation"], marker: 0 },
    { id: "marked", number: 2, labels: [] as string[], marker: 1 },
    { id: "running", number: 3, labels: ["conveyor", "conveyor:implementation"], marker: 0 },
  ];
  for (const issue of issues) {
    store.upsertIssue({
      id: issue.id, repositoryId: "app", sourceNumber: issue.number, sourceUrl: `https://example.com/issues/${issue.number}`,
      title: issue.id, body: "", sourceState: "open", labels: issue.labels, sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
  }
  store.setIssueProjection("staged", { stage: "implementation", state: "paused", warning: null });
  store.setIssueProjection("marked", { stage: null, state: "paused", warning: null });
  store.setIssueProjection("running", { stage: "implementation", state: "active", warning: null });
  store.sqlite().exec(UNDO_EVENT_CLASSES + " DROP TABLE pending_purges; DROP TABLE purged_generations; DROP TABLE pending_pause_relabels; ALTER TABLE issues ADD COLUMN paused_by_conveyor INTEGER NOT NULL DEFAULT 0; DROP TABLE item_stop_summaries; DELETE FROM schema_migrations WHERE version >= 46;");
  store.sqlite().query("UPDATE issues SET paused_by_conveyor = 1 WHERE id = 'marked'").run();
  store.close();

  store = await ConveyorStore.open(database);
  const columns = (store.sqlite().query("PRAGMA table_info(issues)").all() as Array<{ name: string }>).map((column) => column.name);
  expect(columns).not.toContain("paused_by_conveyor");
  expect(store.listPendingPauseRelabels().map((issue) => issue.id)).toEqual(["marked", "staged"]);

  const live = new Map<number, string[]>([[1, ["conveyor:implementation"]], [2, []], [3, ["conveyor", "conveyor:implementation"]]]);
  const writes: Array<{ issue: number; labels: string[] }> = [];
  const sourceIssue = (number: number) => ({
    id: `source-${number}`, number, url: `https://example.com/issues/${number}`, title: `issue ${number}`, body: "",
    state: "open" as const, labels: live.get(number) ?? [], updatedAt: "2026-01-02T00:00:00Z",
  });
  const github = {
    async repositoryVisibility() { return "private" as const; },
    async collaboratorPermission() { return "admin" as const; },
    async ensureLabels() {},
    async listIssues() { return [1, 2, 3].map(sourceIssue); },
    async getIssue(_address: string, number: number) { return sourceIssue(number); },
    async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }; },
    async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
      writes.push({ issue: number, labels: [...labels] });
      live.set(number, [...labels]);
    },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
  };
  const service = new ConveyorService(settings, store, github as never);
  service.drain("tests");

  await service.syncRepository("app");
  await service.syncRepository("app");

  expect(writes).toEqual([
    { issue: 1, labels: ["conveyor", "conveyor:implementation", "conveyor:paused"] },
    { issue: 2, labels: ["conveyor", "conveyor:paused"] },
  ]);
  expect(store.listPendingPauseRelabels()).toEqual([]);
  expect(store.getIssue("staged")).toMatchObject({ projectedStage: "implementation", projectedState: "paused" });
  expect(store.getIssue("marked")).toMatchObject({ projectedState: "paused" });
  expect(store.getIssue("running")).toMatchObject({ projectedState: "active" });
  await service.close();
});

test("label setup creates conveyor:paused together with the other system labels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-pause-labels-"));
  directories.push(root);
  const settings = config(root);
  const store = await ConveyorStore.open(settings.settings.database);
  const created: string[] = [];
  const github = {
    async repositoryVisibility() { return "private" as const; },
    async collaboratorPermission() { return "admin" as const; },
    async ensureLabels(_address: string, labels: Array<{ name: string }>) { created.push(...labels.map((label) => label.name)); },
    async listIssues() { return []; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
  };
  const service = new ConveyorService(settings, store, github as never);
  service.drain("tests");

  await service.onboardRepositories();

  expect(created).toEqual(expect.arrayContaining(["conveyor", "conveyor:implementation", "conveyor:no-split", "conveyor:closable", "conveyor:paused"]));
  await service.close();
});
