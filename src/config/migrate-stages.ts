// `conveyor config migrate --stages`: rewrites a configuration whose repositories use named
// pipelines so they follow one installation-wide `stages:` list. Differences between pipelines
// become per-repository `overrides` and `skip: true`. The result is written beside the original as
// `*.migrated.yaml`; the original is never touched.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap } from "yaml";

import type { TaskRegistry } from "../tasks/contract";
import { comparePlans } from "../tasks/compare-plans";
import { ConfigError } from "./errors";
import { loadConfig } from "./load";
import type { Plugin } from "../core/plugins";

type Json = Record<string, unknown>;

export interface StagesMigrationResult {
  /** The file written. */
  output: string;
  /** Per repository, the `config compare` text between the old and the new plan. */
  comparisons: Array<{ repository: string; identical: boolean; report: string }>;
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (left: unknown, right: unknown) => Bun.deepEquals(left, right, true);

function sectionMap(document: Document, name: string): YAMLMap {
  const node = document.get(name, true);
  if (node === undefined) throw new ConfigError(`--stages needs a "${name}" section`);
  if (!isMap(node) || node.tag?.startsWith("!")) {
    throw new ConfigError(`--stages cannot migrate "${name}": it must be written inline in the file (it is a ${String((node as { tag?: string }).tag ?? "non-map")} node)`);
  }
  return node;
}

function stageId(stage: Json): string {
  return String(stage.id);
}

/**
 * The merged order: a stable topological sort of every pipeline's adjacent-stage constraints, ties
 * broken by first appearance. Returns null when the pipelines' orders contradict each other.
 */
function mergeOrder(pipelines: Array<{ name: string; stages: Json[] }>): string[] | null {
  const seen: string[] = [];
  const after = new Map<string, Set<string>>();
  const before = new Map<string, number>();
  for (const { stages } of pipelines) {
    let previous: string | null = null;
    for (const stage of stages) {
      const id = stageId(stage);
      if (!seen.includes(id)) {
        seen.push(id);
        after.set(id, new Set());
        before.set(id, 0);
      }
      if (previous !== null && previous !== id && !after.get(previous)!.has(id)) {
        after.get(previous)!.add(id);
        before.set(id, before.get(id)! + 1);
      }
      previous = id;
    }
  }
  const merged: string[] = [];
  const remaining = new Set(seen);
  while (remaining.size > 0) {
    const next = seen.find((id) => remaining.has(id) && before.get(id) === 0);
    if (next === undefined) return null;
    remaining.delete(next);
    merged.push(next);
    for (const id of after.get(next)!) before.set(id, before.get(id)! - 1);
  }
  return merged;
}

function isSubsequence(ids: string[], merged: string[]): boolean {
  let position = 0;
  for (const id of ids) {
    position = merged.indexOf(id, position);
    if (position < 0) return false;
    position += 1;
  }
  return true;
}

const entryId = (entry: Json) => String(entry.id ?? entry.task);

/** The overrides that turn `base` into `stage`, or the reason it cannot be expressed as overrides. */
function stageOverrides(base: Json, stage: Json, label: string): Json {
  const result: Json = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(stage)]);
  for (const key of keys) {
    if (key === "actions" || key === "exit-gate") continue;
    if (!same(base[key], stage[key])) throw new ConfigError(`${label}: stage "${stageId(base)}" differs in "${key}", which an override cannot change`);
  }
  for (const list of ["actions", "exit-gate"] as const) {
    const left = (base[list] ?? []) as Json[];
    const right = (stage[list] ?? []) as Json[];
    const shape = (entries: Json[]) => entries.map((entry) => {
      const { with: _with, wait: _wait, onFail: _onFail, ...rest } = entry;
      return rest;
    });
    if (!same(shape(left), shape(right))) {
      throw new ConfigError(`${label}: stage "${stageId(base)}" ${list} differ in tasks, which an override cannot change (only with, wait and onFail)`);
    }
    for (const [index, entry] of left.entries()) {
      const other = right[index]!;
      const changed: Json = {};
      for (const field of ["with", "wait", "onFail"] as const) {
        if (same(entry[field], other[field])) continue;
        if (other[field] === undefined) throw new ConfigError(`${label}: stage "${stageId(base)}" ${list} task "${entryId(entry)}" drops "${field}", which an override cannot remove`);
        changed[field] = other[field];
      }
      if (Object.keys(changed).length > 0) {
        const group = (result[list] ??= {}) as Json;
        group[entryId(entry)] = changed;
      }
    }
  }
  return result;
}

/** Writes `value` under `at`, descending `depth` object levels, without replacing anything already there. */
function setMissing(node: YAMLMap, at: string[], value: unknown, depth: number): void {
  if (depth > 0 && isObject(value)) {
    for (const [key, child] of Object.entries(value)) setMissing(node, [...at, key], child, depth - 1);
    return;
  }
  if (!node.hasIn(at)) node.setIn(at, value);
}

export async function migrateStages(
  from: string,
  options: { home?: string; registry?: TaskRegistry | null; plugins?: readonly Plugin[] } = {},
): Promise<StagesMigrationResult> {
  const source = path.resolve(from);
  const text = await readFile(source, "utf8").catch(() => {
    throw new ConfigError(`${source} cannot be read; --stages migrates a configuration file`);
  });
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new ConfigError(`${source}: ${document.errors[0]!.message}`);
  if (!isMap(document.contents)) throw new ConfigError(`${source} is not a configuration file`);
  if (document.has("stages")) throw new ConfigError(`${source} already defines "stages"`);

  const pipelineMap = sectionMap(document, "pipelines");
  const repositoryMap = sectionMap(document, "repositories");
  visit(pipelineMap, {
    Node(_key, node) {
      if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag?.startsWith("!")) {
        throw new ConfigError(`--stages cannot migrate a pipeline that uses the ${node.tag} tag inside its stages; write the value inline first`);
      }
    },
  });
  const pipelines = new Map<string, Json[]>();
  for (const pair of pipelineMap.items) {
    const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
    const value = (pair.value as { toJSON?: () => unknown } | null)?.toJSON?.();
    const stages = isObject(value) ? value.stages : undefined;
    if (!Array.isArray(stages)) throw new ConfigError(`pipeline "${name}" has no stage list`);
    for (const stage of stages) {
      if (!isObject(stage) || "run" in stage) throw new ConfigError(`pipeline "${name}" stage "${isObject(stage) ? stageId(stage) : "?"}" is a legacy (run) stage; --stages migrates only actions and exit-gate stages`);
    }
    pipelines.set(name, stages as Json[]);
  }

  // Which pipeline each repository follows, in repository order.
  const repositories: Array<{ id: string; node: YAMLMap; pipeline: string }> = [];
  for (const pair of repositoryMap.items) {
    const id = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (!isMap(pair.value)) throw new ConfigError(`repository "${id}" must be written inline to migrate it`);
    const pipeline = pair.value.get("pipeline");
    if (typeof pipeline !== "string" || !pipelines.has(pipeline)) throw new ConfigError(`repository "${id}" does not name a defined pipeline`);
    repositories.push({ id, node: pair.value, pipeline });
  }
  if (repositories.length === 0) throw new ConfigError("there is no repository to migrate");

  const used: Array<{ name: string; stages: Json[] }> = [];
  for (const { pipeline } of repositories) {
    if (!used.some((entry) => entry.name === pipeline)) used.push({ name: pipeline, stages: pipelines.get(pipeline)! });
  }
  const merged = mergeOrder(used);
  if (merged === null || repositories.some(({ pipeline }) => !isSubsequence(pipelines.get(pipeline)!.map(stageId), merged))) {
    throw new ConfigError([
      "the pipelines order the same stages differently; reorder them to agree, then migrate again. Current stage order per repository:",
      ...repositories.map(({ id, pipeline }) => `  ${id} (pipeline ${pipeline}): ${pipelines.get(pipeline)!.map(stageId).join(", ")}`),
    ].join("\n"));
  }

  // The first pipeline that has a stage defines it.
  const definitions = new Map<string, Json>();
  for (const { stages } of used) for (const stage of stages) if (!definitions.has(stageId(stage))) definitions.set(stageId(stage), stage);

  // Compute every repository's changes before touching the document, so a failure leaves nothing half-built.
  const changes = repositories.map(({ id, pipeline }) => {
    const stages = pipelines.get(pipeline)!;
    const present = new Set(stages.map(stageId));
    const overrides: Array<[string, Json]> = [];
    for (const stage of stages) {
      const difference = stageOverrides(definitions.get(stageId(stage))!, stage, `repository "${id}"`);
      if (Object.keys(difference).length > 0) overrides.push([stageId(stage), difference]);
    }
    return { id, overrides, skipped: merged!.filter((stage) => !present.has(stage)) };
  });

  for (const [index, { node }] of repositories.entries()) {
    const change = changes[index]!;
    node.delete("pipeline");
    // The repository's own overrides apply on top of its pipeline, so they win over generated ones.
    for (const [stage, difference] of change.overrides) setMissing(node, ["overrides", "stages", stage], difference, 3);
    for (const stage of change.skipped) setMissing(node, ["overrides", "stages", stage], { skip: true }, 1);
  }
  const stagesNode = document.createNode(merged!.map((id) => definitions.get(id)));
  const pipelinesPair = (document.contents as YAMLMap).items.find((pair) => isScalar(pair.key) && pair.key.value === "pipelines")!;
  pipelinesPair.key = document.createNode("stages");
  pipelinesPair.value = stagesNode;
  if (!isSeq(stagesNode)) throw new ConfigError("internal: the stage list was not built");

  const parsed = path.parse(source);
  const output = path.join(parsed.dir, `${parsed.name}.migrated${parsed.ext || ".yaml"}`);
  const loadOptions = { ...(options.home ? { home: options.home } : {}), ...(options.plugins ? { plugins: options.plugins } : {}) };
  const old = await loadConfig(source, options.registry, loadOptions);
  await writeFile(output, document.toString({ lineWidth: 0 }));
  const migrated = await loadConfig(output, options.registry, loadOptions);

  const comparisons = repositories.map(({ id }) => {
    const left = old.plans.filter((plan) => plan.repositoryId === id);
    const right = migrated.plans.filter((plan) => plan.repositoryId === id);
    return {
      repository: id,
      identical: same(left, right),
      report: comparePlans(left, right, { left: `${source} (${id})`, right: `${output} (${id})` }),
    };
  });
  return { output, comparisons };
}
