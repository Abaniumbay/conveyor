import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { resolvePathEnvironment } from "../core/paths";

/**
 * A level's `settings.environment`: each variable's value, or `null` for the service's own value of
 * that variable when the run starts.
 */
export type EnvironmentSettings = Record<string, string | null>;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables Conveyor sets for every run itself. */
const CONVEYOR_SET = new Set(["HOME", "SHELL", "TMPDIR"]);

/** Why the configuration may not set this variable; undefined when it may. */
export function reservedVariable(name: string): string | undefined {
  if (CONVEYOR_SET.has(name) || name.startsWith("CONVEYOR_")) return "is set by Conveyor for every run";
  return undefined;
}

/** The root `settings.environment` when the configuration sets none: these variables, from the service. */
export const DEFAULT_RUN_ENVIRONMENT: Readonly<EnvironmentSettings> = Object.freeze({
  USER: null, LOGNAME: null, PATH: null, TERM: null, COLORTERM: null, LANG: null, LC_ALL: null,
  HTTP_PROXY: null, HTTPS_PROXY: null, NO_PROXY: null,
});

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
}

/** `settings.environment` at any level: names to values (`~/` expanded), an empty value taking the service's. */
export const environmentSettingsSchema = z
  .record(
    z.string().regex(VARIABLE_NAME, "must be an environment variable name"),
    z.union([z.string(), z.number(), z.boolean()]).transform((value) => expandHome(String(value))).nullable(),
  )
  .superRefine((environment, context) => {
    for (const name of Object.keys(environment)) {
      const reason = reservedVariable(name);
      if (reason) context.addIssue({ code: "custom", path: [name], message: `${name} ${reason}` });
    }
  });

/** One level of a run's environment, most general first. */
export interface EnvironmentLayer {
  readonly values: Readonly<EnvironmentSettings>;
  /** The harness's own level: what it sets reaches the harness program and never the commands it runs. */
  readonly program?: boolean;
}

export interface RunVariables {
  /** Every variable the run starts with, by name. */
  variables: Record<string, string>;
  /** The names whose winning definition is the harness's own level: removed before each command. */
  programVariables: string[];
}

/**
 * The run's variables from its levels, the last definition of a name winning. A `null` value takes the
 * service's value of that variable, and a variable the service does not have is not set. Nothing else
 * is added or removed: what a run sees is exactly what the configuration lists.
 */
export function resolveRunEnvironment(
  layers: readonly EnvironmentLayer[],
  service: Record<string, string | undefined> = process.env,
): RunVariables {
  const winners = new Map<string, { value: string | null; program: boolean }>();
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer.values)) winners.set(name, { value, program: layer.program === true });
  }
  const variables: Record<string, string> = {};
  const programVariables: string[] = [];
  for (const [name, { value, program }] of winners) {
    if (program) programVariables.push(name);
    const resolved = value ?? service[name];
    if (resolved !== undefined) variables[name] = resolved;
  }
  return { variables: resolvePathEnvironment(variables), programVariables };
}

/** The root default's variables from the service: what a run starts with when its caller names none. */
export function defaultRunVariables(service: Record<string, string | undefined> = process.env): Record<string, string> {
  return resolveRunEnvironment([{ values: DEFAULT_RUN_ENVIRONMENT }], service).variables;
}

/** What a run is part of, given to it as `CONVEYOR_*` variables: identifiers only. */
export interface RunContext {
  /** Absent for a script that runs before its run is recorded (a legacy check's evidence script). */
  runId?: string | undefined;
  repositoryId?: string | undefined;
  itemId?: string | undefined;
  stageId?: string | undefined;
  agentId?: string | undefined;
}

export function runContextVariables(context: RunContext): Record<string, string> {
  const variables: Record<string, string> = {};
  if (context.runId !== undefined) variables.CONVEYOR_RUN_ID = context.runId;
  if (context.repositoryId !== undefined) variables.CONVEYOR_REPOSITORY_ID = context.repositoryId;
  if (context.itemId !== undefined) variables.CONVEYOR_ITEM_ID = context.itemId;
  if (context.stageId !== undefined) variables.CONVEYOR_STAGE_ID = context.stageId;
  if (context.agentId !== undefined) variables.CONVEYOR_AGENT_ID = context.agentId;
  return variables;
}
