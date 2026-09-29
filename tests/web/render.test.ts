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
  dependencies: [{ number: 40, title: "Required foundation", url: "https://github.com/sample/repo/issues/40" }],
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
  dependencies: [],
};

const completedIssue: IssueCardViewModel = {
  ...backlogIssue,
  id: "completed",
  number: 44,
  title: "Delivered item",
  url: "https://github.com/sample/repo/issues/44",
  state: "completed",
  tone: "success",
  reason: null,
};

const dashboard: DashboardViewModel = {
  title: "Conveyor",
  project: "sample/repo",
  updatedAt: "2026-09-29T12:00:00Z",
  revision: "revision-1",
  view: "board",
  counts: { board: 43, attention: 1 },
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
  done: {
    id: "done",
    name: "Done",
    cost: null,
    totalIssues: 41,
    page: 1,
    totalPages: 1,
    issues: [completedIssue],
  },
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
  steering: { enabled: false, agent: null, selected: null, recent: [] },
  csrfToken: "csrf-token",
};

describe("renderDashboard", () => {
  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Delivery board");
    expect(html).toContain(">Backlog</h2>");
    expect(html).toContain(">Build</h2>");
    expect(html).toContain(">Review</h2>");
    expect(html).toContain(">Done</h2>");
    expect(html).toContain('aria-label="41 issues"');
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=1");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=3");
    expect(html).toContain("issue--warning");
    expect(html).toContain("Nested task");
    expect(html).toContain("Blocked by");
    expect(html).toContain("Required foundation");
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
    expect(html).toContain("Load 20 more");
    expect(html).toContain('name="doneLimit" value="21"');
    expect(html).toContain('data-dashboard-revision="revision-1"');
    expect(html).toContain('src="/assets/dashboard.js"');
    expect(html).toContain(">Details</button>");
    expect(html).toContain("<dialog");
    expect(html).not.toContain("indicator-blocked");
    expect(html).not.toContain('class="labels"');
  });

  test("uses Preact escaping and rejects unsafe issue URLs", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
    expect(html).toContain("https://github.com/sample/repo/issues/41?x=1&amp;y=2");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders backlog ordering inside the board", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain('Move #43 up" disabled');
    expect(html).toContain('Move #43 down" disabled');
    expect(html).not.toContain("?view=backlog");
  });

  test("renders invalid stage labels on the separate attention tab", () => {
    const html = renderDashboard({ ...dashboard, view: "attention" });
    expect(html).toContain("missing, unknown, or conflicting stage label");
    expect(html).toContain("No valid configured stage label is present.");
    expect(html).not.toContain("Delivery board");
  });

  test("renders the configured steering agent and its persisted live report", () => {
    const html = renderDashboard({
      ...dashboard,
      view: "agent",
      steering: {
        enabled: true,
        agent: "operator",
        selected: {
          id: "run-1",
          status: "running",
          startedAt: "2026-09-29T12:00:00Z",
          finishedAt: null,
          events: [
            { sequence: 1, type: "user", text: "Inspect the board", createdAt: "2026-09-29T12:00:00Z" },
            { sequence: 2, type: "report", text: "Fixed the labels", createdAt: "2026-09-29T12:01:00Z" },
          ],
        },
        recent: [{ id: "run-1", status: "running", startedAt: "2026-09-29T12:00:00Z" }],
      },
    });

    expect(html).toContain("Agent");
    expect(html).toContain("Inspect the board");
    expect(html).toContain("Fixed the labels");
    expect(html).toContain('action="/steering"');
    expect(html).toContain('data-steering-run="run-1"');
  });
});
