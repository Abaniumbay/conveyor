// Who caused the work running now and which command it belongs to. A command scoped to an item
// shares its context only with that item's events, while other contexts apply to every event.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const ACTOR_KINDS = ["user", "cli", "agent", "webhook", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface EventActor {
  kind: ActorKind;
  /** The account, run or delivery that acted; null for Conveyor itself. */
  id: string | null;
}

export interface EventContext {
  actor: EventActor;
  correlationId: string | null;
  /** The item a command explicitly acts on, when it names one. */
  issueId?: string;
}

const SYSTEM: EventContext = { actor: { kind: "system", id: null }, correlationId: null };
const storage = new AsyncLocalStorage<EventContext>();

/** Runs `work` so that the events it appends, directly or asynchronously, carry `context`. */
export function withEventContext<T>(context: Partial<EventContext> & { actor: EventActor }, work: () => T): T {
  const current: EventContext = { correlationId: context.correlationId ?? null, actor: context.actor };
  if (context.issueId !== undefined) current.issueId = context.issueId;
  return storage.run(current, work);
}

export function currentEventContext(): EventContext {
  return storage.getStore() ?? SYSTEM;
}

/** Returns the current context unless its command is scoped to another item. */
export function eventContextForIssue(issueId: string | null): EventContext {
  const context = currentEventContext();
  if (context.issueId !== undefined && issueId !== null && context.issueId !== issueId) return SYSTEM;
  return context;
}

export function newCorrelationId(): string {
  return randomUUID();
}
