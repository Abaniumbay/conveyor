import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";
import { GitHubTransportError } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  setSystemTime();
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const FALLBACK = { default: 15 * 60_000, ci: 5 * 60_000, change: 10 * 60_000, dependencies: 30 * 60_000 };
const MINUTE = 60_000;

interface Delivery { id: string; guid: string; deliveredAt: string; statusCode: number; redelivery: boolean }

/** One repository, onboarded: Conveyor knows its webhook's id unless `webhooks` is false. */
async function service(options: { webhooks?: boolean; deliveries?: () => Delivery[]; issues?: boolean; pingFails?: boolean; storedIssueChangedAt?: string; noRepositories?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-health-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: {
      artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor",
      events: { retentionMs: null, sinks: [], fallbackMs: FALLBACK },
    },
    web: options.webhooks === false ? {} : { publicUrl: "https://conveyor.example.com" },
    sources: { github: { type: "github", webhookPath: "/hooks/github", webhookSecret: "secret", autoConfigureWebhook: options.webhooks !== false } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { orderTemplate: "conveyor:order:{number}" } },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "work", concurrency: 1 }] } }, agents: {},
    repositories: options.noRepositories ? {} : { app: { source: "github", address: "owner/app", folder: root, baseBranch: "main", pipeline: "default", systemLabels: [] } },
  } as unknown as ConveyorConfig;
  const calls = { redelivered: [] as string[], listings: 0, deliveryListings: 0, since: [] as Array<string | undefined>, visibility: 0, subIssues: 0, pings: 0, permissions: 0 };
  const issue = { id: "github:owner/app#1", number: 1, url: "https://example.com/1", title: "Open", body: "", state: "open" as const, labels: ["conveyor"], updatedAt: options.storedIssueChangedAt ?? "2026-10-17T00:00:00Z" };
  const github = {
    async listHookDeliveries() { calls.deliveryListings += 1; return options.deliveries?.() ?? []; },
    async redeliverHookDelivery(_address: string, _hook: number, id: string) { calls.redelivered.push(id); },
    async listIssues(_address: string, listing: { since?: string } = {}) { calls.listings += 1; calls.since.push(listing.since); return options.issues ? [issue] : []; },
    async listSubIssues() { calls.subIssues += 1; return []; },
    async getIssueProvenance() {
      calls.permissions += 1;
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async upsertStatusComment() { return 1; },
    async ensureLabels() {},
    async ensureWebhook() { return 7; },
    async pingHook() {
      if (options.pingFails) throw new GitHubTransportError("GitHub API POST skipped: GitHub rate limit", 1, "");
      calls.pings += 1;
    },
    async listDependencies() { return []; },
    async repositoryVisibility() { calls.visibility += 1; return "private" as const; },
  };
  if (options.storedIssueChangedAt) {
    // State from before a restart.
    store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
    store.upsertIssue({ id: "github:owner/app#1", repositoryId: "app", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "Open", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: options.storedIssueChangedAt });
  }
  const conveyor = new ConveyorService(config, store, github as never);
  conveyor.drain("tests: nothing executes");
  await conveyor.onboardRepositories();
  calls.visibility = 0;
  const deliver = async () => {
    const body = new TextEncoder().encode(JSON.stringify({ zen: "x", repository: { full_name: "owner/app" } }));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    await conveyor.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": `d-${Math.random()}`, "x-github-event": "ping" }));
    await conveyor.webhooksSettled();
  };
  const health = () => store.events().read({ type: "webhook.healthChanged" }).map((event) => event.payload);
  return { conveyor, store, deliver, calls, health };
}

describe("webhook health", () => {
  test("a repository counts as healthy until a ping goes undelivered", async () => {
    const { conveyor, store } = await service();
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    store.close();
  });

  test("a repository quiet for an hour gets one ping", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls, deliver } = await service();
    await deliver();
    setSystemTime(new Date("2026-10-17T10:59:00Z"));
    await conveyor.superviseWebhooks();
    expect(calls.pings).toBe(0);
    setSystemTime(new Date("2026-10-17T11:00:00Z"));
    await conveyor.superviseWebhooks();
    await conveyor.superviseWebhooks();
    expect(calls.pings).toBe(1);
    store.close();
  });

  test("a ping that arrives keeps it healthy", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, deliver, health } = await service();
    await conveyor.pingWebhook("app");
    setSystemTime(new Date("2026-10-17T10:00:05Z"));
    await deliver();
    setSystemTime(new Date("2026-10-17T10:10:00Z"));
    await conveyor.superviseWebhooks();
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    expect(health()).not.toContainEqual({ healthy: false });
    store.close();
  });

  test("a ping that does not arrive marks the repository unhealthy, as an event", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, health } = await service();
    await conveyor.pingWebhook("app");
    setSystemTime(new Date("2026-10-17T10:04:00Z"));
    await conveyor.superviseWebhooks();
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    setSystemTime(new Date("2026-10-17T10:05:00Z"));
    await conveyor.superviseWebhooks();
    expect(conveyor.webhooksHealthy("app")).toBe(false);
    expect(health()).toEqual([{ healthy: false }]);
    store.close();
  });

  test("an unhealthy repository keeps its waits' deadlines and is not read periodically", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls } = await service();
    await conveyor.pingWebhook("app");
    setSystemTime(new Date("2026-10-17T10:06:00Z"));
    await conveyor.superviseWebhooks();
    expect(conveyor.webhooksHealthy("app")).toBe(false);
    expect([conveyor.waitFallbackMs("app", "ci"), conveyor.waitFallbackMs("app", "dependencies")]).toEqual([5 * MINUTE, 30 * MINUTE]);
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.listings).toBe(0);
    store.close();
  });

  test("a ping request GitHub refuses changes nothing", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, health } = await service({ pingFails: true });
    expect(await conveyor.pingWebhook("app")).toBe(false);
    setSystemTime(new Date("2026-10-17T10:30:00Z"));
    await conveyor.superviseWebhooks();
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    expect(health()).toEqual([]);
    store.close();
  });

  test("a delivery after an outage marks it healthy and asks for what was missed", async () => {
    setSystemTime(new Date("2026-10-17T10:00:00Z"));
    const { conveyor, store, calls, deliver, health } = await service();
    await conveyor.pingWebhook("app");
    setSystemTime(new Date("2026-10-17T10:06:00Z"));
    await conveyor.superviseWebhooks();
    await deliver();
    for (let attempt = 0; attempt < 100 && calls.deliveryListings === 0; attempt += 1) await Bun.sleep(5);
    expect(conveyor.webhooksHealthy("app")).toBe(true);
    expect(health()).toEqual([{ healthy: false }, { healthy: true }]);
    expect(calls.deliveryListings).toBe(1);
    store.close();
  });

  test("a repository without a managed webhook polls", async () => {
    const { conveyor, store } = await service({ webhooks: false });
    expect(conveyor.waitFallbackMs("app", "ci")).toBeNull();
    expect(await conveyor.pingWebhook("app")).toBe(false);
    store.close();
  });

  test("with a managed webhook, an event wait sleeps until its kind's deadline", async () => {
    const { conveyor, store } = await service();
    expect([conveyor.waitFallbackMs("app", "ci"), conveyor.waitFallbackMs("app", "dependencies")]).toEqual([5 * MINUTE, 30 * MINUTE]);
    store.close();
  });
});

describe("missed deliveries", () => {
  const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  test("onboarding, before the server listens, neither asks for them nor pings", async () => {
    const { store, calls } = await service({ deliveries: () => [{ id: "11", guid: "g-1", deliveredAt: recent(1), statusCode: 502, redelivery: false }] });
    expect({ redelivered: calls.redelivered, pings: calls.pings }).toEqual({ redelivered: [], pings: 0 });
    store.close();
  });

  test("starting, once the server listens, asks for the deliveries missed while it was down, then pings", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: "11", guid: "g-1", deliveredAt: recent(1), statusCode: 502, redelivery: false }] });
    conveyor.start();
    for (let attempt = 0; attempt < 100 && calls.pings === 0; attempt += 1) await Bun.sleep(10);
    expect({ redelivered: calls.redelivered, pings: calls.pings }).toEqual({ redelivered: ["11"], pings: 1 });
    await conveyor.close();
    store.close();
  });

  test("a recent delivery that failed and was never received is redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: "11", guid: "g-1", deliveredAt: recent(5), statusCode: 502, redelivery: false }] });
    expect(await conveyor.redeliverMissed("app")).toBe(1);
    expect(calls.redelivered).toEqual(["11"]);
    store.close();
  });

  test("a delivery that one attempt delivered is not redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [
      { id: "12", guid: "g-1", deliveredAt: recent(4), statusCode: 200, redelivery: true },
      { id: "11", guid: "g-1", deliveredAt: recent(5), statusCode: 502, redelivery: false },
    ] });
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("a delivery Conveyor stored is not redelivered", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: "11", guid: "g-1", deliveredAt: recent(5), statusCode: 504, redelivery: false }] });
    store.recordSourceEvent({ source: "github", deliveryId: "g-1", eventType: "issues", payload: {} });
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("a delivery older than a day is left alone", async () => {
    const { conveyor, store, calls } = await service({ deliveries: () => [{ id: "11", guid: "g-1", deliveredAt: recent(25 * 60), statusCode: 502, redelivery: false }] });
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toEqual([]);
    store.close();
  });

  test("at most fifty are redelivered in one pass", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ id: String(index + 1), guid: `g-${index}`, deliveredAt: recent(5), statusCode: 502, redelivery: false }));
    const { conveyor, store, calls } = await service({ deliveries: () => many });
    await conveyor.redeliverMissed("app");
    expect(calls.redelivered).toHaveLength(50);
    store.close();
  });

  test("without the permission to list deliveries, it warns once and stops asking", async () => {
    const records: LogRecord[] = [];
    const { conveyor, store, calls } = await service({ deliveries: () => { throw new GitHubTransportError("GitHub API GET failed", 1, "gh: Not Found (HTTP 404)"); } });
    log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
    await conveyor.redeliverMissed("app");
    await conveyor.redeliverMissed("app");
    expect({ listings: calls.deliveryListings, warnings: records.filter((record) => record.message.startsWith("Cannot list webhook deliveries")).length }).toEqual({ listings: 1, warnings: 1 });
    store.close();
  });
});

describe("reading repositories", () => {
  test("startup makes the service ready, even with no repository to read", async () => {
    const { conveyor, store } = await service({ noRepositories: true });
    expect(conveyor.isReady()).toBe(false);
    await conveyor.reconcileAll();
    expect(conveyor.isReady()).toBe(true);
    store.close();
  });

  test("the periodic tick does not read a repository with a managed webhook", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.reconcileAll({ skipFresh: true });
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.listings).toBe(0);
    store.close();
  });

  test("the periodic tick reads a polling repository in full every time", async () => {
    const { conveyor, store, calls } = await service({ webhooks: false });
    await conveyor.reconcileAll({ skipFresh: true });
    await conveyor.reconcileAll({ skipFresh: true });
    expect(calls.since).toEqual([undefined, undefined]);
    store.close();
  });

  test("startup reads only the issues changed since the newest change Conveyor stored", async () => {
    const { conveyor, store, calls } = await service({ storedIssueChangedAt: "2026-10-17T09:00:00Z" });
    await conveyor.reconcileAll();
    // The listing overlaps the stored change by a margin for GitHub's clock.
    expect(calls.since).toEqual(["2026-10-17T08:58:00.000Z"]);
    store.close();
  });

  test("startup reads relationships only for issues GitHub reports changed", async () => {
    // The listing overlaps the last read, so it returns the stored issue although it did not change.
    const { conveyor, store, calls } = await service({ issues: true, storedIssueChangedAt: "2026-10-17T09:00:00Z" });
    await conveyor.reconcileAll();
    expect({ listings: calls.listings, subIssues: calls.subIssues }).toEqual({ listings: 1, subIssues: 0 });
    store.close();
  });

  test("startup with nothing stored lists every issue once, and reads no visibility again", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.reconcileAll();
    expect({ since: calls.since, visibility: calls.visibility }).toEqual({ since: [undefined], visibility: 0 });
    store.close();
  });
});

describe("repository sync", () => {
  const superuser = { kind: "user" as const, id: "admin-1", name: "admin", role: "superuser" as const };

  test("reads every issue again, and the repository's visibility", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.reconcileAll();
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect({ since: calls.since, visibility: calls.visibility }).toEqual({ since: [undefined, undefined], visibility: 1 });
    store.close();
  });

  test("reads relationships again instead of reusing the cache", async () => {
    const { conveyor, store, calls } = await service({ issues: true });
    await conveyor.reconcileAll();
    expect(calls.subIssues).toBe(1);
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.subIssues).toBe(2);
    store.close();
  });

  test("re-checks an enrolled item's provenance and author permissions", async () => {
    const { conveyor, store, calls } = await service({ issues: true });
    await conveyor.reconcileAll();
    expect(calls.permissions).toBe(1);
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.permissions).toBe(2);
    store.close();
  });

  test("pings the webhook", async () => {
    const { conveyor, store, calls } = await service();
    await conveyor.commands.dispatch("repository.sync", { repositoryId: "app" }, superuser);
    expect(calls.pings).toBe(1);
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
