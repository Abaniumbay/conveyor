import { describe, expect, test } from "bun:test";

import { boardSelectionFromUrl, boardViewModel, DEFAULT_DONE_LIMIT } from "../../../src/web/app/derive";
import type { DashboardItem, DashboardModel } from "../../../src/web/model";

function item(number: number, overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    id: `github:owner/repo#${number}`, repository: "repo", repositoryPaused: false, repositoryColor: 1, number, title: `Item ${number}`,
    url: null, state: "active", labels: [], issueType: null, issueFields: [], acceptanceCriteria: [], todos: null, indicators: [],
    activity: null, reason: null, cost: null, duration: null, stateChangedAt: null, waiting: null, blocked: false, inconsistent: false,
    closable: false, noSplit: false, tone: "active", parent: null, children: [], dependencies: [], working: false,
    needsAttention: false, retryable: false, resumableRollup: false, stoppedRollup: false,
    placement: "backlog", column: null, order: 0, needsYou: false, conversation: null,
    ...overrides,
  };
}

function model(items: DashboardItem[]): DashboardModel {
  return {
    items: Object.fromEntries(items.map((entry) => [entry.id, entry])),
    stages: {
      review: { id: "review", name: "Review", description: null, icon: null, actors: [], cost: null, order: 1 },
      implementation: { id: "implementation", name: "Implementation", description: null, icon: "🛠️", actors: [], cost: null, order: 0 },
    },
    questions: {},
    repositories: {},
    restrictedRepositories: {},
    graph: { nodes: [], relationships: [] },
    system: {
      title: "Conveyor", updatedAt: "2026-10-20T00:00:00Z", project: "1 repositories", totalUsage: "0 runs", harnessUsage: [], draining: null,
      activeWork: { runnerCount: 0, runnerCapacity: 2, runs: [] }, doneTotal: 120, systemWarnings: [],
      steering: { enabled: false, agent: null, recent: [] },
    },
  };
}

const account = { id: "a", username: "owner", role: "superuser" as const, avatar: "🐼" };
const board = (items: DashboardItem[], url = "https://conveyor.example.com/app") =>
  boardViewModel({ model: model(items), account, csrfToken: "token", selection: boardSelectionFromUrl(new URL(url)) });

describe("boardViewModel", () => {
  test("puts the stage columns in line order", () => {
    expect(board([]).stages.map((stage) => stage.id)).toEqual(["stage:implementation", "stage:review"]);
  });

  test("places each item in its column in order", () => {
    const view = board([
      item(1, { placement: "stage", column: "review", order: 3 }),
      item(2, { placement: "stage", column: "implementation", order: 2 }),
      item(3, { placement: "stage", column: "review", order: 1 }),
    ]);
    expect(view.stages[0]!.issues.map((issue) => issue.number)).toEqual([2]);
    expect(view.stages[1]!.issues.map((issue) => issue.number)).toEqual([3, 1]);
  });

  test("keeps the backlog in its saved order", () => {
    expect(board([item(1, { order: 1 }), item(2, { order: 0 })]).backlog.map((issue) => issue.number)).toEqual([2, 1]);
  });

  test("shows the most recent finished items up to the Done limit, counting all of them", () => {
    const finished = Array.from({ length: 30 }, (_, index) => item(100 + index, { placement: "done", order: index }));
    const view = board(finished);
    expect(view.done.issues).toHaveLength(DEFAULT_DONE_LIMIT);
    expect(view.done.issues[0]?.number).toBe(100);
    expect(view.done.totalIssues).toBe(120);
  });

  test("lists the items that need their owner", () => {
    expect(board([item(1), item(2, { needsYou: true })]).needsYou.map((issue) => issue.number)).toEqual([2]);
  });

  test("carries the session's token on every card and no live-model fields", () => {
    const card = board([item(1)]).backlog[0]!;
    expect(card.csrfToken).toBe("token");
    expect(card).not.toHaveProperty("placement");
    expect(card).not.toHaveProperty("conversation");
  });

  test("selects the item the address names", () => {
    const view = board([item(7)], "https://conveyor.example.com/app/issues/repo/7");
    expect(view.selectedIssue?.number).toBe(7);
  });

  test("selects nothing for an item that is not on the board", () => {
    expect(board([item(7)], "https://conveyor.example.com/app/issues/repo/8").selectedIssue).toBeNull();
  });
});

describe("boardSelectionFromUrl", () => {
  test("reads the filters and the Done limit", () => {
    expect(boardSelectionFromUrl(new URL("https://conveyor.example.com/app?repo=a&repo=b&q=fix&state=running&doneLimit=40"))).toEqual({
      repositoryIds: ["a", "b"], q: "fix", state: "running", issue: null, doneLimit: 40,
    });
  });

  test("ignores an unusable Done limit", () => {
    expect(boardSelectionFromUrl(new URL("https://conveyor.example.com/app?doneLimit=-3")).doneLimit).toBe(DEFAULT_DONE_LIMIT);
  });
});
