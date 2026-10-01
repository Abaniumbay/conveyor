import { describe, expect, test } from "bun:test";

import { formatDuration, formatUsage } from "../../src/web/format";

describe("formatDuration", () => {
  test("uses readable seconds, minutes, and hours", () => {
    expect(formatDuration(1_000)).toBe("1 second");
    expect(formatDuration(59_600)).toBe("1 minute");
    expect(formatDuration(90_000)).toBe("1 minute 30 seconds");
    expect(formatDuration(5_070_000)).toBe("1 hour 24 minutes 30 seconds");
  });
});

describe("formatUsage", () => {
  const usage = { runs: 444, amount: 0, unavailableRuns: 444, inputTokens: 601_222_369, outputTokens: 2_009_500, cachedTokens: 575_658_240 };

  test("shows token usage when the price is unavailable (subscription harnesses)", () => {
    expect(formatUsage(usage)).toBe("601M in (576M cached) · 2.0M out · 444 runs");
  });

  test("adds the dollar amount when it is known and keeps small numbers exact", () => {
    expect(formatUsage({ runs: 1, amount: 0.0123, unavailableRuns: 0, inputTokens: 950, outputTokens: 12_345, cachedTokens: 0 }))
      .toBe("$0.0123 · 950 in · 12K out · 1 run");
  });

  test("is empty without runs", () => {
    expect(formatUsage({ ...usage, runs: 0 })).toBeNull();
  });
});
