import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";
import { GitHubTransportError, type GitHubWebhookStatus } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  setSystemTime();
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const FALLBACK = { default: 15 * 60_000, ci: 5 * 60_000, change: 10 * 60_000, dependencies: 30 * 60_000 };

interface Delivery { id: number; guid: string; deliveredAt: string; statusCode: number; redelivery: boolean }

async function service(options: { webhooks?: boolean; status?: () => GitHubWebhookStatus | null; deliveries?: () => Delivery[]; issues?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-health-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: {
      artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor",
      events: { retentionMs: null, sinks: [], fallbackMs: FALLBACK, reconcileIntervalMs: 30 * 60_000, fullReconcileIntervalMs: 24 * 60 * 60_000 },
    },
    web: options.webhooks === false ? {} : { publicUrl: "https://conveyor.example.com" },
    sources: { github: { type: "github", webhookPath: "/hooks/github", webhookSecret: "secret", autoConfigureWebhook: options.webhooks !== false } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { orderTemplate: "conveyor:order:{number}" } },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "work", concurrency: 1 }] } }, agents: {},
    repositories: { app: { source: "github", address: "owner/app", folder: root, baseBranch: "main", pipeline: "default" } },
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const calls = { redelivered: [] as number[], listings: 0, deliveryListings: 0, since: [] as Array<string | undefined>, visibility: 0, subIssues: 0, hookChecks: 0, permissions: 0 };
  const issue = { id: "1", number: 1, url: "https://example.com/1", title: "Open", body: "", state: "open" as const, labels: ["conveyor"], updatedAt: "2026-10-17T00:00:00Z" };
  const github = {
    async listHookDeliveries() { calls.deliveryListings += 1; return options.deliveries?.() ?? []; },
    async redeliverHookDelivery(_address: string, _hook: number, id: number) { calls.redelivered.push(id); },
    async listIssues(_address: string, listing: { since?: string } = {}) { calls.listings += 1; calls.since.push(listing.since); return options.issues ? [issue] : []; },
    async listSubIssues() { calls.subIssues += 1; return []; },
    async getIssueProvenance() {
      calls.permissions += 1;
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async upsertStatusComment() { return 1; },
    async listDependencies() { return []; },
    async repositoryVisibility() { calls.visibility += 1; return "private" as const; },
    async webhookStatus() {
      calls.hookChecks += 1;
      return options.status ? options.status() : { id: 1, active: true, lastResponseCode: null };
    },
  };
  const conveyor = new ConveyorService(config, store, github as never);
  conveyor.drain("tests: nothing executes");
  const deliver = async () => {
    const body = new TextEncoder().encode(JSON.stringify({ zen: "x", repository: { full_name: "owner/app" } }));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    await conveyor.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": `d-${Math.random()}`, "x-github-event": "ping" }));
    await conveyor.webhooksSettled();
  };
  return { conveyor, store, deliver, calls };
}

describe("webhook health", () => {
  test("an active hook that has not delivered yet is healthy", async () => {
    const { conveyor, store } = await service();
    expect(await conveyor.checkWebhookHealth("app")).toBe(true);
    store.close();
  });

  test("an active hook whose last delivery succeeded is healthy", async () => {
    const { conveyor, store } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 200 }) });
    expect(await conveyor.checkWebhookHealth("app")).toBe(true);
    store.close();
  });

  test("a hook whose last delivery failed is unhealthy", async () => {
    const { conveyor, store } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 502 }) });
    expect(await conveyor.checkWebhookHealth("app")).toBe(false);
    store.close();
  });

  test("an inactive hook is unhealthy", async () => {
    const { conveyor, store } = await service({ status: () => ({ id: 1, active: false, lastResponseCode: 200 }) });
    expect(await conveyor.checkWebhookHealth("app")).toBe(false);
    store.close();
  });

  test("a missing hook is unhealthy", async () => {
    const { conveyor, store } = await service({ status: () => null });
    expect(await conveyor.checkWebhookHealth("app")).toBe(false);
    store.close();
  });

  test("a hook that cannot be read is unhealthy", async () => {
    const { conveyor, store } = await service({ status: () => { throw new Error("forbidden"); } });
    expect(await conveyor.checkWebhookHealth("app")).toBe(false);
    store.close();
  });

  test("a repository without managed webhooks polls", async () => {
    const { conveyor, store } = await service({ webhooks: false });
    expect(await conveyor.checkWebhookHealth("app")).toBe(false);
    expect(conveyor.waitFallbackMs("app", "ci")).toBeNull();
    store.close();
  });

  test("a delivery shows the webhook works, whatever the last check said", async () => {
    const { conveyor, store, deliver } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 502 }) });
    await conveyor.checkWebhookHealth("app");
    await deliver();
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    store.close();
  });

  test("health changes are recorded as events", async () => {
    let code: number | null = null;
    const { conveyor, store } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: code }) });
    await conveyor.checkWebhookHealth("app");
    code = 500;
    await conveyor.checkWebhookHealth("app");
    await conveyor.checkWebhookHealth("app");
    expect(store.events().read({ type: "webhook.healthChanged" }).map((event) => event.payload)).toEqual([{ healthy: true }, { healthy: false }]);
    store.close();
  });

  test("while healthy, an event wait sleeps until its kind's fallback", async () => {
    const { conveyor, store } = await service();
    await conveyor.checkWebhookHealth("app");
    expect([conveyor.waitFallbackMs("app", "ci"), conveyor.waitFallbackMs("app", "dependencies")]).toEqual([5 * 60_000, 30 * 60_000]);
    store.close();
  });

  test("while unhealthy, an event wait polls", async () => {
    const { conveyor, store } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 500 }) });
    await conveyor.checkWebhookHealth("app");
    expect(conveyor.waitFallbackMs("app", "ci")).toBeNull();
    store.close();
  });
});

describe("missed deliveries", () => {
  const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  test("a recent delivery that failed and was never received is redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: 11, guid: "g-1", deliveredAt: recent(5), statusCode: 502, redelivery: false }] });
    await conveyor.checkWebhookHealth("app");
    expect(await conveyor.redeliverMissed("app")).toBe(1);
    expect(calls.redelivered).toEqual([11]);
    store.close();
  });

  test("a delivery that one attempt delivered is not redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [
      { id: 12, guid: "g-1", deliveredAt: recent(4), statusCode: 200, redelivery: true },
      { id: 11, guid: "g-1", deliveredAt: recent(5), statusCode: 502, redelivery: false },
    ] });
    await conveyor.checkWebhookHealth("app");
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("a delivery Conveyor stored is not redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: 11, guid: "g-1", deliveredAt: recent(5), statusCode: 504, redelivery: false }] });
    store.recordSourceEvent({ source: "github", deliveryId: "g-1", eventType: "issues", payload: {} });
    await conveyor.checkWebhookHealth("app");
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("a delivery older than a day is left alone", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: 11, guid: "g-1", deliveredAt: recent(25 * 60), statusCode: 502, redelivery: false }] });
    await conveyor.checkWebhookHealth("app");
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("at most fifty are redelivered in one pass", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, guid: `g-${index}`, deliveredAt: recent(5), statusCode: 502, redelivery: false }));
    const { conveyor, store, calls } = await service({ deliveries: () => many });
    await conveyor.checkWebhookHealth("app");
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toHaveLength(50);
    store.close();
  });

  test("without the permission to list deliveries, it warns once and stops asking", async () => {
    const records: LogRecord[] = [];
    const { conveyor, store, calls } = await service({ deliveries: () => { throw new GitHubTransportError("GitHub API GET failed", 1, "gh: Not Found (HTTP 404)"); } });
    log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
    await conveyor.checkWebhookHealth("app");
    await conveyor.redeliverMissed("app");
    await conveyor.redeliverMissed("app");
    expect({ listings: calls.deliveryListings, warnings: records.filter((record) => record.message.startsWith("Cannot list webhook deliveries")).length }).toEqual({ listings: 1, warnings: 1 });
    store.close();
  });
});

describe("the safety-net reconcile", () => {
  test("a repository with healthy webhooks is read at most every events.reconcileInterval", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll({ skipFresh: true });
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.listings).toBe(1);
    store.close();
  });

  test("a repository with unhealthy webhooks is read on every tick", async () => {
    const { conveyor, store, calls } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 500 }) });
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll({ skipFresh: true });
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.listings).toBe(2);
    store.close();
  });

  test("a full pass (startup) always reads every repository", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll({ skipFresh: true });
    await conveyor.reconcileAll();
    expect(calls.listings).toBe(2);
    store.close();
  });

  test("while healthy, a tick after events.reconcileInterval is a light pass: only changed issues, no visibility read", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls } = await service();
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    setSystemTime(new Date("2026-10-17T10:31:00Z"));
    await conveyor.reconcileAll({ skipFresh: true });
    // The listing overlaps the previous read by a margin for GitHub's clock.
    expect(calls.since).toEqual([undefined, "2026-10-17T09:58:00.000Z"]);
    expect(calls.visibility).toBe(1);
    store.close();
  });

  test("while healthy, a tick after events.fullReconcileInterval is a full pass", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls } = await service();
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    setSystemTime(new Date("2026-10-18T10:00:00Z"));
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.since).toEqual([undefined, undefined]);
    expect(calls.visibility).toBe(2);
    store.close();
  });

  test("while unhealthy, every tick is a full pass", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls } = await service({ status: () => ({ id: 1, active: true, lastResponseCode: 500 }) });
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    setSystemTime(new Date("2026-10-17T10:31:00Z"));
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.since).toEqual([undefined, undefined]);
    store.close();
  });
});

describe("repository sync", () => {
  const superuser = { kind: "user" as const, id: "admin-1", name: "admin", role: "superuser" as const };

  test("reads every issue again, even right after a full pass", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.since).toEqual([undefined, undefined]);
    expect(calls.visibility).toBe(2);
    store.close();
  });

  test("reads relationships again instead of reusing the cache", async () => {
    const { conveyor, store, calls } = await service({ issues: true });
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    expect(calls.subIssues).toBe(1);
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.subIssues).toBe(2);
    store.close();
  });

  test("re-checks an enrolled item's provenance and author permissions", async () => {
    const { conveyor, store, calls } = await service({ issues: true });
    await conveyor.checkWebhookHealth("app");
    await conveyor.reconcileAll();
    expect(calls.permissions).toBe(1);
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.permissions).toBe(2);
    store.close();
  });

  test("checks the webhook again", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.hookChecks).toBe(1);
    store.close();
  });

  test("reports whether GitHub could be read", async () => {
    const { conveyor, store } = await service();
    expect((await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser)).result).toEqual({ issues: 0, failed: false });
    store.close();
  });

  test("two syncs at once read GitHub once", async () => {
    const { conveyor, store, calls } = await service();
    await Promise.all([
      conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser),
      conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser),
    ]);
    expect(calls.listings).toBe(1);
    store.close();
  });

  test("an unknown repository is refused", async () => {
    const { conveyor, store } = await service();
    await expect(conveyor.commands.dispatch("repository.sync", { repositoryId: "missing" }, superuser)).rejects.toThrow(/unknown repository/);
    store.close();
  });

  test("a user who is not a superuser may not sync", async () => {
    const { conveyor, store, calls } = await service();
    await expect(conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, { ...superuser, role: "user" })).rejects.toThrow();
    expect(calls.listings).toBe(0);
    store.close();
  });
});
