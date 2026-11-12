// The store's data domains. Each port is the part of ConveyorStore one domain owns, so a consumer
// can take only the ports it uses (interface segregation); one ConveyorStore implements them all.

import type { ConveyorStore } from "./store";

/** Repositories, their pauses and trust, issues, relationships, enrollments, workspaces, pull requests, the queue and purges. */
export type ItemStore = Pick<ConveyorStore,
  | "recordConfigSnapshot"
  | "listRepositories" | "upsertRepository" | "removeRepositoriesExcept"
  | "setRepositoryTrustStatus" | "repositoryTrustStatus"
  | "repositoryPause" | "pauseRepository" | "resumeRepository" | "listPendingPauseRelabels" | "completePauseRelabel"
  | "upsertIssue" | "setIssueMetadata" | "setIssueProjection" | "getIssue" | "getIssueByNumber" | "insertPlaceholderIssue"
  | "listIssues" | "listRecoveryCandidates" | "listRecentActivity" | "countFinishedIssues"
  | "replaceRelationships" | "listDependencies" | "listDependents" | "listChildren"
  | "activateEnrollment" | "getActiveEnrollment" | "getEnrollment" | "endActiveEnrollment"
  | "recordWorkspace" | "getActiveWorkspace" | "listActiveWorkspaces" | "markWorkspaceRemoved"
  | "upsertPullRequest" | "getCurrentPullRequest" | "findIssueIdsByPullRequest" | "hasMergedPullRequest"
  | "setQueueRank" | "nextQueueRank" | "moveQueueIssue" | "moveQueueIssueBefore"
  | "beginPurge" | "isPurging" | "listPendingPurges" | "listRunIdsForIssue" | "listUnremovedWorkspaces" | "finishPurge"
>;

/** Stage states and transitions, the journey, source mutations and the execution journal (context, cursors, waits). */
export type JournalStore = Pick<ConveyorStore,
  | "executions"
  | "setStageState" | "claimStageExecution" | "releaseFencedStageExecution" | "getStageState"
  | "recordJourneyEvent" | "currentStopId" | "recordStopSummary" | "currentStopSummary"
  | "beginStageTransition" | "beginStageTransitionWithMutation" | "completeStageTransition" | "failStageTransition"
  | "listStageTransitions" | "listPendingStageTransitions"
  | "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation"
  | "getSourceMutation" | "getSourceMutationByKey" | "getLatestSourceMutationByKeyPrefix"
>;

/** What gates read: findings, criterion approvals and test evidence, review threads, todos, indicators, manual gates and advisory CI. */
export type EvidenceStore = Pick<ConveyorStore,
  | "findings" | "criterionApprovals" | "reviewThreads" | "todos" | "manualGates" | "advisoryWatches"
  | "criterionTestEvidence" | "replaceCriterionTestEvidence" | "refreshCriterionTestEvidence"
  | "saveIndicator" | "listIndicators" | "clearIndicator" | "findIssueIdsByIndicatorHead"
>;

/** The append-only event log. */
export type EventStore = Pick<ConveyorStore, "events">;

/** Runs, their events (transcripts, tool calls) and their usage and cost. */
export type RunLogStore = Pick<ConveyorStore,
  | "createRun" | "recoverInterruptedExecutions" | "nextRunAttempt" | "finishRun" | "getRun"
  | "recordTerminalHomeReclamationFailure" | "clearTerminalHomeReclamationFailure"
  | "listRunsForStage" | "listRunsForExecution" | "listActiveIssueRuns" | "listIssueRuns" | "listIssueRunsPage" | "listRunsByKind"
  | "listRetiredRuns" | "latestRunSummary" | "costSummary" | "costSummaryByStage"
  | "appendRunEvent" | "listHarnessRunEvents" | "listRunEvents" | "deleteRunEvents" | "listIssueRunEventsAfter" | "listRunEventsPage"
>;

/** Agent questions, their answers and the item conversation. */
export type ConversationStore = Pick<ConveyorStore,
  | "openQuestion" | "answerQuestion" | "recordQuestionAnswer" | "recordQuestionAnswerWithConversation" | "completeQuestionAnswer"
  | "getQuestion" | "getQuestionForRun" | "listOpenQuestions" | "listAnsweredQuestionsForStage" | "hasQuestionForIssue"
  | "appendConversationMessage" | "latestConversationMessageIds" | "listConversationMessages"
>;

/** Conveyor's stored copy of GitHub reads. */
export type MirrorStore = Pick<ConveyorStore, "githubMirror">;

/** Stored webhook deliveries. */
export type DeliveryLogStore = Pick<ConveyorStore,
  "recordSourceEvent" | "sourceEvent" | "hasSourceEvent" | "countSourceEventsBefore" | "pruneSourceEvents"
>;

/** Dashboard accounts, push notifications and operator MCP tokens. */
export type AccountStore = Pick<ConveyorStore,
  | "dashboardAccounts" | "dashboardAccountById" | "dashboardAccountByUsername"
  | "seedDashboardSuperuser" | "createDashboardUser" | "changeDashboardPassword" | "changeDashboardAvatar" | "deleteDashboardAccount"
  | "getPushPreferences" | "setPushPreferences" | "putPushSubscription" | "deletePushSubscription" | "deletePushSubscriptions"
  | "listPushSubscriptions" | "recordPushEvent" | "pendingPushEvents" | "pushEventSubscriptions" | "claimPushDelivery"
  | "createOperatorMcpToken" | "listOperatorMcpTokens" | "revokeOperatorMcpToken" | "operatorMcpTokenIsActive"
>;

/** The read-only report queries. */
export type ReportStore = Pick<ConveyorStore, "reports">;

/** The database itself: transactions, its file, backups, schema and the dashboard revision. */
export type DatabaseStore = Pick<ConveyorStore,
  "close" | "transaction" | "filename" | "backupTo" | "sqlite" | "pragma" | "schemaVersion" | "dashboardRevision"
>;
