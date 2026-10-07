import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CiProvider, CiRun } from "../../src/app/ci-provider";
import { ConveyorService } from "../../src/app/service";
import type { CodeHost } from "../../src/codehost/types";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const run = (name: string, state: CiRun["state"], over: Partial<CiRun> = {}): CiRun => ({
  id: `id-${name}`, name, state, url: `https://ci/${name}`, canRerun: false, hasLog: false, startedAt: "2026-01-01T00:00:00Z", completedAt: null, ...over,
});

async function setup(ci = "") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-ci-indicator-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
web: {}
sources: { github: { type: github, webhookSecret: hook-secret } }
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
          - { id: ciGate, task: ci.passed, with: { settleSeconds: 120 } }
repositories:
  repo: { source: github, address: owner/repo, folder: ${repositoryPath}, pipeline: default${ci} }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({ id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "u", title: "F", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment("issue");
  store.upsertPullRequest({ issueId: "issue", id: "pr-5", number: 5, url: "https://x/pull/5", state: "open" });

  const state = { head: "head1", runsHead: null as string | null, runs: [run("build", "running")] as CiRun[], listed: [] as string[], fail: false };
  const provider = {
    async list(_change: unknown, commit: string) {
      state.listed.push(commit);
      if (state.fail) throw new Error("provider down");
      return state.runsHead && state.runsHead !== commit ? [] : state.runs;
    },
  } as unknown as CiProvider;
  const statusComments: string[] = [];
  const github = {
    async listIssues() {
      return [{ id: "issue", number: 1, url: "u", title: "F", body: "", state: "open", labels: ["conveyor"], updatedAt: "2026-01-01T00:00:00Z" }];
    },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async upsertStatusComment(_address: string, _number: number, markdown: string) {
      statusComments.push(markdown);
      return statusComments.length;
    },
  };
  const service = new ConveyorService(config, store, github as never);
  service.drain("tests: nothing executes");
  const internals = service as unknown as {
    ciProvider: () => CiProvider;
    codeHostFor: () => CodeHost;
    backfillCiIndicators(id: string): Promise<void>;
    updateStatusComment(id: string): Promise<void>;
  };
  internals.ciProvider = () => provider;
  internals.codeHostFor = () => ({ async getChange() { return { headSha: state.head }; } }) as unknown as CodeHost;

  let delivery = 0;
  const deliver = (event: string, payload: Record<string, unknown>, id = `d${(delivery += 1)}`) => {
    const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: "owner/repo" }, ...payload }));
    const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    return service.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": id, "x-github-event": event }));
  };
  const indicator = () => store.listIndicators("issue").find((entry) => entry.id === "ci");
  const card = () => service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue;
  const reopen = async () => {
    const reopenedStore = await ConveyorStore.open(config.settings.database);
    const reopenedService = new ConveyorService(config, reopenedStore, github as never);
    reopenedService.drain("tests: nothing executes");
    const reopenedInternals = reopenedService as unknown as {
      ciProvider: () => CiProvider;
      codeHostFor: () => CodeHost;
    };
    reopenedInternals.ciProvider = () => provider;
    reopenedInternals.codeHostFor = () => ({ async getChange() { return { headSha: state.head }; } }) as unknown as CodeHost;
    return { service: reopenedService, store: reopenedStore };
  };
  return { service, store, state, internals, deliver, indicator, card, statusComments, reopen };
}

const workflowRun = (head: string, extra: Record<string, unknown> = {}) =>
  ({ action: "completed", workflow_run: { head_sha: head, pull_requests: [{ number: 5 }], ...extra } });

function parkCiGate(store: ConveyorStore, wakeAt: string) {
  const journal = store.executions();
  const epoch = journal.stageEpoch("issue");
  const { record } = journal.planExecution({
    itemId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, list: "exit-gate", taskInstanceId: "ciGate",
  });
  journal.markPending(record.id, { wakeAt, deadlineAt: null, message: "Waiting for CI at head1: 1 running." }, epoch);
  journal.saveCursor({
    issueId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, returns: 0, list: "exit-gate",
    taskInstanceId: "ciGate", state: "pending", feedback: null, pendingSince: new Date().toISOString(), wakeAt, deadlineAt: null,
  }, epoch);
}

test("existing changes acquire a current-head indicator on reconcile, shown on the card without a provider call", async () => {
  const w = await setup();
  expect(w.indicator()).toBeUndefined();
  await w.internals.backfillCiIndicators("repo");
  expect(w.indicator()).toMatchObject({ headSha: "head1", state: "running" });
  const listed = w.state.listed.length;
  expect(w.card()?.indicators).toMatchObject([{ id: "ci", state: "running", symbol: "●", progress: "1 running" }]);
  expect(w.state.listed.length).toBe(listed);
  await w.service.close();
});

test("reconcile revalidates a stored indicator against the current head", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  w.state.head = "head2";
  w.state.runs = [run("build", "passed")];
  await w.internals.backfillCiIndicators("repo");
  expect(w.indicator()).toMatchObject({ headSha: "head2", state: "passing" });
  await w.service.close();
});

test("a workflow_run webhook for the current head updates the stored indicator and the dashboard revision", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  expect(w.card()?.waiting).toMatchObject({ kind: "waiting", reason: "Waiting for CI at head1: 1 running · 0/1 passed." });
  const revision = w.service.dashboard("csrf").revision;
  await Bun.sleep(3);
  w.state.runs = [run("build", "passed", { completedAt: "2026-01-01T00:01:00Z" })];
  await w.deliver("workflow_run", workflowRun("head1"));
  expect(w.indicator()).toMatchObject({ state: "passing", progress: "1/1" });
  expect(w.service.dashboard("csrf").revision).not.toBe(revision);
  expect(w.card()?.indicators[0]).toMatchObject({ state: "passing", entries: [{ name: "build", state: "passed", durationMs: 60_000 }] });
  expect(w.card()?.waiting?.reason).toContain("CI passed at head1; settling until");
  expect(w.card()?.waiting?.reason).not.toContain("Waiting for CI");
  await w.internals.updateStatusComment("issue");
  expect(w.statusComments.at(-1)).toContain(`- Status: Waiting · ${w.card()?.waiting?.reason}`);
  await w.service.close();
});

test("a CI settle status preserves its head and end time across a restart", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  w.state.runs = [run("build", "passed", { completedAt: "2026-01-01T00:01:00Z" })];
  await w.deliver("workflow_run", workflowRun("head1"));
  const before = w.card()?.waiting?.reason;
  expect(before).toMatch(/^CI passed at head1; settling until /);
  await w.service.close();

  const restarted = await w.reopen();
  const after = restarted.service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue?.waiting?.reason;
  expect(after).toBe(before);
  await restarted.service.close();
});

test("concurrent status refreshes for an issue share one source-comment write", async () => {
  const w = await setup();
  let active = 0;
  let maximum = 0;
  const upsert = w.service.github.upsertStatusComment.bind(w.service.github);
  w.service.github.upsertStatusComment = async (...args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Bun.sleep(5);
    active -= 1;
    return upsert(...args);
  };

  await Promise.all([
    w.internals.updateStatusComment("issue"),
    w.internals.updateStatusComment("issue"),
  ]);

  expect(maximum).toBe(1);
  expect(w.statusComments).toHaveLength(1);
  await w.service.close();
});

test("a check_suite webhook without pull requests finds the item by its stored head", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  w.state.runs = [run("build", "failed")];
  await w.deliver("check_suite", { check_suite: { head_sha: "head1", pull_requests: [] } });
  expect(w.indicator()).toMatchObject({ state: "failed", progress: "1 failed" });
  expect(w.card()?.waiting).toMatchObject({ kind: "waiting", reason: "CI failed at head1: 1 failed · 0/1 passed." });
  await w.service.close();
});

test("duplicate deliveries and events for other or old heads do not regress the status", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  w.state.runs = [run("build", "passed")];
  await w.deliver("workflow_run", workflowRun("head1"), "same");
  w.state.runs = [run("build", "failed")];
  await w.deliver("workflow_run", workflowRun("head1"), "same");
  expect(w.indicator()).toMatchObject({ state: "passing" });
  // An old head: the code host says head1 is current, so head0 is ignored.
  await w.deliver("workflow_run", workflowRun("head0"));
  await w.deliver("workflow_run", { action: "completed", workflow_run: { head_sha: "other", pull_requests: [{ number: 99 }] } });
  expect(w.indicator()).toMatchObject({ headSha: "head1", state: "passing" });
  expect(w.card()?.waiting?.reason).toContain("CI passed at head1; settling until");
  await w.service.close();
});

test("a new head replaces the indicator with a starting one; old-head results afterwards are ignored", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  w.state.head = "head2";
  w.state.runs = [];
  await w.deliver("pull_request", { action: "synchronize", pull_request: { number: 5, head: { sha: "head2" } } });
  expect(w.indicator()).toMatchObject({ headSha: "head2", state: "running", detail: "CI is starting", entries: [] });
  w.state.runs = [run("build", "passed")];
  w.state.runsHead = "head1";
  await w.deliver("workflow_run", workflowRun("head1"));
  expect(w.indicator()).toMatchObject({ headSha: "head2", detail: "CI is starting" });
  w.state.runsHead = "head2";
  await w.deliver("workflow_run", workflowRun("head2"));
  expect(w.indicator()).toMatchObject({ headSha: "head2", state: "passing" });
  await w.service.close();
});

test("an unreadable provider on a webhook records unknown instead of a stale state", async () => {
  const w = await setup();
  await w.internals.backfillCiIndicators("repo");
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  w.state.fail = true;
  await w.deliver("workflow_run", workflowRun("head1"));
  expect(w.indicator()).toMatchObject({ state: "unknown", detail: "CI could not be read: provider down" });
  expect(w.card()?.waiting).toMatchObject({ kind: "waiting", reason: "Waiting for CI at head1: CI could not be read: provider down." });
  expect(w.card()?.waiting?.reason).not.toContain("passed");
  await w.service.close();
});

test("an expired CI settle window waits for the next gate evaluation instead", async () => {
  const w = await setup();
  parkCiGate(w.store, new Date(Date.now() + 60_000).toISOString());
  w.store.executions().markCi("issue", "head1", "first-seen", "", "2000-01-01T00:00:00.000Z");
  w.store.saveIndicator("issue", "head1", {
    id: "ci", label: "CI", state: "passing", detail: "1/1 passed", progress: "1/1", url: null,
    observedAt: "2000-01-01T00:00:00.000Z", entries: [], reference: null,
  }, true);

  expect(w.card()?.waiting?.reason).toBe("CI passed at head1; ready for the next gate evaluation.");
  await w.service.close();
});

test("disabled CI stores and shows no indicator", async () => {
  const w = await setup(", ci: { mode: disabled }");
  await w.internals.backfillCiIndicators("repo");
  await w.deliver("workflow_run", workflowRun("head1"));
  expect(w.store.listIndicators()).toEqual([]);
  expect(w.card()?.indicators).toEqual([]);
  // A record from before CI was disabled is not rendered either.
  w.store.saveIndicator("issue", "head1", { id: "ci", label: "CI", state: "passing", detail: "1/1 passed", progress: "1/1", url: null, observedAt: "2026-01-01T00:00:00Z", entries: [], reference: null }, true);
  expect(w.card()?.indicators).toEqual([]);
  await w.service.close();
});

test("an item without a change has no indicator", async () => {
  const w = await setup();
  w.store.upsertIssue({ id: "lone", repositoryId: "repo", sourceNumber: 2, sourceUrl: "u", title: "L", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  w.store.setIssueProjection("lone", { stage: "implementation", state: "active", warning: null });
  await w.internals.backfillCiIndicators("repo");
  expect(w.store.listIndicators("lone")).toEqual([]);
  await w.service.close();
});
