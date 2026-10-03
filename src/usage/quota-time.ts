export function quotaCountdown(resetAtMs: number, nowMs = Date.now()): { stale: boolean; text: string } {
  if (resetAtMs <= nowMs) return { stale: true, text: "stale" };
  const minutes = Math.floor((resetAtMs - nowMs) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return { stale: false, text: `resets in ${days}d ${hours}h ${minutes % 60}m` };
}

/** Updates one quota window element; the dashboard client embeds this exact function. */
export function updateQuotaWindow(element: HTMLElement, nowMs = Date.now()): void {
  const resetAt = new Date(element.getAttribute("data-reset-at") || "").getTime();
  const countdown = element.querySelector<HTMLElement>("[data-countdown]");
  if (!countdown || Number.isNaN(resetAt)) return;
  const result = quotaCountdown(resetAt, nowMs);
  const stale = result.stale;
  const remaining = element.getAttribute("data-remaining") || "0";
  element.classList.toggle("quota-window--stale", stale);
  const value = element.querySelector<HTMLElement>(".quota-value");
  if (value) value.textContent = (stale ? "Stale · " : "") + remaining + "% left";
  countdown.textContent = result.text;
  const name = element.getAttribute("data-window-name") || "usage";
  const harnessName = element.closest(".harness-quota")?.querySelector("strong")?.textContent || "Harness";
  element.setAttribute("aria-label", harnessName + " " + name + ": " + (stale ? "stale, " : "") + remaining + "% remaining. " + (element.getAttribute("title") || ""));
}
