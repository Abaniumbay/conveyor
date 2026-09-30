import { describe, expect, test } from "bun:test";

import { dashboardClient } from "../../src/web/client";

describe("dashboard browser client", () => {
  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
    expect(dashboardClient).toContain("activityUrl");
    expect(dashboardClient).toContain("appendLinkedText(body, String(message.message");
    expect(dashboardClient).toContain("data-detail-tab");
    expect(dashboardClient).toContain("new EventSource('/events/dashboard')");
    expect(dashboardClient).toContain("addEventListener('conversation'");
    expect(dashboardClient).toContain("addEventListener('activity'");
    expect(dashboardClient).toContain("scheduleActivityRefresh");
    expect(dashboardClient).toContain("loadIssueJourney");
    expect(dashboardClient).toContain("scheduleJourneyRefresh");
    expect(dashboardClient).not.toContain("/api/dashboard-revision");
    expect(dashboardClient).toContain("url.searchParams.set('tab', name)");
    expect(dashboardClient).toContain("data-more-runs");
    expect(dashboardClient).toContain("data-more-events");
    expect(dashboardClient).toContain("field.value = ''");
    expect(dashboardClient).toContain("field.value = submittedMessage");
    expect(dashboardClient).toContain("name === 'journey'");
    expect(dashboardClient).toContain("new DOMParser()");
    expect(dashboardClient).toContain("currentDashboard.replaceWith(nextDashboard)");
    expect(dashboardClient).not.toContain("location.reload()")
  });
});
