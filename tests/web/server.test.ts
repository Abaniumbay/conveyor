import { describe, expect, test } from "bun:test";
import packageMetadata from "../../package.json";
import { ToolRequestError } from "../../src/tasks/errors";
import { BUILD } from "../../src/version";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler, PROFILE_AVATARS } from "../../src/web/server";
import type { DashboardViewModel, IssueCardViewModel } from "../../src/web/types";
import { withCommands } from "../support/web-commands";
import { DashboardFeed } from "../../src/app/dashboard-feed";
import { dashboardSnapshotSchema, normalizeDashboard } from "../../src/web/model";

const model: DashboardViewModel = {
  title: "Test board",
  project: "org/repo",
  totalUsage: "12M in · 80K out",
  harnessUsage: [],
  draining: null,
  updatedAt: "2026-09-29T12:00:00Z",
  revision: "revision-1",
  view: "board",
  repositoryId: null,
  graph: { nodes: [], relationships: [] },
  counts: { board: 0, attention: 0 },
  activeWork: { runnerCount: 0, runnerCapacity: 2, runs: [] },
  selectedIssue: null,
  stages: [],
  backlog: [],
  done: {
    id: "done",
    name: "Done",
    actors: [],
    cost: null,
    totalIssues: 0,
    page: 1,
    totalPages: 1,
    issues: [],
  },
  attention: {
    id: "attention",
    name: "Label problems",
    actors: [],
    cost: null,
    totalIssues: 0,
    page: 1,
    totalPages: 1,
    issues: [],
  },
  questions: [],
  needsYou: [],
  systemWarnings: [],
  repositories: [],
  restrictedRepositories: [],
  steering: { enabled: false, agent: null, selected: null, recent: [] },
  csrfToken: "filled-by-handler",
};

const detailIssue: IssueCardViewModel = {
  id: "github:owner/repo#1",
  repository: "repo",
  repositoryPaused: false,
  repositoryColor: 1,
  number: 1,
  title: "Keep <item> safe",
  url: "https://github.com/owner/repo/issues/1",
  state: "in_progress",
  labels: ["feature"],
  issueType: null,
  issueFields: [],
  acceptanceCriteria: [{ id: "AC-1", text: "Works safely", approved: true, manual: false, tests: [] }],
  todos: { finished: 1, skipped: 0, total: 1, current: null, items: [{ id: "t1", text: "Complete", status: "done" }] },
  indicators: [],
  activity: "Testing",
  reason: null,
  cost: "$0.01",
  duration: "1m",
  stateChangedAt: "2026-09-29T12:00:00Z",
  waiting: null,
  blocked: false,
  inconsistent: false,
  closable: false,
  noSplit: false,
  tone: "active",
  parent: null,
  children: [],
  dependencies: [],
  working: true,
  needsAttention: false,
  retryable: false,
  resumableRollup: false,
  stoppedRollup: false,
};

interface CallLog {
  answers: unknown[][];
  reorders: unknown[][];
  moves: unknown[][];
  webhooks: unknown[][];
  mcp: unknown[][];
  steering: unknown[][];
  issueActivity: unknown[][];
  issueRunEvents: unknown[][];
  issueConversation: unknown[][];
  issueJourney: unknown[][];
  messages: unknown[][];
  retries: unknown[][];
  dismissals: unknown[][];
  boardApprovals: unknown[][];
  manualApprovals: unknown[][];
}

function setup(overrides: Record<string, unknown> = {}) {
  const auth = createWebAuth({
    passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
  });
  const calls: CallLog = { answers: [], reorders: [], moves: [], webhooks: [], mcp: [], steering: [], issueActivity: [], issueRunEvents: [], issueConversation: [], issueJourney: [], messages: [], retries: [], dismissals: [], boardApprovals: [], manualApprovals: [] };
  const dependencies = {
    auth,
    username: "operator",
    isReady: () => true,
    webhookPath: "/hooks/custom",
    maxBodyBytes: 128,
    answerQuestion: async (...args: unknown[]) => { calls.answers.push(args); },
    reorderBacklog: async (...args: unknown[]) => { calls.reorders.push(args); },
    moveBacklogIssue: async (...args: unknown[]) => { calls.moves.push(args); },
    handleWebhook: async (...args: unknown[]) => { calls.webhooks.push(args); },
    handleMcp: async (...args: unknown[]) => { calls.mcp.push(args); return { ok: true }; },
    startSteering: async (...args: unknown[]) => { calls.steering.push(args); return "run-1"; },
    getSteeringRun: async () => ({ id: "run-1", status: "succeeded" }),
    getSteeringEvents: async () => [{ sequence: 1, type: "report", text: "Done", createdAt: "2026-09-29T12:00:00Z" }],
    getIssueActivity: async (...args: unknown[]) => {
      calls.issueActivity.push(args);
      return {
        issueId: String(args[0]),
        runs: [{
          id: "run-2",
          stageId: "implementation",
          attempt: 2,
          kind: "producer",
          status: "running",
          startedAt: "2026-09-29T12:00:00Z",
          finishedAt: null,
          result: null,
          events: [{ sequence: 1, type: "progress", payload: { message: "Editing files" }, createdAt: "2026-09-29T12:00:01Z" }],
          nextEventBefore: null,
        }],
        nextRunBefore: null,
      };
    },
    getIssueRunEvents: async (...args: unknown[]) => {
      calls.issueRunEvents.push(args);
      return {
        issueId: String(args[0]),
        runId: String(args[1]),
        events: [{ sequence: 1, type: "progress", payload: { message: "Earlier work" }, createdAt: "2026-09-29T11:59:00Z" }],
        nextEventBefore: null,
      };
    },
    getIssueConversation: async (...args: unknown[]) => {
      calls.issueConversation.push(args);
      return {
        issueId: String(args[0]),
        messages: [{
          id: 1,
          stageId: "implementation",
          actorType: "agent",
          actorId: "implementer",
          actorName: "Implementer",
          actorTitle: "Senior Developer",
          message: "Running focused tests.",
          createdAt: "2026-09-29T12:00:01Z",
        }],
      };
    },
    getIssueJourney: async (...args: unknown[]) => {
      calls.issueJourney.push(args);
      return {
        issueId: String(args[0]),
        now: { stage: "review", state: "stopped", reason: "A race can return null.", since: "2026-09-29T12:00:00Z" },
        transitions: [{
          id: "transition-1",
          fromStage: "review",
          toStage: "implementation",
          kind: "correction",
          status: "completed",
          resultStatus: "changes-requested",
          reason: "A race can return null.",
          requiredFixes: ["Return duel-ended."],
          actor: "Reviewer · Senior Code Reviewer",
          createdAt: "2026-09-29T12:00:00Z",
          completedAt: "2026-09-29T12:00:01Z",
        }],
        skippedReviews: [{ author: "reviewer", url: "https://example.com/reviews/1", skippedAt: "2026-09-29T12:00:00Z", active: true }],
      };
    },
    getIssueRoute: async (reference: { id?: string; repository?: string; number?: number }) => {
      if (reference.id === "github:owner/repo#1" || (reference.repository === "repo" && reference.number === 1)) {
        return { id: "github:owner/repo#1", repository: "repo", number: 1 };
      }
      return null;
    },
    postIssueMessage: async (...args: unknown[]) => { calls.messages.push(args); },
    retryIssue: async (...args: unknown[]) => { calls.retries.push(args); return { status: "queued", stageId: "implementation" }; },
    resumeRollupParent: async () => ({ stageId: "implementation" }),
    dismissFinding: async (...args: unknown[]) => { calls.dismissals.push(args); },
    reclassifyFinding: () => ({ changed: true }),
    setBoardApprovalRequirement: async (...args: unknown[]) => { calls.boardApprovals.push(args); },
    approveManualGate: async (...args: unknown[]) => { calls.manualApprovals.push(args); },
    ...overrides,
  };
  const { dependencies: withDispatch, events } = withCommands(dependencies);
  return { handler: createWebHandler(withDispatch as never), auth, calls, events };
}

async function login(handler: (request: Request) => Promise<Response>) {
  const response = await handler(new Request("http://localhost/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "correct horse" }),
  }));
  return { response, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

type CspResource = "script" | "style" | "font" | "image" | "manifest" | "worker" | "connect";

function cspAllows(policy: string, resource: CspResource, source: URL | "inline", origin: string): boolean {
  const directives = new Map(policy.split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  }));
  const directiveNames = { script: "script", style: "style", font: "font", image: "img", manifest: "manifest", connect: "connect" };
  const sources = resource === "worker"
    ? directives.get("worker-src") ?? directives.get("child-src") ?? directives.get("script-src") ?? directives.get("default-src")
    : directives.get(`${directiveNames[resource]}-src`) ?? directives.get("default-src");
  if (!sources) return false;
  if (source === "inline") return sources.includes("'unsafe-inline'");
  return sources.includes("'self'") && source.origin === origin;
}

describe("createWebHandler", () => {
  test("serves same-origin PWA assets publicly without caching dashboard data", async () => {
    const { handler } = setup();
    const manifest = await handler(new Request("http://localhost/manifest.webmanifest"));
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest.json()).toMatchObject({
      name: "Conveyor",
      start_url: "/board",
      display: "standalone",
      icons: expect.arrayContaining([expect.objectContaining({ sizes: "192x192" }), expect.objectContaining({ sizes: "512x512" })]),
    });

    const worker = await handler(new Request("http://localhost/service-worker.js"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("service-worker-allowed")).toBe("/");
    const source = await worker.text();
    expect(source).toContain("fetch(request)");
    expect(source).toContain("offline</h1>");
    expect(source).toContain("url.origin === self.location.origin");
    expect(source).not.toContain("caches.open");

    for (const path of ["/icons/conveyor-192.svg", "/icons/conveyor-512.svg"]) {
      expect((await handler(new Request(`http://localhost${path}`))).status).toBe(200);
    }
  });

  test("permits every resource referenced by a rendered dashboard without relaxing the CSP", async () => {
    const { handler } = setup();
    const { cookie } = await login(handler);
    const dashboard = await handler(new Request("http://localhost/board", { headers: { cookie } }));
    const policy = dashboard.headers.get("content-security-policy")!;

    expect(await dashboard.text()).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(policy).toBe("default-src 'none'; manifest-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    expect(cspAllows(policy, "script", new URL("http://localhost/assets/app.js"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "style", "inline", "http://localhost")).toBe(true);
    expect(cspAllows(policy, "font", new URL("http://localhost/assets/fonts/ibm-plex-sans-400.woff2"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "image", new URL("http://localhost/favicon.svg"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "manifest", new URL("http://localhost/manifest.webmanifest"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "worker", new URL("http://localhost/service-worker.js"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "connect", new URL("http://localhost/api/dashboard-revision"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "connect", new URL("http://localhost/api/v1/stream"), "http://localhost")).toBe(true);
    expect(cspAllows(policy, "manifest", new URL("https://attacker.example/manifest.webmanifest"), "http://localhost")).toBe(false);
  });

  test("returns notification clicks to the protected page after sign-in without allowing external redirects", async () => {
    const { handler } = setup();
    const protectedPage = await handler(new Request("http://localhost/issues/repo/1?tab=conversation"));
    expect(protectedPage.headers.get("location")).toBe("/login?returnTo=%2Fissues%2Frepo%2F1%3Ftab%3Dconversation");
    const loginPage = await handler(new Request(`http://localhost${protectedPage.headers.get("location")}`));
    expect(await loginPage.text()).toContain('name="returnTo" value="/issues/repo/1?tab=conversation"');
    const signedIn = await handler(new Request("http://localhost/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password: "correct horse", returnTo: "/issues/repo/1?tab=conversation" }),
    }));
    expect(signedIn.headers.get("location")).toBe("/issues/repo/1?tab=conversation");
    const opened = await handler(new Request("http://localhost/issues/repo/1?tab=conversation", { headers: { cookie: signedIn.headers.get("set-cookie")!.split(";")[0]! } }));
    expect(opened.status).toBe(200);

    const external = await handler(new Request("http://localhost/login?returnTo=https%3A%2F%2Fattacker.example"));
    expect(await external.text()).not.toContain('name="returnTo"');
  });

  test("protects notification preferences and subscriptions with account-bound CSRF requests", async () => {
    let preferences = { questions: false, stopped: false, done: false };
    const subscriptions: unknown[][] = [];
    const { handler, auth } = setup({
      pushPublicKey: "BExamplePushPublicKey12345678901234567890",
      getPushPreferences: () => preferences,
      setPushPreferences: (_accountId: string, value: typeof preferences) => { preferences = value; },
      putPushSubscription: (...args: unknown[]) => { subscriptions.push(args); },
    });
    expect((await handler(new Request("http://localhost/api/notifications/settings"))).status).toBe(401);
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const p256dh = Buffer.alloc(65, 1).toString("base64url");
    const authKey = Buffer.alloc(16, 2).toString("base64url");
    const page = await handler(new Request("http://localhost/settings/notifications", { headers: { cookie } }));
    expect(page.status).toBe(200);
    const notificationsPage = await page.text();
    // The application draws the view; the page brings the push settings script and the theme before first paint.
    expect(notificationsPage).toContain("/assets/notifications.js");
    expect(notificationsPage).toContain("data-app-skeleton");
    expect(notificationsPage).toContain('<script src="/assets/theme.js"></script>');
    expect(notificationsPage.indexOf('/assets/theme.js')).toBeLessThan(notificationsPage.indexOf('<style>'));
    expect(notificationsPage).toContain('@media(max-width:760px)');
    expect((await handler(new Request("http://localhost/api/notifications/settings", { headers: { cookie } }))).status).toBe(200);

    const denied = await handler(new Request("http://localhost/api/notifications/settings", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ questions: true, stopped: false, done: false }),
    }));
    expect(denied.status).toBe(403);
    const saved = await handler(new Request("http://localhost/api/notifications/settings", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ questions: true, stopped: false, done: false }),
    }));
    expect(saved.status).toBe(200);
    expect(preferences).toEqual({ questions: true, stopped: false, done: false });

    const invalid = await handler(new Request("http://localhost/api/notifications/subscriptions", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ endpoint: "http://attacker.example/push", keys: { p256dh, auth: authKey } }),
    }));
    expect(invalid.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
    const malformedEndpoint = await handler(new Request("http://localhost/api/notifications/subscriptions", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ endpoint: "https://", keys: { p256dh, auth: authKey } }),
    }));
    expect(malformedEndpoint.status).toBe(400);
    const invalidKey = await handler(new Request("http://localhost/api/notifications/subscriptions", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ endpoint: "https://push.example/bad-key", keys: { p256dh: "short", auth: authKey } }),
    }));
    expect(invalidKey.status).toBe(400);
    expect(subscriptions).toHaveLength(0);
    const oversized = await handler(new Request("http://localhost/api/notifications/subscriptions", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ endpoint: "https://push.example/subscription", keys: { p256dh, auth: authKey }, padding: "x".repeat(17 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
    expect(subscriptions).toHaveLength(0);
    const registered = await handler(new Request("http://localhost/api/notifications/subscriptions", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ endpoint: "https://push.example/subscription", keys: { p256dh, auth: authKey } }),
    }));
    expect(registered.status).toBe(201);
    expect(subscriptions).toEqual([["legacy", "https://push.example/subscription", { p256dh, auth: authKey }]]);
  });

  test("publishes source build metadata without a session", async () => {
    const { handler } = setup();
    const version = await handler(new Request("http://localhost/version"));

    expect(version.status).toBe(200);
    expect(version.headers.get("content-type")).toContain("application/json");
    const metadata = await version.json();
    expect(metadata).toEqual({
      service: "conveyor",
      version: BUILD.version,
      commit: BUILD.commit,
      builtAt: BUILD.builtAt,
    });
    expect(metadata).toMatchObject({ version: packageMetadata.version, commit: "development", builtAt: null });
  });

  test("keeps liveness public and protects readiness and the dashboard", async () => {
    const { handler } = setup();
    const live = await handler(new Request("http://localhost/health/live"));
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("application/json");
    expect(await live.json()).toEqual({ status: "live", version: BUILD.version, commit: BUILD.commit });

    expect((await handler(new Request("http://localhost/health/ready"))).status).toBe(401);
    const unauthenticated = await handler(new Request("http://localhost/"));
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe("/login");
    const recentUnauthenticated = await handler(new Request("http://localhost/recent?type=done"));
    expect(recentUnauthenticated.status).toBe(303);
    expect(recentUnauthenticated.headers.get("location")).toBe("/login?returnTo=%2Frecent%3Ftype%3Ddone");
    const graphUnauthenticated = await handler(new Request("http://localhost/graph"));
    expect(graphUnauthenticated.status).toBe(303);
    expect(graphUnauthenticated.headers.get("location")).toBe("/login?returnTo=%2Fgraph");
    expect((await handler(new Request("http://localhost/login"))).headers.get("content-type")).toContain("text/html");
  });

  test("limits the public version endpoint to GET", async () => {
    const { handler } = setup();
    const response = await handler(new Request("http://localhost/version", { method: "POST" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  test("loads an item the live model does not hold, with the session's own token", async () => {
    const { handler, auth } = setup({
      getIssueDetails: (issueId: string) => issueId === detailIssue.id ? { ...detailIssue, csrfToken: "" } : null,
    });
    const path = "/api/v1/items/repo/1";

    expect((await handler(new Request(`http://localhost${path}`))).status).toBe(401);
    const { cookie } = await login(handler);
    const details = await handler(new Request(`http://localhost${path}`, { headers: { cookie } }));
    expect(details.status).toBe(200);
    expect(details.headers.get("cache-control")).toBe("no-store");
    expect(await details.json()).toMatchObject({ id: detailIssue.id, title: "Keep <item> safe", csrfToken: auth.getSession(cookie)!.csrfToken });

    expect((await handler(new Request("http://localhost/api/v1/items/repo/999", { headers: { cookie } }))).status).toBe(404);
    expect((await handler(new Request("http://localhost/api/v1/items/unknown/1", { headers: { cookie } }))).status).toBe(404);
    expect((await handler(new Request(`http://localhost${path}`, { method: "POST", headers: { cookie } }))).status).toBe(405);
  });

  test("answers 503 when an item cannot be read", async () => {
    const { handler } = setup({ getIssueDetails: () => { throw new Error("database is locked"); } });
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/v1/items/repo/1", { headers: { cookie } }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database is locked");
  });

  test("compresses pages on request and lets browsers revalidate the scripts", async () => {
    const { handler } = setup();
    const { cookie } = await login(handler);

    const plain = await handler(new Request("http://localhost/board", { headers: { cookie } }));
    const zipped = await handler(new Request("http://localhost/board", { headers: { cookie, "accept-encoding": "gzip, br" } }));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toBe("accept-encoding");
    expect(zipped.headers.get("x-robots-tag")).toBe("noindex");
    const body = new Uint8Array(await zipped.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(await plain.text());
    expect(body.byteLength).toBeLessThan(40_000);
    // A quality of zero refuses the coding; `*` accepts it unless gzip itself is refused.
    for (const [accepted, encoding] of [["gzip;q=0, br", null], ["GZIP;q=0.5", "gzip"], ["br, *;q=0.1", "gzip"], ["*, gzip;q=0", null], ["br", null]] as const) {
      const answered = await handler(new Request("http://localhost/board", { headers: { cookie, "accept-encoding": accepted } }));
      expect(answered.headers.get("content-encoding")).toBe(encoding);
    }

    const script = await handler(new Request("http://localhost/assets/notifications.js"));
    const etag = script.headers.get("etag")!;
    expect(script.headers.get("cache-control")).toBe("no-cache");
    const unchanged = await handler(new Request("http://localhost/assets/notifications.js", { headers: { "if-none-match": etag } }));
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect((await handler(new Request("http://localhost/assets/notifications.js", { headers: { "if-none-match": '"stale"' } }))).status).toBe(200);
  });

  test("extends an active session on page loads and skips the sign-in form for signed-in visitors", async () => {
    let now = 1_000_000;
    const auth = createWebAuth({
      passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      secureCookies: false,
      sessionTtlSeconds: 1000,
    }, { now: () => now });
    const { handler } = setup({ auth });
    const { cookie } = await login(handler);

    const fresh = await handler(new Request("http://localhost/board", { headers: { cookie } }));
    expect(fresh.headers.get("set-cookie")).toBeNull();

    now += 600_000;
    // Background requests do not count as a visit.
    expect((await handler(new Request("http://localhost/assets/dashboard.js", { headers: { cookie } }))).headers.get("set-cookie")).toBeNull();
    const visited = await handler(new Request("http://localhost/board", { headers: { cookie } }));
    const renewed = visited.headers.get("set-cookie")!.split(";")[0]!;
    expect(renewed).not.toBe(cookie);

    now += 500_000;
    expect((await handler(new Request("http://localhost/board", { headers: { cookie }, redirect: "manual" }))).status).toBe(303);
    expect((await handler(new Request("http://localhost/board", { headers: { cookie: renewed } }))).status).toBe(200);

    const signIn = await handler(new Request("http://localhost/login?returnTo=%2Fteam", { headers: { cookie: renewed } }));
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/team");
    expect((await handler(new Request("http://localhost/login"))).status).toBe(200);
  });

  test("keeps the login card inside a phone viewport", async () => {
    const { handler } = setup();
    const html = await (await handler(new Request("http://localhost/login"))).text();
    // Without border-box the padding is added to the width and the card is clipped at phone widths.
    expect(html).toContain(".login{box-sizing:border-box;width:min(24rem,calc(100% - 2rem))");
  });

  test("links the app favicon from the login page", async () => {
    const { handler } = setup();
    const loginPage = await handler(new Request("http://localhost/login"));
    expect(await loginPage.text()).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  });

  test("renders the login page with the same flash-free system, light, and dark theme tokens", async () => {
    const { handler } = setup();
    const loginPage = await handler(new Request("http://localhost/login"));
    const html = await loginPage.text();

    expect(html).toContain('<script src="/assets/theme.js"></script>');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(':root[data-theme="dark"]{color-scheme:dark;');
    expect(html).toContain('@media(prefers-color-scheme:dark){:root:not([data-theme="light"])');
    expect(html).toContain('background:var(--concrete)');
    expect(html).toContain('color:var(--ink)');
  });

  test("logs in, serves dashboard, and clears the session on logout", async () => {
    const removedPushSubscriptions: unknown[][] = [];
    const { handler, auth } = setup({
      deletePushSubscription: (...args: unknown[]) => { removedPushSubscriptions.push(args); },
    });
    const { response, cookie } = await login(handler);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/board");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await handler(new Request("http://localhost/issues/repo/1?column=stage%3Areview&page=4&doneLimit=40", { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("data-app-skeleton");

    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const logout = await handler(new Request("http://localhost/logout", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, pushEndpoint: "https://push.example/browser-a" }),
    }));
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(removedPushSubscriptions).toEqual([[auth.getSession(cookie)?.account.id, "https://push.example/browser-a"]]);
  });

  test("serves the application on every dashboard path and redirects legacy URLs permanently", async () => {
    const profile = {
      id: "kaveh", name: "Kaveh", title: "Developer", harness: "codex", model: null, effort: null,
      access: "workspace-write", usage: [], tasks: [], instructions: null,
    };
    const { handler } = setup({
      getIssueRoute: async (reference: { id?: string; repository?: string; number?: number }) => {
        if (reference.id === "github:owner/repo#1" || (reference.repository === "midgame" && reference.number === 1)) {
          return { id: "github:owner/repo#1", repository: "midgame", number: 1 };
        }
        return null;
      },
      getAgentProfiles: async () => [profile],
      getAgentProfile: async (id: string) => id === "kaveh" ? profile : null,
      getSteeringRun: async (id: string) => id === "run-1" ? { id, status: "succeeded" } : null,
    });
    const { cookie } = await login(handler);
    const get = (path: string) => handler(new Request(`http://localhost${path}`, { headers: { cookie } }));
    const shell = await (await get("/")).text();
    expect(shell).toContain("data-app-skeleton");

    // The application reads the view, its filters and the open item from the address.
    for (const path of [
      "/board", "/graph?repo=midgame&stage=review", "/recent?type=done&beforeAt=2026-10-15T12%3A00%3A00.000Z", "/attention", "/repositories",
      "/repositories/space%2Fname", "/team", "/team/kaveh", "/reports", "/reports/quesshi?period=30d", "/operator", "/operator/runs/run-1",
      "/accounts", "/profile", "/settings/notifications", "/about", "/issues/midgame/1", "/issues/midgame/1/conversation?column=stage%3Areview&page=2",
      // Unknown items, agents, runs and repositories are the application's to report.
      "/issues/unknown/1", "/team/nobody", "/operator/runs/missing", "/repositories/%E0%A4%A",
    ]) {
      const response = await get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(await response.text()).toBe(shell);
    }

    for (const [oldPath, location] of [
      ["/?view=attention", "/attention"],
      ["/?issue=github%3Aowner%2Frepo%231&tab=journey", "/issues/midgame/1/journey"],
      ["/?view=team&agent=kaveh", "/team/kaveh"],
      ["/?view=agent&run=run-1", "/operator/runs/run-1"],
      ["/?view=team&repo=midgame", "/team?repo=midgame"],
      ["/?view=agent", "/operator"],
      ["/agents", "/team"],
      ["/agents/kaveh", "/team/kaveh"],
      // The addresses the application had while it was previewed beside the server-rendered dashboard.
      ["/app", "/"],
      ["/app/issues/midgame/1?q=fix", "/issues/midgame/1?q=fix"],
    ] as const) {
      const response = await get(oldPath);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(location);
    }

    for (const path of ["/?issue=missing", "/?view=team&agent=nobody", "/?view=agent&run=missing", "/?view=agent&run=not%20a%20run"]) {
      expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
    }
    expect((await get("/graph/extra")).status).toBe(404);
    expect((await handler(new Request("http://localhost/graph", { method: "POST", headers: { cookie } }))).status).toBe(405);
  });

  test("sends a signed-out reader to sign in and back to the address they asked for", async () => {
    const { handler } = setup();
    for (const [path, location] of [
      ["/", "/login"],
      ["/about", "/login?returnTo=%2Fabout"],
      ["/repositories", "/login?returnTo=%2Frepositories"],
      ["/issues/repo/7?q=fix", `/login?returnTo=${encodeURIComponent("/issues/repo/7?q=fix")}`],
    ] as const) {
      const response = await handler(new Request(`http://localhost${path}`));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(location);
    }
  });

  test("requires CSRF for question answers and backlog reorder callbacks", async () => {
    const { handler, auth, calls } = setup();
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const bad = await handler(new Request("http://localhost/questions/q-1/answer", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer: "yes" }),
    }));
    expect(bad.status).toBe(403);

    const answer = await handler(new Request("http://localhost/questions/q-1/answer", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer: "current-main", csrf }),
    }));
    expect(answer.status).toBe(303);
    expect(calls.answers).toEqual([["q-1", "current-main", "operator"]]);

    const reorder = await handler(new Request("http://localhost/backlog/reorder", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ issueId: "i-2", direction: "up", csrf }),
    }));
    expect(reorder.status).toBe(303);
    expect(reorder.headers.get("location")).toBe("/board");
    expect(calls.reorders).toEqual([["i-2", "up"]]);

    const scripted = await handler(new Request("http://localhost/backlog/reorder", {
      method: "POST", headers: { cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ issueId: "i-2", direction: "down", csrf }),
    }));
    expect(scripted.status).toBe(200);
    expect(await scripted.json()).toEqual({ ok: true, correlationId: expect.any(String) });
  });

  test("limits manual gate requirements and approvals to superuser CSRF requests", async () => {
    type Account = { id: string; username: string; role: "superuser" | "user"; avatar: string; sessionVersion: number; passwordHash: string };
    const admin: Account = { id: "admin-id", username: "admin", role: "superuser", avatar: "🐼", sessionVersion: 1, passwordHash: hashPassword("admin password", { salt: "0123456789abcdef" }) };
    const reader: Account = { id: "reader-id", username: "reader", role: "user", avatar: "🦊", sessionVersion: 1, passwordHash: hashPassword("reader password", { salt: "abcdef0123456789" }) };
    const accounts = new Map([[admin.id, admin], [reader.id, reader]]);
    const auth = createWebAuth({
      passwordHash: undefined,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: (id) => accounts.get(id) ?? null,
      accountByUsername: (username) => [...accounts.values()].find((account) => account.username === username) ?? null,
    });
    const { handler, calls } = setup({ auth });
    const adminSession = auth.createSession(admin)!;
    const readerSession = auth.createSession(reader)!;
    const adminCookie = adminSession.cookie.split(";", 1)[0]!;
    const readerCookie = readerSession.cookie.split(";", 1)[0]!;
    const post = (path: string, fields: Record<string, string>, cookie = adminCookie) => handler(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields),
    }));

    const requirement = { issueId: "issue-1", stageId: "implementation", required: "true" };
    expect((await post("/manual-gates/requirement", requirement, "")).status).toBe(401);
    expect((await post("/manual-gates/requirement", requirement, readerCookie)).status).toBe(403);
    expect((await post("/manual-gates/requirement", requirement)).status).toBe(403);
    expect((await post("/manual-gates/requirement", { ...requirement, csrf: adminSession.csrfToken })).status).toBe(303);
    expect(calls.boardApprovals).toEqual([["issue-1", "implementation", true]]);

    const approval = { issueId: "issue-1", stageId: "implementation", gateId: "entry-approval" };
    expect((await post("/manual-gates/approve", approval, "")).status).toBe(401);
    expect((await post("/manual-gates/approve", approval, readerCookie)).status).toBe(403);
    expect((await post("/manual-gates/approve", approval)).status).toBe(403);
    expect((await post("/manual-gates/approve", { ...approval, csrf: "invalid" })).status).toBe(403);
    expect(calls.manualApprovals).toEqual([]);

    expect((await post("/manual-gates/approve", { ...approval, csrf: adminSession.csrfToken })).status).toBe(303);
    expect((await post("/manual-gates/approve", { issueId: "issue-1", stageId: "implementation", csrf: adminSession.csrfToken })).status).toBe(303);
    expect(calls.manualApprovals).toHaveLength(2);
    expect(calls.manualApprovals[0]?.slice(0, 3)).toEqual(["issue-1", "implementation", "entry-approval"]);
    expect(calls.manualApprovals[0]?.[3]).toMatchObject({ id: "admin-id", username: "admin" });
    expect(calls.manualApprovals[1]?.slice(0, 3)).toEqual(["issue-1", "implementation", null]);
  });

  test("returns actionable validation errors for blank or rejected question answers", async () => {
    const { handler, auth, calls } = setup({ answerQuestion: async () => { throw new Error("Choose one of the available answers."); } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const post = (answer: string) => handler(new Request("http://localhost/questions/q-1/answer", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer, csrf }),
    }));

    const blank = await post("   ");
    expect(blank.status).toBe(400);
    expect(await blank.text()).toBe("An answer is required");
    expect(calls.answers).toEqual([]);

    const rejected = await post("not-an-option");
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toBe("Choose one of the available answers.");

    // The page script sends answers in the background and reads JSON back.
    const scripted = await handler(new Request("http://localhost/questions/q-1/answer", {
      method: "POST", headers: { cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer: "not-an-option", csrf }),
    }));
    expect(scripted.status).toBe(409);
    expect(await scripted.json()).toEqual({ error: "Choose one of the available answers." });
  });

  test("answers a canonical question choice for the page script with JSON instead of a redirect", async () => {
    const { handler, auth, calls } = setup();
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const answer = await handler(new Request("http://localhost/questions/q-1/answer", {
      method: "POST", headers: { cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer: "current-main", csrf }),
    }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, correlationId: expect.any(String) });
    expect(calls.answers).toEqual([["q-1", "current-main", "operator"]]);
  });

  test("moves a backlog issue in place for drag and drop, with CSRF", async () => {
    const { handler, auth, calls } = setup();
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const post = (params: Record<string, string>) => handler(new Request("http://localhost/backlog/move", {
      method: "POST", headers: { cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }));

    expect((await post({ issueId: "i-3", beforeIssueId: "i-1" })).status).toBe(403);
    const before = await post({ issueId: "i-3", beforeIssueId: "i-1", csrf });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ ok: true, correlationId: expect.any(String) });
    expect((await post({ issueId: "i-1", beforeIssueId: "", csrf })).status).toBe(200);
    expect((await post({ csrf })).status).toBe(400);
    expect(calls.moves).toEqual([["i-3", "i-1"], ["i-1", null]]);
  });

  test("serves the page assets and starts steering with CSRF", async () => {
    const { handler, auth, calls } = setup();
    // The old dashboard's page script and event stream are gone.
    for (const path of ["/assets/dashboard.js", "/events/dashboard", "/api/dashboard-revision"]) {
      expect((await handler(new Request(`http://localhost${path}`))).status).toBe(404);
    }
    // The theme runs before first paint; it must be a file, since the CSP forbids inline scripts.
    const theme = await handler(new Request("http://localhost/assets/theme.js"));
    expect(theme.status).toBe(200);
    expect(theme.headers.get("content-type")).toContain("javascript");
    expect(await theme.text()).toContain("dataset.theme");
    const loginPage = await (await handler(new Request("http://localhost/login"))).text();
    expect(loginPage).toContain('<script src="/assets/theme.js"></script>');
    expect(loginPage).not.toMatch(/<script>[^<]/);
    for (const font of [
      "ibm-plex-sans-400.woff2",
      "ibm-plex-sans-500.woff2",
      "ibm-plex-sans-600.woff2",
      "ibm-plex-mono-400.woff2",
    ]) {
      const response = await handler(new Request(`http://localhost/assets/fonts/${font}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
    const favicon = await handler(new Request("http://localhost/favicon.svg"));
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");

    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const forbidden = await handler(new Request("http://localhost/steering", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "Fix the board" }),
    }));
    expect(forbidden.status).toBe(403);
    const started = await handler(new Request("http://localhost/steering", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "Fix the board", csrf }),
    }));
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toBe("/operator/runs/run-1");
    expect(calls.steering).toEqual([["Fix the board"]]);

    const events = await handler(new Request("http://localhost/steering/run-1/events", { headers: { cookie } }));
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toContain('"text":"Done"');
  });

  test("serves authenticated persisted activity for an encoded issue id", async () => {
    const { handler, calls } = setup();
    expect((await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/activity"))).status).toBe(401);
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/activity", { headers: { cookie } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issueId: "github:owner/repo#1",
      runs: [{ status: "running", events: [{ payload: { message: "Editing files" } }] }],
    });
    expect(calls.issueActivity).toEqual([["github:owner/repo#1", undefined]]);

    const older = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/activity?before=run-2", { headers: { cookie } }));
    expect(older.status).toBe(200);
    expect(calls.issueActivity.at(-1)).toEqual(["github:owner/repo#1", "run-2"]);

    const events = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/activity/runs/run-2/events?before=2", { headers: { cookie } }));
    expect(events.status).toBe(200);
    expect(calls.issueRunEvents).toEqual([["github:owner/repo#1", "run-2", 2]]);
  });

  test("serves an authenticated issue journey", async () => {
    const { handler, calls } = setup();
    expect((await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/journey"))).status).toBe(401);
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/journey", { headers: { cookie } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issueId: "github:owner/repo#1",
      now: { stage: "review", state: "stopped" },
      transitions: [{ kind: "correction", actor: "Reviewer · Senior Code Reviewer" }],
      skippedReviews: [{ author: "reviewer", url: "https://example.com/reviews/1", active: true }],
    });
    expect(calls.issueJourney).toEqual([["github:owner/repo#1"]]);
  });

  test("serves and accepts authenticated issue conversation messages", async () => {
    const { handler, auth, calls } = setup({ maxBodyBytes: 4096 });
    expect((await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation"))).status).toBe(401);
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation", { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issueId: "github:owner/repo#1",
      messages: [{ actorName: "Implementer", message: "Running focused tests." }],
    });

    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const forbidden = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "Please preserve the public API." }),
    }));
    expect(forbidden.status).toBe(403);
    const posted = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "Please preserve the public API.", csrf }),
    }));
    expect(posted.status).toBe(201);
    expect(calls.issueConversation).toEqual([["github:owner/repo#1"]]);
    expect(calls.messages).toEqual([["github:owner/repo#1", "Please preserve the public API.", "operator"]]);
  });

  test("ordinary accounts keep dashboard reads and conversation posting while every admin action is denied", async () => {
    const account = { id: "reader-id", username: "reader", role: "user" as const, avatar: "🦊", sessionVersion: 1 };
    const hash = hashPassword("correct horse", { salt: "0123456789abcdef" });
    const auth = createWebAuth({
      passwordHash: hash,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: () => account,
      accountByUsername: (username) => username === account.username ? { ...account, passwordHash: hash } : null,
    });
    const { handler, calls } = setup({
      auth,
      getAgentProfiles: () => [],
      getReport: async () => ({
        period: "all", since: null, repository: null, repositories: [],
        totals: { delivered: 0, inProgress: 0, runs: 0, failedRuns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, agentMs: 0,
          avgTokensPerItem: 0, avgRunsPerItem: 0, avgLeadMs: 0, avgAgentMs: 0, avgChecksWaitMs: 0, avgWaitingForYouMs: 0, avgQueuedMs: 0,
          avgReturnsPerItem: 0, avgStopsPerItem: 0, firstPassRate: null },
        byRepository: [], byMonth: [], byStage: [], items: [], importedWithoutHistory: 0, generatedAt: "2026-10-03T00:00:00.000Z",
      }),
    });
    const created = auth.createSession(account)!;
    const cookie = created.cookie.split(";")[0]!;
    const csrf = created.csrfToken;

    for (const path of ["/board", "/recent", "/attention", "/team", "/operator", "/reports", "/about", "/settings/notifications", "/issues/repo/1", "/api/issues/github%3Aowner%2Frepo%231/journey", "/api/issues/github%3Aowner%2Frepo%231/activity"]) {
      const page = await handler(new Request(`http://localhost${path}`, { headers: { cookie } }));
      expect(page.status).toBe(200);
    }
    const conversation = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation", { headers: { cookie } }));
    expect(conversation.status).toBe(200);
    const post = await handler(new Request("http://localhost/api/issues/github%3Aowner%2Frepo%231/conversation", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: "hello", username: "admin", actorId: "admin", csrf }),
    }));
    expect(post.status).toBe(201);
    expect(calls.messages[0]).toEqual(["github:owner/repo#1", "hello", "reader"]);

    const formPost = (path: string, fields: Record<string, string> = {}) => handler(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...fields }),
    }));
    for (const [path, fields] of [
      ["/api/issues/i-1/retry", {}],
      ["/api/issues/i-1/resume-waiting", {}],
      ["/questions/q-1/answer", { answer: "yes" }],
      ["/backlog/reorder", { issueId: "i-1", direction: "up" }],
      ["/backlog/move", { issueId: "i-1", beforeIssueId: "i-2" }],
      ["/steering", { prompt: "inspect" }],
      ["/repositories/app/sync", {}],
    ] as const) expect((await formPost(path, fields)).status).toBe(403);
    const dismissal = await handler(new Request("http://localhost/api/issues/i-1/findings/f-1/dismiss", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ reason: "resolved" }),
    }));
    expect(dismissal.status).toBe(403);
    const reclassification = await handler(new Request("http://localhost/api/issues/i-1/findings/f-1/type", {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ type: "bug" }),
    }));
    expect(reclassification.status).toBe(403);
    expect((await handler(new Request("http://localhost/accounts", { headers: { cookie } }))).status).toBe(403);
    expect((await handler(new Request("http://localhost/api/accounts", { headers: { cookie } }))).status).toBe(403);
    expect(calls.retries).toHaveLength(0);
    expect(calls.answers).toHaveLength(0);
    expect(calls.reorders).toHaveLength(0);
    expect(calls.moves).toHaveLength(0);
    expect(calls.steering).toHaveLength(0);
    expect(calls.dismissals).toHaveLength(0);
  });

  test("superusers can list and create accounts, with invalid and duplicate input rejected", async () => {
    const accounts: { id: string; username: string; role: "user"; avatar: string }[] = [];
    const { handler, auth } = setup({
      maxBodyBytes: 4096,
      listAccounts: () => accounts,
      createAccount: (username: string) => {
        if (accounts.some((item) => item.username.toLowerCase() === username.toLowerCase())) throw new Error("duplicate");
        const created = { id: `id-${accounts.length}`, username, role: "user" as const, avatar: "🐼" };
        accounts.push(created);
        return created;
      },
    });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const page = await handler(new Request("http://localhost/accounts", { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("data-app-skeleton");
    expect((await handler(new Request("http://localhost/api/accounts", { headers: { cookie } }))).status).toBe(200);
    const create = (username: string, password = "long enough password") => handler(new Request("http://localhost/api/accounts", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, username, password }),
    }));

    expect((await create("bad name")).status).toBe(400);
    expect(accounts).toHaveLength(0);
    expect((await create("reader")).status).toBe(201);
    expect(accounts).toHaveLength(1);
    expect((await create("reader")).status).toBe(409);
    expect(accounts).toHaveLength(1);
  });

  test("superusers reset and delete regular accounts with CSRF, session, and deletion safeguards", async () => {
    type Account = { id: string; username: string; role: "superuser" | "user"; avatar: string; sessionVersion: number; passwordHash: string };
    let accounts = new Map<string, Account>();
    const admin = { id: "admin-id", username: "admin", role: "superuser" as const, avatar: "🐼", sessionVersion: 1, passwordHash: hashPassword("admin password", { salt: "0123456789abcdef" }) };
    const reader = { id: "reader-id", username: "reader", role: "user" as const, avatar: "🦊", sessionVersion: 1, passwordHash: hashPassword("reader password", { salt: "abcdef0123456789" }) };
    accounts = new Map<string, Account>([[admin.id, admin], [reader.id, reader]]);
    const auth = createWebAuth({
      passwordHash: undefined,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: (id) => accounts.get(id) ?? null,
      accountByUsername: (username) => [...accounts.values()].find((account) => account.username === username) ?? null,
    });
    const { handler } = setup({
      auth,
      maxBodyBytes: 4096,
      listAccounts: () => [...accounts.values()],
      getAccount: (id: string) => accounts.get(id) ?? null,
      changePassword: (id: string, passwordHash: string) => {
        const account = accounts.get(id)!;
        accounts.set(id, { ...account, passwordHash, sessionVersion: account.sessionVersion + 1 });
      },
      deleteAccount: (id: string) => accounts.delete(id) ? "deleted" : "not_found",
    });
    const adminSession = auth.createSession(admin)!;
    const adminCookie = adminSession.cookie.split(";", 1)[0]!;
    const post = (path: string, fields: Record<string, string>, cookie = adminCookie) => handler(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields),
    }));

    expect((await post(`/api/accounts/${reader.id}/password`, { password: "replacement password" }, "")).status).toBe(401);
    const readerSession = auth.createSession(reader)!;
    const readerCookie = readerSession.cookie.split(";", 1)[0]!;
    expect((await post(`/api/accounts/${admin.id}/password`, { csrf: readerSession.csrfToken, password: "replacement password" }, readerCookie)).status).toBe(403);
    expect((await post(`/api/accounts/${reader.id}/delete`, { csrf: readerSession.csrfToken, confirmation: "reader" }, readerCookie)).status).toBe(403);
    expect((await post(`/api/accounts/${reader.id}/password`, { password: "replacement password" })).status).toBe(403);
    expect((await post(`/api/accounts/${reader.id}/delete`, { confirmation: "reader" })).status).toBe(403);
    expect((await post("/api/accounts/missing/password", { csrf: adminSession.csrfToken, password: "replacement password" })).status).toBe(404);
    expect((await post(`/api/accounts/${reader.id}/password`, { csrf: adminSession.csrfToken, password: "short" })).status).toBe(400);
    expect((await post(`/api/accounts/${reader.id}/password`, { csrf: adminSession.csrfToken, password: "replacement password" })).status).toBe(200);
    expect(auth.authenticate("reader", "reader password")).toBe(false);
    expect(auth.authenticate("reader", "replacement password")).toBe(true);
    expect((await handler(new Request("http://localhost/board", { headers: { cookie: readerCookie } }))).status).toBe(303);

    const ownReset = await post(`/api/accounts/${admin.id}/password`, { csrf: adminSession.csrfToken, password: "another admin password" });
    expect(ownReset.status).toBe(303);
    expect((await handler(new Request("http://localhost/board", { headers: { cookie: adminCookie } }))).status).toBe(303);
    const renewedAdmin = auth.createSession(accounts.get(admin.id)!)!;
    const renewedCookie = renewedAdmin.cookie.split(";", 1)[0]!;
    expect((await post(`/api/accounts/${admin.id}/delete`, { csrf: renewedAdmin.csrfToken, confirmation: "admin" }, renewedCookie)).status).toBe(400);
    expect((await post(`/api/accounts/${reader.id}/delete`, { csrf: renewedAdmin.csrfToken, confirmation: "nope" }, renewedCookie)).status).toBe(400);
    expect((await post("/api/accounts/missing/delete", { csrf: renewedAdmin.csrfToken, confirmation: "missing" }, renewedCookie)).status).toBe(404);
    expect((await post(`/api/accounts/${reader.id}/delete`, { csrf: renewedAdmin.csrfToken, confirmation: "reader" }, renewedCookie)).status).toBe(200);
    expect(accounts.has(reader.id)).toBe(false);
    expect((await handler(new Request("http://localhost/board", { headers: { cookie: readerCookie } }))).status).toBe(303);
  });

  test("users can change only their own avatar and password, and password changes revoke old sessions", async () => {
    const hash = hashPassword("initial password", { salt: "0123456789abcdef" });
    let storedHash = hash;
    let account = { id: "reader-id", username: "reader", role: "user" as const, avatar: "🐼", sessionVersion: 1 };
    const auth = createWebAuth({
      passwordHash: hash,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: () => account,
      accountByUsername: (username) => username === account.username ? { ...account, passwordHash: storedHash } : null,
    });
    const dependencies = {
      getAccount: (id: string) => id === account.id ? { ...account, passwordHash: storedHash } : null,
      changePassword: (id: string, nextHash: string) => {
        expect(id).toBe(account.id);
        storedHash = nextHash;
        account = { ...account, sessionVersion: account.sessionVersion + 1 };
      },
      changeAvatar: (id: string, avatar: string) => {
        expect(id).toBe(account.id);
        account = { ...account, avatar };
      },
    };
    const { handler } = setup({ auth, maxBodyBytes: 4096, getDashboardSnapshot: () => ({ seq: 0, model: normalizeDashboard(model) }), ...dependencies });
    const created = auth.createSession(account)!;
    const cookie = created.cookie.split(";")[0]!;
    const csrf = created.csrfToken;
    const post = (path: string, fields: Record<string, string>) => handler(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...fields }),
    }));

    expect((await post("/api/profile/avatar", { avatar: "invalid" })).status).toBe(400);
    expect((await post("/api/profile/avatar", { avatar: "🦊", accountId: "another-user" })).status).toBe(200);
    expect(account.avatar).toBe("🦊");
    // The dashboard draws the profile from the account its snapshot carries.
    const snapshot = await (await handler(new Request("http://localhost/api/v1/snapshot", { headers: { cookie } }))).json() as { account: { avatar: string } };
    expect(snapshot.account.avatar).toBe("🦊");

    expect((await post("/api/profile/password", { currentPassword: "wrong password", newPassword: "replacement password" })).status).toBe(403);
    expect(account.sessionVersion).toBe(1);
    const changed = await post("/api/profile/password", { currentPassword: "initial password", newPassword: "replacement password" });
    expect(changed.status).toBe(303);
    expect((await handler(new Request("http://localhost/board", { headers: { cookie } }))).status).toBe(303);
    const loginResponse = await handler(new Request("http://localhost/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "reader", password: "replacement password" }),
    }));
    expect(loginResponse.status).toBe(303);
    expect(auth.authenticate("reader", "initial password")).toBe(false);
    expect(auth.authenticate("reader", "replacement password")).toBe(true);
  });

  test("retry and roll-up recovery only run through signed-in CSRF protected requests", async () => {
    const { handler, auth, calls } = setup({ maxBodyBytes: 8_192 });
    const url = "http://localhost/api/issues/github%3Aowner%2Frepo%231/retry";
    expect((await handler(new Request(url, { method: "POST" }))).status).toBe(401);
    const { cookie } = await login(handler);
    expect((await handler(new Request(url, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "note=" }))).status).toBe(403);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const post = (note: string) => handler(new Request(url, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ note, csrf }),
    }));
    expect((await post(" ")).status).toBe(202);
    expect(calls.retries).toEqual([["github:owner/repo#1", "", "operator"]]);
    expect((await post("x".repeat(4_001))).status).toBe(400);
    expect((await handler(new Request(url, { method: "GET", headers: { cookie } }))).status).toBe(405);
    const resumeUrl = "https://example.com/api/issues/github%3Aowner%2Frepo%231/resume-waiting";
    expect((await handler(new Request(resumeUrl, { method: "POST" }))).status).toBe(401);
    expect((await handler(new Request(resumeUrl, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "" }))).status).toBe(403);
    expect((await handler(new Request(resumeUrl, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }),
    }))).status).toBe(202);
    expect((await handler(new Request(resumeUrl, { method: "GET", headers: { cookie } }))).status).toBe(405);
  });

  test("reports a rejected source retry as a conflict", async () => {
    const { handler, auth } = setup({ retryIssue: async () => { throw new Error("source label update failed"); } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const response = await handler(new Request("http://localhost/api/issues/i1/retry", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ note: "feedback", csrf }),
    }));
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("source label update failed");
  });

  test("dismisses a finding only for an authenticated session with CSRF and a reason", async () => {
    const { handler, auth, calls } = setup({ maxBodyBytes: 4096 });
    const url = "http://localhost/api/issues/github%3Aowner%2Frepo%231/findings/F-1/dismiss";
    const post = (headers: Record<string, string>, body: string) => handler(new Request(url, { method: "POST", headers, body }));
    const json = { "content-type": "application/json" };
    expect((await post(json, JSON.stringify({ reason: "ok" }))).status).toBe(401);
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    expect((await post({ ...json, cookie }, JSON.stringify({ reason: "ok" }))).status).toBe(403);
    expect((await post({ ...json, cookie, "x-csrf-token": csrf }, JSON.stringify({ reason: "  " }))).status).toBe(400);
    expect((await post({ ...json, cookie, "x-csrf-token": csrf }, "not json")).status).toBe(400);
    expect((await post({ cookie, "x-csrf-token": csrf, "content-type": "text/plain" }, "{}")).status).toBe(415);
    expect((await handler(new Request(url, { headers: { cookie } }))).status).toBe(405);
    expect(calls.dismissals).toEqual([]);
    const ok = await post({ ...json, cookie, "x-csrf-token": csrf }, JSON.stringify({ reason: "Not applicable" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, correlationId: expect.any(String) });
    expect(calls.dismissals).toEqual([["github:owner/repo#1", "F-1", "Not applicable", "operator"]]);
  });

  test("reclassifies a finding only for a signed-in superuser with CSRF and a known type", async () => {
    const reclassified: unknown[][] = [];
    const { handler, auth } = setup({ maxBodyBytes: 4096, reclassifyFinding: (...args: unknown[]) => { reclassified.push(args); return { changed: true }; } });
    const url = "http://localhost/api/issues/github%3Aowner%2Frepo%231/findings/F-1/type";
    const post = (headers: Record<string, string>, body: string) => handler(new Request(url, { method: "POST", headers, body }));
    const json = { "content-type": "application/json" };
    expect((await post(json, JSON.stringify({ type: "bug" }))).status).toBe(401);
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    expect((await post({ ...json, cookie }, JSON.stringify({ type: "bug" }))).status).toBe(403);
    expect((await post({ ...json, cookie, "x-csrf-token": "wrong" }, JSON.stringify({ type: "bug" }))).status).toBe(403);
    expect((await post({ ...json, cookie, "x-csrf-token": csrf }, JSON.stringify({ type: "nonsense" }))).status).toBe(400);
    expect((await post({ ...json, cookie, "x-csrf-token": csrf }, "not json")).status).toBe(400);
    expect((await post({ cookie, "x-csrf-token": csrf, "content-type": "text/plain" }, "{}")).status).toBe(415);
    expect((await handler(new Request(url, { headers: { cookie } }))).status).toBe(405);
    expect(reclassified).toEqual([]);
    const reader = { id: "reader-id", username: "reader", role: "user" as const, avatar: "🦊", sessionVersion: 1 };
    const hash = hashPassword("correct horse", { salt: "0123456789abcdef" });
    const readerAuth = createWebAuth({
      passwordHash: hash,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: () => reader,
      accountByUsername: (username) => username === reader.username ? { ...reader, passwordHash: hash } : null,
    });
    const nonSuperuser = setup({ auth: readerAuth, reclassifyFinding: (...args: unknown[]) => { reclassified.push(args); return { changed: true }; } });
    const readerSession = readerAuth.createSession(reader)!;
    const refused = await nonSuperuser.handler(new Request(url, {
      method: "POST",
      headers: { ...json, cookie: readerSession.cookie.split(";")[0]!, "x-csrf-token": readerSession.csrfToken },
      body: JSON.stringify({ type: "bug" }),
    }));
    expect(refused.status).toBe(403);
    expect(reclassified).toEqual([]);
    const ok = await post({ ...json, cookie, "x-csrf-token": csrf }, JSON.stringify({ type: "security" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, changed: true, correlationId: expect.any(String) });
    expect(reclassified).toEqual([["github:owner/repo#1", "F-1", "security", "operator"]]);
  });

  test("a rejected dismissal is a conflict with the reason", async () => {
    const { handler, auth } = setup({ maxBodyBytes: 4096, dismissFinding: async () => { throw new Error("Finding F-1 is resolved, not open"); } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const response = await handler(new Request("http://localhost/api/issues/i1/findings/F-1/dismiss", {
      method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Finding F-1 is resolved, not open" });
  });

  test("delegates configured webhook raw body and headers without requiring a session", async () => {
    const { handler, calls } = setup();
    const body = '{ "action": "opened" }';
    const response = await handler(new Request("http://localhost/hooks/custom", {
      method: "POST", headers: { "x-hub-signature-256": "sha256=test" }, body,
    }));
    expect(response.status).toBe(202);
    const [raw, headers] = calls.webhooks[0] as [Uint8Array, Headers];
    expect(new TextDecoder().decode(raw)).toBe(body);
    expect(headers.get("x-hub-signature-256")).toBe("sha256=test");
    expect((await handler(new Request("http://localhost/hooks/other", { method: "POST" }))).status).toBe(404);
  });

  test("requires bearer auth and JSON for internal MCP requests", async () => {
    const { handler, calls } = setup();
    expect((await handler(new Request("http://localhost/internal/mcp", { method: "POST" }))).status).toBe(401);
    const response = await handler(new Request("http://localhost/internal/mcp", {
      method: "POST",
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json" },
      body: JSON.stringify({ tool: "run.report_progress" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.mcp).toEqual([[{ tool: "run.report_progress" }, "internal-secret", undefined]]);

    await handler(new Request("http://localhost/internal/mcp", {
      method: "POST",
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json", "x-conveyor-call-id": "retry-1" },
      body: JSON.stringify({ tool: "run.report_progress" }),
    }));
    expect(calls.mcp.at(-1)).toEqual([{ tool: "run.report_progress" }, "internal-secret", "retry-1"]);
  });

  test("returns actionable item input errors, and keeps operational failures opaque, to MCP clients", async () => {
    const { handler } = setup({
      handleMcp: async (request: { tool: string }) => {
        if (request.tool === "item.createChild") {
          throw new ToolRequestError("Invalid dependsOn value 166: it must identify an open, Conveyor-enrolled issue in this repository");
        }
        if (request.tool === "item.setFields") throw new ToolRequestError("This repository has no refinement configuration");
        if (request.tool === "workspace.push") {
          throw new ToolRequestError("workspace.push: headSha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is not the current change head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; read change.get and retry");
        }
        throw new Error("database password leaked");
      },
    });
    const request = (tool: string, input: Record<string, unknown>) => handler(new Request("http://localhost/internal/mcp", {
      method: "POST",
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json" },
      body: JSON.stringify({ tool, input }),
    }));

    const dependency = await request("item.createChild", { title: "Child", dependsOn: [166] });
    expect(dependency.status).toBe(422);
    expect(await dependency.json()).toEqual({ error: "Invalid dependsOn value 166: it must identify an open, Conveyor-enrolled issue in this repository" });
    const fields = await request("item.setFields", { fields: [{ name: "Effort", value: "Low" }] });
    expect(fields.status).toBe(422);
    expect(await fields.json()).toEqual({ error: "This repository has no refinement configuration" });
    const stalePush = await request("workspace.push", { forceWithLease: true, headSha: "a".repeat(40) });
    expect(stalePush.status).toBe(422);
    expect(await stalePush.json()).toEqual({ error: "workspace.push: headSha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is not the current change head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; read change.get and retry" });
    const failure = await request("item.setTitle", { title: "Valid title" });
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: "MCP request failed" });
  });

  test("enforces body limits and rejects malformed or unsupported forms", async () => {
    const { handler } = setup();
    expect((await handler(new Request("http://localhost/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }))).status).toBe(415);
    expect((await handler(new Request("http://localhost/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x=".repeat(100),
    }))).status).toBe(413);
  });

  test("the team view carries the agent profiles, and old agent links redirect to it", async () => {
    const profile = {
      id: "kaveh", name: "Kaveh", title: "Senior Developer", harness: "codex", model: null, effort: null,
      access: "workspace-write", usage: [], tasks: [], instructions: null,
    };
    const { handler } = setup({
      getAgentProfiles: async () => [profile],
      getAgentProfile: async (id: string) => (id === "kaveh" ? profile : null),
    });
    const unauthenticated = await handler(new Request("http://localhost/agents"));
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe("/login");
    expect((await handler(new Request("http://localhost/agents/kaveh"))).headers.get("location")).toBe("/login");

    const { cookie } = await login(handler);
    const team = await handler(new Request("http://localhost/api/v1/views/team", { headers: { cookie } }));
    expect(await team.json()).toEqual({ team: [profile] });

    const list = await handler(new Request("http://localhost/agents", { headers: { cookie } }));
    expect(list.status).toBe(301);
    expect(list.headers.get("location")).toBe("/team");
    const page = await handler(new Request("http://localhost/agents/kaveh", { headers: { cookie } }));
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe("/team/kaveh");

    expect((await handler(new Request("http://localhost/agents/nobody", { headers: { cookie } }))).status).toBe(404);
    expect((await handler(new Request("http://localhost/agents/kaveh", { method: "POST", headers: { cookie } }))).status).toBe(405);
  });
});

describe("dashboard commands", () => {
  const ISSUE = encodeURIComponent("github:owner/repo#1");
  const p256dh = Buffer.alloc(65, 1).toString("base64url");
  const authKey = Buffer.alloc(16, 2).toString("base64url");

  test("every route that changes state sends exactly its command", async () => {
    const passwordHash = hashPassword("correct horse", { salt: "0123456789abcdef" });
    const { handler, auth, events } = setup({
      maxBodyBytes: 8_192,
      pushPublicKey: "public-key",
      getAccount: (id: string) => ({ id, username: id === "user-2" ? "someone" : "operator", role: id === "user-2" ? "user" : "superuser", avatar: "fox", sessionVersion: 0, passwordHash }),
      createAccount: () => ({ id: "user-3", username: "new-user", role: "user", avatar: "fox", sessionVersion: 0 }),
      changePassword: () => {},
      deleteAccount: () => "deleted",
      changeAvatar: () => {},
      setPushPreferences: () => {},
      putPushSubscription: () => {},
      deletePushSubscription: () => {},
      syncRepository: () => ({ issues: 3, failed: false }),
      pauseRepository: () => ({ pausedAt: "2026-10-18T12:00:00.000Z" }),
      resumeRepository: () => ({ resumedAt: "2026-10-18T12:00:00.000Z" }),
    });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const form = (path: string, fields: Record<string, string>) => handler(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...fields, csrf }),
    }));
    const json = (path: string, body: unknown, method = "POST") => handler(new Request(`http://localhost${path}`, {
      method, headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body),
    }));
    const routes: Array<[string, () => Promise<Response>]> = [
      ["question.answer", () => form("/questions/q-1/answer", { answer: "yes" })],
      ["gate.setItemApproval", () => form("/manual-gates/requirement", { issueId: "i-1", stageId: "review", required: "true" })],
      ["gate.approve", () => form("/manual-gates/approve", { issueId: "i-1", stageId: "review", gateId: "gate" })],
      ["backlog.reorder", () => form("/backlog/reorder", { issueId: "i-1", direction: "up" })],
      ["backlog.move", () => form("/backlog/move", { issueId: "i-1", beforeIssueId: "" })],
      ["repository.sync", () => form("/repositories/app/sync", {})],
      ["repository.pause", () => form("/repositories/app/pause", { reason: "CI budget" })],
      ["repository.resume", () => form("/repositories/app/resume", {})],
      ["item.postMessage", () => form(`/api/issues/${ISSUE}/conversation`, { message: "Please continue" })],
      ["item.retry", () => form(`/api/issues/${ISSUE}/retry`, { note: "" })],
      ["item.resumeRollup", () => form(`/api/issues/${ISSUE}/resume-waiting`, {})],
      ["finding.dismiss", () => json(`/api/issues/${ISSUE}/findings/f-1/dismiss`, { reason: "Not applicable" })],
      ["steering.start", () => form("/steering", { prompt: "Check the board" })],
      ["notifications.updateSettings", () => json("/api/notifications/settings", { questions: true, stopped: false, done: false })],
      ["notifications.subscribe", () => json("/api/notifications/subscriptions", { endpoint: "https://push.example.com/1", keys: { p256dh, auth: authKey } })],
      ["notifications.unsubscribe", () => json("/api/notifications/subscriptions", { endpoint: "https://push.example.com/1" }, "DELETE")],
      ["account.create", () => form("/api/accounts", { username: "new-user", password: "a long enough password" })],
      ["account.setPassword", () => form("/api/accounts/user-2/password", { password: "a long enough password" })],
      ["account.delete", () => form("/api/accounts/user-2/delete", { confirmation: "someone" })],
      ["account.setAvatar", () => form("/api/profile/avatar", { avatar: PROFILE_AVATARS[0]! })],
    ];
    for (const [command, send] of routes) {
      const after = events.latestSeq();
      const response = await send();
      expect({ command, status: response.status < 400 }).toEqual({ command, status: true });
      expect(events.read({ afterSeq: after }).map((event) => [event.type, event.payload])).toEqual([["command.accepted", { command }]]);
    }
  });

  test("a command refused by the bus is recorded and answered with its status", async () => {
    const { handler, auth, events } = setup();
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    // No account-management fake: the command has no handler in this process.
    const response = await handler(new Request("http://localhost/api/profile/avatar", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ avatar: PROFILE_AVATARS[0]!, csrf }),
    }));
    expect(response.status).toBe(503);
    expect(events.read({ type: "command.rejected" }).map((event) => event.payload)).toEqual([{ command: "account.setAvatar", reason: "account.setAvatar is unavailable" }]);
  });
});

describe("repository sync", () => {
  test("a superuser syncs one repository and is sent back to its page", async () => {
    const synced: string[] = [];
    const { handler, auth } = setup({ syncRepository: (id: string) => { synced.push(id); return { issues: 3, failed: false }; } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const response = await handler(new Request("http://localhost/repositories/my-app/sync", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }),
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/repositories/my-app");
    expect(synced).toEqual(["my-app"]);
  });

  test("a sync without the CSRF token is refused", async () => {
    const synced: string[] = [];
    const { handler } = setup({ syncRepository: (id: string) => { synced.push(id); return { issues: 3, failed: false }; } });
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/repositories/my-app/sync", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({}),
    }));
    expect(response.status).toBe(403);
    expect(synced).toEqual([]);
  });

  test("a sync that could not read GitHub answers JSON callers with its outcome", async () => {
    const { handler, auth } = setup({ syncRepository: () => ({ issues: 3, failed: true }) });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const response = await handler(new Request("http://localhost/repositories/my-app/sync", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ csrf }),
    }));
    expect(await response.json()).toMatchObject({ ok: false, issues: 3, failed: true });
  });
});

describe("repository pause", () => {
  test("a superuser pauses and resumes a repository with a CSRF-protected command", async () => {
    const calls: Array<[string, string, string?]> = [];
    const { handler, auth } = setup({
      pauseRepository: (id: string, reason: string, actor: string) => { calls.push(["pause", id, `${actor}: ${reason}`]); return { pausedAt: "2026-10-18T12:00:00.000Z" }; },
      resumeRepository: (id: string) => { calls.push(["resume", id]); return { resumedAt: "2026-10-18T13:00:00.000Z" }; },
    });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const pause = await handler(new Request("http://localhost/repositories/my-app/pause", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, reason: "CI budget" }),
    }));
    const resume = await handler(new Request("http://localhost/repositories/my-app/resume", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }),
    }));
    expect(pause.headers.get("location")).toBe("/repositories/my-app");
    expect(resume.headers.get("location")).toBe("/repositories/my-app");
    expect(calls).toEqual([["pause", "my-app", "operator: CI budget"], ["resume", "my-app"]]);
  });

  test("repository pause rejects unsigned, forged, and non-superuser requests", async () => {
    const paused: string[] = [];
    const { handler, auth } = setup({ pauseRepository: (id: string) => { paused.push(id); return { pausedAt: "2026-10-18T12:00:00.000Z" }; } });
    expect((await handler(new Request("http://localhost/repositories/my-app/pause", { method: "POST" }))).status).toBe(401);
    const { cookie } = await login(handler);
    expect((await handler(new Request("http://localhost/repositories/my-app/pause", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({}),
    }))).status).toBe(403);
    const reader = { id: "reader-id", username: "reader", role: "user" as const, avatar: "🦊", sessionVersion: 1 };
    const readerSession = auth.createSession(reader)!;
    expect((await handler(new Request("http://localhost/repositories/my-app/pause", {
      method: "POST", headers: { cookie: readerSession.cookie.split(";", 1)[0]!, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: readerSession.csrfToken }),
    }))).status).toBe(403);
    expect(paused).toEqual([]);
  });
});

describe("manual gate routes", () => {
  test("a script gets the command's correlation id instead of a redirect", async () => {
    const approvals: string[] = [];
    const { handler, auth } = setup({ approveManualGate: (issueId: string) => { approvals.push(issueId); } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const response = await handler(new Request("http://localhost/manual-gates/approve", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ csrf, issueId: "i-1", stageId: "review", gateId: "approval" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, correlationId: expect.any(String) });
    expect(approvals).toEqual(["i-1"]);
  });

  test("a script gets a refused change as JSON", async () => {
    const { handler, auth } = setup({ approveManualGate: () => { throw new Error("Gate approval is not waiting"); } });
    const { cookie } = await login(handler);
    const csrf = auth.getSession(cookie)!.csrfToken;
    const response = await handler(new Request("http://localhost/manual-gates/approve", {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ csrf, issueId: "i-1", stageId: "review", gateId: "approval" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Gate approval is not waiting" });
  });
});

describe("dashboard snapshot and patch stream", () => {
  type Account = { id: string; username: string; role: "superuser" | "user"; avatar: string; sessionVersion: number; passwordHash: string };

  function liveSetup() {
    const admin: Account = { id: "admin-id", username: "admin", role: "superuser", avatar: "🐼", sessionVersion: 1, passwordHash: hashPassword("admin password", { salt: "0123456789abcdef" }) };
    const reader: Account = { id: "reader-id", username: "reader", role: "user", avatar: "🦊", sessionVersion: 1, passwordHash: hashPassword("reader password", { salt: "abcdef0123456789" }) };
    const accounts = new Map([[admin.id, admin], [reader.id, reader]]);
    const auth = createWebAuth({
      passwordHash: undefined,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: (id) => accounts.get(id) ?? null,
      accountByUsername: (username) => [...accounts.values()].find((account) => account.username === username) ?? null,
    });
    const board = { ...model, backlog: [detailIssue], restrictedRepositories: [{ id: "repo", folder: "/srv/repo", agentEgressHosts: [] }] };
    const state = { board };
    const feed = new DashboardFeed({ build: () => normalizeDashboard(state.board), settleMs: 5, maxWaitMs: 20 });
    const { handler } = setup({
      auth,
      getDashboardSnapshot: () => feed.snapshot(),
      subscribeDashboardFeed: (listener: Parameters<DashboardFeed["subscribe"]>[0], after: number | null) => feed.subscribe(listener, after),
      getDashboardFeedStatus: () => feed.status,
    });
    const cookie = (account: Account) => auth.createSession(account)!.cookie.split(";", 1)[0]!;
    return { handler, feed, state, adminCookie: cookie(admin), readerCookie: cookie(reader) };
  }

  async function readUntil(response: Response, done: (text: string) => boolean, timeoutMs = 2_000): Promise<string> {
    const reader = response.body!.getReader();
    let text = "";
    try {
      await Promise.race([
        (async () => {
          while (!done(text)) {
            const next = await reader.read();
            if (next.done) return;
            text += new TextDecoder().decode(next.value);
          }
        })(),
        Bun.sleep(timeoutMs).then(() => { throw new Error(`stream timed out with: ${text}`); }),
      ]);
    } finally {
      await reader.cancel();
    }
    return text;
  }

  test("requires a session", async () => {
    const { handler, feed } = liveSetup();
    expect((await handler(new Request("http://localhost/api/v1/snapshot"))).status).toBe(401);
    expect((await handler(new Request("http://localhost/api/v1/stream"))).status).toBe(401);
    feed.close();
  });

  test("sends the normalized model with the session's own token and no superuser data to a regular user", async () => {
    const { handler, feed, readerCookie } = liveSetup();
    const response = await handler(new Request("http://localhost/api/v1/snapshot", { headers: { cookie: readerCookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const snapshot = dashboardSnapshotSchema.parse(await response.json());
    expect(snapshot.account).toEqual({ id: "reader-id", username: "reader", role: "user", avatar: "🦊" });
    expect(snapshot.model.items[detailIssue.id]).toMatchObject({ title: "Keep <item> safe", placement: "backlog" });
    expect(snapshot.model.restrictedRepositories).toEqual({});
    expect(snapshot.csrfToken).not.toBe("");
    feed.close();
  });

  test("sends superuser data to a superuser", async () => {
    const { handler, feed, adminCookie } = liveSetup();
    const snapshot = dashboardSnapshotSchema.parse(await (await handler(new Request("http://localhost/api/v1/snapshot", { headers: { cookie: adminCookie } }))).json());
    expect(Object.keys(snapshot.model.restrictedRepositories)).toEqual(["repo"]);
    feed.close();
  });

  test("streams a changed item as a patch of its changed fields", async () => {
    const { handler, feed, state, readerCookie } = liveSetup();
    feed.snapshot();
    const stream = await handler(new Request("http://localhost/api/v1/stream", { headers: { cookie: readerCookie } }));
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    state.board = { ...state.board, backlog: [{ ...detailIssue, title: "Renamed" }] };
    feed.invalidate();
    const text = await readUntil(stream, (received) => received.includes("event: patch"));
    const data = text.split("\n").find((line) => line.startsWith("data: {\"seq\""))!.slice(6);
    expect(JSON.parse(data)).toEqual({ seq: expect.any(Number), entity: "item", id: detailIssue.id, op: "upsert", data: { title: "Renamed" } });
    feed.close();
  });

  test("replays what a reconnecting dashboard missed, and asks it to reload when that is no longer kept", async () => {
    const { handler, feed, state, readerCookie } = liveSetup();
    const { seq } = feed.snapshot();
    state.board = { ...state.board, backlog: [{ ...detailIssue, title: "Renamed" }] };
    feed.invalidate();
    feed.flush();
    const replayed = await readUntil(
      await handler(new Request("http://localhost/api/v1/stream", { headers: { cookie: readerCookie, "last-event-id": String(seq) } })),
      (received) => received.includes("event: patch"),
    );
    expect(replayed).toContain(`id: ${seq + 1}\nevent: patch`);
    const reset = await readUntil(
      await handler(new Request(`http://localhost/api/v1/stream?after=${seq + 50}`, { headers: { cookie: readerCookie } })),
      (received) => received.includes("event: reset"),
    );
    expect(reset).toContain("event: reset");
    feed.close();
  });

  test("sends EventSource-observable keep-alives at least every five seconds", async () => {
    const { handler, feed, readerCookie } = liveSetup();
    const stream = await handler(new Request("http://localhost/api/v1/stream", { headers: { cookie: readerCookie } }));
    const started = performance.now();
    // One keep-alive opens the stream; the second is the first heartbeat.
    const text = await readUntil(stream, (received) => (received.match(/event: keep-alive\ndata: \{\}\n\n/g) ?? []).length >= 2, 5_500);
    expect((text.match(/event: keep-alive/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(performance.now() - started).toBeLessThan(5_000);
    feed.close();
  });

  test("keeps superuser entities out of a regular user's stream", async () => {
    const { handler, feed, state, readerCookie, adminCookie } = liveSetup();
    const { seq } = feed.snapshot();
    state.board = { ...state.board, restrictedRepositories: [{ id: "repo", folder: "/srv/other", agentEgressHosts: [] }], backlog: [{ ...detailIssue, title: "Renamed" }] };
    feed.invalidate();
    feed.flush();
    // A later change: anything leaked from the first one would arrive before it.
    state.board = { ...state.board, backlog: [{ ...detailIssue, title: "Renamed again" }] };
    feed.invalidate();
    feed.flush();
    const request = (cookie: string) => handler(new Request(`http://localhost/api/v1/stream?after=${seq}`, { headers: { cookie } }));
    const forReader = await readUntil(await request(readerCookie), (received) => received.includes("Renamed again"));
    const forAdmin = await readUntil(await request(adminCookie), (received) => received.includes("Renamed again"));
    expect(forReader).not.toContain("restrictedRepository");
    expect(forAdmin).toContain("\"entity\":\"restrictedRepository\"");
    feed.close();
  });
});

describe("dashboard application", () => {
  test("serves the same data-free shell with a loading skeleton for every dashboard path", async () => {
    const { handler } = setup();
    const { cookie } = await login(handler);
    const board = await handler(new Request("http://localhost/", { headers: { cookie } }));
    const item = await handler(new Request("http://localhost/issues/repo/7", { headers: { cookie } }));
    expect(board.status).toBe(200);
    expect(board.headers.get("content-type")).toContain("text/html");
    expect(board.headers.get("cache-control")).toBe("no-store");
    const html = await board.text();
    expect(html).toBe(await item.text());
    expect(html).toContain("data-app-skeleton");
    expect(html).toMatch(/<script type="module" src="\/assets\/app\.js\?v=[a-z0-9]+"><\/script>/);
    expect(html).not.toContain("Keep <item> safe");
    expect(board.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  test("serves the application script, cached for good under its own version", async () => {
    const { handler } = setup();
    const { cookie } = await login(handler);
    const html = await (await handler(new Request("http://localhost/", { headers: { cookie } }))).text();
    const src = /src="(\/assets\/app\.js\?v=[a-z0-9]+)"/.exec(html)![1]!;
    const script = await handler(new Request(`http://localhost${src}`));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect((await script.text()).length).toBeGreaterThan(1_000);
    const unversioned = await handler(new Request("http://localhost/assets/app.js"));
    expect(unversioned.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("older finished items", () => {
  test("lists the most recent finished items up to a limit, for a signed-in reader only", async () => {
    const calls: Array<{ limit: number; q: string; repositoryIds: readonly string[] }> = [];
    const { handler } = setup({
      getDashboardDone: (selection: { limit: number; q: string; repositoryIds: readonly string[] }) => {
        calls.push(selection);
        return [{ id: "github:owner/repo#3", placement: "done", order: 0, title: "Finished" }];
      },
    });
    expect((await handler(new Request("http://localhost/api/v1/done?limit=60"))).status).toBe(401);
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/v1/done?limit=60", { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: "github:owner/repo#3", placement: "done", order: 0, title: "Finished" }] });
    expect(calls).toEqual([{ limit: 60, q: "", repositoryIds: [] }]);
  });

  test("passes the board's search and repository filters on, to find older finished items", async () => {
    const calls: Array<{ limit: number; q: string; repositoryIds: readonly string[] }> = [];
    const { handler } = setup({ getDashboardDone: (selection: { limit: number; q: string; repositoryIds: readonly string[] }) => { calls.push(selection); return []; } });
    const { cookie } = await login(handler);
    await handler(new Request("http://localhost/api/v1/done?limit=50&q=%23245&repo=alpha&repo=beta", { headers: { cookie } }));
    expect(calls).toEqual([{ limit: 50, q: "#245", repositoryIds: ["alpha", "beta"] }]);
  });

  test("refuses a limit outside 1 to 500", async () => {
    const { handler } = setup({ getDashboardDone: () => [] });
    const { cookie } = await login(handler);
    for (const limit of ["0", "501", "abc"]) {
      expect((await handler(new Request(`http://localhost/api/v1/done?limit=${limit}`, { headers: { cookie } }))).status).toBe(400);
    }
  });
});

describe("recent activity page", () => {
  test("returns the page for the address's filters and cursor to a signed-in reader", async () => {
    const selections: unknown[] = [];
    const page = { types: ["done"], repositoryIds: ["repo"], events: [], nextCursor: null, rangeStartedAt: null };
    const { handler } = setup({ getRecentActivity: (selection: unknown) => { selections.push(selection); return page; } });
    expect((await handler(new Request("http://localhost/api/v1/recent"))).status).toBe(401);
    const { cookie } = await login(handler);
    const response = await handler(new Request("http://localhost/api/v1/recent?type=done&repo=repo&beforeAt=2026-10-20T00:00:00.000Z&beforeId=e1", { headers: { cookie } }));
    expect(await response.json()).toEqual(page);
    expect(selections[0]).toMatchObject({ view: "recent", recentTypes: ["done"], repositoryIds: ["repo"], recentCursor: { occurredAt: "2026-10-20T00:00:00.000Z", id: "e1" } });
  });
});

describe("view data for the dashboard application", () => {
  type Account = { id: string; username: string; role: "superuser" | "user"; avatar: string; sessionVersion: number; passwordHash: string };
  function viewSetup() {
    const admin: Account = { id: "admin-id", username: "admin", role: "superuser", avatar: "🐼", sessionVersion: 1, passwordHash: hashPassword("admin password", { salt: "0123456789abcdef" }) };
    const reader: Account = { id: "reader-id", username: "reader", role: "user", avatar: "🦊", sessionVersion: 1, passwordHash: hashPassword("reader password", { salt: "abcdef0123456789" }) };
    const accounts = new Map([[admin.id, admin], [reader.id, reader]]);
    const auth = createWebAuth({
      passwordHash: undefined,
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      accountById: (id) => accounts.get(id) ?? null,
      accountByUsername: (username) => [...accounts.values()].find((account) => account.username === username) ?? null,
    });
    const reports: unknown[] = [];
    const runs: unknown[] = [];
    const { handler } = setup({
      auth,
      getReport: (input: unknown) => { reports.push(input); return (input as { repository: string | null }).repository === "missing" ? null : { period: "30d" }; },
      getSteeringView: (run: string | null) => { runs.push(run); return { enabled: true, agent: "omid", selected: null, recent: [] }; },
      listAccounts: () => [{ id: "reader-id", username: "reader", role: "user", avatar: "🦊" }],
      getPushPreferences: () => ({ questions: true, stopped: false, done: false }),
      getAgentProfiles: () => [],
    });
    const cookie = (account: Account) => auth.createSession(account)!.cookie.split(";", 1)[0]!;
    const get = (path: string, as: Account | null = reader) => handler(new Request(`http://localhost${path}`, { headers: as ? { cookie: cookie(as) } : {} }));
    return { get, admin, reports, runs };
  }

  test("requires a session", async () => {
    const { get } = viewSetup();
    expect((await get("/api/v1/views/team", null)).status).toBe(401);
  });

  test("returns the team", async () => {
    const { get } = viewSetup();
    expect(await (await get("/api/v1/views/team")).json()).toEqual({ team: [] });
  });

  test("returns a report for its period and repository, and refuses an unknown period", async () => {
    const { get, reports } = viewSetup();
    expect(await (await get("/api/v1/views/reports?period=30d&repository=repo")).json()).toEqual({ report: { period: "30d" } });
    expect(reports).toEqual([{ period: "30d", repository: "repo" }]);
    expect((await get("/api/v1/views/reports?period=forever")).status).toBe(400);
    expect((await get("/api/v1/views/reports?repository=missing")).status).toBe(404);
  });

  test("returns the Operator for a run or the latest one", async () => {
    const { get, runs } = viewSetup();
    expect((await get("/api/v1/views/operator?run=run-7")).status).toBe(200);
    expect((await get("/api/v1/views/operator")).status).toBe(200);
    expect(runs).toEqual(["run-7", null]);
  });

  test("returns accounts to a superuser only", async () => {
    const { get, admin } = viewSetup();
    expect((await get("/api/v1/views/accounts")).status).toBe(403);
    expect(await (await get("/api/v1/views/accounts", admin)).json()).toEqual({ accounts: [{ id: "reader-id", username: "reader", role: "user", avatar: "🦊" }] });
  });

  test("returns the reader's own notification settings", async () => {
    const { get } = viewSetup();
    expect(await (await get("/api/v1/views/notifications")).json()).toEqual({ notifications: { questions: true, stopped: false, done: false } });
  });

  test("returns the running build for About", async () => {
    const { get } = viewSetup();
    expect(await (await get("/api/v1/views/about")).json()).toEqual({ build: JSON.parse(JSON.stringify(BUILD)) });
  });

  test("knows no other view", async () => {
    const { get } = viewSetup();
    expect((await get("/api/v1/views/secrets")).status).toBe(404);
  });
});

describe("operator request from the application", () => {
  test("answers a JSON request with the new run instead of a redirect", async () => {
    const auth = createWebAuth({ passwordHash: undefined, sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes", accountById: () => ({ id: "admin-id", username: "admin", role: "superuser", avatar: "🐼", sessionVersion: 1 }), accountByUsername: () => null });
    const { handler } = setup({ auth });
    const session = auth.createSession({ id: "admin-id", username: "admin", role: "superuser", avatar: "🐼", sessionVersion: 1 })!;
    const response = await handler(new Request("http://localhost/steering", {
      method: "POST",
      headers: { cookie: session.cookie.split(";", 1)[0]!, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ prompt: "Check the board", csrf: session.csrfToken }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, runId: "run-1" });
  });
});
