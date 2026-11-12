import { quotaDate, quotaRecord, type QuotaWindowName, type QuotaWindows } from "../../usage/quota";

/** Reads persisted Claude stream events; callers supply their run_events creation timestamps. */
export function readClaudeQuota(events: readonly { payload: unknown; createdAt: string }[]): QuotaWindows {
  const latest: QuotaWindows = {};
  const latestTimes: Partial<Record<QuotaWindowName, number>> = {};
  for (const event of events) {
    const reportedAt = quotaDate(event.createdAt);
    const payload = quotaRecord(event.payload);
    const info = quotaRecord(payload?.rate_limit_info);
    const windows = quotaRecord(info?.unifiedWindows);
    if (payload?.type !== "rate_limit_event" || !reportedAt || !windows) continue;
    for (const [key, name] of [["five_hour", "fiveHour"], ["seven_day", "weekly"]] as const) {
      const value = quotaRecord(windows[key]);
      if (!value || typeof value.utilization !== "number" || !Number.isFinite(value.utilization) ||
          value.utilization < 0 || value.utilization > 1) continue;
      // The Claude CLI reports numeric reset times as epoch seconds.
      const resetsAt = typeof value.resetsAt === "number"
        ? (value.resetsAt > 0 ? quotaDate(value.resetsAt * 1000) : null)
        : quotaDate(value.resetsAt);
      if (!resetsAt) continue;
      const time = Date.parse(reportedAt);
      if ((latestTimes[name] ?? -Infinity) > time) continue;
      latest[name] = { remaining: 100 * (1 - value.utilization), resetsAt, reportedAt };
      latestTimes[name] = time;
    }
  }
  return latest;
}
