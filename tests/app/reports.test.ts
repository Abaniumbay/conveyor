import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildReport, reportSince } from "../../src/app/reports";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const H = 3_600_000;
const NOW = new Date("2026-10-20T00:00:00.000Z");
const at = (base: string, hours: number) => new Date(Date.parse(base) + hours * H).toISOString();

const config = {
  repositories: { alpha: { pipeline: "delivery" }, beta: { pipeline: "delivery" } },
  pipelines: { delivery: { stages: [{ id: "implementation" }, { id: "review", name: "Code review" }, { id: "cleanup" }] } },
} as unknown as ConveyorConfig;

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-report-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  const db = store.sqlite();
  for (const id of ["alpha", "beta"]) store.upsertRepository({ id, configName: id, source: "github", address: `o/${id}`, folder: "/f", configHash: "h" });
  let sequence = 0;
  const issue = (id: string, repository: string, number: number, projected: string, enrolledAt: string | null) => {
    store.upsertIssue({ id, repositoryId: repository, sourceNumber: number, sourceUrl: `https://x/${number}`, title: `Item ${number}`, body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    store.setIssueProjection(id, { stage: "implementation", state: projected, warning: null });
    if (enrolledAt) db.query("INSERT INTO enrollments(id, issue_id, generation, status, started_at) VALUES (?, ?, 1, 'active', ?)").run(`e-${id}`, id, enrolledAt);
  };
  const run = (issueId: string, stage: string, status: string, startedAt: string, hours: number | null, input = 0, output = 0, cached = 0) => {
    const id = `r${++sequence}`;
    db.query("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, finished_at) VALUES (?, ?, ?, 1, 'producer', ?, 'h', ?, ?)")
      .run(id, issueId, stage, status, startedAt, hours === null ? null : at(startedAt, hours));
    db.query("INSERT INTO usage_cost_entries(id, run_id, input_tokens, output_tokens, cached_tokens, source, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, 'unavailable', 0, ?)")
      .run(`u${sequence}`, id, input, output, cached, startedAt);
  };
  const transition = (issueId: string, kind: string, from: string, to: string, createdAt: string) => {
    db.query("INSERT INTO stage_transitions(id, issue_id, from_stage, to_stage, status, created_at, completed_at, kind) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)")
      .run(`t${++sequence}`, issueId, from, to, createdAt, createdAt, kind);
  };
  const wait = (issueId: string, since: string, hours: number) => {
    db.query("INSERT INTO task_executions(id, issue_id, stage, stage_epoch, attempt, list, task_instance_id, idempotency_key, state, recovery_state, started_at, pending_since, updated_at) VALUES (?, ?, 'implementation', 1, 1, 'exit-gate', 'ciGate', ?, 'completed', 'not-needed', ?, ?, ?)")
      .run(`w${++sequence}`, issueId, `k${sequence}`, since, since, at(since, hours));
  };

  // alpha#1: delivered this month after one review return and one stop.
  const a1 = "2026-10-10T00:00:00.000Z";
  issue("a1", "alpha", 1, "done", a1);
  run("a1", "implementation", "succeeded", a1, 1, 900, 100, 600);
  wait("a1", at(a1, 1), 0.5);
  transition("a1", "advance", "implementation", "review", at(a1, 1.5));
  run("a1", "review", "succeeded", at(a1, 1.5), 0.5, 200, 0, 100);
  transition("a1", "correction", "review", "implementation", at(a1, 2));
  transition("a1", "stopped", "implementation", "implementation", at(a1, 2));
  transition("a1", "resumed", "implementation", "implementation", at(a1, 4));
  run("a1", "implementation", "failed", at(a1, 4), 1, 800, 0, 0);
  transition("a1", "advance", "cleanup", "cleanup", at(a1, 10));
  // alpha#2: in progress, a run still going.
  issue("a2", "alpha", 2, "active", "2026-10-19T00:00:00.000Z");
  run("a2", "implementation", "running", "2026-10-19T22:00:00.000Z", null, 0, 0, 0);
  // alpha#3: imported as done with no recorded delivery.
  issue("a3", "alpha", 3, "done", null);
  // beta#7: delivered last month, first pass.
  const b7 = "2026-09-01T00:00:00.000Z";
  issue("b7", "beta", 7, "done", b7);
  run("b7", "implementation", "succeeded", b7, 2, 3000, 0, 0);
  transition("b7", "advance", "cleanup", "cleanup", at(b7, 6));
  return store;
}

describe("buildReport", () => {
  test("totals and per-item averages count delivered items over their whole life and leave imported items out", async () => {
    const store = await world();
    const report = buildReport({ store, config, period: "all", repository: null, now: NOW });
    expect(report.totals).toMatchObject({
      delivered: 2, inProgress: 1, runs: 5, failedRuns: 1,
      inputTokens: 4900, outputTokens: 100, cachedTokens: 700,
      avgTokensPerItem: (2000 + 3000) / 2, avgRunsPerItem: 2, avgReturnsPerItem: 0.5, avgStopsPerItem: 0.5, firstPassRate: 0.5,
    });
    expect(report.totals.agentMs).toBe(2.5 * H + 2 * H + 2 * H); // a1 runs, b7 run, a2 running for 2 h
    expect(report.totals.avgLeadMs).toBe((10 + 6) / 2 * H);
    expect(report.totals.avgAgentMs).toBe((2.5 + 2) / 2 * H);
    expect(report.totals.avgChecksWaitMs).toBe(0.5 / 2 * H);
    expect(report.totals.avgWaitingForYouMs).toBe(2 / 2 * H);
    // a1: 10 - 2.5 - 0.5 - 2 = 5 h queued; b7: 6 - 2 = 4 h.
    expect(report.totals.avgQueuedMs).toBe(4.5 * H);
    expect(report.importedWithoutHistory).toBe(1);
    expect(report.byRepository.map((row) => [row.id, row.delivered, row.inProgress])).toEqual([["alpha", 1, 1], ["beta", 1, 0]]);
    expect(report.items).toEqual([]);
  });

  test("months bucket deliveries by finish and usage by run start; stages follow the pipeline order and names", async () => {
    const store = await world();
    const report = buildReport({ store, config, period: "all", repository: null, now: NOW });
    expect(report.byMonth).toEqual([
      { month: "2026-09", delivered: 1, runs: 1, tokens: 3000, agentMs: 2 * H, avgTokensPerItem: 3000, avgLeadMs: 6 * H },
      { month: "2026-10", delivered: 1, runs: 4, tokens: 2000, agentMs: 4.5 * H, avgTokensPerItem: 2000, avgLeadMs: 10 * H },
    ]);
    expect(report.byStage.map((stage) => [stage.id, stage.name, stage.runs, stage.failedRuns, stage.tokens])).toEqual([
      ["implementation", "Implementation", 4, 1, 4800],
      ["review", "Code review", 1, 0, 200],
    ]);
  });

  test("a period keeps only what happened in it", async () => {
    const store = await world();
    const report = buildReport({ store, config, period: "30d", repository: null, now: NOW });
    expect(report.since).toBe(reportSince("30d", NOW));
    expect(report.totals).toMatchObject({ delivered: 1, runs: 4, inputTokens: 1900 });
    expect(report.byMonth.map((row) => row.month)).toEqual(["2026-10"]);
    expect(reportSince("all", NOW)).toBeNull();
  });

  test("drilling into a repository lists its active items, in progress first, with their figures", async () => {
    const store = await world();
    const report = buildReport({ store, config, period: "all", repository: "alpha", now: NOW });
    expect(report.totals.delivered).toBe(1);
    expect(report.byStage.map((stage) => stage.id)).toEqual(["implementation", "review"]);
    expect(report.items).toEqual([
      { repository: "alpha", number: 2, title: "Item 2", state: "active", finishedAt: null, leadMs: null, agentMs: 2 * H, checksWaitMs: 0, waitingForYouMs: 0, runs: 1, tokens: 0, returns: 0, stops: 0 },
      { repository: "alpha", number: 1, title: "Item 1", state: "done", finishedAt: "2026-10-10T10:00:00.000Z", leadMs: 10 * H, agentMs: 2.5 * H, checksWaitMs: 0.5 * H, waitingForYouMs: 2 * H, runs: 3, tokens: 2000, returns: 1, stops: 1 },
    ]);
    expect(report.importedWithoutHistory).toBe(1);
  });

  test("a stop that never resumed counts until now while the item is in progress", async () => {
    const store = await world();
    store.sqlite().query("INSERT INTO stage_transitions(id, issue_id, from_stage, to_stage, status, created_at, completed_at, kind) VALUES ('s1', 'a2', 'implementation', 'implementation', 'completed', ?, ?, 'stopped')")
      .run("2026-10-19T23:00:00.000Z", "2026-10-19T23:00:00.000Z");
    const report = buildReport({ store, config, period: "all", repository: "alpha", now: NOW });
    expect(report.items[0]).toMatchObject({ number: 2, waitingForYouMs: H, stops: 1 });
  });
});
