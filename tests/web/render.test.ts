import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/web/render";
import type { DashboardViewModel, IssueCardViewModel } from "../../src/web/types";

const parent: IssueCardViewModel = {
  id: "parent",
  repository: "sample",
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
  stateChangedAt: "2026-09-29T11:30:00Z",
  waiting: null,
  blocked: true,
  inconsistent: false,
  closable: true,
  tone: "warning",
  parent: null,
  children: [{ id: "child", repository: "sample", number: 42, title: "Nested task", url: "https://github.com/sample/repo/issues/42", satisfied: false }],
  dependencies: [
    { id: "dependency", repository: "foundation", number: 40, title: "Required foundation", url: "https://github.com/sample/repo/issues/40", satisfied: true },
    { id: "dependency-open", repository: "foundation", number: 39, title: "Open foundation", url: "https://github.com/sample/repo/issues/39", satisfied: false },
  ],
  working: true,
};

const backlogIssue: IssueCardViewModel = {
  id: "backlog",
  repository: "sample",
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
  stateChangedAt: "2026-09-29T10:00:00Z",
  waiting: null,
  blocked: false,
  inconsistent: false,
  closable: false,
  tone: "active",
  parent: null,
  children: [],
  dependencies: [],
  working: false,
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

const waitingIssue = {
  ...backlogIssue,
  id: "stage-child",
  number: 45,
  title: "Executable child",
  activity: "implementation › ciGate",
  reason: null,
  waiting: {
    reason: "Waiting for CI for 7c0ea55",
    since: "2026-09-29T11:40:00Z",
    nextCheckAt: "2026-09-29T12:10:00Z",
    deadline: "2026-09-29T22:48:00Z",
  },
} as IssueCardViewModel;

const dashboard: DashboardViewModel = {
  title: "Conveyor",
  project: "sample/repo",
  totalUsage: "664M in · 2.2M out",
  updatedAt: "2026-09-29T12:00:00Z",
  revision: "revision-1",
  view: "board",
  counts: { board: 43, attention: 1 },
  activeWork: {
    runnerCount: 1,
    runnerCapacity: 4,
    runs: [{
      id: "run-active",
      issueId: "parent",
      repository: "sample",
      issueNumber: 41,
      issueTitle: "Build <safe> & sound",
      stageId: "build",
      kind: "producer",
      startedAt: "2026-09-29T12:00:00Z",
    }],
  },
  stages: [
    {
      id: "stage:build",
      name: "Build",
      actors: [{ type: "agent", name: "Implementer", title: "Senior Developer" }],
      cost: "$0.42",
      totalIssues: 41,
      page: 2,
      totalPages: 3,
      issues: [parent, waitingIssue],
    },
    {
      id: "stage:review",
      name: "Review",
      actors: [{ type: "agent", name: "Reviewer", title: "Senior Reviewer" }],
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
    actors: [],
    cost: null,
    totalIssues: 41,
    page: 1,
    totalPages: 1,
    issues: [completedIssue],
  },
  attention: {
    id: "attention",
    name: "Needs attention",
    actors: [],
    cost: null,
    totalIssues: 1,
    page: 1,
    totalPages: 1,
    issues: [{ ...backlogIssue, reason: "No valid configured stage label is present.", tone: "danger" }],
  },
  questions: [
    {
      id: "question/1",
      issueId: "backlog",
      issueNumber: 43,
      issueTitle: "Next item",
      prompt: "Which layout?",
      reason: "Both satisfy the acceptance criteria.",
      options: [{ id: "compact", label: "Compact" }],
      allowFreeText: false,
    },
  ],
  needsYou: [parent],
  systemWarnings: ["meal-planner webhook is unavailable"],
  steering: { enabled: false, agent: null, selected: null, recent: [] },
  selectedIssue: null,
  csrfToken: "csrf-token",
};

describe("renderDashboard", () => {
  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Delivery board");
    expect(html).toContain(">Backlog</h2>");
    expect(html).toContain('class="stage-heading stage-heading--simple"');
    expect(html).toContain(">Build</h2>");
    expect(html).toContain(">Review</h2>");
    expect(html).toContain("Implementer");
    expect(html).toContain("Senior Developer");
    expect(html).toContain(">Done</h2>");
    expect(html).toContain('aria-label="41 issues"');
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=1");
    expect(html).toContain("view=board&amp;column=stage%3Abuild&amp;page=3");
    expect(html).toContain("issue--warning");
    expect(html).toContain("issue--rollup");
    expect(html).toContain("Roll-up parent");
    expect(html).toContain('class="stage-group stage-group--rollups"');
    expect(html).toContain(">Roll-up parents</h3>");
    expect(html).toContain(">Issues</h3>");
    expect(html).toContain("Executable child");
    expect(html).toContain("Waiting for CI for 7c0ea55");
    expect(html).toContain("next check");
    expect(html).toContain("gives up");
    expect(html).toContain('data-local-clock="true"');
    expect(html).toContain('aria-label="1 waiting"');
    expect(html).toContain("Nested task");
    expect(html).toContain("Blocked by");
    expect(html).toContain("Required foundation");
    expect(html).toContain('Waiting on <a href="/?issue=dependency-open">#39</a>');
    expect(html).toContain('class="relation-link--satisfied"');
    expect(html).toContain("Issue relationships for #41");
    expect(html).toContain(">Working</strong>");
    expect(html).toContain("Keyboard usable");
    expect(html).toContain("Running verification");
    expect(html).toContain("Waiting for checks");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Needs you <span>(2)</span>");
    expect(html).toContain("#41 Build &lt;safe> &amp; sound");
    expect(html).toContain('<a class="needs-you-action" href="/?issue=parent">Open</a>');
    expect(html).toContain("/questions/question%2F1/answer");
    expect(html).toContain('name="csrf" value="csrf-token"');
    expect(html).toContain("System attention");
    expect(html).toContain("Load 20 more");
    expect(html).toContain('name="doneLimit" value="21"');
    expect(html).toContain('data-dashboard-revision="revision-1"');
    expect(html).toContain('src="/assets/dashboard.js"');
    expect(html).toContain('data-dialog-open="issue-parent-41"');
    expect(html).toContain('aria-label="Open details for issue #41"');
    expect(html).toContain("<summary><strong>1 of 4</strong> runners</summary>");
    expect(html).toContain("<h2>Active work</h2>");
    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain('href="/?issue=parent"');
    expect(html).toContain("sample:#41");
    expect(html).toContain('href="/?issue=child"');
    expect(html).toContain('href="/?issue=dependency"');
    expect(html).not.toContain('href="https://github.com/sample/repo/issues/42"');
    expect(html).not.toContain(">Permalink</a>");
    expect(html).toContain('data-detail-tab="conversation"');
    expect(html).toContain("Conversation");
    expect(html).toContain('data-conversation-url="/api/issues/parent/conversation"');
    expect(html).toContain("grid-auto-rows:max-content");
    expect(html).toContain(".agent-events{display:grid;flex:1;");
    expect(html).toContain("align-content:start;grid-auto-rows:max-content");
    expect(html).toContain('data-detail-tab="journey"');
    expect(html).toContain('data-journey-url="/api/issues/parent/journey"');
    expect(html).toContain("Journey");
    expect(html).toContain("Technical logs");
    expect(html).toContain('data-detail-tab="activity"');
    expect(html).toContain('/api/issues/parent/activity');
    expect(html).not.toContain(">Details</button>");
    expect(html).not.toContain("details-button");
    expect(html).toContain("<dialog");
    expect(html).toContain('class="issue-details issue-inspector"');
    expect(html).not.toContain("indicator-blocked");
    expect(html).not.toContain('class="labels"');
    expect(html).toContain("@media(prefers-reduced-motion:no-preference)");
    expect(html).toContain("@keyframes belt");
    expect(html).not.toContain("working-pulse");
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain("data-server-status");
    expect(html).toContain("data-local-time");
    expect(html).toContain("page-loader");
    expect(html).toContain('<nav class="line" aria-labelledby="line-heading">');
    expect(html).toContain('data-station-link="stage:build"');
    expect(html).toContain('href="#station-stage-build"');
    expect(html).toContain('class="line-station line-station--running"');
    expect(html).toContain("andon--run");
    expect(html).toContain('<time datetime="2026-09-29T11:30:00Z" data-relative-time="true">recently</time>');
    expect(html).toContain("Roll-up · 1 child, 0 done");
    expect(html).toContain('class="stage stage--empty" id="station-stage-review"');
    expect(html).toContain(".stage--empty .stage-heading h2{writing-mode:vertical-rl");
    const parentCardStart = html.indexOf('data-issue-id="parent" data-dialog-open');
    const parentCard = html.slice(parentCardStart, html.indexOf("<dialog", parentCardStart));
    expect(parentCard).toContain("Implementer");
    expect(parentCard).not.toContain("Required foundation");
    expect(html).toContain(".agent-panel{min-height:calc(100vh - 12rem);display:flex");
    expect(html).toContain("grid-template-columns:minmax(0,1fr) auto");
    expect(html).toContain("width:min(560px,100vw);height:100dvh");
    expect(html).toContain(".conversation-compose{display:grid;flex:0 0 auto");
    expect(html).toContain(".line ol{position:relative;display:grid}");
    expect(html).toContain(".issue-details.issue-inspector{width:100vw;height:100dvh");
    expect(html).toContain("--concrete:#E8EBE8");
    expect(html).toContain("--panel:#F8F9F7");
    expect(html).toContain("--ink:#1C2328");
    expect(html).toContain("--steel:#5D6970");
    expect(html).toContain("--run:#1E8A5A");
    expect(html).toContain("--wait:#B8720E");
    expect(html).toContain("--stop:#BD3B26");
    expect(html).toContain("--signal:#2A5BD7");
    expect(html).toContain('font-family:"IBM Plex Sans"');
    expect(html).toContain('font-family:"IBM Plex Mono"');
  });

  test("uses Preact escaping and rejects unsafe issue URLs", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
    expect(html).toContain("https://github.com/sample/repo/issues/41?x=1&amp;y=2");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("labels token totals as usage rather than cost", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain("<dt>Usage</dt><dd>$0.42</dd>");
    expect(html).not.toContain("<dt>Cost</dt>");
  });

  test("gives long stage usage its own non-overlapping header row", () => {
    const html = renderDashboard({
      ...dashboard,
      stages: [{
        ...dashboard.stages[0]!,
        cost: "585M in (564M cached) · 1.8M out · 331 runs",
      }],
    });

    expect(html).toContain("585M in (564M cached) · 1.8M out · 331 runs");
    expect(html).toContain(".stage-heading{display:grid;grid-template-columns:minmax(0,1fr)");
    expect(html).toContain(".stage-summary{display:flex;min-width:0;align-items:center;justify-content:space-between");
  });

  test("renders backlog ordering inside the board", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain('Move #43 up" disabled');
    expect(html).toContain('Move #43 down" disabled');
    expect(html).toContain('<ol class="issue-list" data-backlog-list="true">');
    expect(html).toContain('data-backlog-id="backlog" draggable="true"');
    expect(html).not.toContain("?view=backlog");
  });

  test("lists the configured agents, each linking to its profile page", () => {
    const html = renderDashboard({
      ...dashboard,
      agents: [{ id: "kaveh", name: "Kaveh", title: "Senior Developer" }, { id: "darya", name: "Darya", title: "Product Owner" }],
    });
    expect(html).toContain('<details class="agents-menu">');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/agents/kaveh"');
    expect(html).toContain('href="/agents/darya"');
    expect(html).toContain("Product Owner");
    expect(renderDashboard({ ...dashboard, agents: [] })).toContain("View all agents");
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
            { sequence: 2, type: "report", text: "Fixed **the** `labels`:\n- [Details](https://example.test)\n- <script>alert(1)</script>", createdAt: "2026-09-29T12:01:00Z" },
          ],
        },
        recent: [{ id: "run-1", status: "running", startedAt: "2026-09-29T12:00:00Z" }],
      },
    });

    expect(html).toContain(">Operator</a>");
    expect(html).toContain("<h2>Operator</h2>");
    expect(html).toContain("Inspect the board");
    expect(html).toContain("Fixed <strong>the</strong> <code>labels</code>:");
    expect(html).toContain('<a href="https://example.test/" target="_blank" rel="noopener noreferrer">Details</a>');
    expect(html).toContain("<ul><li>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('action="/steering"');
    expect(html).toContain('data-steering-run="run-1"');
    expect(html).toContain("Send to operator");
  });

  test("renders a deep-linked issue dialog even when its card is not on the current page", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: completedIssue });

    expect(html).toContain('data-selected-issue="true"');
    expect(html).toContain('data-issue-id="completed"');
  });
});
