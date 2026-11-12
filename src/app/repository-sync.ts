// Repository sync (#676): onboarding and the startup pass, reconciling a repository from its source
// (full, changed-since, or named items), an operator's sync, created and delivered items, and the
// reaction to what webhook deliveries observed. Syncs of one repository run one at a time behind
// its lock; GitHub stays authoritative and the store holds its projection.

import { AsyncLocalStorage } from "node:async_hooks";

import type { ConveyorConfig } from "../config/load";
import { reconcileRepository, type DeliveredActors, type ReconcileRepositoryInput } from "../core/reconciler";
import { RepositoryPausedError } from "../core/repository-pause";
import type { ConversationStore, EventStore, EvidenceStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import { isEventOf, type StoredEvent } from "../events/catalogue";
import { withEventContext } from "../events/context";
import { log, type LogFields } from "../log/logger";
import { withCallSource } from "../source/calls";
import type { ItemLifecycle, ItemSourceAdmin, SourceCache } from "../source/client";
import type { ActorTrust } from "../source/trust";
import { isIssueGone, type IssueSourceAdapter, type ItemMetadata, type SourceIssue } from "../source/types";
import { CommandInputError } from "../commands/bus";
import type { StartupRepositoryPhase, StartupStatus } from "./control-sources";
import type { WebhookSupervisor } from "./webhook-supervisor";

/** A partial issue list starts this much before the previous read began, so clock skew and in-flight edits are not missed. */
const ISSUE_LISTING_OVERLAP_MS = 2 * 60_000;

type Repository = ConveyorConfig["repositories"][string];

/** An item as a delivery described it, and who made each change. */
interface DeliveredIssue {
  issue: SourceIssue;
  actors: DeliveredActors;
}

/** The labels Conveyor creates on a repository: enrollment, stages, states, metadata and system areas. */
export function labelDefinitions(config: ConveyorConfig, repositoryId: string) {
  const repository = config.repositories[repositoryId]!;
  const pipeline = config.pipelines[repository.pipeline]!;
  const labels = [
    { name: config.labels.enrollment, color: "2563eb", description: "Enrolled in Conveyor" },
    ...pipeline.stages.map((stage) => ({
      name: config.labels.stageTemplate.replace("{stage}", stage.id),
      color: "0ea5e9",
      description: `Conveyor stage: ${stage.id}`,
    })),
    ...Object.entries(config.labels.states).map(([state, name]) => ({
      name,
      color: state === "done" ? "16a34a" : state === "rejected" ? "6b7280" : "d97706",
      description: `Conveyor state: ${state}`,
    })),
    { name: config.labels.metadata.closable, color: "8b5cf6", description: "Conveyor considers this issue closable" },
    { name: config.labels.metadata.noSplit, color: "0f766e", description: "Conveyor will not split this issue" },
    { name: config.labels.metadata.paused, color: "9ca3af", description: "Conveyor is paused on this issue" },
    ...repository.systemLabels.map((name) => ({
      name,
      color: "64748b",
      description: "Project system area",
    })),
  ];
  return [...new Map(labels.map((label) => [label.name, label])).values()];
}

export interface RepositorySyncDeps {
  config: ConveyorConfig;
  store: ItemStore & JournalStore & EvidenceStore & RunLogStore & ConversationStore & EventStore;
  source: Pick<IssueSourceAdapter, "getIssue"> & Pick<ItemMetadata, "getIssueFieldValues">
    & Pick<ItemSourceAdmin, "repositoryVisibility"> & Pick<SourceCache, "forgetRepository">;
  /** The item source fenced at the repository's pause. */
  fencedSource: (repositoryId: string) => Pick<IssueSourceAdapter, "listIssues" | "getIssueProvenance" | "getIssue">
    & Pick<ItemSourceAdmin, "ensureLabels"> & Pick<ItemLifecycle, "createIssue">;
  /** Who may enroll and edit an item. */
  trust: ActorTrust;
  webhooks: Pick<WebhookSupervisor, "url" | "register" | "redeliverMissed" | "ping">;
  /** Begins the purge of an item that left Conveyor. */
  purge: (issueId: string) => Promise<void>;
  /** Picks up purges a pass left unfinished. */
  resumePurges: () => void;
  /** Tells the runs that must not go on to stop; returns the items it told. */
  interruptIneligibleRuns: () => string[];
  /** Resolves once the runs of these items have ended. */
  runsEnded: (issueIds: readonly string[]) => Promise<void>;
  schedule: () => void;
  refreshStatusComments: (issueIds: readonly string[]) => void;
  /** Restores a cross-stage retry's handoff once reconciliation reached its stage. */
  restoreFeedback: (repositoryId: string) => void;
  /** Relabels items paused the old way, once. */
  relabelOldPausedItems: (repositoryId: string) => Promise<void>;
  /** Reads relationships; `scope` names the issues to read afresh, null reads all. */
  reconcileRelationships: (repositoryId: string, address: string, scope: ReadonlySet<number> | null) => Promise<void>;
  /** Drops what was read about these issues' relationships. */
  forgetRelationships: (repositoryId: string, numbers: readonly number[]) => void;
  /** Gives open changes a current-head CI indicator; `scope` limits it to the issues named. */
  backfillCiIndicators: (repositoryId: string, scope?: ReadonlySet<number> | null) => Promise<void>;
  /** Updates the CI indicator from a CI or change event. */
  applyCiEvent: (repositoryId: string, event: StoredEvent) => Promise<void>;
  /** Wakes items whose follow-ups were cleared from their text since `before` (bodies by item). */
  wakeClearedFollowUps: (repositoryId: string, before: ReadonlyMap<string, string>) => void;
  /** Re-applies parked items' pending messages after a reconcile reset warnings. */
  restorePendingStatus: (repositoryId: string) => void;
  /** Resolves one closed source item, from `delivered` when the caller already has its state. */
  recoverClosedItem: (repositoryId: string, issue: StoredIssue, delivered?: SourceIssue) => Promise<void>;
  /** Picks up scheduled Operator answers whose mirror did not finish. */
  recoverPendingScheduledAnswers: () => void;
  /** Removes scratch directories no active workspace owns. */
  recoverWorkspaceScratch: () => Promise<void>;
  /** Resolves once committed events are published and the scheduling they asked for ran. */
  eventsSettled: () => Promise<void>;
  shuttingDown: () => boolean;
  itemFields: (issueId: string) => LogFields;
}

/** Reads repositories into the projection, one sync per repository at a time. */
export class RepositorySync {
  readonly #deps: RepositorySyncDeps;
  /** When each repository's last successful listing began, less the overlap. */
  readonly #issueListings = new Map<string, { since: string }>();
  /** The running webhook reconcile of each repository. */
  readonly #webhookReconciles = new Map<string, Promise<void>>();
  /** The webhook reconcile waiting to start, per repository, and the issues it reads afresh (null: all). */
  readonly #queuedWebhookReconciles = new Map<string, { issueNumbers: Set<number> | null; done: Promise<void> }>();
  /** The tail of each repository's sync queue. */
  readonly #locks = new Map<string, Promise<void>>();
  /** The repositories whose lock the current async context holds. */
  readonly #heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
  /** The work webhook observations started, until it finishes. */
  readonly #webhookWork = new Set<Promise<void>>();
  /** An operator's running sync, per repository. */
  readonly #syncs = new Map<string, Promise<{ issues: number; failed: boolean }>>();
  /** Issue creations by repository and idempotency key. */
  readonly #createdIssues = new Map<string, Promise<{ issueId: string; number: number; url: string }>>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  /** The repositories the startup pass has not finished, and where it is with each. */
  readonly #startup = new Map<string, StartupRepositoryPhase>();
  #startupStarted = false;
  #startupRunning = false;
  #startupCompleted = false;
  #startupFailed = false;
  #lastReconciledAt: string | null = null;

  constructor(deps: RepositorySyncDeps) {
    this.#deps = deps;
  }

  /** When every repository was last reconciled; null before the first pass completed. */
  get lastReconciledAt(): string | null {
    return this.#lastReconciledAt;
  }

  /** Why a repository's last reconcile failed, by repository. */
  get reconcileErrors(): ReadonlyMap<string, string> {
    return this.#repositoryErrors;
  }

  /** Why a repository's onboarding failed, by repository. */
  get onboardingErrors(): ReadonlyMap<string, string> {
    return this.#onboardingErrors;
  }

  /** The repositories the startup pass has not finished, with their phase. */
  get startup(): ReadonlyMap<string, StartupRepositoryPhase> {
    return this.#startup;
  }

  /** Whether the startup pass is running now. */
  get startupRunning(): boolean {
    return this.#startupRunning;
  }

  /** Whether sync work that uses the database is still running (the startup pass or a webhook's work). */
  get busy(): boolean {
    return this.#webhookWork.size > 0 || this.#startupRunning;
  }

  /** Reconciled at least once, and every repository onboarded and reconciling. */
  ready(): boolean {
    return Boolean(this.#lastReconciledAt) &&
      (!this.#startupStarted || this.#startupCompleted) && !this.#startupRunning &&
      !this.#startupFailed &&
      this.#repositoryErrors.size === 0 && this.#onboardingErrors.size === 0;
  }

  /** Whether the repository's startup pass is done and neither its onboarding nor its last reconcile failed. */
  repositoryReady(repositoryId: string): boolean {
    return !this.#startup.has(repositoryId) &&
      !this.#onboardingErrors.has(repositoryId) &&
      !this.#repositoryErrors.has(repositoryId);
  }

  /** The process-local state of the first pass, for the control socket and dashboard. */
  startupStatus(): StartupStatus {
    if (this.#startupRunning || (this.#startupStarted && !this.#startupCompleted)) {
      const current = [...this.#startup.entries()].find(([, phase]) => phase !== "waiting")
        ?? (!this.#startupRunning ? this.#startup.entries().next().value ?? null : null);
      return { state: "starting", repository: current?.[0] ?? null, phase: current?.[1] ?? null };
    }
    const failed = [...this.#onboardingErrors.keys(), ...this.#repositoryErrors.keys()][0] ?? null;
    if (this.#startupFailed && failed === null) return { state: "degraded", repository: null, phase: null };
    return failed === null ? { state: "ready", repository: null, phase: null } : { state: "degraded", repository: failed, phase: null };
  }

  /** Marks creation as pending before listeners are opened; provider work begins from `beginStartupPass`. */
  prepareStartupPass(): void {
    this.#startupStarted = true;
    this.#startupCompleted = false;
    for (const id of Object.keys(this.#deps.config.repositories)) this.#startup.set(id, "waiting");
  }

  /** Onboards and reconciles every repository in parallel; each schedules as soon as it is checked. */
  beginStartupPass(): void {
    const { config, store } = this.#deps;
    this.#startupStarted = true;
    this.#startupRunning = true;
    this.#startupCompleted = false;
    this.#startupFailed = false;
    for (const id of Object.keys(config.repositories)) this.#startup.set(id, "waiting");
    void withCallSource("startup", async () => {
      await this.#deps.recoverWorkspaceScratch();
      await Promise.all(Object.entries(config.repositories).map(async ([id, repository]) => {
        const startedAt = Date.now();
        let issues = 0;
        let failed = false;
        this.#startup.set(id, "onboarding");
        log.info("Startup repository reconciliation started", { repository: id });
        try {
          await this.onboardRepository(id, repository);
          failed = this.#onboardingErrors.has(id);
          if (!failed) {
            this.#startup.set(id, "reconciling");
            issues = await this.#reconcileOne(id, this.#deps.webhooks.url(id) ? "changed" : "full");
            failed = this.#repositoryErrors.has(id);
          }
        } catch (error) {
          failed = true;
          this.#repositoryErrors.set(id, error instanceof Error ? error.message : String(error));
          log.error("Startup repository reconciliation failed", { repository: id }, error);
        } finally {
          log.info("Startup repository reconciliation completed", {
            repository: id,
            issues,
            durationMs: Date.now() - startedAt,
            success: !failed,
          });
          this.#startup.delete(id);
          // A repository can safely resume as soon as its own projection is checked.
          if (!failed) this.#deps.schedule();
        }
      }));
      this.#lastReconciledAt = new Date().toISOString();
      store.events().append("service.reconciled", { failed: this.#repositoryErrors.size + this.#onboardingErrors.size });
      this.#deps.interruptIneligibleRuns();
      this.#deps.recoverPendingScheduledAnswers();
    }).catch((error) => {
      this.#startupFailed = true;
      log.error("Startup reconciliation failed", {}, error);
    }).finally(() => {
      this.#startupRunning = false;
      this.#startupCompleted = true;
      this.#deps.schedule();
    });
  }

  /** Records the repository, its trust status, labels and webhook; a failure is kept as its onboarding error. */
  async onboardRepository(id: string, repository: Repository): Promise<void> {
    const { config, store } = this.#deps;
    store.upsertRepository({ id, configName: id, source: repository.source, address: repository.address, folder: repository.folder, configHash: config.hash });
    await this.#recordTrustStatus(id, repository.address);
    if (store.repositoryPause(id)) return;
    try {
      await this.#deps.fencedSource(id).ensureLabels(repository.address, labelDefinitions(config, id));
      await this.#deps.webhooks.register(id);
      if (this.#onboardingErrors.delete(id)) store.events().append("repository.healthChanged", { check: "onboarding", healthy: true }, { repositoryId: id });
    } catch (error) {
      if (error instanceof RepositoryPausedError) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#onboardingErrors.has(id)) store.events().append("repository.healthChanged", { check: "onboarding", healthy: false }, { repositoryId: id });
      this.#onboardingErrors.set(id, message);
      log.error("Repository onboarding failed", { repository: id }, error);
    }
  }

  /**
   * Reads every repository. A repository whose webhook Conveyor manages is read only at startup, and
   * then only the issues changed since Conveyor last saw it: its deliveries keep it current from there.
   * A repository without one (polling) is read in full at startup and on every periodic tick.
   */
  async reconcileAll(options: { skipFresh?: boolean } = {}): Promise<void> {
    let read = 0;
    for (const id of Object.keys(this.#deps.config.repositories)) {
      const managed = this.#deps.webhooks.url(id) !== null;
      if (options.skipFresh && managed) continue;
      await this.#reconcileOne(id, managed ? "changed" : "full");
      read += 1;
    }
    this.#deps.resumePurges();
    // A tick that read nothing changed nothing; startup always completes, even with no repository to read.
    if (options.skipFresh && read === 0) return;
    this.#lastReconciledAt = new Date().toISOString();
    this.#deps.store.events().append("service.reconciled", { failed: this.#repositoryErrors.size });
    this.#deps.interruptIneligibleRuns();
    this.#deps.recoverPendingScheduledAnswers();
  }

  /**
   * Runs one sync of a repository alone: syncs of the same repository run one at a time, different
   * repositories in parallel. A sync started from inside a locked sync of that repository joins it.
   */
  async withRepositoryLock<T>(repositoryId: string, sync: () => Promise<T>): Promise<T> {
    const held = this.#heldLocks.getStore();
    if (held?.has(repositoryId)) return sync();
    const previous = this.#locks.get(repositoryId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const next = previous.then(() => tail);
    this.#locks.set(repositoryId, next);
    await previous;
    try {
      return await this.#heldLocks.run(new Set([...(held ?? []), repositoryId]), sync);
    } finally {
      release();
      if (this.#locks.get(repositoryId) === next) this.#locks.delete(repositoryId);
    }
  }

  /** Runs work outside every repository lock the caller holds: work that outlives the sync must not inherit it. */
  outsideLocks<T>(work: () => T): T {
    return this.#heldLocks.exit(work);
  }

  /**
   * Reads one repository afresh, now: every issue, every enrolled item's provenance and author
   * permissions, relationships, pull request heads and CI, and the webhook's health. For an operator
   * who changed something GitHub sends no event for, such as a collaborator's permission.
   */
  syncRepository(repositoryId: string): Promise<{ issues: number; failed: boolean }> {
    this.#assertRepositoryActive(repositoryId);
    // A second click while a sync runs joins it rather than reading everything twice.
    const running = this.#syncs.get(repositoryId);
    if (running) return running;
    const sync = this.#runSync(repositoryId).finally(() => this.#syncs.delete(repositoryId));
    this.#syncs.set(repositoryId, sync);
    return sync;
  }

  /**
   * Creates an issue in an onboarded repository, enrolls it (the enrollment label puts it in the
   * backlog at the pipeline's start stage) and records it from the create response, with no
   * further request, so it shows in the item list. `repository` is a configured repository id or
   * its source address. A repeated call with the same `idempotencyKey` and repository returns the
   * first call's result instead of creating another issue.
   */
  createIssue(input: { repository: string; title: string; body: string; idempotencyKey?: string | undefined }): Promise<{ issueId: string; number: number; url: string }> {
    const title = input.title.trim();
    if (title === "") return Promise.reject(new CommandInputError("the issue title must not be empty"));
    const repositoryId = Object.entries(this.#deps.config.repositories).find(([id, repository]) => id === input.repository || repository.address === input.repository)?.[0];
    if (!repositoryId) return Promise.reject(new CommandInputError(`repository ${input.repository} is not onboarded`));
    this.#assertRepositoryActive(repositoryId);
    const key = input.idempotencyKey ? `${repositoryId}\u0000${input.idempotencyKey}` : null;
    if (key !== null) {
      const earlier = this.#createdIssues.get(key);
      if (earlier) return earlier;
    }
    const creation = this.#createIssueNow(repositoryId, title, input.body);
    if (key !== null) {
      this.#createdIssues.set(key, creation);
      // A failed creation made nothing, so a retry with the key may try again.
      creation.catch(() => { if (this.#createdIssues.get(key) === creation) this.#createdIssues.delete(key); });
    }
    return creation;
  }

  /**
   * Reads the source into the projection. `only` reads just those issues (one request each) and
   * touches nothing else, for work on one item; otherwise a listing, partial for a webhook pass.
   */
  reconcileRepository(repositoryId: string, options: { partial?: boolean; includeIssueNumbers?: readonly number[]; only?: readonly number[] } = {}): Promise<void> {
    return this.withRepositoryLock(repositoryId, () => this.#reconcileRepositoryLocked(repositoryId, options));
  }

  /** Reconciles one supplied source snapshot without issuing another source read. */
  reconcileSnapshot(repositoryId: string, issue: SourceIssue): Promise<void> {
    return this.withRepositoryLock(repositoryId, async () => {
      const repository = this.#deps.config.repositories[repositoryId];
      if (!repository) return;
      await reconcileRepository({ ...this.#reconcileInput(repositoryId, repository), issues: [issue] });
    });
  }

  /**
   * The projection's reaction to what a provider observed: the CI indicator first, so the board shows
   * a finished run within seconds, then the item the observation carries, or a reconcile of the items
   * it names. It runs in the background: a provider may count a delivery as failed after a few
   * seconds, and the event bus must not wait for the provider either.
   */
  reactToObservation(event: StoredEvent): void {
    const { config, store } = this.#deps;
    const repositoryId = event.repositoryId;
    if (!repositoryId || !config.repositories[repositoryId]) return;
    // A deleted or transferred issue is gone: purge its item now, synchronously, so its run is aborted
    // before anything makes another GitHub request, and without a read or a sync.
    if (isEventOf(event, "itemSource.itemChanged") && !event.payload.pullRequest && (event.payload.action === "deleted" || event.payload.action === "transferred")) {
      const gone = event.payload.number;
      for (const issue of store.listIssues(repositoryId)) {
        if (issue.sourceNumber === gone && issue.projectedState !== "unlisted") void this.#deps.purge(issue.id);
      }
      return;
    }
    const named = (numbers: readonly number[]) => {
      const wanted = new Set(numbers);
      return store.listIssues(repositoryId).filter((issue) => wanted.has(issue.sourceNumber));
    };
    const work = withEventContext({ actor: { kind: "webhook", id: event.actor.id } }, () => withCallSource("webhook", async () => {
      await this.#deps.applyCiEvent(repositoryId, event)
        .catch((error) => log.warn("CI indicator webhook update failed", { repository: repositoryId, event: event.type }, error));
      if (isEventOf(event, "itemSource.itemChanged")) {
        // A comment on a pull request changes nothing on the item's issue.
        if (event.payload.pullRequest) {
          this.#deps.refreshStatusComments(named(this.#issueNumbersFor(repositoryId, event)).map((issue) => issue.id));
          return;
        }
        const { item, actors } = event.payload;
        if (item && actors) {
          // An item source that reports no issue type or close reason leaves them out, which differs from null.
          const { stateReason, type, ...fields } = item;
          const issue: SourceIssue = { ...fields, ...(stateReason !== undefined ? { stateReason } : {}), ...(type !== undefined ? { type } : {}) };
          if (await this.#applyIssueDelivery(repositoryId, { issue, actors })) return;
        }
      }
      if (isEventOf(event, "code.changeUpdated") && event.payload.action === "closed" && event.payload.merged) {
        const numbers = this.#issueNumbersFor(repositoryId, event);
        for (const issue of named(numbers)) {
          await this.#deps.recoverClosedItem(repositoryId, issue);
        }
        this.#deps.refreshStatusComments(named(numbers).map((issue) => issue.id));
        return;
      }
      const issueNumbers = this.#issueNumbersFor(repositoryId, event);
      if (issueNumbers.length === 0) return;
      // CI and pull request events change no issue data: the indicator is updated above, a waiting
      // task reads the change itself, and the status comments of the items involved are refreshed.
      if (isEventOf(event, "ci.runUpdated") || isEventOf(event, "code.changeUpdated")) {
        // CI progress changes nothing the comment shows.
        if (isEventOf(event, "ci.runUpdated") && !event.payload.completed) return;
        this.#deps.refreshStatusComments(named(issueNumbers).map((issue) => issue.id));
        return;
      }
      if (isEventOf(event, "itemSource.relationsChanged")) this.#deps.forgetRelationships(repositoryId, event.payload.numbers);
      await this.#queueWebhookReconcile(repositoryId, issueNumbers);
    }));
    this.#webhookWork.add(work);
    void work.finally(() => this.#webhookWork.delete(work));
  }

  /** Resolves once every accepted webhook delivery has been processed. */
  async webhooksSettled(): Promise<void> {
    // A delivery's work starts from its event, and that work records events of its own.
    for (;;) {
      await this.#deps.eventsSettled();
      if (this.#webhookWork.size === 0) return;
      await Promise.all([...this.#webhookWork]);
    }
  }

  /** What every reconcile of a repository passes the reconciler. */
  #reconcileInput(repositoryId: string, repository: Repository) {
    const { config, store } = this.#deps;
    const pipeline = config.pipelines[repository.pipeline]!;
    return {
      store,
      configHash: config.hash,
      repository: { id: repositoryId, configName: repositoryId, source: repository.source, address: repository.address, folder: repository.folder },
      stages: pipeline.stages.map((stage) => stage.id),
      labels: config.labels,
      source: this.#deps.fencedSource(repositoryId),
      trust: this.#deps.trust,
      extraTrustedLogins: repository.extraTrustedLogins ?? [],
      expectedPostMergeClosure: (issueId: string) => store.hasMergedPullRequest(issueId),
      onLeft: (issueId: string) => { void this.#deps.purge(issueId); },
    } satisfies ReconcileRepositoryInput;
  }

  /**
   * Reads one repository. A full pass lists every issue; a `changed` pass lists only the issues
   * changed since Conveyor last saw the repository and reads relationships for those alone.
   */
  #reconcileOne(id: string, kind: "full" | "changed", options: { verifyTrust?: boolean } = {}): Promise<number> {
    return this.withRepositoryLock(id, () => this.#reconcileOneLocked(id, kind, options));
  }

  async #reconcileOneLocked(id: string, kind: "full" | "changed", options: { verifyTrust?: boolean }): Promise<number> {
    const { store } = this.#deps;
    const repository = this.#deps.config.repositories[id];
    if (!repository) return 0;
    try {
      await this.#deps.relabelOldPausedItems(id);
      // What Conveyor held before the read, so a `changed` pass re-reads relationships only for issues
      // GitHub reports changed (the listing overlaps the last read and returns some unchanged ones).
      const before = new Map(store.listIssues(id).map((issue) => [issue.id, { body: issue.body, sourceUpdatedAt: issue.sourceUpdatedAt }]));
      const listing = this.#issueListing(id, kind);
      const result = await reconcileRepository({
        ...this.#reconcileInput(id, repository),
        ...(options.verifyTrust ? { verifyTrust: true } : {}),
        ...(listing.since !== undefined ? { since: listing.since } : {}),
      });
      listing.finish();
      this.#deps.restoreFeedback(id);
      const since = listing.since;
      const scope = since === undefined
        ? null
        : new Set(store.listIssues(id).filter((issue) => issue.sourceUpdatedAt >= since && before.get(issue.id)?.sourceUpdatedAt !== issue.sourceUpdatedAt).map((issue) => issue.sourceNumber));
      // A paused repository may refresh its projection, but cannot reconcile work that would
      // mutate source state or discard a worktree.
      if (store.repositoryPause(id)) return result.seen;
      await this.#deps.reconcileRelationships(id, repository.address, scope);
      if (scope !== null) await this.#deps.backfillCiIndicators(id, scope);
      await this.#syncIssueFields(id, repository);
      this.#deps.wakeClearedFollowUps(id, new Map([...before].map(([issueId, previous]) => [issueId, previous.body])));
      this.#deps.restorePendingStatus(id);
      if (this.#repositoryErrors.delete(id)) store.events().append("repository.healthChanged", { check: "reconcile", healthy: true }, { repositoryId: id });
      store.events().append("repository.reconciled", { issueNumbers: scope === null ? null : [...scope] }, { repositoryId: id });
      return result.seen;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return 0;
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#repositoryErrors.has(id)) store.events().append("repository.healthChanged", { check: "reconcile", healthy: false }, { repositoryId: id });
      this.#repositoryErrors.set(id, message);
      log.error("Repository reconciliation failed", { repository: id }, error);
      return 0;
    } finally {
      // Visibility only informs operators, so a light pass leaves it to the next full one.
      if (kind === "full") await this.#recordTrustStatus(id, repository.address);
    }
  }

  /** Records source visibility for operators without changing any trust decision. */
  async #recordTrustStatus(id: string, address: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    try {
      const visibility = await this.#deps.source.repositoryVisibility(address);
      this.#deps.store.setRepositoryTrustStatus({ repositoryId: id, visibility, checkedAt, warning: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.store.setRepositoryTrustStatus({
        repositoryId: id,
        visibility: "unknown",
        checkedAt,
        warning: `Could not determine repository visibility: ${message}`,
      });
      log.warn("Repository trust status could not be determined", { repository: id }, error);
    }
  }

  async #createIssueNow(repositoryId: string, title: string, body: string): Promise<{ issueId: string; number: number; url: string }> {
    const { config } = this.#deps;
    const started = performance.now();
    const repository = config.repositories[repositoryId]!;
    const created = await this.#deps.fencedSource(repositoryId).createIssue({
      address: repository.address, title, body, labels: [config.labels.enrollment],
    });
    const forgeDone = performance.now();
    // The create call returned the issue's full current state: apply it as an `issues.opened`
    // delivery would, with no listing, permission, redelivery or ping request. A failure is
    // caught up by the next reconcile.
    await this.#applyCreatedIssue(repositoryId, created)
      .catch((error: unknown) => log.error("Recording the created issue failed", { repository: repositoryId, number: created.number }, error));
    const handedOff = performance.now();
    log.info("create_issue completed", {
      repository: repositoryId, number: created.number,
      forgeCreateMs: Math.round(forgeDone - started), recordMs: Math.round(handedOff - forgeDone), totalMs: Math.round(handedOff - started),
    });
    return { issueId: created.id, number: created.number, url: created.url };
  }

  /**
   * Records an issue Conveyor has just created from the object the create call returned. Conveyor
   * made it and enrolled it itself, so no permission lookup decides its trust.
   */
  async #applyCreatedIssue(repositoryId: string, created: SourceIssue): Promise<void> {
    const { store } = this.#deps;
    await this.withRepositoryLock(repositoryId, async () => {
      const repository = this.#deps.config.repositories[repositoryId];
      if (!repository) return;
      // A newer delivery or reconcile may have recorded the issue while the create call returned or
      // this waited for the lock: an older state changes nothing.
      const prior = store.listIssues(repositoryId).find((issue) => issue.sourceNumber === created.number);
      if (prior && Date.parse(prior.sourceUpdatedAt) > Date.parse(created.updatedAt)) return;
      const self = { login: "conveyor" };
      await reconcileRepository({
        ...this.#reconcileInput(repositoryId, repository),
        trust: { isTrusted: async () => true },
        issues: [created],
        delivered: new Map([[created.number, { enrollment: self, title: self, body: self }]]),
      });
      this.#deps.interruptIneligibleRuns();
      store.events().append("repository.reconciled", { issueNumbers: [created.number] }, { repositoryId });
      this.#deps.schedule();
    });
  }

  async #runSync(repositoryId: string): Promise<{ issues: number; failed: boolean }> {
    const { config, store } = this.#deps;
    // A sync reads everything again: nothing held about the repository is reused.
    this.#deps.source.forgetRepository?.(config.repositories[repositoryId]!.address);
    this.#deps.forgetRelationships(repositoryId, store.listIssues(repositoryId).map((issue) => issue.sourceNumber));
    await this.#reconcileOne(repositoryId, "full", { verifyTrust: true });
    await this.#deps.backfillCiIndicators(repositoryId);
    if (this.#deps.webhooks.url(repositoryId)) {
      await this.#deps.webhooks.redeliverMissed(repositoryId);
      await this.#deps.webhooks.ping(repositoryId);
    }
    this.#deps.interruptIneligibleRuns();
    this.#deps.schedule();
    const issues = store.listIssues(repositoryId);
    this.#deps.refreshStatusComments(issues.map((issue) => issue.id));
    const failed = this.#repositoryErrors.has(repositoryId);
    log.info("Repository synced", { repository: repositoryId, issues: issues.length, failed });
    return { issues: issues.length, failed };
  }

  /** Read the configured issue-field values of enrolled issues that changed since they were last read. */
  async #syncIssueFields(repositoryId: string, repository: Repository): Promise<void> {
    const { config, store } = this.#deps;
    const refinement = repository.refinement;
    if (!refinement || refinement.fields.length === 0) return;
    for (const issue of store.listIssues(repositoryId)) {
      if (issue.sourceState !== "open" || !issue.labels.includes(config.labels.enrollment)) continue;
      if (issue.metadata.fieldsSyncedAt === issue.sourceUpdatedAt) continue;
      try {
        const values = await this.#deps.source.getIssueFieldValues(repository.address, issue.sourceNumber);
        const configured = Object.fromEntries(Object.entries(values).filter(([name]) =>
          refinement.fields.some((field) => field.toLocaleLowerCase() === name.toLocaleLowerCase())));
        store.setIssueMetadata(issue.id, { fields: configured, fieldsSyncedAt: issue.sourceUpdatedAt });
      } catch (error) {
        log.warn("Issue field sync failed", this.#deps.itemFields(issue.id), error);
        continue;
      }
    }
  }

  /**
   * `full` lists every issue. `changed` lists the issues changed since Conveyor last saw the
   * repository: since its previous listing in this run, or after a restart since the newest change it
   * stored. `finish` records a successful read.
   */
  #issueListing(repositoryId: string, mode: "full" | "changed"): { since?: string; finish(): void } {
    const startedAt = Date.now();
    const since = mode === "changed" ? this.#issueListings.get(repositoryId)?.since ?? this.#storedSince(repositoryId) : undefined;
    return {
      ...(since !== undefined ? { since } : {}),
      finish: () => this.#issueListings.set(repositoryId, { since: new Date(startedAt - ISSUE_LISTING_OVERLAP_MS).toISOString() }),
    };
  }

  /** Just before the newest change Conveyor stored for a repository; undefined when it stored none. */
  #storedSince(repositoryId: string): string | undefined {
    let newest = Number.NEGATIVE_INFINITY;
    for (const issue of this.#deps.store.listIssues(repositoryId)) newest = Math.max(newest, Date.parse(issue.sourceUpdatedAt));
    return Number.isFinite(newest) ? new Date(newest - ISSUE_LISTING_OVERLAP_MS).toISOString() : undefined;
  }

  async #reconcileRepositoryLocked(repositoryId: string, options: { partial?: boolean; includeIssueNumbers?: readonly number[]; only?: readonly number[] }): Promise<void> {
    const { store } = this.#deps;
    const repository = this.#deps.config.repositories[repositoryId];
    if (!repository) return;
    if (options.only) {
      await this.#refreshIssues(repositoryId, options.only);
      return;
    }
    const followUpBodies = this.#followUpBodies(repositoryId);
    const listing = this.#issueListing(repositoryId, options.partial === true ? "changed" : "full");
    await reconcileRepository({
      ...this.#reconcileInput(repositoryId, repository),
      ...(listing.since !== undefined ? { since: listing.since } : {}),
      ...(options.includeIssueNumbers !== undefined ? { includeIssueNumbers: options.includeIssueNumbers } : {}),
    });
    listing.finish();
    this.#deps.restoreFeedback(repositoryId);
    if (store.repositoryPause(repositoryId)) return;
    const scope = options.includeIssueNumbers ? new Set(options.includeIssueNumbers) : null;
    await this.#deps.reconcileRelationships(repositoryId, repository.address, scope);
    await this.#deps.backfillCiIndicators(repositoryId, scope);
    this.#deps.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.#deps.restorePendingStatus(repositoryId);
    this.#deps.interruptIneligibleRuns();
    store.events().append("repository.reconciled", { issueNumbers: options.includeIssueNumbers ? [...options.includeIssueNumbers] : null }, { repositoryId });
  }

  /** Reads the named issues of a repository and updates only them: one request per issue, no listing. */
  async #refreshIssues(repositoryId: string, numbers: readonly number[]): Promise<void> {
    const { store } = this.#deps;
    const repository = this.#deps.config.repositories[repositoryId];
    if (!repository) return;
    const followUpBodies = this.#followUpBodies(repositoryId);
    const issues = (await Promise.all([...new Set(numbers)].map(async (number) => {
      try {
        return await this.#deps.source.getIssue(repository.address, number);
      } catch (error) {
        if (!isIssueGone(error)) throw error;
        // 404/410: the issue is gone, which is the same as having no Conveyor labels.
        const stored = store.listIssues(repositoryId).find((issue) => issue.sourceNumber === number);
        if (stored && stored.projectedState !== "unlisted") void this.#deps.purge(stored.id);
        return null;
      }
    }))).filter((issue) => issue !== null);
    await reconcileRepository({
      ...this.#reconcileInput(repositoryId, repository),
      issues,
      // Conveyor's own label writes move updated_at but change neither enrollment nor text. Anyone
      // else's change arrives as a delivery that names them, so a trusted item keeps its decision.
      ...(this.#deps.webhooks.url(repositoryId)
        ? { delivered: new Map(numbers.map((number) => [number, { enrollment: "unchanged", title: "unchanged", body: "unchanged" } as const])) }
        : {}),
    });
    this.#deps.restoreFeedback(repositoryId);
    if (store.repositoryPause(repositoryId)) return;
    const scope = new Set(numbers);
    await this.#deps.reconcileRelationships(repositoryId, repository.address, scope);
    this.#deps.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.#deps.restorePendingStatus(repositoryId);
    this.#deps.interruptIneligibleRuns();
    store.events().append("repository.reconciled", { issueNumbers: [...scope] }, { repositoryId });
  }

  #followUpBodies(repositoryId: string): Map<string, string> {
    return new Map(this.#deps.store.listIssues(repositoryId).map((issue) => [issue.id, issue.body]));
  }

  /**
   * Applies the item an observation carries, with no request to the item source: the plugin read the
   * item's current state and who made the change from the delivery. An observation that cannot stand
   * in for a read (a transfer, an unknown action) carries no item, and the caller reads it instead.
   */
  async #applyIssueDelivery(repositoryId: string, change: DeliveredIssue): Promise<boolean> {
    const repository = this.#deps.config.repositories[repositoryId];
    if (!repository) return false;
    return this.withRepositoryLock(repositoryId, () => this.#applyIssueDeliveryLocked(repositoryId, repository, change));
  }

  async #applyIssueDeliveryLocked(repositoryId: string, repository: Repository, change: DeliveredIssue): Promise<boolean> {
    const { store } = this.#deps;
    const number = change.issue.number;
    const prior = store.listIssues(repositoryId).find((issue) => issue.sourceNumber === number);
    const followUpBodies = this.#followUpBodies(repositoryId);
    // Deliveries can arrive out of order: an older state of the issue changes nothing.
    if (prior && Date.parse(prior.sourceUpdatedAt) > Date.parse(change.issue.updatedAt)) return true;
    await reconcileRepository({
      ...this.#reconcileInput(repositoryId, repository),
      issues: [change.issue],
      delivered: new Map([[number, change.actors]]),
    });
    this.#deps.restoreFeedback(repositoryId);
    // A run that must not go on (the item was closed, paused, left Conveyor) stops before closed-item
    // recovery makes any GitHub call for it.
    await this.#deps.runsEnded(this.#deps.interruptIneligibleRuns());
    const applied = store.listIssues(repositoryId).find((issue) => issue.sourceNumber === number);
    if (change.issue.state === "closed" && applied) await this.#deps.recoverClosedItem(repositoryId, applied, change.issue);
    if (store.repositoryPause(repositoryId)) return true;
    this.#deps.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.#deps.restorePendingStatus(repositoryId);
    this.#deps.interruptIneligibleRuns();
    store.events().append("repository.reconciled", { issueNumbers: [number] }, { repositoryId });
    this.#deps.schedule();
    if (applied) this.#deps.refreshStatusComments([applied.id]);
    return true;
  }

  /** The issue numbers whose status a GitHub event may change; a pull request names its item's issue. */
  #issueNumbersFor(repositoryId: string, event: StoredEvent): number[] {
    const { store } = this.#deps;
    const forPullRequests = (numbers: readonly number[]) => {
      const wanted = new Set(numbers);
      return store.listIssues(repositoryId).flatMap((issue) => {
        const pullRequest = store.getCurrentPullRequest(issue.id);
        return pullRequest && wanted.has(pullRequest.number) ? [issue.sourceNumber] : [];
      });
    };
    if (isEventOf(event, "itemSource.itemChanged")) return event.payload.pullRequest ? forPullRequests([event.payload.number]) : [event.payload.number];
    if (isEventOf(event, "itemSource.relationsChanged")) return event.payload.numbers;
    if (isEventOf(event, "code.changeUpdated")) return forPullRequests([event.payload.number]);
    if (isEventOf(event, "ci.runUpdated")) return forPullRequests(event.payload.changes);
    return [];
  }

  /**
   * Reconciles a repository for webhook deliveries, one pass at a time. Deliveries arriving while a
   * pass waits to start join it, so a burst of deliveries costs one or two passes rather than one each.
   * Only the status comments of the issues the deliveries name are refreshed.
   */
  #queueWebhookReconcile(repositoryId: string, issueNumbers: number[] | null): Promise<void> {
    const queued = this.#queuedWebhookReconciles.get(repositoryId);
    if (queued) {
      if (issueNumbers === null) queued.issueNumbers = null;
      else for (const issueNumber of issueNumbers) queued.issueNumbers?.add(issueNumber);
      return queued.done;
    }
    const entry: { issueNumbers: Set<number> | null; done: Promise<void> } = {
      issueNumbers: issueNumbers === null ? null : new Set(issueNumbers),
      done: Promise.resolve(),
    };
    this.#queuedWebhookReconciles.set(repositoryId, entry);
    const previous = this.#webhookReconciles.get(repositoryId) ?? Promise.resolve();
    entry.done = previous.then(async () => {
      // Deliveries from here on queue the next pass: this one may already have read past them.
      this.#queuedWebhookReconciles.delete(repositoryId);
      if (this.#deps.shuttingDown()) return;
      await this.reconcileRepository(repositoryId, {
        partial: true,
        ...(entry.issueNumbers === null ? {} : { includeIssueNumbers: [...entry.issueNumbers] }),
      });
      this.#deps.schedule();
      const issues = this.#deps.store.listIssues(repositoryId);
      this.#deps.refreshStatusComments((entry.issueNumbers === null
        ? issues
        : issues.filter((issue) => entry.issueNumbers!.has(issue.sourceNumber))).map((issue) => issue.id));
    }).catch((error) => log.error("Repository reconciliation failed", { repository: repositoryId }, error));
    this.#webhookReconciles.set(repositoryId, entry.done);
    void entry.done.then(() => {
      if (this.#webhookReconciles.get(repositoryId) === entry.done) this.#webhookReconciles.delete(repositoryId);
    });
    return entry.done;
  }

  /** Rejects an operation that would mutate the paused repository's source. */
  #assertRepositoryActive(repositoryId: string): void {
    if (this.#deps.store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
  }
}
