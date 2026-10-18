import { afterEach, describe, expect, test } from "bun:test";

import { EventBus } from "../../src/events/bus";
import type { StoredEvent } from "../../src/events/catalogue";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";

afterEach(() => log.configure({ sinks: [new ConsoleSink()] }));

describe("EventBus", () => {
  const event = (type: StoredEvent["type"]): StoredEvent => ({
    seq: 1, type, occurredAt: "2026-10-17T00:00:00Z", repositoryId: null, issueId: null, actor: { kind: "system", id: null }, correlationId: null,
    payload: {} as StoredEvent["payload"],
  });

  test("runs the subscribers of an event in registration order, awaiting each", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe("item.offboarded", "first", async () => { await Bun.sleep(5); order.push("first"); });
    bus.subscribe("*", "second", () => { order.push("second"); });
    bus.subscribe("item.enrolled", "other", () => { order.push("other"); });
    await bus.dispatch(event("item.offboarded"));
    expect(order).toEqual(["first", "second"]);
  });

  test("runs later synchronous subscribers before queued work from an earlier one", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe("item.offboarded", "first", () => {
      order.push("first");
      queueMicrotask(() => { order.push("queued"); });
    });
    bus.subscribe("item.offboarded", "second", () => { order.push("second"); });

    await bus.dispatch(event("item.offboarded"));

    expect(order).toEqual(["first", "second", "queued"]);
  });

  test("a failing subscriber is logged and the later ones still run", async () => {
    const records: LogRecord[] = [];
    log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe("*", "broken", () => { throw new Error("boom"); });
    bus.subscribe("*", "after", () => { order.push("after"); });
    await bus.dispatch(event("item.offboarded"));
    expect(order).toEqual(["after"]);
    expect(records).toEqual([expect.objectContaining({ level: "warn", message: "Event subscriber failed", subscriber: "broken", event: "item.offboarded" })]);
  });

  test("an unsubscribed handler no longer runs", async () => {
    const bus = new EventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe("*", "once", () => { calls += 1; });
    unsubscribe();
    await bus.dispatch(event("item.offboarded"));
    expect(calls).toBe(0);
  });
});
