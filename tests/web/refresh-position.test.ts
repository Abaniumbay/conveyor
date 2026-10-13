import { afterEach, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import type { DashboardViewModel, IssueCardViewModel, StageColumnViewModel } from "../../src/web/types";

const password = "correct horse";
let browser: Browser | null = null;

function issue(id: string, number: number, title = id): IssueCardViewModel {
  return {
    id,
    repository: "sample",
    repositoryColor: 1,
    number,
    title,
    url: `https://github.com/sample/repo/issues/${number}`,
    state: "active",
    labels: [],
    issueType: null,
    issueFields: [],
    acceptanceCriteria: [],
    todos: null,
    indicators: [],
    activity: null,
    reason: null,
    cost: null,
    duration: null,
    stateChangedAt: null,
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
}

function stage(id: string, name: string, issues: readonly IssueCardViewModel[]): StageColumnViewModel {
  return { id, name, actors: [], cost: null, totalIssues: issues.length, page: 1, totalPages: 1, issues };
}

function dashboard(
  revision: string,
  middleIssues: readonly IssueCardViewModel[],
  beforeIssues: readonly IssueCardViewModel[] = [issue("before-card", 1)],
): DashboardViewModel {
  const empty = stage("done", "Done", []);
  return {
    title: "Refresh position test",
    project: "sample/repo",
    totalUsage: "0 tokens",
    harnessUsage: [],
    updatedAt: "2026-10-12T12:00:00Z",
    revision,
    view: "board",
    repositoryId: null,
    counts: { board: middleIssues.length, attention: 0 },
    activeWork: { runnerCount: 0, runnerCapacity: 1, runs: [] },
    stages: [
      stage("before", "Before", beforeIssues),
      stage("reader", "Reader", middleIssues),
      stage("after", "After", [issue("after-card", 99)]),
    ],
    backlog: [],
    done: empty,
    attention: stage("attention", "Attention", []),
    questions: [],
    needsYou: [],
    systemWarnings: [],
    repositories: [],
    restrictedRepositories: [],
    steering: { enabled: false, agent: null, selected: null, recent: [] },
    selectedIssue: null,
    csrfToken: "filled-by-handler",
  };
}

function cardPositions(page: Awaited<ReturnType<Browser["newPage"]>>) {
  return page.evaluate(() => {
    const card = document.querySelector('article.issue[data-issue-id="target"]');
    const stage = document.getElementById("station-reader");
    const board = document.querySelector<HTMLElement>(".board");
    return {
      cardTop: card?.getBoundingClientRect().top ?? null,
      stageLeft: stage?.getBoundingClientRect().left ?? null,
      scrollX: board?.scrollLeft ?? 0,
      scrollY: window.scrollY,
      path: location.pathname + location.search + location.hash,
    };
  });
}

async function waitForReplacement(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await page.evaluate(() => document.querySelector("main.dashboard")?.setAttribute("data-before-refresh", "true"));
  await page.waitForFunction(() => !document.querySelector("main.dashboard")?.hasAttribute("data-before-refresh"));
}

afterEach(async () => {
  await browser?.close();
  browser = null;
});

describe("dashboard live refresh position", () => {
  test("keeps a phone reader's card and stage in place, then bounds offsets when the card disappears", async () => {
    const original = Array.from({ length: 8 }, (_, index) => issue(`above-${index}`, index + 2));
    const target = issue("target", 20, "Target card");
    const below = Array.from({ length: 8 }, (_, index) => issue(`below-${index}`, index + 30));
    const offscreenIssues = Array.from({ length: 10 }, (_, index) => issue(`before-${index}`, index + 100));
    let revision = "revision-1";
    let currentDashboard = dashboard(revision, [...original, target, ...below], offscreenIssues);
    const auth = createWebAuth({
      passwordHash: hashPassword(password, { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      secureCookies: false,
    });
    const handler = createWebHandler({
      auth,
      username: "operator",
      getDashboard: () => currentDashboard,
      getDashboardRevision: () => revision,
      getConversationRevision: () => "conversation-1",
      getActivityRevision: () => "activity-1",
      getSystemStatus: () => ({ memory: { usedBytes: 1, totalBytes: 2, processBytes: 1 }, disk: { usedBytes: 1, totalBytes: 2, availableBytes: 1 }, uptimeSeconds: 1 }),
      isReady: () => true,
      webhookPath: "/hooks/custom",
      answerQuestion: () => {},
      reorderBacklog: () => {},
      moveBacklogIssue: () => {},
      handleWebhook: () => ({}),
      handleMcp: () => ({}),
      startSteering: () => "run-1",
      getSteeringRun: () => null,
      getSteeringEvents: () => [],
      getIssueActivity: () => null,
      getIssueRunEvents: () => null,
      getIssueConversation: () => null,
      getIssueJourney: () => null,
      getIssueRoute: () => null,
      postIssueMessage: () => ({}),
      retryIssue: () => ({}),
      dismissFinding: () => {},
      getAgentProfiles: () => [],
      getAgentProfile: () => null,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      await page.goto(`${baseUrl}/login`);
      await page.locator('input[name="username"]').fill("operator");
      await page.locator('input[name="password"]').fill(password);
      await Promise.all([page.waitForURL("**/board"), page.locator('button[type="submit"]').click()]);

      await page.locator('article.issue[data-issue-id="target"]').evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
      const before = await cardPositions(page);
      expect(before.cardTop).not.toBeNull();
      expect(before.stageLeft).not.toBeNull();
      expect(before.scrollX).toBeGreaterThan(0);

      const inserted = Array.from({ length: 5 }, (_, index) => issue(`inserted-${index}`, index + 60));
      currentDashboard = dashboard(
        "revision-2",
        [...original, ...inserted, target, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-2";
      await waitForReplacement(page);
      const afterInsert = await cardPositions(page);
      expect(Math.abs(afterInsert.cardTop! - before.cardTop!)).toBeLessThanOrEqual(24);
      expect(Math.abs(afterInsert.stageLeft! - before.stageLeft!)).toBeLessThanOrEqual(24);
      expect(afterInsert.path).toBe(before.path);

      const priorOffsets = await cardPositions(page);
      currentDashboard = dashboard(
        "revision-3",
        [...original, ...inserted, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-3";
      await waitForReplacement(page);
      const afterRemoval = await page.evaluate(() => {
        const board = document.querySelector<HTMLElement>(".board");
        return {
          scrollX: board?.scrollLeft ?? 0,
          maxScrollX: board ? board.scrollWidth - board.clientWidth : 0,
          scrollY: window.scrollY,
          maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
        };
      });
      expect(afterRemoval.scrollY).toBeGreaterThan(0);
      expect(afterRemoval.scrollX).toBeGreaterThan(0);
      expect(afterRemoval.scrollY).toBeLessThanOrEqual(Math.max(0, afterRemoval.maxScrollY));
      expect(afterRemoval.scrollX).toBeLessThanOrEqual(Math.max(0, afterRemoval.maxScrollX));
      expect(Math.abs(afterRemoval.scrollY - Math.min(priorOffsets.scrollY, Math.max(0, afterRemoval.maxScrollY)))).toBeLessThanOrEqual(24);
      expect(Math.abs(afterRemoval.scrollX - Math.min(priorOffsets.scrollX, Math.max(0, afterRemoval.maxScrollX)))).toBeLessThanOrEqual(24);

      await page.locator('article.issue[data-issue-id="above-0"] .card-open').click();
      expect(await page.locator("dialog[open]").count()).toBe(1);
      await page.evaluate(() => document.querySelector("main.dashboard")?.setAttribute("data-before-refresh", "true"));
      currentDashboard = dashboard(
        "revision-4",
        [...inserted, ...original, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-4";
      await page.waitForFunction(() => document.body.dataset.dashboardRevision === "revision-4");
      await page.waitForTimeout(1100);
      expect(await page.locator("main.dashboard").getAttribute("data-before-refresh")).toBe("true");
      expect(await page.locator("dialog[open]").count()).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
