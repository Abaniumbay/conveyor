import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";

/** Whether this stage runs entirely in-process and therefore consumes no runner permits. */
export function isLightweightRepositoryStage(config: ConveyorConfig, repositoryId: string, stageId: string): boolean {
  const repository = config.repositories[repositoryId];
  const stage = repository
    ? config.pipelines[repository.pipeline]?.stages.find((candidate) => candidate.id === stageId)
    : undefined;
  if (!stage) return false;
  if (isNativeStage(stage)) {
    return ![...stage.actions, ...(stage.exitGate ?? [])].some((entry) => /^(agent|script)\.run$/.test(entry.task));
  }
  // Older in-process fixtures may hold a partially normalised stage. Treat it as
  // permit-consuming until configuration loading has supplied its legacy run contract.
  if (!("run" in stage)) return false;
  return stage.run.type === "source-action" && !stage.enterCheck && !stage.exitCheck;
}
