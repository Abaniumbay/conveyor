import { describe, expect, test } from "bun:test";

import { formatDuration } from "../../src/web/format";

describe("formatDuration", () => {
  test("uses readable seconds, minutes, and hours", () => {
    expect(formatDuration(1_000)).toBe("1 second");
    expect(formatDuration(59_600)).toBe("1 minute");
    expect(formatDuration(90_000)).toBe("1 minute 30 seconds");
    expect(formatDuration(5_070_000)).toBe("1 hour 24 minutes 30 seconds");
  });
});
