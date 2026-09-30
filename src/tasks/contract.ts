import type { ZodType } from "zod";
import {
  CAPTURED_KEYS,
  SNAPSHOT_KEYS,
  type CapturedKey,
  type ContextKey,
  type SnapshotKey,
  type TaskContext,
} from "./context";

export type TaskKind = "load" | "check" | "act" | "tool";

export type Route = { retry: true } | { return: string } | { stop: string };

export type TaskResult =
  | { status: "pass"; output?: unknown }
  | { status: "pending"; message: string; after?: number }
  | { status: "fail"; message: string; details?: unknown; route?: Route };

export function pass(output?: unknown): TaskResult {
  return output === undefined ? { status: "pass" } : { status: "pass", output };
}

export function pending(message: string, options: { after?: number } = {}): TaskResult {
  return options.after === undefined
    ? { status: "pending", message }
    : { status: "pending", message, after: options.after };
}

export function fail(message: string, options: { details?: unknown; route?: Route } = {}): TaskResult {
  const result: TaskResult = { status: "fail", message };
  if (options.details !== undefined) result.details = options.details;
  if (options.route !== undefined) result.route = options.route;
  return result;
}

/** Thrown by tasks for anything that is not a domain failure. */
export class InfrastructureError extends Error {
  readonly usageLimit?: boolean;
  constructor(message: string, options: { usageLimit?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InfrastructureError";
    if (options.usageLimit !== undefined) this.usageLimit = options.usageLimit;
  }
}

export class TaskConfigError extends Error {
  constructor(readonly task: string, message: string) {
    super(`Invalid configuration for task ${task}: ${message}`);
    this.name = "TaskConfigError";
  }
}

export class TaskInputError extends Error {
  constructor(readonly task: string, message: string) {
    super(`Invalid input for task ${task}: ${message}`);
    this.name = "TaskInputError";
  }
}

export class InvalidTaskResultError extends Error {
  constructor(readonly task: string, detail: string) {
    super(`Task ${task} returned an invalid result: ${detail}`);
    this.name = "InvalidTaskResultError";
  }
}

export interface TaskArgs<C = unknown, I = unknown, D = unknown> {
  context: Partial<TaskContext>;
  config: C;
  deps: D;
  instance: { id: string; stage: string; idempotencyKey: string; resumed: boolean };
  input?: I;
  actor?: string;
}

export interface TaskDefinition<C = unknown, I = unknown, D = unknown> {
  name: string;
  kind: TaskKind;
  description: string;
  reads: ContextKey[];
  writes: ContextKey[];
  invalidates: SnapshotKey[];
  /** Validates the stage `with` block. */
  config?: ZodType<C>;
  /** Validates tool input (tools only). */
  input?: ZodType<I>;
  defaultWait?: { timeoutMs: number | null; pollMs: number };
  checkpoint?: { name: "ciPassed" | "reviewPassed"; scope: "task" | "gate" };
  /** Tools only: whether the tool changes external state. */
  mutating?: boolean;
  run(args: TaskArgs<C, I, D>): TaskResult | Promise<TaskResult>;
}

export interface TaskGroup {
  name: string;
  definitions: TaskDefinition<any, any, any>[];
}

const isSnapshotKey = (key: string): key is SnapshotKey => (SNAPSHOT_KEYS as readonly string[]).includes(key);
const isCapturedKey = (key: string): key is CapturedKey => (CAPTURED_KEYS as readonly string[]).includes(key);

export function defineGroup(group: string, definitions: TaskDefinition<any, any, any>[]): TaskGroup {
  const pattern = new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-z][a-zA-Z0-9]*$`);
  for (const def of definitions) {
    const where = `Task ${def.name}`;
    if (!pattern.test(def.name)) {
      throw new Error(`Task name "${def.name}" must be ${group}.<camelCase>`);
    }
    if (def.kind === "tool" && !def.input) {
      throw new Error(`${where}: a tool must define an input schema`);
    }
    if (def.kind === "load") {
      if (def.writes.length !== 1) throw new Error(`${where}: a load must write exactly one snapshot key`);
      if (!isSnapshotKey(def.writes[0]!)) {
        throw new Error(`${where}: a load must write a snapshot key (${SNAPSHOT_KEYS.join(", ")})`);
      }
    }
    if (def.kind === "check" && (def.writes.length > 0 || def.invalidates.length > 0)) {
      throw new Error(`${where}: a check must not write or invalidate anything`);
    }
    if (def.kind === "act") {
      const bad = def.writes.filter((key) => !isCapturedKey(key));
      if (bad.length > 0) {
        throw new Error(`${where}: an act may write only captured keys (${CAPTURED_KEYS.join(", ")}), not ${bad.join(", ")}`);
      }
    }
  }
  return { name: group, definitions };
}

export class TaskRegistry {
  private readonly byName = new Map<string, TaskDefinition<any, any, any>>();
  private readonly loaders = new Map<SnapshotKey, TaskDefinition<any, any, any>>();

  register(group: TaskGroup): void {
    for (const def of group.definitions) {
      if (this.byName.has(def.name)) throw new Error(`Duplicate task name ${def.name}`);
      if (def.kind === "load") {
        const key = def.writes[0] as SnapshotKey;
        const existing = this.loaders.get(key);
        if (existing) throw new Error(`Two loaders for ${key}: ${existing.name} and ${def.name}`);
        this.loaders.set(key, def);
      }
      this.byName.set(def.name, def);
    }
  }

  get(name: string): TaskDefinition<any, any, any> | undefined {
    return this.byName.get(name);
  }

  require(name: string): TaskDefinition<any, any, any> {
    const def = this.byName.get(name);
    if (!def) throw new Error(`Unknown task ${name}`);
    return def;
  }

  list(kind?: TaskKind): TaskDefinition<any, any, any>[] {
    const all = [...this.byName.values()];
    return kind ? all.filter((def) => def.kind === kind) : all;
  }

  loaderFor(key: SnapshotKey): TaskDefinition<any, any, any> | undefined {
    return this.loaders.get(key);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateResult(task: string, result: unknown): TaskResult {
  const bad = (detail: string) => new InvalidTaskResultError(task, detail);
  if (!result || typeof result !== "object") throw bad("not an object");
  const r = result as Record<string, unknown>;
  if (r.status === "pass") return result as TaskResult;
  if (r.status === "pending") {
    if (typeof r.message !== "string") throw bad("pending needs a message");
    if (r.after !== undefined && typeof r.after !== "number") throw bad("pending.after must be a number");
    return result as TaskResult;
  }
  if (r.status === "fail") {
    if (typeof r.message !== "string") throw bad("fail needs a message");
    if (r.route !== undefined) {
      const route = r.route as Record<string, unknown> | null;
      const ok =
        !!route &&
        typeof route === "object" &&
        ((route.retry === true && Object.keys(route).length === 1) ||
          (typeof route.return === "string" && Object.keys(route).length === 1) ||
          (typeof route.stop === "string" && Object.keys(route).length === 1));
      if (!ok) throw bad("fail.route must be { retry: true }, { return } or { stop }");
    }
    return result as TaskResult;
  }
  throw bad(`unknown status ${String(r.status)}`);
}

/**
 * Runs one task. Thrown errors propagate unchanged and are infrastructure
 * errors; domain outcomes are returned as a TaskResult.
 */
export async function runTask<C, I, D>(
  definition: TaskDefinition<C, I, D>,
  args: TaskArgs<unknown, I, D>,
): Promise<TaskResult> {
  let config = args.config as C;
  if (definition.config) {
    const parsed = definition.config.safeParse(args.config ?? {});
    if (!parsed.success) throw new TaskConfigError(definition.name, parsed.error.message);
    config = parsed.data;
  }
  let input = args.input;
  if (definition.input) {
    const parsed = definition.input.safeParse(args.input ?? {});
    if (!parsed.success) throw new TaskInputError(definition.name, parsed.error.message);
    input = parsed.data;
  }
  const source = args.context as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of definition.reads) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  const context = deepFreeze(structuredClone(picked)) as Partial<TaskContext>;
  const isCheck = definition.kind === "check";
  const result = await definition.run({
    ...args,
    ...(input === undefined ? {} : { input }),
    context,
    config,
    deps: (isCheck ? undefined : args.deps) as D,
    instance: isCheck ? { ...args.instance, idempotencyKey: "" } : args.instance,
  });
  return validateResult(definition.name, result);
}
