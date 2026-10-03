import { timingSafeEqual } from "node:crypto";
import { createWebAuth, hashPassword, verifyPassword, type WebAccountIdentity } from "./auth";
import { dashboardClient } from "./client";
import { agentHref } from "./agent-pages";
import { REPORT_PERIOD_VALUES } from "./report-page";
import { renderDashboard } from "./render";
import { pwaIcons, pwaManifest, serviceWorker } from "./pwa";
import { notificationClient } from "./notifications-client";
import { themeInitScript } from "./styles";
import type { AgentProfileViewModel, DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRunEventsViewModel, ReportPeriod, ReportViewModel, SystemStatusViewModel } from "./types";

export type WebAuthApi = ReturnType<typeof createWebAuth>;
export type BacklogDirection = "up" | "down";
export type IssueRouteReference = { id: string } | { repository: string; number: number };
export interface IssueRouteTarget { id: string; repository: string; number: number }

export interface WebHandlerDependencies {
  auth: WebAuthApi;
  username: string;
  listAccounts?: () => readonly Omit<WebAccountIdentity, "sessionVersion">[];
  getAccount?: (id: string) => (WebAccountIdentity & { passwordHash: string }) | null;
  getPushPreferences?: (accountId: string) => { questions: boolean; stopped: boolean; done: boolean };
  setPushPreferences?: (accountId: string, preferences: { questions: boolean; stopped: boolean; done: boolean }) => void;
  putPushSubscription?: (accountId: string, endpoint: string, keys: { p256dh: string; auth: string }) => void;
  deletePushSubscription?: (accountId: string, endpoint: string) => void;
  pushPublicKey?: string | null;
  dispatchPushEvents?: () => void | Promise<void>;
  createAccount?: (username: string, passwordHash: string) => WebAccountIdentity;
  changePassword?: (id: string, passwordHash: string) => void;
  changeAvatar?: (id: string, avatar: string) => void;
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
  getIssueRoute: (reference: IssueRouteReference) => IssueRouteTarget | null | Promise<IssueRouteTarget | null>;
  postIssueMessage: (
    issueId: string,
    message: string,
    username: string,
  ) => unknown | Promise<unknown>;
  retryIssue: (issueId: string, note: string, username: string) => unknown | Promise<unknown>;
  /** Dismisses an open review finding on behalf of the signed-in operator; rejects when it cannot be dismissed. */
  dismissFinding: (issueId: string, findingId: string, reason: string, username: string) => void | Promise<void>;
  /** Read-only profiles of the configured agents. */
  getAgentProfiles: () => readonly AgentProfileViewModel[] | Promise<readonly AgentProfileViewModel[]>;
  /** The Reports view for a period, across every repository or drilled into one; null for an unknown repository. */
  getReport?: (input: { period: ReportPeriod; repository: string | null }) => ReportViewModel | null | Promise<ReportViewModel | null>;
  getAgentProfile: (agentId: string) => AgentProfileViewModel | null | Promise<AgentProfileViewModel | null>;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const PROFILE_AVATARS = ["🐼", "🦊", "🐨", "🐯", "🐸", "🦉", "🐙", "🦁"] as const;
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

function permanentRedirect(location: string): Response {
  return response(null, 301, "text/plain; charset=utf-8", { location });
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

function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const target = new URL(value, "https://conveyor.invalid");
    return target.origin === "https://conveyor.invalid" ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch {
    return null;
  }
}

function loginPage(message = "", returnTo: string | null = null): string {
  const error = message ? `<p role="alert" class="error">${escapeHtml(message)}</p>` : "";
  const returnField = returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Sign in · Conveyor</title><script src="/assets/theme.js"></script><style>@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-400.woff2") format("woff2")}@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:600;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-600.woff2") format("woff2")}:root{color-scheme:light;--concrete:#E8EBE8;--panel:#F8F9F7;--ink:#1C2328;--steel:#5D6970;--line:#8A959B;--signal:#2A5BD7;--stop:#A72F1D;--on-signal:#FFFFFF;--shadow:0 8px 32px rgba(28,35,40,.07)}:root[data-theme="light"]{color-scheme:light}:root[data-theme="dark"]{color-scheme:dark;--concrete:#151A1D;--panel:#20272B;--ink:#F2F5F3;--steel:#AEB9BD;--line:#66737A;--signal:#83A7FF;--stop:#FF7B69;--on-signal:#0E1A34;--shadow:0 8px 32px rgba(0,0,0,.48)}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--concrete:#151A1D;--panel:#20272B;--ink:#F2F5F3;--steel:#AEB9BD;--line:#66737A;--signal:#83A7FF;--stop:#FF7B69;--on-signal:#0E1A34;--shadow:0 8px 32px rgba(0,0,0,.48)}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--concrete);color:var(--ink);font:15px/1.5 "IBM Plex Sans",sans-serif}.login{width:min(24rem,calc(100% - 2rem));padding:2rem;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}h1{margin:0 0 .35rem;font-size:24px}.muted{margin:0 0 1.25rem;color:var(--steel)}label{display:block;margin:.8rem 0 .4rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);font:inherit}button{width:100%;margin-top:1rem;padding:.7rem;border:0;border-radius:7px;background:var(--signal);color:var(--on-signal);font:inherit;font-weight:600;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid var(--signal);outline-offset:2px}.error{color:var(--stop)}</style></head><body><main class="login"><h1>Sign in</h1><p class="muted">Access the Conveyor dashboard.</p>${error}<form method="post" action="/login">${returnField}<label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button></form></main></body></html>`;
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

function isBase64UrlOfLength(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === length && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function isHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" && endpoint.hostname !== "" && endpoint.username === "" && endpoint.password === "" && endpoint.hash === "";
  } catch {
    return false;
  }
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

async function readNotificationJson(request: Request): Promise<Record<string, unknown> | Response> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return text("Expected JSON", 415);
  const body = await readBody(request, 16 * 1024);
  if (body instanceof Response) return body;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : json({ error: "Invalid JSON object" }, 400);
  } catch {
    return json({ error: "Malformed JSON" }, 400);
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

function dashboardPage(
  url: URL,
  view: DashboardPageSelection["view"],
  runId: string | null = null,
  issueId: string | null = null,
): DashboardPageSelection {
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
    return { view, column: null, page: 1, doneLimit, runId, issueId };
  }
  const column = columns[0]!;
  const page = pages[0]!;
  if (column.length === 0 || column.length > 200 || !/^[1-9]\d*$/.test(page)) {
    return { view, column: null, page: 1, doneLimit, runId, issueId };
  }
  const parsedPage = Number(page);
  return Number.isSafeInteger(parsedPage)
    ? { view, column, page: parsedPage, doneLimit, runId, issueId }
    : { view, column: null, page: 1, doneLimit, runId, issueId };
}

function paginationSuffix(url: URL): string {
  const pagination = new URLSearchParams();
  for (const key of ["doneLimit", "column", "page"]) {
    const values = url.searchParams.getAll(key);
    if (values.length === 1) pagination.set(key, values[0]!);
  }
  const query = pagination.toString();
  return query ? `?${query}` : "";
}

function issueRoutePath(target: IssueRouteTarget, tab?: string | null): string {
  const suffix = tab === "conversation" || tab === "journey"
    ? `/${tab}`
    : tab === "activity" || tab === "logs" ? "/logs" : "";
  return `/issues/${encodeURIComponent(target.repository)}/${target.number}${suffix}`;
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

  function requireSuperuser(request: Request): Response | null {
    const current = session(request);
    return !current ? json({ error: "unauthorized" }, 401) : current.account.role !== "superuser" ? json({ error: "forbidden" }, 403) : null;
  }

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return text("Bad request", 400);
    }
    const path = url.pathname;

    if (path === "/manifest.webmanifest") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(JSON.stringify(pwaManifest), 200, "application/manifest+json; charset=utf-8", {
        "cache-control": "public, max-age=3600",
      });
    }

    if (path === "/service-worker.js") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(serviceWorker, 200, "text/javascript; charset=utf-8", {
        "service-worker-allowed": "/",
        "cache-control": "no-cache",
      });
    }

    if (path === "/assets/notifications.js") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(notificationClient, 200, "text/javascript; charset=utf-8");
    }

    const pwaIcon = pwaIcons.get(path);
    if (pwaIcon) {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(pwaIcon, 200, "image/svg+xml; charset=utf-8", {
        "cache-control": "public, max-age=31536000, immutable",
      });
    }

    if (path === "/assets/dashboard.js") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(dashboardClient, 200, "text/javascript; charset=utf-8");
    }

    if (path === "/assets/theme.js") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(themeInitScript, 200, "text/javascript; charset=utf-8");
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
      const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
      if (request.method === "GET") return response(loginPage("", returnTo), 200, "text/html; charset=utf-8");
      if (request.method !== "POST") return response(null, 405, "text/plain; charset=utf-8", { allow: "GET, POST" });
      if (!dependencies.auth.isConfigured) return text("Web authentication is not configured", 503);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      const username = oneValue(form, "username");
      const password = oneValue(form, "password");
      const requestedReturnTo = safeReturnTo(oneValue(form, "returnTo"));
      if (username === null || username.length > 200 || password === null || password.length > 1024) return text("Invalid login request", 400);
      if (!dependencies.auth.authenticate(username, password)) {
        return response(loginPage("The credentials were not accepted.", requestedReturnTo), 401, "text/html; charset=utf-8");
      }
      const account = dependencies.auth.findAccount(username);
      const created = dependencies.auth.createSession(account ?? undefined);
      if (!created) return text("Unable to create session", 503);
      return redirect(requestedReturnTo ?? "/board", { "set-cookie": created.cookie });
    }

    if (path === "/logout") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const pushEndpoint = oneValue(form, "pushEndpoint");
      if (pushEndpoint && isHttpsEndpoint(pushEndpoint)) {
        dependencies.deletePushSubscription?.(session(request)!.account.id, pushEndpoint);
      }
      return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
    }

    if (path === "/settings/notifications") {
      if (request.method !== "GET") return response(null, 405, "text/plain; charset=utf-8", { allow: "GET" });
      const current = session(request);
      if (!current) return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
      const preferences = dependencies.getPushPreferences?.(current.account.id) ?? { questions: false, stopped: false, done: false };
      const checks = (["questions", "stopped", "done"] as const).map((category) => {
        const label = category === "questions" ? "New questions requiring an answer" : category === "stopped" ? "Issues entering blocked, error, needs intervention, or rejected" : "Issues reaching done";
        return `<label><input type="checkbox" name="${category}" ${preferences[category] ? "checked" : ""}> ${label}</label>`;
      }).join("");
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="theme-color" content="#087f72"><title>Notifications · Conveyor</title></head><body><main><h1>Browser notifications</h1><p><a href="/board">Dashboard</a> · Signed in as ${escapeHtml(current.account.username)}</p><p>Push notifications require a supported browser, notification permission, and HTTPS. Permission is requested only when you enable a category.</p><p id="notification-status" role="status" aria-live="polite">Checking browser support…</p><form id="notification-settings" data-csrf="${escapeHtml(current.csrfToken)}">${checks}<button type="submit">Save notification settings</button></form><script src="/assets/notifications.js" defer></script></main></body></html>`;
      return response(page, 200, "text/html; charset=utf-8");
    }

    if (path === "/api/notifications/settings") {
      const current = session(request);
      if (!current) return json({ error: "unauthorized" }, 401);
      if (request.method === "GET") return json({ preferences: dependencies.getPushPreferences?.(current.account.id) ?? { questions: false, stopped: false, done: false }, publicKey: dependencies.pushPublicKey ?? null });
      if (request.method !== "POST") return response(null, 405, "application/json; charset=utf-8", { allow: "GET, POST" });
      if (!dependencies.auth.validateCsrf(request.headers.get("cookie") ?? undefined, request.headers.get("x-csrf-token") ?? undefined)) return json({ error: "forbidden" }, 403);
      const input = await readNotificationJson(request);
      if (input instanceof Response) return input;
      if (Object.keys(input).some((key) => !["questions", "stopped", "done"].includes(key)) || ["questions", "stopped", "done"].some((key) => typeof input[key] !== "boolean")) return json({ error: "Invalid notification preferences" }, 400);
      if (!dependencies.setPushPreferences) return json({ error: "Notification settings are unavailable" }, 503);
      const preferences = { questions: input.questions as boolean, stopped: input.stopped as boolean, done: input.done as boolean };
      dependencies.setPushPreferences(current.account.id, preferences);
      return json({ preferences });
    }

    if (path === "/api/notifications/subscriptions") {
      const current = session(request);
      if (!current) return json({ error: "unauthorized" }, 401);
      if (request.method !== "POST" && request.method !== "DELETE") return response(null, 405, "application/json; charset=utf-8", { allow: "POST, DELETE" });
      if (!dependencies.auth.validateCsrf(request.headers.get("cookie") ?? undefined, request.headers.get("x-csrf-token") ?? undefined)) return json({ error: "forbidden" }, 403);
      const input = await readNotificationJson(request);
      if (input instanceof Response) return input;
      if (!isHttpsEndpoint(input.endpoint)) return json({ error: "Invalid subscription endpoint" }, 400);
      if (request.method === "DELETE") {
        dependencies.deletePushSubscription?.(current.account.id, input.endpoint);
        return json({ removed: true });
      }
      const keys = input.keys as Record<string, unknown> | undefined;
      if (!dependencies.pushPublicKey || !keys || !isBase64UrlOfLength(keys.p256dh, 65) || !isBase64UrlOfLength(keys.auth, 16) || (input.expirationTime !== undefined && input.expirationTime !== null && typeof input.expirationTime !== "number") || Object.keys(input).some((key) => !["endpoint", "expirationTime", "keys"].includes(key)) || Object.keys(keys).some((key) => !["p256dh", "auth"].includes(key))) return json({ error: dependencies.pushPublicKey ? "Invalid subscription data" : "Server push is not configured" }, 400);
      dependencies.putPushSubscription?.(current.account.id, input.endpoint, { p256dh: keys.p256dh, auth: keys.auth });
      return json({ registered: true }, 201);
    }

    if (path === "/api/accounts") {
      const denied = requireSuperuser(request);
      if (denied) return denied;
      if (request.method === "GET") return json({ accounts: dependencies.listAccounts?.() ?? [] });
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const username = oneValue(form, "username")?.trim();
      const password = oneValue(form, "password");
      if (!username || username.length > 64 || !/^[\p{L}\p{N}_.@-]+$/u.test(username) || !password || password.length < 12 || password.length > 1024) {
        return json({ error: "Username must be 1–64 letters, numbers, or ._@-; password must be at least 12 characters." }, 400);
      }
      if (!dependencies.createAccount) return json({ error: "Account management is unavailable" }, 503);
      try {
        const created = await dependencies.createAccount(username, hashPassword(password));
        return json({ account: { id: created.id, username: created.username, role: created.role, avatar: created.avatar } }, 201);
      } catch {
        return json({ error: "That username is already in use." }, 409);
      }
    }

    if (path === "/accounts") {
      const current = session(request);
      if (!current) return redirect("/login");
      if (current.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const accounts = dependencies.listAccounts?.() ?? [];
      const rows = accounts.map((account) => `<li>${escapeHtml(account.avatar)} ${escapeHtml(account.username)} — ${escapeHtml(account.role)}</li>`).join("");
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Accounts · Conveyor</title></head><body><main><h1>Dashboard accounts</h1><p><a href="/board">Dashboard</a> · <a href="/profile">Your profile</a></p><ul>${rows}</ul><h2>Create user</h2><form method="post" action="/api/accounts"><input type="hidden" name="csrf" value="${escapeHtml(current.csrfToken)}"><label>Username <input name="username" maxlength="64" required></label><label>Initial password <input type="password" name="password" minlength="12" required></label><button>Create account</button></form></main></body></html>`;
      return response(page, 200, "text/html; charset=utf-8");
    }

    if (path === "/profile") {
      const current = session(request);
      if (!current) return redirect("/login");
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const avatars = PROFILE_AVATARS.map((avatar) => `<option value="${avatar}"${avatar === current.account.avatar ? " selected" : ""}>${avatar}</option>`).join("");
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your profile · Conveyor</title></head><body><main><h1>Your profile</h1><p>${escapeHtml(current.account.avatar)} ${escapeHtml(current.account.username)}</p><p><a href="/board">Dashboard</a></p><form method="post" action="/api/profile/avatar"><input type="hidden" name="csrf" value="${escapeHtml(current.csrfToken)}"><label>Animal avatar <select name="avatar">${avatars}</select></label><button>Save avatar</button></form><h2>Change password</h2><form method="post" action="/api/profile/password"><input type="hidden" name="csrf" value="${escapeHtml(current.csrfToken)}"><label>Current password <input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password <input name="newPassword" type="password" minlength="12" autocomplete="new-password" required></label><button>Change password</button></form></main></body></html>`;
      return response(page, 200, "text/html; charset=utf-8");
    }

    if (path === "/api/profile/password") {
      const current = session(request);
      if (!current) return json({ error: "unauthorized" }, 401);
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const oldPassword = oneValue(form, "currentPassword");
      const newPassword = oneValue(form, "newPassword");
      const account = dependencies.getAccount?.(current.account.id);
      if (!oldPassword || !newPassword || newPassword.length < 12 || newPassword.length > 1024) return json({ error: "New password must be at least 12 characters." }, 400);
      if (!account || !verifyPassword(oldPassword, account.passwordHash)) return json({ error: "Current password was not accepted." }, 403);
      if (!dependencies.changePassword) return json({ error: "Password changes are unavailable" }, 503);
      await dependencies.changePassword(current.account.id, hashPassword(newPassword));
      return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
    }

    if (path === "/api/profile/avatar") {
      const current = session(request);
      if (!current) return json({ error: "unauthorized" }, 401);
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const avatar = oneValue(form, "avatar");
      if (!avatar || !(PROFILE_AVATARS as readonly string[]).includes(avatar)) return json({ error: "Choose an available avatar." }, 400);
      if (!dependencies.changeAvatar) return json({ error: "Profile updates are unavailable" }, 503);
      await dependencies.changeAvatar(current.account.id, avatar);
      return json({ ok: true, avatar });
    }

    const legacyDashboardQuery = path === "/" && ["view", "issue", "tab", "agent", "run"]
      .some((key) => url.searchParams.has(key));
    const teamProfilePath = /^\/team\/([^/]{1,200})$/.exec(path);
    const operatorRunPath = /^\/operator\/runs\/([A-Za-z0-9-]{1,100})$/.exec(path);
    const issuePagePath = /^\/issues\/([^/]{1,200})\/([1-9]\d*)(?:\/(conversation|journey|logs))?$/.exec(path);
    const reportPath = /^\/reports(?:\/([^/]{1,200}))?$/.exec(path);
    const dashboardView = path === "/" || path === "/board"
      ? "board"
      : path === "/attention"
        ? "attention"
        : path === "/team" || teamProfilePath
          ? "team"
          : path === "/operator" || operatorRunPath
            ? "agent"
            : reportPath && dependencies.getReport
              ? "reports"
              : issuePagePath ? "board" : null;

    if (legacyDashboardQuery || dashboardView) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return redirect(issuePagePath ? `/login?returnTo=${encodeURIComponent(`${path}${url.search}`)}` : "/login");
      try {
        if (legacyDashboardQuery) {
          const legacyIssue = url.searchParams.getAll("issue");
          if (legacyIssue.length === 1) {
            const target = await dependencies.getIssueRoute({ id: legacyIssue[0]! });
            if (!target) return text("Issue not found", 404);
            return permanentRedirect(`${issueRoutePath(target, url.searchParams.get("tab"))}${paginationSuffix(url)}`);
          }
          const requestedView = url.searchParams.get("view");
          if (requestedView === "team") {
            const agentId = url.searchParams.get("agent");
            if (agentId) {
              const profile = await dependencies.getAgentProfile(agentId);
              return profile ? permanentRedirect(agentHref(profile.id)) : text("Agent not found", 404);
            }
            return permanentRedirect(`/team${paginationSuffix(url)}`);
          }
          if (requestedView === "agent") {
            const runId = url.searchParams.get("run");
            if (runId) {
              if (!/^[A-Za-z0-9-]{1,100}$/.test(runId) || !await dependencies.getSteeringRun(runId)) {
                return text("Operator run not found", 404);
              }
              return permanentRedirect(`/operator/runs/${encodeURIComponent(runId)}${paginationSuffix(url)}`);
            }
            return permanentRedirect(`/operator${paginationSuffix(url)}`);
          }
          const legacyPath = requestedView === "attention" ? "/attention" : "/board";
          return permanentRedirect(`${legacyPath}${paginationSuffix(url)}`);
        }

        let issueId: string | null = null;
        if (issuePagePath) {
          let repository: string;
          try { repository = decodeURIComponent(issuePagePath[1]!); } catch { return text("Invalid repository id", 400); }
          const number = Number(issuePagePath[2]);
          if (!Number.isSafeInteger(number)) return text("Issue not found", 404);
          const target = await dependencies.getIssueRoute({ repository, number });
          if (!target) return text("Issue not found", 404);
          issueId = target.id;
        }

        if (teamProfilePath) {
          let agentId: string;
          try { agentId = decodeURIComponent(teamProfilePath[1]!); } catch { return text("Invalid agent id", 400); }
          if (!await dependencies.getAgentProfile(agentId)) return text("Agent not found", 404);
        }

        const runId = operatorRunPath?.[1] ?? null;
        if (runId && !await dependencies.getSteeringRun(runId)) return text("Operator run not found", 404);

        let report: ReportViewModel | undefined;
        if (dashboardView === "reports") {
          let repository: string | null = null;
          if (reportPath![1]) {
            try { repository = decodeURIComponent(reportPath![1]); } catch { return text("Invalid repository id", 400); }
          }
          const requestedPeriod = url.searchParams.get("period") ?? "all";
          if (!(REPORT_PERIOD_VALUES as readonly string[]).includes(requestedPeriod)) return text("Unknown report period", 400);
          const built = await dependencies.getReport!({ period: requestedPeriod as ReportPeriod, repository });
          if (!built) return text("Repository not found", 404);
          report = built;
        }

        const page = dashboardPage(url, dashboardView!, runId, issueId);
        const model = await dependencies.getDashboard(currentSession.csrfToken, page);
        const team = page.view === "team" ? await dependencies.getAgentProfiles() : undefined;
        return response(renderDashboard({ ...model, account: currentSession.account, ...(team ? { team } : {}), ...(report ? { report } : {}) }), 200, "text/html; charset=utf-8");
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
      return permanentRedirect("/team");
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
          ? permanentRedirect(agentHref(profile.id))
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
          const result = await dependencies.postIssueMessage(issueId, message, currentSession.account.username);
          return json({ accepted: true, result: result ?? null }, 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to add conversation message";
          return text(message, message === "issue not found" ? 404 : 409);
        }
      }
      return response(null, 405, "text/plain; charset=utf-8", { allow: "GET, POST" });
    }

    const issueRetry = /^\/api\/issues\/([^/]{1,1000})\/retry$/.exec(path);
    if (issueRetry) {
      if (request.method !== "POST") return response(null, 405, "text/plain; charset=utf-8", { allow: "POST" });
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      let issueId: string;
      try { issueId = decodeURIComponent(issueRetry[1]!); } catch { return text("Invalid issue id", 400); }
      if (!issueId || issueId.length > 500) return text("Invalid issue id", 400);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const noteValues = form.getAll("note");
      if (noteValues.length > 1 || (noteValues[0]?.length ?? 0) > 4_000) return text("Invalid retry note", 400);
      try {
        const result = await dependencies.retryIssue(issueId, (noteValues[0] ?? "").trim(), currentSession.account.username);
        return json({ accepted: true, result: result ?? null }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to retry issue";
        return text(message, message === "issue not found" ? 404 : 409);
      }
    }

    const issueRunEvents = /^\/api\/issues\/([^/]{1,1000})\/activity\/runs\/([A-Za-z0-9-]{1,100})\/events$/.exec(path);
    if (issueRunEvents) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
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
      const denied = requireSuperuser(request);
      if (denied) return denied;
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
        await dependencies.dismissFinding(issueId, findingId, reason.trim(), session(request)!.account.username);
        return json({ ok: true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unable to dismiss finding" }, 409);
      }
    }

    if (path === "/steering") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const prompt = oneValue(form, "prompt")?.trim();
      if (!prompt || prompt.length > 12_000) return text("Invalid steering prompt", 400);
      try {
        const runId = await dependencies.startSteering(prompt);
        return redirect(`/operator/runs/${encodeURIComponent(runId)}`);
      } catch (error) {
        return text(error instanceof Error ? error.message : "Unable to start steering agent", 409);
      }
    }

    const steeringEvents = /^\/steering\/([A-Za-z0-9-]{1,100})\/events$/.exec(path);
    if (steeringEvents) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
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
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
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
        return redirect("/board");
      } catch {
        return text("Unable to record answer", 409);
      }
    }

    if (path === "/backlog/reorder") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const issueId = oneValue(form, "issueId");
      const direction = oneValue(form, "direction");
      if (!issueId || issueId.length > 200 || (direction !== "up" && direction !== "down")) return text("Invalid reorder request", 400);
      try {
        await dependencies.reorderBacklog(issueId, direction);
        if (wantsJson(request)) return json({ ok: true });
        return redirect("/board");
      } catch {
        return text("Unable to reorder backlog", 409);
      }
    }

    if (path === "/backlog/move") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
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
