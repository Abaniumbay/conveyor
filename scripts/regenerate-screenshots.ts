#!/usr/bin/env bun
// Regenerate dashboard screenshots from a disposable, self-contained Conveyor instance.
// Usage: bun run docs:screenshots

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { ConveyorStore, type IssueProjection } from "../src/db/store";
import { ReviewFindings } from "../src/engine/review-findings";

const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo-password-12chars";
const DEMO_TIMEOUT = 30_000;
const DEMO_TIME = "2026-09-15T12:00:00.000Z";
const DEMO_FINISHED_TIME = "2026-09-15T12:01:32.000Z";
const OUTPUT_DIRECTORY = path.join("docs", "screenshots");
const PHONE_OVERFLOW_REPOSITORY = "MobileViewportRegressionContentMustWrapWithoutCreatingADocumentWideHorizontalScrollRange";
const PHONE_OVERFLOW_ADDRESS = "demo/PhoneWidthAddressMustWrapWithoutCreatingDocumentWideHorizontalOverflow";
const DEGRADED_STATUS = "simulated provider outage for screenshot coverage";
const PHONE_TRUST_WARNING = "The source visibility check remains uncertain while the simulated provider outage is investigated for this deliberately long phone-width status message.";
const PHONE_TRUSTED_LOGIN = "phone-width-trusted-login-0000000000000";
// This folder is rendered in the superuser Setup section. Keep its display value
// independent of the host's temporary-directory configuration.
const SCREENSHOT_WORKSPACE = "/tmp/conveyor-screenshot-workspace";
const DEMO_SOURCE_ISSUES = [
  {
    id: 10_001,
    number: 1,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/1",
    title: "Ship a reliable dashboard overview",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:implementation", "conveyor:no-split"],
    updated_at: DEMO_TIME,
  },
  {
    id: 10_002,
    number: 2,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/2",
    title: "Review accessible status indicators",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:review"],
    updated_at: DEMO_TIME,
  },
  {
    id: 10_003,
    number: 3,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/3",
    title: "Plan release communications",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:refinement"],
    updated_at: DEMO_TIME,
  },
  {
    id: 10_004,
    number: 4,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/4",
    title: "Choose the migration strategy",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"],
    updated_at: DEMO_TIME,
  },
  {
    id: 10_005,
    number: 5,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/5",
    title: "Investigate the rollout alert",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"],
    updated_at: DEMO_TIME,
  },
] as const;

let demoHome: string | null = null;
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

async function reserveListenAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string")
    throw new Error("Could not reserve an isolated demo port");
  return `127.0.0.1:${address.port}`;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + DEMO_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status === 200 || response.status === 302) return;
    } catch {
      // The server is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Demo server did not become ready within ${DEMO_TIMEOUT / 1000}s`,
  );
}

async function cleanup(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await serverProcess.exited.catch(() => {});
    serverProcess = null;
  }
  if (demoHome) {
    await rm(demoHome, { recursive: true, force: true }).catch(() => {});
    demoHome = null;
  }
}

async function runCli(
  args: string[],
  environment: Record<string, string>,
): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`conveyor ${args[0]} failed with exit code ${exitCode}`);
}

async function configureDemo(
  home: string,
  listen: string,
): Promise<Record<string, string>> {
  const binDirectory = path.join(home, "bin");
  // This is displayed on the repository detail page, so it must not contain the
  // randomized demo-home suffix when screenshot regeneration is compared.
  const workspace = SCREENSHOT_WORKSPACE;
  const passwordFile = path.join(home, "admin-password");
  const githubLog = path.join(home, "github-requests.log");
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  // The only `gh` available to the demo server is this local stub. It has no credentials and
  // serves a fixed local source snapshot, so startup cannot contact or import a real account.
  const githubStub = path.join(binDirectory, "gh");
  const sourceSnapshot = JSON.stringify(DEMO_SOURCE_ISSUES);
  await writeFile(
    githubStub,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      'printf \'%s\\n\' "$*" >> "$CONVEYOR_DEMO_GH_LOG"',
      'case "$*" in',
      `  *\"/repos/demo/dashboard-demo/issues?state=all\"*) printf '%s\\n' '${sourceSnapshot}' ;;`,
      // Keep one configured repository visibly degraded without talking to a real provider.
      `  *repos/${PHONE_OVERFLOW_ADDRESS}*) printf '%s\\n' '${DEGRADED_STATUS}: ${PHONE_TRUST_WARNING}' >&2; exit 1 ;;`,
      "  *\"--method POST\"*) printf '%s\\n' '{}' ;;",
      "  *) printf '%s\\n' '[]' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(githubStub, 0o700);

  const environment = {
    HOME: home,
    PATH: `${binDirectory}:/usr/local/bin:/usr/bin:/bin`,
    GH_CONFIG_DIR: path.join(home, "github-config"),
    CONVEYOR_HOME: home,
    CONVEYOR_DEMO_GH_LOG: githubLog,
  };
  await writeFile(passwordFile, DEMO_PASSWORD, { mode: 0o600 });
  try {
    await runCli(
      [
        "init",
        "--home",
        home,
        "--admin-username",
        DEMO_USERNAME,
        "--admin-password-file",
        passwordFile,
      ],
      environment,
    );
  } finally {
    await rm(passwordFile, { force: true });
  }

  const configPath = path.join(home, "config", "conveyor.yaml");
  const repositoriesDirectory = path.join(home, "config", "repositories");
  const repositories = [
    { id: "demo", address: "demo/dashboard-demo", ci: ["  mode: disabled"] },
    {
      id: PHONE_OVERFLOW_REPOSITORY,
      address: PHONE_OVERFLOW_ADDRESS,
      ci: ["  provider: actions", "  mode: advisory"],
      extraTrustedLogins: [PHONE_TRUSTED_LOGIN],
    },
  ];
  let config = await readFile(configPath, "utf8");
  config = config.replace(
    "listen: 127.0.0.1:7788",
    `listen: ${listen}\n  steering:\n    agent: omid\n    workspace: ${workspace}`,
  );
  await writeFile(configPath, config);
  await mkdir(repositoriesDirectory, { recursive: true });
  await Promise.all(repositories.map((repository) =>
    writeFile(
      path.join(repositoriesDirectory, `${repository.id}.yaml`),
      [
        "source: github",
        "codeHost: github",
        `address: ${repository.address}`,
        `folder: ${workspace}`,
        "baseBranch: main",
        "pipeline: delivery",
        ...(repository.extraTrustedLogins
          ? ["extraTrustedLogins:", ...repository.extraTrustedLogins.map((login) => `  - ${login}`)]
          : []),
        "ci:",
        // The long repository shows a stored CI chip; the demo repository shows none.
        ...repository.ci,
        "agentEgress:",
        "  allowLoopbackMcp: true",
        "  httpsHosts: []",
        "",
      ].join("\n"),
    ),
  ));
  return environment;
}

function issue(number: number, title: string, stage: string): IssueProjection {
  return {
    id: `demo#${number}`,
    repositoryId: "demo",
    sourceNumber: number,
    sourceUrl: `https://github.invalid/demo/dashboard-demo/issues/${number}`,
    title,
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    sourceState: "open",
    sourceStateReason: null,
    labels: ["conveyor", `conveyor:${stage}`],
    sourceUpdatedAt: DEMO_TIME,
  };
}

function usage(amount: number) {
  return {
    inputTokens: 12_400,
    outputTokens: 3_800,
    cachedTokens: 1_600,
    amount,
    currency: "USD",
    source: "demo",
    durationMs: 92_000,
  };
}

async function seedDemo(home: string): Promise<void> {
  const store = await ConveyorStore.open(
    path.join(home, "state", "conveyor.sqlite"),
  );
  try {
    store.upsertRepository({
      id: "demo",
      configName: "demo",
      source: "github",
      address: "demo/dashboard-demo",
      folder: path.join(home, "workspace"),
      configHash: "demo-config",
    });
    store.upsertRepository({
      id: PHONE_OVERFLOW_REPOSITORY,
      configName: PHONE_OVERFLOW_REPOSITORY,
      source: "github",
      address: PHONE_OVERFLOW_ADDRESS,
      folder: path.join(home, "workspace"),
      configHash: "demo-config",
    });
    const issues = [
      {
        ...issue(1, "Ship a reliable dashboard overview", "implementation"),
        labels: ["conveyor", "conveyor:implementation", "conveyor:no-split"],
      },
      issue(2, "Review accessible status indicators", "review"),
      issue(3, "Plan release communications", "refinement"),
      {
        ...issue(4, "Choose the migration strategy", "implementation"),
        labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"],
      },
      {
        ...issue(5, "Investigate the rollout alert", "implementation"),
        labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"],
      },
    ];
    const phoneOverflowIssue = {
      ...issue(6, "Keep repository controls reachable on phone widths", "review"),
      id: `${PHONE_OVERFLOW_REPOSITORY}#6`,
      repositoryId: PHONE_OVERFLOW_REPOSITORY,
    };
    issues.push(phoneOverflowIssue);
    for (let number = 7; number <= 42; number += 1) {
      issues.push(issue(number, `Keep the long implementation board card ${number}`, "implementation"));
    }
    for (const entry of issues) store.upsertIssue(entry);
    store.setRepositoryTrustStatus({
      repositoryId: PHONE_OVERFLOW_REPOSITORY,
      visibility: "unknown",
      checkedAt: DEMO_TIME,
      warning: PHONE_TRUST_WARNING,
    });
    new ReviewFindings(store.sqlite()).importNative(phoneOverflowIssue.id, [{
      providerKey: "screenshot-ignored-review",
      author: "untrusted-phone-reviewer",
      trusted: false,
      body: "This review text is intentionally absent from the dashboard screenshot.",
      url: "https://example.com/reviews/screenshot-ignored-review",
      path: null,
      line: null,
      resolved: false,
    }], "demo-head", DEMO_TIME);
    // A CI chip carries visually hidden text. In a stage scrolled out of view at phone widths it
    // must not widen the document, which verifyPhoneLayouts checks.
    store.saveIndicator(
      phoneOverflowIssue.id,
      "demo-head",
      {
        id: "ci",
        label: "CI",
        state: "passing",
        detail: "3/3 passed",
        progress: "3/3",
        url: null,
        observedAt: DEMO_TIME,
        entries: [],
        reference: null,
      },
      true,
    );
    store.setIssueProjection("demo#1", {
      stage: "implementation",
      state: "active",
      warning: null,
    });
    store.setIssueProjection("demo#2", {
      stage: "review",
      state: "active",
      warning: null,
    });
    store.setIssueProjection("demo#3", {
      stage: "refinement",
      state: "active",
      warning: null,
    });
    store.setIssueProjection("demo#4", {
      stage: "implementation",
      state: "blocked",
      warning: "Awaiting a product decision",
    });
    store.setIssueProjection("demo#5", {
      stage: "implementation",
      state: "blocked",
      warning: "Investigating the rollout alert",
    });
    store.setIssueProjection(phoneOverflowIssue.id, {
      stage: "review",
      state: "active",
      warning: null,
    });
    for (let number = 7; number <= 42; number += 1) {
      store.setIssueProjection(`demo#${number}`, {
        stage: "implementation",
        state: "active",
        warning: null,
      });
    }
    for (const [id, stage, status] of [
      ["demo#1", "implementation", "completed"],
      ["demo#2", "review", "completed"],
      ["demo#3", "refinement", "completed"],
      ["demo#4", "implementation", "stopped"],
      ["demo#5", "implementation", "stopped"],
      [phoneOverflowIssue.id, "review", "completed"],
    ] as const)
      store.setStageState({
        issueId: id,
        stageId: stage,
        status,
        feedbackCycle: 0,
        configHash: "demo-config",
      });
    for (let number = 7; number <= 42; number += 1) {
      store.setStageState({
        issueId: `demo#${number}`,
        stageId: "implementation",
        status: "completed",
        feedbackCycle: 0,
        configHash: "demo-config",
      });
    }

    store.createRun({
      id: "demo-implementation-run",
      issueId: "demo#1",
      stageId: "implementation",
      attempt: 1,
      kind: "stage",
      status: "running",
      configHash: "demo-config",
      startedAt: DEMO_TIME,
    });
    store.appendRunEvent("demo-implementation-run", "report", {
      text: "Implemented the dashboard layout and verified the focused checks.",
    });
    store.appendRunEvent("demo-implementation-run", "report", {
      text: "Prepared the change for review with deterministic evidence.",
    });
    store.finishRun("demo-implementation-run", {
      status: "succeeded",
      exitCode: 0,
      result: { summary: "Demo implementation completed" },
      sessionId: "demo-session",
      finishedAt: DEMO_FINISHED_TIME,
      usage: usage(0.1842),
    });
    store.createRun({
      id: "demo-steering-run",
      issueId: null,
      stageId: "steering",
      attempt: 1,
      kind: "steering",
      status: "running",
      configHash: "demo-config",
      startedAt: DEMO_TIME,
    });
    store.appendRunEvent("demo-steering-run", "user", {
      text: "Show the latest delivery activity.",
    });
    store.appendRunEvent("demo-steering-run", "report", {
      text: "The implementation is ready for review and one item needs your decision.",
    });
    store.finishRun("demo-steering-run", {
      status: "succeeded",
      exitCode: 0,
      result: { summary: "Demo operator response" },
      sessionId: "demo-steering-session",
      finishedAt: DEMO_FINISHED_TIME,
      usage: usage(0.0315),
    });

    store.appendConversationMessage({
      issueId: "demo#1",
      runId: "demo-implementation-run",
      stageId: "implementation",
      actorType: "agent",
      actorId: "jamshid",
      actorName: "Jamshid",
      actorTitle: "Developer",
      message:
        "The dashboard overview is implemented with a populated demo fixture.",
    });
    store.appendConversationMessage({
      issueId: "demo#1",
      runId: "demo-implementation-run",
      stageId: "implementation",
      actorType: "conveyor",
      actorId: "conveyor",
      actorName: "Conveyor",
      actorTitle: "Orchestrator",
      message: "Focused checks passed; the item is ready for review.",
    });
    store.openQuestion({
      issueId: "demo#4",
      runId: null,
      prompt: "Which migration path should the team use?",
      reason: "The implementation cannot continue without this choice.",
      options: [
        { id: "incremental", label: "Incremental migration" },
        { id: "cutover", label: "Single cutover" },
      ],
    });
    store.beginStageTransition({
      id: "demo-transition-1",
      issueId: "demo#1",
      fromStage: "refinement",
      toStage: "implementation",
      kind: "advance",
      sourceMutationId: null,
      detail: {
        reason: "The plan was approved for implementation.",
        requiredFixes: [],
        resultStatus: "succeeded",
        actor: { name: "Conveyor", title: "Orchestrator" },
      },
    });
    store.completeStageTransition("demo-transition-1");
    store.beginStageTransition({
      id: "demo-transition-5",
      issueId: "demo#5",
      fromStage: "implementation",
      toStage: "implementation",
      kind: "stopped",
      sourceMutationId: null,
      detail: {
        reason: "A rollout owner must confirm the alert is resolved before implementation can resume.",
        requiredFixes: [],
        resultStatus: "blocked",
        actor: { name: "Conveyor", title: "Orchestrator" },
      },
    });
    store.completeStageTransition("demo-transition-5");
  } finally {
    store.close();
  }
}

async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  // Live refreshes re-render elapsed times; keep them pinned for the capture.
  await page.evaluate(() => {
    const pin = () =>
      document.querySelectorAll("[data-relative-time], time").forEach((node) => {
        if (node.textContent !== "demo time") node.textContent = "demo time";
      });
    pin();
    new MutationObserver(pin).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await page.evaluate(() => document.fonts.ready);
  // The header shows "Connecting" until the live stream opens; capture only the settled state.
  await page
    .locator("[data-connection-state]")
    .filter({ hasText: "Connected" })
    .waitFor({ state: "attached", timeout: 10_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function expectText(page: Page, text: string): Promise<void> {
  const candidates = page.getByText(text, { exact: false });
  let element: Locator | null = null;
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) {
      element = candidate;
      break;
    }
  }
  if (!element) throw new Error(`Visible text was not found: ${text}`);
  const bounds = await element.evaluate((node) => {
    const { bottom, top } = node.getBoundingClientRect();
    return { bottom, top, viewportHeight: window.innerHeight };
  });
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight) {
    throw new Error(`Primary content is clipped: ${text}`);
  }
}

async function expectReachableElement(
  element: Locator,
  description: string,
): Promise<void> {
  await element.waitFor({ state: "visible", timeout: 10_000 });
  await element.scrollIntoViewIfNeeded();
  const bounds = await element.evaluate((node) => {
    const { bottom, left, right, top } = node.getBoundingClientRect();
    return { bottom, left, right, top, viewportHeight: window.innerHeight, viewportWidth: window.innerWidth };
  });
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight || bounds.left < 0 || bounds.right > bounds.viewportWidth) {
    throw new Error(`Reachable content is clipped: ${description}`);
  }
}

async function expectReachableText(page: Page, text: string): Promise<void> {
  await expectReachableElement(page.getByText(text, { exact: false }).first(), text);
}

async function expectReachableHealth(page: Page, health: "Healthy" | "Degraded"): Promise<void> {
  await expectReachableElement(page.getByRole("img", { name: health }).first(), health);
}

async function expectDocumentToFitPhoneViewport(
  page: Page,
  name: string,
  width: number,
): Promise<void> {
  const dimensions = await page.evaluate(() => {
    const root = document.documentElement;
    window.scrollTo({ top: root.scrollHeight });
    const result = { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth };
    window.scrollTo({ top: 0 });
    return result;
  });
  if (dimensions.scrollWidth > dimensions.clientWidth) {
    throw new Error(
      `${name} has document-wide horizontal overflow at ${width}px (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px)`,
    );
  }
}

async function expectNonScrollerContentToFitPhoneViewport(
  page: Page,
  name: string,
  width: number,
): Promise<void> {
  const outsideViewport = await page.evaluate(() => {
    const intentionalHorizontalScrollers = ".board,.tabs,.details-tabs,.report-table-wrap,.mini-line,.agent-history ol";
    const root = document.documentElement;
    const previousScrollTop = window.scrollY;
    window.scrollTo({ top: root.scrollHeight });
    const description = (element: HTMLElement) => {
      const classes = [...element.classList].slice(0, 2).join(".");
      return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
    };

    const outsideViewport = [...document.body.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      if (
        bounds.width === 0 ||
        bounds.height === 0 ||
        bounds.right <= window.innerWidth + 1 ||
        element.closest("details:not([open])") ||
        element.closest(intentionalHorizontalScrollers)
      ) return [];
      return [{ element: description(element), right: Math.ceil(bounds.right) }];
    }).slice(0, 10);
    window.scrollTo({ top: previousScrollTop });
    return outsideViewport;
  });
  if (outsideViewport.length > 0) {
    throw new Error(
      `${name} has non-scroller content beyond the ${width}px viewport: ${JSON.stringify(outsideViewport)}`,
    );
  }
}

async function expectLastChildReachable(
  page: Page,
  containerSelector: string,
  childSelector: string,
  name: string,
  requireOverflow = false,
): Promise<void> {
  const result = await page.locator(containerSelector).first().evaluate(
    (container, selector) => {
      const children = container.querySelectorAll<HTMLElement>(selector);
      const lastChild = children.item(children.length - 1);
      if (!lastChild)
        return { found: false, hasOverflow: false, reachable: false };

      container.scrollLeft = container.scrollWidth;
      const containerBounds = container.getBoundingClientRect();
      const childBounds = lastChild.getBoundingClientRect();
      return {
        found: true,
        hasOverflow: container.scrollWidth > container.clientWidth,
        reachable:
          childBounds.left >= containerBounds.left - 1 &&
          childBounds.right <= containerBounds.right + 1,
        childLeft: childBounds.left,
        childRight: childBounds.right,
        containerLeft: containerBounds.left,
        containerRight: containerBounds.right,
      };
    },
    childSelector,
  );
  if (!result.found || !result.reachable || (requireOverflow && !result.hasOverflow)) {
    throw new Error(
      `${name} is not reachable through its horizontal scroller: ${JSON.stringify(result)}`,
    );
  }
}

async function expectStickyDashboard(page: Page, maximumHeight?: number): Promise<void> {
  const bounds = await page.locator(".dashboard-sticky").evaluate((sticky) => {
    const tabs = sticky.querySelector<HTMLElement>(".tabs");
    const needsYou = sticky.querySelector<HTMLElement>(".needs-you-link");
    const box = sticky.getBoundingClientRect();
    const tabBox = tabs?.getBoundingClientRect();
    const needsYouBox = needsYou?.getBoundingClientRect();
    return {
      bottom: box.bottom,
      height: box.height,
      needsYouVisible: !!needsYouBox && needsYouBox.top >= 0 && needsYouBox.bottom <= innerHeight,
      tabsVisible: !!tabBox && tabBox.top >= 0 && tabBox.bottom <= innerHeight,
      top: box.top,
      viewportHeight: innerHeight,
    };
  });
  if (bounds.top < -1 || bounds.top > 12 || !bounds.tabsVisible || !bounds.needsYouVisible || (maximumHeight !== undefined && bounds.height > maximumHeight)) {
    throw new Error(`Dashboard navigation is not sticky and compact: ${JSON.stringify(bounds)}`);
  }
}

async function verifyStickyThemeBackgrounds(page: Page): Promise<void> {
  const backgrounds: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    const background = await page.locator(".dashboard-sticky").evaluate((sticky, currentTheme) => {
      document.documentElement.dataset.theme = currentTheme;
      localStorage.setItem("conveyor-theme", currentTheme);
      return getComputedStyle(sticky).backgroundColor;
    }, theme);
    if (background === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(background))
      throw new Error(`Sticky navigation has a transparent ${theme} theme background: ${background}`);
    backgrounds.push(background);
  }
  if (backgrounds[0] === backgrounds[1])
    throw new Error(`Sticky navigation did not apply distinct light and dark backgrounds: ${backgrounds[0]}`);
  await page.locator(".dashboard-sticky").evaluate(() => {
    document.documentElement.dataset.theme = "light";
    localStorage.setItem("conveyor-theme", "light");
  });
}

async function scrollBoardAndExpectSticky(page: Page): Promise<void> {
  const scroll = await page.locator(".board.board--rows").evaluate((board) => {
    board.scrollTop = 2_000;
    return { maximum: board.scrollHeight - board.clientHeight, top: board.scrollTop };
  });
  if (scroll.maximum < 2_000 || scroll.top < 1_900)
    throw new Error(`The populated board did not scroll about 2000px: ${JSON.stringify(scroll)}`);
  await expectStickyDashboard(page);
  const stage = await page.locator(".board-head").evaluate((head) => {
    const bounds = head.getBoundingClientRect();
    return { bottom: bounds.bottom, top: bounds.top };
  });
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  if (stage.top < 0 || stage.bottom > viewportHeight)
    throw new Error(`The scrolled board stage header is not visible: ${JSON.stringify(stage)}`);
}

async function scrollPhoneBoardAndExpectSticky(page: Page): Promise<void> {
  const scroll = await page.evaluate(() => {
    window.scrollTo(0, 2_000);
    return {
      maximum: document.documentElement.scrollHeight - window.innerHeight,
      top: window.scrollY,
    };
  });
  if (scroll.maximum < 2_000 || scroll.top < 1_900)
    throw new Error(`The populated phone board did not scroll about 2000px: ${JSON.stringify(scroll)}`);
  await expectStickyDashboard(page, 100);
}

async function verifyPhoneStickyNavigation(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
  await stabilize(page);
  await expectStickyDashboard(page, 100);
  const headerHeight = await page.locator(".dashboard-header").evaluate((header) => header.getBoundingClientRect().height);
  if (headerHeight > 56)
    throw new Error(`Phone dashboard header is taller than 56px: ${headerHeight}px`);

  await page.locator(".server-status > summary").click();
  await expectReachableElement(page.locator(".server-popover"), "System popover");
  await expectReachableText(page, "runners");
  await expectReachableText(page, "Notifications");
  await page.getByRole("button", { name: "Dark" }).waitFor({ state: "visible" });
  await page.locator(".server-status > summary").click();

  await page.locator(".account-menu > summary").click();
  await expectReachableElement(page.locator(".account-popover"), "Account popover");
  await page.locator(".account-menu > summary").click();

  await page.locator('.tabs a[href="/operator"]').click();
  await page.locator('.tabs a[aria-current="page"]').filter({ hasText: "Operator" }).waitFor({ state: "visible" });
  const activeTab = await page.locator('.tabs a[aria-current="page"]').evaluate((tab) => {
    const tabBounds = tab.getBoundingClientRect();
    const tabsBounds = tab.parentElement!.getBoundingClientRect();
    return { left: tabBounds.left, right: tabBounds.right, tabsLeft: tabsBounds.left, tabsRight: tabsBounds.right };
  });
  if (activeTab.left < activeTab.tabsLeft || activeTab.right > activeTab.tabsRight)
    throw new Error(`Active phone tab is outside its scroller: ${JSON.stringify(activeTab)}`);

  await page.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
  await stabilize(page);
}

async function verifyAnchorOffset(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/board#needs-you-heading`, { waitUntil: "networkidle" });
  await page.locator("#needs-you-heading").waitFor({ state: "visible", timeout: 10_000 });
  const needsYou = await page.locator("#needs-you-heading").evaluate((heading) => {
    const sticky = document.querySelector<HTMLElement>(".dashboard-sticky")!;
    return { headingTop: heading.getBoundingClientRect().top, stickyBottom: sticky.getBoundingClientRect().bottom };
  });
  if (needsYou.headingTop < needsYou.stickyBottom)
    throw new Error(`Needs you anchor landed beneath sticky navigation: ${JSON.stringify(needsYou)}`);

  await page.locator(".skip-link").focus();
  await page.locator(".skip-link").click();
  const content = await page.locator("#content").evaluate((target) => {
    const sticky = document.querySelector<HTMLElement>(".dashboard-sticky")!;
    return { targetTop: target.getBoundingClientRect().top, stickyBottom: sticky.getBoundingClientRect().bottom };
  });
  if (content.targetTop < content.stickyBottom)
    throw new Error(`Skip link landed beneath sticky navigation: ${JSON.stringify(content)}`);

  await page.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
  await stabilize(page);
  const stationLink = page.locator("[data-station-link]").first();
  const stationTarget = await stationLink.getAttribute("href");
  if (!stationTarget?.startsWith("#"))
    throw new Error("Expected the board to provide a line-station anchor link.");
  await stationLink.focus();
  await page.keyboard.press("Enter");
  const station = await page.locator(stationTarget).evaluate((target) => {
    const sticky = document.querySelector<HTMLElement>(".dashboard-sticky")!;
    return { targetTop: target.getBoundingClientRect().top, stickyBottom: sticky.getBoundingClientRect().bottom };
  });
  if (station.targetTop < station.stickyBottom)
    throw new Error(`Station anchor landed beneath sticky navigation: ${JSON.stringify(station)}`);
}

async function verifyPhoneLayouts(page: Page, baseUrl: string): Promise<void> {
  const pages = [
    ["board", "/board"],
    ["repositories", "/repositories"],
    ["repository detail", `/repositories/${encodeURIComponent(PHONE_OVERFLOW_REPOSITORY)}`],
    ["team", "/team"],
    ["operator", "/operator"],
    ["reports", "/reports"],
    ["item detail", `/issues/${PHONE_OVERFLOW_REPOSITORY}/6/conversation`],
  ] as const;

  for (const width of [320, 390] as const) {
    await page.setViewportSize({ width, height: 844 });
    for (const [name, route] of pages) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
      await page.locator("main").waitFor({ state: "visible", timeout: 10_000 });
      await stabilize(page);
      if (name === "item detail")
        await page.locator(".issue-inspector[open]").waitFor({ state: "visible" });
      await expectDocumentToFitPhoneViewport(page, name, width);
      await expectNonScrollerContentToFitPhoneViewport(page, name, width);
      if (name === "board") {
        await page.getByRole("button", { name: /^Filters/ }).click();
        await expectReachableElement(
          page.locator('.tabs a[href="/repositories"]'),
          "Repositories navigation",
        );
        await expectReachableText(page, PHONE_OVERFLOW_REPOSITORY);
        await page.getByLabel("Degraded").first().waitFor({ state: "visible", timeout: 10_000 });
      }
      if (name === "repositories" || name === "repository detail") {
        await expectReachableElement(
          page.locator('.tabs a[href="/repositories"]'),
          "Repositories navigation",
        );
        await expectReachableText(page, PHONE_OVERFLOW_REPOSITORY);
      }
      // The board names repositories only on cards; their address and health are on the Repositories pages.
      if (name === "repositories" || name === "repository detail") {
        await expectReachableText(page, PHONE_OVERFLOW_ADDRESS);
        await expectReachableText(page, DEGRADED_STATUS);
        await expectReachableHealth(page, "Degraded");
      }
      if (name === "repository detail") {
        await expectReachableText(page, "Public repository trust");
        await expectReachableText(page, PHONE_TRUSTED_LOGIN);
        await expectReachableText(page, PHONE_TRUST_WARNING);
        await expectReachableElement(
          page.locator(`a[href="/issues/${encodeURIComponent(PHONE_OVERFLOW_REPOSITORY)}/6/journey"]`),
          "Ignored review history",
        );
      }
      if (name === "board") {
        // On a phone the board lists its stages top to bottom: nothing scrolls sideways, and every stage
        // with items is on the page.
        const phoneBoard = await page.locator(".board").evaluate((board) => ({
          sideways: board.scrollWidth > board.clientWidth + 1,
          hidden: [...board.querySelectorAll<HTMLElement>("[data-station-cell]")]
            .filter((cell) => cell.querySelector("article.issue") && cell.getBoundingClientRect().width === 0)
            .map((cell) => cell.dataset.stationCell),
        }));
        if (phoneBoard.sideways || phoneBoard.hidden.length > 0)
          throw new Error(`Board on a phone scrolls sideways or hides stages: ${JSON.stringify(phoneBoard)}`);
        await expectLastChildReachable(page, ".tabs", ".tab", "Navigation tabs");
      }
      if (name === "reports")
        await expectLastChildReachable(
          page,
          ".report-table-wrap",
          ".report-table thead th:last-child",
          "Report's last column",
          true,
        );
      if (name === "item detail")
        await expectLastChildReachable(page, ".details-tabs", "[role=tab]", "Issue detail tabs");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function capture(
  page: Page,
  baseUrl: string,
  name: string,
  route: string,
  expected: string[],
  expectedHealth: Array<"Healthy" | "Degraded"> = [],
): Promise<void> {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
  await page.locator("main").waitFor({ state: "visible", timeout: 10_000 });
  await stabilize(page);
  for (const text of expected) await expectText(page, text);
  for (const health of expectedHealth)
    await page.getByRole("img", { name: health }).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, `${name}.png`) });
}

async function verifyGithubStub(home: string): Promise<void> {
  const requestLog = await readFile(
    path.join(home, "github-requests.log"),
    "utf8",
  ).catch(() => "");
  if (!requestLog.includes("api"))
    throw new Error(
      "The isolated GitHub stub was not used during demo startup",
    );
}

async function main(): Promise<void> {
  demoHome = await mkdtemp(path.join(tmpdir(), "conveyor-screenshots-"));
  try {
    const listen = await reserveListenAddress();
    const environment = await configureDemo(demoHome, listen);
    await seedDemo(demoHome);
    serverProcess = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "serve", "--home", demoHome],
      {
        cwd: process.cwd(),
        env: environment,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const baseUrl = `http://${listen}`;
    await waitForServer(`${baseUrl}/health/live`);
    await verifyGithubStub(demoHome);

    // Multi-threaded and GPU rasterization anti-alias edges slightly differently between runs;
    // single-threaded software raster keeps repeated captures pixel-identical.
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-gpu",
        "--disable-gpu-rasterization",
        "--disable-partial-raster",
        "--disable-skia-runtime-opts",
        "--num-raster-threads=1",
        "--font-render-hinting=none",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("conveyor-theme", "light"),
    );
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill("input[name=username]", DEMO_USERNAME);
    await page.fill("input[name=password]", DEMO_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/(board|attention)?$/),
      page.click("button[type=submit]"),
    ]);
    await page.waitForLoadState("networkidle");

    await capture(page, baseUrl, "board", "/board", [
      "Needs you",
      "Which migration path should the team use?",
      "Ship a reliable dashboard overview",
      "No split",
      "Search board",
      "Show all",
      PHONE_OVERFLOW_REPOSITORY,
    ]);
    await verifyStickyThemeBackgrounds(page);
    await page.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
    await stabilize(page);
    await scrollBoardAndExpectSticky(page);
    await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "board-scrolled.png") });
    await verifyAnchorOffset(page, baseUrl);
    await capture(page, baseUrl, "board-filtered", "/board?repo=demo&q=dashboard", [
      "Search board",
      "Clear filters",
      "Showing 1 of",
      "Ship a reliable dashboard overview",
    ]);
    await expectReachableElement(page.locator("[data-sticky-filter-summary]"), "Sticky filter summary");
    await capture(page, baseUrl, "repositories", "/repositories", [
      "Repositories",
      PHONE_OVERFLOW_REPOSITORY,
      PHONE_OVERFLOW_ADDRESS,
      DEGRADED_STATUS,
    ], ["Healthy", "Degraded"]);
    await capture(page, baseUrl, "repository", `/repositories/${encodeURIComponent(PHONE_OVERFLOW_REPOSITORY)}`, [
      PHONE_OVERFLOW_REPOSITORY,
      PHONE_OVERFLOW_ADDRESS,
      DEGRADED_STATUS,
      "Setup",
    ], ["Degraded"]);
    await capture(page, baseUrl, "team", "/team", ["Team", "Jamshid", "Omid"]);
    await capture(page, baseUrl, "operator", "/operator", [
      "Operator",
      "Show the latest delivery activity.",
    ]);
    await capture(page, baseUrl, "reports", "/reports", [
      "Reports",
      "16.2K",
      "Runs",
    ]);
    await capture(page, baseUrl, "item", "/issues/demo/1/conversation", [
      "Ship a reliable dashboard overview",
      "The dashboard overview is implemented",
    ]);
    await verifyPhoneLayouts(page, baseUrl);

    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      colorScheme: "light",
      reducedMotion: "reduce",
      storageState: await context.storageState(),
    });
    const phone = await phoneContext.newPage();
    await phone.addInitScript(() => localStorage.setItem("conveyor-theme", "light"));
    await capture(phone, baseUrl, "board-phone", "/board", ["Search board", "Filters"]);
    await phone.goto(`${baseUrl}/board`, { waitUntil: "networkidle" });
    await stabilize(phone);
    await scrollPhoneBoardAndExpectSticky(phone);
    await phone.screenshot({ path: path.join(OUTPUT_DIRECTORY, "board-phone-scrolled.png") });
    await verifyPhoneStickyNavigation(phone, baseUrl);
    const collapsedRows = await phone.locator("[data-filter-form]").evaluate((form) => {
      const rows = new Set(
        [...form.children]
          .filter((child) => getComputedStyle(child).display !== "none" && child.getBoundingClientRect().height > 0)
          .map((child) => Math.round(child.getBoundingClientRect().bottom)),
      );
      return rows.size;
    });
    if (collapsedRows > 2)
      throw new Error(`Collapsed phone filter bar uses ${collapsedRows} rows`);
    await capture(phone, baseUrl, "board-phone-filtered", "/board?repo=demo&q=dashboard", [
      "Search board",
      "Filters 2",
      "Clear filters",
    ]);
    await expectReachableElement(phone.locator("[data-sticky-filter-summary]"), "Phone sticky filter summary");
    await phoneContext.close();
    await page.goto(`${baseUrl}/issues/demo/1/journey`, {
      waitUntil: "networkidle",
    });
    await expectText(page, "The plan was approved for implementation.");
    await page.goto(`${baseUrl}/issues/demo/1/logs`, {
      waitUntil: "networkidle",
    });
    await expectText(page, "Prepared the change for review");
    await context.close();
  } finally {
    await cleanup();
  }
}

void main().catch((error) => {
  console.error(
    `Screenshot generation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
