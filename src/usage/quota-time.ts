export function quotaCountdown(resetAtMs: number, nowMs = Date.now()): { stale: boolean; text: string } {
  if (resetAtMs <= nowMs) return { stale: true, text: "stale" };
  const minutes = Math.floor((resetAtMs - nowMs) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return { stale: false, text: `resets in ${days}d ${hours}h ${minutes % 60}m` };
}
