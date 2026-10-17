// The append-only event log in the Conveyor database. Writers append inside the transaction of the
// change they record; after the transaction ends the log drains the new rows, in order, to the bus.

import type { Database, SQLQueryBindings } from "bun:sqlite";

import { log } from "../log/logger";
import type { EventBus } from "./bus";
import { EVENT_CATALOGUE, type EventPayload, type EventType, type StoredEvent } from "./catalogue";
import { currentEventContext } from "./context";

export interface EventScope {
  repositoryId?: string | null;
  issueId?: string | null;
}

export interface EventQuery {
  afterSeq?: number;
  issueId?: string;
  /** An event type, or a prefix ending in a dot such as `item.`. */
  type?: string;
  correlationId?: string;
  since?: string;
  limit?: number;
}

interface EventRow {
  seq: number;
  type: string;
  occurred_at: string;
  repository_id: string | null;
  issue_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  correlation_id: string | null;
  payload_json: string;
}

const toEvent = (row: EventRow): StoredEvent => ({
  seq: row.seq,
  type: row.type as EventType,
  occurredAt: row.occurred_at,
  repositoryId: row.repository_id,
  issueId: row.issue_id,
  actor: { kind: row.actor_kind, id: row.actor_id },
  correlationId: row.correlation_id,
  payload: JSON.parse(row.payload_json) as StoredEvent["payload"],
});

const logs = new WeakMap<Database, EventLog>();

/** The event log of a database: every writer of that database appends to the same log. */
export function eventLog(database: Database): EventLog {
  let found = logs.get(database);
  if (!found) {
    found = new EventLog(database);
    logs.set(database, found);
  }
  return found;
}

export class EventLog {
  #bus: EventBus | null = null;
  #published = 0;
  #draining: Promise<void> | null = null;
  #again = false;

  constructor(private readonly database: Database) {}

  /**
   * Publishes events appended from now on to `bus`. Earlier events are not replayed: in-process
   * subscribers are live projections, and durable consumers read the log from their own cursor.
   */
  attach(bus: EventBus): void {
    this.#bus = bus;
    this.#published = this.latestSeq();
  }

  /** Appends one event; inside a transaction it is kept or rolled back with the change it records. */
  append<T extends EventType>(type: T, payload: EventPayload<T>, scope: EventScope = {}): void {
    const parsed = EVENT_CATALOGUE[type].payload.parse(payload);
    const { actor, correlationId } = currentEventContext();
    const issueId = scope.issueId ?? null;
    this.database
      .query(
        `INSERT INTO events(type, occurred_at, repository_id, issue_id, actor_kind, actor_id, correlation_id, payload_json)
         VALUES (?, ?, COALESCE(?, (SELECT repository_id FROM issues WHERE id = ?)), ?, ?, ?, ?, ?)`,
      )
      .run(type, new Date().toISOString(), scope.repositoryId ?? null, issueId, issueId, actor.kind, actor.id, correlationId, JSON.stringify(parsed));
    // bun:sqlite transactions are synchronous, so this runs after the enclosing one committed or rolled back.
    if (this.#bus) queueMicrotask(() => void this.drain());
  }

  latestSeq(): number {
    const row = this.database.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  oldestSeq(): number | null {
    const row = this.database.query("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq;
  }

  read(query: EventQuery = {}): StoredEvent[] {
    const clauses: string[] = ["seq > ?"];
    const values: SQLQueryBindings[] = [query.afterSeq ?? 0];
    if (query.issueId !== undefined) { clauses.push("issue_id = ?"); values.push(query.issueId); }
    if (query.type !== undefined) {
      if (query.type.endsWith(".")) { clauses.push("substr(type, 1, ?) = ?"); values.push(query.type.length, query.type); }
      else { clauses.push("type = ?"); values.push(query.type); }
    }
    if (query.correlationId !== undefined) { clauses.push("correlation_id = ?"); values.push(query.correlationId); }
    if (query.since !== undefined) { clauses.push("occurred_at >= ?"); values.push(query.since); }
    values.push(Math.min(Math.max(query.limit ?? 500, 1), 5_000));
    const rows = this.database
      .query(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`)
      .all(...values) as EventRow[];
    return rows.map(toEvent);
  }

  /** How many events occurred before `before`. */
  countBefore(before: string): number {
    const row = this.database.query("SELECT COUNT(*) AS count FROM events WHERE occurred_at < ?").get(before) as { count: number };
    return row.count;
  }

  /** Deletes events that occurred before `before`; returns how many. */
  prune(before: string): number {
    return this.database.query("DELETE FROM events WHERE occurred_at < ?").run(before).changes;
  }

  /** The last event a durable consumer processed, or null when it has never run. */
  consumerCursor(name: string): number | null {
    const row = this.database.query("SELECT last_seq FROM event_consumers WHERE name = ?").get(name) as { last_seq: number } | null;
    return row?.last_seq ?? null;
  }

  advanceConsumer(name: string, seq: number): void {
    this.database
      .query(
        `INSERT INTO event_consumers(name, last_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_seq = MAX(event_consumers.last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
      )
      .run(name, seq, new Date().toISOString());
  }

  /** Publishes every committed event not yet published, in order; one drain runs at a time. */
  drain(): Promise<void> {
    if (this.#draining) {
      this.#again = true;
      return this.#draining;
    }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          const bus = this.#bus;
          if (!bus) return;
          for (let batch = this.read({ afterSeq: this.#published }); batch.length > 0; batch = this.read({ afterSeq: this.#published })) {
            for (const event of batch) {
              this.#published = event.seq;
              await bus.dispatch(event);
            }
          }
        } while (this.#again);
      } catch (error) {
        // Reading can fail only when the database is closing; the next append drains again.
        log.warn("Event publishing stopped", { published: this.#published }, error);
      }
    })();
    // Cleared after the assignment: a drain with nothing to publish finishes before `run` is stored.
    this.#draining = run;
    void run.finally(() => {
      if (this.#draining === run) this.#draining = null;
    });
    return run;
  }

  /** Resolves once every committed event has been published. */
  async settled(): Promise<void> {
    await Promise.resolve();
    while (this.#draining || (this.#bus && this.latestSeq() > this.#published)) await this.drain();
  }
}
