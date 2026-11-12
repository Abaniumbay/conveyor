// The read-only queries behind the Reports view, the finding report and the repository summaries.
// Each returns raw rows; the reports themselves are assembled in src/app.

import type { Database } from "bun:sqlite";

export interface ReportIssueRow { id: string; repository_id: string; source_number: number; title: string; source_state: string; projected_state: string | null }
export interface ReportRunRow { issue_id: string; stage_id: string; status: string; started_at: string; finished_at: string | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null }
export interface ReportTransitionRow { issue_id: string; kind: string; from_stage: string | null; to_stage: string | null; status: string; created_at: string }
export interface ReportWaitRow { issue_id: string; pending_since: string; updated_at: string }
export interface ReportEnrollmentRow { issue_id: string; started_at: string }
export interface ReportFindingRow { id: string; issue_id: string; run_id: string | null; provider_key: string | null; author: string; type: string; created_at: string; repository_id: string }
export interface ReportRoundRow { id: string; issue_id: string; started_at: string; finished_at: string | null }
export interface ReportDeliveryRow { issue_id: string; repository_id: string; source_number: number; title: string; delivered_at: string }

export class ReportQueries {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  issues(): ReportIssueRow[] {
    return this.#db.query("SELECT id, repository_id, source_number, title, source_state, projected_state FROM issues").all() as ReportIssueRow[];
  }

  /** Every run with its summed token usage, oldest first. */
  runs(): ReportRunRow[] {
    return this.#db.query(`
      SELECT r.issue_id, r.stage_id, r.status, r.started_at, r.finished_at,
             SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cached_tokens) AS cached_tokens
      FROM runs r LEFT JOIN usage_cost_entries u ON u.run_id = r.id
      GROUP BY r.id ORDER BY r.started_at`).all() as ReportRunRow[];
  }

  transitions(): ReportTransitionRow[] {
    return this.#db.query(
      "SELECT issue_id, kind, from_stage, to_stage, status, created_at FROM stage_transitions ORDER BY created_at, id",
    ).all() as ReportTransitionRow[];
  }

  /** Task executions that parked on something outside the agent: CI, a deploy, a dependency. */
  waits(): ReportWaitRow[] {
    return this.#db.query(
      "SELECT issue_id, pending_since, updated_at FROM task_executions WHERE pending_since IS NOT NULL",
    ).all() as ReportWaitRow[];
  }

  /** When each item was first enrolled. */
  firstEnrollments(): ReportEnrollmentRow[] {
    return this.#db.query("SELECT issue_id, MIN(started_at) AS started_at FROM enrollments GROUP BY issue_id").all() as ReportEnrollmentRow[];
  }

  /** Every finding with its item's repository, optionally limited to one repository and to those created since `since`. */
  findings(repositoryId: string | null, since: string | null): ReportFindingRow[] {
    return this.#db.query(
      `SELECT f.id, f.issue_id, f.run_id, f.provider_key, f.author, f.type, f.created_at, i.repository_id
         FROM findings f JOIN issues i ON i.id = f.issue_id
        WHERE (?1 IS NULL OR i.repository_id = ?1) AND (?2 IS NULL OR f.created_at >= ?2)`,
    ).all(repositoryId, since) as ReportFindingRow[];
  }

  /** The runs of `stage`, optionally limited to one repository and to those started since `since`. */
  stageRuns(stage: string, repositoryId: string | null, since: string | null): ReportRoundRow[] {
    return this.#db.query(
      `SELECT r.id, r.issue_id, r.started_at, r.finished_at
         FROM runs r JOIN issues i ON i.id = r.issue_id
        WHERE r.stage_id = ?1 AND (?2 IS NULL OR i.repository_id = ?2) AND (?3 IS NULL OR r.started_at >= ?3)`,
    ).all(stage, repositoryId, since) as ReportRoundRow[];
  }

  /** Items that finished their last stage (an advance from a stage to itself), newest first. */
  deliveries(): ReportDeliveryRow[] {
    return this.#db.query(`
      SELECT i.id AS issue_id, i.repository_id, i.source_number, i.title,
             MAX(st.created_at) AS delivered_at
      FROM stage_transitions st
      JOIN issues i ON i.id = st.issue_id
      WHERE st.status = 'completed'
        AND st.kind = 'advance'
        AND st.from_stage IS NOT NULL
        AND st.from_stage = st.to_stage
      GROUP BY i.id, i.repository_id, i.source_number, i.title
      ORDER BY delivered_at DESC, i.source_number DESC
    `).all() as ReportDeliveryRow[];
  }
}
