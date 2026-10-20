import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { createControlHandler, serveControlSocket } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, type LogRecord, log } from "../../src/log/logger";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];

afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function config(root: string): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "conveyor.sqlite"),
      logs: path.join(root, "logs"),
      artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"),
      runners: 1,
      reconcileInterval: "1m",
    },
    sources: { github: { type: "github" } },
    labels: {
      enrollment: "conveyor",
      stageTemplate: "conveyor:{stage}",
      states: {},
      metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: {
      default: {
        successStatuses: ["done"],
        failureStatuses: ["blocked"],
        stages: [{ id: "implementation", concurrency: 1, actions: [], "exit-gate": [{ id: "acknowledge", task: "item.followUps", manual: true }] }],
      },
    },
    repositories: {
      app: {
        source: "github", address: "owner/my-app", folder: root, pipeline: "default",
      },
    },
    agents: {},
  });
  return { ...parsed, hash: "startup-test", root, plans: [] };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

async function twoRepositoryService(holdSecond: Promise<void>, failSecond = false, holdFirst = Promise.resolve(), failFirst = false) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-startup-"));
  directories.push(root);
  const firstFolder = path.join(root, "first");
  const secondFolder = path.join(root, "second");
  await Promise.all([mkdir(firstFolder), mkdir(secondFolder)]);
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
          - { id: acknowledge, task: item.followUps, manual: true }
repositories:
  first: { source: github, address: owner/my-app, folder: ${firstFolder}, pipeline: default }
  second: { source: github, address: owner/other-app, folder: ${secondFolder}, pipeline: default }
`);
  const loaded = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(loaded.settings.database);
  for (const [id, address, folder, issueId, number] of [
    ["first", "owner/my-app", firstFolder, "first-issue", 1],
    ["second", "owner/other-app", secondFolder, "second-issue", 2],
  ] as const) {
    store.upsertRepository({ id, configName: id, source: "github", address, folder, configHash: loaded.hash });
    store.upsertIssue({
      id: issueId, repositoryId: id, sourceNumber: number, sourceUrl: `https://example.com/issues/${number}`,
      title: id, body: "", sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection(issueId, { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: loaded.hash });
    store.activateEnrollment(issueId);
    store.setQueueRank(issueId, number);
  }
  let secondListed = false;
  const labels = new Map<number, string[]>([
    [1, ["conveyor", "conveyor:implementation"]],
    [2, ["conveyor", "conveyor:implementation"]],
  ]);
  const sourceIssue = (number: number) => ({
    id: `source-${number}`, number, url: `https://example.com/issues/${number}`, title: "Recovered", body: "",
    state: "open" as const, labels: labels.get(number) ?? [], updatedAt: "2026-01-01T00:00:00Z",
  });
  const github = {
    async repositoryVisibility() { return "private" as const; },
    async collaboratorPermission() { return "admin" as const; },
    async ensureLabels() {},
    async listIssues(address: string) {
      if (address === "owner/my-app") {
        await holdFirst;
        if (failFirst) throw new Error("source unavailable");
      }
      if (address === "owner/other-app") {
        secondListed = true;
        await holdSecond;
        if (failSecond) throw new Error("source unavailable");
      }
      return [sourceIssue(address === "owner/my-app" ? 1 : 2)];
    },
    async getIssue(_address: string, number: number) { return sourceIssue(number); },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: null, body: null }; },
    async replaceConveyorLabels(_address: string, number: number, nextLabels: readonly string[]) {
      labels.set(number, [...nextLabels]);
    },
    async upsertStatusComment() { return 1; },
  };
  return { service: new ConveyorService(loaded, store, github as never), store, secondListed: () => secondListed };
}

describe("startup reconciliation", () => {
  test("serves the dashboard, live health, and control status while a cold repository is reconciling", async () => {
    const root = await shortTemporaryDirectory("conveyor-startup-", { socketPath: "control.sock" });
    directories.push(root);
    let release!: () => void;
    const heldListing = new Promise<void>((resolve) => { release = resolve; });
    let listed = 0;
    const records: LogRecord[] = [];
    const github = {
      async repositoryVisibility() { return "private" as const; },
      async ensureLabels() {},
      async listIssues() { listed += 1; await heldListing; return []; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = await ConveyorService.create(config(root), github as never, new CodeHostRegistry());
    expect(service.startupStatus()).toEqual({ state: "starting", repository: "app", phase: "waiting" });
    const auth = createWebAuth({
      username: "operator",
      passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      secureCookies: false,
    });
    const web = Bun.serve({ port: 0, fetch: createWebHandler(service.webDependencies(auth, "operator")) });
    const socket = path.join(root, "control.sock");
    const control = await serveControlSocket(socket, createControlHandler(service, {
      home: root, config: path.join(root, "conveyor.yaml"), logs: path.join(root, "logs"), database: path.join(root, "conveyor.sqlite"),
      dashboardUrl: "https://conveyor.example.com/", startedAt: new Date().toISOString(), supervised: false,
    }));
    log.configure({ sinks: [{ write: (record) => records.push(record) }] });
    try {
      service.start();
      await waitFor(() => listed === 1);

      const login = await fetch(new URL("/login", web.url), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "operator", password: "correct horse" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const [live, ready, dashboard, status] = await Promise.all([
        fetch(new URL("/health/live", web.url)),
        fetch(new URL("/health/ready", web.url), { headers: { cookie } }),
        fetch(new URL("/api/v1/snapshot", web.url), { headers: { cookie } }),
        fetch("http://example.com/v1/status", { unix: socket }),
      ]);

      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(await dashboard.text()).toContain(`"startup":"reconciling"`);
      expect(await status.json()).toMatchObject({
        ready: false,
        startup: { state: "starting", repository: "app", phase: "reconciling" },
      });
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "Startup repository reconciliation started", repository: "app" }),
      ]));

      release();
      await waitFor(() => service.isReady());
      expect((await fetch(new URL("/health/ready", web.url), { headers: { cookie } })).status).toBe(200);
      expect((await fetch("http://example.com/v1/status", { unix: socket })).json()).resolves.toMatchObject({
        ready: true,
        startup: { state: "ready", repository: null, phase: null },
      });
      expect(await (await fetch(new URL("/api/v1/snapshot", web.url), { headers: { cookie } })).text()).not.toContain(`"startup":"reconciling"`);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "Startup repository reconciliation completed", repository: "app", issues: 0, success: true,
        }),
      ]));
      expect(records.find((record) => record.message === "Startup repository reconciliation completed")!.durationMs).toEqual(expect.any(Number));
    } finally {
      release();
      await service.close();
      await control.stop();
      web.stop(true);
    }
  });

  test("keeps cached startup live while held onboarding degrades", async () => {
    const root = await shortTemporaryDirectory("conveyor-startup-", { socketPath: "control.sock" });
    directories.push(root);
    const cached = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    cached.upsertRepository({
      id: "app", configName: "app", source: "github", address: "owner/my-app", folder: root, configHash: "startup-test",
    });
    cached.upsertIssue({
      id: "cached-issue", repositoryId: "app", sourceNumber: 1, sourceUrl: "https://example.com/issues/1",
      title: "Cached issue", body: "", sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    cached.setIssueProjection("cached-issue", { stage: "implementation", state: "active", warning: null });
    cached.setStageState({ issueId: "cached-issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: "startup-test" });
    cached.activateEnrollment("cached-issue");
    cached.setQueueRank("cached-issue", 1);
    cached.close();

    let release!: () => void;
    const heldOnboarding = new Promise<void>((resolve) => { release = resolve; });
    let labelsRequested = 0;
    const github = {
      async repositoryVisibility() { return "private" as const; },
      async ensureLabels() {
        labelsRequested += 1;
        await heldOnboarding;
        throw new Error("label setup unavailable");
      },
      async listIssues() { throw new Error("reconciliation must not start after failed onboarding"); },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = await ConveyorService.create(config(root), github as never, new CodeHostRegistry());
    const auth = createWebAuth({
      username: "operator",
      passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      secureCookies: false,
    });
    const web = Bun.serve({ port: 0, fetch: createWebHandler(service.webDependencies(auth, "operator")) });
    const socket = path.join(root, "control.sock");
    const control = await serveControlSocket(socket, createControlHandler(service, {
      home: root, config: path.join(root, "conveyor.yaml"), logs: path.join(root, "logs"), database: path.join(root, "conveyor.sqlite"),
      dashboardUrl: "https://conveyor.example.com/", startedAt: new Date().toISOString(), supervised: false,
    }));
    try {
      service.start();
      await waitFor(() => labelsRequested === 1);

      const login = await fetch(new URL("/login", web.url), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "operator", password: "correct horse" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const [live, ready, dashboard, status] = await Promise.all([
        fetch(new URL("/health/live", web.url)),
        fetch(new URL("/health/ready", web.url), { headers: { cookie } }),
        fetch(new URL("/api/v1/snapshot", web.url), { headers: { cookie } }),
        fetch("http://example.com/v1/status", { unix: socket }),
      ]);

      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(await dashboard.text()).toContain(`"startup":"onboarding"`);
      expect(await (await fetch(new URL("/api/v1/snapshot", web.url), { headers: { cookie } })).text()).toContain("Cached issue");
      expect(await status.json()).toMatchObject({
        ready: false,
        startup: { state: "starting", repository: "app", phase: "onboarding" },
      });

      release();
      await waitFor(() => service.startupStatus().state === "degraded");
      const [failedLive, failedReady, failedDashboard, failedStatus] = await Promise.all([
        fetch(new URL("/health/live", web.url)),
        fetch(new URL("/health/ready", web.url), { headers: { cookie } }),
        fetch(new URL("/api/v1/snapshot", web.url), { headers: { cookie } }),
        fetch("http://example.com/v1/status", { unix: socket }),
      ]);
      expect(failedLive.status).toBe(200);
      expect(failedReady.status).toBe(503);
      expect(await failedDashboard.text()).toContain("label setup unavailable");
      expect(await failedStatus.json()).toMatchObject({
        ready: false,
        startup: { state: "degraded", repository: "app", phase: null },
      });
    } finally {
      release();
      await service.close();
      await control.stop();
      web.stop(true);
    }
  });

  test("clears startup only after every repository succeeds and exposes a failed repository as degraded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-startup-"));
    directories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const github = {
      async repositoryVisibility() { return "private" as const; },
      async ensureLabels() {},
      async listIssues() { throw new Error("source unavailable"); },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = new ConveyorService(config(root), store, github as never);
    const records: LogRecord[] = [];
    log.configure({ sinks: [{ write: (record) => records.push(record) }] });
    service.start();
    try {
      await waitFor(() => service.startupStatus().state === "degraded");
      expect(service.startupStatus()).toEqual({ state: "degraded", repository: "app", phase: null });
      expect(service.isReady()).toBe(false);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "Startup repository reconciliation completed", repository: "app", issues: 0, success: false,
        }),
      ]));
      expect(records.find((record) => record.message === "Startup repository reconciliation completed")!.durationMs).toEqual(expect.any(Number));
    } finally {
      await service.close();
    }
  });

  test("admits each recovered repository only after its own startup reconciliation", async () => {
    let release!: () => void;
    const secondListing = new Promise<void>((resolve) => { release = resolve; });
    const { service, store, secondListed } = await twoRepositoryService(secondListing);
    try {
      service.start();
      await waitFor(secondListed);
      await waitFor(() => store.getStageState("first-issue")?.status === "done");
      expect(store.getStageState("second-issue")?.status).toBe("ready");

      release();
      await waitFor(() => store.getStageState("second-issue")?.status === "done");
    } finally {
      release();
      await service.close();
    }
  });

  test("admits a later repository while an earlier startup reconciliation is held", async () => {
    let release!: () => void;
    const firstListing = new Promise<void>((resolve) => { release = resolve; });
    const { service, store, secondListed } = await twoRepositoryService(Promise.resolve(), false, firstListing);
    try {
      service.start();
      await waitFor(secondListed);
      await waitFor(() => store.getStageState("second-issue")?.status === "done");
      expect(store.getStageState("first-issue")?.status).toBe("ready");

      release();
      await waitFor(() => store.getStageState("first-issue")?.status === "done");
    } finally {
      release();
      await service.close();
    }
  });

  test("keeps an unreconciled failed repository out of scheduling while another recovers", async () => {
    const { service, store, secondListed } = await twoRepositoryService(Promise.resolve(), true);
    try {
      service.start();
      await waitFor(secondListed);
      await waitFor(() => service.startupStatus().state === "degraded");
      await waitFor(() => store.getStageState("first-issue")?.status === "done");
      expect(service.startupStatus()).toEqual({ state: "degraded", repository: "second", phase: null });
      expect(store.getStageState("second-issue")?.status).toBe("ready");
    } finally {
      await service.close();
    }
  });
});
