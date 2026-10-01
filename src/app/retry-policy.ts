import type { ConveyorConfig } from "../config/load";
import { InfrastructureError } from "../tasks/contract";

type RetrySettings = ConveyorConfig["settings"]["retries"];

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b|quota/i;

/** A failure that clears by waiting (runner usage limit, provider rate limit) rather than a fault. */
export function isUsageLimitError(error: unknown): boolean {
  if (error instanceof InfrastructureError && error.usageLimit) return true;
  if (error && typeof error === "object" && (error as { kind?: unknown }).kind === "usage-limit") return true;
  return USAGE_LIMIT_PATTERN.test(error instanceof Error ? error.message : String(error));
}

/**
 * What to do after the `failures`-th consecutive infrastructure failure of a stage: wait with
 * exponential backoff (minBackoff, doubling, capped at maxBackoff), or stop once the configured
 * attempts are used up. Usage limits wait at the same backoff and stop only if they are capped.
 */
export function infrastructureRetry(input: {
  failures: number;
  usageLimit: boolean;
  retries: RetrySettings;
}): { retryInMs: number } | { stop: true } {
  const cap = input.usageLimit ? input.retries.usageLimitAttempts : input.retries.infrastructureAttempts;
  if (cap !== "unlimited" && input.failures > cap) return { stop: true };
  const exponent = Math.min(input.failures - 1, 30);
  return { retryInMs: Math.min(input.retries.maxBackoff, input.retries.minBackoff * 2 ** exponent) };
}
