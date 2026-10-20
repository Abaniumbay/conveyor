import { describe, expect, test } from "bun:test";
import { renderDashboard, renderIssueDetails } from "../../src/web/render";
import { BUILD } from "../../src/version";
import { dashboardCss, graphCss, quotaHeaderCss, themeInitScript } from "../../src/web/styles";
import type { DashboardView, DashboardViewModel, IssueCardViewModel } from "../../src/web/types";

const parent: IssueCardViewModel = {
  id: "parent",
  repository: "sample",
  repositoryPaused: false,
  repositoryColor: 1,
  number: 41,
  title: "Build <safe> & sound",
  url: "https://github.com/sample/repo/issues/41?x=1&y=2",
  state: "in_progress",
  labels: ["feature", "priority: high"],
  issueType: "Feature",
  issueFields: [{ name: "Effort", value: "Medium" }],
  acceptanceCriteria: [
    { id: "AC-1", text: "<script>alert(1)</script>", approved: false, manual: false, tests: [] },
    { id: "AC-2", text: "Keyboard usable", approved: true, manual: false, tests: [] },
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
  resumableRollup: false,
  stoppedRollup: false,
};

const backlogIssue: IssueCardViewModel = {
  id: "backlog",
  repository: "sample",
  repositoryPaused: false,
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
  resumableRollup: false,
  stoppedRollup: false,
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
  draining: null,
  updatedAt: "2026-09-29T12:00:00Z",
  revision: "revision-1",
  view: "board",
  repositoryId: null,
  graph: { nodes: [], relationships: [] },
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

test("defines shared action variants with a touch target", () => {
  expect(dashboardCss).toContain(".action-button{");
  expect(dashboardCss).toContain(".action-button--primary{");
  expect(dashboardCss).toContain(".action-button--secondary{");
  expect(dashboardCss).toContain(".action-button--destructive{");
  expect(dashboardCss).toContain(".action-button:focus-visible{");
  expect(dashboardCss).toContain("@media(pointer:coarse){.action-button{min-height:2.75rem}");
  expect(dashboardCss).toContain(".dialog-close{");
  for (const duplicatedRule of [".repository-sync button{", ".retry-form button{", ".settings-actions button{", ".recent-filter-submit,.recent-load-more{"]) {
    expect(dashboardCss).not.toContain(duplicatedRule);
  }
});

test("keeps at most one primary action in each dashboard view", () => {
  const account = { id: "admin", username: "admin", role: "superuser" as const, avatar: "🦊" };
  const views: readonly DashboardView[] = ["board", "graph", "recent", "attention", "agent", "team", "reports", "repositories", "repository", "about", "accounts", "profile", "notifications"];

  for (const view of views) {
    const html = renderDashboard({
      ...dashboard,
      view,
      account,
      accounts: [account],
      notifications: { questions: true, stopped: false, done: true },
    });
    expect((html.match(/class="[^"]*action-button--primary/g) ?? []).length, `${view} has more than one primary action`).toBeLessThanOrEqual(1);
  }

  expect(renderIssueDetails(parent)).toContain('<button type="submit" class="action-button action-button--secondary">Send</button>');
});

test("keeps dialog, line, row-fold, and theme controls out of action-button variants", () => {
  const family: IssueCardViewModel = {
    ...parent,
    id: "family",
    number: 172,
    children: [{ id: "family-part", repository: "sample", number: 173, title: "A family part", url: null, satisfied: false }],
  };
  const familyPart: IssueCardViewModel = {
    ...backlogIssue,
    id: "family-part",
    number: 173,
    parent: { id: "family", repository: "sample", number: 172, title: "Build <safe> & sound", url: null, satisfied: false },
    parentProgress: { done: 0, total: 1 },
  };
  const html = renderDashboard({
    ...dashboard,
    selectedIssue: parent,
    stages: [{ ...dashboard.stages[0]!, issues: [family, familyPart] }, dashboard.stages[1]!],
  });

  expect(html).toContain('<button class="dialog-close" aria-label="Close issue details">×</button>');
  expect(html).toContain('<button type="button" class="line-toggle" data-line-toggle="true"');
  expect(html).toContain('<button type="button" class="row-fold" data-row-fold="family-family" aria-controls="family-family-cells" aria-expanded="true" aria-label="Fold the #172 family" data-fold-label="the #172 family">');
  expect(html).toContain('<button type="button" data-theme-choice="system" aria-pressed="true">System</button>');
  expect(html).toContain('<button type="button" data-theme-choice="light" aria-pressed="false">Light</button>');
  expect(html).toContain('<button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>');
});

test("renders the stage badge and source link once in every item-details header", () => {
  const issue: IssueCardViewModel = {
    ...parent,
    stageBadge: { name: "Review", icon: "🔍", offboarded: false },
  };
  const dialog = renderDashboard({
    ...dashboard,
    stages: [{ ...dashboard.stages[0]!, issues: [issue] }],
    selectedIssue: issue,
  });
  const direct = renderIssueDetails(issue);

  for (const html of [dialog, direct]) {
    expect(html).toContain('data-details-stage-badge');
    expect(html).toContain('<span class="sr-only">Stage: </span>Review');
    expect(html).not.toContain('aria-label="Stage: Review"');
    expect(html).toContain('class="details-stage-icon"');
    expect(html).toContain('🔍');
    expect(html).toContain('href="https://github.com/sample/repo/issues/41?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"');
    expect(html.match(/Open issue source ↗/g)).toHaveLength(1);
    expect(html).not.toContain('class="details-source"');
  }

  const noIcon = renderIssueDetails({ ...issue, stageBadge: { name: "Deploy", icon: null, offboarded: false } });
  expect(noIcon).toContain('<span class="sr-only">Stage: </span>Deploy');
  expect(noIcon).not.toContain('aria-label="Stage: Deploy"');
  expect(noIcon).not.toContain('details-stage-icon');

  const offboarded = renderIssueDetails({ ...issue, historyOnly: true, stageBadge: { name: "Build", icon: "🛠️", offboarded: true } });
  expect(offboarded).toContain('<span class="sr-only">Stage: </span>Build (offboarded)');
  expect(offboarded).not.toContain('aria-label="Stage: Build (offboarded)"');
  expect(offboarded).toContain('offboarded');
  expect(offboarded).toContain('aria-hidden="true"');
});

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
  const withIndicators = (indicators: IssueCardViewModel["indicators"]) => {
    const issue = { ...parent, indicators };
    return `${renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, issues: [issue] }] })}${renderIssueDetails(issue)}`;
  };

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
  const html = (issueType: string | null, issueFields: IssueCardViewModel["issueFields"]) => {
    const issue = { ...parent, issueType, issueFields };
    return renderDashboard({ ...dashboard, selectedIssue: issue, stages: [{ ...dashboard.stages[0]!, issues: [issue] }] });
  };

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
  test("renders a safe draining notice and a release link only for a typed upgrade", () => {
    const ordinary = renderDashboard({
      ...dashboard,
      draining: { reason: "operator requested <em>maintenance</em>", upgrade: null },
    });
    expect(ordinary).toContain("Draining");
    expect(ordinary).toContain("Work already running continues.");
    expect(ordinary).toContain("operator requested &lt;em>maintenance&lt;/em>");
    expect(ordinary).not.toContain("<em>maintenance</em>");
    expect(ordinary).not.toContain("Target version:");
    expect(ordinary).not.toContain("releases/tag/");

    for (const reason of ["service restarted before the switch", "rollback to 1.0.0"]) {
      const nonUpgrade = renderDashboard({ ...dashboard, draining: { reason, upgrade: null } });
      expect(nonUpgrade).toContain(`Reason: ${reason}`);
      expect(nonUpgrade).not.toContain("Target version:");
      expect(nonUpgrade).not.toContain("releases/tag/");
    }

    const upgrade = renderDashboard({
      ...dashboard,
      draining: {
        reason: "upgrade to 9.9.9",
        upgrade: { version: "9.9.9", releaseUrl: "https://github.com/Abaniumbay/conveyor/releases/tag/v9.9.9" },
      },
    });
    expect(upgrade).toContain("Target version: 9.9.9");
    expect(upgrade).toContain('href="https://github.com/Abaniumbay/conveyor/releases/tag/v9.9.9"');
    expect(upgrade).toContain("View release 9.9.9");
  });

  test("renders an accessible Graph view with directed, text-labelled relationships", () => {
    const html = renderDashboard({
      ...dashboard,
      view: "graph",
      graph: {
        nodes: [
          { id: "parent", repository: "sample", repositoryColor: 1, number: 41, title: "Parent <safe> title that remains available in full", state: "Active", stage: "Implementation", context: false, signal: "run" },
          { id: "child", repository: "sample", repositoryColor: 1, number: 42, title: "Child", state: "Blocked", stage: "Review", context: false, signal: "stop" },
          { id: "prerequisite", repository: "foundation-with-a-deliberately-long-name", repositoryColor: 2, number: 7, title: "Finished prerequisite", state: "Done", stage: null, context: true, signal: null },
          { id: "outstanding", repository: "foundation", repositoryColor: 2, number: 8, title: "Outstanding prerequisite", state: "Active", stage: null, context: true, signal: "run" },
          { id: "stopped", repository: "foundation", repositoryColor: 2, number: 9, title: "Stopped prerequisite", state: "Stopped", stage: null, context: true, signal: "stop" },
          { id: "standalone", repository: "sample", repositoryColor: 1, number: 99, title: "Unconnected item title", state: "Active", stage: "Implementation", context: false, signal: "run" },
        ],
        relationships: [
          { kind: "parent-child", from: "parent", to: "child", status: null },
          { kind: "dependency", from: "prerequisite", to: "child", status: "satisfied" },
          { kind: "dependency", from: "outstanding", to: "child", status: "outstanding" },
          { kind: "dependency", from: "stopped", to: "child", status: "stopped" },
        ],
      },
      graphFilters: {
        repositories: ["sample"], stage: "implementation",
        stages: [{ id: "implementation", name: "Implementation" }, { id: "review", name: "Review" }],
      },
      repositories: [
        {
          id: "sample", address: "owner/sample", addressUrl: null, color: 1, health: "healthy", error: null, errorSummary: null, lastReconciledAt: null, pause: null,
          backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
          setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling", webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled", systemLabels: [] },
          trust: { visibility: "unknown", checkedAt: null, warning: null, permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: [] },
          report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
        },
        {
          id: "foundation", address: "owner/foundation", addressUrl: null, color: 2, health: "healthy", error: null, errorSummary: null, lastReconciledAt: null, pause: null,
          backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
          setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling", webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled", systemLabels: [] },
          trust: { visibility: "unknown", checkedAt: null, warning: null, permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: [] },
          report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
        },
      ],
    });

    expect(html).toContain("<title>Graph · Conveyor</title>");
    expect(html).toContain('<a href="/graph" class="tab tab--active" aria-current="page">Graph</a>');
    expect(html).toContain('<a href="/board" class="tab">Board<span class="tab-count">43</span></a>');
    expect(html).toContain('<svg class="graph-svg"');
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="img" aria-labelledby="graph-svg-title');
    expect(html).toContain('data-graph-edge="parent-child:parent:child"');
    expect(html).toContain('data-graph-edge="dependency:prerequisite:child"');
    expect(html).toContain('class="graph-canvas"');
    expect(html).toContain('action="/graph"');
    expect(html).toContain('<section class="board-filters" aria-label="Graph filters">');
    expect(html).toContain('<fieldset><legend>Repositories</legend>');
    expect(html).toContain('class="repository-filter"');
    expect(html).toContain('name="repo" value="sample" checked');
    expect(html).toContain('name="repo" value="foundation"');
    expect(html).toContain('class="repository-dot repo-color-1"');
    expect(html).not.toContain('name="repo" multiple');
    expect(html).toContain('<fieldset><legend>Stage</legend>');
    expect(html).toContain('<select class="board-filter-select" name="stage" aria-label="Graph stage">');
    expect(html).toContain('<option value>All stages</option>');
    expect(html).toContain('<option value="implementation" selected>Implementation</option>');
    expect(html).toContain('class="board-filter-submit action-button action-button--secondary">Apply filters</button>');
    expect(html).toContain('class="board-filter-clear action-button action-button--secondary" href="/graph">Clear</a>');
    expect(graphCss).not.toContain(".graph-filters");
    expect(dashboardCss).toContain(".board-filter-select");
    expect(html).toContain('data-graph-node="parent"');
    expect(html).toContain('Parent &lt;safe> title that remains available in full');
    expect(html).not.toContain("Parent <safe>");
    expect(html).toMatch(/class="graph-node-title"[^>]*>[^<]*…<\/text>/);
    expect(html).toMatch(/class="graph-node-reference"[^>]*>[^<]*…<\/text>/);
    expect(html).toContain('clipPath id="graph-node-clip-parent"');
    expect(html).toContain('clip-path="url(#graph-node-clip-parent)"');
    expect(html).toContain('href="/issues/sample/41"');
    expect(html).toContain('data-details-url="/api/issues/parent/details"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Parent #41 (Parent &lt;safe> title that remains available in full) → child #42 (Child)");
    expect(html).toContain("Issue #42 (Child) waits for prerequisite #7 (Finished prerequisite)");
    expect(html).toContain("Issue #99 (Unconnected item title): stage Implementation; state Active");
    expect(html).toContain("Status: satisfied prerequisite");
    expect(html).toContain("graph-relationship--satisfied");
    expect(html).toContain("graph-relationship--outstanding");
    expect(html).toContain("graph-relationship--stopped");
    expect(html).toContain("Context item");
    expect(html).toContain("Stopped");
  });

  test("keeps branching Graphs stable, uncrossed, and separate from unrelated components", () => {
    const nodes: DashboardViewModel["graph"]["nodes"] = [
      { id: "parent", repository: "sample", repositoryColor: 1, number: 1, title: "Parent", state: "Active", stage: "Implementation", context: false, signal: "run" },
      { id: "branch-a", repository: "sample", repositoryColor: 1, number: 2, title: "First child", state: "Active", stage: "Implementation", context: false, signal: "run" },
      { id: "branch-b", repository: "sample", repositoryColor: 1, number: 3, title: "Second child", state: "Active", stage: "Implementation", context: false, signal: "run" },
      { id: "end-a", repository: "sample", repositoryColor: 1, number: 4, title: "Second dependency target", state: "Active", stage: "Review", context: false, signal: "run" },
      { id: "end-b", repository: "sample", repositoryColor: 1, number: 5, title: "First dependency target", state: "Active", stage: "Review", context: false, signal: "run" },
      { id: "unrelated", repository: "other", repositoryColor: 2, number: 6, title: "Unrelated item", state: "Active", stage: "Implementation", context: false, signal: "run" },
    ];
    const relationships: DashboardViewModel["graph"]["relationships"] = [
      { kind: "parent-child", from: "parent", to: "branch-a", status: null },
      { kind: "parent-child", from: "parent", to: "branch-b", status: null },
      { kind: "dependency", from: "branch-a", to: "end-b", status: "outstanding" },
      { kind: "dependency", from: "branch-b", to: "end-a", status: "outstanding" },
    ];
    const renderGraph = (graphNodes: DashboardViewModel["graph"]["nodes"], graphRelationships: DashboardViewModel["graph"]["relationships"]) => renderDashboard({
      ...dashboard,
      view: "graph",
      graph: { nodes: graphNodes, relationships: graphRelationships },
    });
    const html = renderGraph(nodes, relationships);
    const reorderedHtml = renderGraph([...nodes].reverse(), [...relationships].reverse());
    const nodePosition = (id: string) => {
      const match = html.match(new RegExp(`data-graph-node="${id}"[\\s\\S]*?<rect x="(\\d+)" y="(\\d+)" width="248" height="140"`));
      if (!match?.[1] || !match[2]) throw new Error(`Missing Graph node position for ${id}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    const parent = nodePosition("parent");
    const branchA = nodePosition("branch-a");
    const branchB = nodePosition("branch-b");
    const endA = nodePosition("end-a");
    const endB = nodePosition("end-b");
    const unrelated = nodePosition("unrelated");
    const edgeRows = (id: string) => {
      const match = html.match(new RegExp(`data-graph-edge="${id}">[\\s\\S]*?<path d="M \\d+ (\\d+) C \\d+ \\d+, \\d+ \\d+, \\d+ (\\d+)"`));
      if (!match?.[1] || !match[2]) throw new Error(`Missing Graph edge positions for ${id}`);
      return { from: Number(match[1]), to: Number(match[2]) };
    };
    const firstDependency = edgeRows("dependency:branch-a:end-b");
    const secondDependency = edgeRows("dependency:branch-b:end-a");

    expect(html).toBe(reorderedHtml);
    expect(parent.x).toBeLessThan(branchA.x);
    expect(branchA.y).toBeLessThan(branchB.y);
    expect(endB.y).toBeLessThan(endA.y);
    expect(firstDependency.from).toBeLessThan(secondDependency.from);
    expect(firstDependency.to).toBeLessThan(secondDependency.to);
    expect(unrelated.y).toBeGreaterThan(Math.max(parent.y, branchA.y, branchB.y, endA.y, endB.y) + 140);
  });

  test("renders an empty Graph without board columns", () => {
    const html = renderDashboard({ ...dashboard, view: "graph", graph: { nodes: [], relationships: [] } });

    expect(html).toContain("There are no current workflow items to show.");
    expect(html).not.toContain('class="board board--rows"');
  });

  test("renders a bookmarkable, read-only recent activity feed with safe long content", () => {
    const title = "A realistic issue title that is intentionally long enough to wrap on a phone without widening the document";
    const reason = "A realistic transition reason that remains on one summary line until expanded and has enough detail to make wrapping behaviour observable.";
    const html = renderDashboard({
      ...dashboard,
      view: "recent",
      recent: {
        types: ["done", "stopped"], repositoryIds: ["sample"], rangeStartedAt: "2026-10-14T12:00:00.000Z",
        nextCursor: { occurredAt: "2026-10-15T11:00:00.000Z", id: "transition:older" },
        events: [{
          id: "transition:event-1", occurredAt: "2026-10-15T12:00:00.000Z", type: "stopped", repository: "sample", repositoryColor: 1,
          issueNumber: 72, issueTitle: title, issueUrl: "/issues/sample/72", fromStage: "review", toStage: "implementation", reason,
        }],
      },
    });

    expect(html).toContain('<a href="/recent" class="tab tab--active" aria-current="page">Recent</a>');
    expect(html).toContain('name="type" value="done" checked');
    expect(html).toContain('datetime="2026-10-15T12:00:00.000Z" data-relative-time="true" title="2026-10-15T12:00:00.000Z" aria-label="2026-10-15T12:00:00.000Z" tabindex="0"');
    expect(html).toContain('href="/issues/sample/72"');
    expect(html).toContain('<button class="recent-filter-submit action-button action-button--primary" type="submit">Apply filters</button>');
    expect(html).toContain('<a class="recent-load-more action-button action-button--secondary"');
    expect(html).toContain("review</span><span aria-hidden=\"true\">→</span><span>implementation");
    expect(html).toContain(`<details class="recent-reason"><summary><span>Reason</span><span>${reason}</span></summary>`);
    expect(html).toContain('href="/recent?type=done&amp;type=stopped&amp;repo=sample&amp;beforeAt=2026-10-15T11%3A00%3A00.000Z&amp;beforeId=transition%3Aolder"');
    expect(html).not.toContain('method="post" action="/recent"');
    expect(html).toContain("overflow-wrap:anywhere");
  });

  test("renders clear final and empty-page states for Recent activity", () => {
    const finalPage = renderDashboard({
      ...dashboard,
      view: "recent",
      recent: {
        types: ["done"], repositoryIds: [], rangeStartedAt: null, nextCursor: null,
        events: [{ id: "done:event", occurredAt: "2026-10-15T12:00:00.000Z", type: "done", repository: "sample", repositoryColor: 1, issueNumber: 1, issueTitle: "Done item", issueUrl: "/issues/sample/1", fromStage: null, toStage: null, reason: null }],
      },
    });
    const emptyOlderPage = renderDashboard({
      ...dashboard,
      view: "recent",
      recent: { types: ["done"], repositoryIds: [], rangeStartedAt: null, nextCursor: null, events: [] },
    });

    expect(finalPage).toContain("You've reached the end of the activity feed.");
    expect(emptyOlderPage).toContain("You've reached the end of the activity feed.");
  });

  test("shows a no-split marker on the card and details only while the item carries the label", () => {
    const labelled = renderDashboard({ ...dashboard, selectedIssue: parent, stages: [{ ...dashboard.stages[0]!, issues: [parent] }], backlog: [backlogIssue] });
    const unlabelledIssue = { ...parent, noSplit: false };
    const unlabelled = renderDashboard({ ...dashboard, selectedIssue: unlabelledIssue, stages: [{ ...dashboard.stages[0]!, issues: [unlabelledIssue] }], backlog: [backlogIssue] });

    expect(labelled.match(/No split/g)).toHaveLength(2);
    expect(unlabelled).not.toContain("No split");
  });

  test("renders visible approved and unapproved criterion states", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

    expect(html).toContain('aria-hidden="true">☐</span> Waiting');
    expect(html).toContain('aria-hidden="true">☑☑</span> Approved');
    expect(html).toContain("Keyboard usable");
  });

  test("renders stage board approvals and configured manual gates only for superusers", () => {
    const selectedIssue = {
      ...parent,
      csrfToken: "csrf-token",
      manualGates: [
        { stageId: "implementation", gateId: null, kind: "board", required: true, waiting: true, approvedBy: "admin", approvedAt: "2026-10-14T12:00:00Z" },
        { stageId: "implementation", gateId: "ciGate", kind: "configured", required: true, waiting: false, approvedBy: null, approvedAt: null },
      ],
    } satisfies IssueCardViewModel;
    const base = { ...dashboard, selectedIssue };

    const reader = renderDashboard({ ...base, account: { id: "reader", username: "reader", role: "user", avatar: "🦊" } });
    expect(reader).toContain("Manual gate approvals");
    expect(reader).toContain("implementation");
    expect(reader).toContain("Configured manual requirement");
    expect(reader).toContain("Waiting for board approval");
    expect(reader).toContain("Approved by admin");
    expect(reader).not.toContain("/manual-gates/requirement");

    const superuser = renderDashboard({ ...base, account: { id: "admin", username: "admin", role: "superuser", avatar: "🦊" } });
    expect(superuser).toContain('action="/manual-gates/requirement"');
    expect(superuser).toContain('action="/manual-gates/approve"');
    expect(superuser).toContain('name="csrf" value="csrf-token"');
    // The switch shows the stage board approval and turns it off.
    expect(superuser).toContain('<input type="hidden" name="required" value="false"/><button type="submit" class="manual-gate-switch" role="switch" aria-checked="true">');
    expect(superuser).toContain("Require board approval before leaving implementation");
    const optional = renderDashboard({ ...base, selectedIssue: { ...selectedIssue, manualGates: [{ ...selectedIssue.manualGates[0]!, required: false }] }, account: { id: "admin", username: "admin", role: "superuser", avatar: "🦊" } });
    expect(optional).toContain('<input type="hidden" name="required" value="true"/><button type="submit" class="manual-gate-switch" role="switch" aria-checked="false">');
    expect(superuser).toContain('<button type="submit" class="manual-gate-approve action-button action-button--secondary">Approve</button>');
  });

  test("renders waiting Follow-ups once, escapes every note, and limits Done to superusers", () => {
    const selectedIssue = {
      ...parent,
      csrfToken: "csrf-token",
      manualGates: [{
        stageId: "follow-up", gateId: "followUps", kind: "follow-up", required: true, waiting: true,
        approvedBy: null, approvedAt: null,
        notes: ["Set <script>alert(1)</script> production config.", "Announce the release."],
      }],
    } satisfies IssueCardViewModel;
    const base = { ...dashboard, needsYou: [selectedIssue], selectedIssue };

    const reader = renderDashboard({ ...base, account: { id: "reader", username: "reader", role: "user", avatar: "🦊" } });
    expect(reader.match(/needs-you-item--follow-up/g)).toHaveLength(1);
    expect(reader).toContain('class="needs-you-follow-up" aria-hidden="true">✓</span>');
    expect(reader).toContain("Set &lt;script>alert(1)&lt;/script> production config.");
    expect(reader).toContain("Announce the release.");
    expect(reader).not.toContain("<script>alert(1)</script>");
    expect(reader).not.toContain(">Done</button>");

    const superuser = renderDashboard({ ...base, account: { id: "admin", username: "admin", role: "superuser", avatar: "🦊" } });
    expect(superuser).toContain('action="/manual-gates/approve"');
    expect(superuser).toContain('name="gateId" value="followUps"');
    expect(superuser).toContain('<button type="submit" class="manual-gate-approve action-button action-button--secondary">Done</button>');
  });

  test("labels capacity-held work Queued on its card and details without an obsolete next check", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: queuedIssue, stages: [{ ...dashboard.stages[0]!, issues: [queuedIssue] }] });

    expect(html.match(/>Queued<\/strong>/g)).toHaveLength(3);
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

    expect(html).toContain(`<span class="total-usage header-desktop-control" title="${totalUsage}">${totalUsage}</span>`);
    expect(html).toContain('<a href="/board">Conveyor</a>');
    expect(html).toMatch(/data-connection-state(?:="true")?>Connecting/);
    expect(html).toContain('data-session-sign-in');
    expect(html).toContain('>Sign in again</a>');
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
      selectedIssue: stopped,
      stages: [{ ...dashboard.stages[0]!, issues: [stopped] }],
      backlog: [backlogIssue],
    });
    expect(html.match(/>Retry</g)).toHaveLength(2);
    expect(html).toContain('data-retry-card');
    expect(html).toContain('data-retry-form');
    expect(html).toContain('class="issue-retry action-button action-button--secondary" data-retry-card');
    expect(html).toContain('class="action-button action-button--secondary" data-retry-submit="true">Retry</button>');
    expect(html).toContain('maxlength="4000"');
    expect(html).toContain('role="status" aria-live="polite" data-retry-status');
  });

  test("shows roll-up recovery, rather than stage retry, for a stopped parent", () => {
    const stoppedParent = { ...backlogIssue, id: "stopped-parent", state: "blocked", blocked: true, retryable: false, resumableRollup: true, stoppedRollup: true, children: [] };
    const html = renderDashboard({
      ...dashboard,
      selectedIssue: stoppedParent,
      stages: [{ ...dashboard.stages[0]!, issues: [stoppedParent] }],
      backlog: [backlogIssue],
    });
    expect(html.match(/Resume waiting for children/g)).toHaveLength(2);
    expect(html).toContain('data-resume-rollup-card');
    expect(html).toContain('data-resume-rollup-form');
    expect(html).toContain('Children can keep running while this parent waits.');
    expect(html).not.toContain('data-retry-card');
    expect(html).not.toContain('data-retry-form');
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
          { id: "t0", text: "Old work", status: "skipped" as const, note: "Closed by Conveyor when the item moved on to its next stage." },
        ],
      },
    };
    const html = renderDashboard({ ...dashboard, selectedIssue: working, stages: [{ ...dashboard.stages[0]!, issues: [working] }], backlog: [backlogIssue] });
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
    expect(html.match(/aria-label="Todos"/g)).toHaveLength(1);
  });

  test("shows no card todo progress once nothing is left open, keeping the details checklist", () => {
    for (const stage of ["review", "merge", "done"]) {
      const issue = {
        ...backlogIssue, id: "later", number: 78, stage,
        todos: { finished: 1, skipped: 1, total: 1, current: null, items: [{ id: "t1", text: "Closed", status: "skipped" as const, note: "n" }] },
      };
      const html = renderDashboard({ ...dashboard, selectedIssue: issue, stages: [{ ...dashboard.stages[0]!, issues: [issue] }], backlog: [backlogIssue] });
      expect(html).not.toContain('class="todo-progress"');
      expect(html.match(/aria-label="Todos"/g)).toHaveLength(1);
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
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });
    // A blocking script in <head>, before the stylesheet; a file, since the CSP forbids inline scripts.
    const themeScript = html.indexOf('<script src="/assets/theme.js"></script>');
    const stylesheet = html.indexOf("<style>");

    expect(themeScript).toBeGreaterThan(0);
    expect(themeScript).toBeLessThan(stylesheet);
    expect(themeInitScript).toContain('localStorage.getItem("conveyor-theme")');
    expect(themeInitScript).toContain('document.documentElement.dataset.theme');
    // The line's open or closed choice is restored before the page draws, like the theme.
    expect(themeInitScript).toContain('localStorage.getItem("conveyor-line")');
    expect(themeInitScript).toContain("document.documentElement.dataset.line");
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
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

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

  test("replaces the Board repository strip with filter controls while keeping the repository list", () => {
    const summary = (id: string, health: "healthy" | "degraded", items: DashboardViewModel["repositories"][number]["items"], errorSummary: string | null = null) => ({
      id, address: `owner/${id}`, color: 1, health, error: errorSummary, errorSummary,
      addressUrl: `https://github.com/owner/${id}`, lastReconciledAt: null,
      pause: null,
      backlog: 1, stages: [{ id: "implementation", name: "Implementation", count: 1 }], done: 2, items,
      deliveries: [], skippedReviewItems: [], capacity: { busy: 1, slots: 2 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "webhook" as const, webhooks: "healthy" as const, githubCalls: { total: 0, bySource: [] }, ciProvider: "github-actions", ciMode: "required" as const, systemLabels: ["conveyor"] },
      trust: { visibility: "public" as const, checkedAt: "2026-10-01T00:00:00.000Z", warning: null, permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: ["native review findings", "post-enrollment issue title and body edits", "enrollment labels"] },
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
    const board = renderDashboard({ ...dashboard, repositories, backlog: [{ ...backlogIssue, repository: "active" }] });
    const filters = board.slice(board.indexOf('<section class="board-filters"'), board.indexOf("</section>", board.indexOf('<section class="board-filters"')));

    expect(board).not.toContain('<h2 id="repositories-heading"><a href="/repositories">Repositories</a></h2>');
    expect(board).toContain('data-board-filters');
    expect(board).toContain('name="repo" value="active"');
    expect(filters).not.toContain('href="/repositories/');
    expect(filters).not.toContain("repository-filter-open");
    expect(filters).toContain('class="board-filter-more action-button action-button--secondary"');
    expect(filters).toContain('class="board-filter-submit action-button action-button--secondary">Apply filters</button>');
    expect(board).toContain('name="q"');
    expect(board).toContain('data-filter-state="needs-you"');
    expect(board).toContain('href="/repositories" class="repository-filter-all">Show all</a>');
    expect(board).toContain('name="repo" value="broken"');
    expect(board).not.toContain('name="repo" value="z-idle"');
    expect(board).not.toContain('name="repo" value="alpha-idle"');

    const list = renderDashboard({ ...dashboard, view: "repositories", repositories });
    expect(list).toContain('class="tab tab--active" aria-current="page">Repositories</a>');
    expect(list).toContain('href="/repositories/space%2Fname"');
    expect(list).toContain('owner/space/name');
    expect(list).toContain('Webhook is unavailable');
    expect(list).toContain('1 in progress · 1 needs you');
    expect(list.indexOf('href="/repositories/broken"')).toBeLessThan(list.indexOf('href="/repositories/owner"'));
    expect(list.indexOf('href="/repositories/owner"')).toBeLessThan(list.indexOf('href="/repositories/active"'));
    expect(dashboardCss).toContain('.repository-grid{grid-template-columns:minmax(0,1fr)}');
    expect(dashboardCss).not.toContain("repository-filter-open");
    expect(list).not.toContain('Show all 7');
    expect(renderDashboard({ ...dashboard, view: "repositories", repositories: [] })).toContain("No repositories are configured.");

    const boardWithEncodedRepository = renderDashboard({ ...dashboard, backlog: [{ ...backlogIssue, repository: "space/name" }] });
    expect(boardWithEncodedRepository).toContain('class="repository-badge" href="/repositories/space%2Fname" title="space/name"');
  });

  test("uses each card's pipeline actors in board search data", () => {
    const alpha = { ...backlogIssue, id: "alpha", repository: "alpha", number: 101, title: "Alpha work", searchActors: [{ type: "agent" as const, name: "Alice", title: null }] };
    const beta = { ...backlogIssue, id: "beta", repository: "beta", number: 102, title: "Beta work", searchActors: [{ type: "agent" as const, name: "Beatrice", title: null }] };
    const html = renderDashboard({ ...dashboard, stages: [{ ...dashboard.stages[0]!, actors: [{ type: "agent", name: "Shared", title: null }], issues: [alpha, beta] }] });
    const alphaCard = html.slice(html.indexOf('data-issue-id="alpha"'), html.indexOf('data-issue-id="beta"'));
    const betaCard = html.slice(html.indexOf('data-issue-id="beta"'));

    expect(alphaCard).toContain('data-board-search="alpha work 101 #101 alpha  alice"');
    expect(betaCard).toContain('data-board-search="beta work 102 #102 beta  beatrice"');
  });

  test("renders repository detail sections and redacts restricted setup for non-superusers", () => {
    const repository = {
      id: "space/name", address: "owner/space-name", color: 2, health: "degraded" as const,
      error: "The full reconciliation error", errorSummary: "Reconciliation failed", backlog: 4,
      addressUrl: "https://github.com/owner/space-name", lastReconciledAt: "2026-10-01T00:00:00.000Z",
      pause: null,
      stages: [{ id: "implementation", name: "Implementation", count: 2 }], done: 8,
      items: [{ number: 7, title: "Current item", stage: "implementation", state: "Running" as const }],
      deliveries: [{ number: 6, title: "Delivered item", deliveredAt: "2026-10-01T00:00:00.000Z" }],
      skippedReviewItems: [{ number: 7, title: "Current item", count: 1 }],
      capacity: { busy: 1, slots: 2 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling" as const, webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: "github-actions", ciMode: "required" as const, systemLabels: ["conveyor"] },
      trust: { visibility: "unknown" as const, checkedAt: null, warning: "<img src=x onerror=alert(1)>", permissionThreshold: "write, maintain, or admin", extraTrustedLogins: ["reviewer[bot]", "<unsafe-login>"], ignoredInputCategories: ["native review findings", "post-enrollment issue title and body edits", "enrollment labels"] },
      report30d: { delivered: 8, inputTokens: 120, outputTokens: 30, agentMs: 180_000 },
    };
    const base = { ...dashboard, view: "repository" as const, repositoryId: repository.id, repositories: [repository], restrictedRepositories: [{ id: repository.id, folder: "/sentinel/local-folder", agentEgressHosts: ["sentinel.egress.example"] }] };
    const reader = renderDashboard({ ...base, account: { id: "reader", username: "reader", role: "user", avatar: "🦊" } });
    expect(reader).toContain("The full reconciliation error");
    expect(reader).toContain('href="/issues/space%2Fname/7"');
    expect(reader).toContain('href="/repositories"');
    expect(reader).toContain("‹ Repositories");
    expect(reader).toContain('href="https://github.com/owner/space-name"');
    expect(reader).toContain('data-relative-time="true" title="2026-10-01T00:00:00.000Z" aria-label="2026-10-01T00:00:00.000Z" tabindex="0">recently</time>');
    expect(reader).toContain("Last checked");
    expect(reader).toContain("Slots");
    expect(reader).toContain("1 of 2");
    expect(reader).toContain("<dt>GitHub calls, last hour</dt><dd>0</dd>");
    const webhooks = renderDashboard({ ...base, repositories: [{ ...repository, setup: { ...repository.setup, itemSync: "webhook" as const, webhooks: "unhealthy" as const, githubCalls: { total: 7, bySource: [{ source: "tick", count: 5 }, { source: "webhook", count: 2 }] } } }] });
    expect(webhooks).toContain("github · webhook (deliveries stopped arriving: check the webhook)");
    expect(webhooks).toContain("<dt>GitHub calls, last hour</dt><dd>7 (tick 5, webhook 2)</dd>");
    // Counts, not nine links to the same Board page.
    expect(reader).toContain("<p>4 backlog · 2 Implementation · 8 completed all-time</p>");
    expect(reader).toContain("Completed all-time includes completed roll-up parents; Last 30 days counts deliveries only.");
    expect(reader).toContain('href="/reports/space%2Fname?period=30d"');
    expect(reader).toContain("Full report →");
    for (const heading of ["Line", "Now", "Recently delivered", "Public repository trust", "Setup", "Last 30 days"]) expect(reader).toContain(`<h3>${heading}</h3>`);
    expect(reader).toContain("Repository visibility is uncertain");
    expect(reader).toContain("Default permission threshold");
    expect(reader).toContain("write, maintain, or admin");
    expect(reader).toContain("native review findings");
    expect(reader).toContain("post-enrollment issue title and body edits");
    expect(reader).toContain("enrollment labels");
    expect(reader).toContain("reviewer[bot]");
    expect(reader).toContain("&lt;unsafe-login>");
    expect(reader).toContain("&lt;img src=x onerror=alert(1)>");
    expect(reader).not.toContain('<img src=x onerror=alert(1)>');
    expect(reader).toContain('href="/issues/space%2Fname/7/journey"');
    expect(reader).toContain("Ignored native reviews");
    expect(reader).not.toContain("/sentinel/local-folder");
    expect(reader).not.toContain("sentinel.egress.example");
    const superuser = renderDashboard({ ...base, account: { id: "admin", username: "admin", role: "superuser", avatar: "🦊" } });
    expect(superuser).toContain("/sentinel/local-folder");
    expect(superuser).toContain("sentinel.egress.example");
    // Sync now is one repository's, and only for superusers.
    expect(superuser).toContain('action="/repositories/space%2Fname/sync" data-repository-sync="true"');
    expect(superuser).toContain('<button type="submit" class="action-button action-button--secondary" data-repository-sync-submit="true">Sync now</button>');
    expect(superuser).toContain('<label>Pause reason <input name="reason" maxlength="500"/></label><button type="submit" class="action-button action-button--secondary">Pause repository</button>');
    expect(superuser).toContain('action="/repositories/space%2Fname/pause"');
    expect(superuser).toContain("Pause repository");
    expect(reader).not.toContain("Sync now");
    expect(reader).not.toContain("Pause repository");

    const paused = renderDashboard({ ...base, repositories: [{ ...repository, pause: { actor: "<operator>", pausedAt: "2026-10-01T01:00:00.000Z", reason: "<CI budget>" } }], backlog: [{ ...backlogIssue, repository: repository.id, repositoryPaused: true, working: true }] });
    expect(paused).toContain("Paused</strong> by &lt;operator>");
    expect(paused).toContain("&lt;CI budget>");
    expect(paused).toContain("Resume repository");
    const pausedBoard = renderDashboard({ ...dashboard, repositories: [{ ...repository, pause: { actor: "operator", pausedAt: "2026-10-01T01:00:00.000Z", reason: "CI budget" } }], backlog: [{ ...backlogIssue, repository: repository.id, repositoryPaused: true, working: true }] });
    expect(pausedBoard).toContain("Repository paused");

    const unreconciled = renderDashboard({ ...base, repositories: [{ ...repository, lastReconciledAt: null }] });
    expect(unreconciled).not.toContain("Last checked");

    const idle = renderDashboard({ ...base, repositories: [{ ...repository, capacity: { busy: 0, slots: 2 } }] });
    expect(idle).toContain("<dt>Slots</dt><dd>0 of 2</dd>");

    const publicRepository = renderDashboard({ ...base, repositories: [{ ...repository, trust: { ...repository.trust, visibility: "public", warning: null } }] });
    expect(publicRepository).toContain("GitHub reports this repository is public.");

    const privateRepository = renderDashboard({ ...base, repositories: [{ ...repository, trust: { ...repository.trust, visibility: "private", warning: null } }] });
    expect(privateRepository).toContain("GitHub reports this repository is private; the public-source safeguards are not required.");
    expect(privateRepository).not.toContain("GitHub reports this repository is public.");
    expect(privateRepository).not.toContain("Public repository safeguards are active.");
  });

  test("renders legacy string choices and an actionable error instead of an empty answer form", () => {
    const legacy = renderDashboard({
      ...dashboard,
      questions: [{ ...dashboard.questions[0]!, options: [{ id: "compact", label: "Compact" }, { id: "expanded", label: "Expanded" }], answerError: null }],
    });
    expect(legacy).toContain('type="radio" name="answer" value="compact"');
    expect(legacy).toContain('type="radio" name="answer" value="expanded"');
    expect(legacy).toContain('<button class="answer-button action-button action-button--secondary" type="submit">Answer</button>');

    const valueBacked = renderDashboard({
      ...dashboard,
      questions: [{ ...dashboard.questions[0]!, options: [{ id: "current-main", label: "Current main commit" }], answerError: null }],
    });
    expect(valueBacked).toContain('type="radio" name="answer" value="current-main"');
    expect(valueBacked).toContain("Current main commit");

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
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });
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

    expect(secondary.indexOf('class="dashboard-sticky"')).toBeLessThan(secondary.indexOf('class="system-warnings"'));
    expect(secondary.indexOf('class="tabs"')).toBeLessThan(secondary.indexOf('class="system-warnings"'));
    expect(secondary.indexOf('class="system-warnings"')).toBeLessThan(secondary.indexOf('class="team"'));
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
    expect(empty).toContain('href="/board#needs-you-heading" class="needs-you-link"><i class="andon andon--stop" aria-hidden="true"></i><span><strong>0</strong> need you</span></a>');
    expect(empty).not.toContain('href="/attention"');
    expect(attention).toContain('href="/attention" class="tab tab--active" aria-current="page">Label problems<span class="tab-count">0</span>');
    expect(renderDashboard(dashboard).indexOf('class="tabs"')).toBeLessThan(renderDashboard(dashboard).indexOf('id="line-heading"'));
  });

  test("keeps the dashboard navigation visible and gives an empty Needs you link a target", () => {
    const emptyBoard = renderDashboard({ ...dashboard, questions: [], needsYou: [] });

    expect(emptyBoard).toContain('class="dashboard-sticky"');
    expect(emptyBoard).toContain('id="needs-you-heading">Needs you <span>(0)</span>');
    expect(emptyBoard).toContain('No items need your attention right now.');
    expect(emptyBoard).toContain('aria-label="Connection state: Connecting"');
    expect(dashboardCss).toContain('.dashboard-sticky{position:sticky;top:0;z-index:20;background:var(--concrete)');
    expect(dashboardCss).toContain('#content,#needs-you-heading,[id^="station-"]{scroll-margin-top:calc(var(--dashboard-sticky-height) + .5rem)}');
  });

  test("keeps active-run links in the mobile System popover", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

    expect(html).toContain('<section class="mobile-active-work"><h3>Active work</h3><ul><li><a href="/issues/sample/41"><strong>#41 Build &lt;safe> &amp; sound</strong>');
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
    expect(familyRow).toContain('data-dialog-open="issue-family-172"');
    // Its children are cards in their stations, labelled with the station for phones; its done parts are listed.
    expect(familyRow).toContain('id="family-family-cells"');
    // The page script's trace walks from the parent through its unfinished parts, kept apart from its dependencies.
    expect(familyRow).toContain('data-parts="running-part stopped-part"');
    expect(familyRow).toContain(">Sign in by code</button>");
    expect(familyRow).toContain(">Guest sign-in</button>");
    expect(familyRow).toContain('<span class="issue-stage">Build</span>');
    expect(familyRow).toContain('href="/issues/sample/244" data-filter-card="true" data-board-search="store sign-in data 244 #244 sample" data-board-repository="sample" data-board-state="waiting"');
    expect(familyRow).toContain('<span class="issue-title">Store sign-in data</span><span class="issue-status"><span class="andon andon--run" aria-hidden="true"></span><strong>Done</strong></span>');
    expect(familyRow).not.toContain("family-thread");
    expect(familyRow).not.toContain(">Store sign-in data</button>");
    expect(familyRow.match(/<span class="issue-title">Store sign-in data<\/span>/g)?.length).toBe(1);
    // An empty stage keeps a regular column so its complete heading remains readable.
    const withEmpty = renderDashboard({ ...dashboard });
    expect(withEmpty).toContain('<section class="stage" id="station-stage-review"');
    expect(withEmpty).not.toContain(' 4.5rem ');
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
    // Empty pipeline stages use the same column width as Backlog and Done.
    const empty = renderDashboard({ ...dashboard, backlog: [] });
    expect(empty).toContain('style="--board-columns:min(20rem,86vw) min(20rem,86vw) min(20rem,86vw) min(20rem,86vw);');
    expect(empty).toContain('class="stage" id="station-stage-review"');
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
    expect(card("blocker")).toContain('data-number="245" data-state-word="Blocked" data-filter-card="true"');
    expect(card("moving")).toContain(">Blocks 1</button>");
    expect(html).toContain('<p class="trace-banner" data-trace-banner="true" role="status" hidden>');
  });

  test("renders one horizontal board column per configured stage with card status styling", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

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
    expect(html).toContain('<a class="needs-you-action action-button action-button--secondary" href="/issues/sample/41">Open</a>');
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
    expect(html).toContain('<time datetime="2026-09-29T11:30:00Z" data-relative-time="true" title="2026-09-29T11:30:00Z" aria-label="2026-09-29T11:30:00Z" tabindex="0">recently</time>');
    expect(html).toContain('class="stage" id="station-stage-review"');
    expect(html).not.toContain("stage--empty");
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
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });

    expect(html).toContain("Build &lt;safe> &amp; sound");
    expect(html).toContain("&lt;script>alert(1)&lt;/script>");
    expect(html).toContain("https://github.com/sample/repo/issues/41?x=1&amp;y=2");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("labels token totals as usage rather than cost", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: parent });
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
      selectedIssue: blocked,
      needsYou: [],
      questions: [],
      stages: [{ ...dashboard.stages[0]!, issues: [blocked] }],
    });

    expect(html).toContain(`class="issue-status-context" title="${reason}"`);
    expect(html).toContain(`<section class="blocked-summary" aria-label="Blocking reason"><h3>Blocking reason</h3><p>${reason}</p>`);
    expect(html).toContain(".stage{width:min(20rem,86vw);min-width:min(20rem,86vw);max-width:min(20rem,86vw);flex:0 0 min(20rem,86vw)}");
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
    expect(html).toContain('class="logout action-button action-button--secondary" type="submit">Sign out</button>');
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
    expect(accountsHtml).toContain('<button type="submit" class="action-button action-button--primary">Create account</button>');
    expect(accountsHtml).toContain('<button type="submit" class="action-button action-button--secondary">Reset password</button>');
    expect(accountsHtml).toContain('class="action-button action-button--destructive">Delete account</button>');
    expect(accountsHtml).toContain('class="action-button action-button--secondary" data-account-delete-cancel="true">Cancel</button>');
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
    expect(profileHtml).toContain('<button type="submit" class="action-button action-button--primary">Save</button>');
    expect(profileHtml).toContain('<button type="submit" class="action-button action-button--secondary">Change password</button>');
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
    expect(html).toContain('class="header-link header-desktop-control header-link--active" href="/settings/notifications" aria-current="page"');
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
    expect(html).toContain('class="action-button action-button--primary" disabled>Send to operator</button>');
    expect(html).toContain("Send to operator");
  });

  test("renders a deep-linked issue dialog even when its card is not on the current page", () => {
    const html = renderDashboard({ ...dashboard, selectedIssue: completedIssue });

    expect(html).toContain('data-selected-issue="true"');
    expect(html).toContain('data-issue-id="completed"');
  });

  test("keeps ordinary board cards compact while exposing their details endpoint", () => {
    const html = renderDashboard(dashboard);

    expect(html).toContain('data-details-url="/api/issues/parent/details"');
    expect(html).not.toContain('class="issue-details issue-inspector"');
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

test("renders one accessible marker for each criterion evidence state", () => {
  const html = renderIssueDetails({
    ...parent,
    acceptanceCriteria: [
      {
        id: "AC-1", text: "<criterion>", approved: true, manual: false,
        tests: [
          { name: "renders <safely>", file: "tests/web/render.test.ts", line: 47, description: "Escapes <stored> text", sourceUrl: "https://example.com/owner/repo/blob/verified-head/tests/web/render.test.ts#L47" },
          { name: "uses a file link", file: "tests/web/no-line.test.ts", line: null, description: null, sourceUrl: "https://example.com/owner/repo/blob/recorded-head/tests/web/no-line.test.ts" },
        ],
      },
      { id: "AC-2", text: "No evidence", approved: false, manual: false, tests: [] },
      {
        id: "AC-3", text: "Production validation", approved: true, manual: true,
        tests: [{ name: "manual prerequisite", file: "tests/manual.test.ts", line: null, description: null, sourceUrl: null }],
      },
      { id: "AC-4", text: "Approved without recorded evidence", approved: true, manual: false, tests: [] },
    ],
  });

  expect(html).toContain('<details class="criterion-evidence">');
  expect(html).toContain('class="criterion-state criterion-state--approved" aria-label="Approved"');
  expect(html).toContain('aria-hidden="true">☑☑</span> Approved');
  expect(html).toContain('class="criterion-state criterion-state--waiting" aria-label="Waiting"');
  expect(html).toContain('aria-hidden="true">☐</span> Waiting');
  expect(html).toContain('class="criterion-state criterion-state--manual" aria-label="Manual"');
  expect(html).toContain('aria-hidden="true">◌</span> Manual');
  expect(html).toContain("Marker key: the first check is an implementer-linked test; the second is reviewer approval.");
  expect(html.match(/class="criterion-state /g)?.length).toBe(4);
  expect(html).toContain("2 linked tests");
  expect(html).toContain('href="https://example.com/owner/repo/blob/verified-head/tests/web/render.test.ts#L47"');
  expect(html).toContain('href="https://example.com/owner/repo/blob/recorded-head/tests/web/no-line.test.ts"');
  expect(html).toContain("tests/web/render.test.ts:47");
  expect(html).toContain("tests/web/no-line.test.ts");
  expect(html).toContain("Escapes &lt;stored> text");
  expect(html).toContain("&lt;criterion>");
  expect(html).toContain("renders &lt;safely>");
  expect(html).toContain("No test linked");
  expect(html).toContain("manual");
  expect(html).not.toContain("<criterion>");
  expect(html).not.toContain("<stored>");
});

test("shows tests linked when evidence exists without current-head approval", () => {
  const html = renderIssueDetails({
    ...parent,
    acceptanceCriteria: [{
      id: "AC-1", text: "Evidence is recorded", approved: false, manual: false,
      tests: [{ name: "records evidence", file: "tests/web/render.test.ts", line: 1, description: null, sourceUrl: null }],
    }],
  });

  expect(html).toContain('class="criterion-state criterion-state--tests-linked" aria-label="Tests linked"');
  expect(html).toContain('aria-hidden="true">☑</span> Tests linked');
  expect(html).toContain("records evidence");
  expect(html).toContain("tests/web/render.test.ts:1");
  expect(html).not.toContain('href="null"');
  expect(html).not.toContain('aria-hidden="true">☑☑</span> Approved');
});

test("styles criterion states with theme variables and removes the generic list marker", () => {
  expect(dashboardCss).toContain(".criterion-list>li::before{content:none}");
  expect(dashboardCss).toContain(".criterion-state--waiting,.criterion-state--manual{color:var(--steel)}");
  expect(dashboardCss).toContain(".criterion-state--tests-linked{color:var(--wait-text)}");
  expect(dashboardCss).toContain(".criterion-state--approved{color:var(--run-text)}");
});
