import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { EventBus } from "../../src/events/bus";
import { withEventContext } from "../../src/events/context";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function open() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-events-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  return { store, file: path.join(root, "conveyor.sqlite") };
}

const issue = (number: number) => ({
  id: `issue-${number}`, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.com/${number}`, title: "T", body: "",
  sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-10-17T00:00:00Z",
});

describe("EventLog", () => {
  test("appends with the item's repository, the current actor and correlation id", async () => {
    const { store } = await open();
    withEventContext({ actor: { kind: "user", id: "account-1" }, correlationId: "c-1" }, () => store.upsertIssue(issue(1)));
    expect(store.events().read({ type: "item.discovered" })).toEqual([expect.objectContaining({
      type: "item.discovered", repositoryId: "repo", issueId: "issue-1", actor: { kind: "user", id: "account-1" }, correlationId: "c-1", payload: { number: 1 },
    })]);
    store.close();
  });

  test("an event outside any context is Conveyor's own", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    expect(store.events().read({ type: "item.discovered" })[0]).toMatchObject({ actor: { kind: "system", id: null }, correlationId: null });
    store.close();
  });

  test("rejects a payload that does not match its event's schema", async () => {
    const { store } = await open();
    // @ts-expect-error the payload is deliberately wrong
    expect(() => store.events().append("item.discovered", { number: "one" })).toThrow();
    store.close();
  });

  test("an event appended in a rolled-back transaction is neither stored nor published", async () => {
    const { store } = await open();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("*", "test", (event) => { seen.push(event.type); });
    store.events().attach(bus);
    const before = store.events().latestSeq();
    expect(() => store.sqlite().transaction(() => {
      store.upsertIssue(issue(1));
      throw new Error("roll back");
    })()).toThrow("roll back");
    await store.events().settled();
    expect(store.events().latestSeq()).toBe(before);
    expect(seen).toEqual([]);
    store.close();
  });

  test("publishes committed events once each, in order, after their transaction", async () => {
    const { store } = await open();
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe("*", "test", (event) => { seen.push(event.seq); });
    store.events().attach(bus);
    store.upsertIssue(issue(1));
    store.upsertIssue(issue(2));
    store.setIssueProjection("issue-1", { stage: "work", state: "active", warning: null });
    expect(seen).toEqual([]);
    await store.events().settled();
    expect(seen).toEqual(store.events().read().map((event) => event.seq).filter((seq) => seq > seen[0]! - 1));
    expect(new Set(seen).size).toBe(seen.length);
    store.close();
  });

  test("events a subscriber appends are published after the event that caused them", async () => {
    const { store } = await open();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("item.discovered", "enroll", (event) => { store.activateEnrollment(event.issueId!); });
    bus.subscribe("*", "record", (event) => { seen.push(event.type); });
    store.events().attach(bus);
    store.upsertIssue(issue(1));
    await store.events().settled();
    expect(seen.indexOf("item.discovered")).toBeLessThan(seen.indexOf("item.enrolled"));
    store.close();
  });

  test("attaching starts from the current end: earlier events are not replayed", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("*", "test", (event) => { seen.push(event.type); });
    store.events().attach(bus);
    store.upsertIssue(issue(2));
    await store.events().settled();
    expect(seen).toEqual(["item.discovered"]);
    store.close();
  });

  test("reads by issue", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    store.upsertIssue(issue(2));
    expect(store.events().read({ issueId: "issue-2" }).map((event) => event.issueId)).toEqual(["issue-2"]);
    store.close();
  });

  test("reads by type prefix", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    store.activateEnrollment("issue-1");
    expect(new Set(store.events().read({ type: "item." }).map((event) => event.type))).toEqual(new Set(["item.discovered", "item.fenced", "item.enrolled"]));
    store.close();
  });

  test("reads by correlation id", async () => {
    const { store } = await open();
    withEventContext({ actor: { kind: "user", id: "a" }, correlationId: "one" }, () => store.upsertIssue(issue(1)));
    withEventContext({ actor: { kind: "user", id: "a" }, correlationId: "two" }, () => store.upsertIssue(issue(2)));
    expect(store.events().read({ correlationId: "two" }).map((event) => event.issueId)).toEqual(["issue-2"]);
    store.close();
  });

  test("reads after a sequence number", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    const after = store.events().latestSeq();
    store.upsertIssue(issue(2));
    expect(store.events().read({ afterSeq: after }).map((event) => event.issueId)).toEqual(["issue-2"]);
    store.close();
  });

  test("prunes events older than a time", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    expect(store.events().prune(new Date(Date.now() + 1_000).toISOString())).toBeGreaterThan(0);
    expect(store.events().read()).toEqual([]);
    store.close();
  });

  test("an event's item trail outlives the item", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    store.removeRepositoriesExcept([]);
    expect(store.events().read({ issueId: "issue-1" }).map((event) => event.type)).toEqual(["item.discovered"]);
    store.close();
  });

  test("a durable consumer's cursor survives reopening the database and never moves back", async () => {
    const { store, file } = await open();
    expect(store.events().consumerCursor("sink")).toBeNull();
    store.events().advanceConsumer("sink", 7);
    store.events().advanceConsumer("sink", 3);
    store.close();
    const reopened = await ConveyorStore.open(file);
    expect(reopened.events().consumerCursor("sink")).toBe(7);
    reopened.close();
  });
});

describe("event classes, sources and causes", () => {
  test("an item change is a fact from the core", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    expect(store.events().read({ type: "item.discovered" })[0]).toMatchObject({ class: "fact", source: "core", causationSeq: null });
    store.close();
  });

  test("a webhook observation is an ingest event from the plugin that received it", async () => {
    const { store } = await open();
    store.recordSourceEvent({
      source: "github", deliveryId: "d-1", eventType: "ping", payload: {}, repositoryId: "repo",
      normalized: { type: "github.ping", payload: { repository: "owner/my-app" } },
    });
    expect(store.events().read({ type: "github.ping" })[0]).toMatchObject({ class: "ingest", source: "github" });
    expect(store.events().read({ type: "webhook.received" })[0]).toMatchObject({ class: "ingest", source: "github" });
    store.close();
  });

  test("an event a subscriber records names the event it reacted to as its cause", async () => {
    const { store } = await open();
    const bus = new EventBus();
    store.events().attach(bus);
    bus.subscribe("item.discovered", "react", (event) => {
      if (event.issueId === "issue-1") store.upsertIssue(issue(2));
    });
    store.upsertIssue(issue(1));
    await store.events().settled();
    const [first] = store.events().read({ type: "item.discovered", issueId: "issue-1" });
    const [second] = store.events().read({ type: "item.discovered", issueId: "issue-2" });
    expect(second?.causationSeq).toBe(first!.seq);
    store.close();
  });

  test("work a subscriber starts asynchronously keeps the cause", async () => {
    const { store } = await open();
    const bus = new EventBus();
    store.events().attach(bus);
    let later: Promise<void> = Promise.resolve();
    bus.subscribe("item.discovered", "react later", (event) => {
      if (event.issueId === "issue-1") later = Bun.sleep(1).then(() => store.upsertIssue(issue(2)));
    });
    store.upsertIssue(issue(1));
    await store.events().settled();
    await later;
    const [first] = store.events().read({ type: "item.discovered", issueId: "issue-1" });
    expect(store.events().read({ type: "item.discovered", issueId: "issue-2" })[0]?.causationSeq).toBe(first!.seq);
    store.close();
  });

  test("causedBy returns the whole chain of reactions, not unrelated events", async () => {
    const { store } = await open();
    const bus = new EventBus();
    store.events().attach(bus);
    bus.subscribe("item.discovered", "chain", (event) => {
      if (event.issueId === "issue-1") store.upsertIssue(issue(2));
      if (event.issueId === "issue-2") store.upsertIssue(issue(3));
    });
    store.upsertIssue(issue(1));
    await store.events().settled();
    store.upsertIssue(issue(9));
    await store.events().settled();
    const root = store.events().read({ type: "item.discovered", issueId: "issue-1" })[0]!;
    const chain = store.events().read({ causedBy: root.seq, type: "item.discovered" }).map((event) => event.issueId);
    expect(chain).toEqual(["issue-2", "issue-3"]);
    store.close();
  });

  test("classes selects events by class", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    store.events().trace("timer.fired", { timer: "reconcile" });
    expect(store.events().read({ classes: ["trace"] }).map((event) => event.type)).toEqual(["timer.fired"]);
    expect(store.events().read({ classes: ["fact"] }).map((event) => event.type)).not.toContain("timer.fired");
    store.close();
  });

  test("trace refuses an event type that is not a trace", async () => {
    const { store } = await open();
    expect(() => store.events().trace("admission.paused", {})).toThrow("admission.paused is not a trace event");
    store.close();
  });

  test("prune removes traces older than their own cutoff and keeps newer facts", async () => {
    const { store } = await open();
    store.upsertIssue(issue(1));
    store.events().trace("timer.fired", { timer: "wake" });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(store.events().prune("", future)).toBe(1);
    const types = store.events().read().map((event) => event.type);
    expect(types).toContain("item.discovered");
    expect(types).not.toContain("timer.fired");
    store.close();
  });
});
