// Counts every GitHub API request by why Conveyor made it, so the cost of each path (the periodic
// reconcile, webhook deliveries, parked waits, agents) can be measured and compared.

import { AsyncLocalStorage } from "node:async_hooks";

import { log } from "../../log/logger";
import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "./adapter";

/**
 * Why a request was made. `wait` is a parked task re-run because something woke it; `fallback` is
 * one re-run because its wake-up time passed; `stage` is any other stage work.
 */
export const GITHUB_CALL_SOURCES = ["startup", "tick", "webhook", "stage", "wait", "fallback", "advisory", "agent", "command", "other"] as const;
export type GitHubCallSource = (typeof GITHUB_CALL_SOURCES)[number];

const sourceContext = new AsyncLocalStorage<GitHubCallSource>();

/** Runs `work` with every GitHub request it makes, directly or asynchronously, counted as `source`. */
export function withGitHubCallSource<T>(source: GitHubCallSource, work: () => T): T {
  return sourceContext.run(source, work);
}

export function currentGitHubCallSource(): GitHubCallSource {
  return sourceContext.getStore() ?? "other";
}

export interface GitHubCall {
  method: GitHubTransportRequest["method"];
  /** The request path with identifiers replaced, for example `repos/:repo/pulls/:n`. */
  route: string;
  repository: string | null;
  source: GitHubCallSource;
  durationMs: number;
  ok: boolean;
  status: number | null;
}

export interface GitHubCallSummary {
  total: number;
  bySource: Partial<Record<GitHubCallSource, number>>;
  byRepository: Record<string, Partial<Record<GitHubCallSource, number>>>;
  byRoute: Record<string, number>;
}

const BUCKET_MS = 60_000;
const BUCKETS = 60;
/** `rate_limit` does not count against the limit and is how the meter reads it, so it is not counted. */
/** A refusal for the rate limit is warned about at most once per window; requests then pause anyway. */
const RATE_LIMIT_WARNING_MS = 5 * 60_000;
const UNCOUNTED_ROUTES = new Set(["rate_limit"]);

interface Bucket {
  minute: number;
  calls: Map<string, number>;
}

/** The request path with owner/repo, numbers, commit SHAs and names replaced by placeholders. */
export function githubRoute(requestPath: string): string {
  return requestPath
    .split("?")[0]!
    .replace(/^repos\/[^/]+\/[^/]+/, "repos/:repo")
    .replace(/\/contents\/.*$/, "/contents/:path")
    .replace(/\/git\/refs\/heads\/.*$/, "/git/refs/heads/:ref")
    .replace(/\/labels\/[^/]+$/, "/labels/:name")
    .replace(/\/collaborators\/[^/]+\//, "/collaborators/:login/")
    .replace(/^orgs\/[^/]+/, "orgs/:org")
    .replace(/\/[0-9a-f]{40}(?=\/|$)/g, "/:sha")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
}

/** The `owner/repo` a request path addresses, or null for requests outside a repository. */
export function githubRepository(requestPath: string): string | null {
  const match = /^repos\/([^/]+\/[^/?]+)/.exec(requestPath);
  return match ? match[1]!.toLowerCase() : null;
}

/** In-memory counts of the last hour of GitHub requests, by source, repository and route. */
export class GitHubCallMeter {
  readonly #buckets: Bucket[] = [];
  readonly #startedAt: number;

  constructor(now = Date.now()) {
    this.#startedAt = now;
  }

  /** When counting started; a summary over a longer window covers only the time since. */
  get startedAt(): string {
    return new Date(this.#startedAt).toISOString();
  }

  record(call: GitHubCall, now = Date.now()): void {
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

  /** The requests of the last `windowMs` (at most one hour), counted per source, repository and route. */
  summary(windowMs = BUCKETS * BUCKET_MS, now = Date.now()): GitHubCallSummary {
    const first = Math.floor((now - Math.min(windowMs, BUCKETS * BUCKET_MS)) / BUCKET_MS) + 1;
    const summary: GitHubCallSummary = { total: 0, bySource: {}, byRepository: {}, byRoute: {} };
    for (const bucket of this.#buckets) {
      if (bucket.minute < first) continue;
      for (const [key, count] of bucket.calls) {
        const [source, repository, route] = key.split("\u0000") as [GitHubCallSource, string, string];
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

/** The HTTP status a failed `gh api` request reports, when it says. */
function failureStatus(error: unknown): number | null {
  if (!(error instanceof GitHubTransportError)) return null;
  const match = /\(HTTP (\d{3})\)/.exec(`${error.stderr} ${error.message}`);
  return match ? Number(match[1]) : null;
}

/** Wraps a transport so that every request is counted in `meter` and logged at debug level. */
export class MeteredGitHubTransport implements GitHubTransport {
  #rateLimitWarnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inner: GitHubTransport,
    readonly meter: GitHubCallMeter,
  ) {}

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    const started = performance.now();
    const route = githubRoute(request.path);
    const base = { method: request.method, route, repository: githubRepository(request.path), source: currentGitHubCallSource() };
    const finish = (ok: boolean, status: number | null) => {
      const call: GitHubCall = { ...base, durationMs: Math.round(performance.now() - started), ok, status };
      this.meter.record(call);
      log.debug("GitHub call", {
        method: call.method, route: call.route, source: call.source, durationMs: call.durationMs, ok, ...(call.repository ? { address: call.repository } : {}), ...(status !== null ? { status } : {}),
      });
    };
    try {
      const result = await this.inner.request<T>(request);
      finish(true, null);
      return result;
    } catch (error) {
      finish(false, failureStatus(error));
      if (error instanceof GitHubTransportError && /rate limit/i.test(error.stderr) && Date.now() - this.#rateLimitWarnedAt >= RATE_LIMIT_WARNING_MS) {
        this.#rateLimitWarnedAt = Date.now();
        log.warn("GitHub refused a request for its rate limit", { method: base.method, route, source: base.source }, error);
      }
      throw error;
    }
  }
}
