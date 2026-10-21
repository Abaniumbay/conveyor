// Web tests fake the service with plain functions. This builds a real command bus over them, so a
// route's request goes through command validation and authorization exactly as in production.

import { Database } from "bun:sqlite";

import { CommandBus, type CommandActor, type CommandResults } from "../../src/commands/bus";
import type { CommandInput, CommandName } from "../../src/commands/registry";
import { migrations } from "../../src/db/migrations";
import { eventLog, type EventLog } from "../../src/events/log";

/** A command bus whose handlers call the fake service functions present in `service`, and its event log. */
export function fakeCommandBus(service: Record<string, unknown>): { commands: CommandBus; events: EventLog } {
  const database = new Database(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  const events = eventLog(database);
  const commands = new CommandBus(events);
  const register = <N extends CommandName>(
    name: N,
    fake: string,
    call: (fn: (...args: unknown[]) => unknown, input: CommandInput<N>, actor: CommandActor) => unknown,
  ) => {
    const fn = service[fake];
    if (typeof fn !== "function") return;
    const invoke = (...args: unknown[]) => Reflect.apply(fn, undefined, args) as unknown;
    // The fake returns what the service method it stands for returns.
    commands.handle(name, async (input, actor) => (await call(invoke, input, actor)) as CommandResults[N]);
  };
  register("question.answer", "answerQuestion", (fn, input, actor) => fn(input.questionId, input.answer, actor.name));
  register("gate.setItemApproval", "setBoardApprovalRequirement", (fn, input) => fn(input.issueId, input.stageId, input.required));
  register("gate.approve", "approveManualGate", (fn, input, actor) => fn(input.issueId, input.stageId, input.gateId, { id: actor.id, username: actor.name }));
  register("backlog.reorder", "reorderBacklog", (fn, input) => fn(input.issueId, input.direction));
  register("backlog.move", "moveBacklogIssue", (fn, input) => fn(input.issueId, input.beforeIssueId));
  register("repository.sync", "syncRepository", (fn, input) => fn(input.repositoryId));
  register("repository.pause", "pauseRepository", (fn, input, actor) => fn(input.repositoryId, input.reason, actor.name));
  register("repository.resume", "resumeRepository", (fn, input) => fn(input.repositoryId));
  register("steering.start", "startSteering", (fn, input) => fn(input.prompt));
  register("item.postMessage", "postIssueMessage", (fn, input, actor) => fn(input.issueId, input.message, actor.name));
  register("item.retry", "retryIssue", (fn, input, actor) => fn(input.issueId, input.note, actor.name));
  register("item.resumeRollup", "resumeRollupParent", (fn, input) => fn(input.issueId));
  register("finding.reclassify", "reclassifyFinding", (fn, input, actor) => fn(input.issueId, input.findingId, input.type, actor.name));
  register("finding.dismiss", "dismissFinding", (fn, input, actor) => fn(input.issueId, input.findingId, input.reason, actor.name));
  register("account.create", "createAccount", (fn, input) => fn(input.username, input.passwordHash));
  register("account.setPassword", "changePassword", (fn, input) => fn(input.accountId, input.passwordHash));
  register("account.delete", "deleteAccount", (fn, input) => fn(input.accountId));
  register("account.setAvatar", "changeAvatar", (fn, input) => fn(input.accountId, input.avatar));
  register("notifications.updateSettings", "setPushPreferences", (fn, input) => fn(input.accountId, input.preferences));
  register("notifications.subscribe", "putPushSubscription", (fn, input) => fn(input.accountId, input.endpoint, input.keys));
  register("notifications.unsubscribe", "deletePushSubscription", (fn, input) => fn(input.accountId, input.endpoint));
  return { commands, events };
}

/** Fake web dependencies with `dispatch` going through a real command bus over the fake functions. */
export function withCommands<T extends Record<string, unknown>>(service: T): { dependencies: T & { dispatch: CommandBus["dispatch"] }; events: EventLog } {
  const { commands, events } = fakeCommandBus(service);
  return { dependencies: { ...service, dispatch: (name, input, actor) => commands.dispatch(name, input, actor) }, events };
}
