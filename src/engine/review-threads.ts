// Recorded evidence of the code host's review threads: which threads the change has, whether each
// counts (its first comment is from the owner or a contributor, a bot, or Conveyor itself) and
// whether it is resolved. `change.reviewThreadsResolved` is a pure check over this record, which
// `change.load` refreshes from the host. A resolved thread reopens when a counted comment arrives
// that nobody has answered, because the host leaves such a thread marked resolved.

import type { Database } from "bun:sqlite";

import type { ReviewThreadState } from "../codehost/types";

export interface ReviewThreadEvidence {
  providerKey: string;
  author: string | null;
  url: string;
  /** Whether the thread blocks the merge when it is not settled. */
  counted: boolean;
  resolved: boolean;
  /** A counted comment arrived on the resolved thread and was not answered. */
  newComment: boolean;
}

export interface ReviewThreadRecord {
  /** The head the threads were read for; null until the first import. */
  importedHeadSha: string | null;
  threads: ReviewThreadEvidence[];
}

interface Row {
  provider_key: string; author: string | null; url: string; counted: number; resolved: number;
  comment_count: number; acknowledged_count: number; new_comment: number;
}

/** Whether a thread is open for the merge: counted and unresolved, or resolved with an unanswered counted comment. */
export const threadIsOpen = (thread: ReviewThreadEvidence): boolean => thread.counted && (!thread.resolved || thread.newComment);

export class ReviewThreads {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  /** Replaces the item's record with `states`, read at `headSha`. */
  record(issueId: string, headSha: string, states: readonly ReviewThreadState[], at: string): ReviewThreadRecord {
    return this.#db.transaction(() => {
      const prior = new Map((this.#db.query("SELECT * FROM review_thread_evidence WHERE issue_id = ?").all(issueId) as Row[])
        .map((row) => [row.provider_key, row]));
      this.#db.query("DELETE FROM review_thread_evidence WHERE issue_id = ?").run(issueId);
      for (const state of states) {
        const before = prior.get(state.providerKey);
        const count = state.comments.length;
        const answered = state.comments.at(-1)?.own === true;
        // Comments up to the acknowledged count were settled with the thread: the ones present when it
        // was first seen resolved, or when it went from open to resolved, or answered by Conveyor.
        const acknowledged = !state.resolved ? 0
          : before === undefined || before.resolved === 0 || answered ? count
            : before.acknowledged_count;
        const newComment = state.resolved && state.comments.slice(acknowledged).some((comment) => comment.counted && !comment.own);
        this.#db.query(`INSERT INTO review_thread_evidence(issue_id, provider_key, author, url, counted, resolved, comment_count, acknowledged_count, new_comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(issueId, state.providerKey, state.author, state.url, state.counted ? 1 : 0, state.resolved ? 1 : 0, count, acknowledged, newComment ? 1 : 0);
      }
      this.#db.query(`INSERT INTO review_thread_imports(issue_id, head_sha, imported_at) VALUES (?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET head_sha = excluded.head_sha, imported_at = excluded.imported_at`).run(issueId, headSha, at);
      return this.get(issueId);
    })();
  }

  get(issueId: string): ReviewThreadRecord {
    const imported = this.#db.query("SELECT head_sha FROM review_thread_imports WHERE issue_id = ?").get(issueId) as { head_sha: string } | null;
    const rows = this.#db.query("SELECT * FROM review_thread_evidence WHERE issue_id = ? ORDER BY rowid").all(issueId) as Row[];
    return {
      importedHeadSha: imported?.head_sha ?? null,
      threads: rows.map((row) => ({
        providerKey: row.provider_key, author: row.author, url: row.url, counted: row.counted === 1,
        resolved: row.resolved === 1, newComment: row.new_comment === 1,
      })),
    };
  }
}
