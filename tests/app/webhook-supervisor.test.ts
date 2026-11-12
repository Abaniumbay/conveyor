import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebhookSupervisor, type WebhookSupervisorConfig } from "../../src/app/webhook-supervisor";
import type { WebhookSettings } from "../../src/core/plugins";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import type { HookDeliveryAttempt } from "../../src/source/client";

const directories: string[] = [];
const stores: ConveyorStore[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const MINUTE = 60_000;

async function supervisor(options: {
  settings?: Partial<WebhookSettings>;
  publicUrl?: string | null;
  deliveries?: () => HookDeliveryAttempt[];
  listingFails?: Error;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-supervisor-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  stores.push(store);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const config: WebhookSupervisorConfig = {
    repositories: { app: { source: "github", address: "owner/app" } },
    sources: { github: { type: "github" } },
    web: options.publicUrl === null ? {} : { publicUrl: options.publicUrl ?? "https://conveyor.example.com" },
  };
  const settings: WebhookSettings = { path: "/hooks/github", secret: "secret", managed: true, ...options.settings };
  const calls = { registered: [] as Array<{ address: string; url: string; secret: string }>, pings: [] as number[], listings: 0, redelivered: [] as string[], timers: 0 };
  const webhooks = new WebhookSupervisor({
    config,
    plugins: { itemSource: (type) => type === "github" ? { webhook: { receive: () => ({ kind: "ignored" }), settings: () => settings } } : null },
    store,
    source: {
      async listHookDeliveries() {
        calls.listings += 1;
        if (options.listingFails) throw options.listingFails;
        return options.deliveries?.() ?? [];
      },
    },
    fencedSource: () => ({
      async ensureWebhook(input) { calls.registered.push(input); return 7; },
      async pingHook(_address, hookId) { calls.pings.push(hookId); },
      async redeliverHookDelivery(_address, _hookId, deliveryId) { calls.redelivered.push(deliveryId); },
    }),
    timerFired: () => { calls.timers += 1; },
  });
  const health = () => store.events().read({ type: "webhook.healthChanged" }).map((event) => event.payload);
  return { webhooks, store, calls, health };
}

describe("webhook supervisor", () => {
  test("a managed webhook delivers to the source's path under the public URL", async () => {
    const { webhooks } = await supervisor();
    expect(webhooks.url("app")).toBe("https://conveyor.example.com/hooks/github");
    expect(webhooks.url("unknown")).toBeNull();
  });

  test("an unmanaged webhook has no URL", async () => {
    const { webhooks } = await supervisor({ settings: { managed: false } });
    expect(webhooks.url("app")).toBeNull();
  });

  test("without a public URL no webhook is managed", async () => {
    const { webhooks } = await supervisor({ publicUrl: null });
    expect(webhooks.url("app")).toBeNull();
  });

  test("registering a managed webhook needs its secret", async () => {
    const { webhooks, calls } = await supervisor({ settings: { secret: "" } });
    await expect(webhooks.register("app")).rejects.toThrow("a webhook secret is required for webhooks: set webhookSecret on the items provider github");
    expect(calls.registered).toEqual([]);
  });

  test("an unregistered webhook is neither pinged nor asked for deliveries", async () => {
    const { webhooks, calls } = await supervisor();
    expect(await webhooks.ping("app")).toBe(false);
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(calls.pings).toEqual([]);
    expect(calls.listings).toBe(0);
  });

  test("a quiet repository is pinged, and a ping that does not arrive marks it unhealthy once", async () => {
    const { webhooks, calls, health } = await supervisor();
    await webhooks.register("app");
    expect(calls.registered).toEqual([{ address: "owner/app", url: "https://conveyor.example.com/hooks/github", secret: "secret" }]);
    expect(webhooks.healthy("app")).toBe(true);

    await webhooks.supervise(Date.now() + 60 * MINUTE);
    expect(calls.pings).toEqual([7]);

    await webhooks.supervise(Date.now() + 6 * MINUTE);
    await webhooks.supervise(Date.now() + 7 * MINUTE);
    expect(webhooks.healthy("app")).toBe(false);
    expect(webhooks.health.get("app")).toBe(false);
    expect(health()).toEqual([{ healthy: false }]);
  });

  test("a delivery after an outage marks it healthy and redelivers only the missed recent deliveries", async () => {
    const recent = new Date(Date.now() - 10 * MINUTE).toISOString();
    const old = new Date(Date.now() - 2 * 24 * 60 * MINUTE).toISOString();
    const { webhooks, store, calls, health } = await supervisor({
      deliveries: () => [
        { id: "1", guid: "missed", deliveredAt: recent, statusCode: 502, redelivery: false },
        { id: "2", guid: "retried", deliveredAt: recent, statusCode: 502, redelivery: false },
        { id: "3", guid: "retried", deliveredAt: recent, statusCode: 200, redelivery: true },
        { id: "4", guid: "too-old", deliveredAt: old, statusCode: 502, redelivery: false },
        { id: "5", guid: "stored", deliveredAt: recent, statusCode: 502, redelivery: false },
      ],
    });
    store.recordSourceEvent({ source: "github", deliveryId: "stored", eventType: "issues", payload: {} });
    await webhooks.register("app");
    await webhooks.supervise(Date.now() + 60 * MINUTE);
    await webhooks.supervise(Date.now() + 6 * MINUTE);
    expect(webhooks.healthy("app")).toBe(false);

    webhooks.delivered("app");
    expect(webhooks.healthy("app")).toBe(true);
    expect(health()).toEqual([{ healthy: false }, { healthy: true }]);
    while (calls.redelivered.length === 0) await Bun.sleep(1);
    expect(calls.redelivered).toEqual(["1"]);
    expect(await webhooks.redeliverMissed("app")).toBe(1);
  });

  test("a delivery to a healthy webhook asks for nothing", async () => {
    const { webhooks, calls, health } = await supervisor();
    await webhooks.register("app");
    webhooks.delivered("app");
    expect(calls.listings).toBe(0);
    expect(health()).toEqual([{ healthy: true }]);
  });

  test("without permission to list deliveries it stops asking", async () => {
    const denied = Object.assign(new Error("Resource not accessible by integration"), { accessDenied: true });
    const { webhooks, calls } = await supervisor({ listingFails: denied });
    await webhooks.register("app");
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(calls.listings).toBe(1);
  });

  test("a failed listing is tried again next time", async () => {
    const { webhooks, calls } = await supervisor({ listingFails: new Error("GitHub is unavailable") });
    await webhooks.register("app");
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(calls.listings).toBe(2);
  });

  test("a paused repository is neither pinged nor asked for deliveries", async () => {
    const { webhooks, store, calls } = await supervisor();
    await webhooks.register("app");
    store.pauseRepository("app", "owner", null);
    expect(await webhooks.ping("app")).toBe(false);
    expect(await webhooks.redeliverMissed("app")).toBe(0);
    expect(calls.pings).toEqual([]);
    expect(calls.listings).toBe(0);
  });

  test("starting asks for missed deliveries and then pings each managed webhook", async () => {
    const { webhooks, calls } = await supervisor();
    await webhooks.register("app");
    webhooks.start();
    webhooks.stop();
    while (calls.pings.length === 0) await Bun.sleep(1);
    expect(calls.listings).toBe(1);
    expect(calls.pings).toEqual([7]);
  });
});
