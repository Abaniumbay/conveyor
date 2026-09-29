import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

export class ConveyorStore {
  readonly #database: Database;

  private constructor(database: Database) {
    this.#database = database;
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

  pragma(name: "journal_mode" | "foreign_keys"): unknown[] {
    return this.#database.query(`PRAGMA ${name}`).all();
  }

  schemaVersion(): number {
    const row = this.#database
      .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
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

  upsertIssue(issue: IssueProjection): void {
    const timestamp = now();
    const labels = [...new Set(issue.labels)].sort((left, right) => left.localeCompare(right));
    this.#database
      .query(
        `INSERT INTO issues(
           id, repository_id, source_number, source_url, title, body, source_state,
           labels_json, source_updated_at, parent_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repository_id = excluded.repository_id,
           source_number = excluded.source_number,
           source_url = excluded.source_url,
           title = excluded.title,
           body = excluded.body,
           source_state = excluded.source_state,
           labels_json = excluded.labels_json,
           source_updated_at = excluded.source_updated_at,
           parent_id = COALESCE(excluded.parent_id, issues.parent_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        issue.id,
        issue.repositoryId,
        issue.sourceNumber,
        issue.sourceUrl,
        issue.title,
        issue.body,
        issue.sourceState,
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

  setIssueProjection(
    issueId: string,
    projection: { stage: string | null; state: string | null; warning: string | null },
  ): void {
    this.#database
      .query(
        `UPDATE issues
         SET projected_stage = ?, projected_state = ?, warning = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        projection.stage,
        projection.state,
        projection.warning,
        now(),
        issueId,
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
      for (const blockerId of new Set(blockers)) {
        if (blockerId === issueId) throw new Error("an issue cannot depend on itself");
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

  private mapIssue(row: Record<string, SQLQueryBindings>): StoredIssue {
    return {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      sourceNumber: Number(row.source_number),
      sourceUrl: String(row.source_url),
      title: String(row.title),
      body: String(row.body),
      sourceState: String(row.source_state),
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
}
