import { describe, expect, test } from "bun:test";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import type { DashboardViewModel } from "../../src/web/types";

const model: DashboardViewModel = {
  title: "Test board",
  project: "org/repo",
  totalUsage: "12M in · 80K out",
  updatedAt: "2026-09-29T12:00:00Z",
  revision: "revision-1",
  view: "board",
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
    name: "Needs attention",
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
  steering: { enabled: false, agent: null, selected: null, recent: [] },
  csrfToken: "filled-by-handler",
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
  dismissals: unknown[][];
}

function setup(overrides: Record<string, unknown> = {}) {
  const auth = createWebAuth({
    passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
  });
  const calls: CallLog = { answers: [], reorders: [], moves: [], webhooks: [], mcp: [], steering: [], issueActivity: [], issueRunEvents: [], issueConversation: [], issueJourney: [], messages: [], dismissals: [] };
  const dependencies = {
    auth,
    username: "operator",
    getDashboard: () => model,
    getDashboardRevision: () => "revision-1",
    getConversationRevision: () => "conversation-1",
    getActivityRevision: () => "activity-1",
    getSystemStatus: async () => ({
      memory: { usedBytes: 8_000, totalBytes: 16_000, processBytes: 1_000 },
      disk: { usedBytes: 20_000, totalBytes: 100_000, availableBytes: 80_000 },
      uptimeSeconds: 3_600,
    }),
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
      };
    },
    getIssueRoute: async (reference: { id?: string; repository?: string; number?: number }) => {
      if (reference.id === "github:owner/repo#1" || (reference.repository === "repo" && reference.number === 1)) {
        return { id: "github:owner/repo#1", repository: "repo", number: 1 };
      }
      return null;
    },
    postIssueMessage: async (...args: unknown[]) => { calls.messages.push(args); },
    dismissFinding: async (...args: unknown[]) => { calls.dismissals.push(args); },
    ...overrides,
  };
  return { handler: createWebHandler(dependencies as never), auth, calls };
}

async function login(handler: (request: Request) => Promise<Response>) {
  const response = await handler(new Request("http://localhost/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "correct horse" }),
  }));
  return { response, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

describe("createWebHandler", () => {
  test("keeps liveness public and protects readiness and the dashboard", async () => {
    const { handler } = setup();
    const live = await handler(new Request("http://localhost/health/live"));
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("application/json");
    expect(await live.json()).toEqual({ status: "live" });

    expect((await handler(new Request("http://localhost/health/ready"))).status).toBe(401);
    const unauthenticated = await handler(new Request("http://localhost/"));
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe("/login");
    expect((await handler(new Request("http://localhost/login"))).headers.get("content-type")).toContain("text/html");
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
    const dashboardCalls: unknown[][] = [];
    const { handler, auth } = setup({
      getDashboard: (...args: unknown[]) => {
        dashboardCalls.push(args);
        return model;
      },
    });
    const { response, cookie } = await login(handler);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/board");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await handler(new Request("http://localhost/issues/repo/1?column=stage%3Areview&page=4&doneLimit=40", { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Test board");
    expect(dashboardCalls).toEqual([[expect.any(String), {
      view: "board",
      column: "stage:review",
      page: 4,
      doneLimit: 40,
      runId: null,
      issueId: "github:owner/repo#1",
    }]]);

    const csrf = auth.getSession(cookie)?.csrfToken ?? "";
    const logout = await handler(new Request("http://localhost/logout", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    }));
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("serves REST dashboard paths, redirects legacy URLs permanently, and rejects unknown resources", async () => {
    const dashboardCalls: Array<{ view: string; runId: string | null; issueId: string | null }> = [];
    const profile = {
      id: "kaveh", name: "Kaveh", title: "Developer", harness: "codex", model: null, effort: null,
      access: "workspace-write", usage: [], tasks: [], instructions: null,
    };
    const { handler } = setup({
      getDashboard: (_csrf: string, page: { view: string; runId: string | null; issueId: string | null }) => {
        dashboardCalls.push(page);
        return { ...model, view: page.view, selectedIssue: null };
      },
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

    for (const [path, view] of [["/", "board"], ["/board", "board"], ["/attention", "attention"], ["/team", "team"], ["/operator", "agent"]] as const) {
      expect((await get(path)).status).toBe(200);
      expect(dashboardCalls.at(-1)?.view).toBe(view);
    }
    expect((await get("/team/kaveh")).status).toBe(200);
    expect((await get("/operator/runs/run-1")).status).toBe(200);
    expect((await get("/issues/midgame/1/conversation?column=stage%3Areview&page=2")).status).toBe(200);
    expect(dashboardCalls.at(-1)).toMatchObject({ view: "board", issueId: "github:owner/repo#1" });

    for (const [oldPath, location] of [
      ["/?view=attention", "/attention"],
      ["/?issue=github%3Aowner%2Frepo%231&tab=journey", "/issues/midgame/1/journey"],
      ["/?view=team&agent=kaveh", "/team/kaveh"],
      ["/?view=agent&run=run-1", "/operator/runs/run-1"],
      ["/agents", "/team"],
      ["/agents/kaveh", "/team/kaveh"],
    ] as const) {
      const response = await get(oldPath);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(location);
    }

    for (const path of ["/issues/unknown/1", "/issues/midgame/999", "/team/nobody", "/operator/runs/missing"]) {
      expect((await get(path)).status).toBe(404);
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
      body: new URLSearchParams({ answer: "yes", csrf }),
    }));
    expect(answer.status).toBe(303);
    expect(calls.answers).toEqual([["q-1", "yes"]]);

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
    expect(await scripted.json()).toEqual({ ok: true });
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
    expect(await before.json()).toEqual({ ok: true });
    expect((await post({ issueId: "i-1", beforeIssueId: "", csrf })).status).toBe(200);
    expect((await post({ csrf })).status).toBe(400);
    expect(calls.moves).toEqual([["i-3", "i-1"], ["i-1", null]]);
  });

  test("streams authenticated dashboard updates and starts steering with CSRF", async () => {
    let statusAttempts = 0;
    const { handler, auth, calls } = setup({
      getSystemStatus: async () => {
        statusAttempts += 1;
        if (statusAttempts === 1) throw new Error("temporary statfs failure");
        return {
          memory: { usedBytes: 8_000, totalBytes: 16_000, processBytes: 1_000 },
          disk: { usedBytes: 20_000, totalBytes: 100_000, availableBytes: 80_000 },
          uptimeSeconds: 3_600,
        };
      },
    });
    expect((await handler(new Request("http://localhost/events/dashboard"))).status).toBe(401);
    expect((await handler(new Request("http://localhost/api/dashboard-revision"))).status).toBe(404);
    const asset = await handler(new Request("http://localhost/assets/dashboard.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
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
    const updates = await handler(new Request("http://localhost/events/dashboard", { headers: { cookie } }));
    expect(updates.headers.get("content-type")).toContain("text/event-stream");
    expect(updates.headers.get("x-accel-buffering")).toBe("no");
    const reader = updates.body!.getReader();
    let streamed = "";
    await Promise.race([
      (async () => {
        while (!streamed.includes("event: status")) {
          const next = await reader.read();
          if (next.done) throw new Error("dashboard event stream closed");
          streamed += new TextDecoder().decode(next.value);
        }
      })(),
      Bun.sleep(2_500).then(() => { throw new Error("dashboard event stream timed out"); }),
    ]);
    expect(streamed).toContain("event: revision");
    expect(streamed).toContain('"revision":"revision-1"');
    expect(streamed).toContain("event: status");
    expect(statusAttempts).toBe(2);
    await reader.cancel();
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

  test("keeps the dashboard event stream alive with ping comments at least every five seconds", async () => {
    const { handler } = setup();
    const { cookie } = await login(handler);
    const updates = await handler(new Request("http://localhost/events/dashboard", { headers: { cookie } }));
    const reader = updates.body!.getReader();
    const decoder = new TextDecoder();
    let streamed = "";

    const readThroughTwoPings = async () => {
      while ((streamed.match(/: ping\n\n/g) ?? []).length < 2) {
        const next = await reader.read();
        if (next.done) throw new Error("dashboard event stream closed");
        streamed += decoder.decode(next.value);
      }
    };

    await Promise.race([
      readThroughTwoPings(),
      Bun.sleep(5_500).then(() => { throw new Error("dashboard heartbeat took longer than five seconds"); }),
    ]);
    await reader.cancel();
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
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls.dismissals).toEqual([["github:owner/repo#1", "F-1", "Not applicable", "operator"]]);
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
    expect(calls.mcp).toEqual([[{ tool: "run.report_progress" }, "internal-secret"]]);
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
      getDashboard: (_csrf: string, page: { view: DashboardViewModel["view"] }) => ({ ...model, view: page.view }),
      getAgentProfiles: async () => [profile],
      getAgentProfile: async (id: string) => (id === "kaveh" ? profile : null),
    });
    const unauthenticated = await handler(new Request("http://localhost/agents"));
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers.get("location")).toBe("/login");
    expect((await handler(new Request("http://localhost/agents/kaveh"))).headers.get("location")).toBe("/login");

    const { cookie } = await login(handler);
    const team = await handler(new Request("http://localhost/team", { headers: { cookie } }));
    expect(team.status).toBe(200);
    expect(await team.text()).toContain('data-agent-id="kaveh"');
    const board = await handler(new Request("http://localhost/", { headers: { cookie } }));
    expect(await board.text()).not.toContain('data-agent-id="kaveh"');

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
