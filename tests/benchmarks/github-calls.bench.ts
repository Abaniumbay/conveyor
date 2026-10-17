// GitHub call benchmark: runs fixed scenarios through the real service, adapter, code host and CI
// provider over the GitHub simulator, with virtual time, and reports every request by source and
// route. Run with `bun run benchmark:github-calls`; set GITHUB_CALLS_OUT=<file> to save JSON.

import { afterAll, describe, expect, jest, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import { GitHubAdapter, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";
import { GitHubCallMeter, MeteredGitHubTransport, currentGitHubCallSource, githubRoute } from "../../src/source/github/call-meter";
import { createGitHubCodeHostRegistry } from "../../src/source/github/codehost-registry";
import { GitHubSimulator } from "../support/github-simulator";

const ADDRESS = "owner/my-app";
const SECRET = "benchmark-secret";
const START = new Date("2026-10-17T10:00:00.000Z");
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);
const MINUTE = 60_000;
const ITEM_50 = `github:${ADDRESS}#50`;

interface Recorded { at: number; source: string; call: string }

/** Records each request with its source and time before the simulator answers it. */
class Tap implements GitHubTransport {
  readonly calls: Recorded[] = [];
  constructor(private readonly inner: GitHubTransport) {}
  request<T>(request: GitHubTransportRequest): Promise<T> {
    this.calls.push({ at: Date.now(), source: currentGitHubCallSource(), call: `${request.method} ${githubRoute(request.path)}` });
    return this.inner.request<T>(request);
  }
}

interface ScenarioResult {
  scenario: string;
  description: string;
  virtualMinutes: number;
  total: number;
  bySource: Record<string, number>;
  byCall: Record<string, number>;
  outcome: string;
}

const results: ScenarioResult[] = [];
const directories: string[] = [];

async function flush(): Promise<void> {
  // Lets the service's promise chains (and a little real I/O) run between timer steps.
  for (let round = 0; round < 40; round += 1) await new Promise((resolve) => setImmediate(resolve));
  await readFile(import.meta.path);
}

async function world(options: { openIssues: number; pulls: number; enrolledParked?: number }) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-github-calls-bench-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
web: { publicUrl: "https://conveyor.example.com" }
sources: { github: { type: github, webhookSecret: ${SECRET}, autoConfigureWebhook: true } }
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
      - id: ready
        concurrency: 3
        actions: []
        exit-gate:
          - { id: dependencies, task: item.dependenciesMet, wait: { timeout: unlimited, poll: 5m } }
      - id: implementation
        concurrency: 2
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed, wait: { timeout: 3h, poll: 1m } }
      - id: merge
        concurrency: 1
        actions: []
        exit-gate:
          - { id: mergeable, task: change.mergeable, wait: { timeout: 30m, poll: 1m } }
repositories:
  app: { source: github, address: ${ADDRESS}, folder: ${repositoryPath}, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const simulator = new GitHubSimulator();
  const tap = new Tap(simulator);
  const meter = new GitHubCallMeter();
  const github = new GitHubAdapter(new MeteredGitHubTransport(tap, meter), "conveyor");
  // Background issues: open, not enrolled, as in a real repository.
  for (let number = 1; number <= options.openIssues; number += 1) simulator.addIssue(ADDRESS, { number, labels: ["bug"] });
  for (let index = 0; index < options.pulls; index += 1) simulator.addPullRequest(ADDRESS, { number: 900 + index, headSha: SHA_2 });
  // Enrolled items parked on a blocker that stays open, as a busy production repository has.
  if (options.enrolledParked) {
    simulator.addIssue(ADDRESS, { number: 999, labels: ["bug"] });
    for (let index = 0; index < options.enrolledParked; index += 1) simulator.addIssue(ADDRESS, { number: 200 + index, labels: ["conveyor", "conveyor:ready"], blockedBy: [999] });
  }
  let delivery = 0;
  const deliver = async (service: ConveyorService, event: string, payload: Record<string, unknown>) => {
    // As GitHub sends them: an issue delivery carries the whole issue and who made the change.
    const named = (payload.issue as { number?: number } | undefined)?.number;
    const issue = (event === "issues" || event === "issue_comment") && named !== undefined && simulator.repository(ADDRESS).issues.has(named)
      ? { issue: simulator.issueJson(ADDRESS, named) } : {};
    const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: ADDRESS }, sender: { login: "maintainer" }, ...payload, ...issue }));
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    await service.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": `d${(delivery += 1)}`, "x-github-event": event }));
  };
  return { config, simulator, tap, github, meter, deliver };
}

/** Runs one scenario under virtual time and records its GitHub requests. */
async function scenario(
  name: string,
  description: string,
  options: { openIssues: number; pulls: number; enrolledParked?: number; includeStartup?: boolean; restart?: boolean },
  seed: (w: Awaited<ReturnType<typeof world>>, store: ConveyorStore) => void,
  script: (w: Awaited<ReturnType<typeof world>> & { service: ConveyorService; advance: (ms: number) => Promise<void> }) => Promise<string>,
): Promise<ScenarioResult> {
  log.configure(process.env.BENCHMARK_LOG ? { level: "debug", sinks: [new ConsoleSink()] } : { sinks: [] });
  jest.useFakeTimers();
  jest.setSystemTime(START);
  const w = await world(options);
  // State Conveyor already holds locally (a known pull request) is written before the service opens.
  const seeded = await ConveyorStore.open(w.config.settings.database);
  seeded.upsertRepository({ id: "app", configName: "app", source: "github", address: ADDRESS, folder: w.config.repositories.app!.folder, configHash: w.config.hash });
  seed(w, seeded);
  seeded.close();
  if (options.restart) {
    // A first run that onboards everything and stops, so the measured start is a restart.
    const first = await ConveyorService.create(w.config, w.github, createGitHubCodeHostRegistry(w.config, w.github), w.meter);
    first.start();
    await flush();
    jest.advanceTimersByTime(MINUTE);
    await flush();
    await first.webhooksSettled();
    await first.close();
  }
  const startupFrom = w.tap.calls.length;
  const service = await ConveyorService.create(w.config, w.github, createGitHubCodeHostRegistry(w.config, w.github), w.meter);
  const advance = async (ms: number) => {
    const step = 5_000;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      jest.advanceTimersByTime(Math.min(step, ms - elapsed));
      await flush();
    }
  };
  // Startup (onboarding, the first reconcile) is the same before and after; measure from here.
  const measuredFrom = options.includeStartup ? startupFrom : w.tap.calls.length;
  service.start();
  await flush();
  const outcome = await script({ ...w, service, advance });
  const calls = w.tap.calls.slice(measuredFrom);
  const virtualMinutes = Math.round((Date.now() - START.getTime()) / MINUTE);
  jest.useRealTimers();
  await service.webhooksSettled();
  await service.close();
  expect(w.simulator.unhandled).toEqual([]);
  const count = (key: (entry: Recorded) => string) => calls.reduce<Record<string, number>>((all, entry) => {
    all[key(entry)] = (all[key(entry)] ?? 0) + 1;
    return all;
  }, {});
  const result: ScenarioResult = {
    scenario: name, description, virtualMinutes, total: calls.length,
    bySource: count((entry) => entry.source), byCall: count((entry) => entry.call), outcome,
  };
  results.push(result);
  return result;
}

/** Advances virtual time in 5-second steps until `done` holds; returns the time it first held. */
async function until(advance: (ms: number) => Promise<void>, done: () => boolean, limitMs: number): Promise<number> {
  for (let waited = 0; waited < limitMs && !done(); waited += 5_000) await advance(5_000);
  if (!done()) throw new Error("the scenario's expected change did not happen in time");
  return Date.now();
}

const enrolled = (stage: string) => ["conveyor", `conveyor:${stage}`];

describe("GitHub calls per scenario", () => {
  test("CI wait: one item waits 20 minutes for CI, with webhooks delivered", async () => {
    await scenario(
      "ci-wait-20m",
      "An item parked on ci.passed while CI runs for 20 minutes; GitHub delivers workflow_run requested, in_progress and completed, and check_suite completed. Measured until the item enters the next stage.",
      { openIssues: 20, pulls: 4 },
      (w, store) => {
        const { simulator } = w;
        simulator.addIssue(ADDRESS, { number: 50, labels: enrolled("implementation") });
        simulator.addPullRequest(ADDRESS, { number: 150, headSha: SHA_1, headRef: "conveyor/50-work" });
        store.upsertIssue({ id: ITEM_50, repositoryId: "app", sourceNumber: 50, sourceUrl: `https://github.com/${ADDRESS}/issues/50`, title: "Issue 50", body: "", sourceState: "open", labels: enrolled("implementation"), sourceUpdatedAt: START.toISOString() });
        store.setIssueProjection(ITEM_50, { stage: "implementation", state: "active", warning: null });
        store.setStageState({ issueId: ITEM_50, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: w.config.hash });
        store.activateEnrollment(ITEM_50);
        store.upsertPullRequest({ issueId: ITEM_50, id: `github:${ADDRESS}#pr-150`, number: 150, url: `https://github.com/${ADDRESS}/pull/150`, state: "open" });
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "queued" }]);
      },
      async ({ service, simulator, deliver, advance }) => {
        const run = (action: string, status: string, conclusion: string | null) => ({
          action, workflow_run: { head_sha: SHA_1, status, conclusion, pull_requests: [{ number: 150 }] },
        });
        await deliver(service, "workflow_run", run("requested", "queued", null));
        await advance(MINUTE);
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "in_progress", startedAt: new Date().toISOString() }]);
        await deliver(service, "workflow_run", run("in_progress", "in_progress", null));
        await advance(19 * MINUTE);
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "completed", conclusion: "success", startedAt: START.toISOString(), completedAt: new Date().toISOString() }]);
        // Each check run finishes (and is delivered) before the workflow run that contains it.
        for (const checkRun of simulator.checkRunsJson(ADDRESS, SHA_1)) await deliver(service, "check_run", { action: "completed", check_run: { ...checkRun, pull_requests: [{ number: 150 }] } });
        await deliver(service, "workflow_run", run("completed", "completed", "success"));
        const completedAt = Date.now();
        await deliver(service, "check_suite", { action: "completed", check_suite: { head_sha: SHA_1, status: "completed", conclusion: "success", pull_requests: [{ number: 150 }] } });
        const moved = await until(advance, () => service.store.getIssue(ITEM_50)?.projectedStage !== "implementation", 15 * MINUTE);
        return `stage after: ${service.store.getIssue(ITEM_50)?.projectedStage ?? "none"}, ${Math.round((moved - completedAt) / 1_000)} s after CI completed`;
      },
    );
  }, 120_000);

  test("webhook burst: ten deliveries in ten seconds on a repository with 20 open issues", async () => {
    await scenario(
      "webhook-burst",
      "Ten deliveries within ten seconds: four comments on an enrolled issue, one label change, one pull request synchronize and four workflow_run in_progress for a pull request Conveyor does not own. Both enrolled items stay parked on an open blocker. Measured for three minutes.",
      { openIssues: 20, pulls: 4 },
      ({ simulator }) => {
        simulator.addIssue(ADDRESS, { number: 60, labels: enrolled("ready"), blockedBy: [62] });
        simulator.addIssue(ADDRESS, { number: 61, labels: enrolled("ready"), blockedBy: [62] });
        simulator.addIssue(ADDRESS, { number: 62, labels: ["bug"] });
      },
      async ({ service, simulator, deliver, advance }) => {
        await advance(MINUTE);
        for (let index = 0; index < 4; index += 1) {
          await deliver(service, "issue_comment", { action: "created", issue: { number: 60 }, comment: { id: 5000 + index, body: "A note" } });
          await advance(1_000);
        }
        simulator.updateIssue(ADDRESS, 61, { labels: [...enrolled("ready"), "priority"] });
        await deliver(service, "issues", { action: "labeled", issue: { number: 61 }, label: { name: "priority" } });
        await deliver(service, "pull_request", { action: "synchronize", pull_request: { number: 900, head: { sha: SHA_2 } } });
        for (let index = 0; index < 4; index += 1) {
          await deliver(service, "workflow_run", { action: "in_progress", workflow_run: { head_sha: SHA_2, status: "in_progress", pull_requests: [{ number: 900 }] } });
          await advance(1_000);
        }
        await advance(2 * MINUTE);
        return "settled";
      },
    );
  }, 120_000);

  test("dependency wait: an item waits 42 minutes for its blocker to close", async () => {
    await scenario(
      "dependency-wait-42m",
      "An item parked on item.dependenciesMet; its blocker closes after 42 minutes and GitHub delivers issues closed. Measured until the item enters the next stage.",
      { openIssues: 20, pulls: 4 },
      ({ simulator }) => {
        simulator.addIssue(ADDRESS, { number: 70, labels: enrolled("ready"), blockedBy: [71] });
        simulator.addIssue(ADDRESS, { number: 71, labels: ["bug"] });
      },
      async ({ service, simulator, deliver, advance }) => {
        await advance(42 * MINUTE);
        simulator.updateIssue(ADDRESS, 71, { state: "closed" });
        const closedAt = Date.now();
        await deliver(service, "issues", { action: "closed", issue: { number: 71 } });
        const moved = await until(advance, () => service.store.getIssue(`github:${ADDRESS}#70`)?.projectedStage !== "ready", 15 * MINUTE);
        return `stage after: ${service.store.getIssue(`github:${ADDRESS}#70`)?.projectedStage ?? "none"}, ${Math.round((moved - closedAt) / 1_000)} s after the blocker closed`;
      },
    );
  }, 120_000);

  test("idle hour: a repository with 20 open issues, 4 pull requests and one parked item, no deliveries", async () => {
    await scenario(
      "idle-hour",
      "Nothing happens for an hour: 20 open issues, 4 open pull requests and one enrolled item parked on a dependency that stays open. Only periodic work runs.",
      { openIssues: 20, pulls: 4 },
      ({ simulator }) => {
        simulator.addIssue(ADDRESS, { number: 80, labels: enrolled("ready"), blockedBy: [81] });
        simulator.addIssue(ADDRESS, { number: 81, labels: ["bug"] });
      },
      async ({ advance }) => {
        await advance(60 * MINUTE);
        return "idle";
      },
    );
  }, 120_000);

  test("restart: a repository with 30 enrolled items parked on a blocker", async () => {
    await scenario(
      "restart-30-enrolled",
      "Conveyor starts on a repository with 20 open issues, 4 pull requests and 30 enrolled items parked on an open blocker; the database already holds them from before the restart. Measured from the start of the service for two minutes, startup included.",
      { openIssues: 20, pulls: 4, enrolledParked: 30, includeStartup: true, restart: true },
      () => {},
      async ({ advance }) => {
        await advance(2 * MINUTE);
        return "started";
      },
    );
  }, 300_000);

  test("idle hour: 30 enrolled items parked on a blocker, no deliveries", async () => {
    await scenario(
      "idle-hour-30-enrolled",
      "Nothing happens for an hour on a repository with 20 open issues, 4 pull requests and 30 enrolled items parked on an open blocker.",
      { openIssues: 20, pulls: 4, enrolledParked: 30 },
      () => {},
      async ({ advance }) => {
        await advance(60 * MINUTE);
        return "idle";
      },
    );
  }, 300_000);

  test("delivery: one item from implementation to done next to 30 parked items", async () => {
    await scenario(
      "delivery-30-enrolled",
      "One item in implementation with its pull request, next to 30 enrolled items parked on an open blocker. CI runs for 10 minutes (workflow_run requested, in_progress, completed and check_suite completed), the item moves to merge, its pull request is mergeable, and it finishes. Every stage label Conveyor writes comes back as an issues labeled delivery. Measured until the item is done.",
      { openIssues: 20, pulls: 4, enrolledParked: 30 },
      (w, store) => {
        const { simulator } = w;
        simulator.addIssue(ADDRESS, { number: 50, labels: enrolled("implementation") });
        simulator.addPullRequest(ADDRESS, { number: 150, headSha: SHA_1, headRef: "conveyor/50-work" });
        store.upsertIssue({ id: ITEM_50, repositoryId: "app", sourceNumber: 50, sourceUrl: `https://github.com/${ADDRESS}/issues/50`, title: "Issue 50", body: "", sourceState: "open", labels: enrolled("implementation"), sourceUpdatedAt: START.toISOString() });
        store.setIssueProjection(ITEM_50, { stage: "implementation", state: "active", warning: null });
        store.setStageState({ issueId: ITEM_50, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: w.config.hash });
        store.activateEnrollment(ITEM_50);
        store.upsertPullRequest({ issueId: ITEM_50, id: `github:${ADDRESS}#pr-150`, number: 150, url: `https://github.com/${ADDRESS}/pull/150`, state: "open" });
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "queued" }]);
      },
      async ({ service, simulator, deliver, advance }) => {
        // Conveyor's own label writes come back as deliveries, as GitHub sends them.
        let lastLabels = "";
        const echoLabels = async () => {
          const labels = simulator.repository(ADDRESS).issues.get(50)?.labels.join(",") ?? "";
          if (labels === lastLabels) return;
          lastLabels = labels;
          await deliver(service, "issues", { action: "labeled", issue: { number: 50 }, label: { name: "conveyor" } });
        };
        const run = (action: string, status: string, conclusion: string | null) => ({
          action, workflow_run: { head_sha: SHA_1, status, conclusion, pull_requests: [{ number: 150 }] },
        });
        await deliver(service, "workflow_run", run("requested", "queued", null));
        await advance(MINUTE);
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "in_progress", startedAt: new Date().toISOString() }]);
        await deliver(service, "workflow_run", run("in_progress", "in_progress", null));
        await advance(9 * MINUTE);
        simulator.setCheckRuns(ADDRESS, SHA_1, [{ name: "build", status: "completed", conclusion: "success", startedAt: START.toISOString(), completedAt: new Date().toISOString() }]);
        // Each check run finishes (and is delivered) before the workflow run that contains it.
        for (const checkRun of simulator.checkRunsJson(ADDRESS, SHA_1)) await deliver(service, "check_run", { action: "completed", check_run: { ...checkRun, pull_requests: [{ number: 150 }] } });
        await deliver(service, "workflow_run", run("completed", "completed", "success"));
        await deliver(service, "check_suite", { action: "completed", check_suite: { head_sha: SHA_1, status: "completed", conclusion: "success", pull_requests: [{ number: 150 }] } });
        const done = () => service.store.getIssue(ITEM_50)?.projectedState === "done" || service.store.getIssue(ITEM_50)?.projectedStage === null;
        for (let waited = 0; waited < 30 * MINUTE && !done(); waited += 5_000) {
          await advance(5_000);
          await echoLabels();
        }
        const issue = service.store.getIssue(ITEM_50);
        return `item ${issue?.projectedStage ?? "-"}/${issue?.projectedState ?? "-"}`;
      },
    );
  }, 300_000);
});

afterAll(async () => {
  const lines = ["", "GitHub calls per scenario (startup excluded unless the scenario says so):", ""];
  for (const result of results) {
    lines.push(`${result.scenario} (${result.virtualMinutes} virtual min, ${result.outcome}): ${result.total} calls`);
    lines.push(`  by source: ${Object.entries(result.bySource).map(([source, count]) => `${source}=${count}`).join(", ")}`);
    for (const [call, count] of Object.entries(result.byCall).sort((left, right) => right[1] - left[1])) lines.push(`    ${String(count).padStart(4)}  ${call}`);
  }
  console.log(lines.join("\n"));
  const out = process.env.GITHUB_CALLS_OUT;
  if (out) await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
