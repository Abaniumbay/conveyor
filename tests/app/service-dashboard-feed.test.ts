import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DashboardFeedMessage } from "../../src/app/dashboard-feed";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import type { DashboardPatch } from "../../src/web/model";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-feed-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const folder = path.join(root, "repo");
  await mkdir(folder);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
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
        concurrency: 1
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed }
      - id: review
        concurrency: 1
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed }
repositories:
  repo: { source: github, address: owner/repo, folder: ${folder}, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder, configHash: config.hash });
  const source = { labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-01-01T00:00:00Z" };
  const github = {
    async listIssues() {
      return [{ id: "github:owner/repo#1", number: 1, url: "u", title: "Feature", body: "", state: "open", labels: source.labels, updatedAt: source.updatedAt }];
    },
    async repositoryVisibility() { return "private" as const; },
    async getIssueProvenance() {
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async getIssueFieldValues() { return {}; },
    async upsertStatusComment() { return 1; },
    async replaceConveyorLabels() {},
  };
  const service = new ConveyorService(config, store, github as never);
  const web = service.webDependencies({} as never, "operator");
  return { store, service, source, web };
}

function listen(web: Awaited<ReturnType<typeof setup>>["web"]) {
  const messages: DashboardFeedMessage[] = [];
  const subscription = web.subscribeDashboardFeed!((message) => messages.push(message), null);
  return {
    subscription,
    patches: (): DashboardPatch[] => messages.flatMap((message) => message.kind === "patch" ? [message.patch] : []),
  };
}

test("an item moving to the next stage sends one patch for that item, with only what changed", async () => {
  const { store, service, source, web } = await setup();
  try {
    await service.reconcileAll();
    const before = web.getDashboardSnapshot!();
    expect(before.model.items["github:owner/repo#1"]).toMatchObject({ placement: "stage", stage: "implementation" });
    const dashboard = listen(web);

    source.labels = ["conveyor", "conveyor:review"];
    source.updatedAt = "2026-01-02T00:00:00Z";
    await service.reconcileAll();
    web.getDashboardSnapshot!();

    const itemPatches = dashboard.patches().filter((patch) => patch.entity === "item");
    expect(itemPatches).toHaveLength(1);
    expect(itemPatches[0]).toMatchObject({ id: "github:owner/repo#1", op: "upsert", data: expect.objectContaining({ stage: "review" }) });
    expect(itemPatches[0]?.data).not.toHaveProperty("title");
    dashboard.subscription.unsubscribe();
  } finally {
    await service.close();
    store.close();
  }
});

test("a reconcile that changes nothing sends no item patch", async () => {
  const { store, service, web } = await setup();
  try {
    await service.reconcileAll();
    web.getDashboardSnapshot!();
    const dashboard = listen(web);

    await service.reconcileAll();
    web.getDashboardSnapshot!();

    expect(dashboard.patches().filter((patch) => patch.entity === "item")).toEqual([]);
    dashboard.subscription.unsubscribe();
  } finally {
    await service.close();
    store.close();
  }
});

test("an item that leaves Conveyor is removed from open dashboards", async () => {
  const { store, service, source, web } = await setup();
  try {
    await service.reconcileAll();
    web.getDashboardSnapshot!();
    const dashboard = listen(web);

    source.labels = [];
    source.updatedAt = "2026-01-02T00:00:00Z";
    await service.reconcileAll();
    web.getDashboardSnapshot!();

    expect(dashboard.patches()).toContainEqual({ seq: expect.any(Number), entity: "item", id: "github:owner/repo#1", op: "remove" });
    dashboard.subscription.unsubscribe();
  } finally {
    await service.close();
    store.close();
  }
});
