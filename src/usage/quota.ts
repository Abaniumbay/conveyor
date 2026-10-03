import { openSync, opendirSync, readSync, statSync, closeSync } from "node:fs";
import path from "node:path";

export type QuotaWindowName = "fiveHour" | "weekly";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string;
  reportedAt: string;
}

export type QuotaWindows = Partial<Record<QuotaWindowName, QuotaWindow>>;

const CODEX_QUOTA_CACHE_MS = 30_000;
const CODEX_MAX_DIRECTORIES = 128;
const CODEX_MAX_DIRECTORY_ENTRIES = 4_096;
const CODEX_MAX_SESSION_FILES = 64;
const CODEX_MAX_TAIL_BYTES = 64 * 1024;
const codexQuotaCache = new Map<string, { expiresAt: number; value: QuotaWindows }>();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function codexWindow(value: unknown, reportedAt: string): [QuotaWindowName, QuotaWindow] | null {
  const window = record(value);
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) ||
      window.used_percent < 0 || window.used_percent > 100 || typeof window.window_minutes !== "number") return null;
  const name = window.window_minutes === 300 ? "fiveHour" : window.window_minutes === 10080 ? "weekly" : null;
  const resetSeconds = window.resets_at;
  if (!name || typeof resetSeconds !== "number" || !Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;
  const resetsAt = validDate(resetSeconds * 1000);
  if (!resetsAt) return null;
  return [name, { remaining: 100 - window.used_percent, resetsAt, reportedAt }];
}

function newestJsonlFiles(root: string): Array<{ path: string; modifiedAt: number }> {
  const directories = [root];
  const files: Array<{ path: string; modifiedAt: number }> = [];
  let entriesRead = 0;
  for (let next = 0; next < directories.length && next < CODEX_MAX_DIRECTORIES && entriesRead < CODEX_MAX_DIRECTORY_ENTRIES; next += 1) {
    let directory;
    try {
      directory = opendirSync(directories[next]!);
    } catch {
      continue;
    }
    try {
      let entry;
      while (entriesRead < CODEX_MAX_DIRECTORY_ENTRIES && (entry = directory.readSync()) !== null) {
        entriesRead += 1;
        const entryPath = path.join(directories[next]!, entry.name);
        if (entry.isDirectory()) {
          if (directories.length < CODEX_MAX_DIRECTORIES) directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            files.push({ path: entryPath, modifiedAt: statSync(entryPath).mtimeMs });
          } catch {
            // Files that disappear during enumeration are ignored.
          }
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, CODEX_MAX_SESSION_FILES);
}

function readTail(file: string): { contents: string; modifiedAt: string; truncated: boolean } | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const stat = statSync(file);
    const length = Math.min(stat.size, CODEX_MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, stat.size - length);
    return {
      contents: buffer.toString("utf8"),
      modifiedAt: stat.mtime.toISOString(),
      truncated: stat.size > CODEX_MAX_TAIL_BYTES,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Reads the most recent valid Codex quota value per supported window from local session logs. */
export function readCodexQuota(codexHome: string): QuotaWindows {
  const now = Date.now();
  const cached = codexQuotaCache.get(codexHome);
  if (cached && cached.expiresAt > now) return cached.value;
  const latest: QuotaWindows = {};
  const latestTimes: Partial<Record<QuotaWindowName, number>> = {};
  for (const file of newestJsonlFiles(path.join(codexHome, "sessions"))) {
    const tail = readTail(file.path);
    if (!tail) continue;
    const lines = tail.contents.split(/\r?\n/);
    // The first line may begin mid-record when the tail starts inside a large file.
    if (tail.truncated) lines.shift();
    for (const line of lines.reverse()) {
      if (!line) continue;
      let event: Record<string, unknown> | null;
      try {
        event = record(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = record(event?.payload);
      if (payload?.type !== "token_count") continue;
      const limits = record(payload.rate_limits);
      if (!limits) continue;
      const reportedAt = validDate(event?.timestamp) ?? tail.modifiedAt;
      for (const key of ["primary", "secondary"] as const) {
        const parsed = codexWindow(limits[key], reportedAt);
        if (!parsed) continue;
        const [name, quota] = parsed;
        const time = Date.parse(quota.reportedAt);
        if ((latestTimes[name] ?? -Infinity) > time) continue;
        latest[name] = quota;
        latestTimes[name] = time;
      }
    }
    if (latest.fiveHour && latest.weekly) break;
  }
  codexQuotaCache.set(codexHome, { expiresAt: now + CODEX_QUOTA_CACHE_MS, value: latest });
  return latest;
}

/** Reads persisted Claude stream events; callers supply their run_events creation timestamps. */
export function readClaudeQuota(events: readonly { payload: unknown; createdAt: string }[]): QuotaWindows {
  const latest: QuotaWindows = {};
  const latestTimes: Partial<Record<QuotaWindowName, number>> = {};
  for (const event of events) {
    const reportedAt = validDate(event.createdAt);
    const payload = record(event.payload);
    const info = record(payload?.rate_limit_info);
    const windows = record(info?.unifiedWindows);
    if (payload?.type !== "rate_limit_event" || !reportedAt || !windows) continue;
    for (const [key, name] of [["five_hour", "fiveHour"], ["seven_day", "weekly"]] as const) {
      const value = record(windows[key]);
      if (!value || typeof value.utilization !== "number" || !Number.isFinite(value.utilization) ||
          value.utilization < 0 || value.utilization > 1) continue;
      const resetsAt = validDate(value.resetsAt);
      if (!resetsAt) continue;
      const time = Date.parse(reportedAt);
      if ((latestTimes[name] ?? -Infinity) > time) continue;
      latest[name] = { remaining: 100 * (1 - value.utilization), resetsAt, reportedAt };
      latestTimes[name] = time;
    }
  }
  return latest;
}
