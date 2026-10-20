import { describe, expect, test } from "bun:test";

import { changesDashboard, DashboardFeed, type DashboardFeedMessage } from "../../src/app/dashboard-feed";
import type { DashboardItem, DashboardModel } from "../../src/web/model";
import type { SystemStatusViewModel } from "../../src/web/types";

function item(number: number, title = `Item ${number}`): DashboardItem {
  return {
    id: `item-${number}`, repository: "repo", repositoryPaused: false, repositoryColor: 1, number, title, url: null,
    state: "active", labels: [], issueType: null, issueFields: [], acceptanceCriteria: [], todos: null, indicators: [],
    activity: null, reason: null, cost: null, duration: null, stateChangedAt: null, waiting: null, blocked: false,
    inconsistent: false, closable: false, noSplit: false, tone: "active", parent: null, children: [], dependencies: [],
    working: false, needsAttention: false, retryable: false, resumableRollup: false, stoppedRollup: false,
    placement: "backlog", column: null, order: number, needsYou: false, conversation: null,
  };
}

function model(items: DashboardItem[]): DashboardModel {
  return {
    items: Object.fromEntries(items.map((entry) => [entry.id, entry])),
    stages: {},
    questions: {},
    repositories: {},
    restrictedRepositories: {},
    graph: { nodes: [], relationships: [] },
    system: {
      title: "Conveyor", updatedAt: "2026-10-20T00:00:00Z", project: "", totalUsage: "", harnessUsage: [], draining: null,
      activeWork: { runnerCount: 0, runnerCapacity: 1, runs: [] }, doneTotal: 0, systemWarnings: [],
      steering: { enabled: false, agent: null, recent: [] },
    },
  };
}

/** A feed over a state the test changes; the build reads whatever the state is at that moment. */
function setup(options: { status?: () => Promise<SystemStatusViewModel>; replayLimit?: number } = {}) {
  const state = { items: [item(1), item(2)] };
  const feed = new DashboardFeed({ build: () => model(state.items), settleMs: 5, maxWaitMs: 20, statusIntervalMs: 10, ...options });
  return { state, feed };
}

function listen(feed: DashboardFeed, after: number | null = null) {
  const messages: DashboardFeedMessage[] = [];
  const subscription = feed.subscribe((message) => messages.push(message), after);
  return { messages, subscription, patches: () => messages.flatMap((message) => message.kind === "patch" ? [message.patch] : []) };
}

describe("DashboardFeed", () => {
  test("the snapshot builds the model and names the last patch it includes", () => {
    const { feed } = setup();
    const snapshot = feed.snapshot();
    expect(Object.keys(snapshot.model.items)).toEqual(["item-1", "item-2"]);
    expect(snapshot.seq).toBeGreaterThan(0);
    expect(feed.builds).toBe(1);
  });

  test("nothing is built while no dashboard listens", async () => {
    const { feed } = setup();
    feed.snapshot();
    feed.invalidate();
    feed.invalidate();
    await Bun.sleep(40);
    expect(feed.builds).toBe(1);
    feed.close();
  });

  test("a burst of changes is built once and every dashboard receives the same patch", async () => {
    const { state, feed } = setup();
    feed.snapshot();
    const dashboards = [listen(feed), listen(feed), listen(feed)];
    state.items = [item(1, "Renamed"), item(2)];
    for (let i = 0; i < 5; i += 1) feed.invalidate();
    await Bun.sleep(40);
    expect(feed.builds).toBe(2);
    for (const dashboard of dashboards) {
      expect(dashboard.patches()).toEqual([{ seq: expect.any(Number), entity: "item", id: "item-1", op: "upsert", data: { title: "Renamed" } }]);
    }
    feed.close();
  });

  test("a change that alters nothing sends nothing", async () => {
    const { feed } = setup();
    feed.snapshot();
    const dashboard = listen(feed);
    feed.invalidate();
    await Bun.sleep(40);
    expect(feed.builds).toBe(2);
    expect(dashboard.patches()).toEqual([]);
    feed.close();
  });

  test("a reconnecting dashboard gets the patches it missed", () => {
    const { state, feed } = setup();
    const { seq } = feed.snapshot();
    state.items = [item(1), item(2), item(3)];
    feed.invalidate();
    feed.flush();
    const dashboard = listen(feed, seq);
    expect(dashboard.subscription.replay).toEqual([{ seq: seq + 1, entity: "item", id: "item-3", op: "upsert", data: expect.objectContaining({ number: 3 }) }]);
    feed.close();
  });

  test("a dashboard that missed more than is kept is told to reload", () => {
    const { state, feed } = setup({ replayLimit: 2 });
    const { seq } = feed.snapshot();
    state.items = [item(1, "a"), item(2, "b"), item(3), item(4)];
    feed.invalidate();
    feed.flush();
    expect(listen(feed, seq).subscription.replay).toBeNull();
    feed.close();
  });

  test("a dashboard ahead of the feed is told to reload", () => {
    const { feed } = setup();
    const { seq } = feed.snapshot();
    expect(listen(feed, seq + 10).subscription.replay).toBeNull();
    feed.close();
  });

  test("the server status is sent only when it changed", async () => {
    let used = 1;
    const status = async (): Promise<SystemStatusViewModel> => ({
      memory: { usedBytes: used, totalBytes: 10, processBytes: 1 },
      disk: { available: true },
      storage: { artifacts: { available: true }, temporaryDirectory: { available: true }, workspaceScratch: { available: true } },
      uptimeSeconds: 1,
    });
    const { feed } = setup({ status });
    const dashboard = listen(feed);
    await Bun.sleep(50);
    expect(dashboard.messages.filter((message) => message.kind === "status")).toHaveLength(1);
    used = 2;
    await Bun.sleep(50);
    expect(dashboard.messages.filter((message) => message.kind === "status")).toHaveLength(2);
    expect(feed.status?.memory.usedBytes).toBe(2);
    feed.close();
  });

  test("a dashboard that leaves stops receiving patches", async () => {
    const { state, feed } = setup();
    feed.snapshot();
    const dashboard = listen(feed);
    dashboard.subscription.unsubscribe();
    state.items = [item(1, "Renamed"), item(2)];
    feed.invalidate();
    feed.flush();
    expect(dashboard.patches()).toEqual([]);
    feed.close();
  });
});

describe("changesDashboard", () => {
  test("an item change rebuilds the dashboard", () => {
    expect(changesDashboard("item.stageChanged")).toBe(true);
  });
  test("admission changes rebuild the dashboard", () => {
    expect(changesDashboard("admission.paused")).toBe(true);
    expect(changesDashboard("admission.resumed")).toBe(true);
  });
  test("a conversation message rebuilds the dashboard", () => {
    expect(changesDashboard("message.posted")).toBe(true);
  });
  test("a transcript line does not", () => {
    expect(changesDashboard("run.progressed")).toBe(false);
  });
  test("a run starting or finishing does", () => {
    expect(changesDashboard("run.started")).toBe(true);
    expect(changesDashboard("run.finished")).toBe(true);
  });
  test("bookkeeping that shows nowhere does not", () => {
    for (const type of ["webhook.received", "task.planned", "task.pending", "command.accepted", "session.signedIn", "item.fenced", "source.mutationStarted"]) {
      expect({ type, changes: changesDashboard(type) }).toEqual({ type, changes: false });
    }
  });
});
