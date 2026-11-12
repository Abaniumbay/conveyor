// Counts every request Conveyor makes to an item source's provider by why it was made, so the cost
// of each path (the periodic reconcile, webhook deliveries, parked waits, agents) can be measured
// and compared. The core says why work runs (`withCallSource`); a provider plugin's transport reads
// it and records each request in a `CallMeter`.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why a request was made. `wait` is a parked task re-run because something woke it; `fallback` is
 * one re-run because its wake-up time passed; `stage` is any other stage work.
 */
export const CALL_SOURCES = ["startup", "tick", "webhook", "stage", "wait", "fallback", "advisory", "agent", "command", "other"] as const;
export type CallSource = (typeof CALL_SOURCES)[number];

const sourceContext = new AsyncLocalStorage<CallSource>();

/** Runs `work` with every provider request it makes, directly or asynchronously, counted as `source`. */
export function withCallSource<T>(source: CallSource, work: () => T): T {
  return sourceContext.run(source, work);
}

export function currentCallSource(): CallSource {
  return sourceContext.getStore() ?? "other";
}

/** One request to a provider, as its transport saw it. */
export interface ProviderCall {
  method: string;
  /** The request path with identifiers replaced, for example `repos/:repo/pulls/:n`. */
  route: string;
  repository: string | null;
  source: CallSource;
  durationMs: number;
  ok: boolean;
  status: number | null;
}

export interface CallSummary {
  total: number;
  bySource: Partial<Record<CallSource, number>>;
  byRepository: Record<string, Partial<Record<CallSource, number>>>;
  byRoute: Record<string, number>;
}

/** What the core reads of a provider's request counts. */
export interface ProviderCallMeter {
  /** When counting started; a summary over a longer window covers only the time since. */
  readonly startedAt: string;
  /** The requests of the last `windowMs` (at most one hour), counted per source, repository and route. */
  summary(windowMs?: number, now?: number): CallSummary;
}

const BUCKET_MS = 60_000;
const BUCKETS = 60;
/** `rate_limit` does not count against the limit and is how the meter reads it, so it is not counted. */
const UNCOUNTED_ROUTES = new Set(["rate_limit"]);

interface Bucket {
  minute: number;
  calls: Map<string, number>;
}

/** In-memory counts of the last hour of provider requests, by source, repository and route. */
export class CallMeter implements ProviderCallMeter {
  readonly #buckets: Bucket[] = [];
  readonly #startedAt: number;

  constructor(now = Date.now()) {
    this.#startedAt = now;
  }

  get startedAt(): string {
    return new Date(this.#startedAt).toISOString();
  }

  record(call: ProviderCall, now = Date.now()): void {
    if (UNCOUNTED_ROUTES.has(call.route)) return;
    const minute = Math.floor(now / BUCKET_MS);
    let bucket = this.#buckets.at(-1);
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, calls: new Map() };
      this.#buckets.push(bucket);
      while (this.#buckets.length > 0 && this.#buckets[0]!.minute <= minute - BUCKETS) this.#buckets.shift();
    }
    const key = `${call.source}\u0000${call.repository ?? ""}\u0000${call.method} ${call.route}`;
    bucket.calls.set(key, (bucket.calls.get(key) ?? 0) + 1);
  }

  summary(windowMs = BUCKETS * BUCKET_MS, now = Date.now()): CallSummary {
    const first = Math.floor((now - Math.min(windowMs, BUCKETS * BUCKET_MS)) / BUCKET_MS) + 1;
    const summary: CallSummary = { total: 0, bySource: {}, byRepository: {}, byRoute: {} };
    for (const bucket of this.#buckets) {
      if (bucket.minute < first) continue;
      for (const [key, count] of bucket.calls) {
        const [source, repository, route] = key.split("\u0000") as [CallSource, string, string];
        summary.total += count;
        summary.bySource[source] = (summary.bySource[source] ?? 0) + count;
        summary.byRoute[route] = (summary.byRoute[route] ?? 0) + count;
        if (repository) {
          const perRepository = summary.byRepository[repository] ??= {};
          perRepository[source] = (perRepository[source] ?? 0) + count;
        }
      }
    }
    return summary;
  }
}
