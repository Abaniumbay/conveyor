import { afterEach, describe, expect, test } from "bun:test";
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
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const FALLBACK = { default: 15 * 60_000, ci: 5 * 60_000, change: 10 * 60_000, dependencies: 30 * 60_000 };

interface Delivery { id: number; guid: string; deliveredAt: string; statusCode: number; redelivery: boolean }

async function service(options: { webhooks?: boolean; status?: () => GitHubWebhookStatus | null; deliveries?: () => Delivery[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-health-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: {
      artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor",
      events: { retentionMs: null, sinks: [], fallbackMs: FALLBACK, reconcileIntervalMs: 30 * 60_000 },
    },
    web: options.webhooks === false ? {} : { publicUrl: "https://conveyor.example.com" },
    sources: { github: { type: "github", webhookPath: "/hooks/github", webhookSecret: "secret", autoConfigureWebhook: options.webhooks !== false } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: {} },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "work", concurrency: 1 }] } }, agents: {},
    repositories: { app: { source: "github", address: "owner/app", folder: root, baseBranch: "main", pipeline: "default" } },
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const calls = { redelivered: [] as number[], listings: 0, deliveryListings: 0 };
  const github = {
    async listHookDeliveries() { calls.deliveryListings += 1; return options.deliveries?.() ?? []; },
    async redeliverHookDelivery(_address: string, _hook: number, id: number) { calls.redelivered.push(id); },
    async listIssues() { calls.listings += 1; return []; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async repositoryVisibility() { return "private" as const; },
    async webhookStatus() {
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
});
