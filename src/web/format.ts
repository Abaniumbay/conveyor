export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

function formatTokens(count: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (count >= size) {
      const scaled = count / size;
      return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}${unit}`;
    }
  }
  return String(count);
}

/**
 * Usage of a set of runs for the board: tokens always (subscription harnesses report no price),
 * prefixed with the dollar amount when every run reported one.
 */
export function formatUsage(usage: {
  runs: number;
  amount: number;
  unavailableRuns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}): string | null {
  if (usage.runs === 0) return null;
  const cached = usage.cachedTokens > 0 ? ` (${formatTokens(usage.cachedTokens)} cached)` : "";
  const parts = [
    `${formatTokens(usage.inputTokens)} in${cached}`,
    `${formatTokens(usage.outputTokens)} out`,
    `${usage.runs} run${usage.runs === 1 ? "" : "s"}`,
  ];
  if (usage.unavailableRuns === 0) parts.unshift(`$${usage.amount.toFixed(4)}`);
  return parts.join(" · ");
}
