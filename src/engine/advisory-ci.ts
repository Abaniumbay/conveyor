// Durable advisory CI watches. In `ci.mode: advisory` CI never gates an item; `ci.start` creates
// (or reuses) one watch per (repository, item, head) and this store polls it until the head's runs
// settle or the deadline passes, then posts exactly one conversation message. A watch never takes a
// runner permit and never touches stage state, labels or the journal cursor.

import type { Database } from "bun:sqlite";

import { ciAnnouncement, classifyRuns, describeCiFailure, readRunLog, type FailedRun } from "../app/ci-gate";
import type { CiChange, CiProvider } from "../app/ci-provider";
import type { AdvisoryCiWatch } from "../tasks/context";
import type { ExecutionStore } from "./journal";

export const DEFAULT_SETTLE_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 3 * 3_600_000;
export const DEFAULT_POLL_MS = 60_000;
const LOG_LINES = 60;
const MAX_MESSAGE = 3_900;

export interface AdvisoryCiTarget {
  provider: CiProvider;
  address: string;
  ignoreChecks: string[];
}

export interface AdvisoryCiOptions {
  /** Resolves the CI provider and settings of a repository. */
  resolve: (repositoryId: string) => AdvisoryCiTarget;
  /** Posts a Conveyor conversation message; runs inside the transaction that records a final message. */
  post: (itemId: string, stage: string, message: string) => void;
  pollMs?: number;
  /** Called with a provider error; the watch is simply polled again later. */
  onError?: (watch: AdvisoryCiWatch, error: unknown) => void;
}

export interface EnsureWatchInput {
  repositoryId: string;
  itemId: string;
  headSha: string;
  stage: string;
  change: { changeId: string; url: string };
  now: number;
  timeoutMs?: number;
  settleMs?: number;
}

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

const iso = (ms: number) => new Date(ms).toISOString();
const short = (sha: string) => sha.slice(0, 7);
const bounded = (message: string) => message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE)}\n… (truncated)`;

export class AdvisoryCiWatches {
  readonly #db: Database;
  readonly #marks: Pick<ExecutionStore, "markCi" | "ciMarks">;
  readonly #options: AdvisoryCiOptions;
  #polling = false;

  constructor(database: Database, marks: Pick<ExecutionStore, "markCi" | "ciMarks">, options: AdvisoryCiOptions) {
    this.#db = database;
    this.#marks = marks;
    this.#options = options;
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
  ensureWatch(input: EnsureWatchInput): AdvisoryCiWatch {
    const at = iso(input.now);
    return this.#db.transaction(() => {
      this.#db
        .query("UPDATE advisory_ci_watches SET state = 'superseded' WHERE item_id = ? AND head_sha != ? AND state = 'active'")
        .run(input.itemId, input.headSha);
      this.#db
        .query(`INSERT OR IGNORE INTO advisory_ci_watches(id, repository_id, item_id, head_sha, stage, change_id, change_url, state,
                  started_at, settle_ms, wake_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .run(
          crypto.randomUUID(), input.repositoryId, input.itemId, input.headSha, input.stage, input.change.changeId, input.change.url,
          at, input.settleMs ?? DEFAULT_SETTLE_MS, iso(input.now + (this.#options.pollMs ?? DEFAULT_POLL_MS)),
          iso(input.now + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
        );
      // A head that comes back (A, B, A) resumes its own watch unless it already reported.
      this.#db
        .query("UPDATE advisory_ci_watches SET state = 'active' WHERE item_id = ? AND head_sha = ? AND state = 'superseded' AND final_message_at IS NULL")
        .run(input.itemId, input.headSha);
      const row = this.#db
        .query("SELECT * FROM advisory_ci_watches WHERE repository_id = ? AND item_id = ? AND head_sha = ?")
        .get(input.repositoryId, input.itemId, input.headSha) as Row;
      return toWatch(row);
    })();
  }

  /** Polls every active watch whose wake-up has passed. Overlapping calls are ignored. */
  async pollDueWatches(now: number): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const due = this.#db
        .query("SELECT * FROM advisory_ci_watches WHERE state = 'active' AND wake_at <= ? ORDER BY wake_at")
        .all(iso(now)) as Row[];
      for (const row of due) {
        const watch = toWatch(row);
        try { await this.#poll(watch, now); }
        catch (error) {
          this.#options.onError?.(watch, error);
          this.#reschedule(watch, now);
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #reschedule(watch: AdvisoryCiWatch, now: number): void {
    this.#db
      .query("UPDATE advisory_ci_watches SET wake_at = ? WHERE id = ? AND state = 'active'")
      .run(iso(now + (this.#options.pollMs ?? DEFAULT_POLL_MS)), watch.id);
  }

  #isActive(id: string): boolean {
    return (this.#db.query("SELECT state FROM advisory_ci_watches WHERE id = ?").get(id) as { state: string } | null)?.state === "active";
  }

  async #poll(watch: AdvisoryCiWatch, now: number): Promise<void> {
    const target = this.#options.resolve(watch.repositoryId);
    const change: CiChange = { repository: target.address, changeId: watch.changeId, url: watch.changeUrl };
    const ignored = new Set(target.ignoreChecks);
    const listed = (await target.provider.list(change, watch.headSha)).filter((run) => !ignored.has(run.name));
    const rerunIds = new Set(this.#marks.ciMarks(watch.itemId, watch.headSha, "rerun-id"));
    const reran = new Set(this.#marks.ciMarks(watch.itemId, watch.headSha, "rerun"));
    const runs = listed.map((run) => ({ ...run, state: run.state === "cancelled" && rerunIds.has(run.id) ? ("running" as const) : run.state }));
    const sha = short(watch.headSha);

    // The one start announcement per head is shared with ci.start through the ci_marks table.
    if (watch.announcedAt === null && runs.length > 0) {
      const mark = this.#marks.markCi(watch.itemId, watch.headSha, "announced", "", iso(now));
      this.#db.transaction(() => {
        if (mark.fresh && this.#isActive(watch.id)) this.#options.post(watch.itemId, watch.stage, ciAnnouncement(watch.changeUrl, sha, runs, []));
        this.#db.query("UPDATE advisory_ci_watches SET announced_at = ? WHERE id = ?").run(mark.at, watch.id);
      })();
    }

    // A cancelled run that can still be rerun is rerun once by ci.start; until then it counts as unfinished.
    const { running, failed, rerun } = classifyRuns(runs, (run) => run.canRerun && !reran.has(run.name));
    const awaiting = this.#marks.ciMarks(watch.itemId, watch.headSha, "started")
      .filter((name) => !runs.some((run) => run.name === name && run.state !== "skipped"));
    const unfinished = [...awaiting.map((name) => `${name} to start`), ...running.map((run) => run.name), ...rerun.map((run) => run.name)];
    const settled = unfinished.length === 0 && now - Date.parse(watch.startedAt) >= watch.settleMs;

    if (settled && failed.length > 0) {
      const logged: FailedRun[] = [];
      for (const run of failed) logged.push({ name: run.name, state: run.state, url: run.url, log: await readRunLog(target.provider, change, run, LOG_LINES) });
      const report = describeCiFailure(watch.changeUrl, sha, logged);
      return this.#finish(watch, "failed", now, bounded(`${report.reason}\n\n${report.sections.join("\n\n")}`));
    }
    if (settled) {
      const lines = runs.map((run) => `- ${run.name} (${run.state}): ${run.url ?? "no link"}`);
      return this.#finish(watch, "passed", now, bounded(runs.length > 0
        ? [`CI passed at ${sha}: ${watch.changeUrl}/checks`, ...lines].join("\n")
        : `No CI checks reported for ${sha}.`));
    }
    if (now >= Date.parse(watch.deadlineAt)) {
      const minutes = Math.round((Date.parse(watch.deadlineAt) - Date.parse(watch.startedAt)) / 60_000);
      const waitingOn = unfinished.join(", ") || "checks to register";
      return this.#finish(watch, "timed-out", now, bounded(
        `CI for ${sha} did not finish within ${minutes} minutes; still waiting on ${waitingOn}. ${watch.changeUrl}/checks`));
    }
    this.#reschedule(watch, now);
  }

  /** The state change, `final_message_at` and the message itself commit together, so the message is sent exactly once. */
  #finish(watch: AdvisoryCiWatch, state: "passed" | "failed" | "timed-out", now: number, message: string): void {
    this.#db.transaction(() => {
      const changed = this.#db
        .query("UPDATE advisory_ci_watches SET state = ?, final_message_at = ? WHERE id = ? AND state = 'active' AND final_message_at IS NULL")
        .run(state, iso(now), watch.id).changes;
      if (changed > 0) this.#options.post(watch.itemId, watch.stage, message);
    })();
  }
}
