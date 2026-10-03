import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ExecutionStore } from "../engine/journal";
import { migrations } from "./migrations";

export interface RepositoryRecord {
  id: string;
  configName: string;
  source: string;
  address: string;
  folder: string;
  configHash: string;
}

export interface IssueProjection {
  id: string;
  repositoryId: string;
  sourceNumber: number;
  sourceUrl: string;
  title: string;
  body: string;
  sourceState: string;
  sourceStateReason?: string | null;
  labels: string[];
  sourceUpdatedAt: string;
  parentId?: string | null;
}

export interface StoredIssue extends IssueProjection {
  queueRank: number | null;
  projectedStage: string | null;
  projectedState: string | null;
  warning: string | null;
}

export interface DashboardAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: "superuser" | "user";
  avatar: string;
  sessionVersion: number;
}

export interface SourceMutation {
  id: string;
  idempotencyKey: string;
  source: string;
  operation: string;
  status: string;
  request: unknown;
  response: unknown | null;
  error: string | null;
}

export interface RunRecordInput {
  id: string;
  issueId: string | null;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  configHash: string;
  startedAt: string;
}

export interface StoredRun {
  id: string;
  issueId: string | null;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  sessionId: string | null;
  result: unknown | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ActiveIssueRun {
  id: string;
  issueId: string;
  repository: string;
  issueNumber: number;
  issueTitle: string;
  stageId: string;
  kind: string;
  startedAt: string;
}

export interface EnrollmentRecord {
  id: string;
  issueId: string;
  generation: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface StoredWorkspace {
  id: string;
  enrollmentId: string;
  issueId: string;
  generation: number;
  path: string;
  branch: string;
  status: string;
}

export interface StoredPullRequest {
  id: string;
  issueId: string;
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
}

export interface StoredStageState {
  issueId: string;
  stageId: string;
  status: string;
  feedbackCycle: number;
  configHash: string;
  updatedAt: string;
}

export interface StageTransitionDetail {
  reason: string | null;
  requiredFixes: string[];
  resultStatus: string | null;
  actor?: { name: string; title: string | null } | null;
}

export interface StoredStageTransition extends StageTransitionDetail {
  id: string;
  issueId: string;
  fromStage: string | null;
  toStage: string | null;
  kind: string;
  status: string;
  sourceMutationId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StoredQuestion {
  id: string;
  issueId: string;
  runId: string | null;
  prompt: string;
  reason: string;
  options: unknown[];
  minSelections: number;
  maxSelections: number;
  allowFreeText: boolean;
  status: string;
  createdAt: string;
  answeredAt: string | null;
  answer: unknown | null;
}

export interface StoredConversationMessage {
  id: number;
  issueId: string;
  runId: string | null;
  stageId: string | null;
  actorType: string;
  actorId: string;
  actorName: string;
  actorTitle: string | null;
  message: string;
  createdAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

/** Status changes the stage executor makes to itself; they never fence the item. */
const EXECUTOR_STATUSES = new Set(["ready", "running", "error", "interrupted"]);

const CONVERSATION_MESSAGE_LIMIT = 4_000;

/** Keeps the start of a system message (the summary and first failures) and says how much was cut. */
function trimToLimit(message: string): string {
  const note = (omitted: number) => `\n… (${omitted} characters omitted)`;
  const budget = CONVERSATION_MESSAGE_LIMIT - note(message.length).length;
  const cut = message.lastIndexOf("\n", budget) > budget / 2 ? message.lastIndexOf("\n", budget) : budget;
  return `${message.slice(0, cut).trimEnd()}${note(message.length - cut)}`;
}

export class ConveyorStore {
  readonly #database: Database;
  readonly #executions: ExecutionStore;

  private constructor(database: Database) {
    this.#database = database;
    this.#executions = new ExecutionStore(database);
  }

  static async open(filename: string): Promise<ConveyorStore> {
    await mkdir(path.dirname(filename), { recursive: true });
    const database = new Database(filename, { create: true, strict: true });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    const store = new ConveyorStore(database);
    store.migrate();
    return store;
  }

  close(): void {
    this.#database.close(false);
  }

  /** The durable task-chain journal: context, cursor, wake-ups and epochs. */
  executions(): ExecutionStore {
    return this.#executions;
  }

  /** The underlying database, shared with ExecutionStore. */
  sqlite(): Database {
    return this.#database;
  }

  pragma(name: "journal_mode" | "foreign_keys"): unknown[] {
    return this.#database.query(`PRAGMA ${name}`).all();
  }

  schemaVersion(): number {
    const row = this.#database
      .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  }

  dashboardAccounts(): DashboardAccount[] {
    return this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts ORDER BY role DESC, username COLLATE NOCASE`).all() as DashboardAccount[];
  }

  dashboardAccountById(id: string): DashboardAccount | null {
    return (this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts WHERE id = ?`).get(id) as DashboardAccount | undefined) ?? null;
  }

  dashboardAccountByUsername(username: string): DashboardAccount | null {
    return (this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts WHERE username = ? COLLATE NOCASE`).get(username) as DashboardAccount | undefined) ?? null;
  }

  seedDashboardSuperuser(username: string, passwordHash: string): void {
    if (this.#database.query("SELECT 1 FROM dashboard_accounts LIMIT 1").get()) return;
    this.#database.query(`INSERT INTO dashboard_accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'superuser', ?)`).run(randomUUID(), username, passwordHash, now());
  }

  createDashboardUser(username: string, passwordHash: string): DashboardAccount {
    const id = randomUUID();
    this.#database.query(`INSERT INTO dashboard_accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)`).run(id, username, passwordHash, now());
    return this.dashboardAccountById(id)!;
  }

  changeDashboardPassword(id: string, passwordHash: string): void {
    this.#database.query("UPDATE dashboard_accounts SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(passwordHash, id);
  }

  changeDashboardAvatar(id: string, avatar: string): void {
    this.#database.query("UPDATE dashboard_accounts SET avatar = ? WHERE id = ?").run(avatar, id);
  }

  private migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const apply = this.#database.transaction((version: number, sql: string) => {
      this.#database.exec(sql);
      this.#database
        .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, now());
    });
    const current = this.schemaVersion();
    for (const migration of migrations) {
      if (migration.version > current) apply(migration.version, migration.sql);
    }
  }

  recordConfigSnapshot(hash: string, config: unknown): void {
    this.#database
      .query(
        `INSERT INTO config_snapshots(hash, config_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(hash, json(config), now());
  }

  upsertRepository(repository: RepositoryRecord): void {
    const timestamp = now();
    this.#database
      .query(
        `INSERT INTO repositories(
           id, config_name, source, address, folder, config_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           config_name = excluded.config_name,
           source = excluded.source,
           address = excluded.address,
           folder = excluded.folder,
           config_hash = excluded.config_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        repository.id,
        repository.configName,
        repository.source,
        repository.address,
        repository.folder,
        repository.configHash,
        timestamp,
        timestamp,
      );
  }

  removeRepositoriesExcept(configuredIds: readonly string[]): string[] {
    const configured = [...new Set(configuredIds)];
    const placeholders = configured.map(() => "?").join(", ");
    const rows = (configured.length > 0
      ? this.#database
          .query(`SELECT id FROM repositories WHERE id NOT IN (${placeholders}) ORDER BY id`)
          .all(...configured)
      : this.#database.query("SELECT id FROM repositories ORDER BY id").all()) as Array<{
      id: string;
    }>;
    if (rows.length === 0) return [];

    const remove = this.#database.transaction((repositoryIds: readonly string[]) => {
      const statement = this.#database.query("DELETE FROM repositories WHERE id = ?");
      for (const repositoryId of repositoryIds) statement.run(repositoryId);
    });
    const removed = rows.map((row) => row.id);
    remove(removed);
    return removed;
  }

  upsertIssue(issue: IssueProjection): void {
    const timestamp = now();
    const labels = [...new Set(issue.labels)].sort((left, right) => left.localeCompare(right));
    this.#database
      .query(
        `INSERT INTO issues(
           id, repository_id, source_number, source_url, title, body, source_state,
           source_state_reason, labels_json, source_updated_at, parent_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repository_id = excluded.repository_id,
           source_number = excluded.source_number,
           source_url = excluded.source_url,
           title = excluded.title,
           body = excluded.body,
           source_state = excluded.source_state,
           source_state_reason = excluded.source_state_reason,
           labels_json = excluded.labels_json,
           source_updated_at = excluded.source_updated_at,
           parent_id = COALESCE(excluded.parent_id, issues.parent_id),
           updated_at = CASE WHEN
             issues.repository_id IS NOT excluded.repository_id OR
             issues.source_number IS NOT excluded.source_number OR
             issues.source_url IS NOT excluded.source_url OR
             issues.title IS NOT excluded.title OR
             issues.body IS NOT excluded.body OR
             issues.source_state IS NOT excluded.source_state OR
             issues.source_state_reason IS NOT excluded.source_state_reason OR
             issues.labels_json IS NOT excluded.labels_json OR
             issues.source_updated_at IS NOT excluded.source_updated_at OR
             issues.parent_id IS NOT COALESCE(excluded.parent_id, issues.parent_id)
           THEN excluded.updated_at ELSE issues.updated_at END`,
      )
      .run(
        issue.id,
        issue.repositoryId,
        issue.sourceNumber,
        issue.sourceUrl,
        issue.title,
        issue.body,
        issue.sourceState,
        issue.sourceStateReason ?? null,
        json(labels),
        issue.sourceUpdatedAt,
        issue.parentId ?? null,
        timestamp,
        timestamp,
      );
  }

  setQueueRank(issueId: string, rank: number): void {
    if (!Number.isFinite(rank)) throw new Error("queue rank must be finite");
    this.#database
      .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
      .run(rank, now(), issueId);
  }

  nextQueueRank(): number {
    const row = this.#database
      .query("SELECT COALESCE(MAX(queue_rank), 0) AS maximum FROM issues")
      .get() as { maximum: number };
    return Number(row.maximum) + 10;
  }

  /** A change of projected stage or state fences the item; a warning-only change does not. */
  setIssueProjection(
    issueId: string,
    projection: { stage: string | null; state: string | null; warning: string | null },
  ): void {
    this.#database.transaction(() => {
      const before = this.#database
        .query("SELECT projected_stage, projected_state FROM issues WHERE id = ?")
        .get(issueId) as { projected_stage: string | null; projected_state: string | null } | null;
      this.writeIssueProjection(issueId, projection);
      if (
        before &&
        (before.projected_stage !== projection.stage || before.projected_state !== projection.state)
      ) {
        this.#executions.onStageChange(issueId);
      }
    })();
  }

  private writeIssueProjection(
    issueId: string,
    projection: { stage: string | null; state: string | null; warning: string | null },
  ): void {
    this.#database
      .query(
        `UPDATE issues
         SET projected_stage = ?, projected_state = ?, warning = ?, updated_at = ?
         WHERE id = ? AND (
           projected_stage IS NOT ? OR projected_state IS NOT ? OR warning IS NOT ?
         )`,
      )
      .run(
        projection.stage,
        projection.state,
        projection.warning,
        now(),
        issueId,
        projection.stage,
        projection.state,
        projection.warning,
      );
  }

  getIssue(issueId: string): StoredIssue | null {
    const row = this.#database
      .query("SELECT * FROM issues WHERE id = ?")
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return this.mapIssue(row);
  }

  listIssues(repositoryId?: string): StoredIssue[] {
    const rows = (repositoryId
      ? this.#database
          .query(
            `SELECT * FROM issues WHERE repository_id = ?
             ORDER BY queue_rank IS NULL, queue_rank, source_number`,
          )
          .all(repositoryId)
      : this.#database
          .query(
            `SELECT * FROM issues
             ORDER BY queue_rank IS NULL, queue_rank, repository_id, source_number`,
          )
          .all()) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => this.mapIssue(row));
  }

  replaceRelationships(
    issueId: string,
    parent: { parentId: string; siblingOrder: number | null } | null,
    blockers: readonly string[],
  ): void {
    this.#database.transaction(() => {
      const normalizedBlockers = [...new Set(blockers)].sort((left, right) => left.localeCompare(right));
      if (normalizedBlockers.includes(issueId)) {
        throw new Error("an issue cannot depend on itself");
      }
      const currentParent = this.#database
        .query(
          `SELECT parent_id, sibling_order FROM issue_relationships
           WHERE child_id = ? LIMIT 1`,
        )
        .get(issueId) as { parent_id: string; sibling_order: number | null } | null;
      const currentBlockers = (this.#database
        .query("SELECT blocker_id FROM dependencies WHERE issue_id = ? ORDER BY blocker_id")
        .all(issueId) as Array<{ blocker_id: string }>)
        .map((row) => row.blocker_id);
      const sameParent = parent
        ? currentParent?.parent_id === parent.parentId && currentParent.sibling_order === parent.siblingOrder
        : currentParent === null;
      const sameBlockers = currentBlockers.length === normalizedBlockers.length &&
        currentBlockers.every((blockerId, index) => blockerId === normalizedBlockers[index]);
      if (sameParent && sameBlockers) return;

      this.#database
        .query("DELETE FROM issue_relationships WHERE child_id = ?")
        .run(issueId);
      this.#database.query("DELETE FROM dependencies WHERE issue_id = ?").run(issueId);
      this.#database
        .query("UPDATE issues SET parent_id = ?, updated_at = ? WHERE id = ?")
        .run(parent?.parentId ?? null, now(), issueId);
      if (parent) {
        this.#database
          .query(
            `INSERT INTO issue_relationships(parent_id, child_id, sibling_order)
             VALUES (?, ?, ?)`,
          )
          .run(parent.parentId, issueId, parent.siblingOrder);
      }
      const insertDependency = this.#database.query(
        "INSERT INTO dependencies(issue_id, blocker_id) VALUES (?, ?)",
      );
      for (const blockerId of normalizedBlockers) {
        insertDependency.run(issueId, blockerId);
      }
    })();
  }

  listDependencies(issueId: string): string[] {
    const rows = this.#database
      .query(
        "SELECT blocker_id FROM dependencies WHERE issue_id = ? ORDER BY blocker_id",
      )
      .all(issueId) as Array<{ blocker_id: string }>;
    return rows.map((row) => row.blocker_id);
  }

  listChildren(parentId: string): Array<{
    issueId: string;
    siblingOrder: number | null;
  }> {
    const rows = this.#database
      .query(
        `SELECT child_id, sibling_order FROM issue_relationships
         WHERE parent_id = ? ORDER BY sibling_order IS NULL, sibling_order, child_id`,
      )
      .all(parentId) as Array<{ child_id: string; sibling_order: number | null }>;
    return rows.map((row) => ({
      issueId: row.child_id,
      siblingOrder: row.sibling_order,
    }));
  }

  activateEnrollment(issueId: string): EnrollmentRecord {
    return this.#database.transaction(() => {
      const active = this.#database
        .query(
          `SELECT * FROM enrollments
           WHERE issue_id = ? AND status = 'active'
           ORDER BY generation DESC LIMIT 1`,
        )
        .get(issueId) as Record<string, SQLQueryBindings> | null;
      if (active) return this.mapEnrollment(active);
      this.#executions.onStageChange(issueId);

      const latest = this.#database
        .query(
          "SELECT COALESCE(MAX(generation), 0) AS generation FROM enrollments WHERE issue_id = ?",
        )
        .get(issueId) as { generation: number };
      const id = randomUUID();
      const startedAt = now();
      this.#database
        .query(
          `INSERT INTO enrollments(id, issue_id, generation, status, started_at)
           VALUES (?, ?, ?, 'active', ?)`,
        )
        .run(id, issueId, Number(latest.generation) + 1, startedAt);
      return this.getEnrollment(id)!;
    })();
  }

  getEnrollment(id: string): EnrollmentRecord | null {
    const row = this.#database
      .query("SELECT * FROM enrollments WHERE id = ?")
      .get(id) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapEnrollment(row) : null;
  }

  endActiveEnrollment(issueId: string, status: string): void {
    const timestamp = now();
    this.#database.transaction(() => {
      this.#database
        .query(
          `UPDATE workspaces SET status = 'stale'
           WHERE enrollment_id IN (
             SELECT id FROM enrollments WHERE issue_id = ? AND status = 'active'
           ) AND status = 'active'`,
        )
        .run(issueId);
      const ended = this.#database
        .query(
          `UPDATE enrollments SET status = ?, ended_at = ?
           WHERE issue_id = ? AND status = 'active'`,
        )
        .run(status, timestamp, issueId);
      if (ended.changes > 0) this.#executions.onStageChange(issueId);
    })();
  }

  recordWorkspace(workspace: {
    id: string;
    enrollmentId: string;
    path: string;
    branch: string;
    status: string;
  }): void {
    this.#database
      .query(
        `INSERT INTO workspaces(id, enrollment_id, path, branch, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      )
      .run(
        workspace.id,
        workspace.enrollmentId,
        workspace.path,
        workspace.branch,
        workspace.status,
        now(),
      );
  }

  getActiveWorkspace(issueId: string): StoredWorkspace | null {
    const row = this.#database
      .query(
        `SELECT w.*, e.issue_id, e.generation
         FROM workspaces w
         JOIN enrollments e ON e.id = w.enrollment_id
         WHERE e.issue_id = ? AND e.status = 'active' AND w.status = 'active'
         ORDER BY e.generation DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      issueId: String(row.issue_id),
      generation: Number(row.generation),
      path: String(row.path),
      branch: String(row.branch),
      status: String(row.status),
    };
  }

  markWorkspaceRemoved(workspaceId: string): void {
    this.#database
      .query(
        `UPDATE workspaces SET status = 'removed', removed_at = ? WHERE id = ?`,
      )
      .run(now(), workspaceId);
  }

  upsertPullRequest(input: {
    issueId: string;
    id: string;
    number: number;
    url: string;
    state: string;
    mergedAt?: string | null;
  }): void {
    const enrollment = this.#database
      .query(
        `SELECT id FROM enrollments WHERE issue_id = ? AND status = 'active'
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(input.issueId) as { id: string } | null;
    if (!enrollment) throw new Error(`issue ${input.issueId} has no active enrollment`);
    this.#database
      .query(
        `INSERT INTO pull_requests(
           id, enrollment_id, source_number, url, state, merged_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           merged_at = COALESCE(excluded.merged_at, pull_requests.merged_at),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        enrollment.id,
        input.number,
        input.url,
        input.state,
        input.mergedAt ?? null,
        now(),
      );
  }

  getCurrentPullRequest(issueId: string): StoredPullRequest | null {
    const row = this.#database
      .query(
        `SELECT p.*, e.issue_id
         FROM pull_requests p
         JOIN enrollments e ON e.id = p.enrollment_id
         WHERE e.issue_id = ? AND e.status = 'active'
         ORDER BY p.updated_at DESC, p.id DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      number: Number(row.source_number),
      url: String(row.url),
      state: String(row.state),
      mergedAt: row.merged_at === null ? null : String(row.merged_at),
      updatedAt: String(row.updated_at),
    };
  }

  hasMergedPullRequest(issueId: string): boolean {
    const row = this.#database
      .query(
        `SELECT 1 AS found FROM pull_requests p
         JOIN enrollments e ON e.id = p.enrollment_id
         WHERE e.issue_id = ? AND p.merged_at IS NOT NULL LIMIT 1`,
      )
      .get(issueId) as { found: number } | null;
    return row?.found === 1;
  }

  /**
   * Fences the item when the stage changes, or the status changes into anything other than
   * the executor's own bookkeeping statuses (ready, running, error, interrupted).
   */
  setStageState(state: {
    issueId: string;
    stageId: string;
    status: string;
    feedbackCycle: number;
    configHash: string;
  }): void {
    this.#database.transaction(() => {
      const before = this.getStageState(state.issueId);
      this.writeStageState(state);
      const stageChanged = before?.stageId !== state.stageId;
      const statusChanged = before?.status !== state.status;
      if (stageChanged || (statusChanged && !EXECUTOR_STATUSES.has(state.status))) {
        this.#executions.onStageChange(state.issueId);
      }
    })();
  }

  private writeStageState(state: {
    issueId: string;
    stageId: string;
    status: string;
    feedbackCycle: number;
    configHash: string;
  }): void {
    this.#database
      .query(
        `INSERT INTO stage_states(
           issue_id, stage_id, status, feedback_cycle, config_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           stage_id = excluded.stage_id,
           status = excluded.status,
           feedback_cycle = excluded.feedback_cycle,
           config_hash = excluded.config_hash,
           updated_at = CASE WHEN
             stage_states.stage_id IS NOT excluded.stage_id OR
             stage_states.status IS NOT excluded.status OR
             stage_states.feedback_cycle IS NOT excluded.feedback_cycle OR
             stage_states.config_hash IS NOT excluded.config_hash
           THEN excluded.updated_at ELSE stage_states.updated_at END`,
      )
      .run(
        state.issueId,
        state.stageId,
        state.status,
        state.feedbackCycle,
        state.configHash,
        now(),
      );
  }

  getStageState(issueId: string): StoredStageState | null {
    const row = this.#database
      .query("SELECT * FROM stage_states WHERE issue_id = ?")
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      status: String(row.status),
      feedbackCycle: Number(row.feedback_cycle),
      configHash: String(row.config_hash),
      updatedAt: String(row.updated_at),
    };
  }

  /** A completed journey entry that is not a label transition Conveyor applied (a resume, a restart). */
  recordJourneyEvent(input: { issueId: string; stage: string | null; kind: string; reason: string }): void {
    const id = randomUUID();
    this.beginStageTransition({
      id, issueId: input.issueId, fromStage: input.stage, toStage: input.stage, kind: input.kind, sourceMutationId: null,
      detail: { reason: input.reason, requiredFixes: [], resultStatus: null, actor: { name: "Conveyor", title: "Orchestrator" } },
    });
    this.completeStageTransition(id);
  }

  beginStageTransition(input: {
    id: string;
    issueId: string;
    fromStage: string | null;
    toStage: string | null;
    kind: string;
    sourceMutationId: string | null;
    detail: StageTransitionDetail;
  }): void {
    this.#database
      .query(
        `INSERT INTO stage_transitions(
           id, issue_id, from_stage, to_stage, status, source_mutation_id,
           created_at, completed_at, kind, detail_json
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.issueId,
        input.fromStage,
        input.toStage,
        input.sourceMutationId,
        now(),
        input.kind,
        json(input.detail),
      );
  }

  completeStageTransition(id: string): void {
    this.#database
      .query(
        `UPDATE stage_transitions
         SET status = 'completed', completed_at = ?
         WHERE id = ? AND status <> 'completed'`,
      )
      .run(now(), id);
  }

  failStageTransition(id: string): void {
    this.#database
      .query(
        `UPDATE stage_transitions
         SET status = 'failed', completed_at = ?
         WHERE id = ? AND status <> 'completed'`,
      )
      .run(now(), id);
  }

  listStageTransitions(issueId: string): StoredStageTransition[] {
    const rows = this.#database
      .query(
        `SELECT st.*, sm.error AS source_error
         FROM stage_transitions st
         LEFT JOIN source_mutations sm ON sm.id = st.source_mutation_id
         WHERE st.issue_id = ?
         ORDER BY st.created_at, st.id`,
      )
      .all(issueId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => {
      const detail = parseJson<Partial<StageTransitionDetail>>(String(row.detail_json)) ?? {};
      return {
        id: String(row.id),
        issueId: String(row.issue_id),
        fromStage: row.from_stage === null ? null : String(row.from_stage),
        toStage: row.to_stage === null ? null : String(row.to_stage),
        kind: String(row.kind),
        status: String(row.status),
        sourceMutationId:
          row.source_mutation_id === null ? null : String(row.source_mutation_id),
        error: row.source_error === null ? null : String(row.source_error),
        reason: typeof detail.reason === "string" ? detail.reason : null,
        requiredFixes: Array.isArray(detail.requiredFixes)
          ? detail.requiredFixes.filter((value): value is string => typeof value === "string")
          : [],
        resultStatus:
          typeof detail.resultStatus === "string" ? detail.resultStatus : null,
        actor:
          detail.actor && typeof detail.actor.name === "string"
            ? {
                name: detail.actor.name,
                title: typeof detail.actor.title === "string" ? detail.actor.title : null,
              }
            : null,
        createdAt: String(row.created_at),
        completedAt: row.completed_at === null ? null : String(row.completed_at),
      };
    });
  }

  private mapEnrollment(row: Record<string, SQLQueryBindings>): EnrollmentRecord {
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      generation: Number(row.generation),
      status: String(row.status),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
    };
  }

  private mapIssue(row: Record<string, SQLQueryBindings>): StoredIssue {
    return {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      sourceNumber: Number(row.source_number),
      sourceUrl: String(row.source_url),
      title: String(row.title),
      body: String(row.body),
      sourceState: String(row.source_state),
      sourceStateReason:
        row.source_state_reason === null ? null : String(row.source_state_reason),
      labels: parseJson<string[]>(String(row.labels_json)) ?? [],
      sourceUpdatedAt: String(row.source_updated_at),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      queueRank: row.queue_rank === null ? null : Number(row.queue_rank),
      projectedStage:
        row.projected_stage === null ? null : String(row.projected_stage),
      projectedState:
        row.projected_state === null ? null : String(row.projected_state),
      warning: row.warning === null ? null : String(row.warning),
    };
  }

  recordSourceEvent(event: {
    source: string;
    deliveryId: string;
    eventType: string;
    payload: unknown;
  }): boolean {
    const result = this.#database
      .query(
        `INSERT INTO source_events(source, delivery_id, event_type, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, delivery_id) DO NOTHING`,
      )
      .run(event.source, event.deliveryId, event.eventType, json(event.payload), now());
    return result.changes === 1;
  }

  beginSourceMutation(input: {
    idempotencyKey: string;
    source: string;
    operation: string;
    request: unknown;
  }): SourceMutation {
    const existing = this.getSourceMutationByKey(input.idempotencyKey);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = now();
    this.#database
      .query(
        `INSERT INTO source_mutations(
           id, idempotency_key, source, operation, status, request_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.idempotencyKey,
        input.source,
        input.operation,
        json(input.request),
        timestamp,
        timestamp,
      );
    return this.getSourceMutation(id)!;
  }

  completeSourceMutation(id: string, response: unknown): void {
    this.#database
      .query(
        `UPDATE source_mutations
         SET status = 'succeeded', response_json = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(json(response), now(), id);
  }

  failSourceMutation(id: string, error: string): void {
    this.#database
      .query(
        `UPDATE source_mutations
         SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, now(), id);
  }

  getSourceMutation(id: string): SourceMutation | null {
    const row = this.#database
      .query("SELECT * FROM source_mutations WHERE id = ?")
      .get(id) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapSourceMutation(row) : null;
  }

  private getSourceMutationByKey(key: string): SourceMutation | null {
    const row = this.#database
      .query("SELECT * FROM source_mutations WHERE idempotency_key = ?")
      .get(key) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapSourceMutation(row) : null;
  }

  private mapSourceMutation(row: Record<string, SQLQueryBindings>): SourceMutation {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      source: String(row.source),
      operation: String(row.operation),
      status: String(row.status),
      request: parseJson(String(row.request_json)),
      response:
        row.response_json === null ? null : parseJson(String(row.response_json)),
      error: row.error === null ? null : String(row.error),
    };
  }

  createRun(run: RunRecordInput): void {
    this.#database
      .query(
        `INSERT INTO runs(
           id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.issueId,
        run.stageId,
        run.attempt,
        run.kind,
        run.status,
        run.configHash,
        run.startedAt,
        run.startedAt,
      );
  }

  recoverInterruptedExecutions(configHash: string): { runs: number; stages: number } {
    return this.#database.transaction(() => {
      const timestamp = now();
      const interruptedRuns = this.#database
        .query("SELECT id, started_at FROM runs WHERE status = 'running'")
        .all() as Array<{ id: string; started_at: string }>;
      const result = {
        reason: "Conveyor restarted before this run completed.",
      };
      for (const run of interruptedRuns) {
        const startedAt = Date.parse(run.started_at);
        const durationMs = Number.isFinite(startedAt)
          ? Math.max(0, Date.parse(timestamp) - startedAt)
          : 0;
        this.#database
          .query(
            `UPDATE runs SET status = 'interrupted', finished_at = ?, heartbeat_at = ?,
               exit_code = NULL, result_json = ? WHERE id = ?`,
          )
          .run(timestamp, timestamp, json(result), run.id);
        this.#database
          .query(
            `INSERT INTO usage_cost_entries(
               id, run_id, input_tokens, output_tokens, cached_tokens, amount,
               currency, source, duration_ms, created_at
             ) VALUES (?, ?, 0, 0, 0, 0, 'USD', 'unavailable', ?, ?)`,
          )
          .run(randomUUID(), run.id, durationMs, timestamp);
      }

      const runningStages = this.#database
        .query("SELECT COUNT(*) AS count FROM stage_states WHERE status IN ('running', 'error')")
        .get() as { count: number };
      // 'error' stages were waiting on an in-memory retry timer that did not survive the restart.
      this.#database
        .query(
          `UPDATE stage_states SET status = 'ready', config_hash = ?, updated_at = ?
           WHERE status IN ('running', 'error')`,
        )
        .run(configHash, timestamp);
      return {
        runs: interruptedRuns.length,
        stages: Number(runningStages.count),
      };
    })();
  }

  nextRunAttempt(issueId: string, stageId: string, kind: string): number {
    const row = this.#database
      .query(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM runs
         WHERE issue_id = ? AND stage_id = ? AND kind = ?`,
      )
      .get(issueId, stageId, kind) as { attempt: number };
    return Number(row.attempt);
  }

  finishRun(
    runId: string,
    finish: {
      status: string;
      exitCode: number | null;
      result: unknown;
      sessionId: string | null;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        amount: number;
        currency: string;
        source: string;
        durationMs: number;
      };
    },
  ): void {
    this.#database.transaction(() => {
      const timestamp = now();
      const updated = this.#database
        .query(
          `UPDATE runs SET status = ?, session_id = ?, finished_at = ?,
             heartbeat_at = ?, exit_code = ?, result_json = ?
           WHERE id = ?`,
        )
        .run(
          finish.status,
          finish.sessionId,
          timestamp,
          timestamp,
          finish.exitCode,
          json(finish.result),
          runId,
        );
      if (updated.changes !== 1) throw new Error(`unknown run: ${runId}`);
      this.#database
        .query(
          `INSERT INTO usage_cost_entries(
             id, run_id, input_tokens, output_tokens, cached_tokens, amount,
             currency, source, duration_ms, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          runId,
          finish.usage.inputTokens,
          finish.usage.outputTokens,
          finish.usage.cachedTokens,
          finish.usage.amount,
          finish.usage.currency,
          finish.usage.source,
          finish.usage.durationMs,
          timestamp,
        );
    })();
  }

  getRun(runId: string): StoredRun | null {
    const row = this.#database
      .query("SELECT * FROM runs WHERE id = ?")
      .get(runId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      issueId: row.issue_id === null ? null : String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    };
  }

  /** Runs of a kind that logged an `execution` event with this key, newest first. */
  listRunsForExecution(issueId: string, stageId: string, kind: string, executionKey: string): StoredRun[] {
    const rows = this.#database
      .query(
        `SELECT r.id FROM runs r
         WHERE r.issue_id = ? AND r.stage_id = ? AND r.kind = ?
           AND EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = r.id AND e.type = 'execution'
               AND json_extract(e.payload_json, '$.idempotencyKey') = ?
           )
         ORDER BY r.started_at DESC, r.rowid DESC`,
      )
      .all(issueId, stageId, kind, executionKey) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  listActiveIssueRuns(): ActiveIssueRun[] {
    const rows = this.#database
      .query(
        `SELECT * FROM (
           SELECT r.id, r.issue_id, r.stage_id, r.kind, r.started_at,
             i.repository_id, i.source_number, i.title
           FROM runs r JOIN issues i ON i.id = r.issue_id
           WHERE r.status = 'running'
           UNION ALL
           SELECT 'orchestration:' || s.issue_id || ':' || s.stage_id AS id,
             s.issue_id, s.stage_id, 'orchestration' AS kind,
             s.updated_at AS started_at, i.repository_id, i.source_number, i.title
           FROM stage_states s JOIN issues i ON i.id = s.issue_id
           WHERE s.status = 'running'
             AND NOT EXISTS (
               SELECT 1 FROM runs r
               WHERE r.issue_id = s.issue_id AND r.status = 'running'
             )
         ) ORDER BY started_at, id`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      repository: String(row.repository_id),
      issueNumber: Number(row.source_number),
      issueTitle: String(row.title),
      stageId: String(row.stage_id),
      kind: String(row.kind),
      startedAt: String(row.started_at),
    }));
  }

  listIssueRuns(issueId: string): StoredRun[] {
    const rows = this.#database
      .query(
        `SELECT * FROM runs WHERE issue_id = ?
         ORDER BY started_at DESC, id DESC`,
      )
      .all(issueId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  listIssueRunsPage(
    issueId: string,
    options: { before?: string | undefined; limit: number },
  ): { runs: StoredRun[]; nextBefore: string | null } {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) {
      throw new Error("issue run page limit must be between 1 and 20");
    }
    let rows: Array<Record<string, SQLQueryBindings>>;
    if (options.before) {
      const cursor = this.#database
        .query("SELECT started_at, id FROM runs WHERE id = ? AND issue_id = ?")
        .get(options.before, issueId) as { started_at: string; id: string } | null;
      if (!cursor) return { runs: [], nextBefore: null };
      rows = this.#database
        .query(
          `SELECT * FROM runs WHERE issue_id = ?
           AND (started_at < ? OR (started_at = ? AND id < ?))
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(issueId, cursor.started_at, cursor.started_at, cursor.id, options.limit + 1) as Array<Record<string, SQLQueryBindings>>;
    } else {
      rows = this.#database
        .query(
          `SELECT * FROM runs WHERE issue_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(issueId, options.limit + 1) as Array<Record<string, SQLQueryBindings>>;
    }
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const runs = page.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
    return {
      runs,
      nextBefore: hasMore ? (runs.at(-1)?.id ?? null) : null,
    };
  }

  listRunsByKind(kind: string, limit = 10): Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("run list limit must be between 1 and 100");
    }
    const rows = this.#database
      .query(
        `SELECT id, status, started_at, finished_at FROM runs
         WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(kind, limit) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  dashboardRevision(): string {
    const rows = this.#database
      .query(
        `SELECT 'issues' AS source, COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated FROM issues
         UNION ALL
         SELECT 'stages', COUNT(*), COALESCE(MAX(updated_at), '') FROM stage_states
         UNION ALL
         SELECT 'runs', COUNT(*), COALESCE(MAX(COALESCE(finished_at, started_at)), '') FROM runs
         UNION ALL
         SELECT 'questions', COUNT(*), COALESCE(MAX(COALESCE(answered_at, created_at)), '') FROM questions
         UNION ALL
         SELECT 'todos', COUNT(*), COALESCE(MAX(updated_at), '') FROM item_todos`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows
      .map((row) => `${String(row.source)}:${Number(row.count)}:${String(row.updated)}`)
      .join("|");
  }

  conversationRevision(): string {
    const row = this.#database
      .query(
        `SELECT COUNT(*) AS count, COALESCE(MAX(created_at), '') AS updated
         FROM conversation_messages`,
      )
      .get() as Record<string, SQLQueryBindings>;
    return `${Number(row.count)}:${String(row.updated)}`;
  }

  activityRevision(): string {
    const rows = this.#database
      .query(
        `SELECT 'runs' AS source, COUNT(*) AS count,
           COALESCE(MAX(COALESCE(finished_at, started_at)), '') AS updated FROM runs
         UNION ALL
         SELECT 'run_events', COUNT(*), COALESCE(MAX(created_at), '') FROM run_events`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows
      .map((row) => `${String(row.source)}:${Number(row.count)}:${String(row.updated)}`)
      .join("|");
  }

  latestRunSummary(issueId: string): {
    id: string;
    status: string;
    durationMs: number | null;
    inputTokens: number;
    outputTokens: number;
    amount: number | null;
    costSource: string | null;
  } | null {
    const row = this.#database
      .query(
        `SELECT r.id, r.status, u.duration_ms, u.input_tokens, u.output_tokens,
           u.amount, u.source AS cost_source
         FROM runs r
         LEFT JOIN usage_cost_entries u ON u.run_id = r.id
         WHERE r.issue_id = ?
         ORDER BY r.started_at DESC, r.id DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      inputTokens: row.input_tokens === null ? 0 : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens),
      amount: row.amount === null ? null : Number(row.amount),
      costSource: row.cost_source === null ? null : String(row.cost_source),
    };
  }

  costSummary(filters: { issueId?: string; stageId?: string } = {}): {
    runs: number;
    amount: number;
    currency: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    unavailableRuns: number;
  } {
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filters.issueId) {
      conditions.push("r.issue_id = ?");
      bindings.push(filters.issueId);
    }
    if (filters.stageId) {
      conditions.push("r.stage_id = ?");
      bindings.push(filters.stageId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.#database
      .query(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(duration_ms), 0) AS duration_ms,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
           COALESCE(SUM(CASE WHEN source = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_runs
         FROM usage_cost_entries u JOIN runs r ON r.id = u.run_id ${where}`,
      )
      .get(...bindings) as Record<string, SQLQueryBindings>;
    return {
      runs: Number(row.runs),
      amount: Number(row.amount),
      currency: "USD",
      durationMs: Number(row.duration_ms),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedTokens: Number(row.cached_tokens),
      unavailableRuns: Number(row.unavailable_runs),
    };
  }

  moveQueueIssue(issueId: string, direction: "up" | "down"): void {
    this.#database.transaction(() => {
      const issues = this.#database
        .query(
          `SELECT id, queue_rank FROM issues
           WHERE parent_id IS NULL AND queue_rank IS NOT NULL
           ORDER BY queue_rank, id`,
        )
        .all() as Array<{ id: string; queue_rank: number }>;
      const index = issues.findIndex((issue) => issue.id === issueId);
      if (index < 0) throw new Error("only queued top-level issues can be reordered");
      const otherIndex = direction === "up" ? index - 1 : index + 1;
      const current = issues[index];
      const other = issues[otherIndex];
      if (!current || !other) return;
      const timestamp = now();
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(other.queue_rank, timestamp, current.id);
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(current.queue_rank, timestamp, other.id);
    })();
  }

  /**
   * Place a queued top-level issue immediately before another one, or last when
   * `beforeIssueId` is null. Ranks are fractional, so only the moved issue is
   * rewritten; the queue is renumbered when neighbouring ranks get too close.
   */
  moveQueueIssueBefore(issueId: string, beforeIssueId: string | null): void {
    this.#database.transaction(() => {
      const load = () => this.#database
        .query(
          `SELECT id, queue_rank FROM issues
           WHERE parent_id IS NULL AND queue_rank IS NOT NULL
           ORDER BY queue_rank, id`,
        )
        .all() as Array<{ id: string; queue_rank: number }>;
      let issues = load();
      if (!issues.some((issue) => issue.id === issueId)) {
        throw new Error("only queued top-level issues can be reordered");
      }
      if (beforeIssueId === issueId) return;
      if (beforeIssueId !== null && !issues.some((issue) => issue.id === beforeIssueId)) {
        throw new Error("the target position is not a queued top-level issue");
      }
      const target = () => {
        const others = issues.filter((issue) => issue.id !== issueId);
        if (beforeIssueId === null) return (others.at(-1)?.queue_rank ?? 0) + 1;
        const index = others.findIndex((issue) => issue.id === beforeIssueId);
        const next = others[index]!.queue_rank;
        const previous = others[index - 1]?.queue_rank;
        return previous === undefined ? next - 1 : (previous + next) / 2;
      };
      let rank = target();
      const neighbours = issues.filter((issue) => issue.id !== issueId).map((issue) => issue.queue_rank);
      if (neighbours.some((value) => Math.abs(value - rank) < 1e-6)) {
        const renumber = this.#database.query("UPDATE issues SET queue_rank = ? WHERE id = ?");
        issues.forEach((issue, index) => renumber.run(index + 1, issue.id));
        issues = load();
        rank = target();
      }
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(rank, now(), issueId);
    })();
  }

  openQuestion(input: {
    issueId: string;
    runId: string | null;
    prompt: string;
    reason: string;
    options: unknown[];
    minSelections?: number;
    maxSelections?: number;
    allowFreeText?: boolean;
  }): StoredQuestion {
    return this.#database.transaction(() => {
      const existing = this.#database
        .query("SELECT id FROM questions WHERE issue_id = ? AND status = 'open'")
        .get(input.issueId) as { id: string } | null;
      if (existing) return this.getQuestion(existing.id)!;
      const id = randomUUID();
      this.#database
        .query(
          `INSERT INTO questions(
             id, issue_id, run_id, prompt, reason, options_json,
             min_selections, max_selections, allow_free_text, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          input.issueId,
          input.runId,
          input.prompt,
          input.reason,
          json(input.options),
          input.minSelections ?? 1,
          input.maxSelections ?? 1,
          input.allowFreeText ? 1 : 0,
          now(),
        );
      return this.getQuestion(id)!;
    })();
  }

  answerQuestion(questionId: string, source: string, answer: unknown): void {
    this.#database.transaction(() => {
      const question = this.getQuestion(questionId);
      if (!question) throw new Error(`unknown question: ${questionId}`);
      if (question.status !== "open") throw new Error("question is no longer open");
      const timestamp = now();
      this.#database
        .query(
          `INSERT INTO answers(id, question_id, source, answer_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), questionId, source, json(answer), timestamp);
      this.#database
        .query("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?")
        .run(timestamp, questionId);
    })();
  }

  getQuestion(questionId: string): StoredQuestion | null {
    const row = this.#database
      .query(
        `SELECT q.*, a.answer_json
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.id = ?`,
      )
      .get(questionId) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapQuestion(row) : null;
  }

  /** The question a run opened (an issue has at most one open question at a time). */
  getQuestionForRun(runId: string): StoredQuestion | null {
    const row = this.#database
      .query(
        `SELECT q.*, a.answer_json
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.run_id = ? ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1`,
      )
      .get(runId) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapQuestion(row) : null;
  }

  listOpenQuestions(): StoredQuestion[] {
    const rows = this.#database
      .query(
        `SELECT q.*, NULL AS answer_json FROM questions q
         WHERE q.status = 'open' ORDER BY q.created_at, q.id`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => this.mapQuestion(row));
  }

  private mapQuestion(row: Record<string, SQLQueryBindings>): StoredQuestion {
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      runId: row.run_id === null ? null : String(row.run_id),
      prompt: String(row.prompt),
      reason: String(row.reason),
      options: parseJson<unknown[]>(String(row.options_json)) ?? [],
      minSelections: Number(row.min_selections),
      maxSelections: Number(row.max_selections),
      allowFreeText: Number(row.allow_free_text) === 1,
      status: String(row.status),
      createdAt: String(row.created_at),
      answeredAt: row.answered_at === null ? null : String(row.answered_at),
      answer:
        row.answer_json === null ? null : parseJson(String(row.answer_json)),
    };
  }

  appendRunEvent(runId: string, type: string, payload: unknown): number {
    return this.#database.transaction(() => {
      const row = this.#database
        .query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?",
        )
        .get(runId) as { sequence: number };
      this.#database
        .query(
          `INSERT INTO run_events(run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, row.sequence, type, json(payload), now());
      return row.sequence;
    })();
  }

  listHarnessRunEvents(): Array<{ agentId: string; payload: unknown; createdAt: string }> {
    const rows = this.#database.query(
      `SELECT h.payload_json, h.created_at, e.payload_json AS execution_json
       FROM run_events h
       JOIN run_events e ON e.run_id = h.run_id AND e.type = 'execution'
       WHERE h.type = 'harness'
         AND json_extract(h.payload_json, '$.type') = 'rate_limit_event'
       ORDER BY h.id DESC
       LIMIT 1000`,
    ).all() as Array<Record<string, SQLQueryBindings>>;
    return rows.flatMap((row) => {
      const execution = parseJson<Record<string, unknown>>(String(row.execution_json));
      return typeof execution?.agentId === "string"
        ? [{
            agentId: execution.agentId,
            payload: parseJson(String(row.payload_json)),
            createdAt: String(row.created_at),
          }]
        : [];
    });
  }

  listRunEvents(runId: string): Array<{
    sequence: number;
    type: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.#database
      .query(
        `SELECT sequence, type, payload_json, created_at
         FROM run_events WHERE run_id = ? ORDER BY sequence`,
      )
      .all(runId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.type),
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
  }

  listRunEventsPage(
    runId: string,
    options: { before?: number | undefined; limit: number },
  ): {
    events: Array<{ sequence: number; type: string; payload: unknown; createdAt: string }>;
    nextBefore: number | null;
  } {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("run event page limit must be between 1 and 100");
    }
    const rows = (options.before === undefined
      ? this.#database
        .query(
          `SELECT sequence, type, payload_json, created_at
           FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?`,
        )
        .all(runId, options.limit + 1)
      : this.#database
        .query(
          `SELECT sequence, type, payload_json, created_at
           FROM run_events WHERE run_id = ? AND sequence < ?
           ORDER BY sequence DESC LIMIT ?`,
        )
        .all(runId, options.before, options.limit + 1)) as Array<Record<string, SQLQueryBindings>>;
    const hasMore = rows.length > options.limit;
    const events = rows.slice(0, options.limit).map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.type),
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
    return {
      events,
      nextBefore: hasMore ? (events.at(-1)?.sequence ?? null) : null,
    };
  }

  appendConversationMessage(input: {
    issueId: string;
    runId: string | null;
    stageId: string | null;
    actorType: "agent" | "user" | "conveyor";
    actorId: string;
    actorName: string;
    actorTitle: string | null;
    message: string;
  }): StoredConversationMessage {
    let message = input.message.trim();
    if (!message) throw new Error("conversation message must not be empty");
    if (message.length > CONVERSATION_MESSAGE_LIMIT) {
      // A person's message is validated where it is typed. A message Conveyor or an agent produces
      // (e.g. a CI failure with logs) is trimmed: dropping it would fail the stage that reports it.
      if (input.actorType === "user") throw new Error("conversation message must not exceed 4000 characters");
      message = trimToLimit(message);
    }
    const createdAt = now();
    const result = this.#database
      .query(
        `INSERT INTO conversation_messages(
           issue_id, run_id, stage_id, actor_type, actor_id, actor_name,
           actor_title, message, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issueId,
        input.runId,
        input.stageId,
        input.actorType,
        input.actorId,
        input.actorName,
        input.actorTitle,
        message,
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      ...input,
      message,
      createdAt,
    };
  }

  listConversationMessages(issueId: string, limit = 100): StoredConversationMessage[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("conversation message limit must be between 1 and 200");
    }
    const rows = this.#database
      .query(
        `SELECT * FROM (
           SELECT * FROM conversation_messages
           WHERE issue_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id`,
      )
      .all(issueId, limit) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: Number(row.id),
      issueId: String(row.issue_id),
      runId: row.run_id === null ? null : String(row.run_id),
      stageId: row.stage_id === null ? null : String(row.stage_id),
      actorType: String(row.actor_type),
      actorId: String(row.actor_id),
      actorName: String(row.actor_name),
      actorTitle: row.actor_title === null ? null : String(row.actor_title),
      message: String(row.message),
      createdAt: String(row.created_at),
    }));
  }
}
