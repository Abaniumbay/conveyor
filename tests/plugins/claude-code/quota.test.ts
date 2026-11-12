import { describe, expect, test } from "bun:test";

import { readClaudeQuota } from "../../../src/plugins/claude-code/quota";

describe("Claude Code quota telemetry", () => {
  test("selects the latest persisted valid event and maps utilization to remaining capacity", () => {
    const quota = readClaudeQuota([
      { createdAt: "2026-10-03T14:04:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: "2026-10-03T18:30:00.000Z" },
        seven_day: { utilization: 0.96, resetsAt: "2026-10-05T22:00:00.000Z" },
      } } } },
      { createdAt: "2026-10-03T14:10:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 0.2, resetsAt: "2026-10-03T19:00:00.000Z" },
        seven_day: null,
      } } } },
      { createdAt: "2026-10-03T14:11:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 2, resetsAt: "invalid" }, seven_day: null,
      } } } },
      { createdAt: "bad timestamp", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 0, resetsAt: "2026-10-03T20:00:00.000Z" },
      } } } },
    ]);

    expect(quota.fiveHour).toEqual({ remaining: 80, resetsAt: "2026-10-03T19:00:00.000Z", reportedAt: "2026-10-03T14:10:00.000Z" });
    expect(quota.weekly?.remaining).toBe(4.0000000000000036);
    expect(quota.weekly?.resetsAt).toBe("2026-10-05T22:00:00.000Z");
    expect(quota.weekly?.reportedAt).toBe("2026-10-03T14:04:00.000Z");
  });
});

describe("Claude Code quota epoch-seconds resetsAt", () => {
  const realEvent = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed", resetsAt: 1793568600, rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.18, resetsAt: 1793568600 },
        seven_day: { utilization: 0.06, resetsAt: 1793656800 },
      },
    },
  };

  test("reads the five-hour window from numeric epoch seconds", () => {
    const quota = readClaudeQuota([{ createdAt: "2026-11-01T18:00:00.000Z", payload: realEvent }]);
    expect(quota.fiveHour?.resetsAt).toBe(new Date(1793568600 * 1000).toISOString());
    expect(quota.fiveHour?.remaining).toBeCloseTo(82);
  });

  test("reads the weekly window from numeric epoch seconds", () => {
    const quota = readClaudeQuota([{ createdAt: "2026-11-01T18:00:00.000Z", payload: realEvent }]);
    expect(quota.weekly?.resetsAt).toBe(new Date(1793656800 * 1000).toISOString());
    expect(quota.weekly?.remaining).toBeCloseTo(94);
  });

  test("still accepts an ISO-string resetsAt unchanged", () => {
    const quota = readClaudeQuota([{ createdAt: "2026-11-01T18:00:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.5, resetsAt: "2026-11-01T20:00:00.000Z" },
    } } } }]);
    expect(quota.fiveHour?.resetsAt).toBe("2026-11-01T20:00:00.000Z");
  });

  test("ignores windows whose numeric resetsAt is not finite or not a valid date", () => {
    const window = (resetsAt: number) => ({ utilization: 0.5, resetsAt });
    const quota = readClaudeQuota([{ createdAt: "2026-11-01T18:00:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: window(Number.NaN), seven_day: window(Number.POSITIVE_INFINITY),
    } } } }, { createdAt: "2026-11-01T18:01:00.000Z", payload: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: window(1e300), seven_day: window(-5),
    } } } }]);
    expect(quota).toEqual({});
  });
});
