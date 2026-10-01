import { timingSafeEqual } from "node:crypto";
import { createWebAuth } from "./auth";
import { dashboardClient } from "./client";
import { renderAgentList, renderAgentProfile } from "./agent-pages";
import { renderDashboard } from "./render";
import type { AgentProfileViewModel, DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRunEventsViewModel, SystemStatusViewModel } from "./types";

export type WebAuthApi = ReturnType<typeof createWebAuth>;
export type BacklogDirection = "up" | "down";

export interface WebHandlerDependencies {
  auth: WebAuthApi;
  username: string;
  getDashboard: (
    csrfToken: string,
    pagination: DashboardPageSelection,
  ) => DashboardViewModel | Promise<DashboardViewModel>;
  getDashboardRevision: () => string | Promise<string>;
  getConversationRevision: () => string | Promise<string>;
  getActivityRevision: () => string | Promise<string>;
  getSystemStatus: () => SystemStatusViewModel | Promise<SystemStatusViewModel>;
  isReady: () => boolean | Promise<boolean>;
  webhookPath: string;
  answerQuestion: (questionId: string, answer: string) => void | Promise<void>;
  reorderBacklog: (issueId: string, direction: BacklogDirection) => void | Promise<void>;
  moveBacklogIssue: (issueId: string, beforeIssueId: string | null) => void | Promise<void>;
  handleWebhook: (rawBody: Uint8Array, headers: Headers) => unknown | Promise<unknown>;
  handleMcp: (body: unknown, bearerToken: string) => unknown | Promise<unknown>;
  startSteering: (prompt: string) => string | Promise<string>;
  getSteeringRun: (runId: string) => { id: string; status: string } | null | Promise<{ id: string; status: string } | null>;
  getSteeringEvents: (runId: string, after: number) => Array<{
    sequence: number;
    type: string;
    text: string;
    createdAt: string;
  }> | Promise<Array<{ sequence: number; type: string; text: string; createdAt: string }>>;
  getIssueActivity: (issueId: string, before?: string) => IssueActivityViewModel | null | Promise<IssueActivityViewModel | null>;
  getIssueRunEvents: (issueId: string, runId: string, before?: number) => IssueRunEventsViewModel | null | Promise<IssueRunEventsViewModel | null>;
  getIssueConversation: (issueId: string) => IssueConversationViewModel | null | Promise<IssueConversationViewModel | null>;
  getIssueJourney: (issueId: string) => IssueJourneyViewModel | null | Promise<IssueJourneyViewModel | null>;
  postIssueMessage: (
    issueId: string,
    message: string,
    username: string,
  ) => unknown | Promise<unknown>;
  /** Dismisses an open review finding on behalf of the signed-in operator; rejects when it cannot be dismissed. */
  dismissFinding: (issueId: string, findingId: string, reason: string, username: string) => void | Promise<void>;
  /** Read-only profiles of the configured agents. */
  getAgentProfiles: () => readonly AgentProfileViewModel[] | Promise<readonly AgentProfileViewModel[]>;
  getAgentProfile: (agentId: string) => AgentProfileViewModel | null | Promise<AgentProfileViewModel | null>;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_DONE_LIMIT = 20;
const MAX_DONE_LIMIT = 2000;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#087f72"/><path d="M15 21h34M15 43h34" stroke="#dff8f0" stroke-width="6" stroke-linecap="round"/><path d="m25 14 10 18-10 18" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FONT_ASSETS = new Map<string, URL>([
  ["/assets/fonts/ibm-plex-sans-400.woff2", new URL("../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2", import.meta.url)],
  ["/assets/fonts/ibm-plex-sans-500.woff2", new URL("../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2", import.meta.url)],
  ["/assets/fonts/ibm-plex-sans-600.woff2", new URL("../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2", import.meta.url)],
  ["/assets/fonts/ibm-plex-mono-400.woff2", new URL("../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", import.meta.url)],
]);

function response(body: BodyInit | null, status: number, contentType: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", contentType);
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("referrer-policy", "same-origin");
  if (!responseHeaders.has("cache-control")) responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(body, { status, headers: responseHeaders });
}

function json(value: unknown, status = 200): Response {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return response('{"error":"response serialization failed"}', 500, "application/json; charset=utf-8");
  }
  if (text === undefined) text = "null";
  return response(text, status, "application/json; charset=utf-8");
}

function text(message: string, status: number): Response {
  return response(message, status, "text/plain; charset=utf-8");
}

function redirect(location: string, headers?: HeadersInit): Response {
  return response(null, 303, "text/plain; charset=utf-8", { ...Object.fromEntries(new Headers(headers)), location });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function loginPage(message = ""): string {
  const error = message ? `<p role="alert" class="error">${escapeHtml(message)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Sign in · Conveyor</title><style>@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-400.woff2") format("woff2")}@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:600;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-600.woff2") format("woff2")}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#E8EBE8;color:#1C2328;font:15px/1.5 "IBM Plex Sans",sans-serif}.login{width:min(24rem,calc(100% - 2rem));padding:2rem;background:#F8F9F7;border:1px solid #C9CECA;border-radius:14px;box-shadow:0 8px 32px #1C232812}h1{margin:0 0 .35rem;font-size:24px}.muted{margin:0 0 1.25rem;color:#5D6970}label{display:block;margin:.8rem 0 .4rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #8A959B;border-radius:7px;font:inherit}button{width:100%;margin-top:1rem;padding:.7rem;border:0;border-radius:7px;background:#2A5BD7;color:white;font:inherit;font-weight:600;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #2A5BD7;outline-offset:2px}.error{color:#BD3B26}</style></head><body><main class="login"><h1>Sign in</h1><p class="muted">Access the Conveyor dashboard.</p>${error}<form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button></form></main></body></html>`;
}

async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) return text("Invalid Content-Length", 400);
    if (Number(lengthHeader) > maxBytes) return text("Request body too large", 413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return text("Request body too large", 413);
      }
      chunks.push(value);
    }
  } catch {
    return text("Unable to read request body", 400);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isBodyError(value: Uint8Array | Response): value is Response {
  return value instanceof Response;
}

async function readForm(request: Request, maxBytes: number): Promise<URLSearchParams | Response> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== FORM_CONTENT_TYPE) return text("Expected form data", 415);
  const body = await readBody(request, maxBytes);
  if (isBodyError(body)) return body;
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return text("Malformed form data", 400);
  }
}

/** A script-initiated request that wants a result instead of a page navigation. */
function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function oneValue(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function validateCsrf(request: Request, form: URLSearchParams, auth: WebAuthApi): boolean {
  const submitted = oneValue(form, "csrf") ?? request.headers.get("x-csrf-token") ?? undefined;
  return auth.validateCsrf(request.headers.get("cookie") ?? undefined, submitted);
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match?.[1] ?? null;
}

function constantTextEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireMethod(request: Request, method: string): Response | null {
  return request.method === method ? null : response(null, 405, "text/plain; charset=utf-8", { allow: method });
}

function dashboardPage(url: URL): DashboardPageSelection {
  const requestedViews = url.searchParams.getAll("view");
  const requestedView = requestedViews.length === 1 ? requestedViews[0] : null;
  const view = requestedView === "attention" || requestedView === "agent"
    ? requestedView
    : "board";
  const requestedRuns = url.searchParams.getAll("run");
  const requestedRun = requestedRuns.length === 1 && /^[A-Za-z0-9-]{1,100}$/.test(requestedRuns[0] ?? "")
    ? requestedRuns[0]!
    : null;
  const requestedIssues = url.searchParams.getAll("issue");
  const requestedIssue = requestedIssues.length === 1 && (requestedIssues[0]?.length ?? 0) > 0 && (requestedIssues[0]?.length ?? 0) <= 500
    ? requestedIssues[0]!
    : null;
  const requestedDoneLimits = url.searchParams.getAll("doneLimit");
  const rawDoneLimit = requestedDoneLimits.length === 1 ? requestedDoneLimits[0] : null;
  const parsedDoneLimit = rawDoneLimit && /^[1-9]\d*$/.test(rawDoneLimit)
    ? Number(rawDoneLimit)
    : DEFAULT_DONE_LIMIT;
  const doneLimit = Number.isSafeInteger(parsedDoneLimit)
    ? Math.min(Math.max(DEFAULT_DONE_LIMIT, parsedDoneLimit), MAX_DONE_LIMIT)
    : DEFAULT_DONE_LIMIT;
  const columns = url.searchParams.getAll("column");
  const pages = url.searchParams.getAll("page");
  if (columns.length !== 1 || pages.length !== 1) {
    return { view, column: null, page: 1, doneLimit, runId: requestedRun, issueId: requestedIssue };
  }
  const column = columns[0]!;
  const page = pages[0]!;
  if (column.length === 0 || column.length > 200 || !/^[1-9]\d*$/.test(page)) {
    return { view, column: null, page: 1, doneLimit, runId: requestedRun, issueId: requestedIssue };
  }
  const parsedPage = Number(page);
  return Number.isSafeInteger(parsedPage)
    ? { view, column, page: parsedPage, doneLimit, runId: requestedRun, issueId: requestedIssue }
    : { view, column: null, page: 1, doneLimit, runId: requestedRun, issueId: requestedIssue };
}

function steeringEventStream(
  dependencies: WebHandlerDependencies,
  runId: string,
  initialAfter: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let after = initialAfter;
        let lastHeartbeat = Date.now();
        while (!cancelled) {
          const events = await dependencies.getSteeringEvents(runId, after);
          for (const event of events) {
            if (cancelled) return;
            after = Math.max(after, event.sequence);
            controller.enqueue(encoder.encode(
              `id: ${event.sequence}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`,
            ));
          }
          const run = await dependencies.getSteeringRun(runId);
          if (!run) {
            controller.enqueue(encoder.encode("event: done\ndata: {\"status\":\"missing\"}\n\n"));
            controller.close();
            return;
          }
          if (run.status !== "running") {
            controller.enqueue(encoder.encode(
              `event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`,
            ));
            controller.close();
            return;
          }
          if (Date.now() - lastHeartbeat >= 15_000) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            lastHeartbeat = Date.now();
          }
          await Bun.sleep(500);
        }
      })().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    cancel() {
      cancelled = true;
    },
  });
}

function dashboardEventStream(dependencies: WebHandlerDependencies): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let revision = "";
        let conversationRevision = await Promise.resolve()
          .then(() => dependencies.getConversationRevision())
          .catch(() => "");
        let activityRevision = await Promise.resolve()
          .then(() => dependencies.getActivityRevision())
          .catch(() => "");
        let lastStatus = 0;
        let lastHeartbeat = 0;
        controller.enqueue(encoder.encode("retry: 5000\n\n"));
        while (!cancelled) {
          try {
            const nextRevision = await dependencies.getDashboardRevision();
            if (nextRevision !== revision) {
              revision = nextRevision;
              controller.enqueue(encoder.encode(
                `event: revision\ndata: ${JSON.stringify({ revision })}\n\n`,
              ));
            }
          } catch {
            // A transient SQLite read must not terminate the browser's event stream.
          }
          try {
            const nextConversationRevision = await dependencies.getConversationRevision();
            if (conversationRevision && nextConversationRevision !== conversationRevision) {
              controller.enqueue(encoder.encode(
                `event: conversation\ndata: ${JSON.stringify({ revision: nextConversationRevision })}\n\n`,
              ));
            }
            conversationRevision = nextConversationRevision;
          } catch {
            // The next successful read will catch the client up.
          }
          try {
            const nextActivityRevision = await dependencies.getActivityRevision();
            if (activityRevision && nextActivityRevision !== activityRevision) {
              controller.enqueue(encoder.encode(
                `event: activity\ndata: ${JSON.stringify({ revision: nextActivityRevision })}\n\n`,
              ));
            }
            activityRevision = nextActivityRevision;
          } catch {
            // The next successful read will catch the client up.
          }
          const now = Date.now();
          if (now - lastStatus >= 10_000) {
            try {
              const status = await dependencies.getSystemStatus();
              controller.enqueue(encoder.encode(
                `event: status\ndata: ${JSON.stringify(status)}\n\n`,
              ));
              lastStatus = now;
            } catch {
              // Retry on the next loop while keeping the SSE connection alive.
            }
          }
          if (now - lastHeartbeat >= 4_000) {
            controller.enqueue(encoder.encode(": ping\n\n"));
            lastHeartbeat = now;
          }
          await Bun.sleep(1_000);
        }
      })().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    cancel() {
      cancelled = true;
    },
  });
}

export function createWebHandler(dependencies: WebHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.webhookPath.startsWith("/") || dependencies.webhookPath.startsWith("//")) {
    throw new Error("webhookPath must be an absolute URL path");
  }
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be a positive safe integer");

  function session(request: Request) {
    return dependencies.auth.getSession(request.headers.get("cookie") ?? undefined);
  }

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return text("Bad request", 400);
    }
    const path = url.pathname;

    if (path === "/assets/dashboard.js") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(dashboardClient, 200, "text/javascript; charset=utf-8");
    }

    const fontAsset = FONT_ASSETS.get(path);
    if (fontAsset) {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(Bun.file(fontAsset), 200, "font/woff2", {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }

    if (path === "/favicon.svg") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(FAVICON, 200, "image/svg+xml; charset=utf-8", {
        "cache-control": "public, max-age=86400",
      });
    }

    if (path === "/health/live") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? json({ status: "live" });
    }

    if (path === "/health/ready") {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      try {
        return await dependencies.isReady()
          ? json({ status: "ready" })
          : json({ status: "not_ready" }, 503);
      } catch {
        return json({ status: "not_ready" }, 503);
      }
    }

    if (path === "/login") {
      if (request.method === "GET") return response(loginPage(), 200, "text/html; charset=utf-8");
      if (request.method !== "POST") return response(null, 405, "text/plain; charset=utf-8", { allow: "GET, POST" });
      if (!dependencies.auth.isConfigured) return text("Web authentication is not configured", 503);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      const username = oneValue(form, "username");
      const password = oneValue(form, "password");
      if (username === null || username.length > 200 || password === null || password.length > 1024) return text("Invalid login request", 400);
      const passwordAccepted = dependencies.auth.authenticate(password);
      if (!constantTextEquals(username, dependencies.username) || !passwordAccepted) {
        return response(loginPage("The credentials were not accepted."), 401, "text/html; charset=utf-8");
      }
      const created = dependencies.auth.createSession();
      if (!created) return text("Unable to create session", 503);
      return redirect("/", { "set-cookie": created.cookie });
    }

    if (path === "/logout") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
    }

    if (path === "/") {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return redirect("/login");
      try {
        const model = await dependencies.getDashboard(currentSession.csrfToken, dashboardPage(url));
        return response(renderDashboard(model), 200, "text/html; charset=utf-8");
      } catch {
        return text("Dashboard is temporarily unavailable", 503);
      }
    }

    if (path === "/events/dashboard") {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      return response(dashboardEventStream(dependencies), 200, "text/event-stream; charset=utf-8", {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    }

    if (path === "/agents") {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return redirect("/login");
      try {
        return response(renderAgentList(await dependencies.getAgentProfiles()), 200, "text/html; charset=utf-8");
      } catch {
        return text("Agents are temporarily unavailable", 503);
      }
    }

    const agentProfile = /^\/agents\/([^/]{1,200})$/.exec(path);
    if (agentProfile) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return redirect("/login");
      let agentId: string;
      try {
        agentId = decodeURIComponent(agentProfile[1]!);
      } catch {
        return text("Invalid agent id", 400);
      }
      try {
        const profile = await dependencies.getAgentProfile(agentId);
        return profile
          ? response(renderAgentProfile(profile), 200, "text/html; charset=utf-8")
          : text("Agent not found", 404);
      } catch {
        return text("Agent profile is temporarily unavailable", 503);
      }
    }

    const issueJourney = /^\/api\/issues\/([^/]{1,1000})\/journey$/.exec(path);
    if (issueJourney) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      let issueId: string;
      try {
        issueId = decodeURIComponent(issueJourney[1]!);
      } catch {
        return text("Invalid issue id", 400);
      }
      if (!issueId || issueId.length > 500) return text("Invalid issue id", 400);
      try {
        const journey = await dependencies.getIssueJourney(issueId);
        return journey ? json(journey) : text("Issue not found", 404);
      } catch {
        return json({ error: "journey unavailable" }, 503);
      }
    }

    const issueConversation = /^\/api\/issues\/([^/]{1,1000})\/conversation$/.exec(path);
    if (issueConversation) {
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      let issueId: string;
      try {
        issueId = decodeURIComponent(issueConversation[1]!);
      } catch {
        return text("Invalid issue id", 400);
      }
      if (!issueId || issueId.length > 500) return text("Invalid issue id", 400);
      if (request.method === "GET") {
        try {
          const conversation = await dependencies.getIssueConversation(issueId);
          return conversation ? json(conversation) : text("Issue not found", 404);
        } catch {
          return json({ error: "conversation unavailable" }, 503);
        }
      }
      if (request.method === "POST") {
        const form = await readForm(request, maxBodyBytes);
        if (form instanceof Response) return form;
        if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
        const message = oneValue(form, "message")?.trim();
        if (!message || message.length > 4_000) return text("Invalid conversation message", 400);
        try {
          const result = await dependencies.postIssueMessage(issueId, message, dependencies.username);
          return json({ accepted: true, result: result ?? null }, 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to add conversation message";
          return text(message, message === "issue not found" ? 404 : 409);
        }
      }
      return response(null, 405, "text/plain; charset=utf-8", { allow: "GET, POST" });
    }

    const issueRunEvents = /^\/api\/issues\/([^/]{1,1000})\/activity\/runs\/([A-Za-z0-9-]{1,100})\/events$/.exec(path);
    if (issueRunEvents) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      let issueId: string;
      try {
        issueId = decodeURIComponent(issueRunEvents[1]!);
      } catch {
        return text("Invalid issue id", 400);
      }
      const rawBefore = url.searchParams.get("before");
      if (rawBefore !== null && !/^[1-9]\d*$/.test(rawBefore)) return text("Invalid event cursor", 400);
      const before = rawBefore === null ? undefined : Number(rawBefore);
      if (before !== undefined && !Number.isSafeInteger(before)) return text("Invalid event cursor", 400);
      try {
        const activity = await dependencies.getIssueRunEvents(issueId, issueRunEvents[2]!, before);
        return activity ? json(activity) : text("Issue or run not found", 404);
      } catch {
        return json({ error: "activity unavailable" }, 503);
      }
    }

    const issueActivity = /^\/api\/issues\/([^/]{1,1000})\/activity$/.exec(path);
    if (issueActivity) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      let issueId: string;
      try {
        issueId = decodeURIComponent(issueActivity[1]!);
      } catch {
        return text("Invalid issue id", 400);
      }
      if (!issueId || issueId.length > 500) return text("Invalid issue id", 400);
      const before = url.searchParams.get("before");
      if (before !== null && !/^[A-Za-z0-9-]{1,100}$/.test(before)) return text("Invalid run cursor", 400);
      try {
        const activity = await dependencies.getIssueActivity(issueId, before ?? undefined);
        return activity ? json(activity) : text("Issue not found", 404);
      } catch {
        return json({ error: "activity unavailable" }, 503);
      }
    }

    const findingDismissal = /^\/api\/issues\/([^/]{1,1000})\/findings\/([^/]{1,200})\/dismiss$/.exec(path);
    if (findingDismissal) {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") return text("Expected application/json", 415);
      if (!dependencies.auth.validateCsrf(request.headers.get("cookie") ?? undefined, request.headers.get("x-csrf-token") ?? undefined)) {
        return json({ error: "forbidden" }, 403);
      }
      let issueId: string;
      let findingId: string;
      try {
        issueId = decodeURIComponent(findingDismissal[1]!);
        findingId = decodeURIComponent(findingDismissal[2]!);
      } catch {
        return text("Invalid finding path", 400);
      }
      const body = await readBody(request, maxBodyBytes);
      if (isBodyError(body)) return body;
      let reason: unknown;
      try {
        reason = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { reason?: unknown } | null)?.reason;
      } catch {
        return json({ error: "malformed JSON" }, 400);
      }
      if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2000) {
        return json({ error: "a reason is required" }, 400);
      }
      try {
        await dependencies.dismissFinding(issueId, findingId, reason.trim(), dependencies.username);
        return json({ ok: true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to dismiss finding" }, 409);
      }
    }

    if (path === "/steering") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const prompt = oneValue(form, "prompt")?.trim();
      if (!prompt || prompt.length > 12_000) return text("Invalid steering prompt", 400);
      try {
        const runId = await dependencies.startSteering(prompt);
        return redirect(`/?view=agent&run=${encodeURIComponent(runId)}`);
      } catch (error) {
        return text(error instanceof Error ? error.message : "Unable to start steering agent", 409);
      }
    }

    const steeringEvents = /^\/steering\/([A-Za-z0-9-]{1,100})\/events$/.exec(path);
    if (steeringEvents) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const runId = steeringEvents[1]!;
      const rawAfter = url.searchParams.get("after") ?? "0";
      if (!/^\d+$/.test(rawAfter)) return text("Invalid event cursor", 400);
      const after = Number(rawAfter);
      if (!Number.isSafeInteger(after)) return text("Invalid event cursor", 400);
      const run = await dependencies.getSteeringRun(runId);
      if (!run) return text("Steering run not found", 404);
      return response(
        steeringEventStream(dependencies, runId, after),
        200,
        "text/event-stream; charset=utf-8",
        { "x-accel-buffering": "no", connection: "keep-alive" },
      );
    }

    if (path === dependencies.webhookPath) {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const body = await readBody(request, maxBodyBytes);
      if (isBodyError(body)) return body;
      try {
        await dependencies.handleWebhook(body, new Headers(request.headers));
        return json({ accepted: true }, 202);
      } catch {
        return json({ error: "webhook processing failed" }, 500);
      }
    }

    if (path === "/internal/mcp") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const token = bearerToken(request.headers.get("authorization"));
      if (!token) {
        return json({ error: "unauthorized" }, 401);
      }
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") return text("Expected application/json", 415);
      const body = await readBody(request, maxBodyBytes);
      if (isBodyError(body)) return body;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return json({ error: "malformed JSON" }, 400);
      }
      try {
        return json(await dependencies.handleMcp(parsed, token));
      } catch {
        return json({ error: "MCP request failed" }, 500);
      }
    }

    if (path.startsWith("/questions/") && path.endsWith("/answer")) {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const encodedId = path.slice("/questions/".length, -"/answer".length);
      let questionId: string;
      try { questionId = decodeURIComponent(encodedId); } catch { return text("Invalid question id", 400); }
      if (!questionId || questionId.length > 200 || questionId.includes("/")) return text("Invalid question id", 400);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const answer = oneValue(form, "answer");
      if (answer === null || answer.length === 0) return text("Invalid answer", 400);
      try {
        await dependencies.answerQuestion(questionId, answer);
        return redirect("/");
      } catch {
        return text("Unable to record answer", 409);
      }
    }

    if (path === "/backlog/reorder") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const issueId = oneValue(form, "issueId");
      const direction = oneValue(form, "direction");
      if (!issueId || issueId.length > 200 || (direction !== "up" && direction !== "down")) return text("Invalid reorder request", 400);
      try {
        await dependencies.reorderBacklog(issueId, direction);
        if (wantsJson(request)) return json({ ok: true });
        return redirect("/?view=board");
      } catch {
        return text("Unable to reorder backlog", 409);
      }
    }

    if (path === "/backlog/move") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const issueId = oneValue(form, "issueId");
      const beforeIssueId = oneValue(form, "beforeIssueId") || null;
      if (!issueId || issueId.length > 200 || (beforeIssueId !== null && beforeIssueId.length > 200)) {
        return text("Invalid move request", 400);
      }
      try {
        await dependencies.moveBacklogIssue(issueId, beforeIssueId);
        return json({ ok: true });
      } catch {
        return text("Unable to reorder backlog", 409);
      }
    }

    return text("Not found", 404);
  };
}
