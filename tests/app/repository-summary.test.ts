import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRepositorySummaries } from "../../src/app/repository-summary";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const NOW = new Date("2026-10-20T00:00:00.000Z");
const config = {
  sources: { github: { type: "github", autoConfigureWebhook: true, webhookSecret: "never-public" } },
  ci: { checks: { type: "github-actions" } },
  pipelines: { delivery: { stages: [{ id: "implementation" }, { id: "review", name: "Code review" }] } },
  repositories: {
    alpha: {
      source: "github", address: "owner/alpha", folder: "/work/alpha", baseBranch: "trunk", pipeline: "delivery",
      ci: { provider: "checks", mode: "required" }, concurrency: 2, systemLabels: ["conveyor", "managed"],
      agentEgress: { httpsHosts: ["api.example.test"] },
    },
    empty: {
      source: "github", address: "owner/empty", folder: "/work/empty", baseBranch: "main", pipeline: "delivery",
      ci: { provider: null, mode: "disabled" }, concurrency: 1, systemLabels: [],
    },
  },
} as unknown as ConveyorConfig;

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-repository-summary-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  const db = store.sqlite();
  for (const id of ["alpha", "empty", "unconfigured"]) {
    store.upsertRepository({ id, configName: id, source: "github", address: `owner/${id}`, folder: `/work/${id}`, configHash: "h" });
  }
  const issue = (id: string, repositoryId: string, number: number, state: string, stage: string | null) => {
    store.upsertIssue({
      id, repositoryId, sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: `Item ${number}`,
      body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    });
    store.setIssueProjection(id, { state, stage, warning: null });
  };
  const run = (id: string, issueId: string, status: string, startedAt: string, input = 0, output = 0) => {
    db.query("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, finished_at) VALUES (?, ?, 'implementation', 1, 'producer', ?, 'h', ?, ?)")
      .run(id, issueId, status, startedAt, status === "running" ? null : startedAt);
    db.query("INSERT INTO usage_cost_entries(id, run_id, input_tokens, output_tokens, cached_tokens, source, duration_ms, created_at) VALUES (?, ?, ?, ?, 0, 'unavailable', 0, ?)")
      .run(`usage-${id}`, id, input, output, startedAt);
  };
  const delivery = (id: string, issueId: string, at: string) => {
    db.query("INSERT INTO stage_transitions(id, issue_id, from_stage, to_stage, status, created_at, completed_at, kind) VALUES (?, ?, 'review', 'review', 'completed', ?, ?, 'advance')")
      .run(id, issueId, at, at);
  };

  issue("running", "alpha", 1, "active", "implementation");
  run("running-run", "running", "running", "2026-10-19T23:00:00.000Z");
  issue("needs-you", "alpha", 2, "needs-input", "review");
  issue("waiting", "alpha", 3, "active", "review");
  db.query("INSERT INTO stage_cursors(issue_id, stage, stage_epoch, attempt, returns, list, task_instance_id, state, feedback_json, pending_since, wake_at, deadline_at, updated_at) VALUES ('waiting', 'review', 1, 1, 0, 'exit-gate', NULL, 'pending', NULL, ?, NULL, NULL, ?)")
    .run("2026-10-19T20:00:00.000Z", "2026-10-19T20:00:00.000Z");
  issue("blocked", "alpha", 16, "blocked", null);
  issue("queued", "alpha", 17, "active", "implementation");
  for (let number = 4; number <= 14; number += 1) {
    const id = `done-${number}`;
    issue(id, "alpha", number, "done", "review");
    const at = `2026-10-${String(number).padStart(2, "0")}T12:00:00.000Z`;
    delivery(`delivery-${number}`, id, at);
    run(`run-${number}`, id, "succeeded", at, number === 14 ? 100 : 0, number === 14 ? 50 : 0);
  }
  issue("imported", "alpha", 15, "done", "review");
  issue("unconfigured", "unconfigured", 99, "done", "review");
  delivery("unconfigured-delivery", "unconfigured", "2026-10-19T12:00:00.000Z");
  return store;
}

describe("buildRepositorySummaries", () => {
  test("summarizes configured repositories from store facts in pipeline order", async () => {
    const store = await world();
    const summaries = buildRepositorySummaries({
      store, config, now: NOW, lastReconciledAt: "2026-10-20T00:00:00.000Z",
      onboardingErrors: new Map([["alpha", "Webhook setup failed\nwith a detailed explanation"]]),
      reconciliationErrors: new Map([["alpha", "Latest reconciliation failed"]]),
    });

    expect(summaries.repositories.map((repository) => repository.id)).toEqual(["alpha", "empty"]);
    const alpha = summaries.repositories[0]!;
    expect(alpha).toMatchObject({
      address: "owner/alpha", color: 1, health: "degraded",
      error: "Webhook setup failed\nwith a detailed explanation\nLatest reconciliation failed",
      errorSummary: "Webhook setup failed with a detailed explanation Latest reconciliation failed",
      lastReconciledAt: "2026-10-20T00:00:00.000Z",
      backlog: 1, done: 12,
      stages: [
        { id: "implementation", name: "Implementation", count: 2 },
        { id: "review", name: "Code review", count: 2 },
      ],
      capacity: { busy: 1, slots: 2 },
      setup: {
        pipeline: "delivery", baseBranch: "trunk", itemProvider: "github", itemSync: "webhook",
        ciProvider: "github-actions", ciMode: "required", systemLabels: ["conveyor", "managed"],
      },
      report30d: { delivered: 11, inputTokens: 100, outputTokens: 50, agentMs: 3_600_000 },
    });
    expect(alpha.items).toEqual([
      { number: 1, title: "Item 1", stage: "implementation", state: "Running" },
      { number: 2, title: "Item 2", stage: "review", state: "Needs you" },
      { number: 3, title: "Item 3", stage: "review", state: "Waiting" },
      { number: 16, title: "Item 16", stage: null, state: "Blocked" },
      { number: 17, title: "Item 17", stage: "implementation", state: "Queued" },
    ]);
    expect(alpha.deliveries).toHaveLength(10);
    expect(alpha.deliveries[0]).toMatchObject({ number: 14, deliveredAt: "2026-10-14T12:00:00.000Z" });
    expect(alpha.deliveries.some((delivery) => delivery.number === 15)).toBeFalse();
    expect(summaries.repositories[1]).toMatchObject({ health: "healthy", backlog: 0, done: 0, items: [], deliveries: [], color: 2 });
  });

  test("keeps restricted setup facts and secrets out of the ordinary summary and makes no store change", async () => {
    const store = await world();
    const revision = store.dashboardRevision();
    const reportBefore = buildRepositorySummaries({ store, config, now: NOW }).repositories[0]!.report30d;
    const result = buildRepositorySummaries({ store, config, now: NOW });

    expect(store.dashboardRevision()).toBe(revision);
    expect(result.repositories[0]!.report30d).toEqual(reportBefore);
    expect(JSON.stringify(result.repositories)).not.toContain("never-public");
    expect(JSON.stringify(result.repositories)).not.toContain("/work/alpha");
    expect(JSON.stringify(result.repositories)).not.toContain("api.example.test");
    expect(JSON.stringify(result.restrictedRepositories)).not.toContain("never-public");
    expect(result.restrictedRepositories).toEqual([
      { id: "alpha", folder: "/work/alpha", agentEgressHosts: ["api.example.test"] },
      { id: "empty", folder: "/work/empty", agentEgressHosts: [] },
    ]);
  });
});
