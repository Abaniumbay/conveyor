import { isNativeStage, type ConveyorConfigData, type NativeStageConfig, type TaskEntryConfig, type TaskOverrideConfig } from "../config/schema";
import { CAPTURED_KEYS, SNAPSHOT_KEYS, type CapturedKey, type SnapshotKey } from "./context";
import type { Route, TaskKind, TaskRegistry } from "./contract";
import { translateLegacyStage } from "./legacy";

export { renderPlan } from "./render-plan";

export interface CompiledWait {
  timeoutMs: number | null;
  pollMs: number;
}

export interface CompiledTask {
  id: string;
  task: string;
  kind: TaskKind;
  with: Record<string, unknown>;
  /** Short human description shown by renderPlan in place of `with` (legacy tasks). */
  label?: string;
  wait: CompiledWait;
  /** null = the list's default (exit gate: retry; actions: stop blocked). */
  onFail: Route | null;
  reads: string[];
  writes: string[];
  invalidates: SnapshotKey[];
  implicitLoads: SnapshotKey[];
}

export interface CompiledStage {
  id: string;
  concurrency: number;
  retries: number;
  childrenStartAt: string | null;
  legacy: boolean;
  actions: CompiledTask[];
  exitGate: CompiledTask[];
}

export interface CompiledPipeline {
  id: string;
  repositoryId: string;
  stages: CompiledStage[];
}

export class PlanError extends Error {
  override readonly name = "PlanError";

  constructor(
    readonly repositoryId: string,
    readonly errors: string[],
  ) {
    super([`invalid task plan for repository "${repositoryId}":`, ...errors.map((error) => `- ${error}`)].join("\n"));
  }
}

type ListName = "actions" | "exit-gate";
type Guard = NonNullable<TaskEntryConfig["when"]>;

const isSnapshotKey = (key: string): key is SnapshotKey => (SNAPSHOT_KEYS as readonly string[]).includes(key);
const isCapturedKey = (key: string): key is CapturedKey => (CAPTURED_KEYS as readonly string[]).includes(key);

function guardHolds(guard: Guard | undefined, mode: "required" | "advisory" | "disabled"): boolean {
  if (guard === undefined) return true;
  if (guard === "ci.enabled") return mode !== "disabled";
  if (guard === "ci.required") return mode === "required";
  return mode === "advisory";
}

export function compilePipeline(input: {
  config: ConveyorConfigData;
  repositoryId: string;
  registry: TaskRegistry;
}): CompiledPipeline {
  const { config, repositoryId, registry } = input;
  const repository = config.repositories[repositoryId];
  if (!repository) throw new PlanError(repositoryId, [`unknown repository "${repositoryId}"`]);
  const pipeline = config.pipelines[repository.pipeline];
  if (!pipeline) throw new PlanError(repositoryId, [`unknown pipeline "${repository.pipeline}"`]);

  const errors: string[] = [];
  const stages: CompiledStage[] = [];
  const stageIds = pipeline.stages.map((stage) => stage.id);
  const overrides = repository.overrides?.stages ?? {};
  for (const stageId of Object.keys(overrides)) {
    if (!stageIds.includes(stageId)) {
      errors.push(`repositories.${repositoryId}.overrides.stages: unknown stage "${stageId}"`);
    }
  }

  for (const [index, stage] of pipeline.stages.entries()) {
    const prefix = `pipelines.${repository.pipeline}.stages[${index}]`;
    if (!isNativeStage(stage)) {
      const compiled = translateLegacyStage(stage, {
        successStatuses: pipeline.successStatuses ?? [],
        failureStatuses: pipeline.failureStatuses ?? [],
        stages: pipeline.stages,
        feedbackCycles: config.settings.feedbackCycles,
      });
      for (const task of [...compiled.actions, ...compiled.exitGate]) {
        if (!registry.get(task.task)) errors.push(`${prefix}: legacy stage "${stage.id}" needs task "${task.task}", which is not registered`);
      }
      stages.push(compiled);
      continue;
    }
    stages.push(compileStage({ config, repositoryId, registry, stage, prefix, stageIds, errors }));
  }

  if (errors.length > 0) throw new PlanError(repositoryId, errors);
  return { id: repository.pipeline, repositoryId, stages };
}

/** Compiles every repository; legacy stages go through the compatibility translator. */
export function compileRepositories(config: ConveyorConfigData, registry: TaskRegistry): CompiledPipeline[] {
  const plans: CompiledPipeline[] = [];
  for (const [repositoryId, repository] of Object.entries(config.repositories)) {
    const pipeline = config.pipelines[repository.pipeline];
    if (!pipeline) continue;
    plans.push(compilePipeline({ config, repositoryId, registry }));
  }
  return plans;
}

interface StageInput {
  config: ConveyorConfigData;
  repositoryId: string;
  registry: TaskRegistry;
  stage: NativeStageConfig;
  prefix: string;
  stageIds: string[];
  errors: string[];
}

interface Entry {
  path: string;
  id: string;
  config: TaskEntryConfig;
}

function instanceIds(list: TaskEntryConfig[], listPath: string, seen: Set<string>, errors: string[]): Entry[] {
  const counts = new Map<string, number>();
  for (const entry of list) counts.set(entry.task, (counts.get(entry.task) ?? 0) + 1);
  return list.map((config, index) => {
    const path = `${listPath}[${index}]`;
    const id = config.id ?? config.task;
    const ambiguous = config.id === undefined && (counts.get(config.task) ?? 0) > 1;
    if (ambiguous) {
      errors.push(`${path}: task "${config.task}" occurs more than once and needs an explicit id`);
    } else if (seen.has(id)) {
      errors.push(`${path}: duplicate instance id "${id}" in stage`);
    }
    seen.add(id);
    return { path, id, config };
  });
}

function compileStage(input: StageInput): CompiledStage {
  const { config, repositoryId, registry, stage, prefix, stageIds, errors } = input;
  const repository = config.repositories[repositoryId]!;
  const mode = repository.ci.mode;
  const stageOverrides = repository.overrides?.stages?.[stage.id];

  const seenIds = new Set<string>();
  const lists: Record<ListName, Entry[]> = {
    actions: instanceIds(stage.actions, `${prefix}.actions`, seenIds, errors),
    "exit-gate": instanceIds(stage.exitGate, `${prefix}.exit-gate`, seenIds, errors),
  };

  const overrideFor = new Map<string, TaskOverrideConfig>();
  const overrideGroups: Array<[ListName, Record<string, TaskOverrideConfig> | undefined]> = [
    ["actions", stageOverrides?.actions],
    ["exit-gate", stageOverrides?.exitGate],
  ];
  for (const [list, group] of overrideGroups) {
    for (const [instance, override] of Object.entries(group ?? {})) {
      if (lists[list].some((entry) => entry.id === instance)) overrideFor.set(`${list}:${instance}`, override);
      else {
        errors.push(
          `repositories.${repositoryId}.overrides.stages.${stage.id}.${list}: unknown instance "${instance}"`,
        );
      }
    }
  }

  const compiled: Record<ListName, CompiledTask[]> = { actions: [], "exit-gate": [] };
  for (const list of ["actions", "exit-gate"] as const) {
    for (const entry of lists[list]) {
      if (!guardHolds(entry.config.when, mode)) continue;
      const task = compileTask({ ...input, list, entry, override: overrideFor.get(`${list}:${entry.id}`) });
      if (task) compiled[list].push(task);
    }
  }
  if (compiled["exit-gate"].length === 0) {
    errors.push(`${prefix}.exit-gate is empty after guards for ci mode ${mode}`);
  }

  checkDataflow({ ...input, compiled, lists });

  return {
    id: stage.id,
    concurrency: stage.concurrency,
    retries: stage.retries,
    childrenStartAt: stage.childrenStartAt ?? null,
    legacy: false,
    actions: compiled.actions,
    exitGate: compiled["exit-gate"],
  };
}

function compileTask(
  input: StageInput & { list: ListName; entry: Entry; override: TaskOverrideConfig | undefined },
): CompiledTask | undefined {
  const { config, registry, stageIds, stage, errors, list, entry, override } = input;
  const { path } = entry;
  const definition = registry.get(entry.config.task);
  if (!definition) {
    errors.push(`${path}: unknown task "${entry.config.task}"`);
    return undefined;
  }
  const expected: TaskKind = list === "actions" ? "act" : "check";
  if (definition.kind !== expected) {
    const why =
      definition.kind === "tool" || definition.kind === "load"
        ? `a ${definition.kind} task is never listed in a stage`
        : `${list} accept only ${expected} tasks`;
    errors.push(`${path}: task "${definition.name}" is a ${definition.kind}; ${why}`);
    return undefined;
  }

  const withValue = (override?.with ?? entry.config.with ?? {}) as Record<string, unknown>;
  if (definition.config) {
    const parsed = definition.config.safeParse(withValue);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "with"}: ${issue.message}`).join("; ");
      errors.push(`${path}: invalid with for ${definition.name}: ${detail}`);
    }
  }

  const defaults = config.settings.taskDefaults.wait;
  const entryWait = { ...entry.config.wait, ...override?.wait };
  const wait: CompiledWait = {
    timeoutMs: entryWait.timeoutMs !== undefined ? entryWait.timeoutMs : definition.defaultWait ? definition.defaultWait.timeoutMs : defaults.timeoutMs,
    pollMs: entryWait.pollMs ?? definition.defaultWait?.pollMs ?? defaults.pollMs,
  };

  const onFail = override?.onFail ?? entry.config.onFail ?? null;
  if (onFail && "return" in onFail) {
    if (onFail.return === stage.id) errors.push(`${path}: onFail.return must name another stage, not "${stage.id}"`);
    else if (!stageIds.includes(onFail.return)) errors.push(`${path}: onFail.return names unknown stage "${onFail.return}"`);
  }
  if (onFail && "stop" in onFail && !(onFail.stop in config.labels.states)) {
    errors.push(`${path}: onFail.stop names "${onFail.stop}", which is not a configured labels.states key`);
  }

  return {
    id: entry.id,
    task: definition.name,
    kind: definition.kind,
    with: withValue,
    wait,
    onFail,
    reads: [...definition.reads],
    writes: [...definition.writes],
    invalidates: [...definition.invalidates],
    implicitLoads: [],
  };
}

function checkDataflow(
  input: StageInput & {
    compiled: Record<ListName, CompiledTask[]>;
    lists: Record<ListName, Entry[]>;
  },
): void {
  const { registry, errors, compiled, lists } = input;
  const pathOf = (list: ListName, task: CompiledTask) =>
    lists[list].find((entry) => entry.id === task.id)?.path ?? input.prefix;

  const produced = new Set<string>();
  for (const list of ["actions", "exit-gate"] as const) {
    // The exit gate re-evaluates with fresh loads, so nothing counts as loaded.
    const loaded = new Set<SnapshotKey>();
    const reportedMissing = new Set<SnapshotKey>();
    for (const task of compiled[list]) {
      const where = pathOf(list, task);
      for (const key of task.reads) {
        if (isSnapshotKey(key)) {
          if (loaded.has(key)) continue;
          if (!registry.loaderFor(key)) {
            if (!reportedMissing.has(key)) {
              reportedMissing.add(key);
              errors.push(`${where}: ${task.task} reads ${key} but no loader is registered for it`);
            }
            continue;
          }
          loaded.add(key);
          task.implicitLoads.push(key);
        } else if (isCapturedKey(key) && !produced.has(key)) {
          errors.push(`${where}: ${task.task} reads ${key} but no earlier act in this stage's actions writes it`);
        }
      }
      if (task.task === "script.succeeded") {
        const run = task.with.run;
        const target = typeof run === "string" ? compiled.actions.find((candidate) => candidate.id === run) : undefined;
        if (typeof run === "string" && target?.task !== "script.run") {
          errors.push(`${where}: with.run "${run}" must name a script.run instance in this stage's actions`);
        }
      }
      for (const key of task.invalidates) loaded.delete(key);
      if (list === "actions") {
        for (const key of task.writes) produced.add(key);
      }
    }
  }
}
