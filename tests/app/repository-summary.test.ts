import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRepositorySummaries } from "../../src/app/repository-summary";
import { buildReport } from "../../src/app/reports";
import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { renderDashboard } from "../support/render-dashboard";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const NOW = new Date("2026-10-20T00:00:00.000Z");
const config = {
  web: { publicUrl: "https://conveyor.example.test" },
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
  issue("closed", "alpha", 18, "closed", "implementation");
  issue("missing", "alpha", 19, "missing", "review");
  issue("paused", "alpha", 20, "paused", null);
  for (let number = 4; number <= 14; number += 1) {
    const id = `done-${number}`;
    issue(id, "alpha", number, "done", "review");
    const at = `2026-10-${String(number).padStart(2, "0")}T12:00:00.000Z`;
    delivery(`delivery-${number}`, id, at);
    run(`run-${number}`, id, "succeeded", at, number === 14 ? 100 : 0, number === 14 ? 50 : 0);
  }
  issue("imported", "alpha", 15, "done", "review");
  issue("imported-child", "alpha", 21, "done", "review");
  delivery("delivery-imported-child", "imported-child", "2026-10-15T12:00:00.000Z");
  store.replaceRelationships("imported-child", { parentId: "imported", siblingOrder: 1 }, []);
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
      addressUrl: "https://github.com/owner/alpha",
      error: "Webhook setup failed\nwith a detailed explanation\nLatest reconciliation failed",
      errorSummary: "Webhook setup failed with a detailed explanation Latest reconciliation failed",
      lastReconciledAt: "2026-10-20T00:00:00.000Z",
      backlog: 1, done: 13,
      stages: [
        { id: "implementation", name: "Implementation", count: 2 },
        { id: "review", name: "Code review", count: 2 },
      ],
      capacity: { busy: 1, slots: 2 },
      setup: {
        pipeline: "delivery", baseBranch: "trunk", itemProvider: "github", itemSync: "webhook",
        ciProvider: "github-actions", ciMode: "required", systemLabels: ["conveyor", "managed"],
      },
      report30d: { delivered: 12, inputTokens: 100, outputTokens: 50, agentMs: 3_600_000 },
    });
    expect(alpha.setup).toMatchObject({ webhooks: "unhealthy", githubCalls: { total: 0, bySource: [] } });
    const withCalls = buildRepositorySummaries({
      store, config, now: NOW,
      webhookHealth: new Map([["alpha", true]]),
      githubCalls: { total: 5, bySource: { tick: 3, webhook: 2 }, byRepository: { "owner/alpha": { webhook: 2, tick: 3 } }, byRoute: {} },
    }).repositories[0]!;
    expect(withCalls.setup).toMatchObject({ webhooks: "healthy", githubCalls: { total: 5, bySource: [{ source: "tick", count: 3 }, { source: "webhook", count: 2 }] } });
    expect(alpha.items).toEqual([
      { number: 1, title: "Item 1", stage: "implementation", state: "Running" },
      { number: 2, title: "Item 2", stage: "review", state: "Needs you" },
      { number: 3, title: "Item 3", stage: "review", state: "Waiting" },
      { number: 16, title: "Item 16", stage: null, state: "Blocked" },
      { number: 17, title: "Item 17", stage: "implementation", state: "Queued" },
    ]);
    expect(alpha.items.map((item) => item.number)).not.toContain(18);
    expect(alpha.items.map((item) => item.number)).not.toContain(19);
    expect(alpha.items.map((item) => item.number)).not.toContain(20);
    expect(alpha.deliveries).toHaveLength(10);
    expect(alpha.deliveries[0]).toMatchObject({ number: 21, deliveredAt: "2026-10-15T12:00:00.000Z" });
    expect(alpha.deliveries.some((delivery) => delivery.number === 15)).toBeFalse();
    expect(summaries.repositories[1]).toMatchObject({ health: "healthy", backlog: 0, done: 0, items: [], deliveries: [], color: 2 });
  });

  test("counts only active runs that consume a repository slot", async () => {
    const store = await world();
    const summary = (task: string) => buildRepositorySummaries({
      store,
      config: {
        ...config,
        pipelines: { delivery: { stages: [{ id: "implementation", actions: [{ task }] }] } },
      } as unknown as ConveyorConfig,
      now: NOW,
    }).repositories.find((repository) => repository.id === "alpha");

    expect(summary("ci.await")?.capacity).toEqual({ busy: 0, slots: 2 });
    expect(summary("agent.run")?.capacity).toEqual({ busy: 1, slots: 2 });
  });

  test("counts a completed roll-up parent without a delivery as all-time completed", async () => {
    const store = await world();
    const alpha = buildRepositorySummaries({ store, config, now: NOW }).repositories[0]!;

    expect(store.listChildren("imported")).toEqual([{ issueId: "imported-child", siblingOrder: 1 }]);
    expect(alpha.done).toBe(alpha.report30d.delivered + 1);
    expect(alpha.deliveries.some((delivery) => delivery.number === 15)).toBeFalse();
  });

  test("keeps restricted setup facts and secrets out of the ordinary summary without provider calls or store changes", async () => {
    const store = await world();
    const revision = store.dashboardRevision();
    const originalFetch = globalThis.fetch;
    const originalSpawn = Bun.spawn;
    globalThis.fetch = (() => { throw new Error("provider calls are forbidden"); }) as unknown as typeof fetch;
    Bun.spawn = (() => { throw new Error("provider calls are forbidden"); }) as typeof Bun.spawn;
    let result;
    try {
      result = buildRepositorySummaries({ store, config, now: NOW });
    } finally {
      globalThis.fetch = originalFetch;
      Bun.spawn = originalSpawn;
    }
    const report = buildReport({ store, config, period: "30d", repository: null, now: NOW });
    const reportBefore = report.byRepository.find((repository) => repository.id === "alpha");

    expect(store.dashboardRevision()).toBe(revision);
    expect(result!.repositories[0]!.report30d).toEqual({
      delivered: reportBefore!.delivered,
      inputTokens: reportBefore!.inputTokens,
      outputTokens: reportBefore!.outputTokens,
      agentMs: reportBefore!.agentMs,
    });
    expect(JSON.stringify(result!.repositories)).not.toContain("never-public");
    expect(JSON.stringify(result!.repositories)).not.toContain("/work/alpha");
    expect(JSON.stringify(result!.repositories)).not.toContain("api.example.test");
    expect(JSON.stringify(result!.restrictedRepositories)).not.toContain("never-public");
    expect(result!.restrictedRepositories).toEqual([
      { id: "alpha", folder: "/work/alpha", agentEgressHosts: ["api.example.test"] },
      { id: "empty", folder: "/work/empty", agentEgressHosts: [] },
    ]);
  });

  test("renders every repository dashboard view from stored summaries without source access", async () => {
    const store = await world();
    const serviceConfig = {
      ...config,
      hash: "test-config",
      root: tmpdir(),
      settings: { workspaces: tmpdir(), runners: 1 },
      runners: {},
      agents: {},
      sources: { github: { ...config.sources.github, webhookSecret: "sentinel-webhook-secret" } },
      pipelines: {
        delivery: {
          stages: [
            { id: "implementation", run: { type: "agent", agent: "worker" } },
            { id: "review", name: "Code review", run: { type: "agent", agent: "worker" } },
          ],
        },
      },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: {},
        metadata: { closable: "conveyor:closable" },
      },
    } as unknown as ConveyorConfig;
    const provider = new Proxy({}, { get: () => { throw new Error("provider access is forbidden"); } }) as never;
    const service = new ConveyorService(serviceConfig, store, provider);
    store.pauseRepository("alpha", "operator", "CI budget");

    const board = service.dashboard("csrf", { view: "board", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null });
    const list = service.dashboard("csrf", { view: "repositories", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null });
    const detail = service.dashboard("csrf", { view: "repository", repositoryId: "alpha", column: null, page: 1, doneLimit: 20, runId: null, issueId: null });

    const reader = { id: "reader", username: "reader", role: "user" as const, avatar: "🦊" };
    const superuser = { id: "admin", username: "admin", role: "superuser" as const, avatar: "🦊" };
    const boardHtml = renderDashboard({ ...board, account: reader });
    const readerList = renderDashboard({ ...list, account: reader });
    const superuserList = renderDashboard({ ...list, account: superuser });
    const readerDetail = renderDashboard({ ...detail, account: reader });
    const superuserDetail = renderDashboard({ ...detail, account: superuser });

    expect(board.repositories.find((repository) => repository.id === "alpha")?.pause).toMatchObject({ actor: "operator", reason: "CI budget" });
    expect(board.stages.flatMap((stage) => stage.issues).find((card) => card.id === "running")).toMatchObject({ repositoryPaused: true, working: true });
    expect(boardHtml).toContain('href="/repositories"');
    expect(boardHtml).toContain("Repository paused");
    expect(readerList).toContain("owner/alpha");
    expect(superuserList).toContain("owner/alpha");
    expect(readerDetail).toContain("Recently delivered");
    expect(readerDetail).toContain("Paused");
    expect(readerDetail).toContain("CI budget");
    expect(superuserDetail).toContain("/work/alpha");
    expect(readerDetail).not.toContain("/repositories/alpha/pause");
    expect(superuserDetail).toContain("/repositories/alpha/resume");
    expect(readerDetail).not.toContain("/work/alpha");
    for (const html of [readerList, superuserList, readerDetail, superuserDetail]) {
      expect(html).not.toContain("sentinel-webhook-secret");
    }

    store.setIssueProjection("running", { state: "needs-input", stage: "implementation", warning: null });
    const updated = service.dashboard("csrf", { view: "board", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null });
    expect(updated.revision).not.toBe(board.revision);

    const storedRevision = store.dashboardRevision();
    await service.reconcileAll();
    const degraded = service.dashboard("csrf", { view: "board", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null });
    expect(store.dashboardRevision()).toBe(storedRevision);
    expect(degraded.revision).not.toBe(updated.revision);
    // The live dashboard learns of the failing repository from its event, and of every pass.
    const health = () => store.events().read({ type: "repository.healthChanged" }).map((event): unknown[] => [event.repositoryId, event.payload]);
    expect(health()).toContainEqual(["alpha", { check: "reconcile", healthy: false }]);
    expect(degraded.repositories.find((repository) => repository.id === "alpha")?.health).toBe("degraded");
    const passes = store.events().read({ type: "service.reconciled" }).length;
    await service.reconcileAll();
    expect(store.events().read({ type: "service.reconciled" })).toHaveLength(passes + 1);
    // Failing again is not a new health change.
    expect(health().filter(([repository]) => repository === "alpha")).toHaveLength(1);
    expect(degraded.systemWarnings).toEqual([]);
    // The board no longer lists repositories, but a repository that cannot sync is called out there.
    const degradedBoard = renderDashboard(degraded);
    expect(degradedBoard).toContain('class="repository-warnings"');
    expect(degradedBoard).toContain("provider access is forbidden");
    expect(degradedBoard).toContain('href="/repositories/alpha"');
    expect(boardHtml).not.toContain('class="repository-warnings"');
    const degradedHtml = renderDashboard(service.dashboard("csrf", { view: "repositories", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null }));
    expect(degradedHtml).toContain("provider access is forbidden");
    expect(degradedHtml).not.toContain("System attention");
  });

  test("reports sync mode from the configured item provider", async () => {
    const store = await world();
    const pollingSource = {
      ...config,
      sources: { github: { ...config.sources.github, autoConfigureWebhook: false } },
    } as ConveyorConfig;

    expect(buildRepositorySummaries({ store, config: pollingSource, now: NOW }).repositories[0]!.setup.itemSync).toBe("polling");
    expect(buildRepositorySummaries({ store, config, now: NOW }).repositories[0]!.setup.itemSync).toBe("webhook");
  });
});
