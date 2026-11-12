import { describe, expect, test } from "bun:test";

import { quotaCountdown } from "../../src/usage/quota-time";

describe("quota countdown", () => {
  test("formats days, hours and minutes, clamps at reset, and identifies stale windows", () => {
    const now = Date.parse("2026-10-03T14:04:00.000Z");
    expect(quotaCountdown(Date.parse("2026-10-05T22:00:00.000Z"), now)).toEqual({ stale: false, text: "resets in 2d 7h 56m" });
    expect(quotaCountdown(now + 30000, now)).toEqual({ stale: false, text: "resets in 0d 0h 0m" });
    expect(quotaCountdown(now, now)).toEqual({ stale: true, text: "stale" });
    expect(quotaCountdown(now - 60000, now)).toEqual({ stale: true, text: "stale" });
  });
});
