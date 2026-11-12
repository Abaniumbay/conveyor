// Roll-ups and relationships (#676): the sub-issues and blockers Conveyor reads from the source and
// stores, a parent that follows its earliest unfinished child's stage, the completion of a parent
// whose descendants are all complete (the only issue the service ever closes), and resuming a
// stopped parent so it waits for its children again.

import { createHash } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { evaluateIssueState } from "../core/issue-state";
import { RepositoryPausedError } from "../core/repository-pause";
import { applyRollupTransition, type TransitionStore } from "../core/transition";
import type { ConversationStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import { log, type LogFields } from "../log/logger";
import type { ItemLifecycle } from "../source/client";
import type { ItemMarkers, ItemReader, SourceIssue } from "../source/types";
import { removeWorkspace } from "../workspace/lifecycle";
import type { WorkspaceManager } from "../workspace/manager";
import { metadataLabels } from "./question-answers";

/** How long an unchanged issue's sub-issues and blockers are reused before they are read again. */
const RELATIONSHIP_REUSE_MS = 60 * 60_000;
/** The same while the repository's webhooks are healthy and report relationship changes. */
const HEALTHY_RELATIONSHIP_REUSE_MS = 6 * 60 * 60_000;

type Relationships = { children: SourceIssue[]; dependencies: SourceIssue[] };

export interface RollupDeps {
  config: Pick<ConveyorConfig, "labels" | "repositories" | "pipelines" | "hash"> & { labelPrefix: string };
  store: TransitionStore & Pick<RunLogStore, "listActiveIssueRuns"> & Pick<ConversationStore, "listOpenQuestions">;
  source: ItemReader & Pick<ItemLifecycle, "listDependencies">;
  /** The item source fenced at the repository's pause. */
  fencedSource: (repositoryId: string) => Pick<ItemReader, "getIssue"> & Pick<ItemMarkers, "replaceConveyorLabels"> & Pick<ItemLifecycle, "closeIssue">;
  /** Whether the repository's webhooks are healthy, so they report relationship changes. */
  webhookHealthy: (repositoryId: string) => boolean;
  /** The items whose stage runs in this process. */
  runningIssueIds: () => Iterable<string>;
  /** Whether the item has a run in this process or a recorded run that has not finished. */
  hasLiveRun: (issueId: string) => boolean;
  /** Whether this stage's agent is allowed to create children. */
  stageCreatesChildren: (repositoryId: string, stageId: string | null) => boolean;
  /** Whether an explicit retry queued this child-creation stage of a parent. */
  childCreationRetryQueued: (issue: StoredIssue, stageId: string | null) => boolean;
  /** Whether a parked agent question belongs to the item's current execution. */
  hasResumableQuestionExecution: (issueId: string) => boolean;
  /** Whether the item waits on a follow-up gate. */
  hasWaitingFollowUp: (issue: StoredIssue) => boolean;
  /** The workspace manager, read when a parent's workspace is removed. */
  workspaces: () => Pick<WorkspaceManager, "remove">;
  /** Reads the one item from the source again. */
  reconcile: (repositoryId: string, sourceNumber: number) => Promise<void>;
  /** Log correlation for an item. */
  itemFields: (issueId: string) => LogFields;
}

/** Relationships, roll-up stages and completion, and resuming stopped parents. */
export class Rollups {
  readonly #deps: RollupDeps;
  /** Sub-issues and blockers last read per issue, reused while the issue is unchanged (see `#relationshipsOf`). */
  readonly #relationships = new Map<string, { updatedAt: string; readAt: number } & Relationships>();
  readonly #resuming = new Set<string>();

  constructor(deps: RollupDeps) {
    this.#deps = deps;
  }

  /** Drops the remembered sub-issues and blockers of the named issues, so the next pass reads them. */
  forget(repositoryId: string, numbers: readonly number[]): void {
    const named = new Set(numbers);
    for (const issue of this.#deps.store.listIssues(repositoryId)) {
      if (named.has(issue.sourceNumber)) this.#relationships.delete(issue.id);
    }
  }

  /** Whether an item and all of its descendants meet the roll-up completion rule. */
  satisfied(issueId: string, visited = new Set<string>()): boolean {
    const { config, store } = this.#deps;
    if (visited.has(issueId)) return false;
    const issue = store.getIssue(issueId);
    if (!issue) return false;
    const children = store.listChildren(issueId);
    const next = new Set(visited).add(issueId);
    if (children.length > 0) {
      return children.every((child) => this.satisfied(child.issueId, next));
    }
    const doneLabel = config.labels.states.done;
    return (doneLabel !== undefined && issue.labels.includes(doneLabel)) ||
      (issue.sourceState === "closed" &&
        (!store.hasMergedPullRequest(issue.id) || this.#deps.hasWaitingFollowUp(issue)));
  }

  /**
   * The sub-issues and blockers of an issue. Every reconcile needs them, so an issue unchanged since
   * its last read reuses that read for up to an hour; sub-issue and dependency webhooks drop it sooner.
   */
  async #relationshipsOf(address: string, issue: StoredIssue, refresh = true): Promise<Relationships> {
    const cached = this.#relationships.get(issue.id);
    // A pass scoped to some issues reuses what it knows of the others, however old: the read of
    // this run, or after a restart the relationships it stored.
    if (cached && !refresh) return cached;
    if (!refresh) return this.#storedRelationships(issue);
    // Healthy webhooks report relationship changes, so a read is trusted for longer.
    const reuseMs = this.#deps.webhookHealthy(issue.repositoryId) ? HEALTHY_RELATIONSHIP_REUSE_MS : RELATIONSHIP_REUSE_MS;
    if (cached && cached.updatedAt === issue.sourceUpdatedAt && Date.now() - cached.readAt < reuseMs) return cached;
    const children = await this.#deps.source.listSubIssues(address, issue.sourceNumber);
    const dependencies = await this.#deps.source.listDependencies(address, issue.sourceNumber);
    const read = { updatedAt: issue.sourceUpdatedAt, readAt: Date.now(), children, dependencies };
    this.#relationships.set(issue.id, read);
    return read;
  }

  /** The sub-issues and blockers Conveyor stored for an issue, in the shape a source read returns. */
  #storedRelationships(issue: StoredIssue): Relationships {
    const { store } = this.#deps;
    const asSource = (id: string): SourceIssue[] => {
      const stored = store.getIssue(id);
      return stored ? [{
        id: stored.id, number: stored.sourceNumber, url: stored.sourceUrl, title: stored.title, body: stored.body,
        state: stored.sourceState === "closed" ? "closed" : "open", stateReason: stored.sourceStateReason ?? null,
        labels: stored.labels, updatedAt: stored.sourceUpdatedAt,
      }] : [];
    };
    const children = [...store.listChildren(issue.id)].sort((left, right) => (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0));
    return { children: children.flatMap((child) => asSource(child.issueId)), dependencies: store.listDependencies(issue.id).flatMap(asSource) };
  }

  /** Reflect the successful, source-authoritative close without waiting for another poll. */
  #recordClosedParent(readParent: StoredIssue, sourceIssue: SourceIssue): void {
    const { store } = this.#deps;
    // The caller read `readParent` before awaiting the source; keep whatever text and stage are stored now.
    const parent = store.getIssue(readParent.id) ?? readParent;
    store.upsertIssue({
      id: parent.id,
      repositoryId: parent.repositoryId,
      sourceNumber: sourceIssue.number,
      sourceUrl: sourceIssue.url,
      title: parent.title,
      body: parent.body,
      sourceState: sourceIssue.state,
      sourceStateReason: sourceIssue.stateReason ?? null,
      labels: sourceIssue.labels,
      sourceUpdatedAt: sourceIssue.updatedAt,
      ...(parent.acceptedTextAt !== undefined ? { acceptedTextAt: parent.acceptedTextAt } : {}),
      ...(sourceIssue.type !== undefined ? { issueType: sourceIssue.type } : {}),
    });
    store.setIssueProjection(parent.id, {
      stage: parent.projectedStage,
      state: "done",
      warning: null,
    });
  }

  /** Mark and close a completed active roll-up, recovering each source mutation independently. */
  async #completeParent(
    repositoryId: string,
    address: string,
    parent: StoredIssue,
    doneLabel: string | undefined,
  ): Promise<void> {
    const { config, store } = this.#deps;
    if (store.repositoryPause(repositoryId)) return;
    const github = this.#deps.fencedSource(repositoryId);
    const repository = config.repositories[repositoryId]!;
    const stageLabel = parent.projectedStage
      ? [config.labels.stageTemplate.replace("{stage}", parent.projectedStage)]
      : [];
    const closeMutationKeyPrefix = `rollup-completion-close:${parent.id}:`;

    let current = await github.getIssue(address, parent.sourceNumber);
    const priorCloseMutation = store.getLatestSourceMutationByKeyPrefix(closeMutationKeyPrefix);
    if (
      current.state === "closed" &&
      current.stateReason === "completed" &&
      priorCloseMutation &&
      priorCloseMutation.status !== "succeeded"
    ) {
      // A request can reach GitHub even when its response is lost. Seeing the
      // completed state on a later reconciliation is the authoritative proof
      // that the planned mutation finished, so do not issue a second close.
      store.completeSourceMutation(priorCloseMutation.id, {
        state: current.state,
        stateReason: current.stateReason,
      });
      this.#recordClosedParent(parent, current);
      return;
    }
    if (
      !doneLabel ||
      current.state !== "open" ||
      !current.labels.includes(config.labels.enrollment)
    ) {
      return;
    }
    const labels = [
      config.labels.enrollment,
      ...stageLabel,
      doneLabel,
      ...metadataLabels(current.labels, config)
        .filter((label) => label !== config.labels.metadata.closable),
    ].sort((left, right) => left.localeCompare(right));
    const currentConveyorLabels = current.labels
      .filter(
        (label) =>
          label === config.labels.enrollment ||
          label.startsWith(`${config.labels.enrollment}:`) ||
          label === config.labels.metadata.noSplit,
      )
      .sort((left, right) => left.localeCompare(right));
    const needsLabelUpdate = labels.length !== currentConveyorLabels.length ||
      labels.some((label, index) => label !== currentConveyorLabels[index]);

    if (needsLabelUpdate) {
      const labelMutationDigest = createHash("sha256")
        .update(`${parent.id}\0${current.updatedAt}\0${[...current.labels].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 24);
      const labelMutation = store.beginSourceMutation({
        // The source snapshot starts a completion episode. It remains stable
        // while a failed label write is retried, but changes before a parent
        // can be completed again after GitHub reopens or relabels it.
        idempotencyKey: `rollup-completion-labels:${parent.id}:${labelMutationDigest}`,
        source: repository.source,
        operation: "issue.labels.replace",
        request: { issueId: parent.id, issueNumber: parent.sourceNumber, labels },
      });
      if (labelMutation.status !== "succeeded") {
        try {
          await github.replaceConveyorLabels(
            address,
            parent.sourceNumber,
            labels,
            [config.labels.metadata.noSplit, config.labels.metadata.paused],
          );
          store.completeSourceMutation(labelMutation.id, { labels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          store.failSourceMutation(
            labelMutation.id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      current = await github.getIssue(address, parent.sourceNumber);
    }

    if (
      current.state !== "open" ||
      !current.labels.includes(config.labels.enrollment)
    ) {
      return;
    }
    if (!current.labels.includes(doneLabel)) {
      throw new Error("Completed roll-up parent no longer has its done label; refusing to close it.");
    }

    const closeMutationDigest = createHash("sha256")
      .update(`${parent.id}\0${current.updatedAt}\0${[...current.labels].sort().join("\0")}`)
      .digest("hex")
      .slice(0, 24);
    const closeMutation = store.beginSourceMutation({
      idempotencyKey: `${closeMutationKeyPrefix}${closeMutationDigest}`,
      source: repository.source,
      operation: "issue.close",
      request: {
        issueId: parent.id,
        issueNumber: parent.sourceNumber,
        stateReason: "completed",
      },
    });
    if (closeMutation.status === "succeeded") return;
    try {
      const closed = await github.closeIssue(address, parent.sourceNumber);
      if (closed.state !== "closed") {
        throw new Error("GitHub did not confirm the completed roll-up parent as closed.");
      }
      store.completeSourceMutation(closeMutation.id, {
        state: closed.state,
        stateReason: closed.stateReason ?? null,
      });
      this.#recordClosedParent(parent, closed);
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      // GitHub can apply the close and still answer with an error (a 422 was seen in production), so
      // the issue's state decides: a closed issue is a completed close, not a failure to retry.
      const observed = await this.#deps.source.getIssue(address, parent.sourceNumber).catch(() => null);
      if (observed?.state === "closed") {
        store.completeSourceMutation(closeMutation.id, { state: observed.state, stateReason: observed.stateReason ?? null });
        this.#recordClosedParent(parent, observed);
        return;
      }
      store.failSourceMutation(
        closeMutation.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /** Completes one roll-up parent; its failure is that parent's, so the rest of the repository still reconciles. */
  async #completeParentLogged(repositoryId: string, address: string, parent: StoredIssue, doneLabel: string | undefined): Promise<boolean> {
    try {
      await this.#completeParent(repositoryId, address, parent, doneLabel);
      return true;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return false;
      log.warn("Roll-up parent could not be closed; the next pass retries it", this.#deps.itemFields(parent.id), error);
      return false;
    }
  }

  #hasStopLabel(issue: StoredIssue): boolean {
    const { config } = this.#deps;
    // A source refresh can lag the recorded result. Keep any configured
    // stopped state intact until the ordinary item path has cleared it. A
    // stale done label is the exception: an unfinished descendant repairs it.
    const stoppedStates = new Set(Object.keys(config.labels.states).filter((state) => state !== "done"));
    const stopLabels = new Set(Object.entries(config.labels.states)
      .flatMap(([state, label]) => state === "done" ? [] : [label]));
    return (issue.projectedState !== null && stoppedStates.has(issue.projectedState)) ||
      issue.labels.some((label) => stopLabels.has(label));
  }

  /**
   * Stores the repository's relationships and moves or completes its roll-up parents. `scope` names
   * the issues a webhook pass reads afresh; the others keep what was read before. Null reads all.
   */
  async reconcile(
    repositoryId: string,
    address: string,
    scope: ReadonlySet<number> | null = null,
  ): Promise<void> {
    const { config, store } = this.#deps;
    if (store.repositoryPause(repositoryId)) return;
    const refresh = (issue: StoredIssue) => scope === null || scope.has(issue.sourceNumber);
    const issues = store
      .listIssues(repositoryId)
      .filter(
        (issue) =>
          // A closed enrolled intermediate can still contain descendants that
          // decide its open ancestor's roll-up state.
          (issue.sourceState === "open" || issue.labels.includes(config.labels.enrollment)) &&
          // Stopped items too: the board must show the dependencies a person
          // added while an item was blocked, and the scheduler needs them the
          // moment it is unblocked.
          !["unlisted"].includes(issue.projectedState ?? ""),
      );
    const issueByNumber = new Map(
      store
        .listIssues(repositoryId)
        .map((issue) => [issue.sourceNumber, issue]),
    );
    const parents = new Map<string, { parentId: string; siblingOrder: number }>();
    for (const parent of issues) {
      const { children } = await this.#relationshipsOf(address, parent, refresh(parent));
      for (const [index, child] of children.entries()) {
        const storedChild = issueByNumber.get(child.number);
        if (storedChild) {
          parents.set(storedChild.id, { parentId: parent.id, siblingOrder: index + 1 });
        }
      }
    }
    const activeIssueIds = new Set(issues.map((issue) => issue.id));
    for (const [childId, parent] of parents) {
      if (activeIssueIds.has(childId)) continue;
      store.replaceRelationships(
        childId,
        parent,
        store.listDependencies(childId),
      );
    }
    for (const issue of issues) {
      const { dependencies } = await this.#relationshipsOf(address, issue, refresh(issue));
      const blockerIds: string[] = [];
      for (const dependency of dependencies) {
        const storedDependency = issueByNumber.get(dependency.number);
        if (storedDependency) {
          blockerIds.push(storedDependency.id);
          continue;
        }
        // The map predates the awaits above; the blocker may have been stored and enrolled
        // since. Insert only when the store still has no row for it.
        const stored = store.insertPlaceholderIssue({
          id: dependency.id,
          repositoryId,
          sourceNumber: dependency.number,
          sourceUrl: dependency.url,
          // Dependencies can be read before they are independently reconciled.
          // Do not make that raw read an agent-visible snapshot.
          title: "",
          body: "",
          sourceState: dependency.state,
          sourceStateReason: dependency.stateReason ?? null,
          labels: dependency.labels,
          sourceUpdatedAt: dependency.updatedAt,
          acceptedTextAt: null,
          ...(dependency.type !== undefined ? { issueType: dependency.type } : {}),
        });
        blockerIds.push(stored.id);
        issueByNumber.set(dependency.number, stored);
      }
      store.replaceRelationships(
        issue.id,
        parents.get(issue.id) ?? null,
        blockerIds,
      );
    }
    const doneLabel = config.labels.states.done;
    const pipeline = config.pipelines[
      config.repositories[repositoryId]!.pipeline
    ]!;
    const stageIds = pipeline.stages.map((stage) => stage.id);
    const stageRanks = new Map(stageIds.map((stageId, index) => [stageId, index]));
    const rollupStage = (
      issueId: string,
      visited = new Set<string>(),
    ): string | null => {
      if (visited.has(issueId)) return null;
      const next = new Set(visited).add(issueId);
      const unfinishedChildren = store
        .listChildren(issueId)
        .filter((child) => !this.satisfied(child.issueId));
      const childStages = unfinishedChildren.flatMap((child) => {
        const nestedStage = rollupStage(child.issueId, next);
        const stage = nestedStage ?? store.getIssue(child.issueId)?.projectedStage;
        return stage && stageRanks.has(stage) ? [stage] : [];
      });
      return childStages.sort(
        (left, right) => stageRanks.get(left)! - stageRanks.get(right)!,
      )[0] ?? null;
    };
    const runningIssueIds = new Set(
      [
        ...store.listActiveIssueRuns().map((run) => run.issueId),
        ...this.#deps.runningIssueIds(),
      ],
    );
    const repositoryIssues = store.listIssues(repositoryId);
    for (const parent of repositoryIssues) {
      if (store.repositoryPause(repositoryId)) return;
      const children = store.listChildren(parent.id);
      const closeMutation = store.getLatestSourceMutationByKeyPrefix(`rollup-completion-close:${parent.id}:`);
      if (
        children.length > 0 &&
        parent.sourceState === "closed" &&
        closeMutation &&
        closeMutation.status !== "succeeded"
      ) {
        await this.#completeParentLogged(repositoryId, address, parent, doneLabel);
        continue;
      }
      if (
        children.length === 0 ||
        parent.sourceState !== "open" ||
        !parent.labels.includes(config.labels.enrollment)
      ) {
        continue;
      }
      // A live parent run owns its outcome, including any question it asks.
      // Child roll-up must not fence that run or replace its source state.
      if (runningIssueIds.has(parent.id)) continue;
      // A retried child-creation stage may be queued behind available capacity.
      // Keep its stage intact until it can run; otherwise roll-up would replace
      // it with a child's frontier before it creates the remaining children.
      if (parent.projectedState === "active" && this.#deps.childCreationRetryQueued(parent, parent.projectedStage)) continue;
      // A parked question has already finished its producer run, but its cursor
      // still belongs to that run and must survive until its answer resumes it.
      if (this.#deps.hasResumableQuestionExecution(parent.id)) continue;
      // A stage that passed earlier may subsequently be stopped. Never let a
      // roll-up erase that stop while its source state still says to park it.
      if (this.#hasStopLabel(parent)) continue;
      if (store.getStageState(parent.id)?.status !== "running") {
        await removeWorkspace({
          store,
          manager: this.#deps.workspaces(),
          issueId: parent.id,
          repositoryFolder: config.repositories[repositoryId]!.folder,
        });
      }

      const allChildrenSatisfied = children.every((child) => this.satisfied(child.issueId));
      const targetStage = rollupStage(parent.id);
      if (!allChildrenSatisfied && targetStage) {
        const desiredLabels = [
          config.labels.enrollment,
          config.labels.stageTemplate.replace("{stage}", targetStage),
          ...metadataLabels(parent.labels, config)
            .filter((label) => label !== config.labels.metadata.closable),
        ].sort((left, right) => left.localeCompare(right));
        const currentLabels = parent.labels
          .filter(
            (label) =>
              label === config.labels.enrollment ||
              label.startsWith(`${config.labels.enrollment}:`) ||
              label === config.labels.metadata.noSplit,
          )
          .sort((left, right) => left.localeCompare(right));
        if (
          desiredLabels.length !== currentLabels.length ||
          desiredLabels.some((label, index) => label !== currentLabels[index])
        ) {
          const transitionDigest = createHash("sha256")
            .update(`${parent.id}\0${parent.sourceUpdatedAt}\0${parent.projectedStage ?? ""}\0${targetStage}`)
            .digest("hex")
            .slice(0, 24);
          let applied: boolean;
          try {
            applied = await applyRollupTransition({
              store,
              source: this.#deps.fencedSource(repositoryId),
              sourceName: config.repositories[repositoryId]!.source,
              address,
              configHash: config.hash,
              transitionId: `rollup-${transitionDigest}`,
              issue: parent,
              targetStageId: targetStage,
              labels: config.labels,
              reason: `Following the earliest unfinished child stage: ${targetStage}`,
            });
          } catch (error) {
            if (error instanceof RepositoryPausedError) return;
            throw error;
          }
          if (applied) {
            log.info("Roll-up stage transition completed", {
              ...this.#deps.itemFields(parent.id),
              sourceStage: parent.projectedStage,
              targetStage,
              reason: `Following the earliest unfinished child stage: ${targetStage}`,
            });
          }
        }
      }
      if (allChildrenSatisfied && doneLabel && await this.#completeParentLogged(repositoryId, address, parent, doneLabel)) {
        log.info("Parent roll-up completed", {
          ...this.#deps.itemFields(parent.id),
          sourceStage: parent.projectedStage,
          targetStage: "done",
          reason: "All child items are complete",
        });
      }
    }
  }

  /** Whether a stopped parent's recorded state lets it resume waiting for its children. */
  resumable(issue: StoredIssue, children: number, running: boolean, hasOpenQuestion: boolean): boolean {
    return issue.sourceState === "open" &&
      issue.labels.includes(this.#deps.config.labels.enrollment) &&
      issue.projectedStage !== null &&
      ["blocked", "error", "needs-intervention"].includes(issue.projectedState ?? "") &&
      !running && children > 0 && !this.#deps.stageCreatesChildren(issue.repositoryId, issue.projectedStage) && !hasOpenQuestion;
  }

  /** Whether the stored state permits resuming a stopped parent before the command verifies the source snapshot. */
  canResume(issueId: string): boolean {
    const { store } = this.#deps;
    const issue = store.getIssue(issueId);
    return issue !== null && this.resumable(
      issue,
      store.listChildren(issueId).length,
      this.#deps.hasLiveRun(issueId),
      store.listOpenQuestions().some((question) => question.issueId === issueId),
    );
  }

  /** Clears a stopped parent's stop label on the source so it waits for its children again. */
  async resume(issueId: string): Promise<{ stageId: string }> {
    const { config, store } = this.#deps;
    if (this.#resuming.has(issueId)) throw new Error("resume waiting for children is already in progress");
    this.#resuming.add(issueId);
    try {
      const issue = store.getIssue(issueId);
      const repository = issue ? config.repositories[issue.repositoryId] : undefined;
      if (!issue || !repository || issue.projectedState === "unlisted") throw new Error("issue not found");
      if (store.repositoryPause(issue.repositoryId)) throw new RepositoryPausedError();
      if (!this.canResume(issueId)) {
        throw new Error("roll-up parent is not eligible to resume waiting for children");
      }
      const pipeline = config.pipelines[repository.pipeline];
      if (!pipeline) throw new Error("issue pipeline is not configured");

      const stopMutationKeyPrefix = `rollup-resume:${issue.id}:`;
      const priorMutation = store.getLatestSourceMutationByKeyPrefix(stopMutationKeyPrefix);
      const stopLabels = Object.entries(config.labels.states)
        .flatMap(([state, label]) => state === "done" ? [] : [label]);
      const live = await this.#deps.source.getIssue(repository.address, issue.sourceNumber);
      const sourceAlreadyResumed = live.number === issue.sourceNumber &&
        live.state === "open" &&
        live.labels.includes(config.labels.enrollment) &&
        !live.labels.some((label) => stopLabels.includes(label));
      if (sourceAlreadyResumed && priorMutation) {
        // GitHub can apply the label replacement before a lost response. Its
        // current labels are the authoritative proof that the planned resume completed.
        if (priorMutation.status !== "succeeded") {
          store.completeSourceMutation(priorMutation.id, { labels: live.labels });
        }
        await this.#deps.reconcile(issue.repositoryId, issue.sourceNumber);
        return { stageId: issue.projectedStage ?? "" };
      }

      const evaluated = evaluateIssueState({
        sourceState: live.state,
        sourceLabels: live.labels,
        labels: config.labels,
        stages: pipeline.stages.map((stage) => stage.id),
        expectedPostMergeClosure: false,
      });
      const resumableStates = new Set(["blocked", "error", "needs-intervention"]);
      if (live.number !== issue.sourceNumber || live.state !== "open" || evaluated.mode !== "stopped" ||
        !evaluated.state || !resumableStates.has(evaluated.state) || !evaluated.stage ||
        evaluated.state !== issue.projectedState || evaluated.stage !== issue.projectedStage ||
        !this.canResume(issueId)) {
        throw new Error("roll-up parent state changed or is not eligible; refresh before resuming waiting for children");
      }
      // The local relationship projection can lag a user unlinking every child.
      // Read GitHub at the mutation boundary so a stale action cannot resume a non-parent.
      if ((await this.#deps.source.listSubIssues(repository.address, issue.sourceNumber)).length === 0) {
        throw new Error("roll-up parent no longer has children; refresh before resuming waiting for children");
      }

      const stageId = evaluated.stage;
      const conveyorLabels = live.labels.filter((label) =>
        (label === config.labelPrefix ||
          label.startsWith(`${config.labelPrefix}:`) ||
          label === config.labels.metadata.noSplit) &&
        label !== config.labels.states[evaluated.state!],
      );
      const digest = createHash("sha256")
        .update(`${issue.id}\0${live.updatedAt}\0${[...live.labels].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 24);
      const mutation = store.beginSourceMutation({
        idempotencyKey: `${stopMutationKeyPrefix}${digest}`,
        source: repository.source,
        operation: "issue.labels.resume-rollup",
        request: { issueId, issueNumber: issue.sourceNumber, stoppedState: evaluated.state, stageId, labels: conveyorLabels },
      });
      if (mutation.status !== "succeeded") {
        try {
          await this.#deps.fencedSource(issue.repositoryId).replaceConveyorLabels(
            repository.address,
            issue.sourceNumber,
            conveyorLabels,
            [config.labels.metadata.noSplit, config.labels.metadata.paused],
          );
          store.completeSourceMutation(mutation.id, { labels: conveyorLabels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          const observed = await this.#deps.source.getIssue(repository.address, issue.sourceNumber).catch(() => null);
          if (observed?.state === "open" && observed.labels.includes(config.labels.enrollment) &&
            !observed.labels.some((label) => stopLabels.includes(label))) {
            store.completeSourceMutation(mutation.id, { labels: observed.labels });
          } else {
            store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
            throw error;
          }
        }
      }
      await this.#deps.reconcile(issue.repositoryId, issue.sourceNumber);
      return { stageId };
    } finally {
      this.#resuming.delete(issueId);
    }
  }
}
