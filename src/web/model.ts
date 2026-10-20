// The dashboard's normalized live model: entities keyed by id, sent once as a snapshot and then
// kept current by patches. Views (board columns, Needs you, Graph) are derived from it by the
// client. This module has no server-only imports, so the browser application shares it.

import { z } from "zod";

import type {
  ActiveRunViewModel,
  DashboardViewModel,
  GraphViewModel,
  HarnessQuotaViewModel,
  IssueCardViewModel,
  QuestionViewModel,
  RepositoryDashboardSummary,
  RestrictedRepositoryDashboardSummary,
  StageActorViewModel,
  SystemStatusViewModel,
} from "./types";

/** Where an item sits on the board; the client builds the columns from it. */
export type DashboardItemPlacement = "backlog" | "stage" | "attention" | "done";

/** One workflow item: the card the dashboard shows, without any per-session data. */
export interface DashboardItem extends Omit<IssueCardViewModel, "csrfToken"> {
  placement: DashboardItemPlacement;
  /** The stage column it is in, for an item placed on a stage. */
  column: string | null;
  /** Position within its placement: backlog rank, stage order, or Done recency. */
  order: number;
  /** Stopped, asking a question or waiting at a manual gate for its owner. */
  needsYou: boolean;
  /** The newest conversation message, so an open conversation knows when to reload; null before the first. */
  conversation: number | null;
}

export interface DashboardStage {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  actors: readonly StageActorViewModel[];
  cost: string | null;
  /** Position on the line. */
  order: number;
}

export interface DashboardSystem {
  title: string;
  /** When Conveyor last reconciled its repositories. */
  updatedAt: string;
  project: string;
  totalUsage: string;
  harnessUsage: readonly HarnessQuotaViewModel[];
  draining: DashboardViewModel["draining"];
  activeWork: { runnerCount: number; runnerCapacity: number; runs: readonly ActiveRunViewModel[] };
  /** All finished items; the snapshot carries only the most recent of them. */
  doneTotal: number;
  systemWarnings: readonly string[];
  steering: { enabled: boolean; agent: string | null; recent: DashboardViewModel["steering"]["recent"] };
}

export interface DashboardModel {
  items: Record<string, DashboardItem>;
  stages: Record<string, DashboardStage>;
  questions: Record<string, QuestionViewModel>;
  repositories: Record<string, RepositoryDashboardSummary>;
  /** Superuser only. */
  restrictedRepositories: Record<string, RestrictedRepositoryDashboardSummary>;
  graph: GraphViewModel;
  system: DashboardSystem;
}

export const DASHBOARD_ENTITIES = ["item", "stage", "question", "repository", "restrictedRepository", "graph", "system"] as const;
export type DashboardEntity = (typeof DASHBOARD_ENTITIES)[number];

/** Entities sent only to superuser sessions. */
export const SUPERUSER_ENTITIES: ReadonlySet<DashboardEntity> = new Set(["restrictedRepository"]);

const COLLECTIONS = {
  item: "items",
  stage: "stages",
  question: "questions",
  repository: "repositories",
  restrictedRepository: "restrictedRepositories",
} as const satisfies Partial<Record<DashboardEntity, keyof DashboardModel>>;
const SINGLETONS = { graph: "graph", system: "system" } as const satisfies Partial<Record<DashboardEntity, keyof DashboardModel>>;

/** One change to the live model. An upsert of a known entity carries only its changed fields. */
export const dashboardPatchSchema = z.object({
  seq: z.number().int().positive(),
  entity: z.enum(DASHBOARD_ENTITIES),
  id: z.string().min(1),
  op: z.enum(["upsert", "remove"]),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type DashboardPatch = z.infer<typeof dashboardPatchSchema>;

const modelShape = z.object({
  items: z.record(z.string(), z.record(z.string(), z.unknown())),
  stages: z.record(z.string(), z.record(z.string(), z.unknown())),
  questions: z.record(z.string(), z.record(z.string(), z.unknown())),
  repositories: z.record(z.string(), z.record(z.string(), z.unknown())),
  restrictedRepositories: z.record(z.string(), z.record(z.string(), z.unknown())),
  graph: z.object({ nodes: z.array(z.unknown()), relationships: z.array(z.unknown()) }).passthrough(),
  system: z.record(z.string(), z.unknown()),
}).strict();

/** The server status; checked for shape, its fields are the server's own type. */
export const systemStatusSchema = z.custom<SystemStatusViewModel>((value) =>
  z.object({ memory: z.object({}).passthrough(), disk: z.object({}).passthrough(), storage: z.object({}).passthrough() }).passthrough().safeParse(value).success,
);

export const dashboardSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  model: z.custom<DashboardModel>((value) => modelShape.safeParse(value).success, "not a dashboard model"),
  /** The last server status read (memory, disks), or null before the first read. */
  status: systemStatusSchema.nullable(),
  account: z.object({ id: z.string(), username: z.string(), role: z.enum(["superuser", "user"]), avatar: z.string() }).strict(),
  csrfToken: z.string(),
}).strict();

/** Finished items beyond the live model's most recent ones, oldest last. */
export const olderDoneSchema = z.object({
  items: z.array(z.custom<DashboardItem>((value) => z.object({ id: z.string(), placement: z.literal("done"), order: z.number() }).passthrough().safeParse(value).success)),
}).strict();

/** Builds the normalized model from the service's board model. */
export function normalizeDashboard(board: DashboardViewModel, facts: { conversations?: ReadonlyMap<string, number> } = {}): DashboardModel {
  const items: Record<string, DashboardItem> = {};
  const needsYou = new Set(board.needsYou.map((issue) => issue.id));
  const add = (issue: IssueCardViewModel, placement: DashboardItemPlacement, order: number, column: string | null = null) => {
    const { csrfToken: _session, ...card } = issue;
    items[issue.id] = { ...card, placement, column, order, needsYou: needsYou.has(issue.id), conversation: facts.conversations?.get(issue.id) ?? null };
  };
  board.backlog.forEach((issue, index) => add(issue, "backlog", index));
  let position = 0;
  for (const stage of board.stages) for (const issue of stage.issues) add(issue, "stage", position++, stage.id.replace(/^stage:/, ""));
  board.attention.issues.forEach((issue, index) => add(issue, "attention", index));
  board.done.issues.forEach((issue, index) => add(issue, "done", index));
  // Needs you can name an item that is on no column (for example a stopped item outside the line).
  board.needsYou.forEach((issue, index) => { if (!items[issue.id]) add(issue, "attention", board.attention.issues.length + index); });
  const stages: Record<string, DashboardStage> = {};
  board.stages.forEach((stage, order) => {
    const id = stage.id.replace(/^stage:/, "");
    stages[id] = {
      id,
      name: stage.name,
      description: stage.description ?? null,
      icon: stage.icon ?? null,
      actors: stage.actors,
      cost: stage.cost,
      order,
    };
  });
  return {
    items,
    stages,
    questions: Object.fromEntries(board.questions.map((question) => [question.id, question])),
    repositories: Object.fromEntries(board.repositories.map((repository) => [repository.id, repository])),
    restrictedRepositories: Object.fromEntries(board.restrictedRepositories.map((repository) => [repository.id, repository])),
    graph: board.graph,
    system: {
      title: board.title,
      updatedAt: board.updatedAt,
      project: board.project,
      totalUsage: board.totalUsage,
      harnessUsage: board.harnessUsage,
      draining: board.draining,
      activeWork: board.activeWork,
      doneTotal: board.done.totalIssues,
      systemWarnings: board.systemWarnings,
      steering: { enabled: board.steering.enabled, agent: board.steering.agent, recent: board.steering.recent },
    },
  };
}

type Change = Omit<DashboardPatch, "seq">;

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const fieldsOf = (value: object): Record<string, unknown> => Object.fromEntries(Object.entries(value));

/** The top-level fields of `next` that differ from `previous`. */
function changedFields(previous: object, next: object): Record<string, unknown> | null {
  const before = fieldsOf(previous);
  const after = fieldsOf(next);
  const changed: Record<string, unknown> = {};
  let any = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    // A field that disappears is sent as null, which every optional field also accepts.
    changed[key] = key in after ? after[key] : null;
    any = true;
  }
  return any ? changed : null;
}

type CollectionKey = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
type SingletonKey = (typeof SINGLETONS)[keyof typeof SINGLETONS];
const collectionEntries = Object.entries(COLLECTIONS) as [DashboardEntity, CollectionKey][];
const singletonEntries = Object.entries(SINGLETONS) as [DashboardEntity, SingletonKey][];

/** The patches that turn `previous` into `next`, in entity order. */
export function diffDashboard(previous: DashboardModel | null, next: DashboardModel): Change[] {
  const changes: Change[] = [];
  for (const [entity, key] of collectionEntries) {
    const before: Record<string, object> = previous?.[key] ?? {};
    const after: Record<string, object> = next[key];
    for (const [id, value] of Object.entries(after)) {
      const old = before[id];
      const data = old ? changedFields(old, value) : fieldsOf(value);
      if (data) changes.push({ entity, id, op: "upsert", data });
    }
    for (const id of Object.keys(before)) if (!(id in after)) changes.push({ entity, id, op: "remove" });
  }
  for (const [entity, key] of singletonEntries) {
    const after: object = next[key];
    const data = previous ? changedFields(previous[key], after) : fieldsOf(after);
    if (data) changes.push({ entity, id: entity, op: "upsert", data });
  }
  return changes;
}

/** Applies one patch to a model in place; the client and the tests use the same rule. */
export function applyDashboardPatch(model: DashboardModel, patch: Pick<DashboardPatch, "entity" | "id" | "op" | "data">): void {
  const singleton = singletonEntries.find(([entity]) => entity === patch.entity);
  if (singleton) {
    const target: object = model[singleton[1]];
    Object.assign(target, patch.data ?? {});
    return;
  }
  const collectionKey = collectionEntries.find(([entity]) => entity === patch.entity)?.[1];
  if (!collectionKey) return;
  const collection: Record<string, object> = model[collectionKey];
  if (patch.op === "remove") {
    delete collection[patch.id];
    return;
  }
  const existing = collection[patch.id];
  if (existing) Object.assign(existing, patch.data ?? {});
  else collection[patch.id] = { ...(patch.data ?? {}) };
}
