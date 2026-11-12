// Durable advisory CI watches. In `ci.mode: advisory` CI never gates an item; `ci.start` creates
// (or reuses) one watch per (repository, item, head) and this polls it until the head's runs settle
// or the deadline passes, then posts exactly one conversation message. A watch never takes a runner
// permit and never touches stage state, labels or the journal cursor. The watches are stored by
// AdvisoryCiWatchStore (src/db/advisory-ci.ts).

import type { AdvisoryCiWatchStore } from "../db/advisory-ci";
import type { ExecutionStore } from "../db/journal";
import type { AdvisoryCiWatch } from "../tasks/context";
import { ciAnnouncement, classifyRuns, describeCiFailure, readRunLog, type FailedRun } from "./ci-gate";
import type { CiChange, CiProvider, CiRun } from "./ci-provider";

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
  /** How long a watch waits before reading CI again; by repository, since webhooks can make it longer. */
  pollMs?: number | ((repositoryId: string) => number);
  /** Called with a provider error; the watch is simply polled again later. */
  onError?: (watch: AdvisoryCiWatch, error: unknown) => void;
  /** Told every provider read of a watch: the head's runs (before `ignoreChecks`), or the error. */
  observe?: (watch: AdvisoryCiWatch, observation: { runs: CiRun[] } | { error: unknown }) => void;
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

const iso = (ms: number) => new Date(ms).toISOString();
const short = (sha: string) => sha.slice(0, 7);
const bounded = (message: string) => message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE)}\n… (truncated)`;

export class AdvisoryCiWatches {
  readonly #store: AdvisoryCiWatchStore;
  readonly #marks: Pick<ExecutionStore, "ciMarks">;
  readonly #options: AdvisoryCiOptions;
  #polling = false;

  constructor(store: AdvisoryCiWatchStore, marks: Pick<ExecutionStore, "ciMarks">, options: AdvisoryCiOptions) {
    this.#store = store;
    this.#marks = marks;
    this.#options = options;
  }

  get(itemId: string, headSha: string): AdvisoryCiWatch | null {
    return this.#store.get(itemId, headSha);
  }

  /** The earliest wake-up of an active watch, or null. */
  nextWakeAt(): string | null {
    return this.#store.nextWakeAt();
  }

  /** Creates the watch for a head or reuses it; any older active watch of the item becomes superseded. */
  ensureWatch(input: EnsureWatchInput): AdvisoryCiWatch {
    return this.#store.ensure({
      repositoryId: input.repositoryId, itemId: input.itemId, headSha: input.headSha, stage: input.stage, change: input.change,
      startedAt: iso(input.now), settleMs: input.settleMs ?? DEFAULT_SETTLE_MS,
      wakeAt: iso(input.now + this.#pollMs(input.repositoryId)), deadlineAt: iso(input.now + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    });
  }

  /** Polls every active watch whose wake-up has passed. Overlapping calls are ignored. */
  async pollDueWatches(now: number): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const watch of this.#store.due(iso(now))) {
        try { await this.#poll(watch, now); }
        catch (error) {
          this.#options.onError?.(watch, error);
          this.#options.observe?.(watch, { error });
          // An unreadable provider must not keep a watch alive past its deadline.
          if (now >= Date.parse(watch.deadlineAt)) {
            const sha = short(watch.headSha);
            this.#finish(watch, "timed-out", now, bounded(
              `CI for ${sha} could not be read before the deadline (${error instanceof Error ? error.message : String(error)}). ${watch.changeUrl}/checks`));
          } else this.#reschedule(watch, now);
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #pollMs(repositoryId: string): number {
    const pollMs = this.#options.pollMs;
    return typeof pollMs === "function" ? pollMs(repositoryId) : pollMs ?? DEFAULT_POLL_MS;
  }

  /** Reads CI again after the poll interval, or sooner when `soonerMs` (the settle window's end) comes first. */
  #reschedule(watch: AdvisoryCiWatch, now: number, soonerMs?: number): void {
    const delay = Math.min(this.#pollMs(watch.repositoryId), soonerMs !== undefined && soonerMs > 0 ? soonerMs : Number.POSITIVE_INFINITY);
    this.#store.reschedule(watch.id, iso(now + delay));
  }

  /** Makes the active watches of a head due now (its CI finished); returns how many. */
  wakeHead(repositoryId: string, headSha: string, now: number): number {
    return this.#store.wakeHead(repositoryId, headSha, iso(now));
  }

  async #poll(watch: AdvisoryCiWatch, now: number): Promise<void> {
    const target = this.#options.resolve(watch.repositoryId);
    const change: CiChange = { repository: target.address, changeId: watch.changeId, url: watch.changeUrl };
    const ignored = new Set(target.ignoreChecks);
    const all = await target.provider.list(change, watch.headSha);
    this.#options.observe?.(watch, { runs: all });
    const listed = all.filter((run) => !ignored.has(run.name));
    const rerunIds = new Set(this.#marks.ciMarks(watch.itemId, watch.headSha, "rerun-id"));
    const reran = new Set(this.#marks.ciMarks(watch.itemId, watch.headSha, "rerun"));
    const runs = listed.map((run) => ({ ...run, state: run.state === "cancelled" && rerunIds.has(run.id) ? ("running" as const) : run.state }));
    const sha = short(watch.headSha);

    // The one start announcement per head is shared with ci.start through the ci_marks table.
    if (watch.announcedAt === null && runs.length > 0) {
      this.#store.recordAnnouncement(watch, iso(now), () => this.#options.post(watch.itemId, watch.stage, ciAnnouncement(watch.changeUrl, sha, runs, [])));
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
        : `CI finished, but no CI runs were reported for ${sha}: ${watch.changeUrl}/checks`));
    }
    if (now >= Date.parse(watch.deadlineAt)) {
      const minutes = Math.round((Date.parse(watch.deadlineAt) - Date.parse(watch.startedAt)) / 60_000);
      const waitingOn = unfinished.join(", ") || "checks to register";
      return this.#finish(watch, "timed-out", now, bounded(
        `CI for ${sha} did not finish within ${minutes} minutes; still waiting on ${waitingOn}. ${watch.changeUrl}/checks`));
    }
    // With nothing unfinished, only the settle window remains: look again when it ends.
    this.#reschedule(watch, now, unfinished.length === 0 ? Date.parse(watch.startedAt) + watch.settleMs - now : undefined);
  }

  /** The state change, `final_message_at` and the message itself commit together, so the message is sent exactly once. */
  #finish(watch: AdvisoryCiWatch, state: "passed" | "failed" | "timed-out", now: number, message: string): void {
    this.#store.finish(watch, state, iso(now), () => this.#options.post(watch.itemId, watch.stage, message));
  }
}
