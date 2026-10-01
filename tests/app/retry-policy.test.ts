import { describe, expect, test } from "bun:test";

import { infrastructureRetry, isUsageLimitError } from "../../src/app/retry-policy";
import { CodexRunnerError } from "../../src/runner/codex";

const retries = { infrastructureAttempts: 3, usageLimitAttempts: "unlimited" as const, minBackoff: 1_000, maxBackoff: 5_000 };

describe("infrastructure retry policy", () => {
  test("backs off exponentially from minBackoff up to maxBackoff", () => {
    expect(infrastructureRetry({ failures: 1, usageLimit: false, retries })).toEqual({ retryInMs: 1_000 });
    expect(infrastructureRetry({ failures: 2, usageLimit: false, retries })).toEqual({ retryInMs: 2_000 });
    expect(infrastructureRetry({ failures: 3, usageLimit: false, retries })).toEqual({ retryInMs: 4_000 });
  });

  test("stops after the configured number of attempts", () => {
    expect(infrastructureRetry({ failures: 4, usageLimit: false, retries })).toEqual({ stop: true });
    expect(infrastructureRetry({ failures: 1, usageLimit: false, retries: { ...retries, infrastructureAttempts: 0 } })).toEqual({ stop: true });
  });

  test("usage limits keep waiting at maxBackoff unless they are capped too", () => {
    expect(infrastructureRetry({ failures: 50, usageLimit: true, retries })).toEqual({ retryInMs: 5_000 });
    expect(infrastructureRetry({ failures: 3, usageLimit: true, retries: { ...retries, usageLimitAttempts: 2 } })).toEqual({ stop: true });
  });

  test("recognises usage-limit failures from runners and providers", () => {
    expect(isUsageLimitError(new CodexRunnerError("limit", "usage-limit", 1, ""))).toBe(true);
    expect(isUsageLimitError(new Error("gh: API rate limit exceeded for user ID 1"))).toBe(true);
    expect(isUsageLimitError(new Error("conversation message must not exceed 4000 characters"))).toBe(false);
  });
});
