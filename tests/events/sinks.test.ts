import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { EventBus } from "../../src/events/bus";
import type { StoredEvent } from "../../src/events/catalogue";
import { JsonlEventSink, SinkRunner, type EventSink } from "../../src/events/sinks";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-sinks-"));
  directories.push(root);
  const file = path.join(root, "conveyor.sqlite");
  const store = await ConveyorStore.open(file);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  const bus = new EventBus();
  store.events().attach(bus);
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
  let number = 0;
  /** Records one item.discovered event. */
  const change = () => {
    number += 1;
    store.upsertIssue({ id: `issue-${number}`, repositoryId: "repo", sourceNumber: number, sourceUrl: "https://example.com", title: "T", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-17T00:00:00Z" });
  };
  return { root, file, store, bus, change, records };
}

class Collecting implements EventSink {
  readonly name = "collecting";
  readonly received: number[] = [];
  failures = 0;
  async deliver(events: readonly StoredEvent[]): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("analyzer unavailable");
    }
    this.received.push(...events.map((event) => event.seq));
  }
}

describe("SinkRunner", () => {
  test("a new sink receives what the log holds, then every new event, in order", async () => {
    const { store, bus, change } = await world();
    change();
    const sink = new Collecting();
    const runner = new SinkRunner(store.events(), sink);
    runner.start(bus);
    await runner.idle();
    change();
    change();
    await store.events().settled();
    await runner.idle();
    expect(sink.received).toEqual(store.events().read().map((event) => event.seq));
    await runner.stop();
    store.close();
  });

  test("the cursor moves only after a delivery succeeded", async () => {
    const { store, bus, change } = await world();
    change();
    const sink = new Collecting();
    sink.failures = 1;
    const runner = new SinkRunner(store.events(), sink, { backoffMs: 5 });
    runner.start(bus);
    await runner.idle();
    expect(store.events().consumerCursor("collecting")).toBeNull();
    await Bun.sleep(30);
    await runner.idle();
    expect(store.events().consumerCursor("collecting")).toBe(store.events().latestSeq());
    await runner.stop();
    store.close();
  });

  test("a failing sink is retried with backoff and never blocks recording", async () => {
    const { store, bus, change, records } = await world();
    const sink = new Collecting();
    sink.failures = 2;
    const runner = new SinkRunner(store.events(), sink, { backoffMs: 5 });
    runner.start(bus);
    change();
    await store.events().settled();
    expect(store.events().latestSeq()).toBeGreaterThan(0);
    await Bun.sleep(60);
    await runner.idle();
    expect(sink.received).toEqual(store.events().read().map((event) => event.seq));
    expect(records.filter((record) => record.message === "Event sink delivery failed; retrying").map((record) => record.retryInMs)).toEqual([5, 10]);
    await runner.stop();
    store.close();
  });

  test("a sink resumes after a restart without gaps or repeats", async () => {
    const { store, bus, change, file } = await world();
    change();
    const first = new Collecting();
    const runner = new SinkRunner(store.events(), first);
    runner.start(bus);
    await runner.idle();
    await runner.stop();
    change();
    change();
    store.close();
    const reopened = await ConveyorStore.open(file);
    const second = new Collecting();
    const again = new SinkRunner(reopened.events(), second);
    again.start(new EventBus());
    await again.idle();
    expect([...first.received, ...second.received]).toEqual(reopened.events().read().map((event) => event.seq));
    await again.stop();
    reopened.close();
  });

  test("a sink behind pruned events warns how many it missed and continues", async () => {
    const { store, bus, change, records } = await world();
    change();
    const sink = new Collecting();
    store.events().advanceConsumer("collecting", 0);
    change();
    change();
    const oldest = store.events().oldestSeq()!;
    store.sqlite().query("DELETE FROM events WHERE seq < ?").run(oldest + 2);
    const runner = new SinkRunner(store.events(), sink);
    runner.start(bus);
    await runner.idle();
    expect(records.find((record) => record.message === "Event sink missed events that retention already removed")).toMatchObject({ missed: oldest + 1 });
    expect(sink.received).toEqual(store.events().read().map((event) => event.seq));
    await runner.stop();
    store.close();
  });
});

describe("JsonlEventSink", () => {
  test("appends one JSON line per event", async () => {
    const { root, store, change } = await world();
    change();
    change();
    const target = path.join(root, "events", "conveyor.jsonl");
    const sink = new JsonlEventSink(target, { maxBytes: 1_000_000, keepFiles: 2 });
    await sink.deliver(store.events().read());
    const lines = (await readFile(target, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as StoredEvent);
    expect(lines.map((event) => event.type)).toEqual(store.events().read().map((event) => event.type));
    store.close();
  });

  test("rotates the file by size", async () => {
    const { root, store, change } = await world();
    change();
    const target = path.join(root, "conveyor.jsonl");
    const sink = new JsonlEventSink(target, { maxBytes: 10, keepFiles: 1 });
    await sink.deliver(store.events().read());
    await sink.deliver(store.events().read());
    expect((await readFile(`${target}.1`, "utf8")).trim().split("\n")).toHaveLength(store.events().read().length);
    store.close();
  });
});
