// The dashboard's view models (#675): the board, an item's card, activity, journey and conversation,
// the Operator view and the server status. They are built only from DashboardSources (store reads,
// the configuration and the service's live state), never from the service or the whole store.

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import type { DashboardSources, DashboardStore } from "../../app/dashboard-sources";
import { githubOutageLine } from "../../app/github-outage";
import { CI_INDICATOR_ID, indicatorView } from "../../app/indicators";
import { itemTransitions } from "../../app/item-history";
import type { ConveyorConfig } from "../../config/load";
import { isNativeStage } from "../../config/schema";
import { STOPPED_ISSUE_STATES } from "../../core/issue-state";
import { boardStageOrder } from "../../core/pipeline";
import { stopHeadline, type StoredIssue } from "../../db/store";
import { summarizeTodos, type TodoItem } from "../../db/todos";
import { questionConfigurationError, questionOptions } from "../../questions";
import { displayName, formatDuration, formatUsage } from "../../web/format";
import type { DashboardPageSelection, DashboardViewModel, GraphNodeViewModel, GraphRelationshipViewModel, IndicatorViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRelationViewModel, IssueRunEventsViewModel, IssueStageBadgeViewModel, IssueTodosViewModel, IssueTone, QuestionViewModel, RecentActivityEventViewModel, RecentActivityType, RecentActivityViewModel, StageActorViewModel, StageColumnViewModel, SteeringViewModel, SystemStatusViewModel } from "../../web/types";
import { collectSystemStatus } from "./system-status";

const DASHBOARD_PAGE_SIZE = 20;
/** The live model holds every current item and the most recent finished ones; older ones are paged. */
export const DASHBOARD_SNAPSHOT_SELECTION: DashboardPageSelection = {
  view: "board", repositoryId: null, column: null, page: 1, doneLimit: 50, runId: null, issueId: null,
  repositoryIds: [], q: "", state: null, recentTypes: [], recentCursor: null,
};
const ACTIVITY_RUN_PAGE_SIZE = 1;
const ACTIVITY_EVENT_PAGE_SIZE = 5;
const recentActivityCandidateLimit = 500;

function itemStageBadge(
  stageId: string | null,
  stageNames: ReadonlyMap<string, string>,
  stageIcons: ReadonlyMap<string, string>,
  position: "backlog" | "done" | null,
): IssueStageBadgeViewModel {
  if (position === "backlog") return { name: "Backlog", icon: null };
  if (position === "done") return { name: "Done", icon: null };
  const name = stageId === null ? "Unknown stage" : stageNames.get(stageId) ?? displayName(stageId);
  return { name, icon: stageId === null ? null : stageIcons.get(stageId) ?? null };
}

function userFacingSteeringEvent(event: {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}): { sequence: number; type: string; text: string; createdAt: string } | null {
  try {
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return null;
    const payload = event.payload as Record<string, unknown>;
    let text: string | null = null;
    if (["user", "report", "error"].includes(event.type)) {
      text = typeof payload.text === "string" ? payload.text : null;
    } else if (["report_progress", "report_milestone", "report_blocker"].includes(event.type)) {
      text = typeof payload.message === "string"
        ? payload.message
        : typeof payload.summary === "string"
          ? payload.summary
          : typeof payload.reason === "string"
            ? payload.reason
            : null;
    }
    return text
      ? { sequence: event.sequence, type: event.type, text, createdAt: event.createdAt }
      : null;
  } catch {
    return null;
  }
}

function todosView(items: readonly TodoItem[]): IssueTodosViewModel | null {
  const summary = summarizeTodos(items);
  return summary ? { ...summary, items } : null;
}

/** Builds the dashboard's view models from what it reads; it holds no state of its own. */
export class DashboardViews {
  readonly #sources: DashboardSources;
  readonly #store: DashboardStore;
  readonly #config: ConveyorConfig;

  constructor(sources: DashboardSources) {
    this.#sources = sources;
    this.#store = sources.store;
    this.#config = sources.config;
  }

  /** Matches the event stream revision to displayed repository facts, excluding volatile report timestamps. */
  #dashboardRevision(repositorySummaries = this.#sources.repositorySummaries()): string {
    const repositoryFacts = repositorySummaries.repositories.map(({ id, health, error, lastReconciledAt, startup }) => ({ id, health, error, lastReconciledAt, startup }));
    const repositoryDigest = createHash("sha256").update(JSON.stringify(repositoryFacts)).digest("hex");
    return `${this.#store.dashboardRevision()}|repositories:${repositoryDigest}`;
  }

  /** The whole board for a page selection: columns, Done, Needs you, questions, the graph and the Recent view. */
  dashboard(
    csrfToken: string,
    pagination: DashboardPageSelection = {
      view: "board",
      repositoryId: null,
      column: null,
      page: 1,
      doneLimit: 20,
      runId: null,
      issueId: null,
      repositoryIds: [],
      q: "",
      state: null,
      recentTypes: [],
      recentCursor: null,
    },
  ): DashboardViewModel {
    const agentRunner = new Map(Object.entries(this.#config.agents ?? {}).map(([agentId, agent]) => [agentId, agent.runner]));
    const harnessUsage = Object.entries(this.#config.runners ?? {}).flatMap(([runnerId, runner]) => {
      const harness = this.#sources.harnesses[runner.type];
      if (!harness?.quota) return [];
      const windows = harness.quota({
        harnessEvents: () => [...agentRunner.entries()].flatMap(([agentId, configuredRunner]) =>
          configuredRunner === runnerId ? this.#store.listHarnessRunEvents(agentId) : [],
        ),
      });
      return [{
        id: runnerId,
        name: runnerId === "codex" ? "Codex" : runnerId === "claude-code" ? "Claude Code" : displayName(runnerId),
        windows,
      }];
    });
    const listedIssues = this.#store.listIssues();
    const issues = listedIssues.filter((issue) => issue.projectedState !== "unlisted");
    const repositoryColors = new Map(Object.keys(this.#config.repositories).map((repositoryId, index) =>
      [repositoryId, (index % 8) + 1],
    ));
    const activeRuns = this.#store.listActiveIssueRuns();
    const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const listedById = new Map(listedIssues.map((issue) => [issue.id, issue]));
    const openQuestions = this.#store.listOpenQuestions().filter((question) => byId.has(question.issueId));
    const questionIssueIds = new Set(openQuestions.map((question) => question.issueId));
    const relation = (issue: StoredIssue): IssueRelationViewModel => ({
      id: issue.id,
      repository: issue.repositoryId,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      satisfied:
        issue.sourceState === "closed" ||
        issue.projectedState === "done" ||
        issue.projectedState === "completed",
    });
    const rollupRelation = (issue: StoredIssue): IssueRelationViewModel => ({
      ...relation(issue),
      satisfied: this.#sources.isRollupSatisfied(issue.id),
    });
    // A parent card places each child on the line: Backlog, each configured stage, then Done.
    // Called only while cards are built, after the stages and the backlog below are known.
    const childRelation = (child: StoredIssue): IssueRelationViewModel => {
      const base = rollupRelation(child);
      const names = ["Backlog", ...stages.map((stage) => stageNames.get(stage) ?? displayName(stage)), "Done"];
      const stageIndex = child.projectedStage ? stages.indexOf(child.projectedStage) : -1;
      const index = base.satisfied
        ? names.length - 1
        : backlogIds.has(child.id) || stageIndex < 0 ? 0 : stageIndex + 1;
      const station = { index, count: names.length, name: names[index]! };
      return { ...withProgress(child, base), station };
    };
    // An unfinished child or dependency also says whether it is moving, and its state in words.
    const withProgress = (item: StoredIssue, base: IssueRelationViewModel): IssueRelationViewModel => {
      if (base.satisfied) return base;
      const state = item.projectedState ?? item.sourceState;
      const signal = activeIssueIds.has(item.id)
        ? "run"
        // An item with inconsistent labels cannot move until someone repairs them: it is stopped too.
        : questionIssueIds.has(item.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { ...base, signal, state: displayName(state) };
    };
    const tone = (state: string): IssueTone => {
      if (state === "done" || state === "completed") return "success";
      if (["blocked", "error", "rejected", "needs-intervention", "inconsistent"].includes(state)) {
        return "danger";
      }
      if (["paused", "needs-input"].includes(state)) return "warning";
      if (state === "closed") return "muted";
      return "active";
    };
    const todos = this.#store.todos();
    const renderedAt = Date.now();
    const indicators = new Map<string, IndicatorViewModel[]>();
    for (const stored of this.#store.listIndicators()) {
      // CI that is disabled for the repository shows nothing, even if a record was stored earlier.
      const repositoryId = byId.get(stored.issueId)?.repositoryId;
      if (stored.id === CI_INDICATOR_ID && (!repositoryId || this.#config.repositories[repositoryId]?.ci?.mode === "disabled")) continue;
      indicators.set(stored.issueId, [...(indicators.get(stored.issueId) ?? []), indicatorView(stored, renderedAt)]);
    }
    // A dashboard uses the same item facts in columns, rollups, related-item details, and the
    // selected card. Keep each per-item store lookup to one read for the whole model build.
    const stageStates = new Map<string, ReturnType<DashboardStore["getStageState"]>>();
    const stageStateFor = (issueId: string) => {
      if (!stageStates.has(issueId)) stageStates.set(issueId, this.#store.getStageState(issueId));
      return stageStates.get(issueId)!;
    };
    const childrenByParent = new Map<string, ReturnType<DashboardStore["listChildren"]>>();
    const childrenFor = (issueId: string) => {
      if (!childrenByParent.has(issueId)) childrenByParent.set(issueId, this.#store.listChildren(issueId));
      return childrenByParent.get(issueId)!;
    };
    const dependenciesByIssue = new Map<string, ReturnType<DashboardStore["listDependencies"]>>();
    const dependenciesFor = (issueId: string) => {
      if (!dependenciesByIssue.has(issueId)) dependenciesByIssue.set(issueId, this.#store.listDependencies(issueId));
      return dependenciesByIssue.get(issueId)!;
    };
    const dependentsByIssue = new Map<string, ReturnType<DashboardStore["listDependents"]>>();
    const dependentsFor = (issueId: string) => {
      if (!dependentsByIssue.has(issueId)) dependentsByIssue.set(issueId, this.#store.listDependents(issueId));
      return dependentsByIssue.get(issueId)!;
    };
    const costsByIssue = new Map<string, ReturnType<DashboardStore["costSummary"]>>();
    const costFor = (issueId: string) => {
      if (!costsByIssue.has(issueId)) costsByIssue.set(issueId, this.#store.costSummary({ issueId }));
      return costsByIssue.get(issueId)!;
    };
    const liveStatus = this.#sources.liveStatusReader(listedIssues, {
      stageState: stageStateFor,
      dependencies: dependenciesFor,
      children: childrenFor,
      issue: (issueId) => listedById.get(issueId) ?? null,
    });
    const card = (
      issue: StoredIssue,
      options: { reason?: string | null; state?: string } = {},
    ): IssueCardViewModel => {
      const state = stageStateFor(issue.id);
      const cost = costFor(issue.id);
      const children = childrenFor(issue.id)
        .flatMap(({ issueId }) => {
          const child = byId.get(issueId);
          return child ? [childRelation(child)] : [];
        });
      const dependencies = dependenciesFor(issue.id)
        .flatMap((issueId) => {
          const dependency = listedById.get(issueId);
          return dependency ? [withProgress(dependency, relation(dependency))] : [];
        });
      const projectedState = options.state ?? issue.projectedState ?? issue.sourceState;
      const parent = issue.parentId ? byId.get(issue.parentId) : null;
      const siblings = parent
        ? childrenFor(parent.id).flatMap(({ issueId }) => {
            const sibling = byId.get(issueId);
            return sibling ? [rollupRelation(sibling)] : [];
          })
        : [];
      const cursor = this.#store.executions().getCursor(issue.id);
      const manualGates = this.#sources.manualGateViews(issue);
      const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
      const parked = !questionIssueIds.has(issue.id) ? liveStatus(issue) : null;
      const retry = !activeIssueIds.has(issue.id)
        ? this.#sources.retryWaiting(issue.id)
        : null;
      const waiting = parked ?? retry;
      const stopped = STOPPED_ISSUE_STATES.has(projectedState);
      const openQuestion = stopped ? openQuestions.find((question) => question.issueId === issue.id) : undefined;
      const waitingDependencies = dependencies.filter((dependency) => !dependency.satisfied);
      const dependencyReason = waitingDependencies.length > 0
        ? `Waiting for ${waitingDependencies.map((dependency) => `#${dependency.number} ${dependency.title}`).join(", ")} to be completed.`
        : null;
      const stopReason = stopped
        ? this.#sources.latestStopReason(issue.id) ??
          (openQuestion ? `${openQuestion.reason}. Answer needed: ${openQuestion.prompt}` : null) ??
          dependencyReason ?? issue.warning ?? options.reason ??
          "Conveyor received the stopped state, but no blocking reason was recorded. Add the concrete blocker and required action in Conversation before resuming this item."
        : null;
      const viewIssue = { ...issue, projectedState };
      const retryable = this.#sources.retryableStoppedIssue(viewIssue, children.length, activeIssueIds.has(issue.id));
      const resumable = this.#resumablePausedIssue(viewIssue, activeIssueIds.has(issue.id));
      const resumableRollup = this.#sources.resumableRollupIssue(viewIssue, children.length, activeIssueIds.has(issue.id), openQuestion !== undefined);
      return {
        id: issue.id,
        repository: issue.repositoryId,
        repositoryPaused: this.#store.repositoryPause(issue.repositoryId) !== null,
        repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
        number: issue.sourceNumber,
        title: issue.title,
        url: issue.sourceUrl,
        state: projectedState,
        labels: issue.labels,
        issueType: issue.metadata.type,
        issueFields: this.#issueFieldValues(issue),
        acceptanceCriteria: this.#sources.criterionApprovalStates(issue),
        manualGates,
        csrfToken,
        todos: todosView(todos.get(issue.id)?.items ?? []),
        stage: issue.projectedStage,
        stageBadge: stageBadgeFor(issue, state),
        searchActors: issue.projectedStage
          ? actorsForStage(issue.projectedStage, this.#config.repositories[issue.repositoryId]?.pipeline)
          : [],
        indicators: indicators.get(issue.id) ?? [],
        activity: cursor?.state === "pending"
          ? `${cursor.stage} › ${cursor.taskInstanceId ?? cursor.list}`
          : state ? `${state.stageId} · ${state.status}` : null,
        // Live waiting/queued text supersedes the persisted warning, which can describe the
        // gate state from before the item became runnable.
        reason: stopReason ?? (manualWaiting
          ? manualWaiting.kind === "board" ? "Waiting for board approval"
            : manualWaiting.kind === "entry" ? "Waiting for configured entry approval."
              : `Waiting for configured manual gate \"${manualWaiting.gateId}\".`
          : waiting ? null : issue.warning ?? options.reason ?? null),
        cost: formatUsage(cost),
        duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
        stateChangedAt: state?.updatedAt ?? issue.sourceUpdatedAt,
        waiting,
        blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(projectedState),
        inconsistent: issue.projectedState === "inconsistent",
        closable: issue.labels.includes(this.#config.labels.metadata.closable),
        noSplit: issue.labels.includes(this.#config.labels.metadata.noSplit),
        tone: tone(projectedState),
        parent: parent ? rollupRelation(parent) : null,
        parentProgress: parent && siblings.length > 0
          ? { done: siblings.filter((sibling) => sibling.satisfied).length, total: siblings.length }
          : null,
        children,
        dependencies,
        working: activeIssueIds.has(issue.id),
        needsAttention: questionIssueIds.has(issue.id) || manualWaiting !== null || [
          "blocked", "error", "needs-input", "needs-intervention", "rejected",
        ].includes(projectedState),
        retryable,
        retryTargetStage: retryable ? this.#sources.retryTargetStage(issue.id) : null,
        paused: projectedState === "paused",
        pausable: this.#pausableIssue(viewIssue),
        resumable,
        resumableRollup,
        stoppedRollup: stopped && children.length > 0,
        stopSummary: stopped ? this.#store.currentStopSummary(issue.id) : null,
        stopHeadline: stopped && stopReason ? stopHeadline(stopReason) : null,
      };
    };
    const stageNames = new Map<string, string>();
    const stageDescriptions = new Map<string, string>();
    const stageIcons = new Map<string, string>();
    for (const pipeline of Object.values(this.#config.pipelines)) {
      for (const stage of pipeline.stages) {
        if (!stageNames.has(stage.id)) stageNames.set(stage.id, stage.name ?? displayName(stage.id));
        if (stage.description && !stageDescriptions.has(stage.id)) stageDescriptions.set(stage.id, stage.description);
        if (stage.icon && !stageIcons.has(stage.id)) stageIcons.set(stage.id, stage.icon);
      }
    }
    const stages = boardStageOrder(Object.values(this.#config.pipelines));
    const recent = pagination.view === "recent"
      ? this.#recentActivity(pagination, repositoryColors)
      : undefined;
    const actorsForStage = (stageId: string, pipelineId?: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      const addAgent = (agentId: string) => {
        const agent = this.#config.agents[agentId];
        actors.push({
          type: "agent",
          name: agent?.name ?? displayName(agentId),
          title: agent?.title ?? "AI agent",
        });
      };
      for (const [id, pipeline] of Object.entries(this.#config.pipelines)) {
        if (pipelineId && id !== pipelineId) continue;
        const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
        if (!stage) continue;
        if (isNativeStage(stage)) {
          const agentIds = stage.actions.flatMap((task) => {
            if (task.task !== "agent.run") return [];
            const single = task.with?.agent;
            const listed = task.with?.agents;
            return [
              ...(typeof single === "string" ? [single] : []),
              ...(Array.isArray(listed) ? listed.filter((value): value is string => typeof value === "string") : []),
            ];
          });
          if (agentIds.length === 0) actors.push({ type: "script", name: "Script", title: null });
          else agentIds.forEach(addAgent);
          continue;
        }
        if (stage.run.type !== "agent") {
          actors.push({ type: "script", name: "Script", title: null });
          continue;
        }
        addAgent(stage.run.agent);
      }
      return [...new Map(actors.map((actor) => [
        `${actor.type}:${actor.name}:${actor.title ?? ""}`,
        actor,
      ])).values()];
    };
    const configuredStages = new Set(stages);
    const sourceStages = (issue: StoredIssue): string[] => {
      const repository = this.#config.repositories[issue.repositoryId];
      const pipeline = repository ? this.#config.pipelines[repository.pipeline] : null;
      if (!pipeline) return [];
      return pipeline.stages.flatMap((stage) =>
        issue.labels.includes(this.#config.labels.stageTemplate.replace("{stage}", stage.id))
          ? [stage.id]
          : [],
      );
    };
    const remainsInWorkflow = (issue: StoredIssue): boolean =>
      issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "done" &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active");
    const finishedRollupIds = new Set(issues
      .filter((issue) => ["done", "completed"].includes(issue.projectedState ?? ""))
      .filter((issue) => childrenFor(issue.id).length > 0)
      .filter((issue) => this.#sources.isRollupSatisfied(issue.id))
      .map((issue) => issue.id));
    const filterRepositories = new Set(pagination.repositoryIds ?? []);
    const filterWords = (pagination.q ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    /** Deliberately excludes long issue bodies and acceptance criteria. */
    const matchesBoardText = (issue: StoredIssue): boolean => {
      if (filterWords.length === 0) return true;
      const assignedAgents = issue.projectedStage
        ? actorsForStage(issue.projectedStage, this.#config.repositories[issue.repositoryId]?.pipeline)
        : [];
      const haystack = [
        issue.title,
        String(issue.sourceNumber),
        `#${issue.sourceNumber}`,
        issue.repositoryId,
        ...issue.labels,
        issue.metadata.type ?? "",
        ...this.#issueFieldValues(issue).flatMap((field) => [field.name, field.value]),
        ...assignedAgents.flatMap((agent) => [agent.name, agent.title ?? ""]),
      ].join(" ").toLocaleLowerCase();
      return filterWords.every((word) => haystack.includes(word));
    };
    const matchesDoneFilter = (issue: StoredIssue): boolean =>
      (filterRepositories.size === 0 || filterRepositories.has(issue.repositoryId)) && matchesBoardText(issue);
    const closedIssues = issues
      .filter((issue) =>
        (issue.sourceState === "closed" && !remainsInWorkflow(issue)) || finishedRollupIds.has(issue.id)
      )
      .filter(matchesDoneFilter)
      .sort((left, right) =>
        right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
        left.repositoryId.localeCompare(right.repositoryId) ||
        right.sourceNumber - left.sourceNumber
      );
    // This is a database count over the Done predicate, not a count of the already materialized
    // list. Keep the card projection below limited even when a repository has years of history.
    const doneTotal = this.#store.countFinishedIssues({
      repositoryIds: [...filterRepositories],
      words: filterWords,
      workflows: Object.entries(this.#config.repositories).map(([repositoryId, repository]) => ({
        repositoryId,
        stages,
        sourceStageLabels: (this.#config.pipelines[repository.pipeline]?.stages ?? []).map((stage) =>
          this.#config.labels.stageTemplate.replace("{stage}", stage.id),
        ),
      })),
      stageActors: Object.entries(this.#config.repositories).flatMap(([repositoryId, repository]) =>
        (this.#config.pipelines[repository.pipeline]?.stages ?? []).map((stage) => ({
          repositoryId,
          stageId: stage.id,
          text: actorsForStage(stage.id, repository.pipeline)
            .flatMap((actor) => [actor.name, actor.title ?? ""])
            .join(" ")
            .toLocaleLowerCase(),
        })),
      ),
    });
    const workflowIssues = issues.filter((issue) =>
      !finishedRollupIds.has(issue.id) && (issue.sourceState !== "closed" || remainsInWorkflow(issue))
    );
    const backlogIssues = workflowIssues.filter((issue) => {
      if (issue.sourceState === "closed") return false;
      if (issue.parentId || !issue.labels.includes(this.#config.labels.enrollment)) return false;
      if (
        sourceStages(issue).length !== 0 ||
        (issue.projectedState !== "active" && !STOPPED_ISSUE_STATES.has(issue.projectedState ?? ""))
      ) return false;
      const stageState = stageStateFor(issue.id);
      const repository = this.#config.repositories[issue.repositoryId];
      const firstStage = repository ? this.#config.pipelines[repository.pipeline]?.stages[0]?.id : undefined;
      if (issue.projectedStage !== firstStage) return false;
      if (issue.projectedState === "active") {
        return stageState?.status === "ready" && !this.#store.getActiveWorkspace(issue.id);
      }
      return stageState?.status === issue.projectedState ||
        (issue.projectedState === "needs-input" && stageState?.status === "ready");
    });
    const backlogIds = new Set(backlogIssues.map((issue) => issue.id));
    const stageBadgeFor = (
      issue: StoredIssue,
      state: ReturnType<DashboardStore["getStageState"]>,
    ): IssueStageBadgeViewModel => itemStageBadge(
      issue.projectedStage ?? state?.stageId ?? null,
      stageNames,
      stageIcons,
      finishedRollupIds.has(issue.id) || (issue.sourceState === "closed" && !remainsInWorkflow(issue))
        ? "done"
        : backlogIds.has(issue.id)
        ? "backlog"
        : null,
    );
    const stagedIssues = workflowIssues.filter((issue) =>
      !backlogIds.has(issue.id) &&
      issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active"),
    );
    const stagedIds = new Set(stagedIssues.map((issue) => issue.id));
    const attentionIssues = workflowIssues.filter((issue) =>
      !backlogIds.has(issue.id) && !stagedIds.has(issue.id),
    );
    const graphFilterRepositories = new Set(pagination.repositoryIds ?? []);
    const graphCurrentIssues = workflowIssues.filter((issue) =>
      (graphFilterRepositories.size === 0 || graphFilterRepositories.has(issue.repositoryId)) &&
      (!pagination.graphStage || issue.projectedStage === pagination.graphStage),
    );
    // The graph starts with filtered current workflow items, then adds only direct relationship
    // endpoints. That retains the context needed to understand a current item without turning
    // historical completed work into a second, unbounded archive view.
    const graphCurrentIds = new Set(graphCurrentIssues.map((issue) => issue.id));
    const graphContextIds = new Set<string>();
    const addGraphContext = (issueId: string | null | undefined) => {
      if (issueId && !graphCurrentIds.has(issueId) && listedById.has(issueId)) graphContextIds.add(issueId);
    };
    for (const issue of graphCurrentIssues) {
      addGraphContext(issue.parentId);
      childrenFor(issue.id).forEach(({ issueId }) => addGraphContext(issueId));
      dependenciesFor(issue.id).forEach(addGraphContext);
      dependentsFor(issue.id).forEach(addGraphContext);
    }
    const graphIds = new Set([...graphCurrentIds, ...graphContextIds]);
    const graphStatus = (issue: StoredIssue) => {
      const itemRelation = childrenFor(issue.id).length > 0 ? rollupRelation(issue) : relation(issue);
      if (itemRelation.satisfied) return { satisfied: true, signal: null } as const;
      const state = issue.projectedState ?? issue.sourceState;
      const signal = activeIssueIds.has(issue.id)
        ? "run"
        : questionIssueIds.has(issue.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { satisfied: false, signal } as const;
    };
    const graphNodes: GraphNodeViewModel[] = [...graphIds]
      .flatMap((issueId) => {
        const issue = listedById.get(issueId);
        if (!issue) return [];
        const status = graphStatus(issue);
        return [{
          id: issue.id,
          repository: issue.repositoryId,
          repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
          number: issue.sourceNumber,
          title: issue.title,
          state: displayName(issue.projectedState ?? issue.sourceState),
          stage: issue.projectedStage ? stageNames.get(issue.projectedStage) ?? displayName(issue.projectedStage) : null,
          stageId: issue.projectedStage,
          context: graphContextIds.has(issue.id),
          signal: status.signal,
        }];
      })
      .sort((left, right) =>
        left.repository.localeCompare(right.repository) || left.number - right.number || left.id.localeCompare(right.id)
      );
    const graphRelationships = new Map<string, GraphRelationshipViewModel>();
    const addGraphRelationship = (relationship: GraphRelationshipViewModel) => {
      if (!graphIds.has(relationship.from) || !graphIds.has(relationship.to)) return;
      graphRelationships.set(`${relationship.kind}:${relationship.from}:${relationship.to}`, relationship);
    };
    for (const issue of graphCurrentIssues) {
      if (issue.parentId) addGraphRelationship({ kind: "parent-child", from: issue.parentId, to: issue.id, status: null });
      childrenFor(issue.id).forEach(({ issueId }) => {
        addGraphRelationship({ kind: "parent-child", from: issue.id, to: issueId, status: null });
      });
      dependenciesFor(issue.id).forEach((prerequisiteId) => {
        const prerequisite = listedById.get(prerequisiteId);
        if (!prerequisite) return;
        const prerequisiteStatus = graphStatus(prerequisite);
        addGraphRelationship({
          kind: "dependency",
          from: prerequisite.id,
          to: issue.id,
          status: prerequisiteStatus.satisfied ? "satisfied" : prerequisiteStatus.signal === "stop" ? "stopped" : "outstanding",
        });
      });
      dependentsFor(issue.id).forEach((dependentId) => {
        const dependent = listedById.get(dependentId);
        if (!dependent) return;
        const prerequisiteStatus = graphStatus(issue);
        addGraphRelationship({
          kind: "dependency",
          from: issue.id,
          to: dependent.id,
          status: prerequisiteStatus.satisfied ? "satisfied" : prerequisiteStatus.signal === "stop" ? "stopped" : "outstanding",
        });
      });
    }
    const graph = {
      nodes: graphNodes,
      relationships: [...graphRelationships.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
      ),
    };
    const column = (
      id: string,
      name: string,
      columnIssues: StoredIssue[],
      cost: string | null,
      issueCard: (issue: StoredIssue) => IssueCardViewModel = (issue) => card(issue),
      actors: readonly StageActorViewModel[] = [],
      complete = false,
    ): StageColumnViewModel => {
      const totalPages = complete ? 1 : Math.max(1, Math.ceil(columnIssues.length / DASHBOARD_PAGE_SIZE));
      const requestedPage = pagination.column === id ? pagination.page : 1;
      const page = Math.min(Math.max(1, requestedPage), totalPages);
      const offset = (page - 1) * DASHBOARD_PAGE_SIZE;
      return {
        id,
        name,
        actors,
        cost,
        totalIssues: columnIssues.length,
        page,
        totalPages,
        issues: (complete ? columnIssues : columnIssues.slice(offset, offset + DASHBOARD_PAGE_SIZE)).map(issueCard),
      };
    };
    // A source-closed item remains actionable only when its correlated Conveyor PR merged and
    // it still has configured workflow work after that merge.
    const awaitsOwner = (issue: StoredIssue): boolean =>
      issue.labels.includes(this.#config.labels.enrollment) &&
      (issue.sourceState !== "closed" ||
        (remainsInWorkflow(issue) && this.#store.hasMergedPullRequest(issue.id)));
    const questions: QuestionViewModel[] = openQuestions.flatMap((question) => {
      const issue = byId.get(question.issueId);
      if (!issue || !awaitsOwner(issue)) return [];
      const options = questionOptions(question.options);
      return [{
        id: question.id,
        issueId: issue.id,
        repository: issue.repositoryId,
        repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
        issueNumber: issue.sourceNumber,
        issueTitle: issue.title,
        prompt: question.prompt,
        reason: question.reason,
        options,
        allowFreeText: question.allowFreeText,
        answerError: questionConfigurationError(question.options, question.allowFreeText),
      }];
    });
    const total = this.#store.costSummary();
    const stageCosts = this.#store.costSummaryByStage();
    const steering = this.steeringView(pagination.runId);
    const repositorySummaries = this.#sources.repositorySummaries(listedIssues);
    const degradedRepositories = repositorySummaries.repositories.filter((repository) => repository.health === "degraded").length;
    const unassociatedWarnings = this.#sources.repositoryErrors().filter(([repository]) => !this.#config.repositories[repository]).map(([repository, message]) => `${repository}: ${message}`);
    const drain = this.#sources.drain();
    const outage = this.#sources.githubOutage();
    return {
      title: "Conveyor",
      project: `${Object.keys(this.#config.repositories).length} repositories${degradedRepositories > 0 ? ` · ${degradedRepositories} degraded` : ""}`,
      totalUsage: formatUsage(total) ?? "0 runs",
      harnessUsage,
      draining: drain
        ? {
          reason: drain.reason,
          upgrade: drain.upgrade
            ? {
              version: drain.upgrade.targetVersion,
              releaseUrl: `https://github.com/Abaniumbay/conveyor/releases/tag/${drain.upgrade.releaseTag}`,
            }
            : null,
        }
        : null,
      updatedAt: this.#sources.lastReconciledAt() ?? new Date().toISOString(),
      revision: this.#dashboardRevision(repositorySummaries),
      view: pagination.view,
      repositoryId: pagination.repositoryId ?? null,
      boardFilters: {
        repositories: [...filterRepositories],
        q: pagination.q ?? "",
        state: pagination.state ?? null,
      },
      graphFilters: {
        repositories: [...graphFilterRepositories],
        stage: pagination.graphStage ?? null,
        stages: stages.map((stage) => ({ id: stage, name: stageNames.get(stage) ?? displayName(stage) })),
      },
      ...(recent ? { recent } : {}),
      graph,
      counts: {
        board: backlogIssues.length + stagedIssues.length,
        attention: attentionIssues.length,
      },
      activeWork: {
        runnerCount: activeRuns.length,
        runnerCapacity: this.#config.settings.runners,
        runs: activeRuns.map((run) => ({ ...run, repositoryColor: repositoryColors.get(run.repository) ?? 1 })),
      },
      stages: stages.map((stage) => ({
        ...column(
          `stage:${stage}`,
          stageNames.get(stage) ?? displayName(stage),
          stagedIssues.filter((issue) => issue.projectedStage === stage),
          formatUsage(stageCosts.get(stage) ?? {
            runs: 0, amount: 0, currency: "USD", durationMs: 0,
            inputTokens: 0, outputTokens: 0, cachedTokens: 0, unavailableRuns: 0,
          }),
          (issue) => card(issue),
          actorsForStage(stage),
          true,
        ),
        description: stageDescriptions.get(stage) ?? null,
        icon: stageIcons.get(stage) ?? null,
      })),
      backlog: backlogIssues.map((issue) => card(issue)),
      done: {
        id: "done",
        name: "Done",
        actors: [],
        cost: null,
        totalIssues: doneTotal,
        page: 1,
        totalPages: 1,
        issues: closedIssues.slice(0, pagination.doneLimit).map((issue) => card(issue, {
          state: finishedRollupIds.has(issue.id)
            ? issue.projectedState ?? "done"
            : issue.sourceStateReason === "completed" ? "completed" : "closed",
          reason: issue.sourceStateReason && issue.sourceStateReason !== "completed"
            ? `GitHub close reason: ${issue.sourceStateReason.replaceAll("_", " ")}.`
            : null,
        })),
      },
      attention: column(
        "attention",
        "Label problems",
        attentionIssues,
        null,
        (issue) => card(issue, {
          reason: issue.projectedStage
            ? "The issue has conflicting or invalid Conveyor labels."
            : "No valid configured stage label is present.",
        }),
      ),
      questions,
      needsYou: workflowIssues
        .filter((issue) => ["blocked", "error", "needs-input", "needs-intervention", "rejected"].includes(issue.projectedState ?? "") ||
          this.#sources.manualGateViews(issue).some((gate) => gate.waiting))
        .filter(awaitsOwner)
        .map((issue) => card(issue)),
      systemWarnings: [
        ...(outage ? [githubOutageLine({ since: outage.since, waiting: outage.waitingItems.length })] : []),
        ...unassociatedWarnings,
      ],
      repositories: repositorySummaries.repositories,
      restrictedRepositories: repositorySummaries.restrictedRepositories,
      steering,
      selectedIssue: pagination.issueId && listedById.has(pagination.issueId) && listedById.get(pagination.issueId)!.projectedState !== "unlisted"
        ? card(listedById.get(pagination.issueId)!)
        : null,
      csrfToken,
    };
  }

  /** The Operator: whether it is configured, its recent runs, and the selected (or latest) run's conversation. */
  steeringView(runId: string | null): SteeringViewModel {
    const recent = this.#store.listRunsByKind("steering", 10);
    const selectedId = runId ?? recent[0]?.id ?? null;
    const run = selectedId ? this.#store.getRun(selectedId) : null;
    return {
      enabled: Boolean(this.#config.web?.steering),
      agent: this.#config.web?.steering?.agent ?? null,
      selected: run?.kind === "steering"
        ? {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            events: this.#store.listRunEvents(run.id).flatMap((event) => {
              const visible = userFacingSteeringEvent(event);
              return visible ? [visible] : [];
            }),
          }
        : null,
      recent,
    };
  }

  /** One page of the Recent view, for the browser application. */
  recentActivityPage(pagination: DashboardPageSelection): RecentActivityViewModel {
    const repositoryColors = new Map(Object.keys(this.#config.repositories).map((repositoryId, index) => [repositoryId, (index % 8) + 1]));
    return this.#recentActivity(pagination, repositoryColors);
  }

  #recentActivity(
    pagination: DashboardPageSelection,
    repositoryColors: ReadonlyMap<string, number>,
  ): RecentActivityViewModel {
    const allTypes: RecentActivityType[] = ["done", "stopped", "sent-back", "moved-forward", "new", "resumed", "rollup"];
    const defaultTypes = allTypes.filter((type) => type !== "rollup");
    const types = pagination.recentTypes && pagination.recentTypes.length > 0
      ? [...new Set(pagination.recentTypes)]
      : defaultTypes;
    const selectedTypes = new Set(types);
    const selectedRepositories = new Set(pagination.repositoryIds ?? []);
    const configuredRepositories = [...selectedRepositories].filter((repositoryId) => this.#config.repositories[repositoryId] !== undefined);
    const rangeStartedAt = pagination.recentCursor
      ? null
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (selectedRepositories.size > 0 && configuredRepositories.length === 0) {
      return { types, repositoryIds: [...selectedRepositories], events: [], nextCursor: null, rangeStartedAt };
    }
    const events: RecentActivityEventViewModel[] = [];
    let cursor = pagination.recentCursor ?? null;
    let nextCursor: { occurredAt: string; id: string | null } | null = null;
    let exhausted = false;
    let inspected = 0;
    while (!exhausted && events.length < 50 && inspected < recentActivityCandidateLimit) {
      // Fetch one extra source record so the cursor never claims that another page exists
      // merely because the current batch happened to end on its size boundary.
      const candidateLimit = Math.min(101, recentActivityCandidateLimit - inspected);
      const candidates = this.#store.listRecentActivity({
        from: rangeStartedAt,
        before: cursor,
        limit: candidateLimit,
        repositoryIds: configuredRepositories,
      });
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }
      let processed = 0;
      for (const event of candidates) {
        processed += 1;
        const classified = this.#classifyRecentActivity(event, repositoryColors);
        if (!classified || !selectedTypes.has(classified.type)) continue;
        if (selectedRepositories.size > 0 && !selectedRepositories.has(classified.repository)) continue;
        events.push(classified);
        if (events.length === 50) break;
      }
      inspected += processed;
      const last = candidates[processed - 1]!;
      cursor = { occurredAt: last.occurredAt, id: last.id };
      nextCursor = cursor;
      exhausted = processed === candidates.length && candidates.length < candidateLimit;
    }
    if (exhausted && rangeStartedAt) {
      // The first page is bounded to the last day. A cursor without an ID means strictly before
      // that range boundary, allowing Load more to continue into retained history.
      const older = this.#store.listRecentActivity({
        from: null,
        before: { occurredAt: rangeStartedAt, id: null },
        limit: 1,
        repositoryIds: configuredRepositories,
      });
      nextCursor = older.length > 0 ? { occurredAt: rangeStartedAt, id: null } : null;
    } else if (exhausted) {
      nextCursor = null;
    }
    return { types, repositoryIds: [...selectedRepositories], events, nextCursor, rangeStartedAt };
  }

  #classifyRecentActivity(
    event: ReturnType<DashboardStore["listRecentActivity"]>[number],
    repositoryColors: ReadonlyMap<string, number>,
  ): RecentActivityEventViewModel | null {
    let type: RecentActivityType | null = null;
    if (event.source === "done" || event.source === "done-fallback") {
      type = "done";
    } else {
      const stopped = new Set(["blocked", "error", "needs-intervention", "rejected"]);
      const pipeline = this.#config.pipelines[this.#config.repositories[event.repositoryId]?.pipeline ?? ""];
      const configuredStages = pipeline?.stages ?? [];
      const from = configuredStages.findIndex((stage) => stage.id === event.fromStage);
      const to = configuredStages.findIndex((stage) => stage.id === event.toStage);
      if (event.kind === "onboarded") type = "new";
      else if (event.kind === "restarted" || event.kind === "resumed") type = "resumed";
      else if (event.kind === "rollup") type = "rollup";
      else if (event.kind === "stopped" || stopped.has(event.resultStatus ?? "")) type = "stopped";
      else if (from >= 0 && to >= 0 && to < from) type = "sent-back";
      else if (event.kind === "advance" || (from >= 0 && to >= 0 && to > from)) type = "moved-forward";
    }
    if (!type) return null;
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      type,
      repository: event.repositoryId,
      repositoryColor: repositoryColors.get(event.repositoryId) ?? 1,
      issueNumber: event.issueNumber,
      issueTitle: event.issueTitle,
      issueUrl: `/issues/${encodeURIComponent(event.repositoryId)}/${event.issueNumber}`,
      fromStage: event.fromStage,
      toStage: event.toStage,
      reason: event.reason,
    };
  }

  /** One item's card, for an item the live dashboard model does not hold (finished long ago). */
  issueDetails(csrfToken: string, issueId: string): IssueCardViewModel | null {
    // This route is deliberately independent from dashboard(). A dialog is normally opened for
    // one card, so rebuilding every board column, rollup, and repository summary here would make
    // the on-demand endpoint proportional to the board rather than to the item being opened.
    const issue = this.#store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") return null;
    const repositoryColors = new Map(Object.keys(this.#config.repositories).map((repositoryId, index) =>
      [repositoryId, (index % 8) + 1],
    ));
    const pipeline = this.#config.pipelines[this.#config.repositories[issue.repositoryId]?.pipeline ?? ""];
    const stages = pipeline?.stages ?? [];
    const stageNames = stages.map((stage) => stage.name ?? displayName(stage.id));
    const stageNamesById = new Map<string, string>();
    const stageIconsById = new Map<string, string>();
    for (const stage of stages) {
      stageNamesById.set(stage.id, stage.name ?? displayName(stage.id));
      if (stage.icon) stageIconsById.set(stage.id, stage.icon);
    }
    const activeIssueIds = new Set(this.#store.listActiveIssueRuns().map((run) => run.issueId));
    const allOpenQuestions = this.#store.listOpenQuestions();
    const openQuestions = allOpenQuestions.filter((question) => question.issueId === issue.id);
    const questionIssueIds = new Set(allOpenQuestions.map((question) => question.issueId));
    const relatedIssues = new Map<string, StoredIssue>([[issue.id, issue]]);
    const relatedIssue = (id: string): StoredIssue | null => {
      if (!relatedIssues.has(id)) {
        const candidate = this.#store.getIssue(id);
        if (candidate) relatedIssues.set(id, candidate);
      }
      return relatedIssues.get(id) ?? null;
    };
    // Board cards show only enrolled children and parents, but their dependency list deliberately
    // retains unlisted relationship stubs so a stopped item can still say what it is waiting for.
    const boardIssue = (id: string): StoredIssue | null => {
      const candidate = relatedIssue(id);
      return candidate?.projectedState === "unlisted" ? null : candidate;
    };
    const stageStates = new Map<string, ReturnType<DashboardStore["getStageState"]>>();
    const stageStateFor = (id: string) => {
      if (!stageStates.has(id)) stageStates.set(id, this.#store.getStageState(id));
      return stageStates.get(id)!;
    };
    const childrenByParent = new Map<string, ReturnType<DashboardStore["listChildren"]>>();
    const childrenFor = (id: string) => {
      if (!childrenByParent.has(id)) childrenByParent.set(id, this.#store.listChildren(id));
      return childrenByParent.get(id)!;
    };
    const dependenciesByIssue = new Map<string, ReturnType<DashboardStore["listDependencies"]>>();
    const dependenciesFor = (id: string) => {
      if (!dependenciesByIssue.has(id)) dependenciesByIssue.set(id, this.#store.listDependencies(id));
      return dependenciesByIssue.get(id)!;
    };
    const relation = (item: StoredIssue): IssueRelationViewModel => ({
      id: item.id,
      repository: item.repositoryId,
      number: item.sourceNumber,
      title: item.title,
      url: item.sourceUrl,
      satisfied: item.sourceState === "closed" || item.projectedState === "done" || item.projectedState === "completed",
    });
    const rollupRelation = (item: StoredIssue): IssueRelationViewModel => ({
      ...relation(item),
      satisfied: this.#sources.isRollupSatisfied(item.id),
    });
    const withProgress = (item: StoredIssue, base: IssueRelationViewModel): IssueRelationViewModel => {
      if (base.satisfied) return base;
      const state = item.projectedState ?? item.sourceState;
      const signal = activeIssueIds.has(item.id)
        ? "run"
        : questionIssueIds.has(item.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { ...base, signal, state: displayName(state) };
    };
    const sourceStages = (item: StoredIssue): string[] => {
      const itemPipeline = this.#config.pipelines[this.#config.repositories[item.repositoryId]?.pipeline ?? ""];
      return itemPipeline?.stages.flatMap((stage) =>
        item.labels.includes(this.#config.labels.stageTemplate.replace("{stage}", stage.id)) ? [stage.id] : [],
      ) ?? [];
    };
    const isBacklog = (item: StoredIssue): boolean => {
      if (item.sourceState === "closed" || item.parentId || !item.labels.includes(this.#config.labels.enrollment)) return false;
      if (sourceStages(item).length !== 0 ||
        (item.projectedState !== "active" && !STOPPED_ISSUE_STATES.has(item.projectedState ?? ""))) return false;
      const itemPipeline = this.#config.pipelines[this.#config.repositories[item.repositoryId]?.pipeline ?? ""];
      if (item.projectedStage !== itemPipeline?.stages[0]?.id) return false;
      const state = stageStateFor(item.id);
      return item.projectedState === "active"
        ? state?.status === "ready" && !this.#store.getActiveWorkspace(item.id)
        : state?.status === item.projectedState || (item.projectedState === "needs-input" && state?.status === "ready");
    };
    const childRelation = (child: StoredIssue): IssueRelationViewModel => {
      const base = rollupRelation(child);
      const names = ["Backlog", ...stageNames, "Done"];
      const stageIndex = child.projectedStage ? stages.findIndex((stage) => stage.id === child.projectedStage) : -1;
      const index = base.satisfied ? names.length - 1 : isBacklog(child) || stageIndex < 0 ? 0 : stageIndex + 1;
      return { ...withProgress(child, base), station: { index, count: names.length, name: names[index]! } };
    };
    const liveStatus = this.#sources.liveStatusReader([issue], {
      stageState: stageStateFor,
      dependencies: dependenciesFor,
      children: childrenFor,
      issue: relatedIssue,
    });
    const state = stageStateFor(issue.id);
    const cost = this.#store.costSummary({ issueId: issue.id });
    const children = childrenFor(issue.id).flatMap(({ issueId: childId }) => {
      const child = boardIssue(childId);
      return child ? [childRelation(child)] : [];
    });
    const dependencies = dependenciesFor(issue.id).flatMap((dependencyId) => {
      const dependency = relatedIssue(dependencyId);
      return dependency ? [withProgress(dependency, relation(dependency))] : [];
    });
    const parent = issue.parentId ? boardIssue(issue.parentId) : null;
    const siblings = parent
      ? childrenFor(parent.id).flatMap(({ issueId: siblingId }) => {
          const sibling = boardIssue(siblingId);
          return sibling ? [rollupRelation(sibling)] : [];
        })
      : [];
    const configuredStages = new Set(Object.values(this.#config.pipelines).flatMap((itemPipeline) =>
      itemPipeline.stages.map((stage) => stage.id),
    ));
    const remainsInWorkflow = issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "done" &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active");
    const finishedRollup = ["done", "completed"].includes(issue.projectedState ?? "") &&
      childrenFor(issue.id).length > 0 && this.#sources.isRollupSatisfied(issue.id);
    const finished = (issue.sourceState === "closed" && !remainsInWorkflow) || finishedRollup;
    const doneState = finishedRollup
      ? issue.projectedState ?? "done"
      : issue.sourceStateReason === "completed" ? "completed" : "closed";
    const doneReason = issue.sourceStateReason && issue.sourceStateReason !== "completed"
      ? `GitHub close reason: ${issue.sourceStateReason.replaceAll("_", " ")}.`
      : null;
    const projectedState = finished ? doneState : issue.projectedState ?? issue.sourceState;
    const stageBadge = itemStageBadge(
      issue.projectedStage ?? state?.stageId ?? null,
      stageNamesById,
      stageIconsById,
      finished ? "done" : isBacklog(issue) ? "backlog" : null,
    );
    const manualGates = this.#sources.manualGateViews(issue);
    const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
    const waiting = !questionIssueIds.has(issue.id) ? liveStatus(issue) : null;
    const retry = !activeIssueIds.has(issue.id) ? this.#sources.retryWaiting(issue.id) : null;
    const liveWaiting = waiting ?? retry;
    const stopped = STOPPED_ISSUE_STATES.has(projectedState);
    const openQuestion = stopped ? openQuestions[0] : undefined;
    const waitingDependencies = dependencies.filter((dependency) => !dependency.satisfied);
    const dependencyReason = waitingDependencies.length > 0
      ? `Waiting for ${waitingDependencies.map((dependency) => `#${dependency.number} ${dependency.title}`).join(", ")} to be completed.`
      : null;
    const stopReason = stopped
      ? this.#sources.latestStopReason(issue.id) ??
        (openQuestion ? `${openQuestion.reason}. Answer needed: ${openQuestion.prompt}` : null) ??
        dependencyReason ?? issue.warning ?? doneReason ??
        "Conveyor received the stopped state, but no blocking reason was recorded. Add the concrete blocker and required action in Conversation before resuming this item."
      : null;
    const viewIssue = { ...issue, projectedState };
    const retryable = this.#sources.retryableStoppedIssue(viewIssue, children.length, activeIssueIds.has(issue.id));
    const resumable = this.#resumablePausedIssue(viewIssue, activeIssueIds.has(issue.id));
    const resumableRollup = this.#sources.resumableRollupIssue(viewIssue, children.length, activeIssueIds.has(issue.id), openQuestion !== undefined);
    const indicators = this.#store.listIndicators(issue.id)
      .filter((indicator) => indicator.id !== CI_INDICATOR_ID || this.#config.repositories[issue.repositoryId]?.ci?.mode !== "disabled")
      .map((indicator) => indicatorView(indicator, Date.now()));
    const actorsForStage = (stageId: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      const addAgent = (agentId: string) => {
        const agent = this.#config.agents[agentId];
        actors.push({ type: "agent", name: agent?.name ?? displayName(agentId), title: agent?.title ?? "AI agent" });
      };
      for (const stage of stages.filter((candidate) => candidate.id === stageId)) {
        if (isNativeStage(stage)) {
          const agentIds = stage.actions.flatMap((task) => task.task !== "agent.run" ? [] : [
            ...(typeof task.with?.agent === "string" ? [task.with.agent] : []),
            ...(Array.isArray(task.with?.agents) ? task.with.agents.filter((value): value is string => typeof value === "string") : []),
          ]);
          if (agentIds.length === 0) actors.push({ type: "script", name: "Script", title: null });
          else agentIds.forEach(addAgent);
        } else if (stage.run.type !== "agent") {
          actors.push({ type: "script", name: "Script", title: null });
        } else addAgent(stage.run.agent);
      }
      return [...new Map(actors.map((actor) => [`${actor.type}:${actor.name}:${actor.title ?? ""}`, actor])).values()];
    };
    const cursor = this.#store.executions().getCursor(issue.id);
    const todos = this.#store.todos();
    const tone = (itemState: string): IssueTone => {
      if (itemState === "done" || itemState === "completed") return "success";
      if (["blocked", "error", "rejected", "needs-intervention", "inconsistent"].includes(itemState)) return "danger";
      if (["paused", "needs-input"].includes(itemState)) return "warning";
      return itemState === "closed" ? "muted" : "active";
    };
    return {
      id: issue.id,
      repository: issue.repositoryId,
      repositoryPaused: this.#store.repositoryPause(issue.repositoryId) !== null,
      repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      state: projectedState,
      labels: issue.labels,
      issueType: issue.metadata.type,
      issueFields: this.#issueFieldValues(issue),
      acceptanceCriteria: this.#sources.criterionApprovalStates(issue),
      manualGates,
      csrfToken,
      todos: todosView(todos.get(issue.id)?.items ?? []),
      stage: issue.projectedStage,
      stageBadge,
      searchActors: issue.projectedStage ? actorsForStage(issue.projectedStage) : [],
      indicators,
      activity: cursor?.state === "pending" ? `${cursor.stage} › ${cursor.taskInstanceId ?? cursor.list}` : state ? `${state.stageId} · ${state.status}` : null,
      reason: stopReason ?? (manualWaiting
        ? manualWaiting.kind === "board" ? "Waiting for board approval"
          : manualWaiting.kind === "entry" ? "Waiting for configured entry approval."
            : `Waiting for configured manual gate \"${manualWaiting.gateId}\".`
        : liveWaiting ? null : issue.warning ?? doneReason ?? null),
      cost: formatUsage(cost),
      duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
      stateChangedAt: state?.updatedAt ?? issue.sourceUpdatedAt,
      waiting: liveWaiting,
      blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(projectedState),
      inconsistent: issue.projectedState === "inconsistent",
      closable: issue.labels.includes(this.#config.labels.metadata.closable),
      noSplit: issue.labels.includes(this.#config.labels.metadata.noSplit),
      tone: tone(projectedState),
      parent: parent ? rollupRelation(parent) : null,
      parentProgress: parent && siblings.length > 0 ? { done: siblings.filter((sibling) => sibling.satisfied).length, total: siblings.length } : null,
      children,
      dependencies,
      working: activeIssueIds.has(issue.id),
      needsAttention: questionIssueIds.has(issue.id) || manualWaiting !== null ||
        ["blocked", "error", "needs-input", "needs-intervention", "rejected"].includes(projectedState),
      retryable,
      retryTargetStage: retryable ? this.#sources.retryTargetStage(issue.id) : null,
      paused: projectedState === "paused",
      pausable: this.#pausableIssue(viewIssue),
      resumable,
      resumableRollup,
      stoppedRollup: stopped && children.length > 0,
      stopSummary: stopped ? this.#store.currentStopSummary(issue.id) : null,
      stopHeadline: stopped && stopReason ? stopHeadline(stopReason) : null,
    };
  }

  /** One page of an item's runs, newest first, each with its latest events. */
  issueActivity(issueId: string, before?: string): IssueActivityViewModel | null {
    const issue = this.#store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") return null;
    const page = this.#store.listIssueRunsPage(issueId, {
      ...(before ? { before } : {}),
      limit: ACTIVITY_RUN_PAGE_SIZE,
    });
    return {
      issueId,
      runs: page.runs.map((run) => {
        const events = this.#store.listRunEventsPage(run.id, { limit: ACTIVITY_EVENT_PAGE_SIZE });
        return {
          id: run.id,
          stageId: run.stageId,
          attempt: run.attempt,
          kind: run.kind,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          events: events.events,
          nextEventBefore: events.nextBefore,
        };
      }),
      nextRunBefore: page.nextBefore,
    };
  }

  /** One page of a run's events, for an item's activity. */
  issueRunEvents(issueId: string, runId: string, before?: number): IssueRunEventsViewModel | null {
    const issue = this.#store.getIssue(issueId);
    const run = this.#store.getRun(runId);
    if (!issue || issue.projectedState === "unlisted" || run?.issueId !== issueId) return null;
    const page = this.#store.listRunEventsPage(runId, {
      ...(before === undefined ? {} : { before }),
      limit: ACTIVITY_EVENT_PAGE_SIZE,
    });
    return {
      issueId,
      runId,
      events: page.events,
      nextEventBefore: page.nextBefore,
    };
  }

  /** Where an item is now, how it moved between stages, and its review findings. */
  issueJourney(issueId: string): IssueJourneyViewModel | null {
    const now = this.#sources.itemNow(issueId);
    const transitions = itemTransitions(this.#config, this.#store, issueId);
    if (!now || !transitions) return null;
    return {
      issueId,
      now,
      transitions,
      findings: this.#store.findings().listVisible(issueId).map((finding) => ({
        id: finding.id,
        type: finding.type,
        state: finding.state,
        author: finding.author,
        location: finding.path === null ? null : finding.line === null ? finding.path : `${finding.path}:${finding.line}`,
        url: finding.url,
        summary: finding.body.length > 240 ? `${finding.body.slice(0, 240)}…` : finding.body,
        ...(finding.dismissal ? { dismissal: { actor: finding.dismissal.actor, reason: finding.dismissal.reason } } : {}),
      })),
      skippedReviews: this.#store.findings().skippedNative(issueId).map((review) => ({
        author: review.author,
        url: review.url,
        skippedAt: review.skippedAt,
        active: review.active,
      })),
    };
  }

  /** Memory, disks and uptime of the server. */
  async systemStatus(): Promise<SystemStatusViewModel> {
    return collectSystemStatus({
      database: this.#config.settings.database,
      artifacts: this.#config.settings.artifacts,
      temporaryDirectory: tmpdir(),
      // Agent scratch paths are siblings of managed worktrees, so their capacity
      // follows the configured workspaces filesystem rather than the host TMPDIR.
      workspaceScratch: this.#config.settings.workspaces,
    });
  }

  /** The item's conversation, its latest 100 messages. */
  issueConversation(issueId: string): IssueConversationViewModel | null {
    const issue = this.#store.getIssue(issueId);
    if (!issue || issue.projectedState === "unlisted") return null;
    return {
      issueId,
      messages: this.#store.listConversationMessages(issueId, 100).map((message) => ({
        id: message.id,
        stageId: message.stageId,
        actorType: message.actorType,
        actorId: message.actorId,
        actorName: message.actorName,
        actorAvatar: message.actorType === "user" ? this.#store.dashboardAccountByUsername(message.actorName)?.avatar ?? null : null,
        actorTitle: message.actorTitle,
        message: message.message,
        createdAt: message.createdAt,
      })),
    };
  }

  /** An Operator run's status, or null when the run is not one. */
  getSteeringRun(runId: string): { id: string; status: string } | null {
    const run = this.#store.getRun(runId);
    return run?.kind === "steering" ? { id: run.id, status: run.status } : null;
  }

  /** An Operator run's user-facing events after a sequence. */
  getSteeringEvents(runId: string, after: number): Array<{
    sequence: number;
    type: string;
    text: string;
    createdAt: string;
  }> {
    if (!this.getSteeringRun(runId)) return [];
    return this.#store.listRunEvents(runId).flatMap((event) => {
      if (event.sequence <= after) return [];
      const visible = userFacingSteeringEvent(event);
      return visible ? [visible] : [];
    });
  }

  #issueFieldValues(issue: StoredIssue): Array<{ name: string; value: string }> {
    const configured = this.#config.repositories[issue.repositoryId]?.refinement?.fields ?? [];
    return configured.flatMap((name) => {
      const entry = Object.entries(issue.metadata.fields).find(([field]) => field.toLocaleLowerCase() === name.toLocaleLowerCase());
      return entry ? [{ name: entry[0], value: entry[1] }] : [];
    });
  }

  /** Whether an open, enrolled item with a stage can be paused by adding the paused label. */
  #pausableIssue(issue: StoredIssue): boolean {
    return issue.sourceState === "open" && issue.projectedStage !== null &&
      issue.labels.includes(this.#config.labels.enrollment) &&
      !["paused", "done", "unlisted", "inconsistent", "rejected"].includes(issue.projectedState ?? "");
  }

  /** Whether an open paused item can safely be resumed by removing the paused label. */
  #resumablePausedIssue(issue: StoredIssue, running: boolean): boolean {
    return issue.sourceState === "open" && issue.projectedState === "paused" &&
      issue.labels.includes(this.#config.labels.metadata.paused) && !running;
  }
}
