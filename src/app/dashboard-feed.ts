// The dashboard's live feed. Changes to Conveyor's state invalidate the model; the feed rebuilds it
// once per burst of changes, diffs it against the previous build and fans the resulting patches
// out to every open dashboard. The work per change is the same for one dashboard or many, and
// nothing is built while no dashboard is open.

import { log } from "../log/logger";
import { diffDashboard, type DashboardModel, type DashboardPatch } from "../web/model";
import type { SystemStatusViewModel } from "../web/types";

export interface DashboardFeedOptions {
  /** Builds the whole model from the current state. */
  build: () => DashboardModel;
  /** Reads the server status (memory, disks) sent alongside the model. */
  status?: () => Promise<SystemStatusViewModel>;
  /** How long a burst of changes may keep arriving before the model is rebuilt. */
  settleMs?: number;
  /** The longest a change waits for its burst to end. */
  maxWaitMs?: number;
  /** How often the server status is read while a dashboard is open. */
  statusIntervalMs?: number;
  /** How many patches are kept for a reconnecting dashboard. */
  replayLimit?: number;
}

export type DashboardFeedMessage =
  | { kind: "patch"; patch: DashboardPatch }
  | { kind: "status"; status: SystemStatusViewModel };

export type DashboardFeedListener = (message: DashboardFeedMessage) => void;

export interface DashboardFeedSubscription {
  /** Patches the dashboard missed since the sequence it named, or null when they are no longer all kept. */
  replay: DashboardPatch[] | null;
  unsubscribe(): void;
}

export class DashboardFeed {
  readonly #options: Required<Omit<DashboardFeedOptions, "status">> & Pick<DashboardFeedOptions, "status">;
  readonly #listeners = new Set<DashboardFeedListener>();
  #model: DashboardModel | null = null;
  #dirty = true;
  #seq = 0;
  #buffer: DashboardPatch[] = [];
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #dirtySince: number | null = null;
  #statusTimer: ReturnType<typeof setTimeout> | null = null;
  #status: SystemStatusViewModel | null = null;
  #builds = 0;

  constructor(options: DashboardFeedOptions) {
    this.#options = {
      settleMs: 250,
      maxWaitMs: 1_000,
      statusIntervalMs: 10_000,
      replayLimit: 1_000,
      ...options,
    };
  }

  /** How many times the model was built; the work does not grow with the number of dashboards. */
  get builds(): number {
    return this.#builds;
  }

  /** The last server status read, or null before the first read. */
  get status(): SystemStatusViewModel | null {
    return this.#status;
  }

  /** Marks the model out of date. It is rebuilt after the burst settles, and only while someone listens. */
  invalidate(): void {
    this.#dirty = true;
    this.#dirtySince ??= Date.now();
    if (this.#listeners.size === 0) return;
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    const waited = Date.now() - this.#dirtySince;
    const delay = Math.max(0, Math.min(this.#options.settleMs, this.#options.maxWaitMs - waited));
    this.#settleTimer = setTimeout(() => this.flush(), delay);
  }

  /** Rebuilds the model now if it is out of date, and sends the resulting patches. */
  flush(): void {
    if (this.#settleTimer) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
    if (!this.#dirty && this.#model) return;
    this.#dirty = false;
    this.#dirtySince = null;
    let next: DashboardModel;
    try {
      next = this.#options.build();
      this.#builds += 1;
    } catch (error) {
      // The next change retries; the dashboards keep what they have.
      this.#dirty = true;
      log.warn("Dashboard model build failed", {}, error);
      return;
    }
    const changes = diffDashboard(this.#model, next);
    this.#model = next;
    for (const change of changes) {
      const patch: DashboardPatch = { seq: ++this.#seq, ...change };
      this.#buffer.push(patch);
      for (const listener of this.#listeners) listener({ kind: "patch", patch });
    }
    if (this.#buffer.length > this.#options.replayLimit) this.#buffer.splice(0, this.#buffer.length - this.#options.replayLimit);
  }

  /** The current model and the sequence of the last patch it includes. */
  snapshot(): { seq: number; model: DashboardModel } {
    this.flush();
    if (!this.#model) throw new Error("the dashboard model is not available");
    return { seq: this.#seq, model: this.#model };
  }

  /**
   * Starts sending messages to `listener`. With `after`, the patches since that sequence are
   * returned for replay, or null when they are no longer all kept (the dashboard must reload).
   */
  subscribe(listener: DashboardFeedListener, after: number | null = null): DashboardFeedSubscription {
    const replay = after === null ? [] : this.#patchesAfter(after);
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#startStatus();
    if (this.#dirty && this.#model) this.invalidate();
    return {
      replay,
      unsubscribe: () => {
        this.#listeners.delete(listener);
        if (this.#listeners.size === 0) this.#stopStatus();
      },
    };
  }

  /** Stops timers; open subscriptions receive nothing more. */
  close(): void {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    this.#stopStatus();
    this.#listeners.clear();
  }

  #patchesAfter(after: number): DashboardPatch[] | null {
    if (after > this.#seq) return null;
    if (after === this.#seq) return [];
    const first = this.#buffer[0];
    if (!first || first.seq > after + 1) return null;
    return this.#buffer.filter((patch) => patch.seq > after);
  }

  #startStatus(): void {
    const read = this.#options.status;
    if (!read || this.#statusTimer) return;
    const tick = async () => {
      let delay = this.#options.statusIntervalMs;
      try {
        const status = await read();
        if (JSON.stringify(status) !== JSON.stringify(this.#status)) {
          this.#status = status;
          for (const listener of this.#listeners) listener({ kind: "status", status });
        }
      } catch {
        // A transient read failure (for example statfs) is retried soon.
        delay = Math.min(delay, 1_000);
      }
      if (this.#listeners.size > 0) this.#statusTimer = setTimeout(() => void tick(), delay);
      else this.#statusTimer = null;
    };
    this.#statusTimer = setTimeout(() => void tick(), 0);
  }

  #stopStatus(): void {
    if (this.#statusTimer) clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
  }
}
