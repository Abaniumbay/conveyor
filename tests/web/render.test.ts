import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/web/render";
import { themeInitScript } from "../../src/web/styles";
import type { DashboardViewModel, IssueCardViewModel } from "../../src/web/types";

const parent: IssueCardViewModel = {
  id: "parent",
  repository: "sample",
  repositoryColor: 1,
  number: 41,
  title: "Build <safe> & sound",
  url: "https://github.com/sample/repo/issues/41?x=1&y=2",
  state: "in_progress",
  labels: ["feature", "priority: high"],
  acceptanceCriteria: ["<script>alert(1)</script>", "Keyboard usable"],
  todos: null,
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
  needsAttention: true,
  retryable: false,
};

const backlogIssue: IssueCardViewModel = {
  id: "backlog",
  repository: "sample",
  repositoryColor: 1,
  number: 43,
  title: "Next item",
  url: "javascript:alert(1)",
  state: "active",
  labels: [],
  acceptanceCriteria: [],
  todos: null,
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
  needsAttention: false,
  retryable: false,
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
  harnessUsage: [
    { id: "codex", name: "Codex", windows: { weekly: { remaining: 9, resetsAt: "2026-10-09T21:11:00Z", reportedAt: "2026-10-03T14:04:00Z" } } },
    { id: "claude", name: "Claude Code", windows: { fiveHour: { remaining: 86, resetsAt: "2026-10-03T18:30:00Z", reportedAt: "2026-10-03T14:04:00Z" } } },
  ],
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
      repository: "sample",
      repositoryColor: 1,
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
  test("renders harness quotas in the shared header with low-capacity and exact reset details", () => {
    for (const view of ["board", "attention", "team", "reports"] as const) {
      const html = renderDashboard({ ...dashboard, view, harnessUsage: [
        { id: "codex", name: "Codex", windows: { weekly: { remaining: 4.0000000000000036, resetsAt: "2026-10-09T21:11:00.000Z", reportedAt: "2026-10-03T14:04:00.000Z" } } },
        { id: "claude", name: "Claude Code", windows: { fiveHour: { remaining: 86, resetsAt: "2026-10-03T18:30:00.000Z", reportedAt: "2026-10-03T14:04:00.000Z" } } },
        { id: "stale", name: "Stale", windows: { weekly: { remaining: 70, resetsAt: "2020-01-01T00:00:00.000Z", reportedAt: "2019-12-25T00:00:00.000Z" } } },
        { id: "unavailable", name: "Unavailable", windows: {} },
      ] });
      expect(html).toContain('class="harness-usage"');
      expect(html).toContain("Codex");
      expect(html).toContain("Claude Code");
      expect(html).toContain("Low capacity");
      expect(html).toContain('data-remaining="4"');
      expect(html).toContain("4% left");
      expect(html).not.toContain("4.0000000000000036");
      expect(html).toContain("Stale · 70% left");
      expect(html).toContain("quota-window--stale");
      expect(html).toContain("quota-window--low");
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('data-countdown');
      expect(html).toContain("Reset:");
      expect(html).toContain("Last reported:");
      expect(html).toContain("Usage unavailable");
      expect(html).not.toContain("Unavailable 0% left");
    }
  });

  test("shows retry controls on stopped retryable cards and their details only", () => {
    const stopped = { ...backlogIssue, id: "stopped", state: "blocked", retryable: true };
    const html = renderDashboard({
      ...dashboard,
      stages: [{ ...dashboard.stages[0]!, issues: [stopped] }],
      backlog: [backlogIssue],
    });
    expect(html.match(/>Retry</g)).toHaveLength(2);
    expect(html).toContain('data-retry-card');
    expect(html).toContain('data-retry-form');
    expect(html).toContain('maxlength="4000"');
    expect(html).toContain('role="status" aria-live="polite" data-retry-status');
  });

  test("shows todo progress on the card and the escaped checklist in its details; nothing without a list", () => {
    const working = {
      ...backlogIssue, id: "working", number: 77, working: true,
      todos: {
        done: 1, total: 3, current: "Tenant <b>settings</b> endpoint",
        items: [
          { id: "t1", text: "Shared repository", status: "done" as const },
          { id: "t2", text: "Tenant <b>settings</b> endpoint", status: "in_progress" as const, note: "admin auth first" },
          { id: "t3", text: "Lobby picker", status: "pending" as const },
        ],
      },
    };
    const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [working] }], backlog: [backlogIssue] });
    expect(html).toContain('aria-label="Todo progress for #77: 1 of 3 todos done"');
    expect(html).toContain('<meter min="0" max="3" value="1"');
    expect(html).toContain('<span class="todo-progress-count">1/3</span>');
    expect(html).toContain("Tenant &lt;b>settings&lt;/b> endpoint");
    expect(html).not.toContain("<b>settings</b>");
    expect(html).toContain('class="todo todo--done"');
    expect(html).toContain('class="todo todo--in_progress"');
    expect(html).toContain('<span class="todo-note">admin auth first</span>');
    expect(html.match(/class="todo-progress"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Implementation todos"/g)).toHaveLength(1);
  });

  test("renders the Reports view: tab, filters, figures, drill-through links, escaped items and only non-zero bars", () => {
    const totals = {
      delivered: 2, inProgress: 1, runs: 5, failedRuns: 1, inputTokens: 4_900_000, outputTokens: 100_000, cachedTokens: 2_450_000, agentMs: 9 * 3_600_000,
      avgTokensPerItem: 2_500_000, avgRunsPerItem: 2, avgLeadMs: 8 * 3_600_000, avgAgentMs: 2 * 3_600_000, avgChecksWaitMs: 900_000, avgWaitingForYouMs: 3_600_000, avgQueuedMs: 0,
      avgReturnsPerItem: 0.5, avgStopsPerItem: 0.5, firstPassRate: 0.5,
    };
    const html = renderDashboard({
      ...dashboard,
      view: "reports",
      report: {
        period: "30d", since: "2026-09-03T00:00:00.000Z", repository: "sample", repositories: ["other", "sample"],
        totals,
        byRepository: [{ id: "sample", ...totals }],
        byMonth: [{ month: "2026-10", delivered: 2, runs: 5, tokens: 5_000_000, agentMs: 9 * 3_600_000, avgTokensPerItem: 2_500_000, avgLeadMs: 8 * 3_600_000 }],
        byStage: [
          { id: "implementation", name: "Implementation", runs: 4, failedRuns: 1, tokens: 5_000_000, agentMs: 8 * 3_600_000, avgRunMs: 7_200_000 },
          { id: "deploy", name: "Deploy", runs: 1, failedRuns: 0, tokens: 0, agentMs: 600_000, avgRunMs: 600_000 },
        ],
        items: [{ repository: "sample", number: 9, title: "<script>x</script>", state: "needs-input", finishedAt: null, leadMs: null, agentMs: 600_000, checksWaitMs: 0, waitingForYouMs: 0, runs: 1, tokens: 1_200, returns: 0, stops: 1 }],
        importedWithoutHistory: 4,
        generatedAt: "2026-10-03T00:00:00.000Z",
      },
    });
    expect(html).toContain('<a href="/reports" class="tab tab--active" aria-current="page">Reports</a>');
    expect(html).toContain("Reports · sample");
    expect(html).toContain('href="/reports/sample?period=7d"');
    expect(html).toContain('href="/reports?period=30d"');
    expect(html).toContain('<a href="/reports/sample?period=30d" class="report-chip report-chip--active" aria-current="page">30 days</a>');
    expect(html).toContain("<span class=\"report-tile-value\">5.0M</span>");
    expect(html).toContain("50% of input cached");
    expect(html).toContain('href="/issues/sample/9"');
    expect(html).toContain("&lt;script>x&lt;/script>");
    expect(html).toContain("Needs input");
    expect(html).toContain('data-tip="Implementation: 5.0M"');
    expect(html).not.toContain('data-tip="Deploy: 0"');
    expect(html).toContain("4 items imported as done without a recorded delivery are left out.");
    expect(html).not.toContain("By repository");
  });

  test("initializes and controls system, light, and dark themes without a first-paint flash", () => {
    const html = renderDashboard(dashboard);
    // A blocking script in <head>, before the stylesheet; a file, since the CSP forbids inline scripts.
    const themeScript = html.indexOf('<script src="/assets/theme.js"></script>');
    const stylesheet = html.indexOf("<style>");

    expect(themeScript).toBeGreaterThan(0);
    expect(themeScript).toBeLessThan(stylesheet);
    expect(themeInitScript).toContain('localStorage.getItem("conveyor-theme")');
    expect(themeInitScript).toContain('document.documentElement.dataset.theme');
    expect(html).toContain('<meta name="color-scheme" content="light dark"');
    expect(html).toContain('class="theme-control"');
    expect(html).toContain('data-theme-choice="system"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).toContain(':root[data-theme="dark"]{color-scheme:dark;--concrete:#151A1D');
    expect(html).toContain('@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;');
    expect(html).toContain('box-shadow:var(--popover-shadow)');
    expect(html).toContain('background:var(--overlay)');
    expect(html).toContain('color:var(--on-signal)');
  });

  test("uses the configured repository colour for cards, inspector headers, and needs-you rows", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain('class="issue issue--warning issue--working issue--glow-attention issue--rollup repo-color-1"');
    expect(html).toContain('class="repository-badge"><i class="repository-dot" aria-hidden="true"></i>sample</span>:#41');
    expect(html).toContain('class="details-kicker repo-color-1"><span class="repository-badge"');
    expect(html).toContain('class="needs-you-item repo-color-1"');
    expect(html).toContain('class="needs-you-item needs-you-item--question repo-color-1"');
    expect(html).toContain('--repo-1:#2563EB');
    expect(html).toContain('--repo-2:#7C3AED');
    expect(html).toContain('--repo-3:#0F766E');
    expect(html).toContain('--repo-4:#657A1F');
    expect(html).toContain('--repo-5:#0284C7');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain('--repo-1:#7BA8FF');
    expect(html).toContain('--repo-2:#BEA3FF');
    expect(html).toContain('--repo-3:#63D5C5');
    expect(html).toContain('--repo-4:#C5D66D');
    expect(html).toContain('--repo-5:#66C7F0');
  });

  test("gives running and needs-attention cards distinct accessible glows", () => {
    const runningParent = { ...parent, blocked: false, needsAttention: false, tone: "active" as const };
    const boardHtml = renderDashboard({
      ...dashboard,
      needsYou: [],
      questions: [],
      stages: [{ ...dashboard.stages[0]!, issues: [runningParent, waitingIssue] }, dashboard.stages[1]!],
    });
    const attentionHtml = renderDashboard({
      ...dashboard,
      view: "attention",
      attention: { ...dashboard.attention, issues: dashboard.attention.issues.map((issue) => ({ ...issue, needsAttention: true })) },
    });

    expect(boardHtml).toContain('issue--working issue--glow-running');
    expect(attentionHtml).toContain('issue--danger issue--glow-attention');
    expect(boardHtml).toContain('@keyframes card-glow');
    expect(boardHtml).toContain('animation:card-glow 2.4s ease-in-out infinite');
    expect(boardHtml).toContain('box-shadow:0 0 0 1px var(--glow-border),0 0 12px var(--card-glow)');
    expect(boardHtml).toContain('@media(prefers-reduced-motion:no-preference)');
    expect(boardHtml).toContain('.issue.is-selected{outline:2px solid var(--signal);outline-offset:2px}');
  });

  test("renders REST-style navigation, issue, pagination, team, and operator URLs", () => {
    const html = renderDashboard(dashboard);
    const operatorHtml = renderDashboard({
      ...dashboard,
      view: "agent",
      steering: {
        enabled: true,
        agent: "operator",
        selected: null,
        recent: [{ id: "run-1", status: "succeeded", startedAt: "2026-09-29T12:00:00Z" }],
      },
    });

    expect(html).toContain('href="/board"');
    expect(html).toContain('href="/attention"');
    expect(html).toContain('href="/team"');
    expect(html).toContain('href="/operator"');
    expect(html).toContain('href="/issues/sample/41"');
    expect(html).toContain('href="/issues/foundation/40"');
    expect(html).toContain('href="/board?column=stage%3Abuild&amp;page=1"');
    expect(operatorHtml).toContain('href="/operator/runs/run-1"');
    expect(html).not.toContain('href="/?view=');
    expect(html).not.toContain('href="/?issue=');
  });

  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Delivery board");
    expect(html).toContain(">Backlog</h2>");
    expect(html).toContain('class="stage-heading stage-heading--simple"');
    expect(html).toContain(">Build</h2>");
    expect(html).toContain(">Review</h2>");
    expect(html).toContain("Implementer");
    expect(html).toContain("Senior Developer");
    expect(html).toContain('class="agent-avatar agent-avatar--');
    expect(html).toContain('class="stage-actor"');
    expect(html).toContain(">Done</h2>");
    expect(html).toContain('aria-label="41 issues"');
    expect(html).toContain("Page 2 of 3");
    expect(html).toContain("/board?column=stage%3Abuild&amp;page=1");
    expect(html).toContain("/board?column=stage%3Abuild&amp;page=3");
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
    expect(html).toContain('Waiting on <a href="/issues/foundation/39">#39</a>');
    expect(html).toContain('class="relation-link--satisfied"');
    expect(html).toContain("Issue relationships for #41");
    expect(html).toContain(">Working</strong>");
    expect(html).toContain("Keyboard usable");
    expect(html).toContain("Running verification");
    expect(html).toContain("Waiting for checks");
    expect(html).toContain('<section class="blocked-summary" aria-label="Blocking reason"><h3>Blocking reason</h3><p>Waiting for checks</p>');
    expect(html).toContain('border-left:16px solid var(--repo-color,var(--line))');
    expect(html).toContain('.blocked-summary{margin:.75rem 0 0;');
    expect(html).toContain('color:var(--stop)');
    expect(html).toContain("Needs attention");
    expect(html).toContain("Needs you <span>(2)</span>");
    expect(html).toContain("#41 Build &lt;safe> &amp; sound");
    expect(html).toContain('<a class="needs-you-action" href="/issues/sample/41">Open</a>');
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
    expect(html).toContain('href="/issues/sample/41"');
    expect(html).toContain(">sample</span>:#41");
    expect(html).toContain('href="/issues/sample/42"');
    expect(html).toContain('href="/issues/foundation/40"');
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
    expect(html).toContain("width:min(560px,100vw);max-width:none;height:100dvh");
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

  test("keeps board cards compact and ellipsizes a blocker while preserving its full summary", () => {
    const reason = "The deployment provider rejected the expired repository credential and a repository owner must replace it before implementation can continue.";
    const blocked = {
      ...backlogIssue,
      id: "blocked",
      state: "blocked",
      reason,
      blocked: true,
      tone: "danger" as const,
    };
    const html = renderDashboard({
      ...dashboard,
      needsYou: [],
      questions: [],
      stages: [{ ...dashboard.stages[0]!, issues: [blocked] }],
    });

    expect(html).toContain(`class="issue-status-context" title="${reason}"`);
    expect(html).toContain(`<section class="blocked-summary" aria-label="Blocking reason"><h3>Blocking reason</h3><p>${reason}</p>`);
    expect(html).toContain(".stage:not(.stage--empty){width:min(20rem,86vw);min-width:min(20rem,86vw);max-width:min(20rem,86vw);flex:0 0 min(20rem,86vw)}");
    expect(html).toContain(".issue-status-context{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
  });

  test("renders backlog ordering inside the board", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain('Move #43 up" disabled');
    expect(html).toContain('Move #43 down" disabled');
    expect(html).toContain('<ol class="issue-list" data-backlog-list="true">');
    expect(html).toContain('data-backlog-id="backlog" draggable="true"');
    expect(html).not.toContain("?view=backlog");
  });

  test("ordinary users retain navigation and sign-out without operational or account controls", () => {
    const html = renderDashboard({
      ...dashboard,
      account: { id: "reader", username: "reader & friend", role: "user", avatar: "🦊" },
    });
    expect(html).toContain("reader &amp; friend");
    expect(html).toContain("href=\"/profile\"");
    expect(html).toContain('action="/logout"');
    expect(html).toContain('<a class="header-link" href="/settings/notifications">Notifications</a>');
    expect(html).toContain('class="account-menu"');
    expect(html).toContain('aria-label="Account menu for reader &amp; friend"');
    expect(html).toContain('href="/profile#change-password">Change password</a>');
    expect(html).toContain('data-theme-choice="system"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).not.toContain('href="/accounts"');
    expect(html).not.toContain("Move #43 up");
    expect(html).not.toContain('action="/steering"');
  });

  test("the team view lists every agent, each opening its read-only profile in a modal", () => {
    const kaveh = {
      id: "kaveh", name: "Kaveh", title: "Senior Developer", harness: "codex", model: "gpt-6-luna", effort: "high",
      access: "workspace-write",
      usage: [{ pipeline: "delivery", stage: "implementation", role: "runs the stage action" }],
      tasks: [{ group: "workspace", tasks: ["workspace.fetch", "workspace.push"] }],
      instructions: "You are <Kaveh>.",
    };
    const html = renderDashboard({ ...dashboard, view: "team", team: [kaveh, { ...kaveh, id: "darya", name: "Darya", title: "Product Owner", model: null, effort: null, usage: [], instructions: null }] });
    expect(html).toContain('href="/team"');
    expect(html).not.toContain("agents-menu");
    expect(html).toContain('data-dialog-open="agent-kaveh"');
    expect(html).toContain('data-dialog-open="agent-darya"');
    expect(html).toContain('<dialog class="agent-dialog" id="agent-kaveh" aria-labelledby="agent-kaveh-title" data-agent-id="kaveh">');
    expect(html).toContain("Product Owner");
    expect(html).toContain("gpt-6-luna");
    expect(html).toContain("workspace.push");
    expect(html).toContain("<span>Implementation</span>");
    expect(html).toContain("You are &lt;Kaveh");
    expect(html).not.toContain("<Kaveh>");
    expect(html).toContain("Harness default");
    expect(html).toContain("Not used by any pipeline stage.");
    expect(renderDashboard({ ...dashboard, view: "team", team: [{ ...kaveh, usage: [{ pipeline: null, stage: null, role: "steers Conveyor from the dashboard" }] }] }))
      .toContain('<p class="team-card-meta">steers Conveyor from the dashboard');
    expect(html).toContain("Instructions could not be read.");
    const profile = html.slice(html.indexOf('id="agent-kaveh"'), html.indexOf("</dialog>", html.indexOf('id="agent-kaveh"')));
    expect(profile).not.toContain("<input");
    expect(profile).not.toContain('method="post"');
  });

  test("an empty team says so", () => {
    expect(renderDashboard({ ...dashboard, view: "team", team: [] })).toContain("No agents are configured.");
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
