import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readClaudeQuota, readCodexQuota } from "../../src/usage/quota";
import { quotaCountdown } from "../../src/usage/quota-time";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex quota telemetry", () => {
  test("selects latest valid 5-hour and weekly readings and ignores absent or malformed windows", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions", "2026", "10", "03");
    await mkdir(sessions, { recursive: true });
    const first = path.join(sessions, "first.jsonl");
    const later = path.join(sessions, "later.jsonl");
    await writeFile(first, JSON.stringify({ timestamp: "2026-10-03T14:00:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 20, window_minutes: 10080, resets_at: 1791580260 },
      secondary: { used_percent: 30, window_minutes: 300, resets_at: 1791052200 },
    } } }) + "\n");
    await writeFile(later, [
      JSON.stringify({ timestamp: "2026-10-03T14:04:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
        primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 }, secondary: null,
      } } }),
      JSON.stringify({ timestamp: "2026-10-03T14:05:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
        primary: { used_percent: 101, window_minutes: 10080, resets_at: 1791580260 },
        secondary: { used_percent: 10, window_minutes: 300, resets_at: "bad" },
        tertiary: { used_percent: 4, window_minutes: 300, resets_at: 1791042600 },
      } } }),
    ].join("\n") + "\n");

    const quota = readCodexQuota(home);

    expect(quota).toEqual({
      weekly: { remaining: 99, resetsAt: "2026-10-09T21:11:00.000Z", reportedAt: "2026-10-03T14:04:00.000Z" },
      fiveHour: { remaining: 70, resetsAt: "2026-10-03T18:30:00.000Z", reportedAt: "2026-10-03T14:00:00.000Z" },
    });
  });

  test("keeps valid windows when a session file is unreadable or contains invalid JSON", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    await writeFile(path.join(sessions, "bad.jsonl"), "not json\n");
    const valid = path.join(sessions, "valid.jsonl");
    await writeFile(valid, JSON.stringify({ timestamp: "2026-10-03T14:04:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 }, secondary: null,
    } } }) + "\n");
    await utimes(valid, new Date("2026-10-03T14:04:00Z"), new Date("2026-10-03T14:04:00Z"));

    expect(readCodexQuota(home).weekly?.remaining).toBe(99);
  });
});

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
    expect(quota.weekly?.remaining).toBeCloseTo(4);
    expect(quota.weekly?.resetsAt).toBe("2026-10-05T22:00:00.000Z");
    expect(quota.weekly?.reportedAt).toBe("2026-10-03T14:04:00.000Z");
  });
});

describe("quota countdown", () => {
  test("formats days, hours and minutes, clamps at reset, and identifies stale windows", () => {
    const now = Date.parse("2026-10-03T14:04:00.000Z");
    expect(quotaCountdown(Date.parse("2026-10-05T22:00:00.000Z"), now)).toEqual({ stale: false, text: "resets in 2d 7h 56m" });
    expect(quotaCountdown(now + 30000, now)).toEqual({ stale: false, text: "resets in 0d 0h 0m" });
    expect(quotaCountdown(now, now)).toEqual({ stale: true, text: "stale" });
    expect(quotaCountdown(now - 60000, now)).toEqual({ stale: true, text: "stale" });
  });
});
