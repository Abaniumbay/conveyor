// Event sinks: consumers outside Conveyor (an analyzer, a log shipper) that receive every recorded
// event at least once, in order, from a durable cursor. The core never waits for a sink.

import { log, RotatingFile } from "../log/logger";
import type { EventBus } from "./bus";
import type { StoredEvent } from "./catalogue";
import type { EventLog } from "./log";

/** A consumer of the event log. `deliver` resolving means the batch is safely delivered. */
export interface EventSink {
  /** Stable and unique: the sink's cursor is stored under it. */
  readonly name: string;
  deliver(events: readonly StoredEvent[]): Promise<void>;
}

/** Appends each event as one JSON line to a file, rotated by size like the service log. */
export class JsonlEventSink implements EventSink {
  readonly name: string;
  readonly #file: RotatingFile;

  constructor(file: string, options: { maxBytes: number; keepFiles: number }) {
    this.name = `jsonl:${file}`;
    this.#file = new RotatingFile(file, options.maxBytes, options.keepFiles);
  }

  async deliver(events: readonly StoredEvent[]): Promise<void> {
    this.#file.append(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  }
}

export interface SinkRunnerOptions {
  batchSize?: number;
  /** The first retry delay after a failed delivery; it doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

/** Delivers the event log to one sink from its cursor; started by the service, stopped on close. */
export class SinkRunner {
  readonly #batchSize: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  #running: Promise<void> | null = null;
  #again = false;
  #stopped = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: () => void = () => {};

  constructor(private readonly events: EventLog, private readonly sink: EventSink, options: SinkRunnerOptions = {}) {
    this.#batchSize = options.batchSize ?? 500;
    this.#backoffMs = options.backoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  /** Delivers what the sink has not received yet, then every new event as it is recorded. */
  start(bus: EventBus): void {
    this.#unsubscribe = bus.subscribe("*", `sink ${this.sink.name}`, () => this.nudge());
    this.nudge();
  }

  /** Stops after the batch in flight; resolves once it has. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe();
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    await this.#running;
  }

  /** Resolves once every recorded event has been delivered, or a delivery failed. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** Delivers soon; never throws and never blocks the caller. */
  nudge(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    const run = this.#deliverPending();
    this.#running = run;
    void run.finally(() => {
      if (this.#running === run) this.#running = null;
    });
  }

  async #deliverPending(): Promise<void> {
    do {
      this.#again = false;
      while (!this.#stopped) {
        let cursor = this.events.consumerCursor(this.sink.name);
        if (cursor === null) {
          // A new sink starts with what the log still holds.
          cursor = Math.max(0, (this.events.oldestSeq() ?? this.events.latestSeq() + 1) - 1);
        }
        const oldest = this.events.oldestSeq();
        if (oldest !== null && cursor < oldest - 1) {
          log.warn("Event sink missed events that retention already removed", { sink: this.sink.name, missed: oldest - 1 - cursor });
          cursor = oldest - 1;
          this.events.advanceConsumer(this.sink.name, cursor);
        }
        const batch = this.events.read({ afterSeq: cursor, limit: this.#batchSize });
        if (batch.length === 0) break;
        try {
          await this.sink.deliver(batch);
        } catch (error) {
          this.#failures += 1;
          const delay = Math.min(this.#backoffMs * 2 ** (this.#failures - 1), this.#maxBackoffMs);
          log.warn("Event sink delivery failed; retrying", { sink: this.sink.name, events: batch.length, retryInMs: delay }, error);
          this.#retry = setTimeout(() => {
            this.#retry = null;
            this.nudge();
          }, delay);
          return;
        }
        this.#failures = 0;
        this.events.advanceConsumer(this.sink.name, batch.at(-1)!.seq);
      }
    } while (this.#again && !this.#stopped);
  }
}
