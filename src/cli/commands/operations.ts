// Operational inspection and recovery through the running service: status, board, item, questions.

import path from "node:path";

import { loadConfig } from "../../config/load";
import { BUILD, versionLine } from "../../version";
import { CliError, EXIT } from "../args";
import { positional, printJson, stringOption, type Command, type CommandContext } from "../command";
import { control, ServiceUnavailable } from "../control-client";

interface StatusPayload {
  version: { version: string; commit: string };
  pid: number;
  home: string;
  config: string;
  logs: string;
  database: string;
  dashboardUrl: string;
  startedAt: string;
  supervised: boolean;
  configHash: string;
  ready: boolean;
  draining: { since: string; reason: string } | null;
  runners: { limit: number; busy: number };
  active: Array<{ item: string; stage: string }>;
  steering: number;
  stopped: Array<{ item: string; title: string; stage: string | null; state: string | null; reason: string | null }>;
  openQuestions: number;
}

/** Kilobytes used under each path, by `du`; a missing path is skipped. */
export async function diskUsage(paths: Record<string, string>): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  for (const [name, target] of Object.entries(paths)) {
    const child = Bun.spawn(["du", "-sk", target], { stdout: "pipe", stderr: "ignore", timeout: 60_000 });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const kilobytes = Number(stdout.split(/\s/)[0]);
    if (code === 0 && Number.isFinite(kilobytes)) usage[name] = kilobytes * 1024;
  }
  return usage;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The state locations from the configuration, or the home layout when it does not load. */
export async function statePaths(context: CommandContext): Promise<{ state: string; logs: string; artifacts: string; worktrees: string; backups: string }> {
  const config = await loadConfig(context.paths.config, null, { home: context.paths.home }).catch(() => null);
  return {
    state: config ? path.dirname(config.settings.database) : context.paths.state,
    logs: config?.settings.logs ?? context.paths.logs,
    artifacts: config?.settings.artifacts ?? context.paths.artifacts,
    worktrees: config?.settings.workspaces ?? context.paths.worktrees,
    backups: context.paths.backups,
  };
}

export const status: Command = {
  name: "status",
  summary: "show versions, paths, dashboard URL, service health, capacity, stopped items and disk usage",
  async run(context) {
    let unreachable: string | undefined;
    const service = await control<StatusPayload>(context, "GET", "/v1/status").catch((error: unknown) => {
      if (!(error instanceof ServiceUnavailable)) throw error;
      unreachable = error.reason;
      return null;
    });
    const disk = await diskUsage(await statePaths(context));
    if (context.json) {
      printJson(context, { installed: BUILD, running: service !== null, service, disk });
      return service ? EXIT.ok : EXIT.unavailable;
    }
    const lines = [`Installed: ${versionLine()}`];
    if (!service) {
      lines.push(unreachable ? `Service: not reachable: ${unreachable}` : "Service: not running", `Home: ${context.paths.home}`, `Configuration: ${context.paths.config}`);
    } else {
      const health = service.draining ? `draining since ${service.draining.since} (${service.draining.reason})` : service.ready ? "ready" : "not ready (see conveyor logs)";
      lines.push(
        `Service: running ${service.version.version} (${service.version.commit.slice(0, 12)}), pid ${service.pid}, since ${service.startedAt}; ${health}`,
        `Dashboard: ${service.dashboardUrl}`,
        `Home: ${service.home}`,
        `Configuration: ${service.config} (${service.configHash.slice(0, 12)})`,
        `Logs: ${service.logs}`,
        `Runners: ${service.runners.busy} of ${service.runners.limit} busy${service.steering ? `, ${service.steering} steering run` : ""}`,
        ...service.active.map((entry) => `  running ${entry.item} ${entry.stage}`),
        `Stopped items: ${service.stopped.length}`,
        ...service.stopped.map((entry) => `  ${entry.item} ${entry.stage ?? "-"} ${entry.state}: ${entry.reason ?? entry.title}`),
        `Open questions: ${service.openQuestions}${service.openQuestions ? " (conveyor questions list)" : ""}`,
      );
    }
    lines.push(`Disk: ${Object.entries(disk).map(([name, bytes]) => `${name} ${formatBytes(bytes)}`).join(", ") || "nothing yet"}`);
    context.out(lines.join("\n"));
    return service ? EXIT.ok : EXIT.unavailable;
  },
};

interface BoardEntry { item: string; title: string; stage: string | null; state: string | null; warning: string | null; url: string }

export const board: Command = {
  name: "board",
  summary: "list the items Conveyor tracks with their stage and state",
  async run(context) {
    const entries = await control<BoardEntry[]>(context, "GET", "/v1/board");
    if (context.json) return printJson(context, entries);
    if (entries.length === 0) return context.out("No items.");
    const width = Math.max(...entries.map((entry) => entry.item.length));
    context.out(entries.map((entry) =>
      `${entry.item.padEnd(width)}  ${(entry.stage ?? "-").padEnd(14)} ${(entry.state ?? "-").padEnd(18)} ${entry.title}${entry.warning ? `\n${" ".repeat(width + 2)}! ${entry.warning}` : ""}`,
    ).join("\n"));
  },
};

const itemPath = (context: CommandContext, suffix = "") => `/v1/items/${encodeURIComponent(positional(context, 0, "item (for example conveyor:90)"))}${suffix}`;

interface ItemPayload {
  item: string; title: string; url: string; stage: string | null; state: string | null; since: string | null;
  blocker: string | null; warning: string | null; paused: boolean;
  question: { id: string; prompt: string; options: unknown[] } | null;
  actions: string[];
}

export const itemShow: Command = {
  name: "item show",
  usage: "<item>",
  summary: "explain an item's stage, its concrete blocker and the recovery actions available",
  async run(context) {
    const item = await control<ItemPayload>(context, "GET", itemPath(context));
    if (context.json) return printJson(context, item);
    context.out([
      `${item.item}: ${item.title}`,
      `  ${item.url}`,
      `Stage: ${item.stage ?? "-"}   State: ${item.paused ? "paused" : item.state ?? "-"}${item.since ? `   Since: ${item.since}` : ""}`,
      ...(item.blocker ? [`Blocker: ${item.blocker}`] : []),
      ...(item.warning && item.warning !== item.blocker ? [`Warning: ${item.warning}`] : []),
      ...(item.question ? [`Question ${item.question.id}: ${item.question.prompt}`] : []),
      item.actions.length > 0 ? "Actions:" : "No recovery action applies.",
      ...item.actions.map((action) => `  - ${action}`),
    ].join("\n"));
  },
};

interface Transition { fromStage: string | null; toStage: string | null; kind: string; status: string; resultStatus: string | null; reason: string | null; actor: string; createdAt: string }

export const itemHistory: Command = {
  name: "item history",
  usage: "<item>",
  summary: "list an item's stage transitions, oldest first",
  async run(context) {
    const history = await control<{ item: string; transitions: Transition[] }>(context, "GET", itemPath(context, "/history"));
    if (context.json) return printJson(context, history);
    if (history.transitions.length === 0) return context.out(`${history.item} has no transitions yet.`);
    context.out(history.transitions.map((entry) =>
      `${entry.createdAt}  ${entry.kind.padEnd(10)} ${entry.fromStage ?? "-"} -> ${entry.toStage ?? "-"}  ${entry.resultStatus ?? entry.status}  ${entry.actor}${entry.reason ? `\n    ${entry.reason}` : ""}`,
    ).join("\n"));
  },
};

interface RunEvent { id: number; runId: string; stageId: string; kind: string; type: string; payload: unknown; createdAt: string }

/** A one-line summary of a run event's payload. */
export function eventText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["text", "message", "summary", "reason"]) if (typeof record[key] === "string") return record[key] as string;
  }
  const text = JSON.stringify(payload);
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

export const itemLogs: Command = {
  name: "item logs",
  usage: "<item>",
  summary: "print an item's run history (agent events, tool calls, checks), optionally following it",
  options: { follow: { type: "boolean", description: "keep printing new events until interrupted" } },
  async run(context) {
    let after = 0;
    const print = (events: RunEvent[]) => {
      for (const event of events) {
        context.out(context.json ? JSON.stringify(event) : `${event.createdAt} [${event.stageId}/${event.kind}] ${event.type}: ${eventText(event.payload)}`);
        after = event.id;
      }
    };
    for (;;) {
      const page = await control<{ events: RunEvent[] }>(context, "GET", `${itemPath(context, "/logs")}?after=${after}`);
      print(page.events);
      if (page.events.length === 500) continue;
      if (!context.options.follow) return;
      await Bun.sleep(1_000);
    }
  },
};

export const itemRetry: Command = {
  name: "item retry",
  usage: "<item>",
  summary: "retry a blocked, errored or needs-intervention item at its current stage",
  options: { note: { type: "string", value: "<text>", description: "a note added to the item's conversation" } },
  async run(context) {
    const result = await control<{ item: string; status: string; stageId: string }>(context, "POST", itemPath(context, "/retry"), { note: stringOption(context, "note") ?? "" });
    if (context.json) return printJson(context, result);
    context.out(`${result.item}: ${result.stageId} ${result.status === "started" ? "started" : "queued (it starts when capacity and dependencies allow)"}.`);
  },
};

export const itemPause: Command = {
  name: "item pause",
  usage: "<item>",
  summary: "pause an item (removes its enrollment label; its stage and worktree are kept)",
  async run(context) {
    const result = await control<{ item: string; stageId: string | null }>(context, "POST", itemPath(context, "/pause"));
    if (context.json) return printJson(context, result);
    context.out(`${result.item} paused${result.stageId ? ` at ${result.stageId}` : ""}.`);
  },
};

export const itemResume: Command = {
  name: "item resume",
  usage: "<item>",
  summary: "resume a paused item",
  async run(context) {
    const result = await control<{ item: string; status: string; stageId: string | null }>(context, "POST", itemPath(context, "/resume"));
    if (context.json) return printJson(context, result);
    context.out(`${result.item} resumed; ${result.stageId ?? "its stage"} ${result.status}.`);
  },
};

interface Question { id: string; item: string; prompt: string; reason: string; options: unknown[]; allowFreeText: boolean; createdAt: string }

export const questionsList: Command = {
  name: "questions list",
  summary: "list the open questions agents asked",
  async run(context) {
    const questions = await control<Question[]>(context, "GET", "/v1/questions");
    if (context.json) return printJson(context, questions);
    if (questions.length === 0) return context.out("No open questions.");
    context.out(questions.map((question) => [
      `${question.id}  ${question.item}  (${question.createdAt})`,
      `  ${question.prompt}`,
      ...(question.options.length > 0 ? [`  options: ${question.options.map((option) => typeof option === "string" ? option : JSON.stringify(option)).join(" | ")}`] : []),
    ].join("\n")).join("\n\n"));
  },
};

export const questionsAnswer: Command = {
  name: "questions answer",
  usage: "<question-id> <answer...>",
  summary: "answer an open question; the item continues where it stopped",
  async run(context) {
    const id = positional(context, 0, "question id");
    const answer = context.positionals.slice(1).join(" ").trim();
    if (!answer) throw new CliError("missing the answer", EXIT.usage);
    const result = await control<{ answered: string; item: string }>(context, "POST", `/v1/questions/${encodeURIComponent(id)}/answer`, { answer });
    if (context.json) return printJson(context, result);
    context.out(`Answered ${result.answered} for ${result.item}.`);
  },
};
