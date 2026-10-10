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
import { chromium, type Page } from "playwright";
import { ConveyorStore, type IssueProjection } from "../src/db/store";

const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo-password-12chars";
const DEMO_TIMEOUT = 30_000;
const DEMO_TIME = "2026-09-15T12:00:00.000Z";
const DEMO_FINISHED_TIME = "2026-09-15T12:01:32.000Z";
const OUTPUT_DIRECTORY = path.join("docs", "screenshots");
const PHONE_OVERFLOW_REPOSITORY = "MobileViewportRegressionContentMustWrapWithoutCreatingADocumentWideHorizontalScrollRange";
const DEMO_SOURCE_ISSUES = [
  {
    id: 10_001,
    number: 1,
    html_url: "https://github.invalid/demo/dashboard-demo/issues/1",
    title: "Ship a reliable dashboard overview",
    body: "Deterministic demo item used only to regenerate documentation screenshots.",
    state: "open",
    state_reason: null,
    labels: ["conveyor", "conveyor:implementation"],
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
  const workspace = path.join(home, "workspace");
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
  const repositoryPaths = [
    path.join(repositoriesDirectory, "demo.yaml"),
    path.join(repositoriesDirectory, `${PHONE_OVERFLOW_REPOSITORY}.yaml`),
  ];
  let config = await readFile(configPath, "utf8");
  config = config.replace(
    "listen: 127.0.0.1:7788",
    `listen: ${listen}\n  steering:\n    agent: omid\n    workspace: ${workspace}`,
  );
  await writeFile(configPath, config);
  await mkdir(repositoriesDirectory, { recursive: true });
  await Promise.all(repositoryPaths.map((repositoryPath, index) =>
    writeFile(
      repositoryPath,
      [
        "source: github",
        "codeHost: github",
        `address: ${index === 0 ? "demo/dashboard-demo" : "demo/phone-overflow"}`,
        `folder: ${workspace}`,
        "baseBranch: main",
        "pipeline: delivery",
        "ci:",
        // The phone-overflow item shows a stored CI chip; the demo repository shows none.
        ...(index === 0 ? ["  mode: disabled"] : ["  provider: actions", "  mode: advisory"]),
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
      address: "demo/phone-overflow",
      folder: path.join(home, "workspace"),
      configHash: "demo-config",
    });
    const issues = [
      issue(1, "Ship a reliable dashboard overview", "implementation"),
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
    for (const entry of issues) store.upsertIssue(entry);
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
  const element = page
    .getByText(text, { exact: false })
    .first();
  await element.waitFor({ state: "visible", timeout: 10_000 });
  const bounds = await element.evaluate((node) => {
    const { bottom, top } = node.getBoundingClientRect();
    return { bottom, top, viewportHeight: window.innerHeight };
  });
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight) {
    throw new Error(`Primary content is clipped: ${text}`);
  }
}

async function expectCardsToFitViewport(page: Page): Promise<void> {
  const clipped = await page.locator("article[data-issue-id]").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const { bottom, top } = card.getBoundingClientRect();
      return top < 0 || bottom > window.innerHeight
        ? [card.getAttribute("data-issue-id") ?? "unknown item"]
        : [];
    }),
  );
  if (clipped.length > 0) {
    throw new Error(`Board cards extend beyond the capture viewport: ${clipped.join(", ")}`);
  }
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

async function verifyPhoneLayouts(page: Page, baseUrl: string): Promise<void> {
  const pages = [
    ["board", "/board"],
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
        await expectLastChildReachable(
          page,
          ".board",
          ".stage",
          "Board's last stage",
          true,
        );
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
  await page.setViewportSize({ width: 1440, height: 1024 });
}

async function capture(
  page: Page,
  baseUrl: string,
  name: string,
  route: string,
  expected: string[],
): Promise<void> {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
  await page.locator("main").waitFor({ state: "visible", timeout: 10_000 });
  await stabilize(page);
  for (const text of expected) await expectText(page, text);
  if (name === "board") await expectCardsToFitViewport(page);
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
      viewport: { width: 1440, height: 1024 },
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
      "Investigate the rollout alert",
      "Ship a reliable dashboard overview",
    ]);
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
