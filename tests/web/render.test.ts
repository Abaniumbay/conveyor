import { describe, expect, test } from "bun:test";
import { renderDashboard } from "../../src/web/render";
import { BUILD } from "../../src/version";
import { dashboardCss, quotaHeaderCss, themeInitScript } from "../../src/web/styles";
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
  issueType: "Feature",
  issueFields: [{ name: "Effort", value: "Medium" }],
  acceptanceCriteria: [
    { id: "AC-1", text: "<script>alert(1)</script>", approved: false },
    { id: "AC-2", text: "Keyboard usable", approved: true },
  ],
  todos: null,
  indicators: [],
  activity: "Running verification",
  reason: "Waiting for checks",
  cost: "$0.42",
  duration: "3m 12s",
  stateChangedAt: "2026-09-29T11:30:00Z",
  waiting: null,
  blocked: true,
  inconsistent: false,
  closable: true,
  noSplit: true,
  tone: "warning",
  parent: null,
  children: [],
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
  issueType: null,
  issueFields: [],
  acceptanceCriteria: [],
  todos: null,
  indicators: [],
  activity: null,
  reason: "Awaiting capacity",
  cost: null,
  duration: "1h",
  stateChangedAt: "2026-09-29T10:00:00Z",
  waiting: null,
  blocked: false,
  inconsistent: false,
  closable: false,
  noSplit: false,
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
    kind: "waiting",
    reason: "Waiting for CI for 7c0ea55",
    since: "2026-09-29T11:40:00Z",
    nextCheckAt: "2026-09-29T12:10:00Z",
    deadline: "2026-09-29T22:48:00Z",
  },
} as IssueCardViewModel;

const queuedIssue = {
  ...waitingIssue,
  id: "queued",
  number: 46,
  waiting: {
    kind: "queued" as const,
    reason: "repo slots 1/1 busy: #41",
    since: "2026-09-29T11:40:00Z",
    nextCheckAt: null,
    deadline: null,
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
  repositoryId: null,
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
    name: "Label problems",
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
      answerError: null,
    },
  ],
  needsYou: [parent],
  systemWarnings: ["meal-planner webhook is unavailable"],
  repositories: [],
  restrictedRepositories: [],
  steering: { enabled: false, agent: null, selected: null, recent: [] },
  selectedIssue: null,
  csrfToken: "csrf-token",
};

const ciView = (state: "passing" | "running" | "failed" | "unknown", progress: string, symbol: string, word: string) => ({
  id: "ci", label: "CI", state, symbol, stateWord: word, progress, detail: `detail for ${state}`, url: "https://github.com/o/r/pull/5/checks",
  observedAt: "2026-09-29T11:59:00Z", reference: { label: "abcdef1", url: "https://github.com/o/r/pull/5" },
  entries: [
    { name: "Tests", state: "passed", url: "https://github.com/o/r/actions/runs/1", startedAt: "2026-09-29T11:50:00Z", durationMs: 125_000, live: false },
    { name: "Android", state: "queued", url: null, startedAt: null, durationMs: null, live: false },
    { name: "Web", state: "running", url: "javascript:alert(1)", startedAt: "2026-09-29T11:58:00Z", durationMs: 60_000, live: true },
  ],
});

describe("indicators", () => {
  const withIndicators = (indicators: IssueCardViewModel["indicators"]) =>
    renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [{ ...parent, indicators }] }] });

  test.each([
    ["passing", "2/2", "✓", "passing"],
    ["running", "1 running", "●", "running"],
    ["failed", "1 failed", "✕", "failed"],
    ["unknown", "no runs", "?", "unknown"],
  ] as const)("the card chip and details section render the %s state with text, not only color", (state, progress, symbol, word) => {
    const html = withIndicators([ciView(state, progress, symbol, word)]);
    expect(html).toContain(`indicator-chip indicator-chip--${state}`);
    expect(html).toContain(`CI ${symbol} ${progress}`);
    expect(html).toContain(`CI ${word}, ${progress}`);
    expect(html).toContain(`indicator-state--${state}`);
    expect(html).toContain(`detail for ${state}`);
  });

  test("the details list each run with state, start time, duration and link, the short head and the observation time", () => {
    const html = withIndicators([ciView("running", "1 running", "●", "running")]);
    expect(html).toContain('<a href="https://github.com/o/r/actions/runs/1" target="_blank" rel="noopener noreferrer">Tests</a>');
    expect(html).toContain("2 minutes 5 seconds");
    expect(html).toContain("running for 1 minute");
    expect(html).toMatch(/<time datetime="2026-09-29T11:50:00Z" data-local-time[^>]*>/);
    expect(html).toContain("start unavailable");
    expect(html).toContain("duration unavailable");
    expect(html).toContain('<a href="https://github.com/o/r/pull/5" target="_blank" rel="noopener noreferrer"><code>abcdef1</code></a>');
    expect(html).toContain("observed");
    // An unsafe run link is not rendered as a link.
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain('<span class="indicator-entry-name">Web</span>');
  });

  test("another indicator needs no new markup", () => {
    const html = withIndicators([ciView("passing", "2/2", "✓", "passing"), { ...ciView("failed", "1 failed", "✕", "failed"), id: "deploy", label: "Deploy", entries: [] }]);
    expect(html).toContain('data-indicator="deploy"');
    expect(html).toContain("Deploy ✕ 1 failed");
  });

  test("no chip or section without an indicator", () => {
    const html = withIndicators([]);
    expect(html).not.toContain('class="indicator-chips"');
    expect(html).not.toContain('data-indicator=');
    expect(html).not.toContain('class="indicators"');
  });
});

describe("issue type and fields", () => {
  const html = (issueType: string | null, issueFields: IssueCardViewModel["issueFields"]) =>
    renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [{ ...parent, issueType, issueFields }] }] });

  test("the details show the type and the configured field values beside the source labels", () => {
    const page = html("Bug", [{ name: "Effort", value: "Low" }, { name: "Priority", value: "<High>" }]);
    expect(page).toContain("Type: Bug");
    expect(page).toContain("Effort: Low");
    expect(page).toContain("Priority: &lt;High");
    expect(page).not.toContain("<High>");
    expect(page.indexOf("Issue type and fields")).toBeLessThan(page.indexOf("Source labels"));
  });

  test("nothing is rendered when the issue has no type or field values", () => {
    expect(html(null, [])).not.toContain("Issue type and fields");
  });
});

describe("renderDashboard", () => {
  test("shows a no-split marker on the card and details only while the item carries the label", () => {
    const labelled = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [parent] }], backlog: [backlogIssue] });
    const unlabelled = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [{ ...parent, noSplit: false }] }], backlog: [backlogIssue] });

    expect(labelled.match(/No split/g)).toHaveLength(2);
    expect(unlabelled).not.toContain("No split");
  });

  test("renders visible approved and unapproved criterion states", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

    expect(html).toContain("☐ Not approved");
    expect(html).toContain("☑ Approved");
    expect(html).toContain("Keyboard usable");
  });

  test("labels capacity-held work Queued on its card and details without an obsolete next check", () => {
    const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [queuedIssue] }] });

    expect(html.match(/>Queued<\/strong>/g)).toHaveLength(4);
    expect(html).toContain("repo slots 1/1 busy: #41");
    expect(html).not.toContain("next check");
  });

  test("the About view shows the running build", () => {
    const html = renderDashboard({ ...dashboard, view: "about" });
    expect(html).toContain(`Version ${BUILD.version}`);
    expect(html).toContain(`Development build, Bun ${BUILD.runtime}`);
  });

  test("lets header controls wrap instead of overlapping and keeps account-page links compact", () => {
    // Fixed grid columns let neighbouring texts run into each other between phone and wide desktop widths.
    expect(dashboardCss).toContain(".dashboard-header{display:flex;flex-wrap:wrap;align-items:center;");
    expect(dashboardCss).toContain(".total-usage{flex:1 1 8rem;min-width:0;overflow:hidden;");
    expect(quotaHeaderCss).toContain("@media(max-width:1380px){.harness-usage{order:10;flex-basis:100%}}");
    expect(quotaHeaderCss).toContain(".account-page .dashboard-header>.header-link{justify-self:start}");
  });

  test("keeps phone header controls readable and overflowing tabs reachable", () => {
    const totalUsage = "19M in (13M cached) · 1.1M out · 48 runs";
    const html = renderDashboard({ ...dashboard, totalUsage });

    expect(html).toContain(`<span class="total-usage" title="${totalUsage}">${totalUsage}</span>`);
    expect(html).toContain('<a href="/board">Conveyor</a>');
    expect(html).toMatch(/data-connection-state(?:="true")?>Connecting/);
    expect(html).toContain('1 of 4</strong> runners');
    expect(html).toContain('aria-label="Harness usage remaining"');
    expect(html).toMatch(/data-theme-label(?:="true")?>System/);
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('class="account-menu"');
    expect(html).toContain('href="/profile"');
    expect(html).toContain('>Profile</a>');

    expect(dashboardCss).toContain(".dashboard{min-width:0;max-width:100%;overflow-x:hidden;padding:.45rem .5rem 1rem}");
    expect(dashboardCss).toContain(".repository-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    expect(dashboardCss).toContain(".dashboard-header{min-width:0;max-width:100%;gap:.2rem .9rem;padding:.45rem 0}");
    expect(dashboardCss).toContain(".total-usage{order:11;flex-basis:100%;text-align:left}");
    expect(dashboardCss).toContain(".tabs{min-width:0;margin-bottom:.7rem;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}");
    expect(dashboardCss).toContain(".tab{flex:0 0 auto;padding:.55rem .65rem;white-space:nowrap}");
  });

  test("renders harness quotas in the shared header with low-capacity and exact reset details", () => {
    const lowCapacityReset = new Date(Date.now() + 3_600_000).toISOString();
    for (const view of ["board", "attention", "team", "reports"] as const) {
      const html = renderDashboard({ ...dashboard, view, harnessUsage: [
        { id: "codex", name: "Codex", windows: { weekly: { remaining: 4.0000000000000036, resetsAt: lowCapacityReset, reportedAt: "2026-10-03T14:04:00.000Z" } } },
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
      expect(html).toContain("Stale");
      expect(html).not.toContain("Stale · 70% left");
      expect(html).not.toContain("70% left");
      expect(html).toContain("quota-window--stale");
      expect(html).toContain("quota-window--low");
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('data-countdown');
      expect(html).toContain(`data-reset-at="${lowCapacityReset}"`);
      expect(html).toContain('data-reported-at="2026-10-03T14:04:00.000Z"');
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
      ...backlogIssue, id: "working", number: 77, working: true, stage: "implementation",
      todos: {
        finished: 2, skipped: 1, total: 4, current: "Tenant <b>settings</b> endpoint",
        items: [
          { id: "t1", text: "Shared repository", status: "done" as const },
          { id: "t2", text: "Tenant <b>settings</b> endpoint", status: "in_progress" as const, note: "admin auth first" },
          { id: "t3", text: "Lobby picker", status: "pending" as const },
          { id: "t0", text: "Old work", status: "skipped" as const, note: "Closed by Conveyor when the implementation stage passed its gate." },
        ],
      },
    };
    const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [working] }], backlog: [backlogIssue] });
    expect(html).toContain('aria-label="Todo progress for #77: 2 of 4 todos finished"');
    expect(html).toContain('<meter min="0" max="4" value="2"');
    expect(html).toContain('<span class="todo-progress-count">2/4</span>');
    expect(html).toContain('class="todo todo--skipped"');
    expect(html).toContain("Skipped · ");
    expect(html).toContain("2/4, 1 skipped");
    expect(html).toContain("Tenant &lt;b>settings&lt;/b> endpoint");
    expect(html).not.toContain("<b>settings</b>");
    expect(html).toContain('class="todo todo--done"');
    expect(html).toContain('class="todo todo--in_progress"');
    expect(html).toContain('<span class="todo-note">admin auth first</span>');
    expect(html.match(/class="todo-progress"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Implementation todos"/g)).toHaveLength(1);
  });

  test("shows card todo progress only in the stage that owns the list, keeping the details checklist", () => {
    for (const stage of ["review", "merge", "done"]) {
      const issue = {
        ...backlogIssue, id: "later", number: 78, stage,
        todos: { finished: 1, skipped: 1, total: 1, current: null, items: [{ id: "t1", text: "Closed", status: "skipped" as const, note: "n" }] },
      };
      const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [issue] }], backlog: [backlogIssue] });
      expect(html).not.toContain('class="todo-progress"');
      expect(html.match(/aria-label="Implementation todos"/g)).toHaveLength(1);
    }
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

    expect(html).toContain('class="issue issue--warning issue--working issue--glow-attention repo-color-1"');
    expect(html).toContain('class="repository-badge" href="/repositories/sample" title="sample"><i class="repository-dot" aria-hidden="true"></i><span class="repository-name">sample</span></a><span class="issue-number">#41</span>');
    expect(html).toContain('class="details-kicker repo-color-1"><a class="repository-badge" href="/repositories/sample" title="sample">');
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

  test("renders the ordered Board strip and repository list without a horizontal phone layout", () => {
    const summary = (id: string, health: "healthy" | "degraded", items: DashboardViewModel["repositories"][number]["items"], errorSummary: string | null = null) => ({
      id, address: `owner/${id}`, color: 1, health, error: errorSummary, errorSummary,
      addressUrl: `https://github.com/owner/${id}`, lastReconciledAt: null,
      backlog: 1, stages: [{ id: "implementation", name: "Implementation", count: 1 }], done: 2, items,
      deliveries: [], capacity: { busy: 1, slots: 2 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "webhook" as const, ciProvider: "github-actions", ciMode: "required" as const, systemLabels: ["conveyor"] },
      report30d: { delivered: 2, inputTokens: 20, outputTokens: 10, agentMs: 60_000 },
    });
    const repositories = [
      summary("z-idle", "healthy", []),
      summary("active", "healthy", [{ number: 2, title: "Working", stage: "implementation", state: "Running" }]),
      summary("owner", "healthy", [{ number: 3, title: "Question", stage: "review", state: "Needs you" }]),
      summary("broken", "degraded", [], "Webhook is unavailable"),
      summary("alpha-idle", "healthy", []),
      summary("extra", "healthy", []),
      summary("space/name", "healthy", []),
    ];
    const board = renderDashboard({ ...dashboard, repositories });

    expect(board).toContain('<h2 id="repositories-heading"><a href="/repositories">Repositories</a></h2>');
    expect(board).toContain('href="/repositories/space%2Fname"');
    expect(board).toContain('Webhook is unavailable');
    expect(board).toContain('1 in progress · 1 needs you');
    expect(board).toContain('Show all 7');
    expect(board.indexOf('href="/repositories/broken"')).toBeLessThan(board.indexOf('href="/repositories/owner"'));
    expect(board.indexOf('href="/repositories/owner"')).toBeLessThan(board.indexOf('href="/repositories/active"'));
    expect(dashboardCss).toContain('.repository-grid{grid-template-columns:minmax(0,1fr)}');

    const list = renderDashboard({ ...dashboard, view: "repositories", repositories });
    expect(list).toContain('class="tab tab--active" aria-current="page">Repositories</a>');
    expect(list).toContain('owner/space/name');
    expect(list).not.toContain('Show all 7');
    expect(renderDashboard({ ...dashboard, repositories: [] })).toContain("No repositories are configured.");
  });

  test("renders repository detail sections and redacts restricted setup for non-superusers", () => {
    const repository = {
      id: "space/name", address: "owner/space-name", color: 2, health: "degraded" as const,
      error: "The full reconciliation error", errorSummary: "Reconciliation failed", backlog: 4,
      addressUrl: "https://github.com/owner/space-name", lastReconciledAt: "2026-10-01T00:00:00.000Z",
      stages: [{ id: "implementation", name: "Implementation", count: 2 }], done: 8,
      items: [{ number: 7, title: "Current item", stage: "implementation", state: "Running" as const }],
      deliveries: [{ number: 6, title: "Delivered item", deliveredAt: "2026-10-01T00:00:00.000Z" }],
      capacity: { busy: 1, slots: 2 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling" as const, ciProvider: "github-actions", ciMode: "required" as const, systemLabels: ["conveyor"] },
      report30d: { delivered: 8, inputTokens: 120, outputTokens: 30, agentMs: 180_000 },
    };
    const base = { ...dashboard, view: "repository" as const, repositoryId: repository.id, repositories: [repository], restrictedRepositories: [{ id: repository.id, folder: "/sentinel/local-folder", agentEgressHosts: ["sentinel.egress.example"] }] };
    const reader = renderDashboard({ ...base, account: { id: "reader", username: "reader", role: "user", avatar: "🦊" } });
    expect(reader).toContain("The full reconciliation error");
    expect(reader).toContain('href="/issues/space%2Fname/7"');
    expect(reader).toContain('href="/repositories"');
    expect(reader).toContain("‹ Repositories");
    expect(reader).toContain('href="https://github.com/owner/space-name"');
    expect(reader).toContain('data-relative-time="true">recently</time>');
    expect(reader).toContain("Last checked");
    expect(reader).toContain("Slots");
    expect(reader).toContain("1 of 2");
    // Counts, not nine links to the same Board page.
    expect(reader).toContain("<p>4 backlog · 2 Implementation · 8 completed all-time</p>");
    expect(reader).toContain("Completed all-time includes completed roll-up parents; Last 30 days counts deliveries only.");
    expect(reader).toContain('href="/reports/space%2Fname?period=30d"');
    expect(reader).toContain("Full report →");
    for (const heading of ["Line", "Now", "Recently delivered", "Setup", "Last 30 days"]) expect(reader).toContain(`<h3>${heading}</h3>`);
    expect(reader).not.toContain("/sentinel/local-folder");
    expect(reader).not.toContain("sentinel.egress.example");
    const superuser = renderDashboard({ ...base, account: { id: "admin", username: "admin", role: "superuser", avatar: "🦊" } });
    expect(superuser).toContain("/sentinel/local-folder");
    expect(superuser).toContain("sentinel.egress.example");

    const unreconciled = renderDashboard({ ...base, repositories: [{ ...repository, lastReconciledAt: null }] });
    expect(unreconciled).not.toContain("Last checked");

    const idle = renderDashboard({ ...base, repositories: [{ ...repository, capacity: { busy: 0, slots: 2 } }] });
    expect(idle).toContain("<dt>Slots</dt><dd>0 of 2</dd>");
  });

  test("renders legacy string choices and an actionable error instead of an empty answer form", () => {
    const legacy = renderDashboard({
      ...dashboard,
      questions: [{ ...dashboard.questions[0]!, options: [{ id: "compact", label: "Compact" }, { id: "expanded", label: "Expanded" }], answerError: null }],
    });
    expect(legacy).toContain('type="radio" name="answer" value="compact"');
    expect(legacy).toContain('type="radio" name="answer" value="expanded"');

    const invalid = renderDashboard({
      ...dashboard,
      questions: [{ ...dashboard.questions[0]!, options: [], allowFreeText: false, answerError: "A question needs at least one valid choice or free-text input." }],
    });
    expect(invalid).toContain('role="alert">A question needs at least one valid choice or free-text input.</p>');
    expect(invalid).not.toContain('/questions/question%2F1/answer');
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

  test("keeps Board summaries on the Board and gives every view conditional navigation", () => {
    const secondary = renderDashboard({ ...dashboard, view: "team" });
    const empty = renderDashboard({ ...dashboard, view: "team", questions: [], needsYou: [], counts: { ...dashboard.counts, attention: 0 } });
    const attention = renderDashboard({ ...dashboard, view: "attention", counts: { ...dashboard.counts, attention: 0 } });
    const questionAndStopped = renderDashboard({
      ...dashboard,
      view: "team",
      needsYou: [...dashboard.needsYou, backlogIssue],
    });

    expect(secondary.indexOf('class="app-header"')).toBeLessThan(secondary.indexOf('class="system-warnings"'));
    expect(secondary.indexOf('class="system-warnings"')).toBeLessThan(secondary.indexOf('class="tabs"'));
    expect(secondary.indexOf('class="tabs"')).toBeLessThan(secondary.indexOf('class="team"'));
    expect(secondary).not.toContain('id="line-heading"');
    expect(secondary).not.toContain('id="needs-you-heading"');
    expect(secondary).toContain('href="/board#needs-you-heading" class="needs-you-link"><i class="andon andon--stop" aria-hidden="true"></i><span><strong>2</strong> need you</span></a>');
    expect(secondary).toContain('>Label problems<span class="tab-count">1</span>');
    expect(secondary).not.toContain('href="/profile" class="tab');
    expect(secondary).not.toContain('href="/accounts" class="tab');
    expect(secondary).not.toContain('href="/about" class="tab');
    expect(secondary).not.toContain('href="/accounts" class="account-menu-item"');
    expect(secondary).toContain('>About Conveyor</a>');
    expect(questionAndStopped).toContain('href="/board#needs-you-heading" class="needs-you-link"><i class="andon andon--stop" aria-hidden="true"></i><span><strong>2</strong> need you</span></a>');
    expect(empty).not.toContain('/board#needs-you-heading');
    expect(empty).not.toContain('href="/attention"');
    expect(attention).toContain('href="/attention" class="tab tab--active" aria-current="page">Label problems<span class="tab-count">0</span>');
    expect(renderDashboard(dashboard).indexOf('class="tabs"')).toBeLessThan(renderDashboard(dashboard).indexOf('id="line-heading"'));
  });

  test("shows each open parent as a foldable row of its children, and a finished family as its parent alone", () => {
    const station = (index: number, name: string) => ({ index, count: 4, name });
    const family: IssueCardViewModel = {
      ...parent,
      id: "family",
      number: 172,
      title: "Accounts and sessions",
      waiting: null,
      children: [
        { id: "running-part", repository: "sample", number: 246, title: "Sign in by code", url: null, satisfied: false, station: station(1, "Build"), signal: "run" },
        { id: "stopped-part", repository: "sample", number: 247, title: "Guest sign-in", url: null, satisfied: false, station: station(1, "Build"), signal: "stop" },
        { id: "done-part", repository: "sample", number: 244, title: "Store sign-in data", url: null, satisfied: true, station: station(3, "Done") },
      ],
    };
    const relation = (id: string, number: number, title: string) => ({ id, repository: "sample", number, title, url: null, satisfied: false });
    const child = (id: string, number: number, title: string, parentId = "family", parentNumber = 172): IssueCardViewModel => ({
      ...backlogIssue, id, number, title, parent: relation(parentId, parentNumber, "Accounts and sessions"), parentProgress: { done: 1, total: 3 }, children: [],
    });
    const unrelated = { ...backlogIssue, id: "unrelated", number: 300, title: "Unrelated work" };
    const orphan = child("orphan", 310, "Child of an off-board parent", "elsewhere", 900);
    const finished: IssueCardViewModel = { ...completedIssue, id: "finished", number: 500, title: "Finished parent",
      children: [{ ...relation("old-part", 501, "Old part"), satisfied: true }] };
    const html = renderDashboard({
      ...dashboard,
      stages: [{ ...dashboard.stages[0]!, issues: [child("running-part", 246, "Sign in by code"), unrelated, family, child("stopped-part", 247, "Guest sign-in"), orphan, child("done-part", 244, "Store sign-in data")] }],
      done: { ...dashboard.done, issues: [child("done-part", 244, "Store sign-in data"), finished, child("old-part", 501, "Old part", "finished", 500)] },
    });
    const familyRow = html.slice(html.indexOf('data-family-row="family"'), html.indexOf('class="board-row other-row'));
    const otherRow = html.slice(html.indexOf('class="board-row other-row'));

    // The parent is the row's header, not a card: number, title, a square per child, progress, its own stop, Details.
    expect(html).not.toContain('data-issue-id="family" data-dialog-open');
    expect(familyRow).toContain('data-row-fold="family-family" aria-controls="family-family-cells" aria-expanded="true" aria-label="Fold the #172 family"');
    expect(familyRow).toContain('<span class="family-number">#172</span><strong class="family-title" title="Accounts and sessions">Accounts and sessions</strong>');
    expect(familyRow).toContain('<span class="family-squares" role="img" aria-label="1 done, 1 running, 1 stopped"><span class="family-square family-square--done"');
    expect(familyRow.indexOf("family-square--run")).toBeLessThan(familyRow.indexOf("family-square--stop"));
    expect(familyRow).toContain('<span class="family-progress"><strong>1/3</strong> done</span>');
    expect(familyRow).toContain('class="family-stop"');
    expect(familyRow).toContain('<button type="button" class="family-details card-open" aria-haspopup="dialog">Details</button>');
    expect(familyRow).toContain('id="issue-family-172-family"');
    // Its children are cards in their stations, labelled with the station for phones; its done parts are listed.
    expect(familyRow).toContain('id="family-family-cells"');
    // The page script's trace walks from the parent through its unfinished parts, kept apart from its dependencies.
    expect(familyRow).toContain('data-parts="running-part stopped-part"');
    expect(familyRow).toContain(">Sign in by code</button>");
    expect(familyRow).toContain(">Guest sign-in</button>");
    expect(familyRow).toContain('<span class="issue-stage">Build</span>');
    expect(familyRow).toContain('<a class="issue issue--compact issue--success repo-color-1" href="/issues/sample/244"><span class="issue-kicker"><span class="issue-number">#244</span>');
    expect(familyRow).toContain('<span class="issue-title">Store sign-in data</span><span class="issue-status"><span class="andon andon--run" aria-hidden="true"></span><strong>Done</strong></span>');
    expect(familyRow).not.toContain("family-thread");
    expect(familyRow).not.toContain(">Store sign-in data</button>");
    expect(familyRow.match(/<span class="issue-title">Store sign-in data<\/span>/g)?.length).toBe(1);
    // An empty stage is a narrow column with its heading in the strip like any other.
    const withEmpty = renderDashboard({ ...dashboard });
    expect(withEmpty).toContain('<section class="stage stage--empty" id="station-stage-review"');
    expect(withEmpty).toContain(' 4.5rem ');
    // Everything else is in the bottom row; a child of an off-board parent links to it.
    expect(otherRow).toContain('data-row-fold="board-other"');
    expect(otherRow).toContain(">Unrelated work</button>");
    expect(otherRow).not.toContain(">Sign in by code</button>");
    expect(otherRow).not.toContain('data-issue-id="done-part"');
    expect(otherRow).toContain('<p class="family-thread">');
    expect(otherRow).toContain('href="/issues/sample/900" title="#900 Accounts and sessions">#900 Accounts and sessions</a><span class="family-thread-progress">1/3</span>');
    // A finished family is its parent alone, in Done.
    expect(otherRow).toContain(">Finished parent</button>");
    expect(otherRow).toContain('<p class="rollup-summary">All 1 part done</p>');
    expect(otherRow).not.toContain('data-issue-id="old-part"');
    expect(html).not.toContain('data-family-row="finished"');
    // The columns line up: one grid template for the header strip and every row.
    expect(html).toContain('class="board-track" style="--board-columns:min(20rem,86vw) min(20rem,86vw) min(20rem,86vw);--board-columns-phone:calc(100vw - 1.5rem) calc(100vw - 1.5rem) calc(100vw - 1.5rem)"');
    // An empty stage in the middle is a narrow column; an empty Backlog (or Done) keeps its width.
    const empty = renderDashboard({ ...dashboard, backlog: [] });
    expect(empty).toContain('style="--board-columns:min(20rem,86vw) min(20rem,86vw) 4.5rem min(20rem,86vw);');
    expect(empty).toContain('class="stage stage--empty" id="station-stage-review"');
    expect(empty).toContain('class="stage stage--backlog" id="station-backlog"');
    expect(html).toContain('data-station-cell="stage:build"');
  });

  test("a stage's dialog marks a script stage, and always has a usage line", () => {
    const scripted = { ...dashboard.stages[0]!, id: "stage:deploy", name: "Deploy", cost: null, actors: [{ type: "script" as const, name: "Script", title: null }] };
    const quiet = { ...dashboard.stages[0]!, id: "stage:review", name: "Review", cost: null };
    const html = renderDashboard({ ...dashboard, stages: [scripted, quiet] });
    const dialog = (id: string) => html.slice(html.indexOf(`id="stage-info-${id}"`), html.indexOf("</dialog>", html.indexOf(`id="stage-info-${id}"`)));
    expect(dialog("stage-deploy")).toContain("<strong>Script</strong></span>");
    expect(dialog("stage-deploy")).toContain("⚙");
    expect(dialog("stage-deploy")).toContain("Runs without an agent, so it uses no tokens.");
    expect(dialog("stage-review")).toContain("No agent usage recorded yet.");
    expect(dialog("backlog")).toContain("Not a stage agents work in.");
  });

  test("shows dependencies as chips with their state, what each item blocks, and what the page script traces", () => {
    const dependency = (id: string, number: number, extra: object = {}) => ({ id, repository: "sample", number, title: `Item ${number}`, url: null, satisfied: false, ...extra });
    const blocker: IssueCardViewModel = { ...backlogIssue, id: "blocker", number: 245, title: "Stuck item", tone: "danger", state: "blocked", dependencies: [] };
    const waiting: IssueCardViewModel = { ...backlogIssue, id: "waiting", number: 246, title: "Waiting item",
      dependencies: [dependency("blocker", 245, { signal: "stop", state: "Blocked" }), dependency("moving", 260, { signal: "wait", state: "Active" }), dependency("off-board", 39), { ...dependency("finished", 1), satisfied: true }] };
    const moving: IssueCardViewModel = { ...backlogIssue, id: "moving", number: 260, title: "Moving item", dependencies: [] };
    const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [blocker, waiting, moving] }] });
    const card = (id: string) => html.slice(html.indexOf(`data-issue-id="${id}" data-dialog-open`), html.indexOf("<dialog", html.indexOf(`data-issue-id="${id}" data-dialog-open`)));

    // A stopped blocker is a red chip naming its state; one on the board traces in place; one off it links; a finished one is gone.
    expect(card("waiting")).toContain('<button type="button" class="dep-chip dep-chip--stop" data-trace="blocker" aria-pressed="false" aria-label="Trace #245, blocked" title="Item 245">#245 · Blocked</button>');
    expect(card("waiting")).toContain('<button type="button" class="dep-chip" data-trace="moving" aria-pressed="false" aria-label="Trace #260, active" title="Item 260">#260</button>');
    expect(card("waiting")).toContain('<a class="dep-chip" href="/issues/sample/39" title="Item 39">#39</a>');
    expect(card("waiting")).not.toContain("#1<");
    expect(card("waiting")).toContain('data-waits="blocker moving off-board"');
    // What an item blocks.
    expect(card("blocker")).toContain('<button type="button" class="dep-chip dep-chip--blocks" data-trace="blocker" aria-pressed="false" aria-label="#245 blocks 1: trace them">Blocks 1</button>');
    expect(card("blocker")).toContain('data-number="245" data-state-word="Blocked"><p class="issue-kicker">');
    expect(card("moving")).toContain(">Blocks 1</button>");
    expect(html).toContain('<p class="trace-banner" data-trace-banner="true" role="status" hidden>');
  });

  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain("Delivery board");
    expect(html).toContain(">Backlog</h2>");
    // A heading is the name, an information button and the count; the rest is in its dialog.
    expect(html).toContain('<button type="button" class="stage-info card-open" data-dialog-open="stage-info-stage-build" aria-haspopup="dialog" aria-label="About Build">');
    expect(html).toContain('<dialog class="stage-dialog" id="stage-info-stage-build" aria-labelledby="stage-info-stage-build-title">');
    expect(html).toContain('<p class="stage-dialog-description">Enrolled items waiting for their first stage, in the order they will start.</p>');
    // Each heading has an emoji: the configured one, else the usual one for its id (none for an unknown stage).
    expect(html).toContain('<span class="stage-emoji" aria-hidden="true">📥</span><h2 id="stage-backlog">Backlog</h2>');
    expect(html).toContain('<span class="stage-emoji" aria-hidden="true">🏁</span><h2 id="stage-done">Done</h2>');
    expect(html).not.toContain('<span class="stage-emoji" aria-hidden="true"></span>');
    expect(renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, icon: "🧪" }] })).toContain('<span class="stage-emoji" aria-hidden="true">🧪</span><h2 id="stage-stage-build">Build</h2>');
    expect(html).toContain('<section class="stage-dialog-team" aria-label="Who works in Build"><h3>Team</h3>');
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
    expect(html).not.toContain("stage-group");
    expect(html).not.toContain(">Roll-up parents</h3>");
    expect(html).toContain("Executable child");
    expect(html).toContain("Waiting for CI for 7c0ea55");
    expect(html).toContain("next check");
    expect(html).toContain("gives up");
    expect(html).toContain('data-local-clock="true"');
    expect(html).toContain('aria-label="1 waiting"');
    expect(html).toContain("Blocked by");
    expect(html).toContain("Required foundation");
    expect(html).toContain('<span class="relation-group relation-group--blocked">Waiting on</span><a class="dep-chip" href="/issues/foundation/39" title="Open foundation">#39</a>');
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
    expect(html).toContain("Label problems");
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
    // The title is the control that opens the details, so assistive technology announces a button.
    expect(html).toContain('<button type="button" class="card-open" aria-haspopup="dialog">');
    expect(html).not.toContain('aria-label="Open details for issue #41"');
    expect(html).toContain("<summary><strong>1 of 4</strong> runners</summary>");
    expect(html).toContain("<h2>Active work</h2>");
    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain('href="/issues/sample/41"');
    expect(html).toContain('<span class="repository-name">sample</span></a><span class="issue-number">#41</span>');
    expect(html).toContain('href="/issues/foundation/40"');
    expect(html).not.toContain('href="https://github.com/sample/repo/issues/42"');
    expect(html).not.toContain(">Permalink</a>");
    expect(html).toContain('data-detail-tab="conversation"');
    expect(html).toContain("Conversation");
    expect(html).toContain('data-conversation-url="/api/issues/parent/conversation"');
    expect(html).toContain("grid-auto-rows:max-content");
    expect(html).toContain(".agent-events{display:grid;grid-template-columns:minmax(0,1fr);flex:1;");
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
    // The count always sits beside the stage name; a long usage line gets the full width below.
    expect(html).toContain(".stage-heading .count{grid-column:2;grid-row:1}.stage-actors,.stage-cost{grid-column:1/-1}");
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
    expect(html).not.toContain('href="/accounts" class="account-menu-link"');
    expect(html).not.toContain('href="/profile#change-password" class="account-menu-link">Change password</a>');
    expect(html).toContain('href="/about"');
    expect(html).toContain('data-theme-choice="system"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).not.toContain('href="/accounts"');
    expect(html).not.toContain("Move #43 up");
    expect(html).not.toContain('action="/steering"');
  });

  test("renders Accounts and Profile as shared dashboard views with inline forms", () => {
    const account = { id: "admin", username: "admin", role: "superuser" as const, avatar: "🦊" };
    const accountsHtml = renderDashboard({
      ...dashboard,
      view: "accounts",
      account,
      accounts: [account, { id: "reader", username: "reader <safe>", role: "user", avatar: "🐸" }],
    });
    expect(accountsHtml).toContain('data-dashboard-view="accounts"');
    expect(accountsHtml).toContain('href="/accounts" class="account-menu-link account-menu-link--active" aria-current="page">Accounts</a>');
    expect(accountsHtml).toContain('data-account-list="true"');
    expect(accountsHtml).toContain('data-account-create-form="true"');
    expect(accountsHtml).toContain('action="/api/accounts/admin/password"');
    expect(accountsHtml).toContain('action="/api/accounts/reader/delete"');
    expect(accountsHtml).toContain('Type reader &lt;safe> to confirm deletion');
    expect(accountsHtml).not.toContain('action="/api/accounts/admin/delete"');
    expect(accountsHtml).toContain('reader &lt;safe>');
    expect(accountsHtml).not.toContain('reader <safe>');
    expect(accountsHtml).not.toContain('class="account-page"');

    const profileHtml = renderDashboard({ ...dashboard, view: "profile", account });
    expect(profileHtml).toContain('data-dashboard-view="profile"');
    expect(profileHtml).toContain('href="/profile" class="account-menu-link account-menu-link--active" aria-current="page"');
    expect(profileHtml).toContain('name="avatar" value="🦊" checked');
    expect(profileHtml).toContain('data-profile-avatar-form="true"');
    expect(profileHtml).toContain('<button type="submit">Save</button>');
    expect(profileHtml).not.toContain('Save avatar');
  });

  test("renders Notifications as a shared dashboard view", () => {
    const html = renderDashboard({
      ...dashboard,
      view: "notifications",
      account: { id: "reader", username: "reader", role: "user", avatar: "🐸" },
      notifications: { questions: true, stopped: false, done: true },
    });
    expect(html).toContain('data-dashboard-view="notifications"');
    expect(html).toContain('class="header-link header-link--active" href="/settings/notifications" aria-current="page"');
    expect(html).toContain('id="notification-settings" class="settings-form notification-form"');
    expect(html).toContain('name="questions" checked');
    expect(html).toContain('name="done" checked');
    expect(html).toContain('<script src="/assets/notifications.js" defer></script>');
    expect(html).not.toContain('class="account-page"');
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
    // Every profile is on the page at once, so its section ids carry the agent.
    expect(html).toContain('<h2 id="agent-kaveh-config">Configuration</h2>');
    expect(html).toContain('<h2 id="agent-darya-config">Configuration</h2>');
    expect(html).toContain('<h2 class="sr-only" id="team-heading">Team</h2>');
    expect(html).toContain('<h3><button type="button" class="card-open" aria-haspopup="dialog">Kaveh</button></h3>');
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
    expect(html).toContain("Label problems");
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

  test("names each view in the document title and offers a skip link past the shared header", () => {
    expect(renderDashboard(dashboard)).toContain("<title>Board · Conveyor</title>");
    // The client swaps between an open item's title and the view's own, which the body carries.
    const item = renderDashboard({ ...dashboard, selectedIssue: dashboard.stages[0]!.issues[0]! });
    expect(item).toMatch(/<title>#\d+ [^<]+ · Conveyor<\/title>/);
    expect(item).toContain('data-view-title="Board · Conveyor"');
    expect(renderDashboard({ ...dashboard, view: "agent" })).toContain("<title>Operator · Conveyor</title>");
    expect(renderDashboard({ ...dashboard, view: "repository", repositoryId: "demo" })).toContain("<title>demo · Conveyor</title>");

    const html = renderDashboard({ ...dashboard, view: "about" });
    expect(html).toContain("<title>About · Conveyor</title>");
    expect(html.indexOf('<a class="skip-link" href="#content">')).toBeLessThan(html.indexOf('<main class="dashboard">'));
    expect(html.indexOf('id="content"')).toBeGreaterThan(html.indexOf('aria-label="Dashboard views"'));
    expect(html).toContain('role="status" data-route-announcer');
  });

  test("keeps status text readable in the light theme while the signal dots stay vivid", () => {
    const html = renderDashboard(dashboard);
    expect(html).toContain("--run-text:#17704A;--wait-text:#8A5200;--stop-text:#A72F1D");
    expect(html).toContain(".indicator-chip--passing{border-color:var(--run);color:var(--run-text)}");
    expect(html).toContain(".andon--wait{background:var(--wait)}");
  });
});
