// An item's stage transitions as people read them: from where to where, why, and who moved it. The
// CLI's `item history` and the dashboard's journey show the same list.

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import type { ItemStore, JournalStore } from "../db/ports";
import { displayName } from "../web/format";
import type { IssueJourneyTransitionViewModel } from "../web/types";

/** The item's transitions, oldest first; null for an unknown item. */
export function itemTransitions(
  config: ConveyorConfig,
  store: Pick<ItemStore, "getIssue"> & Pick<JournalStore, "listStageTransitions">,
  issueId: string,
): IssueJourneyTransitionViewModel[] | null {
  const issue = store.getIssue(issueId);
  if (!issue) return null;
  const repository = config.repositories[issue.repositoryId]
    ?? Object.values(config.repositories).find((candidate) =>
      candidate.address === issue.repositoryId
    );
  const pipeline = repository ? config.pipelines[repository.pipeline] : null;
  const actorFor = (stageId: string | null): string => {
    if (!stageId) return "Conveyor · Orchestrator";
    const found = pipeline?.stages.find((candidate) => candidate.id === stageId);
    const stage = found && !isNativeStage(found) ? found : undefined;
    if (stage?.run.type === "agent") {
      const agent = config.agents[stage.run.agent];
      return `${agent?.name ?? displayName(stage.run.agent)} · ${agent?.title ?? "AI Agent"}`;
    }
    if (stage?.run.type === "script") return "Conveyor · Script";
    return "Conveyor · Orchestrator";
  };
  return store.listStageTransitions(issueId).map((transition) => ({
    id: transition.id,
    fromStage: transition.fromStage,
    toStage: transition.toStage,
    kind: transition.kind,
    status: transition.status,
    resultStatus: transition.resultStatus,
    reason: transition.error ?? transition.reason,
    requiredFixes: transition.requiredFixes,
    actor: transition.actor
      ? `${transition.actor.name}${transition.actor.title ? ` · ${transition.actor.title}` : ""}`
      : actorFor(transition.fromStage ?? transition.toStage),
    createdAt: transition.createdAt,
    completedAt: transition.completedAt,
  }));
}
