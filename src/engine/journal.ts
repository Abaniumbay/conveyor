// Durable execution storage: item context and history, task execution journal,
// stage cursor, stage epochs (fencing tokens) and due wake-ups.

import type { Database } from "bun:sqlite";

import type { Feedback, TaskContext, TaskExecutionRecord } from "../tasks/context";

export const DEFAULT_CONTEXT_SUMMARY_BYTES = 65536;

export class StaleEpochError extends Error {
  constructor(
    readonly issueId: string,
    readonly expectedEpoch: number,
    readonly actualEpoch: number,
  ) {
    super(`Stale stage epoch for ${issueId}: expected ${expectedEpoch}, current is ${actualEpoch}`);
    this.name = "StaleEpochError";
  }
}

export interface StageCursor {
  issueId: string;
  stage: string;
  stageEpoch: number;
  attempt: number;
  returns: number;
  list: "actions" | "exit-gate";
  taskInstanceId: string | null;
  state: "planned" | "running" | "pending" | "completed";
  feedback: Feedback | null;
  pendingSince: string | null;
  wakeAt: string | null;
  deadlineAt: string | null;
}

export type CiMarkKind = "first-seen" | "announced" | "rerun" | "started";

export interface StoredContext {
  context: TaskContext;
  version: number;
  stageEpoch: number;
}

export interface ContextHistoryRow {
  version: number;
  stage: string;
  stageEpoch: number;
  taskInstanceId: string;
  context: TaskContext;
  createdAt: string;
}

export interface IdempotencyFields {
  issueId: string;
  stage: string;
  stageEpoch: number;
  attempt: number;
  taskInstanceId: string;
}

export type PlannedExecution = Pick<
  TaskExecutionRecord,
  "itemId" | "stage" | "stageEpoch" | "attempt" | "list" | "taskInstanceId"
> &
  Partial<Pick<TaskExecutionRecord, "recoveryState">>;

export interface ExecutionStoreOptions {
  contextSummaryBytes?: number;
  now?: () => Date;
}

interface ExecutionRow {
  id: string;
  issue_id: string;
  stage: string;
  stage_epoch: number;
  attempt: number;
  list: TaskExecutionRecord["list"];
  task_instance_id: string;
  idempotency_key: string;
  state: TaskExecutionRecord["state"];
  recovery_state: TaskExecutionRecord["recoveryState"];
  started_at: string;
  pending_since: string | null;
  wake_at: string | null;
  deadline_at: string | null;
  result_json: string | null;
}

interface CursorRow {
  issue_id: string;
  stage: string;
  stage_epoch: number;
  attempt: number;
  returns: number;
  list: StageCursor["list"];
  task_instance_id: string | null;
  state: StageCursor["state"];
  feedback_json: string | null;
  pending_since: string | null;
  wake_at: string | null;
  deadline_at: string | null;
}

export class ExecutionStore {
  readonly #db: Database;
  readonly #limit: number;
  readonly #now: () => Date;

  constructor(database: Database, options: ExecutionStoreOptions = {}) {
    this.#db = database;
    this.#limit = options.contextSummaryBytes ?? DEFAULT_CONTEXT_SUMMARY_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #fence(issueId: string, expectedEpoch: number): void {
    const actual = this.stageEpoch(issueId);
    if (actual !== expectedEpoch) throw new StaleEpochError(issueId, expectedEpoch, actual);
  }

  #fenced<T>(issueId: string, expectedEpoch: number, work: () => T): T {
    return this.#db.transaction(() => {
      this.#fence(issueId, expectedEpoch);
      return work();
    }).immediate();
  }

  // Context and epochs

  getContext(issueId: string): StoredContext | null {
    const row = this.#db
      .query("SELECT context_json, version, stage_epoch FROM item_contexts WHERE issue_id = ?")
      .get(issueId) as { context_json: string; version: number; stage_epoch: number } | null;
    // A row created only by bumpStageEpoch has no context yet (version 0).
    if (!row || row.version === 0) return null;
    return {
      context: JSON.parse(row.context_json) as TaskContext,
      version: row.version,
      stageEpoch: row.stage_epoch,
    };
  }

  stageEpoch(issueId: string): number {
    const row = this.#db
      .query("SELECT stage_epoch FROM item_contexts WHERE issue_id = ?")
      .get(issueId) as { stage_epoch: number } | null;
    return row?.stage_epoch ?? 0;
  }

  bumpStageEpoch(issueId: string): number {
    const row = this.#db
      .query(
        `INSERT INTO item_contexts(issue_id, schema_version, config_hash, version, stage_epoch, context_json, updated_at)
         VALUES (?, 0, '', 0, 1, 'null', ?)
         ON CONFLICT(issue_id) DO UPDATE SET stage_epoch = stage_epoch + 1, updated_at = excluded.updated_at
         RETURNING stage_epoch`,
      )
      .get(issueId, this.#timestamp()) as { stage_epoch: number };
    return row.stage_epoch;
  }

  /**
   * Fences off everything running for the item: bumps the stage epoch and drops the
   * stage cursor in one transaction, so a late completion from the old stage, state or
   * enrollment can no longer mutate or advance it. Returns the new epoch.
   */
  onStageChange(issueId: string): number {
    return this.#db.transaction(() => {
      const epoch = this.bumpStageEpoch(issueId);
      this.clearCursor(issueId, epoch);
      return epoch;
    })();
  }

  /** Persists the context, appends a history row and returns the new version. */
  saveContext(
    issueId: string,
    context: TaskContext,
    meta: { stage: string; taskInstanceId: string; expectedEpoch: number },
  ): number {
    const json = JSON.stringify(context);
    const size = Buffer.byteLength(json);
    if (size > this.#limit) {
      throw new Error(
        `Context for ${issueId} is ${size} bytes, over the ${this.#limit} byte limit; largest key is "${largestKey(context)}"`,
      );
    }
    return this.#fenced(issueId, meta.expectedEpoch, () => {
      const at = this.#timestamp();
      const row = this.#db
        .query(
          `INSERT INTO item_contexts(issue_id, schema_version, config_hash, version, stage_epoch, context_json, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(issue_id) DO UPDATE SET
             schema_version = excluded.schema_version,
             config_hash = excluded.config_hash,
             version = version + 1,
             context_json = excluded.context_json,
             updated_at = excluded.updated_at
           RETURNING version`,
        )
        .get(issueId, context.schemaVersion, context.configHash, meta.expectedEpoch, json, at) as {
        version: number;
      };
      this.#db
        .query(
          `INSERT INTO context_history(issue_id, version, stage, stage_epoch, task_instance_id, context_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(issueId, row.version, meta.stage, meta.expectedEpoch, meta.taskInstanceId, json, at);
      return row.version;
    });
  }

  contextHistory(issueId: string): ContextHistoryRow[] {
    const rows = this.#db
      .query(
        `SELECT version, stage, stage_epoch, task_instance_id, context_json, created_at
         FROM context_history WHERE issue_id = ? ORDER BY id`,
      )
      .all(issueId) as Array<{
      version: number;
      stage: string;
      stage_epoch: number;
      task_instance_id: string;
      context_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      version: row.version,
      stage: row.stage,
      stageEpoch: row.stage_epoch,
      taskInstanceId: row.task_instance_id,
      context: JSON.parse(row.context_json) as TaskContext,
      createdAt: row.created_at,
    }));
  }

  // Task execution journal

  idempotencyKey(fields: IdempotencyFields): string {
    return new Bun.CryptoHasher("sha256")
      .update(
        [fields.issueId, fields.stage, fields.stageEpoch, fields.attempt, fields.taskInstanceId].join("\u0000"),
      )
      .digest("hex");
  }

  planExecution(input: PlannedExecution): { record: TaskExecutionRecord; resumed: boolean } {
    return this.#fenced(input.itemId, input.stageEpoch, () => {
      const key = this.idempotencyKey({
        issueId: input.itemId,
        stage: input.stage,
        stageEpoch: input.stageEpoch,
        attempt: input.attempt,
        taskInstanceId: input.taskInstanceId,
      });
      const existing = this.#db
        .query("SELECT * FROM task_executions WHERE idempotency_key = ?")
        .get(key) as ExecutionRow | null;
      if (existing) return { record: toRecord(existing), resumed: true };
      const at = this.#timestamp();
      const id = crypto.randomUUID();
      this.#db
        .query(
          `INSERT INTO task_executions(
             id, issue_id, stage, stage_epoch, attempt, list, task_instance_id, idempotency_key,
             state, recovery_state, started_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
        )
        .run(
          id, input.itemId, input.stage, input.stageEpoch, input.attempt, input.list,
          input.taskInstanceId, key, input.recoveryState ?? "not-needed", at, at,
        );
      return { record: this.#execution(id), resumed: false };
    });
  }

  /**
   * Records a CI gate fact once per (item, head, kind, name). Returns whether this call recorded
   * it and when it was first recorded, so a repeat (or a restart) sees the original.
   */
  markCi(issueId: string, headSha: string, kind: CiMarkKind, name: string, at: string): { fresh: boolean; at: string } {
    const inserted = this.#db
      .query("INSERT OR IGNORE INTO ci_marks(issue_id, head_sha, kind, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(issueId, headSha, kind, name, at);
    const row = this.#db
      .query("SELECT created_at FROM ci_marks WHERE issue_id = ? AND head_sha = ? AND kind = ? AND name = ?")
      .get(issueId, headSha, kind, name) as { created_at: string };
    return { fresh: inserted.changes > 0, at: row.created_at };
  }

  ciMarks(issueId: string, headSha: string, kind: CiMarkKind): string[] {
    const rows = this.#db
      .query("SELECT name FROM ci_marks WHERE issue_id = ? AND head_sha = ? AND kind = ? ORDER BY created_at, name")
      .all(issueId, headSha, kind) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  getExecution(id: string): TaskExecutionRecord | null {
    const row = this.#db.query("SELECT * FROM task_executions WHERE id = ?").get(id) as ExecutionRow | null;
    return row ? toRecord(row) : null;
  }

  #execution(id: string): TaskExecutionRecord {
    const record = this.getExecution(id);
    if (!record) throw new Error(`Unknown task execution ${id}`);
    return record;
  }

  #update(id: string, expectedEpoch: number, assignments: string, ...values: Array<string | null>): TaskExecutionRecord {
    const current = this.#execution(id);
    return this.#fenced(current.itemId, expectedEpoch, () => {
      this.#db
        .query(`UPDATE task_executions SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...values, this.#timestamp(), id);
      return this.#execution(id);
    });
  }

  markRunning(id: string, expectedEpoch: number): TaskExecutionRecord {
    return this.#update(id, expectedEpoch, "state = 'running'");
  }

  /**
   * Keeps the first pending_since and deadline_at across repeated polls. The latest
   * `message` is stored as the record's result so a timeout can quote it without
   * re-invoking the task.
   */
  markPending(
    id: string,
    times: { wakeAt: string | null; deadlineAt: string | null; message?: string },
    expectedEpoch: number,
  ): TaskExecutionRecord {
    return this.#update(
      id,
      expectedEpoch,
      `state = 'pending', wake_at = ?,
       pending_since = COALESCE(pending_since, ?),
       deadline_at = COALESCE(deadline_at, ?),
       result_json = ?`,
      times.wakeAt,
      this.#timestamp(),
      times.deadlineAt,
      times.message === undefined ? null : JSON.stringify({ status: "pending", message: times.message }),
    );
  }

  completeExecution(id: string, result: unknown, expectedEpoch: number): TaskExecutionRecord {
    return this.#update(id, expectedEpoch, "state = 'completed', result_json = ?", JSON.stringify(result ?? null));
  }

  failExecution(id: string, result: unknown, expectedEpoch: number): TaskExecutionRecord {
    return this.#update(id, expectedEpoch, "state = 'failed', result_json = ?", JSON.stringify(result ?? null));
  }

  // Stage cursor and wake-ups

  getCursor(issueId: string): StageCursor | null {
    const row = this.#db
      .query("SELECT * FROM stage_cursors WHERE issue_id = ?")
      .get(issueId) as CursorRow | null;
    if (!row) return null;
    return {
      issueId: row.issue_id,
      stage: row.stage,
      stageEpoch: row.stage_epoch,
      attempt: row.attempt,
      returns: row.returns,
      list: row.list,
      taskInstanceId: row.task_instance_id,
      state: row.state,
      feedback: row.feedback_json === null ? null : (JSON.parse(row.feedback_json) as Feedback),
      pendingSince: row.pending_since,
      wakeAt: row.wake_at,
      deadlineAt: row.deadline_at,
    };
  }

  saveCursor(cursor: StageCursor, expectedEpoch: number): void {
    this.#fenced(cursor.issueId, expectedEpoch, () => {
      this.#db
        .query(
          `INSERT INTO stage_cursors(
             issue_id, stage, stage_epoch, attempt, returns, list, task_instance_id, state,
             feedback_json, pending_since, wake_at, deadline_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(issue_id) DO UPDATE SET
             stage = excluded.stage, stage_epoch = excluded.stage_epoch, attempt = excluded.attempt,
             returns = excluded.returns, list = excluded.list, task_instance_id = excluded.task_instance_id,
             state = excluded.state, feedback_json = excluded.feedback_json,
             pending_since = excluded.pending_since, wake_at = excluded.wake_at,
             deadline_at = excluded.deadline_at, updated_at = excluded.updated_at`,
        )
        .run(
          cursor.issueId, cursor.stage, cursor.stageEpoch, cursor.attempt, cursor.returns, cursor.list,
          cursor.taskInstanceId, cursor.state,
          cursor.feedback === null ? null : JSON.stringify(cursor.feedback),
          cursor.pendingSince, cursor.wakeAt, cursor.deadlineAt, this.#timestamp(),
        );
    });
  }

  clearCursor(issueId: string, expectedEpoch: number): void {
    this.#fenced(issueId, expectedEpoch, () => {
      this.#db.query("DELETE FROM stage_cursors WHERE issue_id = ?").run(issueId);
    });
  }

  wakeAt(issueId: string): string | null {
    const row = this.#db
      .query("SELECT wake_at FROM stage_cursors WHERE issue_id = ?")
      .get(issueId) as { wake_at: string | null } | null;
    return row?.wake_at ?? null;
  }

  /**
   * Makes a parked item schedulable now (an answer arrived). Only a pending cursor is
   * touched; its deadline is unchanged. Returns whether a parked cursor was woken.
   */
  wakeNow(issueId: string): boolean {
    const result = this.#db
      .query("UPDATE stage_cursors SET wake_at = ?, updated_at = ? WHERE issue_id = ? AND state = 'pending'")
      .run(this.#timestamp(), this.#timestamp(), issueId);
    return result.changes > 0;
  }

  /** The earliest persisted wake-up strictly after `now`, or null. */
  nextWakeupAfter(now: Date): string | null {
    const row = this.#db
      .query("SELECT MIN(wake_at) AS wake_at FROM stage_cursors WHERE wake_at > ?")
      .get(now.toISOString()) as { wake_at: string | null } | null;
    return row?.wake_at ?? null;
  }

  /** The latest pending message of a parked item's current task, for the board status line. */
  pendingMessage(issueId: string): string | null {
    const row = this.#db
      .query(
        `SELECT e.result_json FROM stage_cursors c
         JOIN task_executions e
           ON e.issue_id = c.issue_id AND e.stage = c.stage AND e.stage_epoch = c.stage_epoch
          AND e.attempt = c.attempt AND e.task_instance_id = c.task_instance_id
         WHERE c.issue_id = ? AND c.state = 'pending' AND e.state = 'pending'`,
      )
      .get(issueId) as { result_json: string | null } | null;
    if (!row?.result_json) return null;
    const message = (JSON.parse(row.result_json) as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }

  listDueWakeups(now: Date): string[] {
    const rows = this.#db
      .query("SELECT issue_id FROM stage_cursors WHERE wake_at IS NOT NULL AND wake_at <= ? ORDER BY wake_at, issue_id")
      .all(now.toISOString()) as Array<{ issue_id: string }>;
    return rows.map((row) => row.issue_id);
  }
}

function toRecord(row: ExecutionRow): TaskExecutionRecord {
  return {
    id: row.id,
    itemId: row.issue_id,
    stage: row.stage,
    stageEpoch: row.stage_epoch,
    attempt: row.attempt,
    list: row.list,
    taskInstanceId: row.task_instance_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    recoveryState: row.recovery_state,
    startedAt: row.started_at,
    pendingSince: row.pending_since,
    wakeAt: row.wake_at,
    deadlineAt: row.deadline_at,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
  };
}

function largestKey(context: TaskContext): string {
  let largest = "";
  let largestSize = -1;
  for (const [key, value] of Object.entries(context)) {
    const size = Buffer.byteLength(JSON.stringify(value) ?? "");
    if (size > largestSize) {
      largest = key;
      largestSize = size;
    }
  }
  return largest;
}
