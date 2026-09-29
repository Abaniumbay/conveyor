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

export interface StoredStageState {
  issueId: string;
  stageId: string;
  status: string;
  feedbackCycle: number;
  configHash: string;
  updatedAt: string;
}

export interface StoredQuestion {
  id: string;
  issueId: string;
  runId: string | null;
  prompt: string;
  reason: string;
  options: unknown[];
  status: string;
  createdAt: string;
  answeredAt: string | null;
  answer: unknown | null;
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
      this.#database
        .query(
          `UPDATE enrollments SET status = ?, ended_at = ?
           WHERE issue_id = ? AND status = 'active'`,
        )
        .run(status, timestamp, issueId);
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

  setStageState(state: {
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
           updated_at = excluded.updated_at`,
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

  getRun(runId: string): {
    id: string;
    issueId: string | null;
    stageId: string;
    attempt: number;
    kind: string;
    status: string;
    sessionId: string | null;
    result: unknown | null;
  } | null {
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
    };
  }

  costSummary(): {
    runs: number;
    amount: number;
    currency: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  } {
    const row = this.#database
      .query(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(duration_ms), 0) AS duration_ms,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cached_tokens), 0) AS cached_tokens
         FROM usage_cost_entries`,
      )
      .get() as Record<string, SQLQueryBindings>;
    return {
      runs: Number(row.runs),
      amount: Number(row.amount),
      currency: "USD",
      durationMs: Number(row.duration_ms),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedTokens: Number(row.cached_tokens),
    };
  }

  openQuestion(input: {
    issueId: string;
    runId: string | null;
    prompt: string;
    reason: string;
    options: unknown[];
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
             id, issue_id, run_id, prompt, reason, options_json, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          input.issueId,
          input.runId,
          input.prompt,
          input.reason,
          json(input.options),
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
