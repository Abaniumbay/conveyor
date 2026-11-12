// A harness's remaining usage, as the dashboard shows it. Each harness plugin reads its own quota
// (`Harness.quota`); these are the shared shapes and the helpers its reader uses.

export type QuotaWindowName = "fiveHour" | "weekly";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string;
  reportedAt: string;
}

export type QuotaWindows = Partial<Record<QuotaWindowName, QuotaWindow>>;

/** The value as a plain object, or null when it is not one. */
export function quotaRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** An ISO 8601 date from a date string or epoch milliseconds, or null when it is not a valid date. */
export function quotaDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
