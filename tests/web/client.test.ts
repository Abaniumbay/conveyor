import { describe, expect, test } from "bun:test";

import { dashboardClient } from "../../src/web/client";

describe("dashboard browser client", () => {
  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
    expect(dashboardClient).toContain("activityUrl");
    expect(dashboardClient).toContain("appendLinkedText(parent, value.slice");
    expect(dashboardClient).toContain("appendMarkdown(body, String(message.message");
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
    expect(dashboardClient).toContain("const SUMMARY_LIVE_PARTS = ['.details-status', '.todos', '.details-facts'];");
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
    expect(dashboardClient).toContain("[data-retry-card]");
    expect(dashboardClient).toContain("[data-retry-form]");
    expect(dashboardClient).toContain("Retry accepted. A fresh attempt is queued.");
    expect(dashboardClient).toContain("Retry failed: ");
    expect(dashboardClient).toContain("button.disabled = true");
  });
});
