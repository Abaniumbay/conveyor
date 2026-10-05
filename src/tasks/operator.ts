// The deliberately small MCP surface for an owner-started Conveyor steering run.  These tools are
// registered like every other MCP task so grants, validation, idempotency and durable source-mutation
// journalling stay in the common dispatcher rather than becoming a second control plane.

import { z } from "zod";

import { defineGroup, pass, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

const emptyInput = z.object({}).strict();
const historyInput = z.object({
  itemId: z.string().min(1),
  beforeRunId: z.string().min(1).optional(),
  eventRunId: z.string().min(1).optional(),
  beforeEventSequence: z.number().int().positive().optional(),
  runLimit: z.number().int().min(1).max(20).default(5),
  eventLimit: z.number().int().min(1).max(100).default(20),
}).strict().superRefine((input, context) => {
  if (input.beforeEventSequence !== undefined && !input.eventRunId) {
    context.addIssue({ code: "custom", path: ["eventRunId"], message: "is required when continuing an event page" });
  }
});
const retryInput = z.object({
  itemId: z.string().min(1),
  note: z.string().max(4_000).default(""),
}).strict();
const moveInput = z.object({
  itemId: z.string().min(1),
  position: z.enum(["up", "down", "before", "end"]),
  beforeItemId: z.string().min(1).optional(),
}).strict().superRefine((input, context) => {
  if (input.position === "before" && !input.beforeItemId) {
    context.addIssue({ code: "custom", path: ["beforeItemId"], message: "is required when position is before" });
  }
  if (input.position !== "before" && input.beforeItemId) {
    context.addIssue({ code: "custom", path: ["beforeItemId"], message: "is only valid when position is before" });
  }
  if (input.itemId === input.beforeItemId) {
    context.addIssue({ code: "custom", path: ["beforeItemId"], message: "must name a different backlog item" });
  }
});

type Deps = TaskDeps;

function operator(deps: Deps): NonNullable<Deps["operator"]> {
  if (!deps.operator) throw new Error("operator tools require an active steering run");
  return deps.operator;
}

function audit(deps: Deps, action: string, target: unknown, outcome: unknown): void {
  const steeringRunId = deps.run?.id;
  if (!steeringRunId) throw new Error("operator tools require a steering run");
  deps.store.appendRunEvent(steeringRunId, "operator.control", {
    steeringRunId,
    action,
    target,
    outcome,
  });
}

const board: TaskDefinition<unknown, z.infer<typeof emptyInput>, Deps> = {
  name: "operator.getBoard",
  kind: "tool",
  description: "Read the reconciled board, configured repository health, and item state without changing anything.",
  reads: [], writes: [], invalidates: [], input: emptyInput,
  run({ deps }) {
    return pass(operator(deps).board());
  },
};

const itemHistory: TaskDefinition<unknown, z.infer<typeof historyInput>, Deps> = {
  name: "operator.getItemHistory",
  kind: "tool",
  description: "Read a bounded, pageable diagnostic history for one configured board item.",
  reads: [], writes: [], invalidates: [], input: historyInput,
  async run({ deps, input }) {
    return pass(await operator(deps).itemHistory({
      itemId: input!.itemId,
      runLimit: input!.runLimit,
      eventLimit: input!.eventLimit,
      ...(input!.beforeRunId ? { beforeRunId: input!.beforeRunId } : {}),
      ...(input!.eventRunId ? { eventRunId: input!.eventRunId } : {}),
      ...(input!.beforeEventSequence ? { beforeEventSequence: input!.beforeEventSequence } : {}),
    }));
  },
};

const retry: TaskDefinition<unknown, z.infer<typeof retryInput>, Deps> = {
  name: "operator.retryItem",
  kind: "tool",
  description: "Retry an eligible stopped board item after the owner explicitly requests it.",
  reads: [], writes: [], invalidates: [], input: retryInput, mutating: true,
  async run({ deps, input }) {
    const outcome = await operator(deps).retry(input!.itemId, input!.note);
    const result = { issueId: input!.itemId, action: "retry", ...outcome };
    audit(deps, "retry", { issueId: input!.itemId }, result);
    return pass(result);
  },
};

const moveBacklog: TaskDefinition<unknown, z.infer<typeof moveInput>, Deps> = {
  name: "operator.moveBacklogItem",
  kind: "tool",
  description: "Move an eligible top-level backlog item up, down, before another item, or to the end.",
  reads: [], writes: [], invalidates: [], input: moveInput, mutating: true,
  run({ deps, input }) {
    const outcome = operator(deps).moveBacklog({
      itemId: input!.itemId,
      position: input!.position,
      ...(input!.beforeItemId ? { beforeItemId: input!.beforeItemId } : {}),
    });
    const result = { issueId: input!.itemId, action: "move-backlog", ...((outcome as object) ?? {}) };
    audit(deps, "move-backlog", {
      issueId: input!.itemId,
      position: input!.position,
      ...(input!.beforeItemId ? { beforeIssueId: input!.beforeItemId } : {}),
    }, result);
    return pass(result);
  },
};

export const OPERATOR_STEERING_TOOLS = new Set([
  "operator.getBoard",
  "operator.getItemHistory",
  "operator.retryItem",
  "operator.moveBacklogItem",
]);

export const operatorGroup = defineGroup("operator", [board, itemHistory, retry, moveBacklog]);
