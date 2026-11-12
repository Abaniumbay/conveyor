// Retries temporary GitHub failures (5xx, GraphQL "went wrong", truncated JSON, rate limits) with
// backoff, so a blip never reaches the caller as a failure. Permanent errors are thrown at once.

import { classifyUpstreamError } from "../../../tasks/upstream-error";
import type { GitHubTransport, GitHubTransportRequest } from "./adapter";

/** Wait before each retry: 5s, 15s, 45s, 2m. After the last one the error is thrown. */
export const GITHUB_RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];

export interface GitHubRetryOptions {
  backoffMs?: readonly number[];
  /** Waits `ms`; injectable so tests run fast. */
  sleep?: (ms: number) => Promise<void>;
}

/** Seconds from a `retry-after` header (or its text form in an error message), as milliseconds. */
export function retryAfterMs(error: unknown): number | undefined {
  const parts: string[] = [];
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth += 1) {
    parts.push(current.message);
    const stderr = (current as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") parts.push(stderr);
  }
  const match = /retry-after["']?\s*[:=]\s*["']?(\d+)/i.exec(parts.join("\n"));
  return match ? Number(match[1]) * 1_000 : undefined;
}

export class RetryingGitHubTransport implements GitHubTransport {
  readonly #backoff: readonly number[];
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(private readonly inner: GitHubTransport, options: GitHubRetryOptions = {}) {
    this.#backoff = options.backoffMs ?? GITHUB_RETRY_BACKOFF_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.inner.request<T>(request);
      } catch (error) {
        if (attempt >= this.#backoff.length || classifyUpstreamError(error).kind !== "transient") throw error;
        await this.#sleep(Math.max(this.#backoff[attempt]!, retryAfterMs(error) ?? 0));
        // The failed create may have succeeded; return what it made rather than make it twice.
        const made = await request.recover?.().catch(() => undefined);
        if (made !== undefined) return made as T;
      }
    }
  }
}
