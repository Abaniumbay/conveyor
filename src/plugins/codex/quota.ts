import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { quotaDate, quotaRecord, type QuotaWindow, type QuotaWindowName, type QuotaWindows } from "../../usage/quota";

const CODEX_QUOTA_CACHE_MS = 30_000;
const CODEX_MAX_DIRECTORIES = 128;
const CODEX_MAX_DIRECTORY_ENTRIES = 4_096;
const CODEX_MAX_SESSION_FILES = 64;
const CODEX_MAX_TAIL_BYTES = 64 * 1024;
const codexQuotaCache = new Map<string, { expiresAt: number; value: QuotaWindows }>();

function codexWindow(value: unknown, reportedAt: string): [QuotaWindowName, QuotaWindow] | null {
  const window = quotaRecord(value);
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent) ||
      window.used_percent < 0 || window.used_percent > 100 || typeof window.window_minutes !== "number") return null;
  const name = window.window_minutes === 300 ? "fiveHour" : window.window_minutes === 10080 ? "weekly" : null;
  const resetSeconds = window.resets_at;
  if (!name || typeof resetSeconds !== "number" || !Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;
  const resetsAt = quotaDate(resetSeconds * 1000);
  if (!resetsAt) return null;
  return [name, { remaining: 100 - window.used_percent, resetsAt, reportedAt }];
}

function newestJsonlFiles(root: string): Array<{ path: string; modifiedAt: number }> {
  const directories = [root];
  const files: Array<{ path: string; modifiedAt: number }> = [];
  let entriesRead = 0;
  for (let next = 0; next < directories.length && next < CODEX_MAX_DIRECTORIES && entriesRead < CODEX_MAX_DIRECTORY_ENTRIES; next += 1) {
    let entries;
    try {
      // Codex's YYYY/MM/DD layout sorts chronologically by name. Order each
      // level before applying traversal budgets so old readdir order cannot
      // consume the bounded search ahead of newer session directories.
      entries = readdirSync(directories[next]!, { withFileTypes: true })
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entriesRead >= CODEX_MAX_DIRECTORY_ENTRIES) break;
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
        event = quotaRecord(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = quotaRecord(event?.payload);
      if (payload?.type !== "token_count") continue;
      const limits = quotaRecord(payload.rate_limits);
      if (!limits) continue;
      const reportedAt = quotaDate(event?.timestamp) ?? tail.modifiedAt;
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
