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
           parent_id = excluded.parent_id,
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

  getIssue(issueId: string): StoredIssue | null {
    const row = this.#database
      .query("SELECT * FROM issues WHERE id = ?")
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
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
