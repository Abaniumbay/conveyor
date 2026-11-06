import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { runCli } from "../../src/cli/main";
import { loadConfig } from "../../src/config/load";
import { createControlHandler, serveControlSocket } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";
import { renderDashboard } from "../support/render-dashboard";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n<!-- conveyor:acceptance-criteria:end -->\n";
const LINE = /GitHub unavailable since \S+, (\d+) items? waiting/g;

async function setup(count: number) {
  const root = await shortTemporaryDirectory("conveyor-outage-status-", { socketPath: "home/run/control.sock" });
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await mkdir(path.join(root, "home/run"), { recursive: true });
  await writeFile(path.join(root, "worker.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
  retries: { infrastructureAttempts: 1, usageLimitAttempts: unlimited, minBackoff: 20ms, maxBackoff: 40ms }
github: { outageWaitLimit: 1h }
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./worker.md } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", needs-intervention: "conveyor:needs-intervention" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    stages:
      - id: implementation
        concurrency: ${count}
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"), createTaskRegistry());
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  const fake = { down: true, probes: 0 };
  const toIssue = (id: string) => {
    const issue = store.getIssue(id)!;
    return {
      id: issue.id, number: issue.sourceNumber, url: issue.sourceUrl, title: issue.title, body: issue.body,
      state: issue.sourceState, stateReason: issue.sourceStateReason, labels: issue.labels, updatedAt: issue.sourceUpdatedAt,
    };
  };
  const github = {
    async listIssues() { return store.listIssues("repo").map((issue) => toIssue(issue.id)); },
    async getIssue(_address: string, number: number) { return toIssue(`item-${number}`); },
    async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }; },
    async collaboratorPermission() { return "write" as const; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async replaceConveyorLabels(_address: string, number: number, labels: string[]) {
      if (fake.down) throw new Error("gh: HTTP 502 Bad Gateway (https://api.github.com/graphql)");
      const issue = store.getIssue(`item-${number}`)!;
      store.upsertIssue({
        id: issue.id, repositoryId: issue.repositoryId, sourceNumber: issue.sourceNumber, sourceUrl: issue.sourceUrl, title: issue.title,
        body: issue.body, sourceState: issue.sourceState, labels, sourceUpdatedAt: new Date().toISOString(),
      });
    },
    async rateLimit() {
      fake.probes += 1;
      if (fake.down) throw new Error("HTTP 503 Service Unavailable");
      return { core: null, graphql: null };
    },
    async upsertStatusComment() { return 1; },
    async hasCommentWithMarker() { return false; },
    async addComment() { return 1; },
  };
  const service = new ConveyorService(config, store, github as never);
  for (let number = 1; number <= count; number += 1) {
    const id = `item-${number}`;
    store.upsertIssue({
      id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: `Feature ${number}`, body: CRITERIA,
      sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection(id, { stage: "implementation", state: "active", warning: null });
    store.setQueueRank(id, store.nextQueueRank());
    store.setStageState({ issueId: id, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    store.activateEnrollment(id);
  }
  const home = path.join(root, "home");
  const socket = path.join(home, "run/control.sock");
  const info = { home, config: path.join(root, "config.yml"), logs: config.settings.logs, database: config.settings.database, dashboardUrl: "http://localhost", startedAt: new Date().toISOString(), supervised: false };
  const control = await serveControlSocket(socket, createControlHandler(service, info));
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    await runCli(argv, { out: (text) => out.push(text), err: () => {}, environment: {}, interactive: false });
    return out.join("\n");
  };
  const close = async () => { await control.stop(); await service.close(); };
  return { service, store, fake, home, cli, close };
}

async function until(condition: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const lines = (text: string) => [...text.matchAll(LINE)];

describe("GitHub outage on status and the dashboard", () => {
  test("status and the dashboard show one GitHub-unavailable line with the waiting count, and waiting items show no blocker of their own", async () => {
    const { service, store, home, cli, close } = await setup(3);
    try {
      await service.tick();
      await until(() => service.githubOutage()?.waitingItems.length === 3, "three waiting items");

      const status = await cli("status", "--home", home);
      expect(lines(status).map((match) => match[1])).toEqual(["3"]);

      const dashboard = service.dashboard("csrf");
      expect(dashboard.systemWarnings.filter((warning) => warning.includes("GitHub unavailable since"))).toHaveLength(1);
      expect(lines(renderDashboard(dashboard)).map((match) => match[1])).toEqual(["3"]);

      // No waiting item carries its own outage blocker: not on the stored item, not in the board.
      for (const issue of store.listIssues("repo")) expect(issue.warning).toBeNull();
      const board = await cli("board", "--home", home);
      expect(board).not.toContain("GitHub unavailable");
      expect(board).not.toContain("!");
    } finally {
      await close();
    }
  });

  test("neither status nor the dashboard shows the line when no item waits on GitHub", async () => {
    const { service, home, cli, close } = await setup(3);
    try {
      expect(service.githubOutage()).toBeNull();
      expect(lines(await cli("status", "--home", home))).toHaveLength(0);
      const dashboard = service.dashboard("csrf");
      expect(dashboard.systemWarnings.filter((warning) => warning.includes("GitHub unavailable"))).toHaveLength(0);
      expect(renderDashboard(dashboard)).not.toContain("GitHub unavailable");
    } finally {
      await close();
    }
  });

  test("the line goes away once GitHub answers and the items resume", async () => {
    const { service, fake, home, cli, close } = await setup(3);
    try {
      await service.tick();
      await until(() => service.githubOutage()?.waitingItems.length === 3, "three waiting items");
      fake.down = false;
      await until(() => service.githubOutage() === null, "the outage to clear");
      expect(lines(await cli("status", "--home", home))).toHaveLength(0);
      expect(renderDashboard(service.dashboard("csrf"))).not.toContain("GitHub unavailable");
    } finally {
      await close();
    }
  });
});
