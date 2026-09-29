const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

const UNIT_MILLISECONDS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export function parseDuration(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("duration must be a positive integer number of milliseconds");
    }
    return value;
  }

  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`invalid duration "${value}"; expected values such as 30s, 5m, or 2h`);
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MILLISECONDS;
  const milliseconds = amount * UNIT_MILLISECONDS[unit];
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`duration "${value}" does not resolve to positive whole milliseconds`);
  }
  return milliseconds;
}
