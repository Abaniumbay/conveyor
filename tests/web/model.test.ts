import { describe, expect, test } from "bun:test";

import { applyDashboardPatch, dashboardSnapshotSchema, diffDashboard, normalizeDashboard, type DashboardModel } from "../../src/web/model";
import type { DashboardViewModel, IssueCardViewModel } from "../../src/web/types";

function card(number: number, overrides: Partial<IssueCardViewModel> = {}): IssueCardViewModel {
  return {
    id: `github:owner/repo#${number}`,
    repository: "repo",
    repositoryPaused: false,
    repositoryColor: 1,
    number,
    title: `Item ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: "active",
    labels: ["conveyor"],
    issueType: null,
    issueFields: [],
    acceptanceCriteria: [],
    todos: null,
    indicators: [],
    activity: null,
    reason: null,
    cost: null,
    duration: null,
    stateChangedAt: null,
    waiting: null,
    blocked: false,
    inconsistent: false,
    closable: false,
    noSplit: false,
    tone: "active",
    parent: null,
    children: [],
    dependencies: [],
    working: false,
    needsAttention: false,
    retryable: false,
    resumable: false,
    resumableRollup: false,
    stoppedRollup: false,
    csrfToken: "session-token",
    ...overrides,
  };
}

function column(id: string, issues: IssueCardViewModel[]) {
  return { id, name: id, actors: [], cost: null, totalIssues: issues.length, page: 1, totalPages: 1, issues };
}

function board(overrides: Partial<DashboardViewModel> = {}): DashboardViewModel {
  return {
    title: "Conveyor",
    project: "1 repositories",
    totalUsage: "0 runs",
    harnessUsage: [],
    draining: null,
    updatedAt: "2026-10-20T00:00:00Z",
    revision: "r1",
    view: "board",
    repositoryId: null,
    graph: { nodes: [], relationships: [] },
    counts: { board: 0, attention: 0 },
    activeWork: { runnerCount: 0, runnerCapacity: 2, runs: [] },
    stages: [{ ...column("stage:implementation", [card(2)]), description: "Build it", icon: "🛠️" }],
    backlog: [card(1)],
    done: { ...column("done", [card(3, { state: "completed" })]), totalIssues: 40 },
    attention: column("attention", []),
    questions: [],
    needsYou: [],
    systemWarnings: [],
    repositories: [],
    restrictedRepositories: [{ id: "repo", folder: "/srv/repo", agentEgressHosts: [] }],
    steering: { enabled: false, agent: null, selected: null, recent: [] },
    selectedIssue: null,
    csrfToken: "session-token",
    ...overrides,
  };
}

const clone = (model: DashboardModel): DashboardModel => JSON.parse(JSON.stringify(model));

describe("normalizeDashboard", () => {
  test("places each item by its column and keeps no session data", () => {
    const model = normalizeDashboard(board());
    expect(model.items["github:owner/repo#1"]).toMatchObject({ placement: "backlog", order: 0, needsYou: false });
    expect(model.items["github:owner/repo#2"]).toMatchObject({ placement: "stage", column: "implementation", order: 0 });
    expect(model.items["github:owner/repo#3"]).toMatchObject({ placement: "done", state: "completed" });
    expect(JSON.stringify(model)).not.toContain("session-token");
  });

  test("keys stages by their stage id and keeps their line order", () => {
    const model = normalizeDashboard(board());
    expect(model.stages).toEqual({
      implementation: { id: "implementation", name: "stage:implementation", description: "Build it", icon: "🛠️", actors: [], cost: null, order: 0 },
    });
  });

  test("marks the items that need their owner", () => {
    const stopped = card(2, { state: "blocked" });
    const model = normalizeDashboard(board({ needsYou: [stopped] }));
    expect(model.items[stopped.id]?.needsYou).toBe(true);
  });

  test("counts every finished item while carrying only the recent ones", () => {
    expect(normalizeDashboard(board()).system.doneTotal).toBe(40);
  });
});

describe("diffDashboard", () => {
  test("a first build sends every entity in full", () => {
    const model = normalizeDashboard(board());
    const changes = diffDashboard(null, model);
    expect(changes.filter((change) => change.entity === "item").map((change) => change.id).sort()).toEqual(Object.keys(model.items).sort());
    expect(changes.find((change) => change.entity === "system")?.data).toEqual({ ...model.system });
  });

  test("an unchanged build sends nothing", () => {
    expect(diffDashboard(normalizeDashboard(board()), normalizeDashboard(board()))).toEqual([]);
  });

  test("a changed item sends only its changed fields", () => {
    const before = normalizeDashboard(board());
    const after = normalizeDashboard(board({ backlog: [card(1, { title: "Renamed", activity: "Refining" })] }));
    expect(diffDashboard(before, after)).toEqual([
      { entity: "item", id: "github:owner/repo#1", op: "upsert", data: { title: "Renamed", activity: "Refining" } },
    ]);
  });

  test("an item that moves column sends its new placement", () => {
    const before = normalizeDashboard(board());
    const after = normalizeDashboard(board({ backlog: [], stages: [{ ...column("stage:implementation", [card(1), card(2)]), description: "Build it", icon: "🛠️" }] }));
    const item = diffDashboard(before, after).find((change) => change.id === "github:owner/repo#1");
    expect(item).toEqual({ entity: "item", id: "github:owner/repo#1", op: "upsert", data: { placement: "stage", column: "implementation" } });
  });

  test("an item that leaves the model is removed", () => {
    const before = normalizeDashboard(board());
    const after = normalizeDashboard(board({ backlog: [] }));
    expect(diffDashboard(before, after)).toContainEqual({ entity: "item", id: "github:owner/repo#1", op: "remove" });
  });

  test("a field that becomes empty is sent as null", () => {
    const before = normalizeDashboard(board({ backlog: [card(1, { reason: "Waiting for #2" })] }));
    const after = normalizeDashboard(board());
    expect(diffDashboard(before, after)).toEqual([
      { entity: "item", id: "github:owner/repo#1", op: "upsert", data: { reason: null } },
    ]);
  });

  test("a system change sends only the changed system fields", () => {
    const before = normalizeDashboard(board());
    const after = normalizeDashboard(board({ draining: { reason: "upgrade", upgrade: null } }));
    expect(diffDashboard(before, after)).toEqual([
      { entity: "system", id: "system", op: "upsert", data: { draining: { reason: "upgrade", upgrade: null } } },
    ]);
  });

  test("applying the patches to the previous model gives the next one", () => {
    const before = normalizeDashboard(board());
    const after = normalizeDashboard(board({
      backlog: [card(4)],
      stages: [{ ...column("stage:implementation", [card(2, { working: true }), card(1)]), description: "Build it", icon: "🛠️" }],
      draining: { reason: "restart", upgrade: null },
    }));
    const applied = clone(before);
    for (const change of diffDashboard(before, after)) applyDashboardPatch(applied, change);
    expect(applied).toEqual(clone(after));
  });
});

describe("dashboardSnapshotSchema", () => {
  test("accepts a normalized snapshot", () => {
    const snapshot = {
      seq: 3,
      model: normalizeDashboard(board()),
      status: null,
      account: { id: "a", username: "owner", role: "superuser", avatar: "fox" },
      csrfToken: "token",
    };
    expect(dashboardSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))).seq).toBe(3);
  });
});
