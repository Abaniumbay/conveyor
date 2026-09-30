import { HarnessError, type HarnessErrorKind } from "./harness-error";

export interface HarnessRetryPolicy {
  infrastructureAttempts: number;
  usageLimitAttempts: number | "unlimited";
  minBackoff: number;
  maxBackoff: number;
}

export class HarnessRetryExhaustedError extends HarnessError {
  override readonly name = "HarnessRetryExhaustedError";
  readonly retryExhausted = true;

  constructor(kind: HarnessErrorKind, attempts: number, cause: unknown) {
    super(`Harness ${kind} retry limit reached after ${attempts} attempt(s)`, kind, { cause });
  }
}

function failureKind(error: unknown): HarnessErrorKind {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === "usage-limit" || kind === "protocol" || kind === "timeout" || kind === "interrupted"
    ? kind
    : "process";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new HarnessError("Run interrupted during retry backoff", "interrupted", { cause: signal.reason }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new HarnessError("Run interrupted during retry backoff", "interrupted", { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runWithHarnessRetries<T>(
  run: () => Promise<T>,
  policy: HarnessRetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  let infrastructure = 0;
  let usageLimit = 0;
  let retryIndex = 0;
  while (true) {
    if (signal?.aborted) throw new HarnessError("Run interrupted before retry", "interrupted", { cause: signal.reason });
    try {
      return await run();
    } catch (error) {
      const kind = failureKind(error);
      if (kind === "interrupted" || signal?.aborted) throw error;
      const attempts = kind === "usage-limit"
        ? policy.usageLimitAttempts
        : policy.infrastructureAttempts;
      if (kind === "usage-limit") usageLimit += 1;
      else infrastructure += 1;
      const used = kind === "usage-limit" ? usageLimit : infrastructure;
      if (attempts !== "unlimited" && used >= attempts) {
        throw new HarnessRetryExhaustedError(kind, used, error);
      }
      const backoff = Math.min(policy.maxBackoff, policy.minBackoff * 2 ** retryIndex);
      retryIndex += 1;
      await delay(backoff, signal);
    }
  }
}
