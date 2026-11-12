import { randomUUID } from "node:crypto";

import { redactSecrets } from "../config/compose";
import { log, type LogFields } from "../log/logger";
import { applyRetention, type RetentionPolicy, type RetentionReport } from "./retention";
import type { StageOutcome } from "../engine/stage-executor";
import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import { RepositoryPausedError } from "../core/repository-pause";
import type { SchedulerCandidate } from "../core/scheduler";
import { applyClosedItemOffboarding, applyStageTransition } from "../core/transition";
import { ConveyorStore, type StoredIssue } from "../db/store";
import type { Harness, SteeringRunInput, SteeringRunResult } from "../harness/types";
import { DEFAULT_CI_TYPE, pluginContext, PluginRegistry, type WebhookReceipt } from "../core/plugins";
import type { ItemSourceClient } from "../source/client";
import { followUpsFromBody } from "../source/managed-sections";
import { RepositoryActorTrust } from "../source/trust";
import type { SourceIssue } from "../source/types";
import type { CiChange, CiProvider, CiRun } from "./ci-provider";
import { CodeHostRegistry } from "../codehost/registry";
import type { ChangeDelivery, CodeHost } from "../codehost/types";
import { changeAction, pushAndEnsureChange, recoverClosedChange } from "../codehost/actions";
import { dispatchTool } from "../tasks/dispatch";
import { WorkspaceManager } from "../workspace/manager";
import { displayName, formatDuration } from "../web/format";
import type { IssueJourneyViewModel, IssueWaitingViewModel } from "../web/types";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type ScopedMcpLease, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";
import { infrastructureRetry, isUsageLimitError } from "./retry-policy";
import { classifyUpstreamError } from "../tasks/upstream-error";
import { createTaskRegistry } from "../tasks/catalogue";
import { TransientScriptError } from "../tasks/contract";
import type { TaskDeps } from "../tasks/deps";
import { criteriaOf, ISSUE_LEFT_OPEN_MARKER } from "../tasks/item";
import { isCriterionApprovedAt } from "../db/review-records";
import { compilePipeline } from "../tasks/plan";
import { cliGit } from "../workspace/git";
import { removeWorkspace } from "../workspace/lifecycle";
import { AdvisoryCiWatches, DEFAULT_POLL_MS as ADVISORY_POLL_MS } from "./advisory-ci";
import { buildRepositorySummaries, type RepositorySummaries } from "./repository-summary";
import { isLightweightRepositoryStage } from "./stage-capacity";
import { remainingWorkStartsProcess } from "../engine/remaining-work";
import { CI_INDICATOR_ID, observeCi, observeCiError, startCiForHead } from "./indicators";
import { createCiGateMemory, evaluateCiGate, parseCiGateOptions, type SourceActionOutcome } from "./ci-gate";
import { conversationQuestionAnswer } from "../questions";
import type { ManualGateApprovals } from "../db/manual-gates";
import { CommandBus, CommandForbiddenError, CommandInputError, type CommandActor } from "../commands/bus";
import { EventBus } from "../events/bus";
import { JsonlEventSink, SinkRunner, type EventSink } from "../events/sinks";
import { isEventOf, type EventPayload, type EventType, type StoredEvent } from "../events/catalogue";
import { withEventContext } from "../events/context";
import type { WaitKind } from "../events/topics";
import { metadataLabels, QuestionAnswers } from "./question-answers";
import { Admission } from "./admission";
import { latestStopReason } from "./item-history";
import { ItemPurges } from "./purge";
import { McpGrants } from "./mcp-grants";
import { RepositorySync } from "./repository-sync";
import { ItemRetries } from "./retry";
import { Rollups } from "./rollups";
import { Scheduler } from "./scheduler";
import { Steering, STOP_SUMMARY_TIMEOUT_MS } from "./steering";
import { StatusCommentWriter } from "./status-comments";
import { WaitDispatcher } from "./wait-dispatcher";
import { WebhookSupervisor } from "./webhook-supervisor";
import type { ActiveWork, ControlSources, GitHubCallReport, StartupStatus } from "./control-sources";
import type { DashboardSources, LiveIssueStatus } from "./dashboard-sources";
import type { WebSources } from "./web-sources";
import { CALL_SOURCES, CallMeter, withCallSource, type CallSource, type ProviderCallMeter } from "../source/calls";
import type { FindingType } from "../db/review-findings";
import { BOARD_APPROVAL_TASK_ID, ENTRY_APPROVAL_TASK_ID, type BoardApprovalResolver, type ManualGateResolver, type ManualGateWaitingNotifier } from "../engine/stage-executor";

const FOLLOW_UP_GATE_TASK = "item.followUps";
const CLOSED_ITEM_RECOVERY_AGE_MS = 60 * 60 * 1000;

/** Code host methods that change a change or its branch; each drops what was read about the repository's changes. */
const CODE_HOST_WRITES = new Set([
  "pushBranch", "ensureChange", "mergeChange", "setChangeChecklist", "setChangeDescription",
  "createFinding", "resolveFindingProjection", "resolveNativeFinding", "deleteBranch",
]);

/** Item source methods that change a source repository; each is refused while the repository is paused. */
const SOURCE_WRITES = new Set<string>([
  "setIssueType", "setIssueFieldValues", "setTitle", "setParent", "setDependencies",
  "replaceConveyorLabels", "replaceManagedProjectLabels", "upsertStatusComment", "addComment",
  "updateManagedSection", "closeIssue", "createChildIssue", "createIssue", "ensureLabels", "ensureWebhook",
  "pingHook", "redeliverHookDelivery",
] satisfies ReadonlyArray<keyof ItemSourceClient>);


interface ActiveRun {
  repositoryId: string;
  stageId: string;
  controller: AbortController;
  /** Runs no runner process; excluded from global and repository permits. */
  lightweight: boolean;
  /** Holds a runner but no repository permit: only checks remain. */
  gateOnly: boolean;
  interrupted: boolean;
  /** The executor returned: the agent process is gone, though the run may still be reconciling. */
  executorDone: boolean;
}

interface ServiceImplementations {
  /** Runs the Operator instead of the steering agent's harness. */
  steering?: (input: SteeringRunInput) => Promise<SteeringRunResult>;
  /** The registered plugins: CI providers, and the code hosts and harnesses unless given below. */
  plugins?: PluginRegistry;
  codeHosts?: CodeHostRegistry;
  /** Agent harnesses by runner type; by default the registered harness plugins. */
  harnesses?: Record<string, Harness>;
  /** How long a stop-summary run may take; ten minutes by default. */
  stopSummaryTimeoutMs?: number;
  /** Counts the item source's requests to its provider; a fresh meter when it has none. */
  githubCalls?: ProviderCallMeter;
  /** Event sinks beyond the configured ones (an embedding application's own consumers). */
  eventSinks?: EventSink[];
}

const SOURCE_GUIDANCE = `GitHub is the source of truth. Use only Conveyor MCP tools for source mutations. Agents never close source issues; Conveyor itself closes only an active completed roll-up parent after its descendant-completion rule passes. Preserve human-authored body text, use managed sections for acceptance criteria, pull-request descriptions, and dependencies, and report blockers with a concrete reason.`;
/** Changes that can make an item runnable; the scheduler runs after them. */
// Reconciles and stage runs schedule as part of the scheduler's own loop; these are the changes a
// person's action makes that can let an item run.
const SCHEDULING_EVENTS: readonly EventType[] = [
  "task.woken", "worker.released", "item.requeued", "gate.requirementChanged", "gate.boardApprovalChanged", "command.accepted",
];
/** How often the GitHub request counts are logged, and the window they cover. */
const GITHUB_CALL_SUMMARY_MS = 60 * 60_000;

/** True when the error, or anything in its cause chain, is a stage script's temporary failure. */
function hasTransientScriptCause(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth += 1) {
    if (error instanceof TransientScriptError) return true;
    error = error.cause;
  }
  return false;
}

export class ConveyorService {
  readonly store: ConveyorStore;
  readonly itemSource: ItemSourceClient;
  readonly #codeHosts: CodeHostRegistry;
  readonly workspaceManager: WorkspaceManager;
  readonly #active = new Map<string, ActiveRun>();
  /** Purges of items that left Conveyor. */
  readonly #purges: ItemPurges;
  /** Answers to agents' questions and the work each answer starts. */
  readonly #answers: QuestionAnswers;
  /** Each enrolled item's status comment on the source. */
  readonly #statusComments: StatusCommentWriter;
  /** The live head of an open change, as last read from the code host; newer than the persisted context. */
  readonly #liveChangeHeads = new Map<string, string>();
  /** Called when process-local state the dashboard shows changes without a recorded event (the GitHub outage). */
  readonly #liveStateListeners = new Set<() => void>();
  /** Called once when the service starts closing, so what reads it stops first. */
  readonly #closeListeners = new Set<() => void>();
  /** Consecutive infrastructure failures per issue, for the stage they happened in. */
  readonly #infrastructureFailures = new Map<string, {
    stageId: string;
    count: number;
    waiting?: IssueWaitingViewModel;
  }>();
  /** The running GitHub outage: when the first waiting item failed and which items wait on it. */
  /** Failure records armed by the outage wait: their retry timer probes GitHub instead of resuming blindly. */
  #outageRecords = new WeakSet<object>();
  /** Failure records of items waiting on a script's temporary failure: the retry runs the script again, with no probe. */
  #scriptWaitRecords = new WeakSet<object>();
  #githubOutage: { since: string; waitingItems: Set<string> } | null = null;
  /** Delayed infrastructure retries that must not outlive the service store. */
  readonly #retryTimers = new Set<ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #periodicOperatorTimer: ReturnType<typeof setInterval> | null = null;
  readonly #ciMemory = createCiGateMemory();
  readonly #ciProviders = new Map<string, CiProvider>();
  /** Fires an advisory CI poll at the earliest wake-up of an active watch. */
  #advisoryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #advisoryWatches: AdvisoryCiWatches;
  #advisoryPolling = false;
  #shuttingDown = false;
  #tickRunning = false;
  /** Drains, repository pauses and item pauses. */
  readonly #admission: Admission;
  /** Retries of stopped items. */
  readonly #retries: ItemRetries;
  /** Relationships, roll-up stages and completion. */
  readonly #rollups: Rollups;
  #retentionTimer: ReturnType<typeof setInterval> | null = null;
  #retentionActive = 0;
  #githubCallTimer: ReturnType<typeof setInterval> | null = null;
  /** Counts every GitHub request this service makes, by why it was made. */
  readonly githubCalls: ProviderCallMeter;
  /** Every committed change, published in order after its transaction; subscribers react to them. */
  readonly events: EventBus;
  /** The only way the dashboard and the CLI change anything. */
  readonly commands: CommandBus;
  /** Configured event sinks, delivered from their own cursors while the service runs. */
  readonly #sinks: SinkRunner[];
  /** The managed webhooks: registration, health and redelivery of missed deliveries. */
  readonly #webhooks: WebhookSupervisor;
  readonly #waitDispatcher: WaitDispatcher;
  readonly #harnesses: Record<string, Harness>;
  readonly #plugins: PluginRegistry;
  readonly #manualGateApprovals: ManualGateApprovals;
  /** Onboarding, the startup pass, reconciles, syncs, created and delivered items. */
  readonly #sync: RepositorySync;
  /** Admission of items to stage runs, their wake-ups and their live status. */
  readonly #scheduler: Scheduler;
  /** The agents' run-scoped MCP grants and their tool calls. */
  readonly #mcp: McpGrants;
  /** Steering runs, scheduled Operator checks and stop summaries. */
  readonly #steering: Steering;

  constructor(
    readonly config: ConveyorConfig,
    store: ConveyorStore,
    itemSource: ItemSourceClient,
    implementations: ServiceImplementations = {},
  ) {
    this.store = store;
    this.itemSource = itemSource;
    this.#plugins = implementations.plugins ?? new PluginRegistry([], pluginContext(config));
    this.#webhooks = new WebhookSupervisor({
      config,
      plugins: this.#plugins,
      store,
      source: itemSource,
      fencedSource: (repositoryId) => this.executionSource(repositoryId),
      timerFired: () => this.#timerFired("webhook-health"),
    });
    this.#statusComments = new StatusCommentWriter({
      config,
      store,
      source: (repositoryId) => this.executionSource(repositoryId),
      refreshChangeHead: (issue) => this.refreshLiveChangeHead(issue),
      criteria: (issue) => this.criterionApprovalStates(issue),
      status: (issue) => this.#scheduler.status(issue),
      stopReason: (issueId) => latestStopReason(this.store, issueId),
    });
    this.#answers = new QuestionAnswers({
      config,
      store,
      source: (repositoryId) => this.executionSource(repositoryId),
      wakeParkedAgent: (question) => this.wakeParkedAgent(question),
      schedule: () => this.schedule(),
      reconcile: (repositoryId, sourceNumber) => this.reconcileRepository(repositoryId, { only: [sourceNumber] }),
      updateStatusComment: (issueId) => this.updateStatusComment(issueId),
      shuttingDown: () => this.#shuttingDown,
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#purges = new ItemPurges({
      config: { repositories: config.repositories, artifacts: config.settings.artifacts },
      store,
      source: itemSource,
      workspaces: () => this.workspaceManager,
      interrupt: (issueId) => { this.#active.get(issueId)?.controller.abort(); },
      runsEnded: (issueIds) => this.runsEnded(issueIds),
      shuttingDown: () => this.#shuttingDown,
      schedule: () => this.schedule(),
    });
    this.#admission = new Admission({
      config: { labels: config.labels, labelPrefix: config.settings.labelPrefix, repositories: config.repositories },
      store,
      source: itemSource,
      fencedSource: (repositoryId) => this.executionSource(repositoryId),
      running: () => [...this.#active].map(([issueId, active]): [string, string] => [issueId, active.stageId]),
      isRunning: (issueId) => this.#active.has(issueId),
      schedule: () => this.schedule(),
      eventsSettled: () => this.eventsSettled(),
      reconcile: (repositoryId, sourceNumber) => this.reconcileRepository(repositoryId, { only: [sourceNumber] }),
      interruptIneligibleRuns: () => { this.interruptIneligibleRuns(); },
      recoverClosedItem: (repositoryId, issue) => this.recoverClosedItem(repositoryId, issue),
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#retries = new ItemRetries({
      config: { labels: config.labels, repositories: config.repositories, pipelines: config.pipelines, hash: config.hash, labelPrefix: config.settings.labelPrefix },
      store,
      source: itemSource,
      fencedSource: (repositoryId) => this.executionSource(repositoryId),
      hasLiveRun: (issueId) => this.hasLiveIssueRun(issueId),
      isRunning: (issueId) => this.#active.has(issueId),
      stageCreatesChildren: (repositoryId, stageId) => this.stageCreatesChildren(repositoryId, stageId),
      reconcile: (repositoryId, sourceNumber) => this.reconcileRepository(repositoryId, { only: [sourceNumber] }),
      eventsSettled: () => this.eventsSettled(),
      scheduledCheck: (runId) => this.#steering.scheduledCheck(runId),
    });
    this.#rollups = new Rollups({
      config: { labels: config.labels, repositories: config.repositories, pipelines: config.pipelines, hash: config.hash, labelPrefix: config.settings.labelPrefix },
      store,
      source: itemSource,
      fencedSource: (repositoryId) => this.executionSource(repositoryId),
      webhookHealthy: (repositoryId) => Boolean(this.webhookUrl(repositoryId)),
      runningIssueIds: () => this.#active.keys(),
      hasLiveRun: (issueId) => this.hasLiveIssueRun(issueId),
      stageCreatesChildren: (repositoryId, stageId) => this.stageCreatesChildren(repositoryId, stageId),
      childCreationRetryQueued: (issue, stageId) => this.childCreationRetryQueued(issue, stageId),
      hasResumableQuestionExecution: (issueId) => this.hasResumableQuestionExecution(issueId),
      hasWaitingFollowUp: (issue) => this.hasWaitingFollowUp(issue),
      workspaces: () => this.workspaceManager,
      reconcile: (repositoryId, sourceNumber) => this.reconcileRepository(repositoryId, { only: [sourceNumber] }),
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#codeHosts = implementations.codeHosts ?? this.#plugins.codeHosts();
    this.githubCalls = implementations.githubCalls ?? new CallMeter();
    this.events = new EventBus();
    store.events().attach(this.events);
    this.commands = new CommandBus(store.events());
    this.#waitDispatcher = new WaitDispatcher({
      journal: store.executions(),
      addressOf: (repositoryId) => config.repositories[repositoryId]?.address ?? null,
      numberOf: (issueId) => store.getIssue(issueId)?.sourceNumber ?? null,
      wake: (issueId) => { this.wakeParked(issueId); },
    });
    this.registerCommands();
    this.subscribeToEvents();
    const logging = config.settings.logging;
    const sinks: EventSink[] = [
      ...(config.settings.events?.sinks ?? []).map((sink) => new JsonlEventSink(sink.path, {
        maxBytes: (logging?.maxFileMegabytes ?? 10) * 1024 * 1024, keepFiles: logging?.keepFiles ?? 5,
        selection: { classes: sink.classes, content: sink.includeContent },
      })),
      ...(implementations.eventSinks ?? []),
    ];
    this.#sinks = sinks.map((sink) => new SinkRunner(store.events(), sink));
    this.workspaceManager = new WorkspaceManager(config.settings.workspaces);
    this.#harnesses = implementations.harnesses ?? this.#plugins.harnesses();
    this.#manualGateApprovals = store.manualGates();
    this.#sync = new RepositorySync({
      config,
      store,
      source: itemSource,
      fencedSource: (repositoryId) => this.executionSource(repositoryId),
      trust: new RepositoryActorTrust(itemSource),
      webhooks: this.#webhooks,
      purge: (issueId) => this.purgeItem(issueId),
      resumePurges: () => this.#purges.resume(),
      interruptIneligibleRuns: () => this.interruptIneligibleRuns(),
      runsEnded: (issueIds) => this.runsEnded(issueIds),
      schedule: () => this.schedule(),
      refreshStatusComments: (issueIds) => this.refreshStatusComments(issueIds),
      restoreFeedback: (repositoryId) => this.#retries.restoreFeedback(repositoryId),
      relabelOldPausedItems: (repositoryId) => this.#admission.relabelOldPausedItems(repositoryId),
      reconcileRelationships: (repositoryId, address, scope) => this.reconcileRelationships(repositoryId, address, scope),
      forgetRelationships: (repositoryId, numbers) => this.#rollups.forget(repositoryId, numbers),
      backfillCiIndicators: (repositoryId, scope) => this.backfillCiIndicators(repositoryId, scope),
      applyCiEvent: (repositoryId, event) => this.applyCiEvent(repositoryId, event),
      wakeClearedFollowUps: (repositoryId, before) => this.wakeClearedFollowUps(repositoryId, before),
      restorePendingStatus: (repositoryId) => this.restorePendingStatus(repositoryId),
      recoverClosedItem: (repositoryId, issue, delivered) => this.recoverClosedItem(repositoryId, issue, delivered),
      recoverPendingScheduledAnswers: () => this.#answers.recoverPendingScheduled(),
      recoverWorkspaceScratch: () => this.recoverWorkspaceScratch(),
      eventsSettled: () => this.eventsSettled(),
      shuttingDown: () => this.#shuttingDown,
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#scheduler = new Scheduler({
      config,
      store,
      running: () => this.#active,
      shuttingDown: () => this.#shuttingDown,
      draining: () => this.#admission.current !== null,
      repositoryReady: (repositoryId) => this.#sync.repositoryReady(repositoryId),
      isLightweightStage: (repositoryId, stageId) => this.isLightweightStage(repositoryId, stageId),
      isSkippedStage: (repositoryId, stageId) => this.isSkippedStage(repositoryId, stageId),
      isGateOnlyExecution: (issueId, repositoryId, stageId) => this.isGateOnlyExecution(issueId, repositoryId, stageId),
      hasResumableQuestionExecution: (issueId) => this.hasResumableQuestionExecution(issueId),
      childCreationRetryQueued: (issue, stageId) => this.childCreationRetryQueued(issue, stageId),
      schedulePass: () => this.schedule(),
      launch: (issue, candidate) => this.launch(issue, candidate),
      refreshStatusComments: (issueIds) => this.refreshStatusComments(issueIds),
      timerFired: () => this.#timerFired("wake"),
    });
    this.#steering = new Steering({
      config,
      store,
      source: itemSource,
      harnesses: this.#harnesses,
      runSteering: implementations.steering,
      stopSummaryTimeoutMs: implementations.stopSummaryTimeoutMs ?? STOP_SUMMARY_TIMEOUT_MS,
      lease: (runId, workspace, allowedTools, stopSummary) => this.steeringMcpLease(runId, workspace, allowedTools, stopSummary),
      lastReconciledAt: () => this.#sync.lastReconciledAt,
      reconcileErrors: () => this.#sync.reconcileErrors,
      onboardingErrors: () => this.#sync.onboardingErrors,
      shuttingDown: () => this.#shuttingDown,
      draining: () => this.#admission.current !== null,
      manualGateViews: (issue) => this.manualGateViews(issue),
      loadDeliveryState: (issueId, address) => this.loadDeliveryState(issueId, address),
      retry: (itemId, note, username) => this.retryIssue(itemId, note, username),
      scheduledRetry: (runId, itemId, note, evidence) => this.#retries.scheduledRetry(runId, itemId, note, evidence),
      answerQuestion: (questionId, answer, source, evidence) => this.answerQuestion(questionId, answer, source, evidence),
      reorderBacklog: (issueId, direction) => this.reorderBacklog(issueId, direction),
      moveBacklogIssue: (issueId, beforeIssueId) => this.moveBacklogIssue(issueId, beforeIssueId),
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#mcp = new McpGrants({
      config,
      store,
      issueTaskDeps: (issueId, repository) => this.taskDeps(issueId, repository),
      operatorTools: (runId, stopSummary) => this.#steering.operatorTools(runId, stopSummary),
      forgetChange: (issueId, address) => this.forgetChange(issueId, address),
      loadDeliveryState: (issueId, address) => this.loadDeliveryState(issueId, address),
      updateStatusComment: (issueId) => this.updateStatusComment(issueId),
      itemFields: (issueId) => this.itemFields(issueId),
    });
    this.#advisoryWatches = new AdvisoryCiWatches(store.advisoryWatchStore(), store.executions(), {
      resolve: (repositoryId) => ({
        provider: this.ciProvider(repositoryId),
        address: this.config.repositories[repositoryId]?.address ?? "",
        ignoreChecks: this.config.repositories[repositoryId]?.ci.ignoreChecks ?? [],
      }),
      post: (itemId, stage, message) => {
        this.store.appendConversationMessage({
          issueId: itemId, runId: null, stageId: stage, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator", message,
        });
      },
      observe: (watch, observation) => {
        const base = {
          issueId: watch.itemId, headSha: watch.headSha, changeUrl: watch.changeUrl,
          ignoreChecks: this.config.repositories[watch.repositoryId]?.ci?.ignoreChecks ?? [], now: new Date(), authoritative: false,
        };
        if ("runs" in observation) observeCi(this.store, { ...base, runs: observation.runs });
        else observeCiError(this.store, { ...base, error: observation.error });
      },
      onError: (watch, error) => log.warn("Advisory CI watch failed", { ...this.itemFields(watch.itemId), commit: watch.headSha.slice(0, 7) }, error),
      // A finished run wakes a watch; while webhooks deliver, reading CI on a timer is only the fallback.
      pollMs: (repositoryId) => this.waitFallbackMs(repositoryId, "ci") ?? ADVISORY_POLL_MS,
    });
  }

  static async create(
    config: ConveyorConfig,
    itemSource: ItemSourceClient,
    implementations: Pick<ServiceImplementations, "plugins" | "codeHosts" | "githubCalls"> = {},
  ): Promise<ConveyorService> {
    await ensureRuntimeDirectories(config);
    const store = await ConveyorStore.open(config.settings.database);
    const removedRepositories = store.removeRepositoriesExcept(Object.keys(config.repositories));
    if (removedRepositories.length > 0) {
      log.info("Removed unconfigured repositories from the local index", { repositories: removedRepositories });
    }
    // The snapshot is history, not a credential store: values that came from !secret are redacted.
    store.recordConfigSnapshot(config.hash, redactSecrets(config, config.secrets ?? []));
    // The source's read cache lives in the database, so a restart does not read it all again.
    itemSource.useMirror?.(store.githubMirror(), config.settings.githubCache);
    const service = new ConveyorService(config, store, itemSource, implementations);
    const recovered = store.recoverInterruptedExecutions(config.hash);
    if (recovered.runs > 0 || recovered.stages > 0) {
      log.warn("Recovered interrupted work after restart", { runs: recovered.runs, stages: recovered.stages });
      for (const stage of recovered.recoveredStages) {
        log.info("Stage queued after restart", { ...service.itemFields(stage.issueId), stage: stage.stageId });
      }
    }
    service.prepareStartupPass();
    return service;
  }

  /** The process-local state of the first pass, for the control socket and dashboard. */
  startupStatus(): StartupStatus {
    return this.#sync.startupStatus();
  }

  async onboardRepositories(): Promise<void> {
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      await this.#sync.onboardRepository(id, repository);
    }
  }

  /** The URL a repository's item source delivers webhook events to, when Conveyor manages its webhook. */
  private webhookUrl(repositoryId: string): string | null {
    return this.#webhooks.url(repositoryId);
  }

  /** Whether the repository's deliveries are known to arrive; false only after a ping went undelivered. */
  webhooksHealthy(repositoryId: string): boolean {
    return this.#webhooks.healthy(repositoryId);
  }

  /** Asks the source to ping the repository's webhook; see WebhookSupervisor.ping. */
  pingWebhook(repositoryId: string): Promise<boolean> {
    return this.#webhooks.ping(repositoryId);
  }

  /** One supervision pass over every managed webhook; see WebhookSupervisor.supervise. */
  superviseWebhooks(now = Date.now()): Promise<void> {
    return this.#webhooks.supervise(now);
  }

  /** Asks the source to redeliver the repository's missed deliveries; see WebhookSupervisor.redeliverMissed. */
  redeliverMissed(repositoryId: string): Promise<number> {
    return this.#webhooks.redeliverMissed(repositoryId);
  }

  /** How long an event wait sleeps without its event: its fallback where Conveyor manages a webhook, else null (poll). */
  waitFallbackMs(repositoryId: string, kind: WaitKind): number | null {
    if (!this.webhookUrl(repositoryId)) return null;
    return this.config.settings.events?.fallbackMs[kind] ?? null;
  }

  /** Reads every repository; see RepositorySync.reconcileAll. */
  reconcileAll(options: { skipFresh?: boolean } = {}): Promise<void> {
    return this.#sync.reconcileAll(options);
  }

  /** Reads one repository afresh, now; see RepositorySync.syncRepository. */
  syncRepository(repositoryId: string): Promise<{ issues: number; failed: boolean }> {
    return this.#sync.syncRepository(repositoryId);
  }

  /** Creates and enrolls an issue in an onboarded repository; see RepositorySync.createIssue. */
  createIssue(input: { repository: string; title: string; body: string; idempotencyKey?: string | undefined }): Promise<{ issueId: string; number: number; url: string }> {
    return this.#sync.createIssue(input);
  }

  start(): void {
    if (this.#timer) return;
    this.#sync.beginStartupPass();
    void this.tick();
    this.#timer = setInterval(() => { this.#timerFired("reconcile"); void this.tick(); }, this.config.settings.reconcileIntervalMs);
    const periodic = this.config.web?.steering?.periodic;
    if (periodic) {
      this.#periodicOperatorTimer = setInterval(() => {
        this.#timerFired("scheduled-operator");
        void this.runScheduledOperatorCheck().catch((error) => log.warn("Scheduled Operator check failed", {}, error));
      }, periodic.intervalMs);
    }
    const prune = () => {
      this.#retentionActive += 1;
      void this.applyRetention()
        .catch((error: unknown) => log.error("Retention failed", {}, error))
        .finally(() => { this.#retentionActive -= 1; });
    };
    prune();
    this.#retentionTimer = setInterval(() => { this.#timerFired("retention"); prune(); }, 24 * 60 * 60_000);
    this.#githubCallTimer = setInterval(() => { this.#timerFired("github-calls"); void this.logGitHubCalls(); }, GITHUB_CALL_SUMMARY_MS);
    for (const sink of this.#sinks) sink.start(this.events);
    // The server listens from here on: ask for the deliveries GitHub could not make while Conveyor was
    // starting or stopped, and ping each webhook so its arrival shows deliveries work.
    this.#webhooks.start();
  }

  /** A trace of a timer firing: the activity no request or event started. */
  #timerFired(timer: EventPayload<"timer.fired">["timer"]): void {
    try {
      this.store.events().trace("timer.fired", { timer });
    } catch (error) {
      // A trace never stops the work it describes (the database may be closing).
      log.warn("Could not record a trace", { timer }, error);
    }
  }

  /** Marks creation as pending before listeners are opened; provider work begins from start(). */
  private prepareStartupPass(): void {
    this.#sync.prepareStartupPass();
  }

  /** Resolves once every event sink has received every recorded event (or a delivery failed). */
  async sinksIdle(): Promise<void> {
    await this.eventsSettled();
    await Promise.all(this.#sinks.map((sink) => sink.idle()));
  }

  /** The last hour of GitHub requests by source and repository, with the token's remaining rate limit. */
  async githubCallReport(): Promise<GitHubCallReport> {
    let rateLimit: GitHubCallReport["rateLimit"] = null;
    try { rateLimit = (await this.itemSource.rateLimit()).core; }
    catch { rateLimit = null; }
    return { countingSince: this.githubCalls.startedAt, windowMs: GITHUB_CALL_SUMMARY_MS, ...this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS), rateLimit };
  }

  /**
   * Logs the last hour of GitHub requests per source, overall and per repository, with the token's
   * remaining rate limit; warns when less than a fifth of it is left.
   */
  async logGitHubCalls(): Promise<void> {
    const summary = this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS);
    const counts = (bySource: Partial<Record<CallSource, number>>) =>
      Object.fromEntries(CALL_SOURCES.filter((source) => bySource[source]).map((source) => [source, bySource[source]!]));
    let limits: Awaited<ReturnType<ItemSourceClient["rateLimit"]>> | null = null;
    try { limits = await this.itemSource.rateLimit(); }
    catch (error) { log.warn("Could not read the GitHub rate limit", {}, error); }
    const core = limits?.core ?? null;
    log.info("GitHub calls in the last hour", {
      total: summary.total, ...counts(summary.bySource),
      ...(core ? { remaining: core.remaining, limit: core.limit, resetAt: core.resetAt } : {}),
      ...(Date.parse(this.githubCalls.startedAt) > Date.now() - GITHUB_CALL_SUMMARY_MS ? { since: this.githubCalls.startedAt } : {}),
    });
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      const bySource = summary.byRepository[repository.address.toLowerCase()];
      if (bySource) log.info("GitHub calls in the last hour for a repository", { repository: id, ...counts(bySource) });
    }
    if (core && core.remaining < core.limit * 0.2) {
      log.warn("GitHub rate limit is running low", { remaining: core.remaining, limit: core.limit, resetAt: core.resetAt });
    }
  }

  private async recoverWorkspaceScratch(): Promise<void> {
    try {
      const removed = await this.workspaceManager.removeOrphanedScratch(
        this.store.listActiveWorkspaces().map((workspace) => workspace.path),
      );
      if (removed > 0) log.info("Removed orphaned item scratch directories", { directories: removed });
    } catch (error) {
      log.error("Workspace scratch recovery failed", {}, error);
    }
  }

  /** Prunes finished work past the retention policy (the configured one by default). */
  async applyRetention(options: { dryRun?: boolean; policy?: RetentionPolicy } = {}): Promise<RetentionReport> {
    const report = await applyRetention({
      store: this.store,
      artifacts: this.config.settings.artifacts,
      policy: options.policy ?? this.config.settings.retention,
      eventsMs: this.config.settings.events?.retentionMs ?? null,
      webhookDeliveriesMs: this.config.settings.retention.webhookDeliveriesMs ?? null,
      dryRun: options.dryRun === true,
    });
    if (!report.dryRun && (report.runHistory.events > 0 || report.artifacts.directories > 0 || report.homes.directories > 0 || report.eventLog.events > 0 || report.webhookDeliveries.deliveries > 0)) {
      log.info("Pruned finished work past retention", { runs: report.runHistory.runs, events: report.runHistory.events, artifactDirectories: report.artifacts.directories, artifactBytes: report.artifacts.bytes, homes: report.homes.directories, homeBytes: report.homes.bytes, eventLog: report.eventLog.events, webhookDeliveries: report.webhookDeliveries.deliveries });
    }
    if (!report.dryRun && report.homes.failures.length > 0) {
      log.warn("Could not reclaim some terminal run homes", { homeFailures: report.homes.failures.length, failures: report.homes.failures });
    }
    return report;
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    for (const listener of this.#closeListeners) listener();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#periodicOperatorTimer) clearInterval(this.#periodicOperatorTimer);
    this.#periodicOperatorTimer = null;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = null;
    this.#scheduler.close();
    if (this.#advisoryTimer) clearTimeout(this.#advisoryTimer);
    this.#advisoryTimer = null;
    if (this.#githubCallTimer) clearInterval(this.#githubCallTimer);
    this.#githubCallTimer = null;
    this.#webhooks.stop();
    await Promise.all(this.#sinks.map((sink) => sink.stop()));
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#retryTimers.clear();
    for (const [issueId, active] of this.#active) {
      active.interrupted = true;
      log.warn("Stage interrupted during shutdown", { ...this.itemFields(issueId), stage: active.stageId });
      active.controller.abort();
    }
    this.#steering.interruptAll();
    // An in-flight reconcile or advisory-CI poll still uses the database; let it finish first.
    while (this.#active.size > 0 || this.#steering.busy || this.#purges.busy || this.#statusComments.busy || this.#answers.busy || this.#sync.busy || this.#tickRunning || this.#advisoryPolling || this.#retentionActive > 0) {
      await Bun.sleep(25);
    }
    this.store.close();
  }

  async tick(): Promise<void> {
    if (this.#shuttingDown || this.#sync.startupRunning || this.#tickRunning) return;
    this.#tickRunning = true;
    try {
      await withCallSource("tick", async () => {
        await this.reconcileAll({ skipFresh: true });
        await this.recoverClosedItems();
      });
      this.schedule();
    } finally {
      this.#tickRunning = false;
    }
    // Not awaited: a slow CI provider must not stall reconcile and scheduling.
    void this.pollAdvisoryCi().catch((error) => log.warn("Advisory CI poll failed", {}, error));
  }

  /** Reconcile long-lived non-runnable projections that webhook delivery may have missed. */
  private async recoverClosedItems(): Promise<void> {
    const now = new Date().toISOString();
    const before = new Date(Date.now() - CLOSED_ITEM_RECOVERY_AGE_MS).toISOString();
    for (const repositoryId of Object.keys(this.config.repositories)) {
      for (const issue of this.store.listRecoveryCandidates(repositoryId, now)) {
        // An issue GitHub left open after the merge is read fresh on every tick, whatever the age of the
        // stop: GitHub may close it any moment and the cached copy is stale.
        const leftOpen = this.stoppedForIssueLeftOpen(repositoryId, issue);
        if (leftOpen) {
          const repository = this.config.repositories[repositoryId];
          if (repository) this.itemSource.forgetIssue?.(repository.address, issue.sourceNumber);
        } else if (issue.projectionChangedAt > before) continue;
        await this.recoverClosedItem(repositoryId, issue);
      }
    }
  }

  /** Whether the item stopped because its change merged and GitHub left the issue open (the `item.issueClosed` gate). */
  private stoppedForIssueLeftOpen(repositoryId: string, issue: StoredIssue): boolean {
    if (issue.projectedState !== "needs-intervention" || !issue.projectedStage) return false;
    const repository = this.config.repositories[repositoryId];
    const stage = repository && this.config.pipelines[repository.pipeline]?.stages.find((candidate) => candidate.id === issue.projectedStage);
    if (!stage || !isNativeStage(stage) || !stage.exitGate.some((gate) => gate.task === "item.issueClosed")) return false;
    return latestStopReason(this.store, issue.id)?.includes(ISSUE_LEFT_OPEN_MARKER) ?? false;
  }

  /** Resolve one closed source item without treating a failed read as evidence of closure or merge. */
  private async recoverClosedItem(
    repositoryId: string,
    issue: StoredIssue,
    deliveredIssue?: SourceIssue,
  ): Promise<void> {
    if (issue.projectedState === "done" || issue.projectedState === "unlisted") return;
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    let sourceIssue: SourceIssue;
    try {
      sourceIssue = deliveredIssue ?? await this.executionSource(repositoryId).getIssue(repository.address, issue.sourceNumber);
    } catch (error) {
      log.warn("Could not read an item for closed-item recovery", this.itemFields(issue.id), error);
      return;
    }
    if (sourceIssue.state !== "closed") return;
    if (this.stoppedForIssueLeftOpen(repositoryId, issue)) {
      // The owner (or a late auto-close) closed the issue this item was waiting on: finish the stage.
      try {
        await this.retryIssue(issue.id, "", "Conveyor", true);
      } catch (error) {
        log.warn("Could not resume an item whose issue closed after the merge", this.itemFields(issue.id), error);
      }
      return;
    }

    const current = this.store.getCurrentPullRequest(issue.id);
    if (current) {
      const host = this.executionCodeHost(issue.id, this.codeHostFor(repositoryId));
      if (!host) {
        log.warn("Could not read a current change for closed-item recovery", this.itemFields(issue.id));
        return;
      }
      let delivery: ChangeDelivery;
      try {
        delivery = await host.getChangeDelivery({ address: repository.address, id: current.id });
      } catch (error) {
        log.warn("Could not read a current change for closed-item recovery", this.itemFields(issue.id), error);
        return;
      }
      const mergedAt = delivery.change.mergedAt ?? current.mergedAt ??
        (delivery.change.state === "merged" ? new Date().toISOString() : null);
      this.store.upsertPullRequest({
        issueId: issue.id,
        id: current.id,
        number: delivery.change.number,
        url: delivery.change.url,
        state: delivery.change.state,
        ...(mergedAt ? { mergedAt } : {}),
      });
      if (mergedAt) {
        await this.continueExternalMerge(repositoryId, issue, sourceIssue, current.id);
        return;
      }
    }
    try {
      const enrollment = this.store.getActiveEnrollment(issue.id);
      await applyClosedItemOffboarding({
        store: this.store,
        source: this.executionSource(repositoryId),
        sourceName: repository.source,
        address: repository.address,
        transitionId: `closed-item-offboard:${issue.id}:${enrollment?.generation ?? "untracked"}`,
        issue,
      });
      // The labels are gone and the purge has begun: stop the run, then remove what Conveyor holds.
      await this.purgeItem(issue.id);
    } catch (error) {
      if (error instanceof RepositoryPausedError) {
        this.store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState,
          warning: "Closed-item cleanup will resume when the repository resumes.",
        });
        return;
      }
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: issue.projectedState,
        warning: "Closed-item cleanup is pending after a source update failure.",
      });
      log.warn("Could not remove controls from a closed item", this.itemFields(issue.id), error);
    }
  }

  /** Records a person-merged current change and continues after the last configured merge boundary. */
  private async continueExternalMerge(
    repositoryId: string,
    issue: StoredIssue,
    sourceIssue: SourceIssue,
    changeId: string,
  ): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const stages = this.config.pipelines[repository.pipeline]!.stages;
    const mergeIndex = stages.findLastIndex((stage) => isNativeStage(stage) && (
      stage.actions.some((action) => action.task === "change.merge") ||
      stage.exitGate.some((gate) => gate.task === "change.merged")
    ));
    const currentStage = issue.projectedStage;
    const currentIndex = currentStage ? stages.findIndex((stage) => stage.id === currentStage) : -1;
    try {
      if (!currentStage || mergeIndex < 0 || currentIndex < 0 || currentIndex > mergeIndex) {
        await this.reconcileClosedItem(repositoryId, sourceIssue);
        return;
      }
      const applied = await applyStageTransition({
        store: this.store,
        source: this.executionSource(repositoryId),
        sourceName: repository.source,
        address: repository.address,
        configHash: this.config.hash,
        transitionId: `external-merge:${issue.id}:${changeId}`,
        issue,
        stages: stages.map((stage) => stage.id),
        labels: this.config.labels,
        result: {
          kind: "advance",
          stageId: currentStage,
          nextStageId: stages[mergeIndex + 1]?.id ?? null,
          feedbackCycles: this.store.getStageState(issue.id)?.feedbackCycle ?? 0,
          result: null,
        },
        actor: { name: "GitHub", title: "External merge" },
      });
      if ("waitingForInFlight" in applied) return;
      const conveyorLabels = sourceIssue.labels.filter((label) =>
        label === this.config.labels.enrollment || label.startsWith(`${this.config.labels.enrollment}:`));
      const projected = {
        ...sourceIssue,
        labels: [...sourceIssue.labels.filter((label) => !conveyorLabels.includes(label)), ...applied.labels],
      };
      await this.reconcileClosedItem(repositoryId, projected);
    } catch (error) {
      if (error instanceof RepositoryPausedError) {
        this.store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState,
          warning: "Post-merge continuation will resume when the repository resumes.",
        });
        return;
      }
      log.warn("Could not continue an externally merged change", this.itemFields(issue.id), error);
    }
  }

  /** Reconciles one supplied source snapshot without issuing another source read. */
  private reconcileClosedItem(repositoryId: string, issue: SourceIssue): Promise<void> {
    return this.#sync.reconcileSnapshot(repositoryId, issue);
  }

  /** One scheduling pass; see Scheduler.schedule. */
  private schedule(): void {
    this.#scheduler.schedule();
  }

  /** Starts the stage run the scheduler selected; it ends by releasing the item's worker. */
  private launch(issue: StoredIssue, candidate: SchedulerCandidate): void {
    const active: ActiveRun = {
      repositoryId: issue.repositoryId,
      stageId: candidate.stageId,
      controller: new AbortController(),
      lightweight: candidate.lightweight === true,
      gateOnly: candidate.gateOnly === true,
      interrupted: false,
      executorDone: false,
    };
    this.#active.set(issue.id, active);
    log.info("Stage started", { ...this.itemFields(issue.id), stage: candidate.stageId });
    // A stage run outlives the sync that scheduled it, so it must not inherit that sync's held lock.
    void this.#sync.outsideLocks(() => withCallSource(this.#scheduler.callSource(issue.id), () => this.execute(issue, active.controller.signal, candidate.gateOnly === true))).finally(() => {
      this.#active.delete(issue.id);
      this.store.events().append("worker.released", { stageId: candidate.stageId }, { issueId: issue.id });
      if (this.#admission.current && !active.interrupted) {
        log.info("Stage finished during drain", { ...this.itemFields(issue.id), stage: candidate.stageId });
      }
    });
  }

  /** Every queued item as the scheduler sees it; see Scheduler.candidates. */
  private schedulerCandidates(): SchedulerCandidate[] {
    return this.#scheduler.candidates();
  }

  private refreshStatusComments(issueIds: readonly string[]): void {
    for (const issueId of new Set(issueIds)) {
      void this.#sync.outsideLocks(() => this.updateStatusComment(issueId))
        .catch((error) => log.warn("Status comment refresh failed", this.itemFields(issueId), error))
        .catch(() => {});
    }
  }

  /** The live scheduler status for an item, when it is waiting or queued rather than running. */
  liveIssueStatus(issueId: string): LiveIssueStatus | null {
    return this.#scheduler.liveIssueStatus(issueId);
  }

  /** Where an item is now: its stage, state, why and since when. The CLI and the dashboard's journey show it. */
  itemNow(issueId: string): IssueJourneyViewModel["now"] | null {
    return this.#scheduler.itemNow(issueId);
  }

  /** What the dashboard plugin reads: store reads, the configuration and this service's live state. */
  dashboardSources(): DashboardSources {
    return {
      config: this.config,
      store: this.store,
      harnesses: this.#harnesses,
      repositorySummaries: (issues) => this.repositorySummaries(issues),
      repositoryErrors: () => [...this.#sync.onboardingErrors.entries(), ...this.#sync.reconcileErrors.entries()],
      lastReconciledAt: () => this.#sync.lastReconciledAt,
      drain: () => this.#admission.current,
      githubOutage: () => this.githubOutage(),
      retryWaiting: (issueId) => this.#infrastructureFailures.get(issueId)?.waiting ?? null,
      liveStatusReader: (issues, lookups) => this.#scheduler.liveStatusReader(issues, lookups),
      itemNow: (issueId) => this.itemNow(issueId),
      latestStopReason: (issueId) => latestStopReason(this.store, issueId),
      isRollupSatisfied: (issueId) => this.#rollups.satisfied(issueId),
      manualGateViews: (issue) => this.manualGateViews(issue),
      criterionApprovalStates: (issue) => this.criterionApprovalStates(issue),
      retryableStoppedIssue: (issue, children, running) => this.#retries.retryable(issue, children, running),
      resumableRollupIssue: (issue, children, running, hasOpenQuestion) => this.#rollups.resumable(issue, children, running, hasOpenQuestion),
      retryTargetStage: (issueId) => this.retryTargetStage(issueId),
      onLiveStateChange: (listener) => {
        this.#liveStateListeners.add(listener);
        return () => { this.#liveStateListeners.delete(listener); };
      },
      onClose: (listener) => { this.#closeListeners.add(listener); },
    };
  }

  #liveStateChanged(): void {
    for (const listener of this.#liveStateListeners) listener();
  }

  /** Polls due advisory CI watches (no permits, no stage state) and re-arms the timer for the next one. */
  private async pollAdvisoryCi(): Promise<void> {
    if (this.#shuttingDown || this.#advisoryPolling) return;
    this.#advisoryPolling = true;
    try { await withCallSource("advisory", () => this.#advisoryWatches.pollDueWatches(Date.now())); }
    finally { this.#advisoryPolling = false; }
    if (this.#advisoryTimer) clearTimeout(this.#advisoryTimer);
    this.#advisoryTimer = null;
    const next = this.#advisoryWatches.nextWakeAt();
    if (next === null || this.#shuttingDown) return;
    this.#advisoryTimer = setTimeout(() => {
      this.#advisoryTimer = null;
      this.#timerFired("advisory-ci");
      void this.pollAdvisoryCi().catch(() => {});
    }, Math.max(0, Date.parse(next) - Date.now()) + 50);
  }

  /** Registers the handler of every service command; release and restart are registered by the control socket. */
  private registerCommands(): void {
    const own = (actor: CommandActor, accountId: string) => {
      if (actor.role !== "superuser" && actor.id !== accountId) throw new CommandForbiddenError("an account may change only itself");
    };
    const account = (actor: CommandActor) => ({ id: actor.id ?? actor.name, username: actor.name });
    const commands = this.commands;
    commands.handle("item.retry", (input, actor) => this.retryIssue(input.issueId, input.note, actor.name));
    commands.handle("item.resumeRollup", (input) => this.resumeRollupParent(input.issueId));
    commands.handle("item.pause", (input, actor) => this.pauseIssue(input.issueId, actor.name));
    commands.handle("item.resume", (input, actor) => this.resumeIssue(input.issueId, actor.name));
    commands.handle("repository.pause", (input, actor) => this.pauseRepository(input.repositoryId, input.reason, actor.name));
    commands.handle("repository.resume", (input) => this.resumeRepository(input.repositoryId));
    commands.handle("item.postMessage", (input, actor) => this.postIssueMessage(input.issueId, input.message, actor.name));
    commands.handle("question.answer", (input, actor) => this.answerQuestion(input.questionId, input.answer, actor.name));
    commands.handle("gate.approve", (input, actor) => this.approveManualGate(input.issueId, input.stageId, input.gateId, account(actor)));
    commands.handle("gate.setItemApproval", (input) => this.setBoardApprovalRequirement(input.issueId, input.stageId, input.required));
    commands.handle("finding.dismiss", (input, actor) => this.dismissFinding(input.issueId, input.findingId, input.reason, actor.name));
    commands.handle("finding.reclassify", (input, actor) => this.reclassifyFinding(input.issueId, input.findingId, input.type, actor.name));
    commands.handle("backlog.reorder", (input) => this.reorderBacklog(input.issueId, input.direction));
    commands.handle("backlog.move", (input) => this.moveBacklogIssue(input.issueId, input.beforeIssueId));
    commands.handle("steering.start", (input) => this.startSteering(input.prompt));
    commands.handle("account.create", (input) => {
      const created = this.store.createDashboardUser(input.username, input.passwordHash);
      return { id: created.id, username: created.username, role: created.role, avatar: created.avatar };
    });
    commands.handle("account.setPassword", (input, actor) => {
      own(actor, input.accountId);
      this.store.changeDashboardPassword(input.accountId, input.passwordHash);
    });
    commands.handle("account.delete", (input) => this.store.deleteDashboardAccount(input.accountId));
    commands.handle("account.setAvatar", (input, actor) => {
      own(actor, input.accountId);
      this.store.changeDashboardAvatar(input.accountId, input.avatar);
    });
    commands.handle("notifications.updateSettings", (input, actor) => {
      own(actor, input.accountId);
      this.store.setPushPreferences(input.accountId, input.preferences);
    });
    commands.handle("notifications.subscribe", (input, actor) => {
      own(actor, input.accountId);
      this.store.putPushSubscription(input.accountId, input.endpoint, input.keys);
    });
    commands.handle("notifications.unsubscribe", (input, actor) => {
      own(actor, input.accountId);
      this.store.deletePushSubscription(input.accountId, input.endpoint);
    });
    commands.handle("repository.sync", (input) => {
      if (!this.config.repositories[input.repositoryId]) throw new CommandInputError(`unknown repository ${input.repositoryId}`);
      return this.syncRepository(input.repositoryId);
    });
    commands.handle("admission.drain", (input, actor) => this.drain(input.reason || `requested by ${actor.name}`));
    commands.handle("admission.resume", () => this.resumeAdmission());
    commands.handle("service.cleanup", (input) => {
      const configured = this.config.settings.retention;
      return this.applyRetention({
        dryRun: input.dryRun,
        policy: { runHistoryMs: input.runHistoryMs ?? configured.runHistoryMs, artifactsMs: input.artifactsMs ?? configured.artifactsMs },
      });
    });
  }

  /** Reactions to committed changes: waking parked items and scheduling. */
  private subscribeToEvents(): void {
    // A parked configured gate re-evaluates as soon as a person changes what it waits on.
    const wakeParkedGate = (issueId: string | null, stageId: string, gateId: string | null, visit?: { stageEpoch: number; attempt: number }) => {
      if (!issueId) return;
      const cursor = this.store.executions().getCursor(issueId);
      const waitingForGate = cursor?.list === "exit-gate" ||
        (cursor?.list === "actions" && gateId === ENTRY_APPROVAL_TASK_ID && cursor.taskInstanceId === ENTRY_APPROVAL_TASK_ID);
      if (cursor?.state !== "pending" || cursor.stage !== stageId || !waitingForGate || (gateId !== null && cursor.taskInstanceId !== gateId)) return;
      // An approval belongs to one visit of the gate; a later visit waits for its own.
      if (visit && (cursor.stageEpoch !== visit.stageEpoch || cursor.attempt !== visit.attempt)) return;
      this.wakeParked(issueId);
    };
    this.events.subscribe("gate.approved", "wake the approved gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, event.payload.gateId, { stageEpoch: event.payload.stageEpoch, attempt: event.payload.attempt }));
    this.events.subscribe("gate.requirementChanged", "wake the changed gate", (event) => wakeParkedGate(event.issueId, event.payload.stageId, event.payload.gateId));
    this.events.subscribe("gate.boardApproved", "wake the approved board gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, BOARD_APPROVAL_TASK_ID, { stageEpoch: event.payload.stageEpoch, attempt: event.payload.attempt }));
    this.events.subscribe("gate.boardApprovalChanged", "wake the changed board gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, BOARD_APPROVAL_TASK_ID));
    this.events.subscribe("finding.changed", "wake the review gate", (event) => {
      if (event.payload.change === "dismissed") {
        const cursor = event.issueId ? this.store.executions().getCursor(event.issueId) : null;
        if (cursor) wakeParkedGate(event.issueId, cursor.stage, null);
      }
    });
    // Every completed stop gets one read-only Operator summary run; the stop itself is already recorded.
    this.events.subscribe("journey.recorded", "start the stop-summary run", (event) => {
      if (event.issueId && event.payload.kind === "stopped" && event.payload.status === "completed") {
        this.#steering.startStopSummary(event.issueId, event.payload.transitionId);
      }
    });
    for (const type of SCHEDULING_EVENTS) this.events.subscribe(type, "schedule", () => this.#scheduler.requestSchedule());
    this.events.subscribe("criterion.approvalChanged", "refresh criterion approval status", (event) => {
      if (event.issueId) this.refreshStatusComments([event.issueId]);
    });
    for (const type of ["itemSource.itemChanged", "itemSource.relationsChanged", "code.changeUpdated", "ci.runUpdated"] as const) {
      this.events.subscribe(type, "source observation", (event) => this.#sync.reactToObservation(event));
    }
    for (const type of ["ci.runUpdated", "code.changeUpdated", "item.updated", "item.stageChanged"] as const) {
      this.events.subscribe(type, "wake waiting tasks", (event) => this.#waitDispatcher.handle(event));
    }
    this.events.subscribe("ci.runUpdated", "wake advisory CI watches", (event) => {
      if (!event.payload.completed || !event.repositoryId) return;
      if (this.#advisoryWatches.wakeHead(event.repositoryId, event.payload.sha, Date.now()) > 0) {
        void this.pollAdvisoryCi().catch((error) => log.warn("Advisory CI poll failed", {}, error));
      }
    });
    // A delivery that arrives shows the webhook works.
    this.events.subscribe("webhook.received", "webhook health", (event) => {
      if (event.repositoryId && this.webhookUrl(event.repositoryId)) this.#webhooks.delivered(event.repositoryId);
    });
  }

  /**
   * Resolves once every committed event has been published and the scheduling it asked for ran:
   * a command that reports whether its item started reads that only after this.
   */
  async eventsSettled(): Promise<void> {
    await this.store.events().settled();
    this.#waitDispatcher.flush();
    await this.store.events().settled();
    this.#scheduler.flushSchedule();
  }

  /** Makes a parked item due now; see Scheduler.wakeParked. */
  private wakeParked(issueId: string): boolean {
    return this.#scheduler.wakeParked(issueId);
  }

  /** Whether a parked agent question belongs to this item's current execution. */
  private hasResumableQuestionExecution(issueId: string): boolean {
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const issue = this.store.getIssue(issueId);
    if (!cursor || cursor.state !== "pending" || cursor.list !== "actions" || cursor.taskInstanceId === null || !issue) {
      return false;
    }
    const plan = this.config.plans.find((candidate) => candidate.repositoryId === issue.repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId: issue.repositoryId, registry: createTaskRegistry() });
    const stage = plan.stages.find((candidate) => candidate.id === cursor.stage);
    const task = stage?.actions.find((candidate) => candidate.id === cursor.taskInstanceId);
    if (stage === undefined || stage.legacy || task?.task !== "agent.run") return false;
    const executionKey = journal.idempotencyKey({
      issueId,
      stage: cursor.stage,
      stageEpoch: cursor.stageEpoch,
      attempt: cursor.attempt,
      taskInstanceId: cursor.taskInstanceId,
    });
    return this.store.listRunsForExecution(issueId, cursor.stage, "producer", executionKey)
      .some((run) => this.store.getQuestionForRun(run.id) !== null);
  }

  /** What native-stage tasks and MCP tools receive. */
  private taskDeps(issueId: string, repository: TaskDeps["repository"], signal?: AbortSignal): TaskDeps {
    return {
      store: this.store,
      config: this.config,
      items: this.executionSource(repository.id),
      repository,
      issueId,
      sourceGuidance: SOURCE_GUIDANCE,
      git: cliGit,
      workspaces: this.workspaceManager,
      mcp: this.mcpFactory(),
      harnesses: this.#harnesses,
      delivery: () => this.loadDeliveryState(issueId, repository.address),
      forgetChange: () => this.forgetChange(issueId, repository.address),
      codeHost: this.executionCodeHost(issueId, this.codeHostFor(repository.id)),
      ci: {
        provider: () => this.executionCiProvider(repository.id),
        watchAdvisory: (input) => {
          this.#advisoryWatches.ensureWatch({
            repositoryId: repository.id, itemId: input.itemId, headSha: input.headSha, stage: input.stage,
            change: { changeId: input.changeId, url: input.changeUrl }, now: Date.now(),
          });
          void this.pollAdvisoryCi().catch(() => {});
        },
      },
      notify: (message, stageId) => {
        this.store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator", message,
        });
      },
      ...(signal ? { signal } : {}),
    };
  }

  private manualGatePlan(issue: StoredIssue) {
    const repositoryId = Object.entries(this.config.repositories).find(
      ([id, repository]) => id === issue.repositoryId || repository.address === issue.repositoryId,
    )?.[0];
    if (!repositoryId) throw new Error("issue repository is not configured");
    return this.config.plans.find((plan) => plan.repositoryId === repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId, registry: createTaskRegistry() });
  }

  /** A board approval belongs to a current or later native stage. */
  private boardApprovalCandidate(issue: StoredIssue, stageId: string) {
    if (!issue.labels.includes(this.config.labels.enrollment)) throw new Error("issue is not enrolled");
    if (issue.projectedState === "done" || issue.projectedState === "completed") {
      throw new Error("manual approval cannot be changed for a completed item");
    }
    const currentStage = issue.projectedStage;
    if (!currentStage) throw new Error("issue has no current stage");
    const plan = this.manualGatePlan(issue);
    const currentIndex = plan.stages.findIndex((stage) => stage.id === currentStage);
    const stageIndex = plan.stages.findIndex((stage) => stage.id === stageId);
    if (currentIndex < 0 || stageIndex < currentIndex) throw new Error("manual approval can be changed only for a current or future stage");
    const stage = plan.stages[stageIndex];
    if (!stage || stage.legacy) throw new Error("board approval is available only for native stages");
    return stage;
  }

  /** A configured manual gate is selected by its native stage entry or exit-gate task. */
  private manualGateCandidate(issue: StoredIssue, stageId: string, gateId: string) {
    const stage = this.boardApprovalCandidate(issue, stageId);
    if (gateId === ENTRY_APPROVAL_TASK_ID && stage.approval === "manual") {
      return { stageId, gateId, configured: true, task: ENTRY_APPROVAL_TASK_ID };
    }
    const task = stage.exitGate.find((candidate) => candidate.id === gateId);
    if (!task?.manual) throw new Error("manual approval is available only for configured manual gates");
    return { stageId, gateId, configured: true, task: task.task };
  }

  private readonly manualGateStatus: ManualGateResolver = ({ issueId, stageId, gateId, stageEpoch, attempt, configured, task }) => {
    const approval = this.#manualGateApprovals.getApproval(issueId, stageId, gateId, stageEpoch, attempt);
    const followUps = task === FOLLOW_UP_GATE_TASK ? followUpsFromBody(this.store.getIssue(issueId)?.body ?? "") : [];
    return {
      required: configured && (task !== FOLLOW_UP_GATE_TASK || followUps.length > 0),
      approved: approval !== null,
      message: task === FOLLOW_UP_GATE_TASK ? "Waiting for follow-up acknowledgement."
        : task === ENTRY_APPROVAL_TASK_ID ? "Waiting for configured entry approval."
        : `Waiting for configured manual gate \"${gateId}\".`,
    };
  };

  private readonly manualGateWaiting: ManualGateWaitingNotifier = ({ issueId, stageId, gateId, stageEpoch, attempt, task }) => {
    if (task !== FOLLOW_UP_GATE_TASK) return;
    this.store.recordPushEvent({
      id: `follow-up:${issueId}:${stageId}:${gateId}:${stageEpoch}:${attempt}`,
      category: "questions",
      target: issueId,
    });
  };

  private readonly boardApprovalStatus: BoardApprovalResolver = ({ issueId, stageId, stageEpoch, attempt }) => {
    const approval = this.#manualGateApprovals.getBoardApproval(issueId, stageId, stageEpoch, attempt);
    return {
      required: this.#manualGateApprovals.hasBoardApprovalRequirement(issueId, stageId),
      approved: approval !== null,
      message: "Waiting for board approval",
    };
  };

  /**
   * A Follow-ups gate has no actor that can notice a human clearing its notes.  Fence its parked
   * visit after a source read so the normal executor re-evaluates the now-empty gate and advances.
   */
  private wakeClearedFollowUps(repositoryId: string, before: ReadonlyMap<string, string>): void {
    if (this.store.repositoryPause(repositoryId)) return;
    const journal = this.store.executions();
    for (const issue of this.store.listIssues(repositoryId)) {
      const previousBody = before.get(issue.id);
      if (previousBody === undefined || followUpsFromBody(previousBody).length === 0 || followUpsFromBody(issue.body).length !== 0) continue;
      if (this.hasWaitingFollowUp(issue)) {
        journal.onStageChange(issue.id);
      }
    }
  }

  private hasWaitingFollowUp(issue: StoredIssue): boolean {
    return this.manualGateViews(issue).some((gate) => gate.kind === "follow-up" && gate.waiting);
  }

  private manualGateViews(issue: StoredIssue) {
    if (!issue.labels.includes(this.config.labels.enrollment) || !issue.projectedStage || issue.projectedState === "done" || issue.projectedState === "completed") return [];
    try {
      const plan = this.manualGatePlan(issue);
      const current = plan.stages.findIndex((stage) => stage.id === issue.projectedStage);
      if (current < 0) return [];
      const cursor = this.store.executions().getCursor(issue.id);
      const epoch = this.store.executions().stageEpoch(issue.id);
      return plan.stages.slice(current).flatMap((stage) => {
        if (stage.legacy) return [];
        const visit = cursor?.stage === stage.id && cursor.stageEpoch === epoch ? cursor : null;
        const boardApproval = visit
          ? this.#manualGateApprovals.getBoardApproval(issue.id, stage.id, epoch, visit.attempt)
          : null;
        const board = {
          stageId: stage.id,
          gateId: null,
          kind: "board" as const,
          required: this.#manualGateApprovals.hasBoardApprovalRequirement(issue.id, stage.id),
          waiting: visit?.list === "exit-gate" && visit.taskInstanceId === BOARD_APPROVAL_TASK_ID && visit.state === "pending" && visit.wakeAt === null,
          approvedBy: boardApproval?.accountName ?? null,
          approvedAt: boardApproval?.approvedAt ?? null,
        };
        const entryApproval = visit
          ? this.#manualGateApprovals.getApproval(issue.id, stage.id, ENTRY_APPROVAL_TASK_ID, epoch, visit.attempt)
          : null;
        const entry = stage.approval === "manual" ? [{
          stageId: stage.id,
          gateId: ENTRY_APPROVAL_TASK_ID,
          kind: "entry" as const,
          required: true,
          waiting: visit?.list === "actions" && visit.taskInstanceId === ENTRY_APPROVAL_TASK_ID && visit.state === "pending" && visit.wakeAt === null,
          approvedBy: entryApproval?.accountName ?? null,
          approvedAt: entryApproval?.approvedAt ?? null,
        }] : [];
        const configured = stage.exitGate.flatMap((task) => {
          if (!task.manual) return [];
          const approval = visit ? this.#manualGateApprovals.getApproval(issue.id, stage.id, task.id, epoch, visit.attempt) : null;
          const followUp = task.task === FOLLOW_UP_GATE_TASK;
          return [{
            stageId: stage.id,
            gateId: task.id,
            kind: followUp ? "follow-up" as const : "configured" as const,
            required: followUp ? followUpsFromBody(issue.body).length > 0 : true,
            waiting: visit?.list === "exit-gate" && visit.taskInstanceId === task.id && visit.state === "pending" && visit.wakeAt === null,
            approvedBy: approval?.accountName ?? null,
            approvedAt: approval?.approvedAt ?? null,
            ...(followUp ? { notes: followUpsFromBody(issue.body) } : {}),
          }];
        });
        return [board, ...entry, ...configured];
      });
    } catch {
      return [];
    }
  }

  /** Changes an enrolled item's final board-approval requirement without altering repository configuration. */
  setBoardApprovalRequirement(issueId: string, stageId: string, required: boolean): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    this.boardApprovalCandidate(issue, stageId);
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const wasRequired = this.#manualGateApprovals.hasBoardApprovalRequirement(issueId, stageId);
    if (required && !wasRequired && stageId === issue.projectedStage &&
      this.store.listStageTransitions(issueId).some((transition) => transition.fromStage === stageId && transition.status === "pending")) {
      throw new Error("board approval cannot be changed while the current stage is advancing");
    }
    this.#manualGateApprovals.setBoardApprovalRequirement({ issueId, stageId, required, changedAt: new Date().toISOString() });
    // A gate may have read its requirement immediately before this board action.
    // Starting a new epoch makes that in-flight decision stale before it can advance.
    // The fence must be synchronous: a subscriber would leave a window for the stale decision.
    // Waking a gate parked on this requirement, and scheduling, follow from the change's event.
    if (required && !wasRequired && stageId === issue.projectedStage && cursor?.stage === stageId && cursor.list === "exit-gate") {
      journal.onStageChange(issueId);
    }
  }

  /** Records a human receipt only for the current manual gate visit, then wakes that item. */
  approveManualGate(issueId: string, stageId: string, gateId: string | null, account: { id: string; username: string }): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    const candidate = gateId !== null ? this.manualGateCandidate(issue, stageId, gateId) : null;
    if (gateId === null) this.boardApprovalCandidate(issue, stageId);
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const stageEpoch = journal.stageEpoch(issueId);
    const expectedList = gateId === ENTRY_APPROVAL_TASK_ID ? "actions" : "exit-gate";
    if (!cursor || cursor.stage !== stageId || cursor.stageEpoch !== stageEpoch || cursor.list !== expectedList ||
      cursor.taskInstanceId !== (gateId ?? BOARD_APPROVAL_TASK_ID) || cursor.state !== "pending") {
      throw new Error(gateId === null ? "board approval is not waiting for approval" : "manual gate is not waiting for approval");
    }
    const status = gateId === null
      ? this.boardApprovalStatus({ issueId, stageId, stageEpoch, attempt: cursor.attempt })
      : this.manualGateStatus({ issueId, stageId, gateId, stageEpoch, attempt: cursor.attempt, configured: true, task: candidate!.task });
    if (!status.required) throw new Error(gateId === null ? "board approval is not required for this stage" : "manual approval is not required for this gate");
    const existing = gateId === null
      ? this.#manualGateApprovals.getBoardApproval(issueId, stageId, stageEpoch, cursor.attempt)
      : this.#manualGateApprovals.getApproval(issueId, stageId, gateId, stageEpoch, cursor.attempt);
    // A retry after the first request woke the item is a harmless no-op.  A
    // different pending gate, however, must not receive a late approval.
    if (existing) return;
    if (cursor.wakeAt !== null) throw new Error(gateId === null ? "board approval is not waiting for approval" : "manual gate is not waiting for approval");
    const approvedAt = new Date().toISOString();
    const recorded = gateId === null
      ? this.#manualGateApprovals.approveBoard({ issueId, stageId, stageEpoch, attempt: cursor.attempt, accountId: account.id, accountName: account.username, approvedAt })
      : this.#manualGateApprovals.approve({ issueId, stageId, gateId, stageEpoch, attempt: cursor.attempt, accountId: account.id, accountName: account.username, approvedAt });
    if (recorded) {
      this.store.appendConversationMessage({
        issueId, runId: null, stageId, actorType: "user", actorId: account.id,
        actorName: account.username, actorTitle: "Superuser",
        message: gateId === null ? "Approved board approval."
          : candidate!.task === FOLLOW_UP_GATE_TASK ? "Acknowledged Follow-ups."
          : candidate!.task === ENTRY_APPROVAL_TASK_ID ? "Approved configured entry approval."
          : `Approved configured manual gate \"${gateId}\".`,
      });
    }
    // The approval event wakes the item.
  }

  /** Log correlation for an item: its repository and <repository>:<number>. */
  private itemFields(issueId: string): LogFields {
    const issue = this.store.getIssue(issueId);
    return issue ? { repository: issue.repositoryId, item: `${issue.repositoryId}:${issue.sourceNumber}` } : { item: issueId };
  }

  /** One record per stage pass, keeping gate and agent stops apart from infrastructure failures. */
  private logOutcome(issueId: string, outcome: StageOutcome): void {
    const fields = { ...this.itemFields(issueId), stage: outcome.stageId };
    if (outcome.kind === "advance") log.info("Stage passed", { ...fields, next: outcome.nextStageId });
    else if (outcome.kind === "stopped") log.warn("Stage stopped", { ...fields, state: outcome.state, reason: outcome.reason });
    else if (outcome.kind === "correction") log.info("Stage returned to an earlier stage", { ...fields, target: outcome.targetStageId, reason: outcome.reason });
    else log.debug("Stage parked", { ...fields, reason: outcome.reason, wakeAt: outcome.wakeAt });
  }

  private async execute(issue: StoredIssue, signal: AbortSignal, gateOnly = false): Promise<void> {
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    const executor = new IssueExecutor({
      config: this.config,
      store: this.store,
      sourceName: repository.source,
      source: this.executionSource(issue.repositoryId),
      workspaceManager: this.workspaceManager,
      recoverWorkspaceChange: async (currentIssue, currentRepository, workspace) => {
        const codeHost = this.executionCodeHost(currentIssue.id, this.codeHostFor(currentRepository.id));
        if (!codeHost) return;
        await recoverClosedChange({
          codeHost, store: this.store, source: currentRepository.source, address: currentRepository.address,
          issue: { id: currentIssue.id, sourceNumber: currentIssue.sourceNumber, title: currentIssue.title },
          workspace, base: currentRepository.baseBranch, closes: true,
        });
      },
      loadDeliveryState: async (currentIssue, currentRepository) =>
        this.loadDeliveryState(currentIssue.id, currentRepository.address),
      sourceGuidance: SOURCE_GUIDANCE,
      taskDeps: (currentIssue, currentRepository) => this.taskDeps(currentIssue.id, currentRepository, signal),
      manualGate: this.manualGateStatus,
      manualGateWaiting: this.manualGateWaiting,
      boardApproval: this.boardApprovalStatus,
      waitFallback: (repositoryId, kind) => this.waitFallbackMs(repositoryId, kind),
      admitInFlight: (currentIssue, targetStageId) => this.#scheduler.inFlightAdmission(currentIssue, targetStageId),
      gateOnly,
      signal,
      runtime: (context, refreshDeliveryState) => new ConfiguredStageRuntime(
        this.config,
        this.store,
        context,
        this.mcpFactory(),
        this.sourceActions(context),
        refreshDeliveryState,
        { harnesses: this.#harnesses },
        signal,
      ),
    });
    try {
      const warningBefore = this.store.getIssue(issue.id)?.warning ?? null;
      let outcome: Awaited<ReturnType<typeof executor.execute>>;
      try {
        outcome = await executor.execute(issue);
      } finally {
        // The agent is gone once the executor returns. The reconcile below may queue for the repository
        // lock, which a stopper can hold while it waits, so the stopper must not wait for it.
        const own = this.#active.get(issue.id);
        if (own && own.controller.signal === signal) own.executorDone = true;
      }
      this.logOutcome(issue.id, outcome);
      if (outcome.kind === "parked") {
        // A transition can reach the repository pause fence after the stage
        // itself has completed. Its pending source mutation is deliberately
        // retained for resume; do not turn the status-comment write into an
        // infrastructure failure while that repository is paused.
        if (this.store.repositoryPause(issue.repositoryId)) {
          return;
        }
        // A parked poll changes nothing at the source: no reconcile, just the status line.
        this.restorePendingStatus(issue.repositoryId);
        if ((this.store.getIssue(issue.id)?.warning ?? null) !== warningBefore) await this.updateStatusComment(issue.id);
      } else if (!signal.aborted) {
        // An interrupted run leaves the reconcile to whoever stopped it: that one may hold the repository
        // lock while it waits for this run to end.
        // The item's own step changed its state; nothing else in the repository did.
        await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
        await this.updateStatusComment(issue.id);
      }
    } catch (error) {
      if (signal.aborted) return;
      await this.handleInfrastructureFailure(issue, error);
      return;
    }
    this.#infrastructureFailures.delete(issue.id);
    this.releaseOutageItem(issue.id);
  }

  /**
   * A stage that failed outside its own tasks (runner crash, provider outage, a bug in Conveyor) is
   * retried with exponential backoff and, once `settings.retries` is used up, stopped as `error` with
   * the reason, instead of retrying the same deterministic failure forever.
   */
  private async handleInfrastructureFailure(issue: StoredIssue, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stageId = this.store.getStageState(issue.id)?.stageId ?? issue.projectedStage ?? "";
    const previous = this.#infrastructureFailures.get(issue.id);
    const failures = previous?.stageId === stageId ? previous.count + 1 : 1;
    const upstream = classifyUpstreamError(error);
    if (hasTransientScriptCause(error)) {
      await this.waitOutGithubOutage(issue, stageId, failures, message, previous?.stageId === stageId ? previous.waiting?.since : undefined, "script");
      return;
    }
    if (upstream.kind === "transient" && upstream.upstream === "github" && !isUsageLimitError(error)) {
      await this.waitOutGithubOutage(issue, stageId, failures, message, previous?.stageId === stageId ? previous.waiting?.since : undefined);
      return;
    }
    this.releaseOutageItem(issue.id);
    const decision = infrastructureRetry({ failures, usageLimit: isUsageLimitError(error), retries: this.config.settings.retries });
    if ("retryInMs" in decision) {
      const now = new Date();
      const waiting: IssueWaitingViewModel = {
        kind: "waiting",
        reason: `Execution failed: ${message}`,
        since: previous?.stageId === stageId && previous.waiting
          ? previous.waiting.since
          : now.toISOString(),
        nextCheckAt: new Date(now.getTime() + decision.retryInMs).toISOString(),
        deadline: null,
      };
      this.#infrastructureFailures.set(issue.id, { stageId, count: failures, waiting });
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: "active",
        warning: `Execution failed and will retry in ${formatDuration(decision.retryInMs)}: ${message}`,
      });
      await this.updateStatusComment(issue.id).catch((statusError) => {
        log.error("Status comment update failed", this.itemFields(issue.id), statusError);
      });
      log.warn("Stage failed outside its tasks; retrying", { ...this.itemFields(issue.id), stage: stageId, attempt: failures, retryInMs: decision.retryInMs }, error);
      this.retryLater(issue.id, decision.retryInMs);
      return;
    }
    log.error("Stage stopped as error after repeated failures", { ...this.itemFields(issue.id), stage: stageId, attempts: failures }, error);
    await this.stopStage(issue, stageId, "error", `${displayName(stageId)} stopped after ${failures} failed attempts: ${message}`);
  }

  /** The running GitHub outage, for the status and dashboard views. */
  githubOutage(): { since: string; waitingItems: string[] } | null {
    return this.#githubOutage ? { since: this.#githubOutage.since, waitingItems: [...this.#githubOutage.waitingItems] } : null;
  }

  /**
   * A stage failed with a transient GitHub error after the tools' own retries: the item waits at the
   * same stage, probing GitHub with backoff, until GitHub answers or `github.outageWaitLimit` is spent.
   */
  private async waitOutGithubOutage(
    issue: StoredIssue,
    stageId: string,
    failures: number,
    message: string,
    firstFailureAt: string | undefined,
    cause: "github" | "script" = "github",
  ): Promise<void> {
    const now = new Date();
    const since = firstFailureAt ?? now.toISOString();
    if (now.getTime() - Date.parse(since) > this.config.github.outageWaitLimit) {
      log.error("Temporary-failure wait limit passed", { ...this.itemFields(issue.id), stage: stageId, since, cause });
      const stopped = await this.stopStage(
        issue, stageId, "needs-intervention",
        cause === "script"
          ? `A stage script has reported a temporary failure since ${since}; waited ${formatDuration(this.config.github.outageWaitLimit)} (github.outageWaitLimit) without recovery. Last error: ${message}`
          : `GitHub has been unavailable since ${since}; waited ${formatDuration(this.config.github.outageWaitLimit)} (github.outageWaitLimit) without recovery. Last error: ${message}`,
      );
      // The stop needs GitHub too: when it failed, keep the recovery work and try again later.
      if (stopped) return;
    }
    const retries = this.config.settings.retries;
    const retryInMs = Math.min(retries.maxBackoff, retries.minBackoff * 2 ** Math.min(failures - 1, 30));
    if (cause === "github") {
      const outage = this.#githubOutage ?? { since, waitingItems: new Set<string>() };
      if (Date.parse(since) < Date.parse(outage.since)) outage.since = since;
      outage.waitingItems.add(issue.id);
      this.#githubOutage = outage;
      this.#liveStateChanged();
    } else {
      this.releaseOutageItem(issue.id);
    }
    const record = {
      stageId,
      count: failures,
      waiting: {
        kind: "waiting" as const,
        reason: cause === "script" ? `A stage script reported a temporary failure since ${since}` : "Waiting for GitHub to recover",
        since,
        nextCheckAt: new Date(now.getTime() + retryInMs).toISOString(),
        deadline: new Date(Date.parse(since) + this.config.github.outageWaitLimit).toISOString(),
      },
    };
    (cause === "script" ? this.#scriptWaitRecords : this.#outageRecords).add(record);
    this.#infrastructureFailures.set(issue.id, record);
    this.store.setIssueProjection(issue.id, {
      stage: issue.projectedStage,
      state: "active",
      // GitHub waits have no per-item blocker: status and the dashboard show one GitHub-unavailable line instead.
      warning: cause === "script"
        ? `A stage script reported a temporary failure since ${since}; waiting to run it again: ${message}`
        : null,
    });
    await this.updateStatusComment(issue.id).catch((statusError) => {
      log.error("Status comment update failed", this.itemFields(issue.id), statusError);
    });
    log.warn(cause === "script" ? "Stage script reported a temporary failure; waiting" : "GitHub unavailable; waiting", { ...this.itemFields(issue.id), stage: stageId, since, retryInMs });
    this.retryLater(issue.id, retryInMs);
  }

  private releaseOutageItem(issueId: string): void {
    if (!this.#githubOutage) return;
    this.#githubOutage.waitingItems.delete(issueId);
    if (this.#githubOutage.waitingItems.size === 0) this.#githubOutage = null;
    this.#liveStateChanged();
  }

  /** Probes GitHub for an item waiting out an outage; true when it answers. */
  private async githubHealthy(repositoryId: string): Promise<boolean> {
    try {
      await this.executionSource(repositoryId).rateLimit();
      return true;
    } catch {
      return false;
    }
  }

  private async stopStage(issue: StoredIssue, stageId: string, state: string, reason: string): Promise<boolean> {
    let stopped = true;
    this.#infrastructureFailures.delete(issue.id);
    this.releaseOutageItem(issue.id);
    const repository = this.config.repositories[issue.repositoryId]!;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    this.store.appendConversationMessage({
      issueId: issue.id, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: reason,
    });
    await applyStageTransition({
      store: this.store,
      source: this.executionSource(issue.repositoryId),
      sourceName: repository.source,
      address: repository.address,
      configHash: this.config.hash,
      transitionId: randomUUID(),
      issue,
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      result: { kind: "stopped", stageId, state, reason, requiredFixes: [], feedbackCycles: 0, result: null },
      actor: { name: "Conveyor", title: "Orchestrator" },
    }).catch((transitionError) => {
      stopped = false;
      log.error("Stopping the item as error failed", { ...this.itemFields(issue.id), stage: stageId }, transitionError);
    });
    await this.updateStatusComment(issue.id).catch(() => {});
    return stopped;
  }

  private retryLater(issueId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      if (this.#shuttingDown) return;
      const failure = this.#infrastructureFailures.get(issueId);
      if (failure && this.#outageRecords.has(failure)) {
        void this.resumeAfterOutageProbe(issueId, failure);
        return;
      }
      if (failure && this.#scriptWaitRecords.has(failure)) {
        this.resumeStage(issueId);
        return;
      }
      if (failure) this.#infrastructureFailures.set(issueId, {
        stageId: failure.stageId,
        count: failure.count,
      });
      this.resumeStage(issueId);
    }, delayMs);
    this.#retryTimers.add(timer);
  }

  private resumeStage(issueId: string): void {
    const current = this.store.getStageState(issueId);
    if (current?.status === "error") {
      this.store.setStageState({
        issueId,
        stageId: current.stageId,
        status: "ready",
        feedbackCycle: current.feedbackCycle,
        configHash: this.config.hash,
      });
      this.schedule();
    }
  }

  /** Resumes an item waiting out a GitHub outage once GitHub answers; otherwise keeps waiting or gives up at the limit. */
  private async resumeAfterOutageProbe(issueId: string, failure: { stageId: string; count: number; waiting?: IssueWaitingViewModel }): Promise<void> {
    // The item may be paused, moved or retried while the probe runs: only the wait this callback
    // belongs to may continue, so every check compares against the record it was armed with.
    const current = () => {
      const issue = this.store.getIssue(issueId);
      const stage = this.store.getStageState(issueId);
      const same = this.#infrastructureFailures.get(issueId) === failure &&
        issue?.projectedState === "active" && issue.projectedStage === failure.stageId &&
        stage?.stageId === failure.stageId && stage.status === "error";
      return same ? issue : null;
    };
    const issue = current();
    if (!issue) {
      if (this.#infrastructureFailures.get(issueId) === failure) {
        this.#infrastructureFailures.delete(issueId);
        this.releaseOutageItem(issueId);
      }
      return;
    }
    const healthy = await this.githubHealthy(issue.repositoryId);
    if (this.#shuttingDown || !current()) return;
    if (healthy) {
      // The count and first failure time stay (a stage that fails again keeps its outage clock), but
      // the item is running again, so it leaves the outage record.
      this.releaseOutageItem(issueId);
      this.resumeStage(issueId);
      return;
    }
    await this.waitOutGithubOutage(
      issue, failure.stageId, failure.count + 1, "GitHub still unavailable", failure.waiting?.since,
    );
  }

  /** Reconciliation resets warnings; a parked item's pending message is re-applied from its journal. */
  private restorePendingStatus(repositoryId: string): void {
    if (this.store.repositoryPause(repositoryId)) return;
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.projectedState !== "active" || issue.warning) continue;
      const message = this.store.executions().pendingMessage(issue.id);
      if (message === null) continue;
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: issue.projectedState,
        warning: message,
      });
    }
  }

  /** Drops the cached GitHub reads of the item's change request, so the next read sees what a push did. */
  private forgetChange(issueId: string, address: string): void {
    const stored = this.store.getCurrentPullRequest(issueId);
    if (stored) this.itemSource.forgetChange?.(address, stored.number);
  }

  private async loadDeliveryState(
    issueId: string,
    address: string,
  ): Promise<{ change: unknown | null; pullRequest: unknown | null; checks: unknown[] }> {
    const stored = this.store.getCurrentPullRequest(issueId);
    if (!stored) return { change: null, pullRequest: null, checks: [] };
    const repository = this.store.getIssue(issueId)?.repositoryId;
    const host = repository ? this.executionCodeHost(issueId, this.codeHostFor(repository)) : null;
    if (!host) throw new Error(`no code host configured for ${issueId}`);
    const delivery = await host.getChangeDelivery({ address, id: stored.id });
    this.store.upsertPullRequest({
      issueId,
      id: stored.id,
      number: delivery.change.number,
      url: delivery.change.url,
      state: delivery.change.state,
      ...(delivery.change.mergedAt || stored.mergedAt
        ? { mergedAt: delivery.change.mergedAt ?? stored.mergedAt }
        : {}),
    });
    const change: CiChange = { repository: address, changeId: String(delivery.change.number), url: delivery.change.url };
    const checks = await this.ciProvider(this.store.getIssue(issueId)?.repositoryId ?? "").list(change, delivery.change.headSha);
    return { change: delivery.change, pullRequest: delivery.pullRequest ?? null, checks };
  }

  private ciProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider {
    const repository = this.config.repositories[repositoryId];
    if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
    const providerName = repository.ci.provider ?? "actions";
    // Unreferenced named providers are inert. An omitted repository reference
    // selects its source-native provider with no named-provider configuration.
    const configured = repository.ci.provider ? this.config.ci[repository.ci.provider] : undefined;
    // A stage's own CI settings (legacy triggers) make a provider of their own.
    const key = `${repositoryId}:${providerName}:${JSON.stringify(stageInput?.triggers ?? null)}`;
    let provider = this.#ciProviders.get(key);
    if (!provider) {
      provider = this.#plugins.ciProvider(configured?.type ?? DEFAULT_CI_TYPE, { repositoryId, providerName, provider: configured, stageInput });
      this.#ciProviders.set(key, provider);
    }
    return provider;
  }

  /** Lets a paused repository keep observing CI while preventing CI dispatches and reruns. */
  private executionCiProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider {
    const provider = this.ciProvider(repositoryId, stageInput);
    const store = this.store;
    return new Proxy(provider, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property !== "start" && property !== "rerun") return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  /** The code host an item's run uses: its writes stop at the durable repository pause boundary. */
  private executionCodeHost(issueId: string, host: CodeHost | null): CodeHost | null {
    if (!host) return null;
    const repositoryId = this.store.getIssue(issueId)?.repositoryId;
    const store = this.store;
    return new Proxy(host, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (!CODE_HOST_WRITES.has(String(property))) return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (repositoryId && store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  /** Fences every item-task source mutation at the durable repository pause boundary. */
  private executionSource(repositoryId: string): ItemSourceClient {
    const store = this.store;
    return new Proxy(this.itemSource, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (!SOURCE_WRITES.has(String(property))) return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  private codeHostFor(repositoryId: string): CodeHost | null {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return null;
    const name = repository.codeHost ?? repository.source;
    return this.#codeHosts.get(name) ?? null;
  }

  /** Whether the stage's remaining work, from its durable cursor, starts no agent or script process. */
  private isGateOnlyExecution(issueId: string, repositoryId: string, stageId: string): boolean {
    // Older in-process fixtures carry no compiled plans; treat them as permit-consuming.
    const stage = (this.config.plans ?? [])
      .find((plan) => plan.repositoryId === repositoryId)
      ?.stages.find((candidate) => candidate.id === stageId);
    if (!stage || stage.legacy) return false;
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    if (!cursor || cursor.stage !== stageId || cursor.stageEpoch !== journal.stageEpoch(issueId)) return false;
    return !remainingWorkStartsProcess(stage, cursor);
  }

  private isSkippedStage(repositoryId: string, stageId: string): boolean {
    return (this.config.plans ?? [])
      .find((plan) => plan.repositoryId === repositoryId)
      ?.stages.find((candidate) => candidate.id === stageId)?.skipped === true;
  }

  private isLightweightStage(repositoryId: string, stageId: string): boolean {
    return isLightweightRepositoryStage(this.config, repositoryId, stageId);
  }

  /**
   * Purges an item that has no Conveyor labels any more (it left, or closed without a merge). One
   * entry point for every way Conveyor learns of it; see `ItemPurges`.
   */
  purgeItem(issueId: string): Promise<void> {
    return this.#purges.purge(issueId);
  }

  /** Resolves once every purge in progress has finished or given up for now. */
  purgesSettled(): Promise<void> {
    return this.#purges.settled();
  }

  /** Tells the runs that must not go on to stop; returns the items it told. */
  private interruptIneligibleRuns(): string[] {
    const interrupted: string[] = [];
    for (const [issueId, active] of this.#active) {
      const issue = this.store.getIssue(issueId);
      if (
        !issue ||
        issue.projectedState !== "active" ||
        issue.projectedStage !== active.stageId
      ) {
        active.controller.abort();
        interrupted.push(issueId);
      }
    }
    return interrupted;
  }

  /** Resolves once the runs of these items have ended: their agent processes are gone. */
  private async runsEnded(issueIds: readonly string[]): Promise<void> {
    while (issueIds.some((issueId) => this.#active.get(issueId)?.executorDone === false)) {
      if (this.#shuttingDown) return;
      await Bun.sleep(10);
    }
  }

  /** Reads the source into the projection; see RepositorySync.reconcileRepository. */
  private reconcileRepository(repositoryId: string, options: { partial?: boolean; includeIssueNumbers?: readonly number[]; only?: readonly number[] } = {}): Promise<void> {
    return this.#sync.reconcileRepository(repositoryId, options);
  }

  /** `scope` names the issues a webhook pass reads afresh; the others keep what was read before. Null reads all. */
  private reconcileRelationships(repositoryId: string, address: string, scope: ReadonlySet<number> | null = null): Promise<void> {
    return this.#rollups.reconcile(repositoryId, address, scope);
  }

  /** Creates item-scoped MCP grants for a stage's agents; see McpGrants.factory. */
  private mcpFactory(): ScopedMcpFactory {
    return this.#mcp.factory();
  }

  /** A system-scoped MCP grant for a steering or Operator run; see McpGrants.steeringLease. */
  private steeringMcpLease(
    runId: string,
    workspace: string,
    allowedTools: readonly string[],
    stopSummary?: { itemId: string; stopId: string },
  ): Promise<ScopedMcpLease> {
    return this.#mcp.steeringLease(runId, workspace, allowedTools, stopSummary);
  }

  private sourceActions(context: RuntimeIssueContext): SourceActionHandler {
    return {
      run: async (action) => {
        this.assertRepositoryActive(context.repository.id);
        const workspace = context.workspace;
        const changeOperation = changeAction(action.sourceAction);
        if (action.sourceAction === "workspace.cleanup") {
          await removeWorkspace({
            store: this.store,
            manager: this.workspaceManager,
            issueId: context.issue.id,
            repositoryFolder: context.repository.folder,
          });
          return;
        }
        if (!workspace) throw new Error(`${action.sourceAction} requires a workspace`);
        if (changeOperation === "ensure") {
          const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
          if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
          const ensured = await pushAndEnsureChange({
            codeHost, store: this.store, address: context.repository.address,
            issue: { id: context.issue.id, sourceNumber: context.issue.sourceNumber, title: context.issue.title },
            workspace, base: context.repository.baseBranch, closes: action.with?.closingReference !== false,
          });
          if (!ensured.pushed) return { outcome: "failure", status: ensured.status, reason: ensured.reason, summary: ensured.reason };
          return;
        }
        if (action.sourceAction === "ci.await" || action.sourceAction === "pullRequest.awaitChecks") {
          return this.awaitPullRequestChecks(context, workspace, action.with);
        }
        if (changeOperation === "merge") {
          const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
          if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
          const pullRequest = await codeHost.ensureChange({
            address: context.repository.address,
            issueNumber: context.issue.sourceNumber,
            branch: workspace.branch,
            base: context.repository.baseBranch,
            title: context.issue.title,
            closes: true,
          });
          const merged = await codeHost.mergeChange({ address: context.repository.address, id: pullRequest.id, method: "squash" });
          if (!merged.merged) throw new Error(`code host did not merge change request #${pullRequest.number}`);
          this.store.upsertPullRequest({
            issueId: context.issue.id,
            id: pullRequest.id,
            number: pullRequest.number,
            url: pullRequest.url,
            state: "merged",
            mergedAt: new Date().toISOString(),
          });
          return;
        }
        throw new Error(`unsupported source action: ${action.sourceAction}`);
      },
    };
  }

  /**
   * Gate a stage on CI for the change request's current head.
   */
  private async awaitPullRequestChecks(
    context: RuntimeIssueContext,
    workspace: { path: string; branch: string },
    input: Record<string, unknown> | undefined,
  ): Promise<SourceActionOutcome> {
    const options = parseCiGateOptions(input);
    const maxCorrections = typeof input?.maxCorrections === "number" ? input.maxCorrections : 5;
    const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
    if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
    const ensured = await pushAndEnsureChange({
      codeHost, store: this.store, address: context.repository.address,
      issue: { id: context.issue.id, sourceNumber: context.issue.sourceNumber, title: context.issue.title },
      workspace, base: context.repository.baseBranch, closes: input?.closingReference !== false,
    });
    if (!ensured.pushed) return { outcome: "failure", status: ensured.status, reason: ensured.reason, summary: ensured.reason };
    const pullRequest = ensured.change;
    const headSha = (await codeHost.getChange({ address: context.repository.address, id: pullRequest.id })).headSha;
    const outcome = await evaluateCiGate({
      change: { repository: context.repository.address, changeId: String(pullRequest.number), url: pullRequest.url },
      issueKey: context.issue.id,
      options,
      provider: this.executionCiProvider(context.issue.repositoryId, input),
      headSha,
      memory: this.#ciMemory,
      now: Date.now(),
      observe: (observation) => {
        const base = {
          issueId: context.issue.id, headSha, changeUrl: pullRequest.url, ignoreChecks: options.ignoreChecks,
          now: new Date(), authoritative: true,
        };
        if ("runs" in observation) observeCi(this.store, { ...base, runs: observation.runs });
        else observeCiError(this.store, { ...base, error: observation.error });
      },
    });
    if (outcome.outcome === "failure" && outcome.status === "changes-requested") {
      // Stop an implementation<->CI loop that is not converging.
      const transitions = this.store.listStageTransitions(context.issue.id);
      let corrections = 0;
      for (const transition of transitions) {
        if (transition.fromStage !== context.issue.projectedStage) continue;
        if (transition.kind === "advance") corrections = 0;
        else if (transition.kind === "correction") corrections += 1;
      }
      if (corrections >= maxCorrections) {
        return {
          ...outcome,
          status: "blocked",
          reason: `${outcome.reason} CI has now failed ${corrections + 1} times in a row after implementation fixes; a person needs to look.`,
        };
      }
    }
    return outcome;
  }

  /** An MCP tool call; see McpGrants.handle. */
  handleMcp(payload: unknown, token: string, callId?: string): Promise<unknown> {
    return this.#mcp.handle(payload, token, callId);
  }

  /** An item source's webhook secret, as its plugin reads it; empty when it has none. */
  private webhookSecretFor(sourceName: string): string {
    return this.#webhooks.settings(sourceName)?.secret ?? "";
  }

  async handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<void> {
    // Each item source type that receives webhooks tries the delivery with its providers' secrets;
    // providers may use different secrets on one webhook path.
    let receipt: WebhookReceipt | null = null;
    let sourceType = "";
    let failure: unknown = new Error("no item source receives webhooks");
    for (const type of new Set(Object.values(this.config.sources).map((source) => source.type))) {
      const receiver = this.#plugins.itemSource(type)?.webhook;
      if (!receiver) continue;
      const secrets = [...new Set(Object.entries(this.config.sources)
        .filter(([, source]) => source.type === type)
        .map(([name]) => this.webhookSecretFor(name))
        .filter(Boolean))];
      try {
        receipt = receiver.receive(rawBody, headers, secrets);
        sourceType = type;
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (!receipt) throw failure;
    if (receipt.kind === "ignored") return;
    const { delivery, secret } = receipt;
    const address = delivery.repositoryAddress?.toLowerCase();
    const repository = address === undefined
      ? undefined
      : Object.entries(this.config.repositories).find(([, candidate]) => candidate.address.toLowerCase() === address);
    // A delivery counts only for a repository whose own provider's secret signed it.
    if (repository && this.webhookSecretFor(repository[1].source) !== secret) throw new Error("invalid webhook signature for this repository");
    // The delivery and what it reports are recorded together; subscribers react once it committed.
    const recorded = withEventContext({ actor: { kind: "webhook", id: delivery.deliveryId } }, () =>
      this.store.recordSourceEvent({
        source: sourceType, deliveryId: delivery.deliveryId, eventType: delivery.eventType, payload: delivery.payload,
        repositoryId: repository?.[0] ?? null, observations: repository ? delivery.observations : [],
      }));
    if (!recorded) return;
    if (repository) delivery.recorded?.();
    if (address === undefined) return;
    if (!repository) this.schedule();
  }

  /** Resolves once every accepted webhook delivery has been processed. */
  webhooksSettled(): Promise<void> {
    return this.#sync.webhooksSettled();
  }

  /**
   * Updates the stored CI indicator from a CI event or a pull request that opened or got a new head.
   * Only the change's current head counts: an event for another head is dropped unless the code
   * host confirms it is the head now (then it replaces the old head's indicator).
   */
  private async applyCiEvent(repositoryId: string, event: StoredEvent): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    let head: string;
    let numbers: readonly number[];
    let newHead: boolean;
    if (isEventOf(event, "ci.runUpdated")) {
      // Progress (requested, in progress) changes nothing a reader of the indicator acts on;
      // ci.start already shows the head's CI as starting. Only a finished run is read.
      if (!event.payload.completed) return;
      head = event.payload.sha;
      numbers = event.payload.changes;
      newHead = false;
    } else if (isEventOf(event, "code.changeUpdated") && ["opened", "reopened", "synchronize"].includes(event.payload.action) && event.payload.headSha) {
      head = event.payload.headSha;
      numbers = [event.payload.number];
      newHead = true;
    } else return;
    const issueIds = new Set([
      ...numbers.flatMap((number) => this.store.findIssueIdsByPullRequest(repositoryId, number)),
      ...this.store.findIssueIdsByIndicatorHead(repositoryId, CI_INDICATOR_ID, head),
    ]);
    for (const issueId of issueIds) {
      const stored = this.store.getCurrentPullRequest(issueId);
      if (!stored || stored.state === "merged" || stored.mergedAt) continue;
      const indicator = this.store.listIndicators(issueId).find((entry) => entry.id === CI_INDICATOR_ID);
      const known = indicator?.headSha === head;
      // A completion can arrive after the change advanced but before its synchronize
      // delivery. Do not let a cached indicator make that old head look current.
      const liveHead = await this.currentChangeHead(repositoryId, stored.id);
      if (liveHead !== head) continue;
      this.setLiveChangeHead(issueId, liveHead);
      if (repository.ci?.mode === "disabled" || (newHead && known)) continue;
      const change = { repository: repository.address, changeId: String(stored.number), url: stored.url };
      const input = { issueId, headSha: head, changeUrl: stored.url, ignoreChecks: repository.ci?.ignoreChecks ?? [], now: new Date(), authoritative: !known };
      if (newHead) { startCiForHead(this.store, input); continue; }
      let runs: CiRun[];
      try { runs = await this.ciProvider(repositoryId).list(change, head); }
      catch (error) { observeCiError(this.store, { ...input, error }); continue; }
      observeCi(this.store, { ...input, runs });
    }
  }

  private async currentChangeHead(repositoryId: string, changeId: string): Promise<string | null> {
    const codeHost = this.codeHostFor(repositoryId);
    const address = this.config.repositories[repositoryId]?.address;
    if (!codeHost || !address) return null;
    try { return (await codeHost.getChange({ address, id: changeId })).headSha; }
    catch { return null; }
  }

  /** Records a changed source head after the dashboard can read it from the in-memory projection. */
  private setLiveChangeHead(issueId: string, headSha: string): void {
    if (this.#liveChangeHeads.get(issueId) === headSha) return;
    this.#liveChangeHeads.set(issueId, headSha);
    this.store.events().append("change.headObserved", { headSha }, { issueId });
  }

  /** Existing open changes acquire a current-head CI indicator after a reconcile or restart. */
  /** `scope` limits a webhook pass to the issues it names; null covers every open item. */
  private async backfillCiIndicators(repositoryId: string, scope: ReadonlySet<number> | null = null): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const ciDisabled = repository.ci?.mode === "disabled";
    const stored = ciDisabled
      ? new Map<string, ReturnType<ConveyorStore["listIndicators"]>[number]>()
      : new Map(this.store.listIndicators().filter((entry) => entry.id === CI_INDICATOR_ID).map((entry) => [entry.issueId, entry]));
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.sourceState !== "open") continue;
      if (scope !== null && !scope.has(issue.sourceNumber)) continue;
      const pullRequest = this.store.getCurrentPullRequest(issue.id);
      if (!pullRequest || pullRequest.state !== "open" || pullRequest.mergedAt) continue;
      try {
        const head = await this.currentChangeHead(repositoryId, pullRequest.id);
        if (!head) continue;
        this.setLiveChangeHead(issue.id, head);
        if (ciDisabled) continue;
        const current = stored.get(issue.id);
        // A stored indicator is kept only while it is for the current head and no longer "starting".
        if (current?.headSha === head && current.progress !== "starting") continue;
        const change = { repository: repository.address, changeId: String(pullRequest.number), url: pullRequest.url };
        observeCi(this.store, {
          issueId: issue.id, headSha: head, changeUrl: pullRequest.url, ignoreChecks: repository.ci?.ignoreChecks ?? [],
          now: new Date(), authoritative: true, runs: await this.ciProvider(repositoryId).list(change, head),
        });
      } catch (error) {
        log.warn("CI indicator backfill failed", this.itemFields(issue.id), error);
      }
    }
  }

  /**
   * Wakes an item whose cursor is parked on `agent.run` in the stage of the run that asked the
   * question. Any other parked task, and every legacy stage, keeps the restart behaviour.
   */
  private wakeParkedAgent(question: { issueId: string; runId: string | null }): boolean {
    const journal = this.store.executions();
    const cursor = journal.getCursor(question.issueId);
    const run = question.runId ? this.store.getRun(question.runId) : null;
    const issue = this.store.getIssue(question.issueId);
    if (!cursor || run?.stageId !== cursor.stage || !issue || !this.hasResumableQuestionExecution(question.issueId)) return false;
    return this.wakeParked(question.issueId);
  }

  /** Accepts an answer to an agent's question; see QuestionAnswers.answer. */
  answerQuestion(questionId: string, answer: string, source = "web", evidence?: string): Promise<void> {
    return this.#answers.answer(questionId, answer, source, evidence);
  }

  /** Resolves once every answer's background work (comment, re-sync, status) has finished. */
  async answerFollowUpsSettled(): Promise<void> {
    await this.#answers.followUpsSettled();
    await this.eventsSettled();
  }

  /** Tests shorten the pauses between answer-mirror retries. */
  get answerRetryDelayMs(): number | null {
    return this.#answers.retryDelayMs;
  }

  set answerRetryDelayMs(delayMs: number | null) {
    this.#answers.retryDelayMs = delayMs;
  }

  /** Starts one scheduled Operator check when stopped work is on the board; see Steering.runScheduledCheck. */
  runScheduledOperatorCheck(): Promise<string | null> {
    return this.#steering.runScheduledCheck();
  }

  /** Wait for every running stop-summary run to settle. */
  waitForStopSummaryRuns(): Promise<void> {
    return this.#steering.waitForStopSummaries();
  }

  /** Starts a person's steering request; see Steering.start. */
  startSteering(prompt: string): Promise<string> {
    return this.#steering.start(prompt);
  }

  /** Wait for a currently running steering request to settle. */
  waitForSteeringRun(runId: string): Promise<void> {
    return this.#steering.waitFor(runId);
  }

  reorderBacklog(issueId: string, direction: "up" | "down"): void {
    this.requireBacklogIssue(issueId);
    this.store.moveQueueIssue(issueId, direction);
  }

  /** Drag-and-drop placement: put a backlog issue right before another, or last. */
  moveBacklogIssue(issueId: string, beforeIssueId: string | null): void {
    this.requireBacklogIssue(issueId);
    if (beforeIssueId !== null) this.requireBacklogIssue(beforeIssueId);
    this.store.moveQueueIssueBefore(issueId, beforeIssueId);
  }

  private requireBacklogIssue(issueId: string): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.parentId || issue.projectedState === "unlisted") {
      throw new Error("only top-level board issues can be reordered");
    }
    const repository = this.config.repositories[issue.repositoryId];
    const firstStage = repository
      ? this.config.pipelines[repository.pipeline]?.stages[0]?.id
      : undefined;
    if (!firstStage || issue.projectedStage !== firstStage) {
      throw new Error("only backlog issues can be reordered");
    }
  }

  /** Queues a write of the issue's status comment; see StatusCommentWriter.update. */
  private updateStatusComment(issueId: string): Promise<void> {
    return this.#statusComments.update(issueId);
  }

  /** The approval fence for an item. A merged item uses the durable review fence, not a later PR projection. */
  private criterionApprovalHead(issue: StoredIssue): string | null {
    const pullRequest = this.store.getCurrentPullRequest(issue.id);
    const context = this.store.executions().getContext(issue.id)?.context;
    const change = context?.change;
    if (!pullRequest || !change) return null;
    if (pullRequest.state === "merged" || pullRequest.mergedAt !== null || change.state === "merged") {
      return change.state === "merged" ? change.headSha : context.checkpoints.reviewPassed?.sha ?? null;
    }
    if (pullRequest.state !== "open" || change.state !== "open") return null;
    return this.#liveChangeHeads.get(issue.id) ?? change.headSha;
  }

  /** Source-authoritative criteria annotated from durable review approvals. */
  private criterionApprovalStates(issue: StoredIssue) {
    const approvals = new Map(
      this.store.criterionApprovals().list(issue.id).map((approval) => [approval.criterionId, approval]),
    );
    const headSha = this.criterionApprovalHead(issue);
    const evidence = new Map(this.store.criterionTestEvidence(issue.id).map((entry) => [entry.criterionId, entry]));
    const repository = this.config.repositories[issue.repositoryId];
    const host = this.codeHostFor(issue.repositoryId);
    return criteriaOf(issue.body).map(({ id, text, manual }) => {
      const recorded = evidence.get(id);
      return {
        id,
        text,
        approved: isCriterionApprovedAt(approvals, { id, text }, headSha),
        manual,
        tests: (recorded?.tests ?? []).map((test) => ({
          name: test.name,
          file: test.file,
          line: test.line ?? null,
          description: test.description ?? null,
          sourceUrl: repository && host && recorded?.sourceLinkHead
            ? host.sourceFileUrl({ address: repository.address, path: test.file, headSha: recorded.sourceLinkHead, ...(test.line === undefined ? {} : { line: test.line }) })
            : null,
        })),
      };
    });
  }

  /** Reads an open change's live head, so what is shown agrees with the review gate even when a webhook was delayed. */
  private async refreshLiveChangeHead(issue: StoredIssue): Promise<void> {
    const openPullRequest = this.store.getCurrentPullRequest(issue.id);
    if (openPullRequest?.state === "open" && !openPullRequest.mergedAt) {
      const liveHead = await this.currentChangeHead(issue.repositoryId, openPullRequest.id);
      if (liveHead) this.setLiveChangeHead(issue.id, liveHead);
    } else {
      this.#liveChangeHeads.delete(issue.id);
    }
  }

  private repositorySummaries(issues?: readonly StoredIssue[]): RepositorySummaries {
    return buildRepositorySummaries({
      store: this.store,
      config: this.config,
      ...(issues ? { issues } : {}),
      onboardingErrors: this.#sync.onboardingErrors,
      reconciliationErrors: this.#sync.reconcileErrors,
      startup: this.#sync.startup,
      lastReconciledAt: this.#sync.lastReconciledAt,
      webhookHealth: this.#webhooks.health,
      githubCalls: this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS),
    });
  }

  async postIssueMessage(
    issueId: string,
    message: string,
    username: string,
  ): Promise<{ status: "delivered" | "started" | "queued"; stageId: string }> {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    if (issue.sourceState === "closed" && !this.store.hasMergedPullRequest(issueId)) {
      throw new Error("closed issues cannot be resumed from conversation");
    }
    if (["done", "inconsistent"].includes(issue.projectedState ?? "")) {
      throw new Error(`issue state ${issue.projectedState} cannot be resumed from conversation`);
    }
    const activeRun = this.store.listActiveIssueRuns().find((run) => run.issueId === issueId);
    const running = this.#active.has(issueId) || Boolean(activeRun);
    const question = this.store.listOpenQuestions().find((candidate) => candidate.issueId === issueId);
    const resumesQuestionRun = question !== undefined &&
      question.runId !== null &&
      this.hasResumableQuestionExecution(issueId);
    if (!running && !resumesQuestionRun && this.store.listChildren(issueId).length > 0) {
      throw new Error("roll-up parents cannot run directly; message a child issue instead");
    }
    const stageId = issue.projectedStage ?? this.store.getStageState(issueId)?.stageId ?? activeRun?.stageId ?? null;
    if (!stageId) throw new Error("issue has no unambiguous configured stage to resume");
    // Reject an invalid choice before it becomes a misleading conversation
    // entry. Human replies may use the label rendered by the form.
    const answer = question ? conversationQuestionAnswer(question, message) : null;
    const recorded = question && !running ? null : this.store.appendConversationMessage({
      issueId,
      runId: null,
      stageId,
      actorType: "user",
      actorId: username,
      actorName: username,
      actorTitle: null,
      message,
    });
    if (running) return { status: "delivered", stageId };

    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) throw new Error("issue repository is not configured");
    const pipeline = this.config.pipelines[repository.pipeline];
    if (!pipeline || !pipeline.stages.some((stage) => stage.id === stageId)) {
      throw new Error("issue has no unambiguous configured stage to resume");
    }

    if (question) {
      await this.answerQuestion(question.id, answer!, username);
    } else {
      const metadata = metadataLabels(issue.labels, this.config);
      const labels = [
        this.config.labels.enrollment,
        this.config.labels.stageTemplate.replace("{stage}", stageId),
        ...metadata,
      ];
      const mutation = this.store.beginSourceMutation({
        idempotencyKey: `conversation-resume:${recorded!.id}`,
        source: repository.source,
        operation: "issue.labels.resume",
        request: { issueId, issueNumber: issue.sourceNumber, labels },
      });
      if (mutation.status !== "succeeded") {
        try {
          await this.executionSource(issue.repositoryId).replaceConveyorLabels(
            repository.address,
            issue.sourceNumber,
            labels,
            [this.config.labels.metadata.noSplit, this.config.labels.metadata.paused],
          );
          this.store.completeSourceMutation(mutation.id, { labels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          this.store.failSourceMutation(
            mutation.id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
      const refreshed = this.store.getIssue(issueId);
      if (refreshed?.queueRank === null) this.store.setQueueRank(issueId, this.store.nextQueueRank());
      this.store.events().append("item.requeued", { reason: "message" }, { issueId });
      await this.eventsSettled();
      await this.updateStatusComment(issueId).catch((error) => {
        log.error("Status comment update failed after conversation resume", this.itemFields(issueId), error);
      });
    }

    await this.eventsSettled();
    const status = this.#active.has(issueId) ? "started" : "queued";
    this.store.appendConversationMessage({
      issueId,
      runId: null,
      stageId,
      actorType: "conveyor",
      actorId: "conveyor",
      actorName: "Conveyor",
      actorTitle: "Orchestrator",
      message: status === "started"
        ? `Started ${stageId}; your message is included in the agent handoff.`
        : `Queued ${stageId}; your message is included in the next agent handoff. Dependencies or runner capacity may delay the start.`,
    });
    return { status, stageId };
  }

  /**
   * Whether an agent is running for the item right now: the item executes (or has a live run in)
   * a stage whose runner is an agent, not a script, a gate-only pass or a source action.
   */
  hasRunningAgent(issueId: string): boolean {
    const active = this.#active.get(issueId);
    if (active?.gateOnly) return false;
    const issue = this.store.getIssue(issueId);
    if (!issue) return false;
    const stageId = active?.stageId ?? this.store.listActiveIssueRuns().find((run) => run.issueId === issueId && run.kind !== "orchestration")?.stageId;
    if (!stageId) return false;
    const pipeline = this.config.pipelines[this.config.repositories[issue.repositoryId]?.pipeline ?? ""];
    const stage = pipeline?.stages.find((candidate) => candidate.id === stageId);
    return Boolean(stage && !isNativeStage(stage) && stage.run.type === "agent");
  }

  private hasLiveIssueRun(issueId: string): boolean {
    return this.#active.has(issueId) || this.store.listActiveIssueRuns().some((run) => run.issueId === issueId);
  }

  /** Whether this stage's agent is allowed to create children. */
  private stageCreatesChildren(repositoryId: string, stageId: string | null): boolean {
    if (!stageId) return false;
    const repository = this.config.repositories[repositoryId];
    const stage = repository && this.config.pipelines[repository.pipeline]?.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return false;
    const agentIds = isNativeStage(stage)
      ? stage.actions.flatMap((task) => task.task !== "agent.run" ? [] : [
        ...(typeof task.with?.agent === "string" ? [task.with.agent] : []),
        ...(Array.isArray(task.with?.agents) ? task.with.agents.filter((agent): agent is string => typeof agent === "string") : []),
      ])
      : "run" in stage && stage.run?.type === "agent" ? [stage.run.agent] : [];
    return agentIds.some((agentId) => this.config.agents[agentId]?.tasks.some((task) =>
      task === "item.createChild" || task === "breakdown.createChildren",
    ));
  }

  /** Only an explicit retry may schedule a parent that already has children. */
  private childCreationRetryQueued(issue: StoredIssue, stageId: string | null): boolean {
    return this.stageCreatesChildren(issue.repositoryId, stageId) &&
      this.store.getStageState(issue.id)?.status === "retry-ready";
  }

  /** Whether the stored state permits a stage retry before the command verifies the source snapshot. */
  canRetryIssue(issueId: string): boolean {
    return this.#retries.canRetry(issueId);
  }

  /** The configured destination for a stopped CI gate's deliberate retry, when it is still valid. */
  retryTargetStage(issueId: string): string | null {
    return this.#retries.targetStage(issueId);
  }

  /** Whether the stored state permits resuming a stopped parent before the command verifies the source snapshot. */
  canResumeRollupParent(issueId: string): boolean {
    return this.#rollups.canResume(issueId);
  }

  /** Clears a stopped parent's stop label on the source so it waits for its children again. */
  resumeRollupParent(issueId: string): Promise<{ stageId: string }> {
    return this.#rollups.resume(issueId);
  }

  /** Retries a stopped item: clears its stop label on the source, reconciles it and requeues it. */
  retryIssue(issueId: string, note: string, username: string, automated = false): Promise<{ status: "started" | "queued"; stageId: string }> {
    return this.#retries.retry(issueId, note, username, automated);
  }

  /** Reconciled at least once, not stopping, and every repository onboarded and reconciling. */
  isReady(): boolean {
    return !this.#shuttingDown && this.#sync.ready();
  }

  /** Stops admitting new work; running work continues. Idempotent: the first reason is kept. */
  drain(reason: string, upgrade: { targetVersion: string; releaseTag: string } | null = null): { since: string; reason: string } {
    return this.#admission.drain(reason, upgrade);
  }

  /** Admits new work again after a drain; false when no drain was in effect. */
  resumeAdmission(): boolean {
    return this.#admission.resumeAdmission();
  }

  draining(): { since: string; reason: string } | null {
    return this.#admission.draining();
  }

  /** Rejects an operation that would admit work or mutate the paused repository's source. */
  private assertRepositoryActive(repositoryId: string): void {
    if (this.store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
  }

  /** Work in flight: items executing a stage, and steering runs. */
  activeWork(): ActiveWork {
    return {
      items: [...this.#active.entries()].map(([issueId, active]) => ({ issueId, repositoryId: active.repositoryId, stageId: active.stageId })),
      steering: this.#steering.running,
    };
  }

  /** Pauses future repository work without changing its configured plan or any item projection. */
  pauseRepository(repositoryId: string, reason: string, actor: string): { pausedAt: string } {
    return this.#admission.pauseRepository(repositoryId, reason, actor);
  }

  /** Re-admits retained work without changing individual item enrollment. */
  resumeRepository(repositoryId: string): Promise<{ resumedAt: string }> {
    return this.#admission.resumeRepository(repositoryId);
  }

  /** Pauses an item by adding the paused label; its labels, stage, worktree and history are kept. */
  pauseIssue(issueId: string, actor: string): Promise<{ stageId: string | null }> {
    return this.#admission.pauseItem(issueId, actor);
  }

  /** Resumes a paused item by removing the paused label; reports whether its stage started or queued. */
  resumeIssue(issueId: string, actor: string): Promise<{ status: "started" | "queued"; stageId: string | null }> {
    return this.#admission.resumeItem(issueId, actor);
  }

  /** An operator's dismissal of a review finding: the dispatcher runs `change.dismissFinding` as that human, never an agent. */
  async dismissFinding(issueId: string, findingId: string, reason: string, username: string): Promise<void> {
    const issue = this.store.getIssue(issueId);
    const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
    if (!issue || !repository) throw new Error("issue not found");
    const actor = { id: `human:${username}`, name: username, title: "Operator" };
    await dispatchTool({
      name: "change.dismissFinding",
      input: { findingId, reason },
      actor,
      grant: { runId: `web:${username}`, stageId: issue.projectedStage ?? "", issueScoped: true, actor, tasks: new Set(["change.dismissFinding"]) },
    }, {
      registry: createTaskRegistry(),
      deps: () => this.taskDeps(issue.id, { id: issue.repositoryId, address: repository.address, folder: repository.folder, baseBranch: repository.baseBranch }),
      liveHeadSha: async () => null,
      store: this.store,
    });
    // The finding.changed event wakes an item parked on its review gate.
    await this.updateStatusComment(issue.id);
  }

  /** An operator's change of a finding's type; the write, its history row and its event share one transaction. */
  reclassifyFinding(issueId: string, findingId: string, type: FindingType, username: string): { changed: boolean } {
    return { changed: this.store.findings().reclassify(issueId, findingId, type, username) };
  }

  /** What the web routes take from this service besides the dashboard's reads. */
  webSources(): WebSources {
    return {
      config: this.config,
      store: this.store,
      commands: this.commands,
      isReady: () => this.isReady(),
      webhookPath: () => Object.keys(this.config.sources).map((name) => this.#webhooks.settings(name)?.path).find((path) => path !== undefined) ?? null,
      handleWebhook: (body, headers) => this.handleWebhook(body, headers),
      handleMcp: (body, token, callId) => this.handleMcp(body, token, callId),
    };
  }

  /** What the control socket, the release coordinator and the operator MCP read, and the commands they send. */
  controlSources(): ControlSources {
    return {
      config: this.config,
      store: this.store,
      commands: this.commands,
      isReady: () => this.isReady(),
      startupStatus: () => this.startupStatus(),
      draining: () => this.draining(),
      githubOutage: () => this.githubOutage(),
      activeWork: () => this.activeWork(),
      githubCallReport: () => this.githubCallReport(),
      itemNow: (issueId) => this.itemNow(issueId),
      hasRunningAgent: (issueId) => this.hasRunningAgent(issueId),
      canResumeRollupParent: (issueId) => this.canResumeRollupParent(issueId),
      canRetryIssue: (issueId) => this.canRetryIssue(issueId),
      retryTargetStage: (issueId) => this.retryTargetStage(issueId),
      createIssue: (input) => this.createIssue(input),
      drain: (reason, upgrade) => this.drain(reason, upgrade),
      resumeAdmission: () => this.resumeAdmission(),
    };
  }
}
