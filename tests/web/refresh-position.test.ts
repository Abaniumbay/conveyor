import { afterEach, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import type { DashboardPageSelection, DashboardStreamEvent, DashboardViewModel, IssueCardViewModel, RecentActivityType, StageColumnViewModel, SystemStatusViewModel } from "../../src/web/types";
import { fakeCommandBus } from "../support/web-commands";

const password = "correct horse";
let browser: Browser | null = null;

function issue(id: string, number: number, title = id): IssueCardViewModel {
  return {
    id,
    repository: "sample",
    repositoryPaused: false,
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
}

function repository(id: string, color: number): DashboardViewModel["repositories"][number] {
  return {
    id, address: `owner/${id}`, addressUrl: null, color, health: "healthy", error: null, errorSummary: null, lastReconciledAt: null, pause: null,
    backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
    setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling", webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled", systemLabels: [] },
    trust: { visibility: "unknown", checkedAt: null, warning: null, permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: [] },
    report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
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
    graph: { nodes: [], relationships: [] },
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

function recentDashboard(selection: DashboardPageSelection): DashboardViewModel {
  const types: readonly RecentActivityType[] = selection.recentTypes?.length
    ? selection.recentTypes
    : ["done", "stopped", "sent-back", "moved-forward", "new", "resumed"];
  const repositoryIds = selection.repositoryIds ?? [];
  const hasOlderPage = selection.recentCursor !== null && selection.recentCursor !== undefined;
  const title = "A realistic issue title that is deliberately long enough to prove that the Recent page stays inside a phone viewport without horizontal scrolling";
  const reason = "A realistic transition reason with enough operational detail to stay on one collapsed summary line before the reader expands it in place on their phone.";
  return {
    ...dashboard("recent-1", []),
    view: "recent",
    repositories: [{
      id: "sample", address: "owner/sample", addressUrl: "https://github.com/owner/sample", color: 1,
      health: "healthy", error: null, errorSummary: null, lastReconciledAt: null, backlog: 0,
      stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling", webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled", systemLabels: [] },
      trust: { visibility: "unknown", checkedAt: null, warning: "Repository visibility has not yet been checked.", permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: ["native review findings", "post-enrollment issue title and body edits", "enrollment labels"] },
      report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
    }],
    recent: {
      types,
      repositoryIds,
      rangeStartedAt: hasOlderPage ? null : "2026-10-14T12:00:00.000Z",
      nextCursor: hasOlderPage ? null : { occurredAt: "2026-10-15T11:00:00.000Z", id: "transition:older" },
      events: repositoryIds.length > 0 && !repositoryIds.includes("sample") ? [] : [{
        id: hasOlderPage ? "transition:older" : "transition:newer", occurredAt: "2026-10-15T12:00:00.000Z", type: "stopped",
        repository: "sample", repositoryColor: 1, issueNumber: 72, issueTitle: title, issueUrl: "/issues/sample/72",
        fromStage: "review", toStage: "implementation", reason,
      }],
    },
  };
}

function dashboardIssue(model: DashboardViewModel, id: string): IssueCardViewModel | null {
  const cards = [
    ...model.stages.flatMap((column) => column.issues),
    ...model.backlog,
    ...model.done.issues,
    ...model.attention.issues,
    ...model.needsYou,
  ];
  return cards.find((card) => card.id === id) ?? null;
}

function cardPositions(page: Awaited<ReturnType<Browser["newPage"]>>) {
  return page.evaluate(() => {
    const card = document.querySelector('article.issue[data-issue-id="target"]');
    const stage = document.querySelector('[data-station-cell="reader"]');
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

async function armReplacement(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await page.evaluate(() => document.querySelector("main.dashboard")?.setAttribute("data-before-refresh", "true"));
}

async function waitForArmedReplacement(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  changedCard?: { id: string; present: boolean },
) {
  await page.waitForFunction((expected) => {
    const replaced = !document.querySelector("main.dashboard")?.hasAttribute("data-before-refresh");
    if (!replaced || !expected) return replaced;
    return (document.querySelector(`article.issue[data-issue-id="${expected.id}"]`) !== null) === expected.present;
  }, changedCard);
}

async function waitForReplacement(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await armReplacement(page);
  await waitForArmedReplacement(page);
}

/** A dashboard server whose page, revision and response delay the test controls. */
function startDashboard(state: {
  dashboard: (selection: DashboardPageSelection) => DashboardViewModel | Promise<DashboardViewModel>;
  revision: () => string;
  delayMs: () => number;
  detailsDelayMs?: (issueId: string) => number;
  answerQuestion?: () => Promise<void>;
  approveManualGate?: () => Promise<void>;
  setBoardApprovalRequirement?: (required: boolean) => void;
  systemStatus?: () => SystemStatusViewModel;
}) {
  const auth = createWebAuth({
    passwordHash: hashPassword(password, { salt: "0123456789abcdef" }),
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
  });
  // The test changes `revision` to simulate a change; like the core, publish an event for it.
  const listeners = new Set<(event: DashboardStreamEvent) => void>();
  let published = state.revision();
  let seq = 0;
  const watcher = setInterval(() => {
    const current = state.revision();
    if (current === published) return;
    published = current;
    seq += 1;
    for (const listener of listeners) listener({ seq, type: "item.updated", repositoryId: "repo", issueId: null, correlationId: null });
  }, 50);
  const { commands } = fakeCommandBus({
    answerQuestion: () => state.answerQuestion?.(), approveManualGate: () => state.approveManualGate?.(),
    setBoardApprovalRequirement: (_issueId: string, _stageId: string, required: boolean) => state.setBoardApprovalRequirement?.(required), reorderBacklog: () => {}, moveBacklogIssue: () => {}, startSteering: () => "run-1",
    postIssueMessage: () => ({}), retryIssue: () => ({}), dismissFinding: () => {},
  });
  const handler = createWebHandler({
    auth,
    username: "operator",
    getDashboard: async (csrfToken, selection) => {
      if (state.delayMs() > 0) await Bun.sleep(state.delayMs());
      const model = await state.dashboard(selection);
      return {
        ...model,
        selectedIssue: selection.issueId ? dashboardIssue(model, selection.issueId) : model.selectedIssue,
        csrfToken,
      };
    },
    getIssueDetails: async (_csrfToken, issueId) => {
      const detailsDelayMs = state.detailsDelayMs?.(issueId) ?? 0;
      if (detailsDelayMs > 0) await Bun.sleep(detailsDelayMs);
      const model = await state.dashboard({ view: "board", column: null, page: 1, doneLimit: 100, runId: null, issueId: null });
      return dashboardIssue(model, issueId);
    },
    subscribeEvents: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSystemStatus: () => state.systemStatus?.() ?? ({
      memory: { usedBytes: 1, totalBytes: 2, processBytes: 1 },
      disk: { available: true, usedBytes: 1, totalBytes: 2, availableBytes: 1 },
      storage: { artifacts: { available: true, usedBytes: 1, totalBytes: 2, availableBytes: 1 }, temporaryDirectory: { available: false }, workspaceScratch: { available: false } },
      uptimeSeconds: 1,
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
    getIssueRoute: async (reference) => {
      const model = await state.dashboard({ view: "board", column: null, page: 1, doneLimit: 100, runId: null, issueId: null });
      const cards = [
        ...model.stages.flatMap((column) => column.issues),
        ...model.backlog,
        ...model.done.issues,
        ...model.attention.issues,
        ...model.needsYou,
      ];
      const card = "id" in reference
        ? cards.find((candidate) => candidate.id === reference.id)
        : cards.find((candidate) => candidate.repository === reference.repository && candidate.number === reference.number);
      return card ? { id: card.id, repository: card.repository, number: card.number } : null;
    },
    getAgentProfiles: () => [],
    getAgentProfile: () => null,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const stop = server.stop.bind(server);
  return Object.assign(server, {
    stop: (force?: boolean) => { clearInterval(watcher); return stop(force); },
    /** Resolves with the sequence number of the event published for the latest change. */
    published: async () => {
      while (published !== state.revision()) await Bun.sleep(10);
      return seq;
    },
  });
}

async function signIn(page: Awaited<ReturnType<Browser["newPage"]>>, port: number | undefined) {
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.locator('input[name="username"]').fill("operator");
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([page.waitForURL("**/board"), page.locator('button[type="submit"]').click()]);
}

afterEach(async () => {
  await browser?.close();
  browser = null;
});

describe("dashboard live refresh position", () => {
  test("restores a hidden dropped stream and receives a later update without reloading", async () => {
    let revision = "reconnect-1";
    let title = "Before reconnect";
    const server = startDashboard({
      dashboard: () => dashboard(revision, [issue("target", 20, title)]),
      revision: () => revision,
      delayMs: () => 0,
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "light" });
      await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        const sources: EventSource[] = [];
        class TrackedEventSource extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            if (new URL(String(url), location.href).pathname === "/events/dashboard") sources.push(this);
          }
        }
        Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: TrackedEventSource });
        (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources = sources;
      });
      await signIn(page, server.port);
      await page.waitForFunction(() => {
        const sources = (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources;
        return sources.length === 1 && document.querySelector("[data-connection-state]")?.textContent === "Connected";
      });

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        const sources = (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources;
        sources.at(-1)?.close();
      });
      await Bun.sleep(100);
      title = "Missed while hidden";
      revision = "reconnect-2";
      await server.published();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => {
        const sources = (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources;
        return sources.length === 2
          && document.querySelector("[data-connection-state]")?.textContent === "Connected"
          && document.querySelector('article.issue[data-issue-id="target"]')?.textContent?.includes("Missed while hidden");
      });

      title = "After reconnect";
      revision = "reconnect-3";
      await server.published();
      await page.waitForFunction(() => document.querySelector('article.issue[data-issue-id="target"]')?.textContent?.includes("After reconnect"));
      expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("shows a sign-in link and stops reconnecting when the dashboard session expires", async () => {
    const server = startDashboard({ dashboard: () => dashboard("expired-session", []), revision: () => "expired-session", delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        const sources: EventSource[] = [];
        class TrackedEventSource extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            if (new URL(String(url), location.href).pathname === "/events/dashboard") sources.push(this);
          }
        }
        Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: TrackedEventSource });
        (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources = sources;
      });
      await signIn(page, server.port);
      await page.waitForFunction(() => (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources.length === 1);

      await page.context().clearCookies();
      await page.evaluate(() => {
        const sources = (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources;
        sources.at(-1)?.close();
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => {
        const state = document.querySelector("[data-connection-state]");
        const signIn = document.querySelector<HTMLAnchorElement>("[data-session-sign-in]");
        return state?.textContent === "Session ended" && !signIn?.hidden && signIn?.getAttribute("href") === "/login?returnTo=%2Fboard";
      });
      const sourceCount = await page.evaluate(() => (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources.length);
      await page.waitForTimeout(1_200);
      expect(await page.evaluate(() => (window as typeof window & { dashboardEventSources: EventSource[] }).dashboardEventSources.length)).toBe(sourceCount);
      await Promise.all([page.waitForURL("**/login?returnTo=%2Fboard"), page.locator("[data-session-sign-in]").click()]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps Recent usable at phone width while filtering, expanding a reason, and paging", async () => {
    const server = startDashboard({ dashboard: recentDashboard, revision: () => "recent-1", delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(page, server.port);
      await page.goto(`http://127.0.0.1:${server.port}/recent`);
      for (const type of ["sent-back", "moved-forward", "new", "resumed"]) await page.locator(`input[name="type"][value="${type}"]`).uncheck();
      await page.locator('input[name="repo"][value="sample"]').check();
      await Promise.all([
        page.waitForURL("**/recent?type=done&type=stopped&repo=sample"),
        page.locator(".recent-filter-submit").click(),
      ]);

      expect(await page.locator('input[name="type"][value="done"]').isChecked()).toBe(true);
      expect(await page.locator('input[name="type"][value="stopped"]').isChecked()).toBe(true);
      expect(await page.locator('input[name="repo"][value="sample"]').isChecked()).toBe(true);
      expect(await page.locator('a[href="/issues/sample/72"]').isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.locator(".recent-reason summary").click();
      expect(await page.locator(".recent-reason").getAttribute("open")).not.toBeNull();
      await Promise.all([
        page.waitForURL("**/recent?type=done&type=stopped&repo=sample&beforeAt=2026-10-15T11%3A00%3A00.000Z&beforeId=transition%3Aolder"),
        page.locator(".recent-load-more").click(),
      ]);
      expect(await page.locator(".recent-load-more").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps the Graph usable at 360 px without horizontal page scrolling", async () => {
    const repositories = [repository("sample", 1), repository("foundation", 2)];
    const server = startDashboard({
      dashboard: (selection) => ({
        ...dashboard("graph-1", [issue("parent", 41), issue("child", 42), issue("prerequisite", 7)]),
        view: selection.view,
        repositories,
        graphFilters: {
          repositories: selection.repositoryIds ?? [],
          stage: selection.graphStage ?? null,
          stages: [{ id: "implementation", name: "Implementation" }, { id: "review", name: "Review" }],
        },
        graph: {
          nodes: [
            { id: "parent", repository: "sample", repositoryColor: 1, number: 41, title: "A deliberately long parent title that must wrap inside a phone viewport", state: "Active", stage: "Implementation", context: false, signal: "run" },
            { id: "child", repository: "sample", repositoryColor: 1, number: 42, title: "A deliberately long child title that must also wrap inside a phone viewport", state: "Blocked", stage: "Review", context: false, signal: "stop" },
            { id: "prerequisite", repository: "foundation-with-a-deliberately-long-name", repositoryColor: 2, number: 7, title: "Context prerequisite", state: "Done", stage: null, context: true, signal: null },
          ],
          relationships: [
            { kind: "parent-child", from: "parent", to: "child", status: null },
            { kind: "dependency", from: "prerequisite", to: "child", status: "stopped" },
          ],
        },
      }),
      revision: () => "graph-1",
      delayMs: () => 0,
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(page, server.port);
      await page.goto(`http://127.0.0.1:${server.port}/graph`);

      const sampleRepository = page.getByRole("checkbox", { name: "sample" });
      const foundationRepository = page.getByRole("checkbox", { name: "foundation" });
      await sampleRepository.focus();
      await page.keyboard.press("Space");
      expect(await sampleRepository.isChecked()).toBe(true);
      await foundationRepository.focus();
      await page.keyboard.press("Space");
      expect(await foundationRepository.isChecked()).toBe(true);
      await page.getByLabel("Graph stage").selectOption("review");
      await Promise.all([
        page.waitForURL("**/graph?repo=sample&repo=foundation&stage=review"),
        page.getByRole("button", { name: "Apply filters" }).click(),
      ]);
      expect(await sampleRepository.isChecked()).toBe(true);
      expect(await foundationRepository.isChecked()).toBe(true);
      expect(await page.getByLabel("Graph stage").inputValue()).toBe("review");

      expect(await page.locator(".graph-node").count()).toBe(3);
      expect(await page.locator(".graph-relationship--dependency").textContent()).toContain("Status: stopped prerequisite");
      expect(await page.locator(".graph-canvas").evaluate((canvas) => canvas.scrollWidth > canvas.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator(".graph-node text").evaluateAll((texts) => texts.every((text) => {
        const node = text.closest(".graph-node");
        if (!node) return false;
        const textBounds = text.getBoundingClientRect();
        const nodeBounds = node.getBoundingClientRect();
        return textBounds.left >= nodeBounds.left && textBounds.right <= nodeBounds.right
          && textBounds.top >= nodeBounds.top && textBounds.bottom <= nodeBounds.bottom;
      }))).toBe(true);

      await page.locator('[data-graph-node="child"]').click({ noWaitAfter: true });
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]')?.getAttribute('data-issue-id') === 'child');
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('dialog.issue-details[open]'));

      const prerequisiteNode = page.locator('[data-graph-node="prerequisite"]');
      await prerequisiteNode.focus();
      await prerequisiteNode.press("Enter", { noWaitAfter: true });
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]')?.getAttribute('data-issue-id') === 'prerequisite');
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('dialog.issue-details[open]'));

      await Promise.all([
        page.waitForURL("**/graph"),
        page.getByRole("link", { name: "Clear" }).click(),
      ]);
      expect(await sampleRepository.isChecked()).toBe(false);
      expect(await foundationRepository.isChecked()).toBe(false);
      expect(await page.getByLabel("Graph stage").inputValue()).toBe("");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("refreshes Graph nodes and relationship status in place without duplicates", async () => {
    let revision = "graph-live-1";
    let currentDashboard: DashboardViewModel = {
      ...dashboard(revision, []),
      view: "graph",
      graph: {
        nodes: [
          { id: "prerequisite", repository: "foundation", repositoryColor: 2, number: 7, title: "Prerequisite", state: "Active", stage: "Review", context: false, signal: "run" },
          { id: "waiting", repository: "sample", repositoryColor: 1, number: 42, title: "Waiting item", state: "Blocked", stage: "Implementation", context: false, signal: "stop" },
          { id: "retired", repository: "foundation", repositoryColor: 2, number: 8, title: "Removed context", state: "Done", stage: null, context: true, signal: null },
        ],
        relationships: [
          { kind: "dependency", from: "prerequisite", to: "waiting", status: "outstanding" },
          { kind: "parent-child", from: "retired", to: "waiting", status: null },
        ],
      },
    };
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
      await signIn(page, server.port);
      await page.goto(`http://127.0.0.1:${server.port}/graph?stage=implementation`);
      expect(await page.locator('[data-graph-node="retired"]').count()).toBe(1);
      expect(await page.locator(".graph-relationship--dependency").textContent()).toContain("Status: outstanding prerequisite");

      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await armReplacement(page);
      revision = "graph-live-2";
      currentDashboard = {
        ...dashboard(revision, []),
        view: "graph",
        graph: {
          nodes: [
            { id: "waiting", repository: "sample", repositoryColor: 1, number: 42, title: "Waiting item", state: "Active", stage: "Implementation", context: false, signal: "run" },
            { id: "prerequisite", repository: "foundation", repositoryColor: 2, number: 7, title: "Prerequisite", state: "Done", stage: "Review", context: false, signal: "run" },
            { id: "added", repository: "sample", repositoryColor: 1, number: 43, title: "New dependent", state: "Active", stage: "Implementation", context: false, signal: "run" },
          ],
          relationships: [
            { kind: "dependency", from: "prerequisite", to: "waiting", status: "satisfied" },
          ],
        },
      };

      await page.waitForFunction(() =>
        document.querySelector('[data-graph-node="added"]') !== null &&
        document.querySelector('[data-graph-node="retired"]') === null &&
        document.querySelector(".graph-relationship--dependency")?.textContent?.includes("Status: satisfied prerequisite"),
      );

      const graphIds = await page.locator("[data-graph-node]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-graph-node")));
      expect(await page.locator('[data-graph-node="retired"]').count()).toBe(0);
      expect(await page.locator('[data-graph-node="added"]').count()).toBe(1);
      expect(await page.locator(".graph-relationship--parent-child").count()).toBe(0);
      expect(await page.locator(".graph-relationship--dependency").textContent()).toContain("Status: satisfied prerequisite");
      expect(new Set(graphIds).size).toBe(graphIds.length);
      expect(navigations).toBe(0);
      expect(await page.evaluate(() => location.pathname + location.search)).toBe("/graph?stage=implementation");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("shows a distinct storage warning from a live status event without reloading", async () => {
    let status: SystemStatusViewModel = {
      memory: { usedBytes: 1, totalBytes: 2, processBytes: 1 },
      disk: { available: true, usedBytes: 1, totalBytes: 2, availableBytes: 1 },
      storage: {
        artifacts: { available: true, usedBytes: 50, totalBytes: 100, availableBytes: 50 },
        temporaryDirectory: { available: false },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 1,
    };
    const server = startDashboard({
      dashboard: () => dashboard("revision-1", [issue("card-1", 3, "Card")]),
      revision: () => "revision-1",
      delayMs: () => 0,
      systemStatus: () => status,
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
      await signIn(page, server.port);
      await page.waitForFunction(() => document.querySelector('[data-server-metrics]')?.textContent?.includes("artifacts 50% used"));
      expect(await page.locator('[data-storage-warning]').isVisible()).toBe(false);
      await page.evaluate(() => { (document.querySelector("main.dashboard") as HTMLElement).dataset.statusTestMarker = "kept"; });

      status = {
        ...status,
        storage: {
          artifacts: { available: true, usedBytes: 8_504, totalBytes: 10_000, availableBytes: 1_496 },
          temporaryDirectory: { available: true, usedBytes: 8_504, totalBytes: 10_000, availableBytes: 1_496, sharesFilesystemWithArtifacts: true },
          workspaceScratch: { available: false },
        },
      };
      await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-server-status]')?.dataset.storagePressure === "true", undefined, { timeout: 15_000 });

      expect(await page.locator('[data-storage-warning]').isVisible()).toBe(true);
      expect(await page.locator('[data-server-metrics]').textContent()).toContain("Warning: artifacts and temporary directory 85% used");
      expect(await page.locator('[data-server-metrics]').textContent()).toContain("agent scratch unavailable");
      expect(await page.locator('[data-server-metrics]').getAttribute("class")).toContain("server-status-metrics--warning");
      expect(await page.locator('[data-server-status] summary').getAttribute("aria-label")).toContain("storage pressure warning");
      expect(await page.evaluate(() => document.querySelector("main.dashboard")?.getAttribute("data-status-test-marker"))).toBe("kept");

      status = {
        ...status,
        storage: {
          artifacts: { available: true, usedBytes: 8_500, totalBytes: 10_000, availableBytes: 1_500 },
          temporaryDirectory: { available: false },
          workspaceScratch: { available: false },
        },
      };
      await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-server-status]')?.dataset.storagePressure === "false", undefined, { timeout: 15_000 });

      expect(await page.locator('[data-storage-warning]').isVisible()).toBe(false);
      expect(await page.locator('[data-server-metrics]').getAttribute("class")).not.toContain("server-status-metrics--warning");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps a phone reader's card in place, then bounds offsets when the card disappears", async () => {
    const original = Array.from({ length: 8 }, (_, index) => issue(`above-${index}`, index + 2));
    const target = issue("target", 20, "Target card");
    const below = Array.from({ length: 8 }, (_, index) => issue(`below-${index}`, index + 30));
    const offscreenIssues = Array.from({ length: 10 }, (_, index) => issue(`before-${index}`, index + 100));
    let revision = "revision-1";
    let currentDashboard = dashboard(revision, [...original, target, ...below], offscreenIssues);
    let responseDelayMs = 0;
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => responseDelayMs });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      await page.goto(`${baseUrl}/login`);
      await page.locator('input[name="username"]').fill("operator");
      await page.locator('input[name="password"]').fill(password);
      await Promise.all([page.waitForURL("**/board"), page.locator('button[type="submit"]').click()]);

      await page.locator('article.issue[data-issue-id="target"]').evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
      const before = await cardPositions(page);
      expect(before.cardTop).not.toBeNull();
      expect(before.stageLeft).not.toBeNull();
      // On a phone the board lists its stages top to bottom: nothing scrolls sideways.
      expect(before.scrollX).toBe(0);

      const inserted = Array.from({ length: 5 }, (_, index) => issue(`inserted-${index}`, index + 60));
      await armReplacement(page);
      currentDashboard = dashboard(
        "revision-2",
        [...original, ...inserted, target, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-2";
      await waitForArmedReplacement(page, { id: "inserted-0", present: true });
      const afterInsert = await cardPositions(page);
      expect(Math.abs(afterInsert.cardTop! - before.cardTop!)).toBeLessThanOrEqual(24);
      expect(Math.abs(afterInsert.stageLeft! - before.stageLeft!)).toBeLessThanOrEqual(24);
      expect(afterInsert.path).toBe(before.path);

      const priorOffsets = await cardPositions(page);
      await armReplacement(page);
      currentDashboard = dashboard(
        "revision-3",
        [...original, ...inserted, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-3";
      await waitForArmedReplacement(page, { id: "target", present: false });
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
      expect(afterRemoval.scrollX).toBe(0);
      expect(afterRemoval.scrollY).toBeLessThanOrEqual(Math.max(0, afterRemoval.maxScrollY));
      expect(afterRemoval.scrollX).toBeLessThanOrEqual(Math.max(0, afterRemoval.maxScrollX));
      expect(Math.abs(afterRemoval.scrollY - Math.min(priorOffsets.scrollY, Math.max(0, afterRemoval.maxScrollY)))).toBeLessThanOrEqual(24);
      expect(Math.abs(afterRemoval.scrollX - Math.min(priorOffsets.scrollX, Math.max(0, afterRemoval.maxScrollX)))).toBeLessThanOrEqual(24);

      // A reader who keeps scrolling while a slow refresh is in flight stays where they scrolled to.
      responseDelayMs = 800;
      const refreshRequest = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).pathname === "/board");
      await page.evaluate(() => document.querySelector("main.dashboard")?.setAttribute("data-before-refresh", "true"));
      currentDashboard = { ...currentDashboard, revision: "revision-3-slow" };
      revision = "revision-3-slow";
      await refreshRequest;
      const scrolledTo = await page.evaluate(() => {
        const maximum = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollBy(0, window.scrollY >= 150 ? -150 : Math.min(150, maximum - window.scrollY));
        return window.scrollY;
      });
      expect(Math.abs(scrolledTo - afterRemoval.scrollY)).toBeGreaterThan(60);
      await page.waitForFunction(() => !document.querySelector("main.dashboard")?.hasAttribute("data-before-refresh"));
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolledTo)).toBeLessThanOrEqual(24);
      responseDelayMs = 0;

      const detailsRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/above-0/details");
      await page.locator('article.issue[data-issue-id="above-0"] .card-open').click();
      expect((await detailsRequest).status()).toBe(200);
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.locator("dialog[open] [role=tab][aria-selected=true]").evaluate((element) => document.activeElement === element)).toBe(true);
      await page.locator('dialog[open] [data-detail-tab="conversation"]').click();
      const draft = page.locator('dialog[open] textarea[name="message"]');
      await draft.fill("Keep this draft while the board changes");
      await page.evaluate(() => document.querySelector("main.dashboard")?.setAttribute("data-before-refresh", "true"));
      currentDashboard = dashboard(
        "revision-4",
        [...inserted, ...original, ...below],
        [issue("before-inserted", 200), ...offscreenIssues],
      );
      revision = "revision-4";
      // The page hears of the change but keeps the dialog's draft: its refresh waits.
      await page.waitForFunction((expected) => Number(document.body.dataset.lastEventSeq ?? 0) >= expected, await server.published());
      await page.waitForTimeout(1100);
      expect(await page.locator("main.dashboard").getAttribute("data-before-refresh")).toBe("true");
      expect(await page.locator("dialog[open]").count()).toBe(1);
      expect(await page.locator('dialog[open] [data-detail-tab="conversation"]').getAttribute("aria-selected")).toBe("true");
      expect(await draft.inputValue()).toBe("Keep this draft while the board changes");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps a phone reader's tab strip position across a live refresh", async () => {
    let revision = "revision-1";
    const withOverflowingTabs = (nextRevision: string) => {
      const base = dashboard(nextRevision, [issue("card-1", 1)]);
      return {
        ...base,
        attention: stage("attention", "Attention", [issue("attention-1", 2)]),
        counts: { ...base.counts, attention: 1 },
      };
    };
    let currentDashboard = withOverflowingTabs(revision);
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });

    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
      });
      await signIn(page, server.port);
      await page.evaluate(() => new Promise(requestAnimationFrame));

      const tabPosition = await page.evaluate(() => {
        const tabs = document.querySelector<HTMLElement>(".tabs");
        if (!tabs) return null;
        tabs.scrollLeft = tabs.scrollWidth;
        return { scrollLeft: tabs.scrollLeft, maximum: tabs.scrollWidth - tabs.clientWidth };
      });
      expect(tabPosition?.maximum).toBeGreaterThan(0);
      expect(tabPosition?.scrollLeft).toBeGreaterThan(0);

      revision = "revision-2";
      currentDashboard = withOverflowingTabs(revision);
      await waitForReplacement(page);
      await page.evaluate(() => new Promise(requestAnimationFrame));

      const refreshedScrollLeft = await page.evaluate(
        () => document.querySelector<HTMLElement>(".tabs")?.scrollLeft,
      );
      expect(refreshedScrollLeft).toBe(tabPosition?.scrollLeft);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("loads card details on demand and keeps the URL, history, and focus in sync", async () => {
    let revision = "revision-1";
    const target = issue("target", 20, "Target item");
    const server = startDashboard({ dashboard: () => dashboard(revision, [target]), revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);
      expect(await page.locator("dialog.issue-details").count()).toBe(0);

      const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/target/details");
      await page.locator('article.issue[data-issue-id="target"] .card-open').click();
      expect((await request).status()).toBe(200);
      await page.waitForURL("**/issues/sample/20");
      expect(await page.locator("dialog.issue-details[open]").count()).toBe(1);

      await page.goBack();
      await page.waitForURL("**/board");
      await page.waitForFunction(() => !document.querySelector("dialog.issue-details[open]"));
      expect(await page.locator('article.issue[data-issue-id="target"] .card-open').evaluate((element) => document.activeElement === element)).toBe(true);

      await page.goForward();
      await page.waitForURL("**/issues/sample/20");
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open]"));
      expect(await page.locator("dialog.issue-details[open]").count()).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("refreshes the open stage badge and keeps item details usable at phone width in both themes", async () => {
    let revision = "stage-badge-1";
    let target: IssueCardViewModel = {
      ...issue("target", 20, "Target item"),
      stageBadge: { name: "Build", icon: "🛠️", offboarded: false },
    };
    const server = startDashboard({ dashboard: () => dashboard(revision, [target]), revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "light" });
      await signIn(page, server.port);

      const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/target/details");
      await page.locator('article.issue[data-issue-id="target"] .card-open').click();
      await request;
      await page.waitForURL("**/issues/sample/20");
      await page.waitForFunction(() => document.querySelector('[data-details-stage-badge]')?.textContent?.includes("Stage: Build"));
      await page.getByRole("tab", { name: "Conversation" }).click();

      target = { ...target, stageBadge: { name: "Review", icon: "🔍", offboarded: false } };
      revision = "stage-badge-2";
      await page.waitForFunction(() => document.querySelector('[data-details-stage-badge]')?.textContent?.includes("Stage: Review"));

      expect(await page.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
      expect(await page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>("dialog.issue-details[open]");
        return document.documentElement.scrollWidth <= window.innerWidth && (dialog === null || dialog.scrollWidth <= dialog.clientWidth);
      })).toBe(true);

      await page.reload({ waitUntil: "commit" });
      await page.waitForFunction(() => document.querySelector('[data-details-stage-badge]')?.textContent?.includes("Stage: Review"));

      const darkPage = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
      await signIn(darkPage, server.port);
      await darkPage.locator('article.issue[data-issue-id="target"] .card-open').click();
      await darkPage.waitForFunction(() => document.querySelector('[data-details-stage-badge]')?.textContent?.includes("Stage: Review"));
      expect(await darkPage.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>("dialog.issue-details[open]");
        return document.documentElement.scrollWidth <= window.innerWidth && (dialog === null || dialog.scrollWidth <= dialog.clientWidth);
      })).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps repository actions touch-sized, keyboard-focusable, and within a phone viewport in both themes", async () => {
    const repository = {
      id: "sample", address: "owner/sample", addressUrl: "https://github.com/owner/sample", color: 1,
      health: "healthy" as const, error: null, errorSummary: null, lastReconciledAt: null, pause: null,
      backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
      setup: { pipeline: "delivery", baseBranch: "main", itemProvider: "github", itemSync: "polling" as const, webhooks: null, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled" as const, systemLabels: [] },
      trust: { visibility: "unknown" as const, checkedAt: null, warning: "Repository visibility has not yet been checked.", permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: ["native review findings"] },
      report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
    };
    const server = startDashboard({
      dashboard: (selection) => ({ ...dashboard("repository-actions", []), repositoryId: selection.repositoryId ?? null, repositories: [repository] }),
      revision: () => "repository-actions",
      delayMs: () => 0,
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "light" });
      await signIn(page, server.port);
      await page.goto(`http://127.0.0.1:${server.port}/repositories/sample`);

      const sync = page.locator("[data-repository-sync-submit]");
      const pause = page.getByRole("button", { name: "Pause repository" });
      await sync.focus();
      expect(await sync.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      const touchTarget = await sync.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        minimum: Number.parseFloat(getComputedStyle(element).minHeight),
        root: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      }));
      expect(touchTarget.minimum).toBe(touchTarget.root * 2.75);
      expect(touchTarget.height).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(await pause.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const darkPage = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
      await signIn(darkPage, server.port);
      await darkPage.goto(`http://127.0.0.1:${server.port}/repositories/sample`);
      expect(await darkPage.locator("[data-repository-sync-submit]").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(touchTarget.minimum);
      expect(await darkPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps the newest card selection when an earlier details load finishes late", async () => {
    let revision = "revision-1";
    const slow = issue("slow", 20, "Slow item");
    const fast = issue("fast", 21, "Fast item");
    const server = startDashboard({
      dashboard: () => dashboard(revision, [slow, fast]),
      revision: () => revision,
      delayMs: () => 0,
      detailsDelayMs: (issueId) => issueId === "slow" ? 200 : 0,
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);

      const slowRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/issues/slow/details");
      await page.locator('article.issue[data-issue-id="slow"] .card-open').click();
      await slowRequest;
      await page.locator('article.issue[data-issue-id="fast"] .card-open').click();
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]')?.getAttribute('data-issue-id') === 'fast');
      await page.waitForTimeout(250);

      expect(await page.locator('dialog.issue-details[open]').getAttribute('data-issue-id')).toBe("fast");
      expect(page.url()).toContain("/issues/sample/21");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("reloads details after close instead of retaining a stale lazy dialog", async () => {
    let revision = "revision-1";
    let currentDashboard = dashboard(revision, [issue("target", 20, "Original item")]);
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);

      const firstDetails = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/target/details");
      await page.locator('article.issue[data-issue-id="target"] .card-open').click();
      await firstDetails;
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]'));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('dialog.issue-details'));

      revision = "revision-2";
      currentDashboard = dashboard(revision, [issue("target", 20, "Updated item")]);
      await waitForReplacement(page);
      const refreshedDetails = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/target/details");
      await page.locator('article.issue[data-issue-id="target"] .card-open').click();
      await refreshedDetails;
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]'));

      expect(await page.locator('dialog.issue-details[open] .details-header h2').textContent()).toBe("Updated item");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("refreshes criterion evidence and approval state in an open phone detail dialog", async () => {
    let revision = "criterion-evidence-1";
    const initial = issue("target", 20, "Target item");
    initial.acceptanceCriteria = [
      { id: "AC-1", text: "Evidence criterion", approved: false, manual: false, tests: [] },
      { id: "AC-2", text: "Manual criterion", approved: false, manual: true, tests: [] },
    ];
    let currentDashboard = dashboard(revision, [initial]);
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
      await signIn(page, server.port);

      const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/issues/target/details");
      await page.locator('article.issue[data-issue-id="target"] .card-open').click();
      await request;
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]'));
      const evidence = page.locator("[data-criterion-evidence]");
      expect(await evidence.textContent()).toContain("no tests linked");
      expect(await evidence.textContent()).toContain("manual");
      expect(await evidence.getByLabel("Waiting").count()).toBe(1);
      expect(await evidence.getByLabel("Manual").count()).toBe(1);
      expect(await evidence.locator(".criterion-list > li").evaluateAll((items) => items.every((item) => getComputedStyle(item, "::before").content === "none"))).toBe(true);

      const refreshed = issue("target", 20, "Target item");
      refreshed.acceptanceCriteria = [
        {
          id: "AC-1", text: "Evidence criterion", approved: true, manual: false,
          tests: [{
            name: "refreshes evidence", file: "tests/web/refresh-position.test.ts", line: 579,
            description: "Uses the verified source revision.",
            sourceUrl: "https://example.com/owner/repo/blob/verified-head/tests/web/refresh-position.test.ts#L579",
          }],
        },
        { id: "AC-2", text: "Manual criterion", approved: false, manual: true, tests: [] },
      ];
      revision = "criterion-evidence-2";
      currentDashboard = dashboard(revision, [refreshed]);
      await page.waitForFunction(() => document.querySelector("[data-criterion-evidence]")?.textContent?.includes("refreshes evidence"));

      expect(await evidence.textContent()).toContain("☑☑ Approved");
      expect(await evidence.getByLabel("Approved").count()).toBe(1);
      expect(await evidence.getByLabel("Manual").count()).toBe(1);
      expect(await evidence.locator("a.criterion-test-location").getAttribute("href")).toContain("/blob/verified-head/tests/web/refresh-position.test.ts#L579");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a live update leaves the scroll position alone when nothing moved, so a scroll in progress finishes", async () => {
    const cards = Array.from({ length: 40 }, (_, index) => issue(`card-${index}`, index + 2, `Card ${index}`));
    let revision = "revision-1";
    let currentDashboard = dashboard(revision, cards);
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
      await signIn(page, server.port);
      const destination = await page.evaluate(() => Math.floor((document.documentElement.scrollHeight - innerHeight) * 0.8));
      expect(destination).toBeGreaterThan(1500);

      // A refresh whose only change is below the fold lands while a long smooth scroll is under way.
      const refresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      await page.evaluate((top) => {
        (window as unknown as { scrollWrites: number }).scrollWrites = 0;
        const original = window.scrollTo.bind(window);
        window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
          (window as unknown as { scrollWrites: number }).scrollWrites++;
          return original(...args);
        }) as typeof window.scrollTo;
        original({ top, behavior: "smooth" });
      }, destination);
      currentDashboard = dashboard("revision-2", cards.map((card) => card.id === "card-39" ? { ...card, title: "Card 39 renamed" } : card));
      revision = "revision-2";
      await refresh;
      await page.locator('[data-issue-id="card-39"] .issue-title').filter({ hasText: "Card 39 renamed" }).waitFor();
      await page.waitForFunction((top) => Math.abs(window.scrollY - top) <= 2, destination, { timeout: 5_000 });

      expect(await page.evaluate(() => (window as unknown as { scrollWrites: number }).scrollWrites)).toBe(0);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - destination)).toBeLessThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a live update replaces only the cards that changed, and the server sends only those", async () => {
    const cards = Array.from({ length: 6 }, (_, index) => issue(`card-${index}`, index + 2, `Card ${index}`));
    let revision = "revision-1";
    let currentDashboard = dashboard(revision, cards);
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);
      // Marks that only survive on nodes that are never replaced.
      await page.evaluate(() => {
        for (const selector of ["main.dashboard", '[data-issue-id="card-1"]', '[data-issue-id="card-3"]', '[data-issue-id="card-5"]']) {
          (document.querySelector(selector) as unknown as { untouched: boolean }).untouched = true;
        }
      });
      const refresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      const changed = cards.map((card) => card.id === "card-3" ? { ...card, title: "Card 3 renamed" } : card);
      currentDashboard = dashboard("revision-2", [changed[0]!, changed[2]!, changed[1]!, ...changed.slice(3, 5), issue("card-new", 90, "New card")]);
      revision = "revision-2";
      const response = await refresh;
      await page.locator('[data-issue-id="card-3"] .issue-title').filter({ hasText: "Card 3 renamed" }).waitFor();

      // The browser said which cards it holds, and got placeholders for the ones that have not changed.
      expect(response.request().headers()["x-conveyor-cards"]?.split(" ").length).toBeGreaterThanOrEqual(6);
      const body = await response.text();
      expect(body).toContain("Card 3 renamed");
      expect(body).toContain("New card");
      expect(body).not.toContain("Card 1<");
      expect(body.match(/data-keep/g)?.length).toBeGreaterThanOrEqual(4);

      const after = await page.evaluate(() => ({
        dashboardKept: (document.querySelector("main.dashboard") as unknown as { untouched?: boolean }).untouched === true,
        unchangedKept: (document.querySelector('[data-issue-id="card-1"]') as unknown as { untouched?: boolean }).untouched === true,
        removedGone: document.querySelector('[data-issue-id="card-5"]') === null,
        order: [...document.querySelectorAll('[data-station-cell="reader"] article.issue')].map((card) => card.getAttribute("data-issue-id")),
        titles: [...document.querySelectorAll('[data-station-cell="reader"] article.issue .issue-title')].map((title) => title.textContent),
        placeholders: document.querySelectorAll("[data-keep]").length,
      }));
      expect(after).toEqual({
        dashboardKept: true, unchangedKept: true, removedGone: true,
        order: ["card-0", "card-2", "card-1", "card-3", "card-4", "card-new"],
        titles: ["Card 0", "Card 2", "Card 1", "Card 3 renamed", "Card 4", "New card"],
        placeholders: 0,
      });

      // A freshly loaded page is the same as the live-updated one.
      const live = await page.locator('[data-station-cell="reader"]').innerHTML();
      await page.reload();
      expect(await page.locator('[data-station-cell="reader"]').innerHTML()).toBe(live);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("filters board cards in the browser, keeps filters through a live update, and collapses them on a phone", async () => {
    const alpha = {
      ...issue("alpha-card", 245, "Find the alpha item"), repository: "alpha", labels: ["backend"],
      issueType: "Feature", issueFields: [{ name: "Effort", value: "Large" }], searchActors: [{ type: "agent" as const, name: "Ada Lovelace", title: null }],
      acceptanceCriteria: [{ id: "private-criterion", text: "Private criterion text", approved: false, manual: false, tests: [] }], needsAttention: true, tone: "danger" as const,
    };
    const beta = { ...issue("beta-card", 246, "Keep the beta item"), repository: "beta", working: true };
    const family = {
      ...issue("family-card", 249, "Running family"), repository: "alpha", working: true,
      children: [{ id: "family-done", repository: "alpha", number: 250, title: "Completed family child", url: null, satisfied: true, station: { index: 4, count: 4, name: "Done" } }],
    };
    const closed = [
      { ...issue("done-alpha", 247, "Find the completed alpha item"), repository: "alpha", state: "closed", tone: "success" as const },
      { ...issue("done-beta", 248, "Completed beta item"), repository: "beta", state: "closed", tone: "success" as const },
    ];
    const repository = (id: string, color: number) => ({
      id, address: `owner/${id}`, addressUrl: null, color, health: "healthy" as const, error: null, errorSummary: null,
      lastReconciledAt: null, backlog: 0, stages: [], done: 0, items: [], deliveries: [], skippedReviewItems: [], capacity: { busy: 0, slots: 1 },
      setup: { pipeline: "default", baseBranch: "main", itemProvider: "github", itemSync: "webhook" as const, webhooks: "healthy" as const, githubCalls: { total: 0, bySource: [] }, ciProvider: null, ciMode: "disabled" as const, systemLabels: [] },
      trust: { visibility: "unknown" as const, checkedAt: null, warning: "Repository visibility has not yet been checked.", permissionThreshold: "write, maintain, or admin", extraTrustedLogins: [], ignoredInputCategories: ["native review findings", "post-enrollment issue title and body edits", "enrollment labels"] },
      report30d: { delivered: 0, inputTokens: 0, outputTokens: 0, agentMs: 0 },
    });
    let revision = "filters-1";
    const doneQueries: string[] = [];
    const board = async (selection: DashboardPageSelection) => {
      const query = selection.q ?? "";
      doneQueries.push(query);
      if (query === "Find") await Bun.sleep(500);
      const repositories = new Set(selection.repositoryIds ?? []);
      const words = (selection.q ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      const matchesDone = (card: IssueCardViewModel) =>
        (repositories.size === 0 || repositories.has(card.repository)) &&
        words.every((word) => [card.title, card.number, `#${card.number}`, card.repository, ...card.labels, card.issueType ?? "", ...card.issueFields.map((field) => field.value)].join(" ").toLowerCase().includes(word));
      const base = dashboard(revision, [alpha, beta, family]);
      return {
        ...base,
        revision,
        done: stage("done", "Done", closed.filter(matchesDone)),
        counts: { ...base.counts, attention: 1 },
        needsYou: [alpha],
        repositories: [repository("alpha", 1), repository("beta", 2)],
        boardFilters: { repositories: [...repositories], q: selection.q ?? "", state: selection.state ?? null },
      };
    };
    const server = startDashboard({ dashboard: board, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await signIn(page, server.port);
      doneQueries.length = 0;

      const initialDoneResponse = page.waitForResponse((response) => {
        if (response.request().resourceType() !== "fetch") return false;
        const parameters = new URL(response.url()).searchParams;
        return parameters.get("repo") === "alpha" && !parameters.has("q");
      });
      await page.locator('.repository-filter label').filter({ hasText: "alpha" }).click();
      await page.waitForFunction(() => location.search === "?repo=alpha");
      await initialDoneResponse;
      doneQueries.length = 0;
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isVisible()).toBe(true);
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);
      expect(await page.locator('[data-board-filters] a[href^="/repositories/"]').count()).toBe(0);

      await page.locator('[data-filter-clear]').click();
      await page.locator('[data-filter-search]').fill("F");
      await page.locator('[data-filter-search]').fill("Fi");
      const firstDoneRequest = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).searchParams.get("q") === "Find");
      await page.locator('[data-filter-search]').fill("Find");
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);
      await firstDoneRequest;
      const doneRequest = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).searchParams.get("q") === "#245");
      await page.locator('[data-filter-search]').fill("#245");
      await doneRequest;
      await page.waitForFunction(() => document.querySelector('.board')?.getAttribute('data-done-total') === '0');
      await Bun.sleep(550);
      expect(doneQueries).toEqual(["Find", "#245"]);
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isVisible()).toBe(true);
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);
      expect(await page.locator('[data-board-station-count="reader"]').first().textContent()).toBe("1 of 3");
      expect(await page.locator('[data-board-line-count="reader"]').first().textContent()).toBe("1 of 3");
      expect(await page.locator('[data-board-signal-count="stop"] small').first().textContent()).toBe("1 of 1");
      expect(await page.locator('[data-board-station-count="done"]').first().textContent()).toBe("0 of 2");
      expect(await page.locator('[data-filter-summary]').textContent()).toContain("Showing 1 of 5 active board items");
      await page.locator('article.issue[data-issue-id="alpha-card"] .card-open').click();
      expect(new URL(page.url()).search).toBe("?q=%23245");
      await page.getByRole("button", { name: "Close" }).click();
      await page.locator('[data-filter-clear]').click();
      await page.waitForFunction(() => location.search === "");
      expect(await page.locator('[data-filter-search]').inputValue()).toBe("");
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isVisible()).toBe(true);

      await page.locator('[data-filter-search]').fill("BACKEND Feature Large Ada");
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isVisible()).toBe(true);
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);
      await page.locator('[data-filter-search]').fill("Private criterion");
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isHidden()).toBe(true);
      expect(await page.locator('[data-filter-summary]').textContent()).toContain("Showing 0 of 5 active board items");
      expect(await page.locator('.needs-you').isVisible()).toBe(true);
      expect(await page.locator('.needs-you-link').textContent()).toContain("1 needs you");
      await page.locator('[data-filter-clear]').click();
      await page.waitForFunction(() => location.search === "");
      await page.evaluate(() => {
        history.replaceState({ conveyorPage: true }, "", "/board");
        const search = document.querySelector('[data-filter-search]');
        if (search instanceof HTMLInputElement) search.value = "";
        document.dispatchEvent(new CustomEvent("conveyor:dashboard-rendered"));
      });

      const firstDoneResponse = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).searchParams.get("q") === "#245");
      await page.locator('[data-filter-search]').fill("#245");
      await firstDoneResponse;
      await page.evaluate(() => {
        history.replaceState({ conveyorPage: true }, "", "/board");
        const search = document.querySelector('[data-filter-search]');
        if (search instanceof HTMLInputElement) search.value = "";
        document.dispatchEvent(new CustomEvent("conveyor:dashboard-rendered"));
      });
      const repeatedDoneRequest = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).searchParams.get("q") === "#245");
      await page.locator('[data-filter-search]').fill("#245");
      await repeatedDoneRequest;
      await page.locator('[data-filter-clear]').click();

      const needsYou = page.getByRole("radio", { name: "Needs you" });
      await needsYou.focus();
      await needsYou.press(" ");
      await page.waitForFunction(() => location.search === "?state=needs-you");
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isVisible()).toBe(true);
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);
      expect(await page.locator('[data-family-row="family-card"] .family-head').isHidden()).toBe(true);
      expect(await page.locator('[data-family-row="family-card"] .issue--compact').isHidden()).toBe(true);
      expect(await page.locator('[data-board-station-count="done"]').first().textContent()).toBe("0 of 2");
      revision = "filters-2";
      await waitForReplacement(page);
      expect(await page.locator('article.issue[data-issue-id="alpha-card"]').isVisible()).toBe(true);
      expect(await page.locator('article.issue[data-issue-id="beta-card"]').isHidden()).toBe(true);

      await page.locator('[data-filter-clear]').click();
      await page.locator('[data-filter-search]').fill("Running family");
      expect(await page.locator('[data-family-row="family-card"] .family-head').isVisible()).toBe(true);
      expect(await page.locator('[data-family-row="family-card"] .issue--compact').isHidden()).toBe(true);

      const phone = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(phone, server.port);
      const collapsed = await phone.evaluate(() => {
        const form = document.querySelector('[data-filter-form]')!;
        const visible = [...form.children].filter((child) => getComputedStyle(child).display !== "none");
        return new Set(visible.map((child) => Math.round(child.getBoundingClientRect().bottom))).size;
      });
      expect(collapsed).toBeLessThanOrEqual(2);
      await phone.getByRole("button", { name: "Filters (0)" }).click();
      expect(await phone.locator('.repository-filter label').filter({ hasText: "alpha" }).isVisible()).toBe(true);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const noScript = await browser.newPage({ javaScriptEnabled: false });
      await signIn(noScript, server.port);
      await noScript.locator('[data-filter-repository="alpha"]').check({ force: true });
      await noScript.locator('[data-filter-search]').fill("#245");
      await noScript.getByRole("radio", { name: "Waiting / Queued" }).check({ force: true });
      await Promise.all([
        noScript.waitForURL((url) => url.pathname === "/board" && url.searchParams.get("repo") === "alpha" && url.searchParams.get("q") === "#245" && url.searchParams.get("state") === "waiting"),
        noScript.getByRole("button", { name: "Apply filters" }).click(),
      ]);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("filters whole backlog rows and restores their reorder controls in order", async () => {
    const alpha = { ...issue("backlog-alpha", 401, "Alpha backlog item"), repository: "alpha", needsAttention: true };
    const beta = { ...issue("backlog-beta", 402, "Beta backlog item"), repository: "beta" };
    const board = async (selection: DashboardPageSelection) => ({
      ...dashboard("backlog-filters", []),
      backlog: [alpha, beta],
      repositories: [repository("alpha", 1), repository("beta", 2)],
      boardFilters: {
        repositories: selection.repositoryIds ?? [],
        q: selection.q ?? "",
        state: selection.state ?? null,
      },
    });
    const server = startDashboard({ dashboard: board, revision: () => "backlog-filters", delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await signIn(page, server.port);

      const backlogOrder = () => page.locator('[data-backlog-list] > .backlog-row').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-backlog-id")));
      const betaRow = page.locator('[data-backlog-id="backlog-beta"]');
      const betaUp = page.getByRole("button", { name: "Move #402 up" });
      const expectBetaHidden = async () => {
        expect(await betaRow.isHidden()).toBe(true);
        expect(await betaUp.isHidden()).toBe(true);
        expect(await page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>('[data-backlog-id="backlog-beta"] button');
          button?.focus();
          return document.activeElement === button;
        })).toBe(false);
      };

      await page.locator('[data-filter-search]').fill("Alpha backlog");
      await expectBetaHidden();
      await page.locator('[data-filter-clear]').click();
      expect(await betaRow.isVisible()).toBe(true);
      expect(await betaUp.isVisible()).toBe(true);
      expect(await backlogOrder()).toEqual(["backlog-alpha", "backlog-beta"]);

      await page.locator('.repository-filter label').filter({ hasText: "alpha" }).click();
      await expectBetaHidden();
      await page.locator('[data-filter-clear]').click();
      expect(await backlogOrder()).toEqual(["backlog-alpha", "backlog-beta"]);

      const needsYou = page.getByRole("radio", { name: "Needs you" });
      await needsYou.focus();
      await needsYou.press(" ");
      await expectBetaHidden();
      await page.locator('[data-filter-clear]').click();
      expect(await betaRow.isVisible()).toBe(true);
      expect(await betaUp.isVisible()).toBe(true);
      expect(await backlogOrder()).toEqual(["backlog-alpha", "backlog-beta"]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a family row folds to its header, stays folded across a reload and a live update, and unfolds", async () => {
    const parentRelation = { id: "family", repository: "sample", number: 10, title: "Family parent", url: null, satisfied: false };
    const child = (id: string, number: number) => ({ ...issue(id, number, `Child ${number}`), parent: parentRelation, parentProgress: { done: 0, total: 2 } });
    const family = {
      ...issue("family", 10, "Family parent"),
      children: [
        { ...parentRelation, id: "child-a", number: 11, title: "Child 11", station: { index: 2, count: 5, name: "Reader" }, signal: "wait" as const },
        { ...parentRelation, id: "child-b", number: 12, title: "Child 12", station: { index: 3, count: 5, name: "After" }, signal: "wait" as const },
      ],
    };
    let revision = "revision-1";
    const build = (extra: IssueCardViewModel[] = []) => {
      const base = dashboard(revision, [family, child("child-a", 11), issue("stranger", 30, "Stranger"), ...extra], [issue("before-card", 1)]);
      return { ...base, stages: base.stages.map((column) => column.id === "after" ? stage("after", "After", [child("child-b", 12), issue("after-card", 99)]) : column) };
    };
    let currentDashboard = build();
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      await signIn(page, server.port);
      const state = () => page.evaluate(() => ({
        rowCards: [...document.querySelectorAll('[data-family-row="family"] article.issue')].map((card) => card.getAttribute("data-issue-id")),
        otherCards: [...document.querySelectorAll('[data-station-cell] article.issue')].map((card) => card.getAttribute("data-issue-id")),
        cellsHidden: ((cells) => cells.inert && cells.getBoundingClientRect().height === 0)(document.getElementById("family-family-cells") as HTMLElement & { inert: boolean }),
        expanded: document.querySelector('[data-row-fold="family-family"]')?.getAttribute("aria-expanded"),
        label: document.querySelector('[data-row-fold="family-family"]')?.getAttribute("aria-label"),
        parentIsCard: document.querySelector('article.issue[data-issue-id="family"]') !== null,
      }));

      // The children sit in the family's row, in their own stations; the parent is the row's header.
      expect(await state()).toEqual({
        rowCards: ["child-a", "child-b"], otherCards: ["before-card", "stranger", "after-card"],
        cellsHidden: false, expanded: "true", label: "Fold the #10 family", parentIsCard: false,
      });

      await page.locator('[data-row-fold="family-family"]').click();
      expect(await state()).toMatchObject({ cellsHidden: true, expanded: "false", label: "Unfold the #10 family" });
      await page.reload();
      expect(await state()).toMatchObject({ cellsHidden: true, expanded: "false" });

      // A live update keeps the row folded.
      const refresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      revision = "revision-2";
      currentDashboard = { ...build([issue("newcomer", 40, "Newcomer")]), revision };
      await refresh;
      await page.locator('article.issue[data-issue-id="newcomer"]').waitFor();
      expect(await state()).toMatchObject({ cellsHidden: true, expanded: "false" });

      // The header's Details opens the parent's details.
      await page.locator('[data-family-row="family"] .family-details').click();
      await page.waitForFunction(() => document.querySelector("dialog[open]") !== null);
      await page.keyboard.press("Escape");

      await page.locator('[data-row-fold="family-family"]').click();
      expect(await state()).toMatchObject({ cellsHidden: false, expanded: "true", label: "Fold the #10 family" });

      // Folding animates like an accordion where motion is allowed: the row's height passes through the
      // middle on its way to closed, and back.
      const animated = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
      await signIn(animated, server.port);
      await animated.waitForFunction(() => document.body.classList.contains("board-motion"));
      const cellsHeight = () => animated.evaluate(() => document.getElementById("family-family-cells")!.getBoundingClientRect().height);
      const open = await cellsHeight();
      await animated.locator('[data-row-fold="family-family"]').click();
      await animated.waitForTimeout(80);
      const midway = await cellsHeight();
      await animated.waitForTimeout(400);
      expect(open).toBeGreaterThan(50);
      expect(midway).toBeGreaterThan(0);
      expect(midway).toBeLessThan(open);
      expect(await cellsHeight()).toBe(0);
      await animated.locator('[data-row-fold="family-family"]').click();
      await animated.waitForTimeout(400);
      expect(await cellsHeight()).toBe(open);

      // On a phone a family's cards are indented under the parent band, the bottom row's are not, and
      // folding closes the row too.
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(phone, server.port);
      const left = (selector: string) => phone.evaluate((target) => document.querySelector(target)!.getBoundingClientRect().left, selector);
      const bandLeft = await left('[data-family-row="family"] .family-head');
      expect((await left('[data-family-row="family"] article.issue')) - bandLeft).toBeGreaterThanOrEqual(20);
      expect(Math.abs((await left('[data-station-cell] article.issue[data-issue-id="stranger"]')) - (await left('.other-row [data-station-cell="reader"] .board-cell-label')))).toBeLessThanOrEqual(2);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await phone.locator('[data-row-fold="family-family"]').click();
      expect(await phone.evaluate(() => ({
        inert: (document.getElementById("family-family-cells") as HTMLElement & { inert: boolean }).inert,
        // The cards keep their size inside a body that has closed to nothing.
        height: document.getElementById("family-family-cells")!.getBoundingClientRect().height,
      }))).toEqual({ inert: true, height: 0 });
    } finally {
      server.stop(true);
    }
  }, 30_000);
  test("tracing a stopped item lights its chain through a family, opens a folded row, survives a live update, and clears", async () => {
    const relation = (id: string, number: number, extra: object = {}) => ({ id, repository: "sample", number, title: `Item ${number}`, url: null, satisfied: false, ...extra });
    const stuck = { ...issue("stuck", 50, "Stuck"), tone: "danger" as const, state: "blocked" };
    const partA = { ...issue("part-a", 11, "Part A"), parent: relation("family", 10), parentProgress: { done: 0, total: 2 }, dependencies: [relation("stuck", 50, { signal: "stop", state: "Blocked" })] };
    const partB = { ...issue("part-b", 12, "Part B"), parent: relation("family", 10), parentProgress: { done: 0, total: 2 } };
    const family = { ...issue("family", 10, "Family parent"), children: [
      relation("part-a", 11, { station: { index: 2, count: 5, name: "Reader" }, signal: "wait" }),
      relation("part-b", 12, { station: { index: 3, count: 5, name: "After" }, signal: "wait" }),
    ] };
    const waitsOnFamily = { ...issue("downstream", 60, "Waits on the family"), dependencies: [relation("family", 10)] };
    let revision = "revision-1";
    const build = (extra: IssueCardViewModel[] = []) => {
      const base = dashboard(revision, [family, partA, stuck, waitsOnFamily, issue("stranger", 30, "Stranger"), ...extra], [issue("before-card", 1)]);
      return { ...base, stages: base.stages.map((column) => column.id === "after" ? stage("after", "After", [partB]) : column) };
    };
    let currentDashboard = build();
    const server = startDashboard({ dashboard: () => currentDashboard, revision: () => revision, delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      await signIn(page, server.port);
      const state = () => page.evaluate(() => ({
        roles: Object.fromEntries([...document.querySelectorAll("[data-trace-role]")].map((element) => [element.getAttribute("data-family-row") || element.getAttribute("data-issue-id"), element.getAttribute("data-trace-role")])),
        tags: [...document.querySelectorAll(".trace-role")].map((tag) => tag.textContent),
        banner: (document.querySelector("[data-trace-banner]") as HTMLElement).hidden ? null : document.querySelector("[data-trace-text]")?.textContent,
        familyCellsHidden: ((cells) => cells.inert && cells.getBoundingClientRect().height === 0)(document.getElementById("family-family-cells") as HTMLElement & { inert: boolean }),
        strangerOpacity: getComputedStyle(document.querySelector('article.issue[data-issue-id="stranger"]')!).opacity,
        pressed: [...document.querySelectorAll("[data-trace][aria-pressed=true]")].map((chip) => chip.getAttribute("data-trace")),
      }));

      // The family's row is folded; tracing the stuck item opens it, because part of the chain is inside.
      await page.locator('[data-row-fold="family-family"]').click();
      expect((await state()).familyCellsHidden).toBe(true);
      await page.locator('article.issue[data-issue-id="stuck"] .dep-chip--blocks').click();
      const result = await state();
      expect(result).toMatchObject({
        roles: { family: "down", "part-a": "down", stuck: "focus", downstream: "down" },
        familyCellsHidden: false, strangerOpacity: "0.25", pressed: ["stuck", "stuck"],
      });
      expect(result.banner).toBe("#50 (blocked): 1 waits on it directly (#11), 3 in all. It waits on nothing.");
      expect(result.tags.sort()).toEqual(["Traced", "Waiting on it", "Waiting on it", "Waiting on it"]);

      // Tracing from the other end: the item waiting on the family is held up by the family, its part, and the stuck item.
      await page.locator('article.issue[data-issue-id="downstream"] [data-trace="family"]').click();
      expect((await state()).roles).toEqual({ family: "focus", "part-a": "up", "part-b": "up", stuck: "up", downstream: "down" });

      // A live update keeps the trace.
      const refresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      revision = "revision-2";
      currentDashboard = { ...build([issue("newcomer", 40, "Newcomer")]), revision };
      await refresh;
      await page.locator('article.issue[data-issue-id="newcomer"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-family-row="family"]')?.getAttribute("data-trace-role") === "focus");

      // The banner clears it, and the folded row folds again; Escape clears a new trace too.
      await page.locator("[data-trace-clear]").click();
      expect(await state()).toMatchObject({ roles: {}, tags: [], banner: null, familyCellsHidden: true, strangerOpacity: "1", pressed: [] });
      await page.locator('article.issue[data-issue-id="stuck"] .dep-chip--blocks').click();
      await page.keyboard.press("Escape");
      expect((await state()).roles).toEqual({});
    } finally {
      server.stop(true);
    }
  }, 30_000);
  test("an answer shows that it is sending, then the board refreshes in place", async () => {
    let finishAnswer: (() => void) | undefined;
    let revision = "revision-1";
    let answered = false;
    const question = { id: "q-1", issueId: "card-1", repository: "sample", repositoryColor: 1, issueNumber: 3, issueTitle: "Card", prompt: "Which database?", reason: "It decides the schema.", options: [{ id: "postgres", label: "PostgreSQL" }], allowFreeText: false };
    const build = () => ({ ...dashboard(revision, [issue("card-1", 3, "Card")]), questions: answered ? [] : [question] });
    const server = startDashboard({
      dashboard: build, revision: () => revision, delayMs: () => 0,
      answerQuestion: () => new Promise<void>((resolve) => { finishAnswer = () => { answered = true; revision = "revision-2"; resolve(); }; }),
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
      await signIn(page, server.port);
      await page.evaluate(() => { (document.querySelector("main.dashboard") as unknown as { untouched: boolean }).untouched = true; });
      await page.locator('input[name="answer"][value="postgres"]').check();
      await page.locator(".answer-button").click();
      await page.waitForFunction(() => document.querySelector(".answer-button")?.textContent === "Answering…");
      expect(await page.locator(".answer-button").isDisabled()).toBe(true);
      finishAnswer?.();
      await page.waitForFunction(() => !document.querySelector(".needs-you-item--question"));
      // Patched in place: the page was not reloaded.
      expect(await page.evaluate(() => (document.querySelector("main.dashboard") as unknown as { untouched?: boolean }).untouched === true)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);
  test("approving a manual gate shows that it is sending, then the open item refreshes in place", async () => {
    let finishApproval: (() => void) | undefined;
    let revision = "gate-1";
    let approved = false;
    let boardRequired = false;
    const build = () => {
      const card = issue("card-1", 3, "Card");
      card.manualGates = [{ stageId: "review", gateId: null, kind: "board", required: boardRequired, waiting: !approved, approvedBy: approved ? "operator" : null, approvedAt: approved ? "2026-10-17T00:00:00.000Z" : null }];
      return dashboard(revision, [card]);
    };
    const server = startDashboard({
      dashboard: build, revision: () => revision, delayMs: () => 0,
      approveManualGate: () => new Promise<void>((resolve) => { finishApproval = () => { approved = true; revision = "gate-2"; resolve(); }; }),
      setBoardApprovalRequirement: (required) => { boardRequired = required; revision = `gate-switch-${String(required)}`; },
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
      await signIn(page, server.port);
      await page.evaluate(() => { (document.querySelector("main.dashboard") as unknown as { untouched: boolean }).untouched = true; });
      await page.locator('article.issue[data-issue-id="card-1"] .card-open').click();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open] .manual-gate-approve"));
      await page.locator("dialog.issue-details[open] .manual-gate-approve").click();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open] .manual-gate-approve")?.textContent === "Approving…");
      expect(await page.locator("dialog.issue-details[open] .manual-gate-approve").isDisabled()).toBe(true);
      finishApproval?.();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open]")?.textContent?.includes("Approved by operator"));
      // Patched in place: the page was not reloaded and the dialog stayed open.
      expect(await page.evaluate(() => (document.querySelector("main.dashboard") as unknown as { untouched?: boolean }).untouched === true)).toBe(true);
      expect(await page.locator("dialog.issue-details[open] .manual-gate-approve").count()).toBe(0);

      // The requirement is a switch: it moves at once and stays where the server put it.
      const toggle = page.locator("dialog.issue-details[open] .manual-gate-switch");
      expect(await toggle.getAttribute("aria-checked")).toBe("false");
      await toggle.click();
      expect(await toggle.getAttribute("aria-checked")).toBe("true");
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open] input[name="required"]')?.getAttribute("value") === "false");
      expect(await page.locator("dialog.issue-details[open] .manual-gate-switch").getAttribute("aria-checked")).toBe("true");
      expect(await page.evaluate(() => (document.querySelector("main.dashboard") as unknown as { untouched?: boolean }).untouched === true)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);
  test("keeps a newly opened item visible when a delayed approval refresh finishes", async () => {
    let revision = "approval-1";
    let approved = false;
    let refreshDelay = 0;
    const build = () => {
      const approvedCard = { ...issue("approved", 3, "Approval item"), state: approved ? "active" : "needs-input" };
      approvedCard.manualGates = [{ stageId: "review", gateId: null, kind: "board", required: false, waiting: !approved, approvedBy: approved ? "operator" : null, approvedAt: approved ? "2026-10-17T00:00:00.000Z" : null }];
      return dashboard(revision, [approvedCard, issue("next", 4, "Next item")]);
    };
    const server = startDashboard({
      dashboard: build, revision: () => revision, delayMs: () => refreshDelay,
      detailsDelayMs: (issueId) => issueId === "next" ? 200 : 0,
      approveManualGate: async () => { approved = true; revision = "approval-2"; },
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);

      await page.locator('article.issue[data-issue-id="approved"] .card-open').click();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open] .manual-gate-approve"));
      await page.locator("dialog.issue-details[open] .manual-gate-approve").click();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open]")?.textContent?.includes("Approved by operator"));

      refreshDelay = 1_000;
      const delayedRefresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      const refreshStarted = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).pathname === "/board");
      await Promise.all([page.waitForURL("**/board"), page.keyboard.press("Escape")]);
      await refreshStarted;
      await page.locator('article.issue[data-issue-id="next"] .card-open').click();
      await page.waitForURL("**/issues/sample/4");
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]')?.getAttribute('data-issue-id') === 'next');
      await delayedRefresh;

      expect(await page.locator('dialog.issue-details[open]').getAttribute('data-issue-id')).toBe("next");
      expect(page.url()).toContain("/issues/sample/4");
      expect(await page.locator('article.issue[data-issue-id="approved"]').getAttribute("data-state-word")).toBe("Needs input");
      await page.keyboard.press("Escape");
      await page.waitForURL("**/board");
      await page.locator('article.issue[data-issue-id="approved"][data-state-word="Queued"]').waitFor();
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps a newly opened item visible when a delayed board-approval switch refresh finishes", async () => {
    let revision = "switch-1";
    let required = false;
    let refreshDelay = 0;
    const build = () => {
      const switchCard = issue("switch", 3, required ? "Approval required" : "Approval optional");
      switchCard.manualGates = [{ stageId: "review", gateId: null, kind: "board", required, waiting: false, approvedBy: null, approvedAt: null }];
      return dashboard(revision, [switchCard, issue("next", 4, "Next item")]);
    };
    const server = startDashboard({
      dashboard: build, revision: () => revision, delayMs: () => refreshDelay,
      detailsDelayMs: (issueId) => issueId === "next" ? 200 : 0,
      setBoardApprovalRequirement: (nextRequired) => { required = nextRequired; revision = "switch-2"; },
    });
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await signIn(page, server.port);

      await page.locator('article.issue[data-issue-id="switch"] .card-open').click();
      await page.waitForFunction(() => document.querySelector("dialog.issue-details[open] .manual-gate-switch"));
      await page.locator("dialog.issue-details[open] .manual-gate-switch").click();
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open] input[name="required"]')?.getAttribute("value") === "false");

      refreshDelay = 1_000;
      const delayedRefresh = page.waitForResponse((response) => response.request().resourceType() === "fetch" && new URL(response.url()).pathname === "/board");
      const refreshStarted = page.waitForRequest((request) => request.resourceType() === "fetch" && new URL(request.url()).pathname === "/board");
      await Promise.all([page.waitForURL("**/board"), page.keyboard.press("Escape")]);
      await refreshStarted;
      await page.locator('article.issue[data-issue-id="next"] .card-open').click();
      await page.waitForURL("**/issues/sample/4");
      await page.waitForFunction(() => document.querySelector('dialog.issue-details[open]')?.getAttribute('data-issue-id') === 'next');
      await delayedRefresh;

      expect(await page.locator('dialog.issue-details[open]').getAttribute('data-issue-id')).toBe("next");
      expect(page.url()).toContain("/issues/sample/4");
      expect(await page.locator('article.issue[data-issue-id="switch"] .issue-title').textContent()).toBe("Approval optional");
      await page.keyboard.press("Escape");
      await page.waitForURL("**/board");
      await page.locator('article.issue[data-issue-id="switch"] .issue-title').filter({ hasText: "Approval required" }).waitFor();
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps empty desktop stage headers readable after scrolling and preserves the phone stage controls", async () => {
    const longStageName = "A configured stage name that remains available to assistive technology";
    const headerDashboard = {
      ...dashboard("stage-headers-1", [issue("implementation-card", 20, "Implementation card")]),
      stages: [
        stage("refinement-review", "Refinement Review", []),
        stage("work-breakdown", "Work Breakdown", []),
        stage("implementation", "Implementation", [issue("implementation-card", 20, "Implementation card")]),
        stage("configured", longStageName, []),
      ],
    };
    const server = startDashboard({ dashboard: () => headerDashboard, revision: () => "stage-headers-1", delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const desktop = await browser.newPage({ viewport: { width: 1024, height: 800 }, reducedMotion: "reduce" });
      await signIn(desktop, server.port);

      const headerLayout = await desktop.evaluate(() => {
        const rect = (element: Element | null) => {
          const box = element?.getBoundingClientRect();
          return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
        };
        return ["refinement-review", "work-breakdown", "implementation"].map((id) => {
          const stage = document.getElementById(`station-${id}`);
          const heading = stage?.querySelector("h2") as HTMLElement | null;
          const info = stage?.querySelector(".stage-info") ?? null;
          const count = stage?.querySelector(".count") ?? null;
          const column = document.querySelector(`.board-column:nth-child(${Array.from(document.querySelectorAll(".board-head > .stage")).indexOf(stage as HTMLElement) + 1})`);
          return {
            id,
            headingFits: heading !== null && heading.scrollWidth <= heading.clientWidth && heading.scrollHeight <= heading.clientHeight,
            stage: rect(stage),
            column: rect(column),
            info: rect(info),
            count: rect(count),
          };
        });
      });
      for (const header of headerLayout) {
        expect(header.headingFits).toBe(true);
        expect(header.stage).not.toBeNull();
        expect(header.column).not.toBeNull();
        expect(header.info).not.toBeNull();
        expect(header.count).not.toBeNull();
        expect(Math.abs(header.stage!.left - header.column!.left)).toBeLessThanOrEqual(1);
        expect(header.info!.width).toBeGreaterThanOrEqual(24);
        expect(header.info!.right).toBeLessThanOrEqual(header.count!.left);
      }
      expect(await desktop.getByRole("heading", { name: longStageName }).count()).toBe(1);

      await desktop.locator(".board").evaluate((board) => { board.scrollLeft = 350; });
      const workBreakdownInfo = desktop.getByRole("button", { name: "About Work Breakdown" });
      await workBreakdownInfo.click();
      await desktop.waitForFunction(() => document.querySelector("#stage-info-work-breakdown")?.hasAttribute("open"));
      await desktop.locator("#stage-info-work-breakdown .stage-dialog-close").click();
      await workBreakdownInfo.focus();
      await desktop.keyboard.press("Enter");
      await desktop.waitForFunction(() => document.querySelector("#stage-info-work-breakdown")?.hasAttribute("open"));

      const phone = await browser.newPage({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(phone, server.port);
      const labels = phone.locator(".board-cell-label");
      expect(await labels.count()).toBeGreaterThanOrEqual(3);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const implementationInfo = phone.getByRole("button", { name: "About Implementation" });
      await implementationInfo.focus();
      await phone.keyboard.press("Enter");
      await phone.waitForFunction(() => document.querySelector("#stage-info-implementation")?.hasAttribute("open"));
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("the line is open on a wide screen and closed on a phone until the reader folds or opens it", async () => {
    const server = startDashboard({ dashboard: () => dashboard("revision-1", [issue("card-1", 3, "Card")]), revision: () => "revision-1", delayMs: () => 0 });
    try {
      browser = await chromium.launch({ headless: true });
      const lineState = (page: Awaited<ReturnType<Browser["newPage"]>>) => page.evaluate(() => ({
        expanded: document.querySelector("[data-line-toggle]")?.getAttribute("aria-expanded"),
        height: document.getElementById("line-stations")!.getBoundingClientRect().height,
        inert: (document.getElementById("line-stations") as HTMLElement & { inert: boolean }).inert,
      }));
      const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      await signIn(desktop, server.port);
      expect(await lineState(desktop)).toMatchObject({ expanded: "true", inert: false });
      // Folding animates once the first state has painted.
      await desktop.waitForFunction(() => document.body.classList.contains("board-motion"));
      expect((await lineState(desktop)).height).toBeGreaterThan(20);

      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      await signIn(phone, server.port);
      expect(await lineState(phone)).toEqual({ expanded: "false", height: 0, inert: true });
      await phone.locator("[data-line-toggle]").click();
      expect(await lineState(phone)).toMatchObject({ expanded: "true", inert: false });
      // The choice is remembered: after a reload the phone keeps the line open.
      await phone.reload();
      expect(await lineState(phone)).toMatchObject({ expanded: "true", inert: false });
      expect((await lineState(phone)).height).toBeGreaterThan(20);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
