import { describe, expect, test } from "bun:test";

import { LiveStore, type LiveEventSource, type LiveState } from "../../../src/web/app/store";
import type { DashboardModel } from "../../../src/web/model";

function model(title = "Item 1"): DashboardModel {
  return {
    items: { i1: { id: "i1", title, number: 1 } as never },
    stages: {}, questions: {}, repositories: {}, restrictedRepositories: {},
    graph: { nodes: [], relationships: [] },
    system: { title: "Conveyor" } as never,
  };
}

class FakeStream implements LiveEventSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void { this.closed = true; }
  send(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function setup(responses: Array<{ status: number; body?: unknown }>) {
  const clock = { now: 1_000 };
  const requests: string[] = [];
  const streams: FakeStream[] = [];
  let signedOut = 0;
  const store = new LiveStore({
    fetch: async (input) => {
      requests.push(input);
      const next = responses.shift() ?? { status: 500 };
      return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
    },
    openStream: (url) => {
      const stream = new FakeStream(url);
      streams.push(stream);
      return stream;
    },
    onSignedOut: () => { signedOut += 1; },
    now: () => clock.now,
  });
  const states: LiveState[] = [];
  store.subscribe((state) => states.push(state));
  return { store, requests, streams, states, clock, signedOut: () => signedOut };
}

const snapshot = (seq: number, title = "Item 1") => ({
  status: 200,
  body: { seq, model: model(title), status: null, account: { id: "a", username: "owner", role: "user", avatar: "🦊" }, csrfToken: "token" },
});

describe("LiveStore", () => {
  test("loads the snapshot once and follows the stream from its sequence", async () => {
    const { store, requests, streams } = setup([snapshot(7)]);
    await store.start();
    expect(requests).toEqual(["/api/v1/snapshot"]);
    expect(streams[0]?.url).toBe("/api/v1/stream?after=7");
    expect(store.state?.model.items.i1).toMatchObject({ title: "Item 1" });
  });

  test("applies a patch without asking the server for anything", async () => {
    const { store, requests, streams } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.send("patch", { seq: 8, entity: "item", id: "i1", op: "upsert", data: { title: "Renamed" } });
    expect(store.state?.model.items.i1).toMatchObject({ title: "Renamed", number: 1 });
    expect(store.state?.seq).toBe(8);
    expect(requests).toHaveLength(1);
  });

  test("ignores a patch the model already includes", async () => {
    const { store, streams } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.send("patch", { seq: 7, entity: "item", id: "i1", op: "upsert", data: { title: "Stale" } });
    expect(store.state?.model.items.i1).toMatchObject({ title: "Item 1" });
  });

  test("removes an item a patch removes", async () => {
    const { store, streams } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.send("patch", { seq: 9, entity: "item", id: "i1", op: "remove" });
    expect(store.state?.model.items).toEqual({});
  });

  test("reloads the snapshot when the stream says patches were missed", async () => {
    const { store, requests, streams } = setup([snapshot(7), snapshot(40, "Fresh")]);
    await store.start();
    streams[0]!.send("reset", {});
    await Bun.sleep(0);
    expect(requests).toEqual(["/api/v1/snapshot", "/api/v1/snapshot"]);
    expect(store.state).toMatchObject({ seq: 40, model: { items: { i1: { title: "Fresh" } } } });
  });

  test("shows the connection as it opens and drops", async () => {
    const { store, streams } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.onopen?.(new Event("open"));
    expect(store.state?.connection).toBe("live");
    streams[0]!.onerror?.(new Event("error"));
    expect(store.state?.connection).toBe("offline");
  });

  test("keeps the latest server status", async () => {
    const { store, streams } = setup([snapshot(7)]);
    await store.start();
    const status = { memory: { usedBytes: 1, totalBytes: 2, processBytes: 1 }, disk: { available: true }, storage: { artifacts: { available: true }, temporaryDirectory: { available: true }, workspaceScratch: { available: true } }, uptimeSeconds: 5 };
    streams[0]!.send("status", status);
    expect(store.state?.status).toEqual(status);
  });

  test("sends the reader to sign in when the session is gone", async () => {
    const { store, streams, signedOut } = setup([{ status: 401 }]);
    await store.start();
    expect(signedOut()).toBe(1);
    expect(streams).toHaveLength(0);
  });

  test("keeps a stream that is still sending heartbeats", async () => {
    const { store, streams, clock } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.onopen?.(new Event("open"));
    clock.now += 10_000;
    streams[0]!.send("keep-alive", {});
    clock.now += 10_000;
    store.check();
    expect(streams).toHaveLength(1);
    expect(streams[0]!.closed).toBe(false);
  });

  test("reopens a silent stream from the last patch it applied", async () => {
    const { store, requests, streams, clock } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.onopen?.(new Event("open"));
    streams[0]!.send("patch", { seq: 9, entity: "item", id: "i1", op: "upsert", data: { title: "Renamed" } });
    clock.now += 13_000;
    store.check();
    expect(streams[0]!.closed).toBe(true);
    expect(streams[1]?.url).toBe("/api/v1/stream?after=9");
    expect(requests).toEqual(["/api/v1/snapshot"]);
  });

  test("reopens a stream the browser closed", async () => {
    const { store, streams } = setup([snapshot(7)]);
    await store.start();
    streams[0]!.readyState = 2;
    store.check();
    expect(streams).toHaveLength(2);
  });

  test("waits longer after each failed restart", async () => {
    const { store, requests, streams } = setup([snapshot(7), { status: 500 }, { status: 500 }, snapshot(8)]);
    await store.start();
    streams[0]!.readyState = 2;
    streams[0]!.onerror?.(new Event("error"));
    await Bun.sleep(0);
    expect(requests).toHaveLength(2);
    // A pending retry is not doubled by a check.
    store.check();
    expect(streams).toHaveLength(1);
    await Bun.sleep(1_100);
    expect(requests).toHaveLength(3);
    await Bun.sleep(1_100);
    expect(requests).toHaveLength(3);
    await Bun.sleep(1_000);
    expect(requests).toHaveLength(4);
    expect(streams[1]?.url).toBe("/api/v1/stream?after=8");
  }, 10_000);
});
