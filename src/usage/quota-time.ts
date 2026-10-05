export function quotaCountdown(resetAtMs: number, nowMs = Date.now()): { stale: boolean; text: string } {
  if (resetAtMs <= nowMs) return { stale: true, text: "stale" };
  const minutes = Math.floor((resetAtMs - nowMs) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return { stale: false, text: `resets in ${days}d ${hours}h ${minutes % 60}m` };
}

/** Updates one quota window element; the dashboard client embeds this exact function. */
export function updateQuotaWindow(element: HTMLElement, nowMs = Date.now()): void {
  const resetAtIso = element.getAttribute("data-reset-at");
  const reportedAtIso = element.getAttribute("data-reported-at");
  const resetAtMs = resetAtIso ? new Date(resetAtIso).getTime() : NaN;
  const countdown = element.querySelector<HTMLElement>("[data-countdown]");
  if (!countdown || Number.isNaN(resetAtMs)) return;
  const result = quotaCountdown(resetAtMs, nowMs);
  const stale = result.stale;
  const remaining = element.getAttribute("data-remaining") || "0";
  element.classList.toggle("quota-window--stale", stale);
  const value = element.querySelector<HTMLElement>(".quota-value");
  if (value) value.textContent = stale ? "Stale" : remaining + "% left";
  countdown.textContent = result.text;
  const name = element.getAttribute("data-window-name") || "usage";
  const harnessName = element.closest(".harness-quota")?.querySelector("strong")?.textContent || "Harness";
  const formatLocalDateTime = (iso: string | null): string => {
    if (!iso || Number.isNaN(new Date(iso).getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(iso));
  };
  const reset = formatLocalDateTime(resetAtIso);
  const reported = formatLocalDateTime(reportedAtIso);
  const resetDetail = element.querySelector<HTMLElement>("[data-reset-detail]");
  const reportedDetail = element.querySelector<HTMLElement>("[data-reported-detail]");
  if (resetDetail) resetDetail.textContent = reset ? `Reset: ${reset}` : "";
  if (reportedDetail) reportedDetail.textContent = reported ? `Last reported: ${reported}` : "";
  const title = [reset && `Reset: ${reset}.`, reported && `Last reported: ${reported}.`].filter(Boolean).join(" ");
  element.setAttribute("title", title);
  element.setAttribute("aria-label", harnessName + " " + name + ": " + (stale ? "stale. " : remaining + "% remaining. ") + title);
}
