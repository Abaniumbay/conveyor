import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/web/render";
import type { DashboardViewModel } from "../../src/web/types";

const dashboard: DashboardViewModel = {
  title: "Conveyor",
  project: "sample/repo",
  updatedAt: "2026-09-29T12:00:00Z",
  stages: [
    {
      name: "Build",
      cost: "$0.42",
      issues: [
        {
          id: "parent",
          number: 41,
          title: "Build <safe> & sound",
          url: "https://github.com/sample/repo/issues/41?x=1&y=2",
          state: "in_progress",
          labels: ["feature", "priority: high"],
          acceptanceCriteria: ["<script>alert(1)</script>", "Keyboard usable"],
          activity: "Running verification",
          reason: "Waiting for checks",
          cost: "$0.42",
          duration: "3m 12s",
          blocked: true,
          inconsistent: false,
          closable: true,
          children: [
            {
              id: "child",
              number: 42,
              title: "Nested task",
              url: "https://github.com/sample/repo/issues/42",
              state: "queued",
              labels: [],
              acceptanceCriteria: [],
              activity: null,
              reason: null,
              cost: null,
              duration: null,
              blocked: false,
              inconsistent: true,
              closable: false,
              children: [],
            },
          ],
        },
      ],
    },
    { name: "Review", cost: null, issues: [] },
  ],
  backlog: [
    {
      id: "backlog",
      number: 43,
      title: "Next item",
      url: "javascript:alert(1)",
      state: "ready",
      labels: [],
      acceptanceCriteria: [],
      activity: null,
      reason: "Awaiting capacity",
      cost: null,
      duration: "1h",
      blocked: false,
      inconsistent: false,
      closable: false,
      children: [],
    },
  ],
  questions: [
    {
      id: "question/1",
      issueNumber: 43,
      prompt: "Which layout?",
      reason: "Both satisfy the acceptance criteria.",
      options: [{ id: "compact", label: "Compact" }],
      allowFreeText: false,
    },
  ],
  systemWarnings: ["meal-planner webhook is unavailable"],
  csrfToken: "csrf-token",
};

describe("renderDashboard", () => {
  test("renders stages, issue hierarchy, status detail, and operational indicators", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("<h2 id=\"stage-heading-1\">Build</h2>");
    expect(html).toContain("<h2 id=\"stage-heading-2\">Review</h2>");
    expect(html).toContain("Nested task");
    expect(html).toContain("aria-label=\"Child issues for #41\"");
    expect(html).toContain("in_progress");
    expect(html).toContain("feature");
    expect(html).toContain("Keyboard usable");
    expect(html).toContain("Running verification");
    expect(html).toContain("Waiting for checks");
    expect(html).toContain("$0.42");
    expect(html).toContain("3m 12s");
    expect(html).toContain("Blocked");
    expect(html).toContain("Inconsistent");
    expect(html).toContain("Closable");
    expect(html).toContain("Backlog");
    expect(html).toContain("Move #43 up");
    expect(html).toContain("Move #43 down");
    expect(html).toContain("Awaiting capacity");
    expect(html).toContain("Needs your input");
    expect(html).toContain("/questions/question%2F1/answer");
    expect(html).toContain('name="csrf" value="csrf-token"');
    expect(html).toContain("System attention");
    expect(html).toContain("meal-planner webhook is unavailable");
  });

  test("escapes text and attributes and rejects unsafe issue URLs", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Build &lt;safe&gt; &amp; sound");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("https://github.com/sample/repo/issues/41?x=1&amp;y=2");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("marks reorder controls disabled at backlog boundaries", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain("Move #43 up\" disabled");
    expect(html).toContain("Move #43 down\" disabled");
  });
});
