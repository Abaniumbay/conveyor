import plexMono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2" with { type: "file" };
import plexSans400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2" with { type: "file" };
import plexSans500 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2" with { type: "file" };
import plexSans600 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2" with { type: "file" };
import { timingSafeEqual } from "node:crypto";
import { CommandForbiddenError, CommandInputError, CommandUnavailableError, type CommandActor, type CommandOutcome } from "../commands/bus";
import type { CommandInput, CommandName } from "../commands/registry";
import { ToolRequestError } from "../tasks/errors";
import { BUILD } from "../version";
import { PROFILE_AVATARS } from "./account-pages";
import { createWebAuth, hashPassword, verifyPassword, type WebAccountIdentity } from "./auth";
import { dashboardClient } from "./client";
import { agentHref } from "./agent-pages";
import { REPORT_PERIOD_VALUES } from "./report-page";
import { renderDashboard, renderIssueDetails } from "./render";
import { pwaIcons, pwaManifest, serviceWorker } from "./pwa";
import { notificationClient } from "./notifications-client";
import { themeInitScript } from "./styles";
import type { AgentProfileViewModel, DashboardPageSelection, DashboardStreamEvent, DashboardViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRunEventsViewModel, ReportPeriod, ReportViewModel, SystemStatusViewModel } from "./types";

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
  pushPublicKey?: string | null;
  dispatchPushEvents?: () => void | Promise<void>;
  /** Sends a command; every route that changes state goes through it. */
  dispatch: <N extends CommandName>(name: N, input: CommandInput<N>, actor: CommandActor) => Promise<CommandOutcome<N>>;
  /** Records a sign-in or sign-out (never its credentials). */
  recordSession?: (change: "signedIn" | "signedOut", accountId: string | null) => void;
  getDashboard: (
    csrfToken: string,
    pagination: DashboardPageSelection,
  ) => DashboardViewModel | Promise<DashboardViewModel>;
  /** Current data for a single board details dialog, without rebuilding the board page. */
  getIssueDetails?: (csrfToken: string, issueId: string) => IssueCardViewModel | null | Promise<IssueCardViewModel | null>;
  /** Calls `listener` with every event recorded from now on; returns the unsubscribe. */
  subscribeEvents?: (listener: (event: DashboardStreamEvent) => void) => () => void;
  /** The events after `seq` for a reconnecting page; null when they are no longer all kept. */
  eventsAfter?: (seq: number) => DashboardStreamEvent[] | null;
  getSystemStatus: () => SystemStatusViewModel | Promise<SystemStatusViewModel>;
  isReady: () => boolean | Promise<boolean>;
  webhookPath: string;
  handleWebhook: (rawBody: Uint8Array, headers: Headers) => unknown | Promise<unknown>;
  handleMcp: (body: unknown, bearerToken: string, callId?: string) => unknown | Promise<unknown>;
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
  /** Read-only profiles of the configured agents. */
  getAgentProfiles: () => readonly AgentProfileViewModel[] | Promise<readonly AgentProfileViewModel[]>;
  /** The Reports view for a period, across every repository or drilled into one; null for an unknown repository. */
  getReport?: (input: { period: ReportPeriod; repository: string | null }) => ReportViewModel | null | Promise<ReportViewModel | null>;
  getAgentProfile: (agentId: string) => AgentProfileViewModel | null | Promise<AgentProfileViewModel | null>;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export { PROFILE_AVATARS } from "./account-pages";
const DEFAULT_DONE_LIMIT = 20;
const MAX_DONE_LIMIT = 2000;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#087f72"/><path d="M15 21h34M15 43h34" stroke="#dff8f0" stroke-width="6" stroke-linecap="round"/><path d="m25 14 10 18-10 18" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Embedded in the executable: each import is a path Bun.file can read, inside the binary too.
const FONT_ASSETS = new Map<string, string>([
  ["/assets/fonts/ibm-plex-sans-400.woff2", plexSans400],
  ["/assets/fonts/ibm-plex-sans-500.woff2", plexSans500],
  ["/assets/fonts/ibm-plex-sans-600.woff2", plexSans600],
  ["/assets/fonts/ibm-plex-mono-400.woff2", plexMono400],
]);

// The scripts change only with a release, so browsers revalidate them instead of downloading them with every page.
const SCRIPT_ASSETS = new Map(Object.entries({
  "/assets/dashboard.js": dashboardClient,
  "/assets/notifications.js": notificationClient,
  "/assets/theme.js": themeInitScript,
}).map(([path, source]) => [path, { source, etag: `"${Bun.hash(source).toString(36)}"` }]));
const COMPRESSIBLE_TYPE = /^(text\/(html|javascript|css|plain)|application\/(json|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESSED_BYTES = 1024;

/** Whether Accept-Encoding allows gzip: listed (or covered by `*`) with a quality above zero. */
function acceptsGzip(header: string | null): boolean {
  const qualities = new Map((header ?? "").split(",").map((entry) => {
    const [coding = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return [coding, quality ? Number(quality.slice(2)) : 1] as const;
  }));
  const quality = qualities.get("gzip") ?? qualities.get("*") ?? 0;
  return quality > 0;
}

/** Gzips complete text responses for clients that accept it; event streams and fonts pass through untouched. */
async function compressed(request: Request, result: Response): Promise<Response> {
  if (result.status !== 200 || !result.body || result.headers.has("content-encoding")) return result;
  if (!COMPRESSIBLE_TYPE.test(result.headers.get("content-type") ?? "")) return result;
  const headers = new Headers(result.headers);
  headers.append("vary", "accept-encoding");
  const body = new Uint8Array(await result.arrayBuffer());
  if (body.byteLength < MIN_COMPRESSED_BYTES || !acceptsGzip(request.headers.get("accept-encoding"))) {
    return new Response(body, { status: result.status, headers });
  }
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  return new Response(Bun.gzipSync(body), { status: result.status, headers });
}

function response(body: BodyInit | null, status: number, contentType: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", contentType);
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("referrer-policy", "same-origin");
  responseHeaders.set("x-robots-tag", "noindex");
  if (!responseHeaders.has("cache-control")) responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-security-policy", "default-src 'none'; manifest-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Sign in · Conveyor</title><script src="/assets/theme.js"></script><style>@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-400.woff2") format("woff2")}@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:600;font-display:swap;src:url("/assets/fonts/ibm-plex-sans-600.woff2") format("woff2")}:root{color-scheme:light;--concrete:#E8EBE8;--panel:#F8F9F7;--ink:#1C2328;--steel:#5D6970;--line:#8A959B;--signal:#2A5BD7;--stop:#A72F1D;--on-signal:#FFFFFF;--shadow:0 8px 32px rgba(28,35,40,.07)}:root[data-theme="light"]{color-scheme:light}:root[data-theme="dark"]{color-scheme:dark;--concrete:#151A1D;--panel:#20272B;--ink:#F2F5F3;--steel:#AEB9BD;--line:#66737A;--signal:#83A7FF;--stop:#FF7B69;--on-signal:#0E1A34;--shadow:0 8px 32px rgba(0,0,0,.48)}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--concrete:#151A1D;--panel:#20272B;--ink:#F2F5F3;--steel:#AEB9BD;--line:#66737A;--signal:#83A7FF;--stop:#FF7B69;--on-signal:#0E1A34;--shadow:0 8px 32px rgba(0,0,0,.48)}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--concrete);color:var(--ink);font:15px/1.5 "IBM Plex Sans",sans-serif}.login{box-sizing:border-box;width:min(24rem,calc(100% - 2rem));padding:clamp(1.25rem,6vw,2rem);background:var(--panel);border:1px solid var(--line);border-radius:2px;box-shadow:var(--shadow)}h1{margin:0 0 .35rem;font-size:24px}.muted{margin:0 0 1.25rem;color:var(--steel)}label{display:block;margin:.8rem 0 .4rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid var(--line);border-radius:2px;background:var(--panel);color:var(--ink);font:inherit;caret-color:var(--signal)}button{width:100%;margin-top:1rem;padding:.7rem;border:0;border-radius:2px;background:var(--signal);color:var(--on-signal);font:inherit;font-weight:600;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid var(--signal);outline-offset:2px}.error{color:var(--stop)}::selection{background:var(--signal);color:var(--on-signal)}</style></head><body><main class="login"><h1>Sign in</h1><p class="muted">Access the Conveyor dashboard.</p>${error}<form method="post" action="/login">${returnField}<label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button></form></main></body></html>`;
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
  repositoryId: string | null = null,
  runId: string | null = null,
  issueId: string | null = null,
): DashboardPageSelection {
  // Repository filters are intentionally permissive: an unknown repository simply matches no cards
  // in the browser, and an unknown state has no special meaning.
  const repositoryIds = [...new Set(url.searchParams.getAll("repo").filter((id) => id.length > 0 && id.length <= 200))];
  const recentTypes = [...new Set(url.searchParams.getAll("type").filter((type): type is import("./types").RecentActivityType =>
    ["done", "stopped", "sent-back", "moved-forward", "new", "resumed", "rollup"].includes(type),
  ))];
  const beforeAt = url.searchParams.getAll("beforeAt");
  const beforeId = url.searchParams.getAll("beforeId");
  const cursorTime = beforeAt.length === 1 && !Number.isNaN(Date.parse(beforeAt[0]!)) ? beforeAt[0]! : null;
  const recentCursor = cursorTime && (beforeId.length === 0 || beforeId.length === 1 && beforeId[0]!.length > 0 && beforeId[0]!.length <= 400)
    ? { occurredAt: cursorTime, id: beforeId[0] ?? null }
    : null;
  const rawQuery = url.searchParams.getAll("q");
  const q = rawQuery.length === 1 ? rawQuery[0]!.slice(0, 500) : "";
  const rawState = url.searchParams.getAll("state");
  const state = rawState.length === 1 && ["needs-you", "running", "waiting"].includes(rawState[0]!) ? rawState[0]! : null;
  const rawGraphStage = url.searchParams.getAll("stage");
  const graphStage = rawGraphStage.length === 1 && rawGraphStage[0]!.length > 0 && rawGraphStage[0]!.length <= 200
    ? rawGraphStage[0]!
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
    return { view, repositoryId, column: null, page: 1, doneLimit, runId, issueId, repositoryIds, q, state, graphStage, recentTypes, recentCursor };
  }
  const column = columns[0]!;
  const page = pages[0]!;
  if (column.length === 0 || column.length > 200 || !/^[1-9]\d*$/.test(page)) {
    return { view, repositoryId, column: null, page: 1, doneLimit, runId, issueId, repositoryIds, q, state, graphStage, recentTypes, recentCursor };
  }
  const parsedPage = Number(page);
  return Number.isSafeInteger(parsedPage)
    ? { view, repositoryId, column, page: parsedPage, doneLimit, runId, issueId, repositoryIds, q, state, graphStage, recentTypes, recentCursor }
    : { view, repositoryId, column: null, page: 1, doneLimit, runId, issueId, repositoryIds, q, state, graphStage, recentTypes, recentCursor };
}

function paginationSuffix(url: URL): string {
  const pagination = new URLSearchParams();
  for (const key of ["repo", "type", "q", "state", "stage", "doneLimit", "column", "page", "beforeAt", "beforeId"]) {
    const values = url.searchParams.getAll(key);
    if (key === "repo" || key === "type") {
      for (const value of [...new Set(values)]) pagination.append(key, value);
    } else if (values.length === 1) {
      pagination.set(key, values[0]!);
    }
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

/**
 * The live dashboard stream: one `conveyor` message per recorded event (identifiers and type only;
 * the page re-reads what it shows), the system status every ten seconds and a heartbeat. A browser
 * reconnecting with Last-Event-ID first receives what it missed, or `reset` when that is no
 * longer all kept.
 */
function dashboardEventStream(dependencies: WebHandlerDependencies, lastEventId: number | null): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
          stop();
        }
      };
      const forward = (event: DashboardStreamEvent) => send(`id: ${event.seq}\nevent: conveyor\ndata: ${JSON.stringify(event)}\n\n`);
      let statusTimer: ReturnType<typeof setTimeout> | null = null;
      // Every ten seconds; a failed read (a transient statfs error) is retried after a second.
      const status = async () => {
        let delay = 10_000;
        try {
          send(`event: status\ndata: ${JSON.stringify(await dependencies.getSystemStatus())}\n\n`);
        } catch {
          delay = 1_000;
        }
        if (!closed) statusTimer = setTimeout(() => void status(), delay);
      };
      send("retry: 5000\n\n: ping\n\n");
      // Subscribe before replaying, so nothing appended in between is lost; replay skips duplicates.
      const buffered: DashboardStreamEvent[] = [];
      let replaying = lastEventId !== null;
      let lastSent = lastEventId ?? 0;
      const unsubscribe = dependencies.subscribeEvents?.((event) => {
        if (replaying) buffered.push(event);
        else if (event.seq > lastSent) {
          lastSent = event.seq;
          forward(event);
        }
      }) ?? (() => {});
      if (lastEventId !== null) {
        const missed = dependencies.eventsAfter ? dependencies.eventsAfter(lastEventId) : [];
        if (missed === null) send("event: reset\ndata: {}\n\n");
        else for (const event of missed) {
          lastSent = Math.max(lastSent, event.seq);
          forward(event);
        }
        replaying = false;
        for (const event of buffered.splice(0)) {
          if (event.seq <= lastSent) continue;
          lastSent = event.seq;
          forward(event);
        }
      }
      void status();
      const heartbeat = setInterval(() => send(": ping\n\n"), 4_000);
      stop = () => {
        closed = true;
        if (statusTimer) clearTimeout(statusTimer);
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      stop();
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

  /** The signed-in account as the sender of a command. */
  function actorOf(current: NonNullable<ReturnType<typeof session>>): CommandActor {
    return { kind: "user", id: current.account.id, name: current.account.username, role: current.account.role };
  }

  /**
   * The response for an error the command bus raised itself, or null for a handler's own error.
   * `unavailable` is the route's answer when this process has no handler for the command.
   */
  function commandError(error: unknown, unavailable?: Response): Response | null {
    if (error instanceof CommandInputError) return json({ error: error.message }, 400);
    if (error instanceof CommandForbiddenError) return json({ error: "forbidden" }, 403);
    if (error instanceof CommandUnavailableError) return unavailable ?? text(error.message, 503);
    return null;
  }

  const handle = async (request: Request): Promise<Response> => {
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

    const script = SCRIPT_ASSETS.get(path);
    if (script) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const headers = { "cache-control": "no-cache", etag: script.etag };
      return request.headers.get("if-none-match") === script.etag
        ? response(null, 304, "text/javascript; charset=utf-8", headers)
        : response(script.source, 200, "text/javascript; charset=utf-8", headers);
    }

    const pwaIcon = pwaIcons.get(path);
    if (pwaIcon) {
      const methodError = requireMethod(request, "GET");
      return methodError ?? response(pwaIcon, 200, "image/svg+xml; charset=utf-8", {
        "cache-control": "public, max-age=31536000, immutable",
      });
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
      return methodError ?? json({ status: "live", version: BUILD.version, commit: BUILD.commit });
    }

    if (path === "/version") {
      const methodError = requireMethod(request, "GET");
      return methodError ?? json({
        service: "conveyor",
        version: BUILD.version,
        commit: BUILD.commit,
        builtAt: BUILD.builtAt,
      });
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
      if (request.method === "GET") {
        return session(request) ? redirect(returnTo ?? "/board") : response(loginPage("", returnTo), 200, "text/html; charset=utf-8");
      }
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
      dependencies.recordSession?.("signedIn", account?.id ?? null);
      return redirect(requestedReturnTo ?? "/board", { "set-cookie": created.cookie });
    }

    if (path === "/logout") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const current = session(request)!;
      const pushEndpoint = oneValue(form, "pushEndpoint");
      if (pushEndpoint && isHttpsEndpoint(pushEndpoint)) {
        await dependencies.dispatch("notifications.unsubscribe", { accountId: current.account.id, endpoint: pushEndpoint }, actorOf(current)).catch(() => {});
      }
      dependencies.recordSession?.("signedOut", current.account.id);
      return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
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
      const preferences = { questions: input.questions as boolean, stopped: input.stopped as boolean, done: input.done as boolean };
      try {
        const { correlationId } = await dependencies.dispatch("notifications.updateSettings", { accountId: current.account.id, preferences }, actorOf(current));
        return json({ preferences, correlationId });
      } catch (error) {
        const unavailable = json({ error: "Notification settings are unavailable" }, 503);
        const handled = commandError(error, unavailable);
        if (handled) return handled;
        throw error;
      }
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
        try {
          await dependencies.dispatch("notifications.unsubscribe", { accountId: current.account.id, endpoint: input.endpoint }, actorOf(current));
        } catch (error) {
          return commandError(error) ?? json({ error: "Unable to remove the subscription" }, 409);
        }
        return json({ removed: true });
      }
      const keys = input.keys as Record<string, unknown> | undefined;
      if (!dependencies.pushPublicKey || !keys || !isBase64UrlOfLength(keys.p256dh, 65) || !isBase64UrlOfLength(keys.auth, 16) || (input.expirationTime !== undefined && input.expirationTime !== null && typeof input.expirationTime !== "number") || Object.keys(input).some((key) => !["endpoint", "expirationTime", "keys"].includes(key)) || Object.keys(keys).some((key) => !["p256dh", "auth"].includes(key))) return json({ error: dependencies.pushPublicKey ? "Invalid subscription data" : "Server push is not configured" }, 400);
      try {
        await dependencies.dispatch("notifications.subscribe", { accountId: current.account.id, endpoint: input.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, actorOf(current));
      } catch (error) {
        return commandError(error) ?? json({ error: "Unable to register the subscription" }, 409);
      }
      return json({ registered: true }, 201);
    }

    const accountAction = /^\/api\/accounts\/([^/]+)\/(password|delete)$/.exec(path);
    if (accountAction) {
      const denied = requireSuperuser(request);
      if (denied) return denied;
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      let accountId: string;
      try { accountId = decodeURIComponent(accountAction[1]!); } catch { return json({ error: "Invalid account." }, 400); }
      if (!accountId) return json({ error: "Invalid account." }, 400);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const target = dependencies.getAccount?.(accountId);
      if (!target) return json({ error: "Account not found." }, 404);
      const current = session(request)!;

      if (accountAction[2] === "password") {
        const password = oneValue(form, "password");
        if (!password || password.length < 12 || password.length > 1024) return json({ error: "Password must be 12 to 1024 characters." }, 400);
        try {
          await dependencies.dispatch("account.setPassword", { accountId: target.id, passwordHash: hashPassword(password) }, actorOf(current));
        } catch (error) {
          const unavailable = json({ error: "Account management is unavailable" }, 503);
          const handled = commandError(error, unavailable);
        if (handled) return handled;
        throw error;
        }
        if (target.id === current.account.id) return redirect("/login", { "set-cookie": dependencies.auth.clearCookie() });
        return json({ passwordChanged: true });
      }

      if (target.id === current.account.id) return json({ error: "You cannot delete your own account." }, 400);
      if (target.role === "superuser") return json({ error: "Superuser accounts cannot be deleted." }, 400);
      if (oneValue(form, "confirmation") !== target.username) return json({ error: `Type ${target.username} to confirm deletion.` }, 400);
      let deleted: "deleted" | "not_found" | "superuser";
      try {
        deleted = (await dependencies.dispatch("account.delete", { accountId: target.id }, actorOf(current))).result;
      } catch (error) {
        const unavailable = json({ error: "Account management is unavailable" }, 503);
        const handled = commandError(error, unavailable);
        if (handled) return handled;
        throw error;
      }
      if (deleted === "not_found") return json({ error: "Account not found." }, 404);
      if (deleted === "superuser") return json({ error: "Superuser accounts cannot be deleted." }, 400);
      return json({ deleted: true });
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
      try {
        const { result: created } = await dependencies.dispatch("account.create", { username, passwordHash: hashPassword(password) }, actorOf(session(request)!));
        return json({ account: { id: created.id, username: created.username, role: created.role, avatar: created.avatar } }, 201);
      } catch (error) {
        return commandError(error, json({ error: "Account management is unavailable" }, 503)) ?? json({ error: "That username is already in use." }, 409);
      }
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
      try {
        await dependencies.dispatch("account.setPassword", { accountId: current.account.id, passwordHash: hashPassword(newPassword) }, actorOf(current));
      } catch (error) {
        const unavailable = json({ error: "Password changes are unavailable" }, 503);
        const handled = commandError(error, unavailable);
        if (handled) return handled;
        throw error;
      }
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
      try {
        const { correlationId } = await dependencies.dispatch("account.setAvatar", { accountId: current.account.id, avatar }, actorOf(current));
        return json({ ok: true, avatar, correlationId });
      } catch (error) {
        const unavailable = json({ error: "Profile updates are unavailable" }, 503);
        const handled = commandError(error, unavailable);
        if (handled) return handled;
        throw error;
      }
    }

    const legacyDashboardQuery = path === "/" && ["view", "issue", "tab", "agent", "run"]
      .some((key) => url.searchParams.has(key));
    const teamProfilePath = /^\/team\/([^/]{1,200})$/.exec(path);
    const operatorRunPath = /^\/operator\/runs\/([A-Za-z0-9-]{1,100})$/.exec(path);
    const issuePagePath = /^\/issues\/([^/]{1,200})\/([1-9]\d*)(?:\/(conversation|journey|logs))?$/.exec(path);
    const reportPath = /^\/reports(?:\/([^/]{1,200}))?$/.exec(path);
    const repositoryPath = /^\/repositories\/([^/]{1,200})$/.exec(path);
    const dashboardView = path === "/" || path === "/board"
      ? "board"
      : path === "/graph"
        ? "graph"
      : path === "/recent"
        ? "recent"
      : path === "/attention"
        ? "attention"
        : path === "/team" || teamProfilePath
          ? "team"
          : path === "/operator" || operatorRunPath
            ? "agent"
            : reportPath && dependencies.getReport
              ? "reports"
              : path === "/repositories"
                ? "repositories"
                : repositoryPath
                  ? "repository"
              : path === "/about"
                ? "about"
              : path === "/accounts"
                ? "accounts"
                : path === "/profile"
                  ? "profile"
                  : path === "/settings/notifications"
                    ? "notifications"
                    : issuePagePath ? "board" : null;

    if (legacyDashboardQuery || dashboardView) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return redirect(issuePagePath || repositoryPath || dashboardView === "recent" || dashboardView === "graph" ? `/login?returnTo=${encodeURIComponent(`${path}${url.search}`)}` : "/login");
      if (dashboardView === "accounts" && currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
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
        let repositoryId: string | null = null;
        let repositoryNotFound = false;
        if (repositoryPath) {
          try { repositoryId = decodeURIComponent(repositoryPath[1]!); } catch { repositoryNotFound = true; }
        }
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

        const page = dashboardPage(url, dashboardView!, repositoryId, runId, issueId);
        // A live update names the card revisions the browser holds; those come back as placeholders.
        const held = request.headers.get("x-conveyor-cards");
        const heldCards = held ? new Set(held.split(" ").filter(Boolean).slice(0, 2_000)) : null;
        const model = await dependencies.getDashboard(currentSession.csrfToken, page);
        if (repositoryPath && (!repositoryId || !model.repositories.some((repository) => repository.id === repositoryId))) repositoryNotFound = true;
        const team = page.view === "team" ? await dependencies.getAgentProfiles() : undefined;
        const accounts = page.view === "accounts" ? dependencies.listAccounts?.() ?? [] : undefined;
        const notifications = page.view === "notifications" ? dependencies.getPushPreferences?.(currentSession.account.id) ?? { questions: false, stopped: false, done: false } : undefined;
        return response(renderDashboard({ ...model, view: page.view, account: currentSession.account, ...(team ? { team } : {}), ...(report ? { report } : {}), ...(accounts ? { accounts } : {}), ...(notifications ? { notifications } : {}) }, heldCards), repositoryNotFound ? 404 : 200, "text/html; charset=utf-8");
      } catch {
        return text("Dashboard is temporarily unavailable", 503);
      }
    }

    if (path === "/events/dashboard") {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      if (!session(request)) return json({ error: "unauthorized" }, 401);
      const lastEventId = /^\d{1,15}$/.test(request.headers.get("last-event-id") ?? "") ? Number(request.headers.get("last-event-id")) : null;
      return response(dashboardEventStream(dependencies, lastEventId), 200, "text/event-stream; charset=utf-8", {
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

    const issueDetails = /^\/api\/issues\/([^/]{1,1000})\/details$/.exec(path);
    if (issueDetails) {
      const methodError = requireMethod(request, "GET");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      let issueId: string;
      try {
        issueId = decodeURIComponent(issueDetails[1]!);
      } catch {
        return text("Invalid issue id", 400);
      }
      if (!issueId || issueId.length > 500) return text("Invalid issue id", 400);
      if (!dependencies.getIssueDetails) return text("Issue details are temporarily unavailable", 503);
      try {
        const issue = await dependencies.getIssueDetails(currentSession.csrfToken, issueId);
        return issue
          ? response(renderIssueDetails(issue, currentSession.account.role === "superuser"), 200, "text/html; charset=utf-8")
          : text("Issue not found", 404);
      } catch {
        return text("Issue details are temporarily unavailable", 503);
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
          const { result, correlationId } = await dependencies.dispatch("item.postMessage", { issueId, message }, actorOf(currentSession));
          return json({ accepted: true, result: result ?? null, correlationId }, 201);
        } catch (error) {
          const handled = commandError(error);
          if (handled) return handled;
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
        const { result, correlationId } = await dependencies.dispatch("item.retry", { issueId, note: (noteValues[0] ?? "").trim() }, actorOf(currentSession));
        return json({ accepted: true, result: result ?? null, correlationId }, 202);
      } catch (error) {
        const handled = commandError(error);
        if (handled) return handled;
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
        const { correlationId } = await dependencies.dispatch("finding.dismiss", { issueId, findingId, reason: reason.trim() }, actorOf(session(request)!));
        return json({ ok: true, correlationId });
      } catch (error) {
        return commandError(error) ?? json({ error: error instanceof Error ? error.message : "Unable to dismiss finding" }, 409);
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
        const { result: runId } = await dependencies.dispatch("steering.start", { prompt }, actorOf(currentSession));
        return redirect(`/operator/runs/${encodeURIComponent(runId)}`);
      } catch (error) {
        return commandError(error) ?? text(error instanceof Error ? error.message : "Unable to start steering agent", 409);
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
        return json(await dependencies.handleMcp(parsed, token, request.headers.get("x-conveyor-call-id") ?? undefined));
      } catch (error) {
        if (error instanceof ToolRequestError) return json({ error: error.message }, 422);
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
      if (answer === null || answer.trim().length === 0) return text("An answer is required", 400);
      try {
        const { correlationId } = await dependencies.dispatch("question.answer", { questionId, answer }, actorOf(currentSession));
        if (wantsJson(request)) return json({ ok: true, correlationId });
        return redirect("/board");
      } catch (error) {
        const handled = commandError(error);
        if (handled) return handled;
        const message = error instanceof Error ? error.message : "Unable to record answer";
        return wantsJson(request) ? json({ error: message }, 409) : text(message, 409);
      }
    }

    if (path === "/manual-gates/requirement" || path === "/manual-gates/approve") {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      const issueId = oneValue(form, "issueId");
      const stageId = oneValue(form, "stageId");
      const gateId = oneValue(form, "gateId");
      if (!issueId || !stageId || issueId.length > 200 || stageId.length > 200 || (gateId !== null && gateId.length > 200)) {
        return text("Invalid manual gate request", 400);
      }
      try {
        let correlationId: string;
        if (path === "/manual-gates/requirement") {
          const required = oneValue(form, "required");
          if (required !== "true" && required !== "false") return text("Invalid manual gate request", 400);
          ({ correlationId } = await dependencies.dispatch("gate.setItemApproval", { issueId, stageId, required: required === "true" }, actorOf(currentSession)));
        } else {
          ({ correlationId } = await dependencies.dispatch("gate.approve", { issueId, stageId, gateId: gateId ?? null }, actorOf(currentSession)));
        }
        if (wantsJson(request)) return json({ ok: true, correlationId });
        return redirect("/board");
      } catch (error) {
        const handled = commandError(error, wantsJson(request) ? json({ error: "Manual gate controls are unavailable" }, 503) : text("Manual gate controls are unavailable", 503));
        if (handled) return handled;
        const message = error instanceof Error ? error.message : "Unable to update manual gate";
        return wantsJson(request) ? json({ error: message }, 409) : text(message, 409);
      }
    }

    const repositorySyncPath = /^\/repositories\/([^/]{1,200})\/sync$/.exec(path);
    if (repositorySyncPath) {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      let repositoryId: string;
      try {
        repositoryId = decodeURIComponent(repositorySyncPath[1]!);
      } catch {
        return text("Invalid repository", 400);
      }
      try {
        const { result, correlationId } = await dependencies.dispatch("repository.sync", { repositoryId }, actorOf(currentSession));
        if (wantsJson(request)) return json({ ok: !result.failed, ...result, correlationId });
        return redirect(`/repositories/${encodeURIComponent(repositoryId)}`);
      } catch (error) {
        return commandError(error) ?? text("Unable to sync the repository", 409);
      }
    }

    const repositoryPausePath = /^\/repositories\/([^/]{1,200})\/(pause|resume)$/.exec(path);
    if (repositoryPausePath) {
      const methodError = requireMethod(request, "POST");
      if (methodError) return methodError;
      const currentSession = session(request);
      if (!currentSession) return json({ error: "unauthorized" }, 401);
      if (currentSession.account.role !== "superuser") return json({ error: "forbidden" }, 403);
      const form = await readForm(request, maxBodyBytes);
      if (form instanceof Response) return form;
      if (!validateCsrf(request, form, dependencies.auth)) return json({ error: "forbidden" }, 403);
      let repositoryId: string;
      try {
        repositoryId = decodeURIComponent(repositoryPausePath[1]!);
      } catch {
        return text("Invalid repository", 400);
      }
      const action = repositoryPausePath[2]!;
      const reason = oneValue(form, "reason");
      if (reason !== null && reason.length > 500) return text("Pause reason is too long", 400);
      if (action === "resume" && reason !== null) return text("Invalid resume request", 400);
      try {
        const { result, correlationId } = action === "pause"
          ? await dependencies.dispatch("repository.pause", { repositoryId, reason: reason ?? "" }, actorOf(currentSession))
          : await dependencies.dispatch("repository.resume", { repositoryId }, actorOf(currentSession));
        if (wantsJson(request)) return json({ ok: true, ...result, correlationId });
        return redirect(`/repositories/${encodeURIComponent(repositoryId)}`);
      } catch (error) {
        return commandError(error) ?? text(`Unable to ${action} the repository`, 409);
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
        const { correlationId } = await dependencies.dispatch("backlog.reorder", { issueId, direction }, actorOf(currentSession));
        if (wantsJson(request)) return json({ ok: true, correlationId });
        return redirect("/board");
      } catch (error) {
        return commandError(error) ?? text("Unable to reorder backlog", 409);
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
        const { correlationId } = await dependencies.dispatch("backlog.move", { issueId, beforeIssueId }, actorOf(currentSession));
        return json({ ok: true, correlationId });
      } catch (error) {
        return commandError(error) ?? text("Unable to reorder backlog", 409);
      }
    }

    return text("Not found", 404);
  };
  return async (request: Request): Promise<Response> => {
    const result = await handle(request);
    // Loading a page counts as activity: a session past half its lifetime is extended, so only a
    // stretch without visits signs anyone out.
    if (request.method === "GET" && result.status === 200 && !result.headers.has("set-cookie") && result.headers.get("content-type")?.startsWith("text/html")) {
      const current = session(request);
      const renewed = current && dependencies.auth.renewSession(current);
      if (renewed) result.headers.append("set-cookie", renewed);
    }
    return compressed(request, result);
  };
}
