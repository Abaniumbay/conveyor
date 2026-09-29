import { timingSafeEqual } from "node:crypto";
import { createWebAuth } from "./auth";
import { renderDashboard } from "./render";
import type { DashboardPageSelection, DashboardViewModel } from "./types";

export type WebAuthApi = ReturnType<typeof createWebAuth>;
export type BacklogDirection = "up" | "down";

export interface WebHandlerDependencies {
  auth: WebAuthApi;
  username: string;
  getDashboard: (
    csrfToken: string,
    pagination: DashboardPageSelection,
  ) => DashboardViewModel | Promise<DashboardViewModel>;
  isReady: () => boolean | Promise<boolean>;
  webhookPath: string;
  answerQuestion: (questionId: string, answer: string) => void | Promise<void>;
  reorderBacklog: (issueId: string, direction: BacklogDirection) => void | Promise<void>;
  handleWebhook: (rawBody: Uint8Array, headers: Headers) => unknown | Promise<unknown>;
  handleMcp: (body: unknown, bearerToken: string) => unknown | Promise<unknown>;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_DONE_LIMIT = 20;
const MAX_DONE_LIMIT = 2000;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

function response(body: BodyInit | null, status: number, contentType: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", contentType);
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("referrer-policy", "same-origin");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Sign in · Conveyor</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f8f6;color:#172126;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}.login{width:min(24rem,calc(100% - 2rem));padding:2rem;background:white;border:1px solid #dce5e3;border-radius:14px;box-shadow:0 8px 32px #17212612}h1{margin:0 0 .35rem;font-size:1.6rem}.muted{margin:0 0 1.25rem;color:#627176}label{display:block;margin:.8rem 0 .4rem;font-weight:650}input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #9cadaa;border-radius:7px;font:inherit}button{width:100%;margin-top:1rem;padding:.7rem;border:0;border-radius:7px;background:#087f72;color:white;font:inherit;font-weight:700;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #49aa9a;outline-offset:2px}.error{color:#a43c37}</style></head><body><main class="login"><h1>Sign in</h1><p class="muted">Access the Conveyor dashboard.</p>${error}<form method="post" action="/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button></form></main></body></html>`;
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
  const view = requestedView === "attention" ? requestedView : "board";
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
  if (columns.length !== 1 || pages.length !== 1) return { view, column: null, page: 1, doneLimit };
  const column = columns[0]!;
  const page = pages[0]!;
  if (column.length === 0 || column.length > 200 || !/^[1-9]\d*$/.test(page)) {
    return { view, column: null, page: 1, doneLimit };
  }
  const parsedPage = Number(page);
  return Number.isSafeInteger(parsedPage)
    ? { view, column, page: parsedPage, doneLimit }
    : { view, column: null, page: 1, doneLimit };
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
        return redirect("/?view=board");
      } catch {
        return text("Unable to reorder backlog", 409);
      }
    }

    return text("Not found", 404);
  };
}
