import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  async function checkEventLoopResponsiveness(refresh: () => void): Promise<void> {
    const started = performance.now();
    let delay = 0;
    const unrelatedRequest = new Promise<void>((resolve) => setTimeout(() => {
      delay = performance.now() - started;
      resolve();
    }, 0));
    refresh();
    await unrelatedRequest;
    expect(delay).toBeLessThan(250);
  }

  test("returns unavailable windows when session history is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-missing-"));
    temporaryDirectories.push(home);
    expect(readCodexQuota(home)).toEqual({});
  });

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

  test("reuses a recent scan instead of rereading growing session logs for every dashboard request", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-cache-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    const file = path.join(sessions, "session.jsonl");
    await writeFile(file, JSON.stringify({ timestamp: "2026-10-03T14:04:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 }, secondary: null,
    } } }) + "\n");

    expect(readCodexQuota(home).weekly?.remaining).toBe(99);
    await writeFile(file, "not json\n");
    expect(readCodexQuota(home).weekly?.remaining).toBe(99);
  });

  test("searches a bounded newest-first file set and reads only the tail of each log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-bounded-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    const quotaEvent = (windows: Record<string, unknown>, timestamp = "2026-10-03T14:00:00Z") => JSON.stringify({ timestamp, payload: { type: "token_count", rate_limits: windows } });
    for (let index = 0; index < 64; index += 1) {
      const file = path.join(sessions, `session-${String(index).padStart(3, "0")}.jsonl`);
      await writeFile(file, `${"x".repeat(70 * 1024)}\n`);
      const time = new Date(Date.parse("2026-10-03T14:00:00Z") + index * 1000);
      await utimes(file, time, time);
    }
    // The record fully inside the newest file's tail is readable even though
    // the file exceeds the byte limit. An incomplete record at the boundary
    // must be discarded instead of being mistaken for JSON.
    const newest = path.join(sessions, "session-063.jsonl");
    const insideTail = quotaEvent({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 } }, "2026-10-03T15:00:00Z");
    await writeFile(newest, `${"x".repeat(64 * 1024 - 12)}${quotaEvent({ primary: { used_percent: 2, window_minutes: 10080, resets_at: 1791580260 } })}\n${insideTail}\n`);
    await utimes(newest, new Date("2026-10-03T15:00:00Z"), new Date("2026-10-03T15:00:00Z"));
    const quota = readCodexQuota(home);
    expect(quota.weekly).toMatchObject({ remaining: 99, reportedAt: "2026-10-03T15:00:00.000Z" });
    expect(quota.fiveHour).toBeUndefined();
  });

  test("only considers the newest 64 files and keeps each quota window independent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-file-cap-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    const event = (timestamp: string, windows: Record<string, unknown>) => JSON.stringify({ timestamp, payload: { type: "token_count", rate_limits: windows } }) + "\n";
    const fiveHour = { secondary: { used_percent: 20, window_minutes: 300, resets_at: 1791052200 } };
    const weekly = { primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 } };
    for (let index = 0; index < 65; index += 1) {
      const file = path.join(sessions, `session-${String(index).padStart(3, "0")}.jsonl`);
      const contents = index === 0
        ? event("2026-10-03T14:00:00Z", weekly)
        : index === 63
          ? event("2026-10-03T14:01:00Z", fiveHour)
          : "{}\n";
      await writeFile(file, contents);
      const time = new Date(Date.parse("2026-10-03T14:00:00Z") + index * 1000);
      await utimes(file, time, time);
    }
    const quota = readCodexQuota(home);
    expect(quota.fiveHour?.remaining).toBe(80);
    // Weekly exists only in the 65th newest file, so exhausting the file
    // budget leaves it unavailable instead of falling back to a full scan.
    expect(quota.weekly).toBeUndefined();
  });

  test("finds newest readings across more than the directory budget in date-path order", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-date-tree-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    const quota = JSON.stringify({ timestamp: "2026-10-30T14:00:00Z", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 1, window_minutes: 10080, resets_at: 1791580260 },
      secondary: { used_percent: 20, window_minutes: 300, resets_at: 1791052200 },
    } } }) + "\n";
    for (let offset = 0; offset < 300; offset += 1) {
      const date = new Date(Date.UTC(2026, 9, 30) - offset * 24 * 60 * 60 * 1000);
      const dayDirectory = path.join(sessions, String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"));
      await mkdir(dayDirectory, { recursive: true });
      const file = path.join(dayDirectory, "session.jsonl");
      await writeFile(file, offset === 0 ? quota : "{}\n");
      const modified = new Date(Date.UTC(2026, 9, 30) - offset * 24 * 60 * 60 * 1000);
      await utimes(file, modified, modified);
    }
    expect(readCodexQuota(home)).toMatchObject({
      weekly: { remaining: 99, reportedAt: "2026-10-30T14:00:00.000Z" },
      fiveHour: { remaining: 80, reportedAt: "2026-10-30T14:00:00.000Z" },
    });
  });

  test("refreshes after cache expiry and completes a large-history scan within the responsiveness budget", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "conveyor-codex-quota-refresh-"));
    temporaryDirectories.push(home);
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    const newest = path.join(sessions, "newest.jsonl");
    const entry = (remaining: number) => JSON.stringify({ timestamp: "2026-10-03T14:04:00Z", payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 100 - remaining, window_minutes: 10080, resets_at: 1791580260 },
      secondary: null,
    } } }) + "\n";
    for (let index = 0; index < 1_000; index += 1) await writeFile(path.join(sessions, `unrelated-${index}.jsonl`), "{}\n");
    await writeFile(newest, entry(99));

    let now = Date.now();
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await checkEventLoopResponsiveness(() => expect(readCodexQuota(home).weekly?.remaining).toBe(99));
      await writeFile(newest, entry(80));
      expect(readCodexQuota(home).weekly?.remaining).toBe(99);
      now += 30_001;
      await checkEventLoopResponsiveness(() => expect(readCodexQuota(home).weekly?.remaining).toBe(80));
    } finally {
      dateNow.mockRestore();
    }
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
    expect(quota.weekly?.remaining).toBe(4.0000000000000036);
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
