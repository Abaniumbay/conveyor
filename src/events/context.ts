// Who caused the work running now and which command it belongs to. Every event appended while it
// runs carries both, so the events one click, one delivery or one tick caused can be read together.

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
}

const SYSTEM: EventContext = { actor: { kind: "system", id: null }, correlationId: null };
const storage = new AsyncLocalStorage<EventContext>();

/** Runs `work` so that the events it appends, directly or asynchronously, carry `context`. */
export function withEventContext<T>(context: Partial<EventContext> & { actor: EventActor }, work: () => T): T {
  return storage.run({ correlationId: context.correlationId ?? null, actor: context.actor }, work);
}

export function currentEventContext(): EventContext {
  return storage.getStore() ?? SYSTEM;
}

export function newCorrelationId(): string {
  return randomUUID();
}
