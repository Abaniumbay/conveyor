// Every event Conveyor records, declared once. The store or engine method that makes a change
// appends its event in the same transaction, so no change exists without its event. Payloads carry
// identifiers and states, never secrets and never user-written text: a consumer that needs the
// text reads it from the view or the source.

import { z } from "zod";

interface Definition<S extends z.ZodType> {
  group: string;
  description: string;
  payload: S;
}

const define = <S extends z.ZodType>(group: string, description: string, payload: S): Definition<S> => ({ group, description, payload });

const id = z.string().min(1);
const nullableId = id.nullable();
const stage = z.string().min(1).nullable();
const sha = z.string().min(1);
const number = z.number().int().positive();

/** The changes a review finding goes through, as its own history records them. */
export const FINDING_CHANGES = ["created", "resolved", "dismissed", "withdrawn", "edited", "reopened"] as const;

export const EVENT_CATALOGUE = {
  // Items
  "item.discovered": define("Items", "Conveyor saw a source issue for the first time.", z.object({ number }).strict()),
  "item.updated": define("Items", "A source issue's title, body, state, labels, parent or accepted text changed; `changed` names the fields.", z.object({
    number, changed: z.array(z.enum(["title", "body", "state", "labels", "parent", "acceptedText"])).min(1),
  }).strict()),
  "item.enrolled": define("Items", "An item started a new enrollment generation.", z.object({ generation: z.number().int().nonnegative() }).strict()),
  "item.offboarded": define("Items", "An item's active enrollment ended; `status` says how.", z.object({ status: z.string() }).strict()),
  "item.stageChanged": define("Items", "An item's projected stage or state changed.", z.object({
    fromStage: stage, fromState: z.string().nullable(), toStage: stage, toState: z.string().nullable(),
  }).strict()),
  "item.queueChanged": define("Items", "An item's backlog position changed; null rank leaves the queue.", z.object({ rank: z.number().nullable() }).strict()),
  "item.relationshipsChanged": define("Items", "An item's stored parent or blockers changed.", z.object({
    parentId: nullableId, dependencies: z.array(id),
  }).strict()),
  "item.metadataChanged": define("Items", "An item's issue type or issue-field values changed.", z.object({}).strict()),
  "stage.stateChanged": define("Items", "An item's stage record (stage, status or feedback cycle) changed.", z.object({
    stageId: id, status: z.string(), feedbackCycle: z.number().int().nonnegative(),
  }).strict()),
  "journey.recorded": define("Items", "A journey entry (a stage transition, resume or restart) completed or failed.", z.object({
    transitionId: id, kind: z.string(), fromStage: stage, toStage: stage, status: z.enum(["completed", "failed"]),
  }).strict()),

  // Execution
  "task.planned": define("Execution", "The executor recorded that it will run a task.", z.object({
    executionId: id, stage: id, list: z.string(), taskInstanceId: id, attempt: z.number().int().positive(), epoch: z.number().int().nonnegative(),
  }).strict()),
  "task.pending": define("Execution", "A task is waiting; it runs again at `wakeAt` unless something wakes it earlier.", z.object({
    executionId: id, taskInstanceId: id, wakeAt: z.string().nullable(), deadlineAt: z.string().nullable(),
  }).strict()),
  "task.passed": define("Execution", "A task passed.", z.object({ executionId: id, taskInstanceId: id }).strict()),
  "task.failed": define("Execution", "A task failed.", z.object({ executionId: id, taskInstanceId: id }).strict()),
  "task.woken": define("Execution", "A parked task was made due before its wake-up time.", z.object({}).strict()),

  // Runs
  "run.started": define("Runs", "An agent, script or steering run started.", z.object({ runId: id, kind: z.string(), stage: stage }).strict()),
  "run.finished": define("Runs", "A run finished; `status` is its outcome.", z.object({ runId: id, status: z.string() }).strict()),

  // Conversation
  "question.asked": define("Conversation", "A question for a person was opened.", z.object({ questionId: id }).strict()),
  "answer.recorded": define("Conversation", "An answer to a question was recorded.", z.object({ questionId: id }).strict()),
  "message.posted": define("Conversation", "A conversation message was stored.", z.object({ messageId: id, role: z.string() }).strict()),

  // Gates and review
  "gate.approved": define("Gates and review", "A person approved a manual gate.", z.object({ stageId: id, gateId: id }).strict()),
  "gate.requirementChanged": define("Gates and review", "A manual gate was made required or optional.", z.object({ stageId: id, gateId: id, required: z.boolean() }).strict()),
  "finding.changed": define("Gates and review", "A review finding was created, resolved, dismissed, withdrawn, edited or reopened; `change` says which.", z.object({
    findingId: id, change: z.enum(FINDING_CHANGES),
  }).strict()),
  "todo.changed": define("Gates and review", "An item's to-do list changed.", z.object({}).strict()),
  "criterion.approvalChanged": define("Gates and review", "A reviewer approved an acceptance criterion at a head, or withdrew the approval.", z.object({
    criterionId: id, approved: z.boolean(), headSha: sha.nullable(),
  }).strict()),
  "criterion.testsRecorded": define("Gates and review", "Test evidence for acceptance criteria was recorded.", z.object({ criteria: z.array(id) }).strict()),

  // Changes and CI
  "change.opened": define("Changes and CI", "Conveyor recorded a pull request for an item.", z.object({ number, state: z.string() }).strict()),
  "change.stateChanged": define("Changes and CI", "A recorded pull request's state changed (merged, closed, reopened).", z.object({ number, state: z.string() }).strict()),
  "indicator.changed": define("Changes and CI", "A board indicator (such as CI) changed state, progress or head.", z.object({
    indicatorId: id, state: z.string(), progress: z.string(), headSha: sha.nullable(),
  }).strict()),
  "indicator.cleared": define("Changes and CI", "A board indicator was removed.", z.object({ indicatorId: id }).strict()),
  "advisoryCi.watchStarted": define("Changes and CI", "An advisory CI watch started for a head.", z.object({ watchId: id, headSha: sha }).strict()),
  "advisoryCi.finished": define("Changes and CI", "An advisory CI watch posted its result.", z.object({ watchId: id, state: z.string() }).strict()),

  // GitHub
  "webhook.received": define("GitHub", "A verified webhook delivery was stored.", z.object({ deliveryId: id, eventType: z.string() }).strict()),
  "source.mutationStarted": define("GitHub", "Conveyor recorded a change it is about to make at the source.", z.object({ mutationId: id, operation: z.string() }).strict()),
  "source.mutationCompleted": define("GitHub", "A source change completed.", z.object({ mutationId: id, operation: z.string() }).strict()),
  "source.mutationFailed": define("GitHub", "A source change failed.", z.object({ mutationId: id, operation: z.string() }).strict()),

  // Workspaces
  "workspace.recorded": define("Workspaces", "An item's workspace was created or its status changed.", z.object({ branch: z.string(), status: z.string() }).strict()),
  "workspace.removed": define("Workspaces", "An item's workspace was removed.", z.object({}).strict()),

  // System
  "repository.onboarded": define("System", "A configured repository was added to or updated in the local index.", z.object({ address: z.string() }).strict()),
  "repository.removed": define("System", "An unconfigured repository and its history were removed.", z.object({}).strict()),
  "repository.trustChanged": define("System", "A repository's observed visibility changed.", z.object({ visibility: z.string() }).strict()),
  "config.recorded": define("System", "A new configuration snapshot was recorded.", z.object({ hash: z.string() }).strict()),
  "account.created": define("System", "A dashboard account was created.", z.object({ accountId: id, role: z.string() }).strict()),
  "account.passwordChanged": define("System", "A dashboard account's password changed.", z.object({ accountId: id }).strict()),
  "account.avatarChanged": define("System", "A dashboard account's avatar changed.", z.object({ accountId: id }).strict()),
  "account.deleted": define("System", "A dashboard account was deleted.", z.object({ accountId: id }).strict()),
  "notifications.settingsChanged": define("System", "An account's push notification preferences changed.", z.object({ accountId: id }).strict()),
  "notifications.subscribed": define("System", "A browser subscribed to push notifications.", z.object({ accountId: id }).strict()),
  "notifications.unsubscribed": define("System", "A browser's push subscription was removed.", z.object({ accountId: nullableId }).strict()),
} as const satisfies Record<string, Definition<z.ZodType>>;

export type EventType = keyof typeof EVENT_CATALOGUE;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_CATALOGUE)[T]["payload"]>;

/** An event as the log stores it. */
export interface StoredEvent<T extends EventType = EventType> {
  seq: number;
  type: T;
  occurredAt: string;
  repositoryId: string | null;
  issueId: string | null;
  actor: { kind: string; id: string | null };
  correlationId: string | null;
  payload: EventPayload<T>;
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOGUE, value);
}
