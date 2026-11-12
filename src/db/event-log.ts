// The append-only event log in the Conveyor database. Writers append inside the transaction of the
// change they record; after the transaction ends the log drains the new rows, in order, to the bus.

import type { Database, SQLQueryBindings } from "bun:sqlite";

import { log } from "../log/logger";
import type { EventBus } from "../events/bus";
import { EVENT_CATALOGUE, type EventClass, type EventPayload, type EventType, type StoredEvent } from "../events/catalogue";
import { currentCausation, eventContextForIssue } from "../events/context";

export interface EventScope {
  repositoryId?: string | null;
  issueId?: string | null;
  /** The plugin that reported an `ingest` event; `core` otherwise. */
  source?: string;
}

export interface EventQuery {
  afterSeq?: number;
  issueId?: string;
  /** An event type, or a prefix ending in a dot such as `item.`. */
  type?: string;
  correlationId?: string;
  /** Only events of these classes; every class when omitted. */
  classes?: readonly EventClass[];
  /** Only the events that `seq` caused, directly or through other reactions. */
  causedBy?: number;
  since?: string;
  limit?: number;
}

/** How long trace events are kept: they show recent activity, not history. */
export const TRACE_RETENTION_MS = 24 * 60 * 60_000;

interface EventRow {
  seq: number;
  type: string;
  class: string;
  source: string;
  causation_seq: number | null;
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
  class: row.class as EventClass,
  source: row.source,
  causationSeq: row.causation_seq,
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

  /**
   * Appends one event; inside a transaction it is kept or rolled back with the change it records.
   * Work that reacts to an event (a bus subscriber and what it starts) records that event as the cause.
   */
  append<T extends EventType>(type: T, payload: EventPayload<T>, scope: EventScope = {}): void {
    const definition = EVENT_CATALOGUE[type];
    const parsed = definition.payload.parse(payload);
    const issueId = scope.issueId ?? null;
    const { actor, correlationId } = eventContextForIssue(issueId);
    this.database
      .query(
        `INSERT INTO events(type, class, source, causation_seq, occurred_at, repository_id, issue_id, actor_kind, actor_id, correlation_id, payload_json)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, (SELECT repository_id FROM issues WHERE id = ?)), ?, ?, ?, ?, ?)`,
      )
      .run(
        type, definition.class, scope.source ?? "core", currentCausation(), new Date().toISOString(),
        scope.repositoryId ?? null, issueId, issueId, actor.kind, actor.id, correlationId, JSON.stringify(parsed),
      );
    // bun:sqlite transactions are synchronous, so this runs after the enclosing one committed or rolled back.
    if (this.#bus) queueMicrotask(() => void this.drain());
  }

  /** Records a trace: what the service is doing, recorded outside any change, kept for a day. */
  trace<T extends EventType>(type: T, payload: EventPayload<T>, scope: EventScope = {}): void {
    if (EVENT_CATALOGUE[type].class !== "trace") throw new Error(`${type} is not a trace event`);
    this.append(type, payload, scope);
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
    if (query.classes !== undefined) {
      clauses.push(`class IN (${query.classes.map(() => "?").join(", ") || "NULL"})`);
      values.push(...query.classes);
    }
    if (query.since !== undefined) { clauses.push("occurred_at >= ?"); values.push(query.since); }
    let chain = "";
    if (query.causedBy !== undefined) {
      chain = `WITH RECURSIVE chain(seq) AS (
          SELECT seq FROM events WHERE causation_seq = ?
          UNION SELECT events.seq FROM events JOIN chain ON events.causation_seq = chain.seq
        ) `;
      values.unshift(query.causedBy);
      clauses.push("seq IN (SELECT seq FROM chain)");
    }
    values.push(Math.min(Math.max(query.limit ?? 500, 1), 5_000));
    const rows = this.database
      .query(`${chain}SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`)
      .all(...values) as EventRow[];
    return rows.map(toEvent);
  }

  /** How many events occurred before `before`. */
  countBefore(before: string): number {
    const row = this.database.query("SELECT COUNT(*) AS count FROM events WHERE occurred_at < ?").get(before) as { count: number };
    return row.count;
  }

  /** Deletes events that occurred before `before`, and traces older than `tracesBefore`; returns how many. */
  prune(before: string, tracesBefore: string = before): number {
    const facts = this.database.query("DELETE FROM events WHERE occurred_at < ?").run(before).changes;
    const traces = this.database.query("DELETE FROM events WHERE class = 'trace' AND occurred_at < ?").run(tracesBefore).changes;
    return facts + traces;
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
              const dispatched = bus.dispatch(event);
              if (dispatched) await dispatched;
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
