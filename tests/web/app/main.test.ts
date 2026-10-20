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
    parent: null, children: [], dependencies: [], working: false, needsAttention: false, retryable: false,
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

function startApp() {
  const state = { title: "Before" };
  const feed = new DashboardFeed({ build: () => normalizeDashboard(board(state.title)), settleMs: 5, maxWaitMs: 20 });
  const auth = createWebAuth({
    passwordHash: hashPassword(password, { salt: "0123456789abcdef" }),
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
  });
  const { commands } = fakeCommandBus({
    answerQuestion: () => {}, approveManualGate: () => {}, setBoardApprovalRequirement: () => {}, reorderBacklog: () => {},
    moveBacklogIssue: () => {}, startSteering: () => "run-1", postIssueMessage: () => ({}), retryIssue: () => ({}), dismissFinding: () => {},
  });
  const handler = createWebHandler({
    auth,
    username: "operator",
    getDashboard: () => board(state.title),
    getSystemStatus: () => ({
      memory: { usedBytes: 1, totalBytes: 2, processBytes: 1 },
      disk: { available: true, usedBytes: 1, totalBytes: 2, availableBytes: 1 },
      storage: { artifacts: { available: true, usedBytes: 1, totalBytes: 2, availableBytes: 1 }, temporaryDirectory: { available: false }, workspaceScratch: { available: false } },
      uptimeSeconds: 1,
    }),
    getDashboardSnapshot: () => feed.snapshot(),
    subscribeDashboardFeed: (listener, after) => feed.subscribe(listener, after),
    getDashboardFeedStatus: () => feed.status,
    getRecentActivity: () => ({
      types: ["done"], repositoryIds: [], nextCursor: null, rangeStartedAt: "2026-10-19T12:00:00Z",
      events: [{ id: "e1", occurredAt: "2026-10-20T11:00:00Z", type: "done", repository: "sample", repositoryColor: 1, issueNumber: 19, issueTitle: "Shipped thing", issueUrl: "/issues/sample/19", fromStage: "review", toStage: null, reason: null }],
    }),
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
    getIssueJourney: () => null,
    getIssueRoute: () => null,
    getAgentProfiles: () => [],
    getAgentProfile: () => null,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return {
    url: `http://127.0.0.1:${server.port}`,
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
  await page.goto(`${url}/login?returnTo=${encodeURIComponent("/app")}`);
  await page.locator('input[name="username"]').fill("operator");
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForURL("**/app"), page.locator('button[type="submit"]').click()]);
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
      expect(new URL(page.url()).pathname).toBe("/app/issues/sample/20");
      await page.keyboard.press("Escape");
      // The dialog closes first; its close event then moves the address back to the board.
      await page.waitForURL((url) => url.pathname === "/app");
      expect(await page.locator("dialog[open]").count()).toBe(0);
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
      expect(new URL(page.url()).pathname).toBe("/app/graph");
      expect(await page.locator("[data-graph-node]").count()).toBe(2);

      await page.locator(".tabs a", { hasText: "Recent" }).click();
      await page.locator(".recent-feed, main", { hasText: "Shipped thing" }).first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/recent");

      await page.locator(".tabs a", { hasText: "Repositories" }).click();
      await page.locator("main", { hasText: "owner/sample" }).first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/repositories");

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
      await page.goto(`${app.url}/app/graph`);
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

  test("fits a phone screen without horizontal scrolling", async () => {
    const app = startApp();
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true });
      await signIn(page, app.url);
      for (const path of ["/app", "/app/graph", "/app/recent", "/app/attention", "/app/repositories", "/app/repositories/sample"]) {
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
