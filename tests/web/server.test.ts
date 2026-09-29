import { describe, expect, test } from "bun:test";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import type { DashboardViewModel } from "../../src/web/types";

const model: DashboardViewModel = {
  title: "Test board",
  project: "org/repo",
  updatedAt: "2026-09-29T12:00:00Z",
  view: "board",
  counts: { board: 0, attention: 0 },
  stages: [],
  backlog: [],
  done: {
    id: "done",
    name: "Done",
    cost: null,
    totalIssues: 0,
    page: 1,
    totalPages: 1,
    issues: [],
  },
  attention: {
    id: "attention",
    name: "Needs attention",
    cost: null,
    totalIssues: 0,
    page: 1,
    totalPages: 1,
    issues: [],
  },
  questions: [],
  systemWarnings: [],
  csrfToken: "filled-by-handler",
};

interface CallLog {
  answers: unknown[][];
  reorders: unknown[][];
  webhooks: unknown[][];
  mcp: unknown[][];
}

function setup(overrides: Record<string, unknown> = {}) {
  const auth = createWebAuth({
    passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    secureCookies: false,
  });
  const calls: CallLog = { answers: [], reorders: [], webhooks: [], mcp: [] };
  const dependencies = {
    auth,
    username: "operator",
    getDashboard: () => model,
    isReady: () => true,
    webhookPath: "/hooks/custom",
    maxBodyBytes: 128,
    answerQuestion: async (...args: unknown[]) => { calls.answers.push(args); },
    reorderBacklog: async (...args: unknown[]) => { calls.reorders.push(args); },
    handleWebhook: async (...args: unknown[]) => { calls.webhooks.push(args); },
    handleMcp: async (...args: unknown[]) => { calls.mcp.push(args); return { ok: true }; },
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
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    const page = await handler(new Request("http://localhost/?column=stage%3Areview&page=4&doneLimit=40", { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Test board");
    expect(dashboardCalls).toEqual([[expect.any(String), {
      view: "board",
      column: "stage:review",
      page: 4,
      doneLimit: 40,
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
    expect(reorder.headers.get("location")).toBe("/?view=board");
    expect(calls.reorders).toEqual([["i-2", "up"]]);
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
});
