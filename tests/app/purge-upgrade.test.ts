import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import { createWorkspace } from "../../src/workspace/lifecycle";
import { WorkspaceManager } from "../../src/workspace/manager";
import { git } from "../support/delivery-world";
import { UNDO_EVENT_CLASSES } from "../support/schema-rollback";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function config(root: string): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "data", "conveyor.sqlite"), logs: path.join(root, "logs"), artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"), runners: 1, reconcileInterval: "1m",
    },
    sources: { github: { type: "github" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" } },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", concurrency: 1, actions: [], "exit-gate": [{ id: "acknowledge", task: "item.followUps", manual: true }] }] } },
    repositories: { app: { source: "github", address: "owner/my-app", folder: path.join(root, "repo"), pipeline: "default" } },
    agents: {},
  });
  return { ...parsed, hash: "upgrade-test", root, plans: [] };
}

test("migration 47 queues the rows of the removed missing and offboarded states; the service removes their workspaces, then deletes them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-purge-upgrade-"));
  directories.push(root);
  const settings = config(root);
  const folder = settings.repositories.app!.folder;
  await Bun.$`mkdir -p ${folder}`.quiet();
  await git(folder, "init", "-b", "main");
  await writeFile(path.join(folder, "README.md"), "# repo\n");
  await git(folder, "add", "README.md");
  await git(folder, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");

  // A database as the previous release left it: rows in the removed states, each with a real worktree.
  let store = await ConveyorStore.open(settings.settings.database);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/my-app", folder, configHash: settings.hash });
  const rows = [
    { id: "gone", number: 1, state: "offboarded", labels: [] as string[] },
    { id: "vanished", number: 2, state: "missing", labels: ["conveyor", "conveyor:implementation"] },
    { id: "kept", number: 3, state: "active", labels: ["conveyor", "conveyor:implementation"] },
  ];
  const manager = new WorkspaceManager(settings.settings.workspaces);
  const worktrees = new Map<string, { path: string; branch: string }>();
  for (const row of rows) {
    store.upsertIssue({
      id: row.id, repositoryId: "app", sourceNumber: row.number, sourceUrl: `https://example.com/issues/${row.number}`,
      title: row.id, body: "", sourceState: "open", labels: row.labels, sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    const workspace = await createWorkspace({
      store, manager, issue: store.getIssue(row.id)!, repository: { id: "app", folder, baseBranch: "main" },
    });
    worktrees.set(row.id, { path: workspace.path, branch: workspace.branch });
    store.setIssueProjection(row.id, { stage: row.state === "active" ? "implementation" : null, state: row.state, warning: null });
  }
  // Offboarding had ended the enrollment of the first and marked its workspace stale.
  store.endActiveEnrollment("gone", "offboarded");
  store.sqlite().exec(UNDO_EVENT_CLASSES + " DROP TABLE pending_purges; DROP TABLE purged_generations; DROP TABLE item_stop_summaries; DELETE FROM schema_migrations WHERE version >= 47;");
  store.close();
  for (const { path: workspacePath } of worktrees.values()) expect(existsSync(workspacePath)).toBe(true);

  store = await ConveyorStore.open(settings.settings.database);
  expect(store.listPendingPurges().map((pending) => pending.issueId)).toEqual(["gone", "vanished"]);
  const states = (store.sqlite().query("SELECT DISTINCT projected_state AS state FROM issues").all() as Array<{ state: string }>).map((row) => row.state);
  expect(states).not.toContain("missing");
  expect(states).not.toContain("offboarded");

  const github = {
    async repositoryVisibility() { return "private" as const; },
    async collaboratorPermission() { return "admin" as const; },
    async ensureLabels() {},
    async listIssues() { return []; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
  };
  const service = new ConveyorService(settings, store, github as never);
  service.drain("tests");
  await service.reconcileAll();
  await service.purgesSettled();

  expect(existsSync(worktrees.get("gone")!.path)).toBe(false);
  expect(existsSync(worktrees.get("vanished")!.path)).toBe(false);
  expect(await git(folder, "branch", "--list", worktrees.get("gone")!.branch)).toBe("");
  expect(await git(folder, "branch", "--list", worktrees.get("vanished")!.branch)).toBe("");
  expect(store.getIssue("gone")).toBeNull();
  expect(store.getIssue("vanished")).toBeNull();
  expect(store.listPendingPurges()).toEqual([]);
  // An item in no removed state is left alone.
  expect(store.getIssue("kept")).not.toBeNull();
  expect(existsSync(worktrees.get("kept")!.path)).toBe(true);
  await service.close();
});
