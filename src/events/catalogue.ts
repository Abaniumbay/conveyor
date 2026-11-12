// Every event Conveyor records, declared once. The store or engine method that makes a change
// appends its event in the same transaction, so no change exists without its event. Each type has a
// class: a `fact` records a change of Conveyor's own state, an `ingest` event reports what a plugin
// observed at a provider, and a `trace` shows what the service is doing (fire and forget, kept for a
// day). Payloads carry identifiers and states, never secrets; only a type declared with `content`
// may carry user-written text, and sinks leave such events out unless they ask for them.

import { z } from "zod";

import { FINDING_TYPES } from "../engine/finding-types";
import { WAIT_KINDS } from "./topics";

export const EVENT_CLASSES = ["fact", "ingest", "trace"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

interface Definition<S extends z.ZodType> {
  group: string;
  description: string;
  payload: S;
  class: EventClass;
  /** Whether the payload may carry user-written text (titles, bodies, comments). */
  content: boolean;
}

const define = <S extends z.ZodType>(
  group: string,
  description: string,
  payload: S,
  options: { class?: EventClass; content?: boolean } = {},
): Definition<S> => ({ group, description, payload, class: options.class ?? "fact", content: options.content ?? false });

const ingest = { class: "ingest" } as const;
const trace = { class: "trace" } as const;

const id = z.string().min(1);
const nullableId = id.nullable();
const stage = z.string().min(1).nullable();
const sha = z.string().min(1);
const number = z.number().int().positive();

const actorSchema = z.object({ login: z.string().nullable() }).strict();
/** An item as an item source reports it (`SourceIssue`). */
const sourceIssueSchema = z.object({
  id: z.string(), number, url: z.string(), title: z.string(), body: z.string(), state: z.enum(["open", "closed"]),
  stateReason: z.string().nullable().optional(), labels: z.array(z.string()), type: z.string().nullable().optional(), updatedAt: z.string(),
}).strict();
/** Who made each change a delivery reports (`DeliveredActors`). */
const deliveredActorsSchema = z.object({
  enrollment: z.union([actorSchema, z.literal("unchanged")]),
  title: z.union([actorSchema, z.literal("unchanged")]),
  body: z.union([actorSchema, z.literal("unchanged")]),
}).strict();

/** The changes a review finding goes through, as its own history records them. */
export const FINDING_CHANGES = ["created", "resolved", "dismissed", "withdrawn", "edited", "reopened", "reclassified"] as const;

export const EVENT_CATALOGUE = {
  // Items
  "item.discovered": define("Items", "Conveyor saw a source issue for the first time.", z.object({ number }).strict()),
  "item.updated": define("Items", "A source issue's title, body, state, labels, parent or accepted text changed; `changed` names the fields.", z.object({
    number, changed: z.array(z.enum(["title", "body", "state", "labels", "parent", "acceptedText"])).min(1),
  }).strict()),
  "item.enrolled": define("Items", "An item started a new enrollment generation.", z.object({ generation: z.number().int().nonnegative() }).strict()),
  "item.offboarded": define("Items", "An item's active enrollment ended; `status` says how.", z.object({ status: z.string() }).strict()),
  "item.purged": define("Items", "An item lost its Conveyor labels (or was closed without a merge) and Conveyor deleted everything it held about it; the event log keeps the item's events.", z.object({ number }).strict()),
  "item.stageChanged": define("Items", "An item's projected stage or state changed.", z.object({
    fromStage: stage, fromState: z.string().nullable(), toStage: stage, toState: z.string().nullable(),
  }).strict()),
  "item.requeued": define("Items", "A person asked for an item's stage to run again: a retry, a message, a resume or an answer.", z.object({
    reason: z.enum(["retry", "message", "resume", "answer"]),
  }).strict()),
  "item.stopSummaryRecorded": define("Items", "The Operator recorded a short advice summary for an item's current stop; `stopId` names the stop. The text is not in the event.", z.object({ stopId: id }).strict()),
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
  "task.pending": define("Execution", "A task is waiting; it runs again at `wakeAt` unless an event it waits for (`waitFor`) wakes it earlier.", z.object({
    executionId: id, taskInstanceId: id, wakeAt: z.string().nullable(), deadlineAt: z.string().nullable(),
    waitFor: z.object({ topics: z.array(z.string()), kind: z.enum(WAIT_KINDS) }).strict().nullable(),
  }).strict()),
  "task.passed": define("Execution", "A task passed.", z.object({ executionId: id, taskInstanceId: id }).strict()),
  "task.failed": define("Execution", "A task failed.", z.object({ executionId: id, taskInstanceId: id }).strict()),
  "item.fenced": define("Execution", "The item's stage epoch moved: work started for the old epoch can no longer change it, and its stage restarts.", z.object({ epoch: z.number().int().positive() }).strict()),
  "task.woken": define("Execution", "A parked task was made due before its wake-up time.", z.object({}).strict()),
  "worker.released": define("Execution", "A stage worker left the running set; `stageId` identifies the stage it ran.", z.object({ stageId: id }).strict()),

  // Runs
  "run.started": define("Runs", "An agent, script or steering run started.", z.object({ runId: id, kind: z.string(), stage: stage }).strict()),
  "run.progressed": define("Runs", "A run wrote to its transcript; recorded at most once a second per run, and once after its last line.", z.object({ runId: id }).strict()),
  "run.finished": define("Runs", "A run finished; `status` is its outcome.", z.object({ runId: id, status: z.string() }).strict()),

  // Conversation
  "question.asked": define("Conversation", "A question for a person was opened.", z.object({ questionId: id }).strict()),
  "answer.recorded": define("Conversation", "An answer to a question was recorded.", z.object({ questionId: id }).strict()),
  "message.posted": define("Conversation", "A conversation message was stored.", z.object({ messageId: id, role: z.string() }).strict()),

  // Gates and review
  "gate.approved": define("Gates and review", "A person approved a manual gate for one visit (stage epoch and attempt) of its stage.", z.object({
    stageId: id, gateId: id, stageEpoch: z.number().int().nonnegative(), attempt: z.number().int().positive(),
  }).strict()),
  "gate.requirementChanged": define("Gates and review", "A manual gate was made required or optional.", z.object({ stageId: id, gateId: id, required: z.boolean() }).strict()),
  "gate.boardApprovalChanged": define("Gates and review", "A board approval was made required or optional for one stage.", z.object({ stageId: id, required: z.boolean() }).strict()),
  "gate.boardApproved": define("Gates and review", "A person approved the board gate for one stage visit.", z.object({
    stageId: id, stageEpoch: z.number().int().nonnegative(), attempt: z.number().int().positive(),
  }).strict()),
  "finding.changed": define("Gates and review", "A review finding was created, resolved, dismissed, withdrawn, edited, reopened or reclassified; `change` and its fixed `type` say which.", z.object({
    findingId: id, type: z.enum(FINDING_TYPES), change: z.enum(FINDING_CHANGES),
  }).strict()),
  "todo.changed": define("Gates and review", "An item's to-do list changed.", z.object({}).strict()),
  "criterion.approvalChanged": define("Gates and review", "A reviewer approved an acceptance criterion at a head, or withdrew the approval.", z.object({
    criterionId: id, approved: z.boolean(), headSha: sha.nullable(),
  }).strict()),
  "criterion.testsRecorded": define("Gates and review", "Test evidence for acceptance criteria was recorded.", z.object({ criteria: z.array(id) }).strict()),

  // Changes and CI
  "change.opened": define("Changes and CI", "Conveyor recorded a pull request for an item.", z.object({ number, state: z.string() }).strict()),
  "change.stateChanged": define("Changes and CI", "A recorded pull request's state changed (merged, closed, reopened).", z.object({ number, state: z.string() }).strict()),
  "change.headObserved": define("Changes and CI", "Conveyor observed a new current head for an open pull request.", z.object({ headSha: sha }).strict()),
  "indicator.changed": define("Changes and CI", "A board indicator (such as CI) changed state, progress or head.", z.object({
    indicatorId: id, state: z.string(), progress: z.string(), headSha: sha.nullable(),
  }).strict()),
  "indicator.cleared": define("Changes and CI", "A board indicator was removed.", z.object({ indicatorId: id }).strict()),
  "advisoryCi.watchStarted": define("Changes and CI", "An advisory CI watch started for a head.", z.object({ watchId: id, headSha: sha }).strict()),
  "advisoryCi.finished": define("Changes and CI", "An advisory CI watch posted its result.", z.object({ watchId: id, state: z.string() }).strict()),

  // Item sources and providers: what a plugin observed, and Conveyor's own source changes
  "webhook.received": define("Providers", "A plugin verified and stored a webhook delivery.", z.object({ deliveryId: id, eventType: z.string() }).strict(), ingest),
  "itemSource.itemChanged": define("Providers", "An item source reported a change to an item or its comments; `pullRequest` when the item is a change request. `item` is the item as the delivery describes it and `actors` who changed what, when the delivery carries them; otherwise Conveyor reads the item.", z.object({
    repository: z.string(), number, action: z.string(), pullRequest: z.boolean(),
    item: sourceIssueSchema.nullable().default(null), actors: deliveredActorsSchema.nullable().default(null),
  }).strict(), { class: "ingest", content: true }),
  "itemSource.relationsChanged": define("Providers", "An item source reported changed children or blockers; `numbers` are the items of this repository involved.", z.object({
    repository: z.string(), numbers: z.array(number),
  }).strict(), ingest),
  "itemSource.pinged": define("Providers", "An item source confirmed its webhook (a ping).", z.object({ repository: z.string() }).strict(), ingest),
  "code.changeUpdated": define("Providers", "A code host reported a change to a change request (opened, synchronize, closed, ...).", z.object({
    repository: z.string(), number, action: z.string(), headSha: sha.nullable(), merged: z.boolean().default(false),
  }).strict(), ingest),
  "ci.runUpdated": define("Providers", "A CI provider reported progress for a commit; `completed` when a run finished. `changes` are the change requests it belongs to.", z.object({
    repository: z.string(), sha, changes: z.array(number), completed: z.boolean(),
  }).strict(), ingest),
  "webhook.healthChanged": define("Providers", "A repository's webhook started or stopped delivering: unhealthy when a ping went undelivered, healthy again with the next delivery.", z.object({ healthy: z.boolean() }).strict()),
  "source.mutationStarted": define("Providers", "Conveyor recorded a change it is about to make at the source.", z.object({ mutationId: id, operation: z.string() }).strict()),
  "source.mutationCompleted": define("Providers", "A source change completed.", z.object({ mutationId: id, operation: z.string() }).strict()),
  "source.mutationFailed": define("Providers", "A source change failed.", z.object({ mutationId: id, operation: z.string() }).strict()),

  // Workspaces
  "workspace.recorded": define("Workspaces", "An item's workspace was created or its status changed.", z.object({ branch: z.string(), status: z.string() }).strict()),
  "workspace.removed": define("Workspaces", "An item's workspace was removed.", z.object({}).strict()),

  // System
  "repository.onboarded": define("System", "A configured repository was added to or updated in the local index.", z.object({ address: z.string() }).strict()),
  "repository.removed": define("System", "An unconfigured repository and its history were removed.", z.object({}).strict()),
  "repository.trustChanged": define("System", "A repository's observed visibility changed.", z.object({ visibility: z.string() }).strict()),
  "repository.paused": define("System", "An operator paused repository work without changing its configuration.", z.object({ actor: z.string(), reason: z.string().nullable() }).strict()),
  "repository.resumed": define("System", "An operator resumed repository work from its retained state.", z.object({}).strict()),
  "config.recorded": define("System", "A new configuration snapshot was recorded.", z.object({ hash: z.string() }).strict()),
  "account.created": define("System", "A dashboard account was created.", z.object({ accountId: id, role: z.string() }).strict()),
  "account.passwordChanged": define("System", "A dashboard account's password changed.", z.object({ accountId: id }).strict()),
  "account.avatarChanged": define("System", "A dashboard account's avatar changed.", z.object({ accountId: id }).strict()),
  "account.deleted": define("System", "A dashboard account was deleted.", z.object({ accountId: id }).strict()),
  "operatorMcpToken.created": define("System", "An operator MCP token was created.", z.object({ tokenId: id }).strict()),
  "operatorMcpToken.revoked": define("System", "An operator MCP token was revoked.", z.object({ tokenId: id }).strict()),
  "notifications.settingsChanged": define("System", "An account's push notification preferences changed.", z.object({ accountId: id }).strict()),
  "notifications.subscribed": define("System", "A browser subscribed to push notifications.", z.object({ accountId: id }).strict()),
  "notifications.unsubscribed": define("System", "A browser's push subscription was removed.", z.object({ accountId: nullableId }).strict()),
  "session.signedIn": define("System", "A dashboard account signed in.", z.object({ accountId: nullableId }).strict()),
  "session.signedOut": define("System", "A dashboard account signed out.", z.object({ accountId: nullableId }).strict()),
  "repository.healthChanged": define("System", "A repository's onboarding or reconcile started failing, or recovered; the dashboard shows the error.", z.object({
    check: z.enum(["onboarding", "reconcile"]), healthy: z.boolean(),
  }).strict()),
  "admission.paused": define("System", "Conveyor stopped admitting new work (a drain); running work continues.", z.object({}).strict()),
  "admission.resumed": define("System", "Conveyor admits new work again.", z.object({}).strict()),
  "service.reconciled": define("System", "A pass over every repository finished; `failed` repositories could not be read.", z.object({ failed: z.number().int().nonnegative() }).strict()),
  "repository.reconciled": define("System", "Conveyor finished reading a repository's issues; `issueNumbers` are the ones a webhook named, null for all.", z.object({
    issueNumbers: z.array(number).nullable(),
  }).strict()),

  // Traces
  "scheduler.decided": define("Traces", "A scheduling pass started `started` items; `waiting` were runnable but held back by a limit and `running` were already running. Recorded when the outcome changes.", z.object({
    started: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
  }).strict(), trace),
  "timer.fired": define("Traces", "One of the service's timers fired and started its work.", z.object({
    timer: z.enum(["reconcile", "wake", "retention", "webhook-health", "github-calls", "advisory-ci", "scheduled-operator"]),
  }).strict(), trace),

  // Commands
  "command.accepted": define("Commands", "A command from the dashboard or the CLI succeeded; events for its item share its correlation id.", z.object({ command: z.string() }).strict()),
  "command.rejected": define("Commands", "A command was refused or failed; `reason` says why.", z.object({ command: z.string(), reason: z.string() }).strict()),
} as const satisfies Record<string, Definition<z.ZodType>>;

export type EventType = keyof typeof EVENT_CATALOGUE;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_CATALOGUE)[T]["payload"]>;

/** The event types a plugin reports when it observes something at a provider. */
export const OBSERVATION_TYPES = ["itemSource.itemChanged", "itemSource.relationsChanged", "itemSource.pinged", "code.changeUpdated", "ci.runUpdated"] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
/** What a plugin observed, as the neutral event it is recorded as. */
export type Observation = { [T in ObservationType]: { type: T; payload: EventPayload<T> } }[ObservationType];

/** An event as the log stores it. */
export interface StoredEvent<T extends EventType = EventType> {
  seq: number;
  type: T;
  class: EventClass;
  /** `core`, or the plugin that reported it (`github`). */
  source: string;
  /** The event whose subscriber appended this one, when it was a reaction. */
  causationSeq: number | null;
  occurredAt: string;
  repositoryId: string | null;
  issueId: string | null;
  actor: { kind: string; id: string | null };
  correlationId: string | null;
  payload: EventPayload<T>;
}

/** Narrows a stored event to one type, and with it its payload. */
export function isEventOf<T extends EventType>(event: StoredEvent, type: T): event is StoredEvent<T> {
  return event.type === type;
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOGUE, value);
}
