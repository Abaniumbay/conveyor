// The one entry point for agent tool calls arriving over MCP. The MCP server filters tools by
// the grant first; this enforces it again, then validates input, actor and preconditions, and
// journals mutating calls by run, tool and input so a retried call returns the stored response.

import { createHash } from "node:crypto";

import type { ConveyorStore } from "../db/store";
import { canonicalToolName } from "./aliases";
import type { AgentActor } from "./agent-support";
import { runTask, TaskInputError, type TaskRegistry } from "./contract";
import type { TaskDeps } from "./deps";
import { OPERATOR_STEERING_TOOLS } from "./operator";

export interface ToolGrant {
  runId: string;
  stageId: string;
  /** False for a system-scoped (steering) grant, which has no item. */
  issueScoped: boolean;
  actor: AgentActor | null;
  /** Canonical tool names. */
  tasks: ReadonlySet<string>;
}

export interface DispatchEnv {
  registry: TaskRegistry;
  deps: () => TaskDeps;
  /** The head SHA of the item's live change request, or null when it has none. */
  liveHeadSha: () => Promise<string | null>;
  store: Pick<ConveyorStore, "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation">;
}

/** The only tools that work without an item (the steering grant). */
const ITEM_FREE_TOOLS: ReadonlySet<string> = new Set([
  "agent.reportProgress",
  "agent.reportRationale",
  "agent.reportBlocker",
  "agent.reportResult",
  "agent.reportMilestone",
  "agent.recordArtifact",
  ...OPERATOR_STEERING_TOOLS,
]);

export async function dispatchTool(
  call: { name: string; input: unknown; actor: AgentActor | null; grant: ToolGrant },
  env: DispatchEnv,
): Promise<unknown> {
  const name = canonicalToolName(call.name);
  const { grant } = call;
  if (!grant.tasks.has(name)) throw new Error(`MCP tool is not granted: ${name}`);
  const definition = env.registry.get(name);
  if (!definition || definition.kind !== "tool") throw new Error(`Unknown MCP tool: ${name}`);

  const parsed = definition.input!.safeParse(call.input ?? {});
  if (!parsed.success) throw new TaskInputError(name, parsed.error.message);
  const input: unknown = parsed.data;

  if (!grant.issueScoped && !ITEM_FREE_TOOLS.has(name)) throw new Error(`${name} requires an issue-scoped MCP grant`);
  if (grant.issueScoped && OPERATOR_STEERING_TOOLS.has(name)) {
    throw new Error(`${name} requires an active steering MCP grant`);
  }
  if (grant.issueScoped && !call.actor) throw new Error(`${name} requires an actor`);

  const headSha = (input as { headSha?: unknown }).headSha;
  if (typeof headSha === "string") {
    const live = await env.liveHeadSha();
    if (live === null) throw new Error(`${name}: the item has no change request to check headSha ${headSha} against`);
    if (live !== headSha) throw new Error(`${name}: headSha ${headSha} is not the current change head ${live}; read change.get and retry`);
  }

  const mutating = definition.mutating === true && definition.journal !== false;
  // A client retry is a new request, so the key is the call's content, not a transport id.
  const idempotencyKey = mutating
    ? `mcp:${grant.runId}:${name}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`
    : "";

  const execute = async (): Promise<unknown> => {
    const deps = env.deps();
    deps.run = { id: grant.runId, actor: call.actor };
    const result = await runTask(definition, {
      config: {},
      context: {},
      deps,
      input,
      ...(call.actor ? { actor: call.actor.id } : {}),
      instance: { id: name, stage: grant.stageId, idempotencyKey, resumed: false },
    });
    if (result.status === "fail" || result.status === "pending") throw new Error(result.message);
    return result.output ?? { accepted: true };
  };

  if (!mutating) return execute();

  const mutation = env.store.beginSourceMutation({ idempotencyKey, source: "mcp", operation: name, request: input });
  if (mutation.status === "succeeded") return mutation.response ?? { accepted: true };
  try {
    const result = await execute();
    env.store.completeSourceMutation(mutation.id, result);
    return result;
  } catch (error) {
    env.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
