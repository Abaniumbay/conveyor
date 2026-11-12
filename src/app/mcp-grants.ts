// MCP grants (#676): the run-scoped grants agents reach Conveyor through. A grant is a random token
// written, with the run's scope, into a private context file the MCP server reads; it allows only
// its listed tools and ends when its lease closes. Each tool call goes through the task dispatcher,
// which enforces the grant and journals mutations.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import type { JournalStore } from "../db/ports";
import { withEventContext } from "../events/context";
import { log, type LogFields } from "../log/logger";
import { INTERNAL, selfCommand } from "../self";
import { withCallSource } from "../source/calls";
import { canonicalToolName } from "../tasks/aliases";
import { createTaskRegistry } from "../tasks/catalogue";
import type { TaskDeps, TaskStore } from "../tasks/deps";
import { dispatchTool } from "../tasks/dispatch";
import type { RuntimeIssueContext, ScopedMcpFactory, ScopedMcpLease } from "./runtime";

interface McpGrant {
  runId: string;
  stageId: string;
  context: RuntimeIssueContext | null;
  allowedTools: Set<string>;
  actor: { id: string; name: string; title: string } | null;
  /** Responses, including in-flight ones, keyed by the client's transport-retry token. */
  calls: Map<string, Promise<unknown>>;
  /** Set only for a stop-summary Operator run: the one item and stop it may record a summary for. */
  stopSummary?: { itemId: string; stopId: string };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function listenPort(listen: string): number {
  const separator = listen.lastIndexOf(":");
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid web listen address: ${listen}`);
  }
  return port;
}

/** The run-scoped MCP server: this executable's internal `__mcp` subcommand. */
function mcpServerCommand(contextFile: string): { command: string; args: string[] } {
  const [command, ...args] = selfCommand(INTERNAL.mcp, "--context", contextFile);
  return { command: command!, args };
}

export interface McpGrantsDeps {
  config: ConveyorConfig;
  store: TaskStore & Pick<JournalStore, "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation">;
  /** What an item-scoped grant's tools receive. */
  issueTaskDeps: (issueId: string, repository: TaskDeps["repository"]) => TaskDeps;
  /** The Operator tools a system-scoped (steering) grant's run may use. */
  operatorTools: (runId: string, stopSummary: { itemId: string; stopId: string } | undefined) => NonNullable<TaskDeps["operator"]>;
  /** Drops the cached reads of the item's change request. */
  forgetChange: (issueId: string, address: string) => void;
  /** The item's delivery state: its change request and checks. */
  loadDeliveryState: (issueId: string, address: string) => Promise<unknown>;
  updateStatusComment: (issueId: string) => Promise<void>;
  itemFields: (issueId: string) => LogFields;
}

/** The live MCP grants, their leases and the tool calls made with them. */
export class McpGrants {
  readonly #deps: McpGrantsDeps;
  readonly #grants = new Map<string, McpGrant>();

  constructor(deps: McpGrantsDeps) {
    this.#deps = deps;
  }

  /** Creates item-scoped grants for a stage's agents. */
  factory(): ScopedMcpFactory {
    return {
      create: async ({ runId, stageId, context, allowedTools, actor }) => {
        const token = randomBytes(32).toString("base64url");
        this.#grants.set(token, {
          runId,
          stageId,
          context,
          allowedTools: new Set(allowedTools.map(canonicalToolName)),
          actor,
          calls: new Map(),
        });
        return this.#lease(token, runId, {
          version: 1,
          runId,
          stageId,
          repository: {
            id: context.repository.id,
            address: context.repository.address,
            baseBranch: context.repository.baseBranch,
          },
          issue: {
            id: context.issue.id,
            number: context.issue.sourceNumber,
            title: context.issue.title,
            body: context.issue.body,
            labels: context.issue.labels,
            url: context.issue.sourceUrl,
          },
          workspace: context.workspace,
          delivery: context.delivery ?? { pullRequest: null, checks: [] },
          sourceGuidance: context.sourceGuidance,
        }, allowedTools);
      },
    };
  }

  /** A system-scoped grant for a steering or Operator run: no item, only the listed Operator tools. */
  async steeringLease(
    runId: string,
    workspace: string,
    allowedTools: readonly string[],
    stopSummary?: { itemId: string; stopId: string },
  ): Promise<ScopedMcpLease> {
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(token, {
      runId,
      stageId: "steering",
      context: null,
      allowedTools: new Set(allowedTools.map(canonicalToolName)),
      actor: null,
      calls: new Map(),
      ...(stopSummary ? { stopSummary } : {}),
    });
    const { web } = this.#deps.config;
    return this.#lease(token, runId, {
      version: 1,
      runId,
      stageId: "steering",
      repository: {
        id: "conveyor-system",
        address: "conveyor/system",
        baseBranch: "main",
      },
      issue: {
        id: `steering:${runId}`,
        number: 1,
        title: "Interactive Conveyor steering",
        body: "",
        labels: [],
        url: web.publicUrl ?? `http://127.0.0.1:${listenPort(web.listen)}/`,
      },
      workspace: { path: workspace, branch: "steering" },
      delivery: { pullRequest: null, checks: [] },
      sourceGuidance: "This is a system-scoped steering run. Only explicitly granted Operator diagnostic and control tools are available. Inspect before any control action.",
    }, allowedTools);
  }

  /** An MCP tool call: a thin wrapper over the task dispatcher, which enforces the grant and journals mutations. */
  async handle(payload: unknown, token: string, callId?: string): Promise<unknown> {
    const grant = this.#grants.get(token);
    if (!grant) throw new Error("expired MCP grant");
    if (callId) {
      const prior = grant.calls.get(callId);
      if (prior) return prior;
      const call = withEventContext({ actor: { kind: "agent", id: grant.runId } }, () => withCallSource("agent", () => this.#request(payload, grant)));
      grant.calls.set(callId, call);
      return call;
    }
    return withEventContext({ actor: { kind: "agent", id: grant.runId } }, () => withCallSource("agent", () => this.#request(payload, grant)));
  }

  /** Writes the grant's private context file and returns the lease that removes both. */
  async #lease(token: string, runId: string, scope: Record<string, unknown>, allowedTools: readonly string[]): Promise<ScopedMcpLease> {
    const { config } = this.#deps;
    const directory = path.join(config.settings.artifacts, runId);
    await mkdir(directory, { recursive: true });
    const contextFile = path.join(directory, "mcp-context.json");
    const port = listenPort(config.web.listen);
    await writeFile(contextFile, JSON.stringify({
      ...scope,
      control: { url: `http://127.0.0.1:${port}/internal/mcp`, token },
      allowedTools: [...new Set(allowedTools.map(canonicalToolName))],
    }), { mode: 0o600 });
    await chmod(contextFile, 0o600);
    return {
      configuration: mcpServerCommand(contextFile),
      close: async () => {
        this.#grants.delete(token);
        await rm(contextFile, { force: true });
      },
    };
  }

  async #request(payload: unknown, grant: McpGrant): Promise<unknown> {
    const { config, store } = this.#deps;
    const context = grant.context;
    // A system-scoped (steering) grant has no item: only explicitly allowed steering-safe tools are available.
    const operator = context ? null : this.#deps.operatorTools(grant.runId, grant.stopSummary);
    let tool = "unknown";
    try {
      const request = object(payload);
      tool = string(request.tool, "tool");
      // The MCP server adds its run scope to every input; the grant is authoritative, so drop it.
      const { runId: _run, stageId: _stage, repositoryId: _repository, issueId: _issue, ...input } = object(request.input ?? {});
      const taskDeps = (): TaskDeps => context
        ? this.#deps.issueTaskDeps(context.issue.id, context.repository)
        : ({ store, config, issueId: "", operator } as TaskDeps);
      const result = await dispatchTool({
        name: tool,
        input,
        actor: grant.actor,
        grant: {
          runId: grant.runId,
          stageId: grant.stageId,
          issueScoped: context !== null,
          actor: grant.actor,
          tasks: grant.allowedTools,
        },
      }, {
        registry: createTaskRegistry(),
        deps: taskDeps,
        liveHeadSha: async (options) => {
          if (!context) return null;
          if (options?.refresh) this.#deps.forgetChange(context.issue.id, context.repository.address);
          const state = await this.#deps.loadDeliveryState(context.issue.id, context.repository.address) as {
            change?: { headSha?: string } | null;
            pullRequest?: { headSha?: string } | null;
          };
          return state.change?.headSha ?? state.pullRequest?.headSha ?? null;
        },
        store,
      });
      if (context && canonicalToolName(tool) === "agent.askQuestion") {
        await this.#deps.updateStatusComment(context.issue.id);
      }
      return result;
    } catch (error) {
      if (context) log.warn("Issue MCP tool failed", { ...this.#deps.itemFields(context.issue.id), tool: canonicalToolName(tool) }, error);
      throw error;
    }
  }
}
