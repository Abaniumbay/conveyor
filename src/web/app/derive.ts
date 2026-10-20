// Builds the board's view model from the live model, in the browser. The components that render it
// are the same ones the server-rendered dashboard uses, so the board looks and reads the same.

import type { DashboardItem, DashboardModel } from "../model";
import type { DashboardAccountViewModel, DashboardViewModel, GraphViewModel, IssueCardViewModel, RecentActivityViewModel, StageColumnViewModel, SystemStatusViewModel } from "../types";

/** The views the application renders itself; every other view is still served by the server. */
export type AppView = "board" | "graph" | "recent" | "attention" | "repositories" | "repository"
  | "team" | "reports" | "agent" | "accounts" | "profile" | "notifications" | "about";

/** The views whose own data is loaded from `/api/v1/views/<name>` when they are shown. */
export const VIEW_DATA: Partial<Record<AppView, string>> = {
  team: "team", reports: "reports", agent: "operator", accounts: "accounts", notifications: "notifications", about: "about",
};

/** What a view loaded for itself, merged into the view model. */
export type ViewData = Partial<Pick<DashboardViewModel, "team" | "report" | "steering" | "accounts" | "notifications" | "build">>;

/** What the address bar selects. */
export interface BoardSelection {
  view: AppView;
  /** The repository a repository page shows. */
  repositoryId: string | null;
  /** The Graph's stage filter. */
  graphStage: string | null;
  /** The agent whose profile is open on Team. */
  agentId: string | null;
  /** The Operator run shown, or null for the latest. */
  runId: string | null;
  repositoryIds: readonly string[];
  q: string;
  state: string | null;
  /** The item whose details are open, by repository and number. */
  issue: { repository: string; number: number } | null;
  /** How many finished items Done shows. */
  doneLimit: number;
}

export const DEFAULT_DONE_LIMIT = 20;

/** The application's own address for a server-rendered dashboard path, or null for a view it does not render. */
export function appPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/board") return "/app";
  if (["/graph", "/recent", "/attention", "/repositories", "/team", "/reports", "/operator", "/accounts", "/profile", "/settings/notifications", "/about"].includes(pathname)) return `/app${pathname}`;
  const nested = /^\/(team|reports|operator\/runs)\/([^/]+)$/.exec(pathname);
  if (nested) return `/app/${nested[1]}/${nested[2]}`;
  const repository = /^\/repositories\/([^/]+)$/.exec(pathname);
  if (repository) return `/app/repositories/${repository[1]}`;
  const item = /^\/issues\/([^/]+)\/([1-9]\d*)(?:\/(?:conversation|journey|logs))?$/.exec(pathname);
  if (item) return `/app/issues/${item[1]}/${item[2]}`;
  return null;
}

type ViewRoute = { view: AppView; repositoryId: string | null; agentId: string | null; runId: string | null };

const decoded = (value: string | undefined): string | null => {
  try { return value === undefined ? null : decodeURIComponent(value); } catch { return null; }
};

function viewOf(pathname: string): ViewRoute {
  const path = pathname.replace(/\/+$/, "") || "/app";
  const route = (view: AppView, extra: Partial<ViewRoute> = {}): ViewRoute => ({ view, repositoryId: null, agentId: null, runId: null, ...extra });
  const simple: Record<string, AppView> = {
    "/app/graph": "graph", "/app/recent": "recent", "/app/attention": "attention", "/app/repositories": "repositories",
    "/app/team": "team", "/app/reports": "reports", "/app/operator": "agent", "/app/accounts": "accounts",
    "/app/profile": "profile", "/app/settings/notifications": "notifications", "/app/about": "about",
  };
  const named = simple[path];
  if (named) return route(named);
  const repository = /^\/app\/repositories\/([^/]+)$/.exec(path);
  if (repository) {
    const id = decoded(repository[1]);
    return id === null ? route("repositories") : route("repository", { repositoryId: id });
  }
  const agent = /^\/app\/team\/([^/]+)$/.exec(path);
  if (agent) return route("team", { agentId: decoded(agent[1]) });
  const report = /^\/app\/reports\/([^/]+)$/.exec(path);
  if (report) return route("reports", { repositoryId: decoded(report[1]) });
  const run = /^\/app\/operator\/runs\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (run) return route("agent", { runId: run[1]! });
  return route("board");
}

/** The query that loads a view's own data, or null for a view that has none. */
export function viewDataUrl(selection: BoardSelection, search: string): string | null {
  const name = VIEW_DATA[selection.view];
  if (!name) return null;
  const query = new URLSearchParams();
  if (selection.view === "reports") {
    const period = new URLSearchParams(search).get("period");
    if (period) query.set("period", period);
    if (selection.repositoryId) query.set("repository", selection.repositoryId);
  }
  if (selection.view === "agent" && selection.runId) query.set("run", selection.runId);
  const text = query.toString();
  return `/api/v1/views/${name}${text ? `?${text}` : ""}`;
}

/** Reads the selection from a dashboard application URL (`/app`, `/app/graph`, `/app/issues/<repository>/<number>`, …). */
export function boardSelectionFromUrl(url: URL): BoardSelection {
  const issue = /^\/app\/issues\/([^/]+)\/(\d+)\/?$/.exec(url.pathname);
  const doneLimit = Number(url.searchParams.get("doneLimit"));
  const stages = url.searchParams.getAll("stage");
  return {
    ...viewOf(url.pathname),
    graphStage: stages.length === 1 && stages[0]!.length > 0 && stages[0]!.length <= 200 ? stages[0]! : null,
    repositoryIds: [...new Set(url.searchParams.getAll("repo").filter((id) => id.length > 0 && id.length <= 200))],
    q: (url.searchParams.get("q") ?? "").slice(0, 200),
    state: url.searchParams.get("state"),
    issue: issue ? { repository: decodeURIComponent(issue[1]!), number: Number(issue[2]) } : null,
    doneLimit: Number.isSafeInteger(doneLimit) && doneLimit > 0 ? Math.min(doneLimit, 500) : DEFAULT_DONE_LIMIT,
  };
}

const byOrder = (left: DashboardItem, right: DashboardItem) => left.order - right.order;

/**
 * The Graph for its filters, as the server builds it: the current items that match, plus every item
 * directly related to one of them as context, and the relationships that touch a matching item.
 */
export function filteredGraph(graph: GraphViewModel, repositoryIds: readonly string[], stage: string | null): GraphViewModel {
  if (repositoryIds.length === 0 && stage === null) return graph;
  const repositories = new Set(repositoryIds);
  const current = new Set(graph.nodes
    .filter((node) => !node.context && (repositories.size === 0 || repositories.has(node.repository)) && (stage === null || node.stageId === stage))
    .map((node) => node.id));
  const relationships = graph.relationships.filter((relationship) => current.has(relationship.from) || current.has(relationship.to));
  const shown = new Set([...current, ...relationships.flatMap((relationship) => [relationship.from, relationship.to])]);
  return {
    nodes: graph.nodes.filter((node) => shown.has(node.id)).map((node) => ({ ...node, context: !current.has(node.id) })),
    relationships,
  };
}

function card(item: DashboardItem, csrfToken: string): IssueCardViewModel {
  const { placement: _placement, column: _column, order: _order, needsYou: _needsYou, conversation: _conversation, ...rest } = item;
  return { ...rest, csrfToken };
}

/** The board as the server-rendered dashboard would have built it for this account and selection. */
export function boardViewModel(input: {
  model: DashboardModel;
  account: DashboardAccountViewModel;
  csrfToken: string;
  selection: BoardSelection;
  /** Finished items loaded beyond the live model's most recent ones. */
  olderDone?: readonly DashboardItem[];
  /** The Recent page loaded for the address, when the Recent view is shown. */
  recent?: RecentActivityViewModel | null;
  /** The data the shown view loaded for itself. */
  viewData?: ViewData | null;
}): DashboardViewModel {
  const { model, account, csrfToken, selection } = input;
  const items = Object.values(model.items);
  const cards = (list: DashboardItem[]) => list.sort(byOrder).map((item) => card(item, csrfToken));
  const stages = Object.values(model.stages).sort((left, right) => left.order - right.order);
  const columns: StageColumnViewModel[] = stages.map((stage) => {
    const issues = cards(items.filter((item) => item.placement === "stage" && item.column === stage.id));
    return {
      id: `stage:${stage.id}`,
      name: stage.name,
      description: stage.description,
      icon: stage.icon,
      actors: stage.actors,
      cost: stage.cost,
      totalIssues: issues.length,
      page: 1,
      totalPages: 1,
      issues,
    };
  });
  const backlog = cards(items.filter((item) => item.placement === "backlog"));
  const liveDone = items.filter((item) => item.placement === "done");
  const known = new Set(liveDone.map((item) => item.id));
  const finished = cards([...liveDone, ...(input.olderDone ?? []).filter((item) => !known.has(item.id))]);
  const attention = cards(items.filter((item) => item.placement === "attention"));
  const selected = selection.issue
    ? items.find((item) => item.repository === selection.issue!.repository && item.number === selection.issue!.number)
    : undefined;
  return {
    title: model.system.title,
    project: model.system.project,
    totalUsage: model.system.totalUsage,
    harnessUsage: model.system.harnessUsage,
    draining: model.system.draining,
    updatedAt: model.system.updatedAt,
    revision: "",
    view: selection.view,
    repositoryId: selection.repositoryId,
    boardFilters: { repositories: [...selection.repositoryIds], q: selection.q, state: selection.state },
    graphFilters: {
      repositories: [...selection.repositoryIds],
      stage: selection.graphStage,
      stages: stages.map((stage) => ({ id: stage.id, name: stage.name })),
    },
    ...(selection.view === "recent" && input.recent ? { recent: input.recent } : {}),
    graph: selection.view === "graph" ? filteredGraph(model.graph, selection.repositoryIds, selection.graphStage) : model.graph,
    counts: { board: backlog.length + columns.reduce((total, column) => total + column.issues.length, 0), attention: attention.length },
    activeWork: model.system.activeWork,
    stages: columns,
    backlog,
    done: {
      id: "done",
      name: "Done",
      actors: [],
      cost: null,
      totalIssues: model.system.doneTotal,
      page: 1,
      totalPages: 1,
      issues: finished.slice(0, selection.doneLimit),
    },
    attention: { id: "attention", name: "Label problems", actors: [], cost: null, totalIssues: attention.length, page: 1, totalPages: 1, issues: attention },
    questions: Object.values(model.questions),
    needsYou: cards(items.filter((item) => item.needsYou)),
    systemWarnings: model.system.systemWarnings,
    repositories: Object.values(model.repositories),
    restrictedRepositories: Object.values(model.restrictedRepositories),
    steering: { ...model.system.steering, selected: null },
    selectedIssue: selected ? card(selected, csrfToken) : null,
    csrfToken,
    account,
    ...(input.viewData ?? {}),
    ...(input.viewData?.steering ? {} : { steering: { ...model.system.steering, selected: null } }),
  };
}

/** The server status line, as the header shows it. */
export type ServerStatus = SystemStatusViewModel | null;
