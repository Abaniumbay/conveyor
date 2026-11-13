import { DEFAULT_RUN_ENVIRONMENT, resolveRunEnvironment, runContextVariables, type EnvironmentLayer, type EnvironmentSettings, type RunContext } from "../isolation/run-environment";
import { isHarnessRunner, isNativeStage, type ConveyorConfigData } from "./schema";

type EnvironmentLevels = Pick<ConveyorConfigData, "settings" | "repositories" | "pipelines" | "runners" | "agents">;

/**
 * An agent run's `settings.environment` levels, most general first: the root, the repository, the
 * stage, the harness (whose variables reach its program only) and the agent.
 */
export function agentEnvironmentLayers(
  config: EnvironmentLevels,
  at: { repositoryId?: string | undefined; stageId?: string | undefined; agentId: string },
): EnvironmentLayer[] {
  const agent = config.agents?.[at.agentId];
  const runner = agent ? config.runners?.[agent.runner] : undefined;
  const layers = placeLayers(config, at);
  if (runner && isHarnessRunner(runner)) layers.push({ values: runner.environment ?? {}, program: true });
  if (agent) layers.push({ values: agent.environment ?? {} });
  return layers;
}

/** The levels every run shares, most general first: the root, the repository and the stage. */
function placeLayers(config: EnvironmentLevels, at: { repositoryId?: string | undefined; stageId?: string | undefined }): EnvironmentLayer[] {
  const repository = at.repositoryId === undefined ? undefined : config.repositories?.[at.repositoryId];
  const stage = repository && at.stageId !== undefined
    ? config.pipelines?.[repository.pipeline ?? ""]?.stages.find((candidate) => candidate.id === at.stageId)
    : undefined;
  // A configuration assembled in code rather than loaded may leave a level's settings out; its root is the default.
  const layers: EnvironmentLayer[] = [{ values: config.settings?.environment ?? DEFAULT_RUN_ENVIRONMENT }];
  if (repository) layers.push({ values: repository.settings?.environment ?? {} });
  if (stage && isNativeStage(stage)) layers.push({ values: stage.settings?.environment ?? {} });
  return layers;
}

/**
 * A script run's variables: the root's, the repository's, the stage's and the script step's
 * `settings.environment`, the run's `CONVEYOR_*` context, and the service's `HOME` and `TMPDIR`: a
 * script runs on the host as the service, so it keeps the service's home and temporary directory.
 */
export function scriptRunVariables(
  config: EnvironmentLevels,
  context: RunContext & { step?: Readonly<EnvironmentSettings> | undefined },
  service: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const layers = placeLayers(config, context);
  if (context.step) layers.push({ values: context.step });
  const { variables } = resolveRunEnvironment(layers, service);
  const host = Object.fromEntries((["HOME", "TMPDIR"] as const).flatMap((name) => (service[name] === undefined ? [] : [[name, service[name]!]])));
  return { ...variables, ...host, ...runContextVariables(context) };
}

/**
 * An agent run's variables: its levels resolved against the service (`null` values) plus its
 * `CONVEYOR_*` context, and the names that reach its harness program only.
 */
export function agentRunVariables(
  config: EnvironmentLevels,
  context: RunContext & { agentId: string },
  service: Record<string, string | undefined> = process.env,
): { env: Record<string, string>; programVariables: string[] } {
  const resolved = resolveRunEnvironment(agentEnvironmentLayers(config, context), service);
  return { env: { ...resolved.variables, ...runContextVariables(context) }, programVariables: resolved.programVariables };
}

/** The variables the commands of an agent run get: its variables without those for its program only. */
export function commandVariables(run: { env: Record<string, string>; programVariables: readonly string[] }): Record<string, string> {
  const program = new Set(run.programVariables);
  return Object.fromEntries(Object.entries(run.env).filter(([name]) => !program.has(name)));
}
