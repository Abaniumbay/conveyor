// The local control interface: a small JSON API on a Unix socket under <home>/run, readable and
// writable only by the service account (directory 0700, socket 0600). Filesystem ownership is the
// authentication: whoever can open the socket can operate this Conveyor, as on its own dashboard.
// Every request calls the same service operations the dashboard does.

import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { ConveyorService } from "../app/service";
import { log } from "../log/logger";
import { readReleaseState } from "../release/state";
import { SwitchRefused, type ReleaseCoordinator } from "./releases";
import { BUILD } from "../version";

/** What `status` reports about this process beyond the service's own state. */
export interface ControlInfo {
  home: string;
  config: string;
  logs: string;
  database: string;
  dashboardUrl: string;
  startedAt: string;
  /** Set when systemd runs this process (INVOCATION_ID), so a restart request is safe. */
  supervised: boolean;
}

/** Hooks for operations that end or replace this process (provided by `serve`). */
export interface ControlHooks {
  /** Exits so the supervisor restarts the process (after draining, which the caller does). */
  restart?: () => void;
  /** Upgrades and rollbacks of the running service. */
  releases?: ReleaseCoordinator;
}

class ControlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

function itemReference(service: ConveyorService, issueId: string): string {
  const issue = service.store.getIssue(issueId);
  return issue ? `${issue.repositoryId}:${issue.sourceNumber}` : issueId;
}

/** `<repository>:<number>`, `<repository>#<number>` or an internal item id. */
export function resolveItem(service: ConveyorService, reference: string): string {
  const match = /^(.+)[:#](\d+)$/.exec(reference);
  const issue = match
    ? service.store.listIssues(match[1]).find((candidate) => candidate.sourceNumber === Number(match[2]))
    : service.store.getIssue(reference);
  if (!issue || issue.projectedState === "offboarded") throw new ControlError(`no item ${reference}`, 404);
  return issue.id;
}

const STOPPED = new Set(["blocked", "error", "needs-input", "needs-intervention", "rejected"]);
const RETRYABLE = new Set(["blocked", "error", "needs-intervention"]);

function status(service: ConveyorService, info: ControlInfo) {
  const work = service.activeWork();
  const issues = service.store.listIssues().filter((issue) => issue.projectedState !== "offboarded");
  return {
    version: BUILD,
    pid: process.pid,
    ...info,
    configHash: service.config.hash,
    ready: service.isReady(),
    draining: service.draining(),
    runners: { limit: service.config.settings.runners, busy: work.items.length },
    active: work.items.map((item) => ({ item: itemReference(service, item.issueId), stage: item.stageId })),
    steering: work.steering,
    stopped: issues
      .filter((issue) => STOPPED.has(issue.projectedState ?? ""))
      .map((issue) => ({
        item: `${issue.repositoryId}:${issue.sourceNumber}`,
        title: issue.title,
        stage: issue.projectedStage,
        state: issue.projectedState,
        reason: service.issueJourney(issue.id)?.now.reason ?? issue.warning,
      })),
    openQuestions: service.store.listOpenQuestions().length,
  };
}

function board(service: ConveyorService) {
  const running = new Set(service.activeWork().items.map((item) => item.issueId));
  return service.store.listIssues()
    .filter((issue) => issue.projectedState !== "offboarded")
    .sort((left, right) => (left.queueRank ?? Infinity) - (right.queueRank ?? Infinity))
    .map((issue) => ({
      item: `${issue.repositoryId}:${issue.sourceNumber}`,
      title: issue.title,
      stage: issue.projectedStage,
      state: running.has(issue.id) ? "running" : issue.projectedState ?? issue.sourceState,
      warning: issue.warning,
      url: issue.sourceUrl,
    }));
}

function item(service: ConveyorService, issueId: string) {
  const issue = service.store.getIssue(issueId)!;
  const journey = service.issueJourney(issueId);
  const question = service.store.listOpenQuestions().find((candidate) => candidate.issueId === issueId) ?? null;
  const running = service.activeWork().items.some((entry) => entry.issueId === issueId);
  const enrolled = issue.labels.includes(service.config.labels.enrollment);
  const actions: string[] = [];
  if (question) actions.push(`answer the question: conveyor questions answer ${question.id} <answer>`);
  if (!running && RETRYABLE.has(issue.projectedState ?? "")) actions.push(`retry the ${issue.projectedStage} stage: conveyor item retry ${itemReference(service, issueId)}`);
  if (enrolled && issue.sourceState === "open") actions.push(`pause it: conveyor item pause ${itemReference(service, issueId)}`);
  if (!enrolled && issue.sourceState === "open") actions.push(`resume it: conveyor item resume ${itemReference(service, issueId)}`);
  return {
    item: itemReference(service, issueId),
    id: issue.id,
    title: issue.title,
    url: issue.sourceUrl,
    sourceState: issue.sourceState,
    stage: journey?.now.stage ?? issue.projectedStage,
    state: running ? "running" : journey?.now.state ?? issue.projectedState,
    since: journey?.now.since ?? null,
    blocker: journey?.now.reason ?? null,
    warning: issue.warning,
    paused: !enrolled,
    question: question && { id: question.id, prompt: question.prompt, reason: question.reason, options: question.options, allowFreeText: question.allowFreeText },
    actions,
  };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ControlError("the request body must be a JSON object", 400);
  return parsed as Record<string, unknown>;
}

/** The actor recorded for CLI actions: the caller's Unix account, as the CLI reports it. */
function actor(request: Request): string {
  const name = request.headers.get("x-conveyor-actor")?.replace(/[^\w.@-]/g, "").slice(0, 64);
  return `${name || "operator"} (CLI)`;
}

export function createControlHandler(service: ConveyorService, info: ControlInfo, hooks: ControlHooks = {}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === "GET /v1/status") return json(status(service, info));
      if (route === "GET /v1/board") return json(board(service));
      if (route === "GET /v1/questions") {
        return json(service.store.listOpenQuestions().map((question) => ({
          id: question.id, item: itemReference(service, question.issueId), prompt: question.prompt, reason: question.reason,
          options: question.options, allowFreeText: question.allowFreeText, createdAt: question.createdAt,
        })));
      }
      const answer = /^POST \/v1\/questions\/([^/]+)\/answer$/.exec(route);
      if (answer) {
        const text = (await body(request)).answer;
        if (typeof text !== "string" || !text.trim() || text.length > 4_000) throw new ControlError("answer must be 1-4000 characters", 400);
        const question = service.store.getQuestion(decodeURIComponent(answer[1]!));
        if (!question) throw new ControlError("no such question", 404);
        if (question.status !== "open") throw new ControlError(`the question is ${question.status}`, 409);
        await service.answerQuestion(question.id, text.trim());
        log.info("Question answered", { item: itemReference(service, question.issueId), question: question.id, actor: actor(request) });
        return json({ answered: question.id, item: itemReference(service, question.issueId) });
      }
      const itemRoute = /^(GET|POST) \/v1\/items\/([^/]+)(?:\/(history|logs|retry|pause|resume))?$/.exec(route);
      if (itemRoute) {
        const [, method, reference, action] = itemRoute;
        const issueId = resolveItem(service, decodeURIComponent(reference!));
        if (method === "GET" && !action) return json(item(service, issueId));
        if (method === "GET" && action === "history") return json({ item: itemReference(service, issueId), transitions: service.issueJourney(issueId)?.transitions ?? [] });
        if (method === "GET" && action === "logs") {
          const after = Number(url.searchParams.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0) throw new ControlError("after must be an event id", 400);
          return json({ item: itemReference(service, issueId), events: service.store.listIssueRunEventsAfter(issueId, after, 500) });
        }
        if (method === "POST" && action === "retry") {
          const note = (await body(request)).note;
          const result = await service.retryIssue(issueId, typeof note === "string" ? note : "", actor(request));
          return json({ item: itemReference(service, issueId), ...result });
        }
        if (method === "POST" && action === "pause") return json({ item: itemReference(service, issueId), ...(await service.pauseIssue(issueId, actor(request))) });
        if (method === "POST" && action === "resume") return json({ item: itemReference(service, issueId), ...(await service.resumeIssue(issueId, actor(request))) });
      }
      if (route === "POST /v1/drain") {
        const reason = (await body(request)).reason;
        return json({ draining: service.drain(typeof reason === "string" && reason ? reason : `requested by ${actor(request)}`), active: service.activeWork() });
      }
      if (route === "DELETE /v1/drain") return json({ resumed: service.resumeAdmission() });
      if (route === "POST /v1/restart") {
        if (!hooks.restart || !info.supervised) throw new ControlError("this Conveyor is not run by systemd, so it cannot restart itself; stop and start it instead", 409);
        const work = service.activeWork();
        if (work.items.length > 0 || work.steering > 0) throw new ControlError("work is still running: drain first", 409);
        setTimeout(() => hooks.restart?.(), 50);
        return json({ restarting: true });
      }
      if (route === "GET /v1/releases") return json({ running: BUILD, ...(await readReleaseState(info.home)) });
      if (route === "POST /v1/releases" && hooks.releases) {
        const input = await body(request);
        const kind = input.kind === "rollback" ? "rollback" : input.kind === "upgrade" ? "upgrade" : null;
        if (!kind || typeof input.prefix !== "string" || (kind === "upgrade" && typeof input.version !== "string")) {
          throw new ControlError("kind (upgrade or rollback), prefix and, for an upgrade, version are required", 400);
        }
        const drainTimeoutMs = typeof input.drainTimeoutMs === "number" && input.drainTimeoutMs > 0 ? input.drainTimeoutMs : 30 * 60_000;
        const pending = await hooks.releases.schedule({
          kind, prefix: input.prefix, drainTimeoutMs, restoreBackup: input.restoreBackup === true,
          ...(typeof input.version === "string" ? { version: input.version } : {}),
        });
        return json({ pending }, 202);
      }
      if (route === "DELETE /v1/releases/pending" && hooks.releases) {
        return json({ cancelled: await hooks.releases.cancel(`cancelled by ${actor(request)}`) });
      }
      return json({ error: `no route ${route}` }, 404);
    } catch (error) {
      if (error instanceof ControlError) return json({ error: error.message }, error.status);
      if (error instanceof SwitchRefused) return json({ error: error.message }, 409);
      if (error instanceof SyntaxError) return json({ error: "the request body is not JSON" }, 400);
      // Service preconditions (already running, state changed, not paused, ...) are refusals, not crashes.
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  };
}

/** Serves the control API on `socket`; refuses to start when another live process holds it. */
export async function serveControlSocket(socket: string, handler: (request: Request) => Promise<Response>): Promise<{ stop(): Promise<void> }> {
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(socket), 0o700);
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`another Conveyor is already running for this home (${socket} is in use)`);
  await rm(socket, { force: true });
  const server = Bun.serve({ unix: socket, fetch: handler });
  await chmod(socket, 0o600);
  return {
    async stop() {
      await server.stop(true);
      await rm(socket, { force: true });
    },
  };
}
