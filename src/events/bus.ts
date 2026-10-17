// The in-process event bus. Only the event log's drain publishes to it, after the transaction
// that appended the events committed, so a subscriber never sees an event whose change rolled back.

import { log } from "../log/logger";
import type { EventType, StoredEvent } from "./catalogue";

export type EventHandler<T extends EventType = EventType> = (event: StoredEvent<T>) => void | Promise<void>;

/** Typed publish/subscribe; subscribers of one event run one after another in registration order. */
export class EventBus {
  readonly #handlers: Array<{ type: EventType | "*"; name: string; handler: EventHandler<EventType> }> = [];

  /** Subscribes `handler` to one event type, or to every event with `*`; returns the unsubscribe. */
  subscribe<T extends EventType>(type: T | "*", name: string, handler: EventHandler<T>): () => void {
    const entry = { type, name, handler: handler as EventHandler<EventType> };
    this.#handlers.push(entry);
    return () => {
      const index = this.#handlers.indexOf(entry);
      if (index >= 0) this.#handlers.splice(index, 1);
    };
  }

  /** Runs every subscriber of `event` in order; a failing one is logged and the rest still run. */
  async dispatch(event: StoredEvent): Promise<void> {
    for (const { type, name, handler } of [...this.#handlers]) {
      if (type !== "*" && type !== event.type) continue;
      try {
        await handler(event);
      } catch (error) {
        log.warn("Event subscriber failed", { subscriber: name, event: event.type, seq: event.seq }, error);
      }
    }
  }
}
