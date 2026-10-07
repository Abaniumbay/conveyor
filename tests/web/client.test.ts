import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dashboardClient } from "../../src/web/client";
import { quotaCountdown, updateQuotaWindow } from "../../src/usage/quota-time";

describe("dashboard browser client", () => {
  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
    expect(dashboardClient).toContain("activityUrl");
    expect(dashboardClient).toContain("appendLinkedText(parent, value.slice");
    expect(dashboardClient).toContain("appendMarkdown(body, String(message.message");
    expect(dashboardClient).toContain("String(message.actorName ||");
    expect(dashboardClient).toContain("actorAvatar(actorName, message.actorType, message.actorAvatar)");
    expect(dashboardClient).not.toContain("actor.textContent = 'You'");
    expect(dashboardClient).toContain("'/backlog/move'");
    expect(dashboardClient).toContain("addEventListener('dragend'");
    expect(dashboardClient).toContain("data-detail-tab");
    expect(dashboardClient).toContain("new EventSource('/events/dashboard')");
    expect(dashboardClient).toContain("addEventListener('conversation'");
    expect(dashboardClient).toContain("addEventListener('activity'");
    expect(dashboardClient).toContain("scheduleActivityRefresh");
    expect(dashboardClient).toContain("loadIssueJourney");
    expect(dashboardClient).toContain("journey.now");
    expect(dashboardClient).toContain("journey-entry--now");
    // The journey reads oldest first, so the current position is appended after the history.
    expect(dashboardClient.indexOf("if (nowItem) root.append(nowItem);")).toBeGreaterThan(dashboardClient.indexOf("for (const transition of transitions)"));
    expect(dashboardClient).toContain("now.state === 'done' || now.state === 'completed'");
    expect(dashboardClient).toContain("scheduleJourneyRefresh");
    // An open issue dialog still gets its live summary parts (todos above all) without a page refresh.
    expect(dashboardClient).toContain("scheduleSummaryRefresh();");
    expect(dashboardClient).toContain("const SUMMARY_LIVE_PARTS = ['.details-status', '.indicators', '.todos', '.details-facts'];");
    expect(dashboardClient).toContain("card.querySelector(':scope > .todo-progress')");
    expect(dashboardClient).not.toContain("/api/dashboard-revision");
    expect(dashboardClient).toContain("issuePath(dialog, name)");
    expect(dashboardClient).toContain("data-more-runs");
    expect(dashboardClient).toContain("data-more-events");
    expect(dashboardClient).toContain("field.value = ''");
    expect(dashboardClient).toContain("field.value = submittedMessage");
    expect(dashboardClient).toContain("name === 'journey'");
    expect(dashboardClient).toContain("new DOMParser()");
    expect(dashboardClient).toContain("currentDashboard.replaceWith(nextDashboard)");
    expect(dashboardClient).toContain("history.pushState({ conveyorPage: true }");
    expect(dashboardClient).toContain("document.title = nextDocument.title");
    expect(dashboardClient).toContain("void navigateDashboard(destination)");
    expect(dashboardClient).toContain("new URL(location.href), 'none'");
    expect(dashboardClient).toContain("conveyor:dashboard-rendered");
    expect(dashboardClient).toContain("destination.origin !== location.origin");
    expect(dashboardClient).toContain("body.classList.add('dashboard-navigating')");
    expect(dashboardClient).not.toContain("body.classList.add('page-loading')");
    expect(dashboardClient).toContain("time[data-relative-time][datetime]");
    expect(dashboardClient).not.toContain("location.reload()")
    expect(dashboardClient).toContain("dialog.showModal();");
    expect(dashboardClient).not.toContain("dialog.show();");
    expect(dashboardClient).toContain("classList.toggle('is-selected', selected)");
    expect(dashboardClient).toContain("parseDashboardPath");
    expect(dashboardClient).toContain("'/issues/'");
    expect(dashboardClient).toContain("'/team/'");
    expect(dashboardClient).toContain("event.key === 'Escape'");
    expect(dashboardClient).toContain(": 'Operator'");
    expect(dashboardClient).toContain("localStorage.setItem('conveyor-theme'");
    expect(dashboardClient).toContain("delete document.documentElement.dataset.theme");
    expect(dashboardClient).toContain("data-theme-choice");
    expect(dashboardClient).toContain("closeHeaderPopovers");
    expect(dashboardClient).toContain("document.addEventListener('toggle'");
    expect(dashboardClient).toContain("closest('.dashboard-header details')");
    expect(dashboardClient).toContain("openDetails.querySelector('summary')");
    expect(dashboardClient).toContain("summary.focus()");
    expect(dashboardClient).toContain("window.setInterval(updateQuotaCountdowns, 60_000)");
    expect(dashboardClient).toContain("countdownOf(resetAtMs, nowMs)");
    expect(dashboardClient).toContain("updateQuotaWindow(quotaWindow, quotaCountdown)");
    expect(dashboardClient).toContain("new Intl.DateTimeFormat(undefined");
    expect(dashboardClient).toContain("quota-window--stale");
    expect(dashboardClient).toContain("[data-retry-card]");
    expect(dashboardClient).toContain("[data-retry-form]");
    expect(dashboardClient).toContain("[data-profile-avatar-form], [data-account-create-form]");
    expect(dashboardClient).toContain(".account-avatar, [data-profile-avatar]");
    expect(dashboardClient).toContain("status.textContent = 'Saved.'");
    expect(dashboardClient).toContain("new FormData(form)");
    expect(dashboardClient).toContain("Retry accepted. A fresh attempt is queued.");
    expect(dashboardClient).toContain("Retry failed: ");
    expect(dashboardClient).toContain("button.disabled = true");
  });

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

  test("the embedded quota code runs on its own after a minified build, as the release serves it", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "conveyor-client-"));
    try {
      const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../../src/web/client.ts")], outdir: out, target: "bun", minify: true });
      expect(built.success).toBe(true);
      const { quotaClient } = await import(built.outputs[0]!.path) as { quotaClient: string };
      const [countdown, update] = new Function(`${quotaClient}\nreturn [quotaCountdown, updateQuotaWindow];`)() as [typeof quotaCountdown, typeof updateQuotaWindow];
      const text = { textContent: "" };
      const element = {
        getAttribute: (name: string) => name === "data-reset-at" ? "2026-10-05T22:00:00.000Z" : name === "data-remaining" ? "40" : null,
        querySelector: (selector: string) => selector === "[data-countdown]" ? text : null,
        classList: { toggle: () => {} },
        closest: () => null,
        setAttribute: () => {},
      } as unknown as HTMLElement;
      update(element, countdown, Date.parse("2026-10-03T14:04:00.000Z"));
      expect(text.textContent).toBe("resets in 2d 7h 56m");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
