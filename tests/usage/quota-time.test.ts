import { describe, expect, test } from "bun:test";

import { quotaCountdown, updateQuotaWindow } from "../../src/usage/quota-time";

describe("updateQuotaWindow", () => {
  test("updates the browser quota element countdown and stale accessibility state", () => {
    const now = Date.parse("2026-10-03T14:04:00.000Z");
    const attributes = new Map<string, string>([
      ["data-reset-at", "2026-10-05T22:00:00.000Z"],
      ["data-reported-at", "2026-10-03T14:04:00.000Z"],
      ["data-remaining", "4"],
      ["data-window-name", "weekly"],
    ]);
    const countdown = { textContent: "" };
    const value = { textContent: "" };
    const lowLabel = { hidden: false };
    const resetDetail = { textContent: "" };
    const reportedDetail = { textContent: "" };
    const classes = new Set<string>(["quota-window--low"]);
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      querySelector: (selector: string) => selector === "[data-countdown]" ? countdown
        : selector === ".quota-value" ? value
          : selector === ".quota-low-label" ? lowLabel
          : selector === "[data-reset-detail]" ? resetDetail
            : selector === "[data-reported-detail]" ? reportedDetail : null,
      classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
      closest: () => ({ querySelector: () => ({ textContent: "Claude Code" }) }),
      setAttribute: (name: string, content: string) => attributes.set(name, content),
    } as unknown as HTMLElement;

    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("resets in 2d 7h 56m");
    expect(value.textContent).toBe("4% left");
    expect(attributes.get("aria-label")).toContain("Claude Code weekly: 4% remaining.");
    const format = (iso: string) => new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(iso));
    expect(resetDetail.textContent).toBe(`Reset: ${format("2026-10-05T22:00:00.000Z")}`);
    expect(reportedDetail.textContent).toBe(`Last reported: ${format("2026-10-03T14:04:00.000Z")}`);
    expect(classes.has("quota-window--stale")).toBe(false);
    expect(classes.has("quota-window--low")).toBe(true);
    expect(lowLabel.hidden).toBe(false);

    attributes.set("data-reset-at", new Date(now).toISOString());
    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("stale");
    expect(value.textContent).toBe("Stale");
    expect(attributes.get("aria-label")).toContain("weekly: stale.");
    expect(attributes.get("aria-label")).not.toContain("remaining");
    expect(classes.has("quota-window--stale")).toBe(true);
    expect(classes.has("quota-window--low")).toBe(false);
    expect(lowLabel.hidden).toBe(true);

    attributes.set("data-reset-at", "2026-10-05T22:00:00.000Z");
    updateQuotaWindow(element, quotaCountdown, now);
    expect(countdown.textContent).toBe("resets in 2d 7h 56m");
    expect(value.textContent).toBe("4% left");
    expect(attributes.get("aria-label")).toContain("weekly: 4% remaining.");
    expect(classes.has("quota-window--stale")).toBe(false);
    expect(classes.has("quota-window--low")).toBe(true);
    expect(lowLabel.hidden).toBe(false);
  });
});
