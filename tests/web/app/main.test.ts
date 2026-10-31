import { afterEach, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

import { DashboardFeed } from "../../../src/app/dashboard-feed";
import { createWebAuth, hashPassword } from "../../../src/web/auth";
import { normalizeDashboard } from "../../../src/web/model";
import { createWebHandler } from "../../../src/web/server";
import type { DashboardViewModel, IssueCardViewModel } from "../../../src/web/types";
import { fakeCommandBus } from "../../support/web-commands";

const password = "correct horse";
let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

function issue(number: number, title: string, overrides: Partial<IssueCardViewModel> = {}): IssueCardViewModel {
  return {
    id: `github:sample/repo#${number}`, repository: "sample", repositoryPaused: false, repositoryColor: 1, number, title,
    url: `https://github.com/sample/repo/issues/${number}`, state: "active", labels: [], issueType: null, issueFields: [],
    acceptanceCriteria: [], todos: null, indicators: [], activity: null, reason: null, cost: null, duration: null,
    stateChangedAt: null, waiting: null, blocked: false, inconsistent: false, closable: false, noSplit: false, tone: "active",
    parent: null, children: [], dependencies: [], working: false, needsAttention: false, retryable: false, resumable: false,
    resumableRollup: false, stoppedRollup: false, stage: "implementation",
    ...overrides,
  };
}

function board(title: string): DashboardViewModel {
  const column = (id: string, name: string, issues: IssueCardViewModel[]) => ({ id, name, actors: [], cost: null, totalIssues: issues.length, page: 1, totalPages: 1, issues });
  return {
    title: "Conveyor", project: "1 repositories", totalUsage: "0 runs", harnessUsage: [], draining: null,
    updatedAt: "2026-10-20T12:00:00Z", revision: "", view: "board", repositoryId: null,
    graph: {
      nodes: [
        { id: "github:sample/repo#20", repository: "sample", repositoryColor: 1, number: 20, title, state: "Active", stage: "Implementation", stageId: "implementation", context: false, signal: null },
        { id: "github:sample/repo#21", repository: "sample", repositoryColor: 1, number: 21, title: "Second item", state: "Active", stage: "Review", stageId: "review", context: false, signal: null },
      ],
      relationships: [{ kind: "dependency", from: "github:sample/repo#21", to: "github:sample/repo#20", status: "outstanding" }],
    },
    counts: { board: 2, attention: 0 },
    activeWork: { runnerCount: 0, runnerCapacity: 2, runs: [] },
    stages: [
      { ...column("stage:implementation", "Implementation", [issue(20, title)]), description: null, icon: "🛠️" },
      { ...column("stage:review", "Review", [issue(21, "Second item", { stage: "review" })]), description: null, icon: "🔍" },
    ],
    backlog: [], done: column("done", "Done", []), attention: column("attention", "Label problems", []),
    questions: [], needsYou: [], systemWarnings: [], repositories: [{
      id: "sample", address: "owner/sample", addressUrl: null, color: 1, health: "healthy", error: null, errorSummary: null, lastReconciledAt: null, pause: null,
      backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling", webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled", systemLabels: [] },
      trust: { visibility: "unknown", checkedAt: null, warning: null, permissionThreshold: "write", extraTrustedLogins: [], ignoredInputCategories: [] },
      report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
    }], restrictedRepositories: [],
    steering: { enabled: false, agent: null, selected: null, recent: [] }, selectedIssue: null, csrfToken: "",
  };
}

const omid = {
  id: "omid", name: "Omid", title: "Operator", harness: "codex", model: null, effort: null, access: "read-only",
  usage: [{ pipeline: null, stage: null, role: "steering" }], tasks: [], instructions: "Watch the board.",
};

const reportTotals = {
  delivered: 3, inProgress: 1, runs: 9, failedRuns: 1, inputTokens: 1000, outputTokens: 200, cachedTokens: 0, agentMs: 60_000,
  avgTokensPerItem: 400, avgRunsPerItem: 3, avgLeadMs: 3_600_000, avgAgentMs: 20_000, avgChecksWaitMs: 0, avgWaitingForYouMs: 0,
  avgQueuedMs: 0, avgReturnsPerItem: 0, avgStopsPerItem: 0, firstPassRate: 1,
};

function startApp(options: { role?: "user" | "superuser" } = {}) {
  const role = options.role ?? "superuser";
  const state = { title: "Before" };
  const reclassified: unknown[][] = [];
  const dismissed: unknown[][] = [];
  const findings: Array<{ id: string; type: string; state: string; author: string; location: string | null; url: string; summary: string; dismissal?: { actor: string; reason: string } }> = ["open", "resolved", "dismissed", "withdrawn"].map((findingState) => ({
    id: `finding-${findingState}`, type: "general", state: findingState, author: "reviewer", location: null, url: "https://example.com/reviews/1", summary: `A ${findingState} finding`,
    ...(findingState === "dismissed" ? { dismissal: { actor: "human:amir", reason: "Known risk" } } : {}),
  }));
  const passwordHash = hashPassword(password, { salt: "0123456789abcdef" });
  const account = { id: "operator", username: "operator", role, avatar: "🐼", sessionVersion: 1 };
  const feed = new DashboardFeed({ build: () => normalizeDashboard(board(state.title)), settleMs: 5, maxWaitMs: 20 });
  const auth = createWebAuth({
    passwordHash: role === "superuser" ? passwordHash : undefined,
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
    ...(role === "superuser" ? {} : {
      accountById: (id: string) => id === account.id ? account : null,
      accountByUsername: (username: string) => username === account.username ? { ...account, passwordHash } : null,
    }),
  });
  const { commands } = fakeCommandBus({
    answerQuestion: () => {}, approveManualGate: () => {}, setBoardApprovalRequirement: () => {}, reorderBacklog: () => {},
    moveBacklogIssue: () => {}, startSteering: () => "run-1", postIssueMessage: () => ({}), retryIssue: () => ({}),
    dismissFinding: (...args: unknown[]) => {
      dismissed.push(args);
      const finding = findings.find((candidate) => candidate.id === args[1])!;
      finding.state = "dismissed";
      finding.dismissal = { actor: `human:${String(args[3])}`, reason: String(args[2]) };
    },
    reclassifyFinding: (...args: unknown[]) => { reclassified.push(args); return { changed: true }; },
  });
  const reportFindings = {
    total: 5, reviewRounds: 9,
    byType: [{ type: "criterion-not-met", findings: 3, rounds: 2, share: 2 / 9 }, { type: "test-not-discriminating", findings: 2, rounds: 2, share: 2 / 9 }, { type: "general", findings: 0, rounds: 0, share: 0 }],
    byRepository: [{ key: "a-repository-with-a-very-long-identifier-name", count: 5 }],
    byAuthor: [{ key: "codex-reviewer[bot]-with-a-long-author-name", count: 5 }],
    byWeek: [{ key: "2026-W43", count: 5 }],
  };
  const handler = createWebHandler({
    auth,
    username: "operator",
    getDashboardSnapshot: () => feed.snapshot(),
    subscribeDashboardFeed: (listener, after) => feed.subscribe(listener, after),
    getDashboardFeedStatus: () => feed.status,
    getRecentActivity: () => ({
      types: ["done"], repositoryIds: [], nextCursor: null, rangeStartedAt: "2026-10-19T12:00:00Z",
      events: [{ id: "e1", occurredAt: "2026-10-20T11:00:00Z", type: "done", repository: "sample", repositoryColor: 1, issueNumber: 19, issueTitle: "Shipped thing", issueUrl: "/issues/sample/19", fromStage: "review", toStage: null, reason: null }],
    }),
    getSteeringView: () => ({ enabled: true, agent: "omid", selected: { id: "run-1", status: "succeeded", startedAt: "2026-10-20T10:00:00Z", finishedAt: "2026-10-20T10:01:00Z", events: [{ sequence: 1, type: "report", text: "Board checked.", createdAt: "2026-10-20T10:01:00Z" }] }, recent: [{ id: "run-1", status: "succeeded", startedAt: "2026-10-20T10:00:00Z" }] }),
    getReport: ({ period, repository }) => ({ period, since: null, repository, repositories: ["sample"], totals: reportTotals, byRepository: [], byMonth: [], byStage: [], items: [], findings: reportFindings, importedWithoutHistory: 0, generatedAt: "2026-10-20T12:00:00Z" }),
    listAccounts: () => [{ id: "operator", username: "operator", role: "superuser", avatar: "🐼" }],
    getPushPreferences: () => ({ questions: true, stopped: false, done: false }),
    isReady: () => true,
    webhookPath: "/hooks/custom",
    dispatch: (name, input, actor) => commands.dispatch(name, input, actor),
    handleWebhook: () => ({}),
    handleMcp: () => ({}),
    getSteeringRun: () => null,
    getSteeringEvents: () => [],
    getIssueActivity: () => null,
    getIssueRunEvents: () => null,
    getIssueConversation: () => null,
    getIssueJourney: (issueId) => issueId === "github:sample/repo#20"
      ? { issueId, now: { stage: "implementation", state: "active", reason: null, since: null }, transitions: [], skippedReviews: [], findings: [{
        id: "finding-1", type: "test-not-discriminating", state: "open", author: "a-reviewer-with-a-rather-long-login", location: "src/web/app/a/very/long/path/to/a/file-with-a-long-name.tsx:120",
        url: "https://example.com/reviews/1", summary: "A_very_long_unbroken_review_summary_that_must_wrap_instead_of_widening_the_page_".repeat(3),
      }, ...findings] }
      : null,
    getIssueRoute: (reference) => "repository" in reference && reference.repository === "sample" && reference.number === 7 ? { id: "github:sample/repo#7", repository: "sample", number: 7 } : null,
    getIssueDetails: (issueId) => issueId === "github:sample/repo#7" ? { ...issue(7, "Finished long ago", { state: "done", tone: "success" }), csrfToken: "" } : null,
    getAgentProfiles: () => [omid],
    getAgentProfile: () => omid,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return {
    url: `http://127.0.0.1:${server.port}`,
    reclassified,
    dismissed,
    rename(title: string) {
      state.title = title;
      feed.invalidate();
    },
    stop() {
      feed.close();
      server.stop(true);
    },
  };
}

async function signIn(page: Page, url: string) {
  await page.goto(`${url}/login?returnTo=${encodeURIComponent("/")}`);
  await page.locator('input[name="username"]').fill("operator");
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForURL((url) => url.pathname === "/"), page.locator('button[type="submit"]').click()]);
  await page.locator(".issue-title", { hasText: "Before" }).waitFor();
}

describe("dashboard application", () => {
  test("draws a change from its patch without requesting anything", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.waitForFunction(() => document.querySelector("[data-connection-state]")?.textContent === "Connected");
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      app.rename("After");

      await page.locator(".issue-title", { hasText: "After" }).waitFor();
      expect(requests).toEqual([]);
      expect(await page.locator("[data-app-skeleton]").count()).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("opens an item's details at its own address and closes back to the board", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);

      await page.locator(".issue-title", { hasText: "Before" }).click();

      await page.locator("dialog[open] .details-header h2", { hasText: "Before" }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/issues/sample/20");
      await page.keyboard.press("Escape");
      // The dialog closes first; its close event then moves the address back to the board.
      await page.waitForURL((url) => url.pathname === "/");
      expect(await page.locator("dialog[open]").count()).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("names the open item in the title and returns to the view's name when it closes", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      expect(await page.title()).toBe("Board · Conveyor");

      await page.locator(".issue-title", { hasText: "Before" }).click();
      await page.locator("dialog[open]").waitFor();
      expect(await page.title()).toBe("#20 Before · Conveyor");
      await page.keyboard.press("Escape");
      // The board redraws on the next frame after the address changes.
      await page.waitForFunction(() => document.title === "Board · Conveyor");
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("opens an older item address on the tab it names", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);

      await page.goto(`${app.url}/issues/sample/20/journey`);

      await page.locator("dialog[open] .details-header h2", { hasText: "Before" }).waitFor();
      expect(await page.locator("dialog[open] [role='tab'][aria-selected='true']").textContent()).toBe("Journey");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("shows a finding's type and lets a superuser change it at 360 px without sideways scrolling", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true });
      await signIn(page, app.url);

      await page.goto(`${app.url}/issues/sample/20/journey`);

      const finding = page.locator("dialog[open] [data-finding-id='finding-1']");
      await finding.waitFor();
      expect(await finding.locator("[data-finding-type]").textContent()).toBe("Test Not Discriminating");
      const select = finding.locator("select[name='type']");
      const button = finding.getByRole("button", { name: "Change type" });
      expect(await select.isVisible() && await button.isVisible()).toBe(true);
      const overflow = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll("dialog[open], dialog[open] *")]
        .some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible" && element.getBoundingClientRect().right > window.innerWidth + 1));
      expect(overflow).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const box = await button.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);

      await select.selectOption("security");
      await button.click();
      await page.waitForFunction(() => document.querySelector("[data-finding-id='finding-1'] [data-finding-type]")?.textContent === "Security");
      expect(app.reclassified).toEqual([["github:sample/repo#20", "finding-1", "security", "operator"]]);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("a superuser dismisses only open findings, with a bounded required reason, and sees the result live", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.goto(`${app.url}/issues/sample/20/journey`);
      const open = page.locator("dialog[open] [data-finding-id='finding-open']");
      await open.waitFor();
      expect(await open.getByRole("button", { name: "Dismiss", exact: true }).count()).toBe(1);
      for (const state of ["resolved", "dismissed", "withdrawn"]) {
        expect(await page.locator(`dialog[open] [data-finding-id='finding-${state}'] [data-finding-dismiss]`).count()).toBe(0);
      }
      const reason = open.locator("textarea[name='reason']");
      const button = open.getByRole("button", { name: "Dismiss", exact: true });
      expect(await reason.getAttribute("maxlength")).toBe("2000");
      expect(await button.isDisabled()).toBe(true);
      await reason.fill("   ");
      expect(await button.isDisabled()).toBe(true);
      await reason.evaluate((element) => { (element as HTMLTextAreaElement).value = "x".repeat(2001); element.dispatchEvent(new Event("input", { bubbles: true })); });
      await open.locator("[data-finding-dismiss]").evaluate((form) => (form as HTMLFormElement).requestSubmit());
      await page.waitForTimeout(200);
      expect(app.dismissed).toEqual([]);
      const requests: Array<{ url: string; csrf: string | undefined; body: string | null }> = [];
      page.on("request", (request) => { if (request.method() === "POST") requests.push({ url: request.url(), csrf: request.headers()["x-csrf-token"], body: request.postData() }); });
      await reason.fill("Accepted as a known risk");
      await button.click();
      await page.locator("dialog[open] [data-finding-id='finding-open'] [data-finding-dismissal]").waitFor();
      expect(await page.locator("dialog[open] [data-finding-id='finding-open'] [data-finding-dismissal]").textContent()).toContain("Accepted as a known risk");
      expect(app.dismissed).toEqual([["github:sample/repo#20", "finding-open", "Accepted as a known risk", "operator"]]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`${app.url}/api/issues/github%3Asample%2Frepo%2320/findings/finding-open/dismiss`);
      expect(JSON.parse(requests[0]!.body!)).toEqual({ reason: "Accepted as a known risk" });
      expect(requests[0]!.csrf).toBeTruthy();
      expect(await open.locator("[data-finding-dismiss]").count()).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("a non-superuser sees no Dismiss action on an open finding", async () => {
    const app = startApp({ role: "user" });
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.goto(`${app.url}/issues/sample/20/journey`);
      await page.locator("dialog[open] [data-finding-id='finding-open']").waitFor();
      expect(await page.getByRole("button", { name: "Dismiss", exact: true }).count()).toBe(0);
      expect(await page.locator("[data-finding-dismiss]").count()).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("opens an item the board no longer holds from its own address", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);

      await page.goto(`${app.url}/issues/sample/7`);

      await page.locator("dialog[open] .details-header h2", { hasText: "Finished long ago" }).waitFor();
      expect(await page.locator(".issue-title", { hasText: "Finished long ago" }).count()).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("an idle dashboard sends no requests", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.waitForFunction(() => document.querySelector("[data-connection-state]")?.textContent === "Connected");
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      // Longer than the heartbeat and the stream check, so both have run.
      await page.waitForTimeout(6_000);

      expect(requests).toEqual([]);
      expect(await page.locator("[data-connection-state]").textContent()).toBe("Connected");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("sends a message from an open item's conversation", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.locator(".issue-title", { hasText: "Before" }).click();
      await page.locator("dialog[open] [data-detail-tab='conversation']").click();

      await page.locator("dialog[open] textarea[name='message']").fill("Use the existing helper.");
      const [response] = await Promise.all([
        page.waitForResponse((candidate) => candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/issues/github%3Asample%2Frepo%2320/conversation"),
        page.locator("dialog[open] .conversation-compose button[type='submit']").click(),
      ]);

      expect(response.status()).toBe(201);
      expect(new URLSearchParams(response.request().postData() ?? "").get("message")).toBe("Use the existing helper.");
      expect(await page.locator("dialog[open] textarea[name='message']").inputValue()).toBe("");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("keeps a stage's information open while a change is drawn", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await signIn(page, app.url);
      await page.getByRole("button", { name: "About Implementation" }).first().click();
      await page.waitForFunction(() => document.querySelector("#stage-info-stage-implementation")?.hasAttribute("open"));

      app.rename("After");

      await page.locator(".issue-title", { hasText: "After" }).waitFor();
      expect(await page.locator("#stage-info-stage-implementation").getAttribute("open")).not.toBeNull();
    } finally {
      app.stop();
    }
  }, 30_000);

  test("moves between its views without loading another page", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.evaluate(() => { Reflect.set(window, "stayed", true); });

      await page.locator(".tabs a", { hasText: "Graph" }).click();
      await page.locator("[data-graph-node]").first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/graph");
      expect(await page.locator("[data-graph-node]").count()).toBe(2);

      await page.locator(".tabs a", { hasText: "Recent" }).click();
      await page.locator(".recent-feed, main", { hasText: "Shipped thing" }).first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/recent");

      await page.locator(".tabs a", { hasText: "Repositories" }).click();
      await page.locator("main", { hasText: "owner/sample" }).first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/repositories");

      expect(await page.evaluate(() => Reflect.get(window, "stayed"))).toBe(true);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("filters the Graph by stage and shows related items as context", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.goto(`${app.url}/graph`);
      await page.locator("[data-graph-node]").first().waitFor();
      await page.locator("select[name='stage']").selectOption("review");
      await page.locator(".graph-view button[type='submit']").click();
      await page.waitForURL((url) => url.search === "?stage=review");
      await page.locator(".graph-node--context").waitFor();
      expect(await page.locator(".graph-node--context").count()).toBe(1);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("opens a team member's profile at its own address and closes back to Team", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.locator(".tabs a", { hasText: "Team" }).click();
      await page.locator(".team-card .card-open", { hasText: "Omid" }).click();
      await page.locator("dialog[open][data-agent-id='omid']").waitFor();
      expect(new URL(page.url()).pathname).toBe("/team/omid");
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => url.pathname === "/team");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("shows Reports and the Operator from their own data", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await signIn(page, app.url);
      await page.locator(".tabs a", { hasText: "Reports" }).click();
      await page.locator("main", { hasText: "sample" }).first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/reports");
      await page.locator(".tabs a", { hasText: "Operator" }).click();
      await page.locator(".agent-event", { hasText: "Board checked." }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/operator");
    } finally {
      app.stop();
    }
  }, 30_000);

  test("shows the finding report readably at 360 px without sideways page scrolling", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true });
      await signIn(page, app.url);
      await page.goto(`${app.url}/reports`);
      const section = page.locator('section[aria-labelledby="report-findings"]');
      await section.waitFor();
      await section.scrollIntoViewIfNeeded();
      expect(await section.getByText("criterion-not-met").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const box = await section.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      const overflowing = await page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="report-findings"] *')]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 && !element.closest(".report-table-wrap")).length);
      expect(overflowing).toBe(0);
    } finally {
      app.stop();
    }
  }, 30_000);

  test("fits a phone screen without horizontal scrolling", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true });
      await signIn(page, app.url);
      for (const path of ["/", "/graph", "/recent", "/attention", "/repositories", "/repositories/sample", "/team", "/reports", "/operator", "/accounts", "/profile", "/settings/notifications", "/about"]) {
        await page.goto(`${app.url}${path}`);
        await page.locator("main.dashboard").waitFor();
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect({ path, overflow }).toEqual({ path, overflow: 0 });
      }
    } finally {
      app.stop();
    }
  }, 30_000);
});
