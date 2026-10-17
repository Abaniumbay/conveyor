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
    expect(new Set(store.events().read({ type: "item." }).map((event) => event.type))).toEqual(new Set(["item.discovered", "item.enrolled"]));
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
