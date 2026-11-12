// Meters every GitHub API request: the transport below records each one in the shared call meter
// (src/source/calls.ts) under the reason the core gave for the work that made it.

import { log } from "../../../log/logger";
import { currentCallSource, type CallMeter, type CallSource } from "../../../source/calls";
import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "./adapter";

/** A GitHub request as the meter records it. */
export interface GitHubCall {
  method: GitHubTransportRequest["method"];
  /** The request path with identifiers replaced, for example `repos/:repo/pulls/:n`. */
  route: string;
  repository: string | null;
  source: CallSource;
  durationMs: number;
  ok: boolean;
  status: number | null;
}

/** A refusal for the rate limit is warned about at most once per window; requests then pause anyway. */
const RATE_LIMIT_WARNING_MS = 5 * 60_000;

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
    readonly meter: CallMeter,
  ) {}

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    const started = performance.now();
    const route = githubRoute(request.path);
    const base = { method: request.method, route, repository: githubRepository(request.path), source: currentCallSource() };
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
