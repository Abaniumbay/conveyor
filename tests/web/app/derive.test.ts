import { describe, expect, test } from "bun:test";

import { appPath, boardSelectionFromUrl, boardViewModel, DEFAULT_DONE_LIMIT, filteredGraph } from "../../../src/web/app/derive";
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
      view: "board", repositoryId: null, graphStage: null, repositoryIds: ["a", "b"], q: "fix", state: "running", issue: null, doneLimit: 40,
    });
  });

  test("ignores an unusable Done limit", () => {
    expect(boardSelectionFromUrl(new URL("https://conveyor.example.com/app?doneLimit=-3")).doneLimit).toBe(DEFAULT_DONE_LIMIT);
  });
});

describe("views", () => {
  test("reads each application view from its address", () => {
    const view = (path: string) => boardSelectionFromUrl(new URL(`https://conveyor.example.com${path}`));
    expect(view("/app")).toMatchObject({ view: "board", repositoryId: null });
    expect(view("/app/graph?stage=review")).toMatchObject({ view: "graph", graphStage: "review" });
    expect(view("/app/recent")).toMatchObject({ view: "recent" });
    expect(view("/app/attention")).toMatchObject({ view: "attention" });
    expect(view("/app/repositories")).toMatchObject({ view: "repositories" });
    expect(view("/app/repositories/my%20app")).toMatchObject({ view: "repository", repositoryId: "my app" });
    expect(view("/app/issues/repo/7")).toMatchObject({ view: "board", issue: { repository: "repo", number: 7 } });
  });

  test("maps the server dashboard's paths to the application's", () => {
    expect(appPath("/board")).toBe("/app");
    expect(appPath("/")).toBe("/app");
    expect(appPath("/graph")).toBe("/app/graph");
    expect(appPath("/repositories/repo")).toBe("/app/repositories/repo");
    expect(appPath("/issues/repo/7/journey")).toBe("/app/issues/repo/7");
  });

  test("leaves views the application does not render to the server", () => {
    expect(appPath("/team")).toBeNull();
    expect(appPath("/reports")).toBeNull();
    expect(appPath("/operator")).toBeNull();
  });

  test("passes the Recent page and the repository on to the view", () => {
    const recent = { types: [], repositoryIds: [], events: [], nextCursor: null, rangeStartedAt: null };
    const view = boardViewModel({ model: model([]), account, csrfToken: "token", selection: boardSelectionFromUrl(new URL("https://conveyor.example.com/app/recent")), recent });
    expect(view).toMatchObject({ view: "recent", recent });
    expect(board([], "https://conveyor.example.com/app/repositories/repo")).toMatchObject({ view: "repository", repositoryId: "repo" });
  });
});

describe("filteredGraph", () => {
  const node = (id: string, repository: string, stageId: string | null, context = false) => ({
    id, repository, repositoryColor: 1, number: Number(id.slice(1)), title: id, state: "Active", stage: stageId, stageId, context, signal: null,
  });
  const graph = {
    nodes: [node("n1", "a", "review"), node("n2", "b", "implementation"), node("n3", "a", "implementation"), node("n9", "c", null, true)],
    relationships: [
      { kind: "dependency" as const, from: "n2", to: "n1", status: "outstanding" as const },
      { kind: "parent-child" as const, from: "n3", to: "n9", status: null },
    ],
  };

  test("is unchanged without filters", () => {
    expect(filteredGraph(graph, [], null)).toBe(graph);
  });

  test("keeps matching items and shows directly related ones as context", () => {
    const result = filteredGraph(graph, [], "review");
    expect(result.nodes.map((entry) => [entry.id, entry.context])).toEqual([["n1", false], ["n2", true]]);
    expect(result.relationships).toEqual(graph.relationships.slice(0, 1));
  });

  test("filters by repository", () => {
    const result = filteredGraph(graph, ["a"], null);
    expect(result.nodes.map((entry) => [entry.id, entry.context])).toEqual([["n1", false], ["n2", true], ["n3", false], ["n9", true]]);
  });
});
