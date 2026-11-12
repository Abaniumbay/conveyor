// Purging items (#676): an item that has no Conveyor labels any more (it left, or closed without a
// merge) loses its run, workspace, worktree, branch, run artifacts and rows. Each step is recorded,
// so a restart or a failed attempt finishes what is left and repeats nothing. The event log keeps
// the item's events.

import type { ConveyorConfig } from "../config/load";
import type { ItemStore } from "../db/ports";
import { log } from "../log/logger";
import type { SourceCache } from "../source/client";
import type { WorkspaceManager } from "../workspace/manager";
import { removeRunArtifacts } from "./retention";

export interface ItemPurgeDeps {
  config: {
    repositories: Readonly<Record<string, Pick<ConveyorConfig["repositories"][string], "folder" | "address">>>;
    /** Where run artifacts are kept. */
    artifacts: string;
  };
  store: Pick<ItemStore,
    | "getIssue" | "repositoryPause" | "beginPurge" | "listPendingPurges" | "finishPurge"
    | "listUnremovedWorkspaces" | "markWorkspaceRemoved" | "listRunIdsForIssue"
  >;
  source: Pick<SourceCache, "forgetIssue">;
  /** The workspace manager, read when a workspace is removed. */
  workspaces: () => Pick<WorkspaceManager, "remove">;
  /** Tells the item's running stage, if any, to stop. */
  interrupt: (issueId: string) => void;
  /** Resolves once the runs of these items have ended. */
  runsEnded: (issueIds: readonly string[]) => Promise<void>;
  shuttingDown: () => boolean;
  schedule: () => void;
}

/** Purges items that left Conveyor and finishes the purges a restart left behind. */
export class ItemPurges {
  readonly #deps: ItemPurgeDeps;
  readonly #purges = new Map<string, Promise<void>>();

  constructor(deps: ItemPurgeDeps) {
    this.#deps = deps;
  }

  /** Whether a purge is still running. */
  get busy(): boolean {
    return this.#purges.size > 0;
  }

  /**
   * Purges an item. One entry point for every way Conveyor learns of it. Synchronously, before any
   * source call, it kills the item's run, ends its enrollment and fences in-flight work; then it
   * removes the workspace, worktree and branch and deletes the rows. Safe to call again for an
   * item already being purged.
   */
  purge(issueId: string): Promise<void> {
    if (!this.#deps.store.getIssue(issueId)) return Promise.resolve();
    this.#deps.interrupt(issueId);
    this.#deps.store.beginPurge(issueId);
    return this.#continue(issueId);
  }

  /** Resolves once every purge in progress has finished or given up for now. */
  async settled(): Promise<void> {
    while (this.#purges.size > 0) await Promise.all([...this.#purges.values()]);
  }

  /** Finishes the purges a restart (or a failed attempt) left behind. */
  resume(): void {
    for (const pending of this.#deps.store.listPendingPurges()) void this.#continue(pending.issueId);
  }

  #continue(issueId: string): Promise<void> {
    const running = this.#purges.get(issueId);
    if (running) return running;
    const purge = this.#finish(issueId)
      .catch((error) => log.warn("Item purge will be retried", { issue: issueId }, error))
      .finally(() => this.#purges.delete(issueId));
    this.#purges.set(issueId, purge);
    return purge;
  }

  async #finish(issueId: string): Promise<void> {
    const { config, store } = this.#deps;
    const issue = store.getIssue(issueId);
    if (!issue) {
      store.finishPurge(issueId);
      return;
    }
    // The run was told to stop; the workspace is removed only once it has.
    await this.#deps.runsEnded([issueId]);
    if (this.#deps.shuttingDown() || store.repositoryPause(issue.repositoryId)) return;
    const repository = config.repositories[issue.repositoryId];
    if (!repository) throw new Error(`repository ${issue.repositoryId} is not configured; cannot remove the workspace of ${issueId}`);
    for (const workspace of store.listUnremovedWorkspaces(issueId)) {
      await this.#deps.workspaces().remove({
        repositoryPath: repository.folder,
        workspacePath: workspace.path,
        branch: workspace.branch,
        deleteBranch: true,
      });
      store.markWorkspaceRemoved(workspace.id);
    }
    // Run artifacts are found through the run records, so they go before the records do.
    for (const runId of store.listRunIdsForIssue(issueId)) await removeRunArtifacts(config.artifacts, runId);
    store.finishPurge(issueId);
    this.#deps.source.forgetIssue?.(repository.address, issue.sourceNumber);
    log.info("Item purged", { issue: issueId, number: issue.sourceNumber });
    this.#deps.schedule();
  }
}
