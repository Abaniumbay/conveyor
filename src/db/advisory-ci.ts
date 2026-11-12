// The records of advisory CI watches: one per (repository, item, head). The polling that reads CI
// and decides when a watch is finished lives in src/app/advisory-ci.ts; this file only stores the
// watches and commits each state change together with what it must happen exactly once with.

import type { Database } from "bun:sqlite";

import type { AdvisoryCiWatch } from "../tasks/context";
import { eventLog } from "./event-log";
import type { ExecutionStore } from "./journal";

interface Row {
  id: string; repository_id: string; item_id: string; head_sha: string; stage: string;
  change_id: string; change_url: string; state: AdvisoryCiWatch["state"]; started_at: string;
  settle_ms: number; wake_at: string; deadline_at: string; announced_at: string | null; final_message_at: string | null;
}

const toWatch = (row: Row): AdvisoryCiWatch => ({
  id: row.id, repositoryId: row.repository_id, itemId: row.item_id, headSha: row.head_sha, stage: row.stage,
  changeId: row.change_id, changeUrl: row.change_url, settleMs: row.settle_ms, state: row.state,
  startedAt: row.started_at, wakeAt: row.wake_at, deadlineAt: row.deadline_at,
  announcedAt: row.announced_at, finalMessageAt: row.final_message_at,
});

export interface NewAdvisoryCiWatch {
  repositoryId: string;
  itemId: string;
  headSha: string;
  stage: string;
  change: { changeId: string; url: string };
  startedAt: string;
  settleMs: number;
  wakeAt: string;
  deadlineAt: string;
}

export class AdvisoryCiWatchStore {
  readonly #db: Database;
  readonly #marks: Pick<ExecutionStore, "markCi">;

  constructor(database: Database, marks: Pick<ExecutionStore, "markCi">) {
    this.#db = database;
    this.#marks = marks;
  }

  get(itemId: string, headSha: string): AdvisoryCiWatch | null {
    const row = this.#db.query("SELECT * FROM advisory_ci_watches WHERE item_id = ? AND head_sha = ?").get(itemId, headSha) as Row | null;
    return row ? toWatch(row) : null;
  }

  /** The earliest wake-up of an active watch, or null. */
  nextWakeAt(): string | null {
    const row = this.#db.query("SELECT MIN(wake_at) AS at FROM advisory_ci_watches WHERE state = 'active'").get() as { at: string | null };
    return row.at;
  }

  /** Creates the watch for a head or reuses it; any older active watch of the item becomes superseded. */
  ensure(input: NewAdvisoryCiWatch): AdvisoryCiWatch {
    return this.#db.transaction(() => {
      this.#db
        .query("UPDATE advisory_ci_watches SET state = 'superseded' WHERE item_id = ? AND head_sha != ? AND state = 'active'")
        .run(input.itemId, input.headSha);
      const inserted = this.#db
        .query(`INSERT OR IGNORE INTO advisory_ci_watches(id, repository_id, item_id, head_sha, stage, change_id, change_url, state,
                  started_at, settle_ms, wake_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .run(
          crypto.randomUUID(), input.repositoryId, input.itemId, input.headSha, input.stage, input.change.changeId, input.change.url,
          input.startedAt, input.settleMs, input.wakeAt, input.deadlineAt,
        );
      // A head that comes back (A, B, A) resumes its own watch unless it already reported.
      this.#db
        .query("UPDATE advisory_ci_watches SET state = 'active' WHERE item_id = ? AND head_sha = ? AND state = 'superseded' AND final_message_at IS NULL")
        .run(input.itemId, input.headSha);
      const row = this.#db
        .query("SELECT * FROM advisory_ci_watches WHERE repository_id = ? AND item_id = ? AND head_sha = ?")
        .get(input.repositoryId, input.itemId, input.headSha) as Row;
      if (inserted.changes > 0) {
        eventLog(this.#db).append("advisoryCi.watchStarted", { watchId: row.id, headSha: input.headSha }, { repositoryId: input.repositoryId, issueId: input.itemId });
      }
      return toWatch(row);
    })();
  }

  /** Active watches whose wake-up is at or before `at`, earliest first. */
  due(at: string): AdvisoryCiWatch[] {
    const rows = this.#db.query("SELECT * FROM advisory_ci_watches WHERE state = 'active' AND wake_at <= ? ORDER BY wake_at").all(at) as Row[];
    return rows.map(toWatch);
  }

  /** Sets an active watch's next wake-up. */
  reschedule(id: string, wakeAt: string): void {
    this.#db.query("UPDATE advisory_ci_watches SET wake_at = ? WHERE id = ? AND state = 'active'").run(wakeAt, id);
  }

  /** Makes the active watches of a head due at `at` (its CI finished); returns how many. */
  wakeHead(repositoryId: string, headSha: string, at: string): number {
    return this.#db
      .query("UPDATE advisory_ci_watches SET wake_at = ? WHERE repository_id = ? AND head_sha = ? AND state = 'active' AND wake_at > ?")
      .run(at, repositoryId, headSha, at).changes;
  }

  /**
   * Records that the head's CI start was announced. The one announcement per head is shared with
   * ci.start through the CI marks: `announce` runs, in the same transaction, only when this call
   * made the mark and the watch is still active.
   */
  recordAnnouncement(watch: AdvisoryCiWatch, at: string, announce: () => void): void {
    this.#db.transaction(() => {
      const mark = this.#marks.markCi(watch.itemId, watch.headSha, "announced", "", at);
      const active = (this.#db.query("SELECT state FROM advisory_ci_watches WHERE id = ?").get(watch.id) as { state: string } | null)?.state === "active";
      if (mark.fresh && active) announce();
      this.#db.query("UPDATE advisory_ci_watches SET announced_at = ? WHERE id = ?").run(mark.at, watch.id);
    })();
  }

  /** Ends an active watch; `report` (its one final message) runs in the same transaction, so it is sent exactly once. */
  finish(watch: AdvisoryCiWatch, state: "passed" | "failed" | "timed-out", at: string, report: () => void): void {
    this.#db.transaction(() => {
      const changed = this.#db
        .query("UPDATE advisory_ci_watches SET state = ?, final_message_at = ? WHERE id = ? AND state = 'active' AND final_message_at IS NULL")
        .run(state, at, watch.id).changes;
      if (changed > 0) {
        report();
        eventLog(this.#db).append("advisoryCi.finished", { watchId: watch.id, state }, { repositoryId: watch.repositoryId, issueId: watch.itemId });
      }
    })();
  }
}
