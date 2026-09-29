import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/web/render";
import type { DashboardViewModel, IssueCardViewModel } from "../../src/web/types";

const parent: IssueCardViewModel = {
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
  tone: "warning",
  parent: null,
  children: [{ number: 42, title: "Nested task", url: "https://github.com/sample/repo/issues/42" }],
};

const backlogIssue: IssueCardViewModel = {
  id: "backlog",
  number: 43,
  title: "Next item",
  url: "javascript:alert(1)",
  state: "active",
  labels: [],
  acceptanceCriteria: [],
  activity: null,
  reason: "Awaiting capacity",
  cost: null,
  duration: "1h",
  blocked: false,
  inconsistent: false,
  closable: false,
  tone: "active",
  parent: null,
  children: [],
};

const dashboard: DashboardViewModel = {
  title: "Conveyor",
  project: "sample/repo",
  updatedAt: "2026-09-29T12:00:00Z",
  view: "board",
  counts: { board: 41, backlog: 1, attention: 1 },
  stages: [
    {
      id: "stage:build",
      name: "Build",
      cost: "$0.42",
      totalIssues: 41,
      page: 2,
      totalPages: 3,
      issues: [parent],
    },
    {
      id: "stage:review",
      name: "Review",
      cost: null,
      totalIssues: 0,
      page: 1,
      totalPages: 1,
      issues: [],
    },
  ],
  backlog: [backlogIssue],
  attention: {
    id: "attention",
    name: "Needs attention",
    cost: null,
    totalIssues: 1,
    page: 1,
    totalPages: 1,
    issues: [{ ...backlogIssue, reason: "No valid configured stage label is present.", tone: "danger" }],
  },
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
  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Configured pipeline stages");
    expect(html).toContain(">Build</h2>");
    expect(html).toContain(">Review</h2>");
    expect(html).toContain('aria-label="41 issues"');
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=1");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=3");
    expect(html).toContain("issue--warning");
    expect(html).toContain("Nested task");
    expect(html).toContain("Issue relationships for #41");
    expect(html).toContain("in_progress");
    expect(html).toContain("Keyboard usable");
    expect(html).toContain("Running verification");
    expect(html).toContain("Waiting for checks");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Needs your input");
    expect(html).toContain("/questions/question%2F1/answer");
    expect(html).toContain('name="csrf" value="csrf-token"');
    expect(html).toContain("System attention");
  });

  test("uses Preact escaping and rejects unsafe issue URLs", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
    expect(html).toContain("https://github.com/sample/repo/issues/41?x=1&amp;y=2");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders backlog controls only on the backlog tab", () => {
    const html = renderDashboard({ ...dashboard, view: "backlog" });
    expect(html).toContain("Ordered backlog");
    expect(html).toContain('aria-current="page">Backlog');
    expect(html).toContain('Move #43 up" disabled');
    expect(html).toContain('Move #43 down" disabled');
  });

  test("renders invalid stage labels on the separate attention tab", () => {
    const html = renderDashboard({ ...dashboard, view: "attention" });
    expect(html).toContain("missing, unknown, or conflicting stage label");
    expect(html).toContain("No valid configured stage label is present.");
    expect(html).not.toContain("Configured pipeline stages");
  });
});
