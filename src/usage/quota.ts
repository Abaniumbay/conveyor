import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type QuotaWindowName = "fiveHour" | "weekly";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string;
  reportedAt: string;
}

export type QuotaWindows = Partial<Record<QuotaWindowName, QuotaWindow>>;

const CODEX_QUOTA_CACHE_MS = 30_000;
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

function jsonlFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return jsonlFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
  });
}

/** Reads the most recent valid Codex quota value per supported window from local session logs. */
export function readCodexQuota(codexHome: string): QuotaWindows {
  const now = Date.now();
  const cached = codexQuotaCache.get(codexHome);
  if (cached && cached.expiresAt > now) return cached.value;
  const latest: QuotaWindows = {};
  const latestTimes: Partial<Record<QuotaWindowName, number>> = {};
  for (const file of jsonlFiles(path.join(codexHome, "sessions"))) {
    let contents: string;
    let modifiedAt: string;
    try {
      contents = readFileSync(file, "utf8");
      modifiedAt = statSync(file).mtime.toISOString();
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
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
      const reportedAt = validDate(event?.timestamp) ?? modifiedAt;
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
