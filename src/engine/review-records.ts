// Durable review facts. A criterion approval is bound to the change head it was given for: it
// never counts for another head, and the PR checklist is only a projection of these rows.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface CriterionApproval {
  criterionId: string;
  reviewer: string;
  headSha: string;
  checkedAt: string;
  /** Hash of the criterion text approved; an approval of other text no longer applies. */
  textHash: string;
}

export const criterionTextHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface Row { criterion_id: string; reviewer: string; head_sha: string; checked_at: string; text_hash: string }

export class CriterionApprovals {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  /** Records the approval, replacing any earlier one for the same criterion. */
  approve(input: CriterionApproval & { issueId: string }): void {
    this.#db
      .query(`INSERT INTO criterion_approvals(issue_id, criterion_id, reviewer, head_sha, checked_at, text_hash) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(issue_id, criterion_id) DO UPDATE SET reviewer = excluded.reviewer, head_sha = excluded.head_sha, checked_at = excluded.checked_at, text_hash = excluded.text_hash`)
      .run(input.issueId, input.criterionId, input.reviewer, input.headSha, input.checkedAt, input.textHash);
  }

  withdraw(issueId: string, criterionId: string): void {
    this.#db.query("DELETE FROM criterion_approvals WHERE issue_id = ? AND criterion_id = ?").run(issueId, criterionId);
  }

  list(issueId: string): CriterionApproval[] {
    const rows = this.#db.query("SELECT * FROM criterion_approvals WHERE issue_id = ? ORDER BY criterion_id").all(issueId) as Row[];
    return rows.map((row) => ({ criterionId: row.criterion_id, reviewer: row.reviewer, headSha: row.head_sha, checkedAt: row.checked_at, textHash: row.text_hash }));
  }
}
