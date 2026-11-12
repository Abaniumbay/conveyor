import { EVENT_CLASSES, type EventClass, type StoredEvent } from "../../events/catalogue";
import type { EventQuery } from "../../events/log";
import { ConveyorStore } from "../../db/store";
import { CliError, EXIT, parseDuration } from "../args";
import { loadCommandConfig, stringOption, type Command } from "../command";

const FOLLOW_POLL_MS = 500;

/** One event as a line: sequence, time, class, type, item, actor, source, cause, correlation and payload. */
export function formatEvent(event: StoredEvent, items: Map<string, string>): string {
  const item = event.issueId ? (items.get(event.issueId) ?? event.issueId) : (event.repositoryId ?? "-");
  const actor = event.actor.id ? `${event.actor.kind}:${event.actor.id}` : event.actor.kind;
  const source = event.source === "core" ? "" : ` source=${event.source}`;
  const cause = event.causationSeq === null ? "" : ` cause=${event.causationSeq}`;
  const correlation = event.correlationId ? ` correlation=${event.correlationId}` : "";
  return `${event.seq} ${event.occurredAt} ${event.class} ${event.type} ${item} ${actor}${source}${cause}${correlation} ${JSON.stringify(event.payload)}`;
}

/** The classes a `--class` list names. */
export function parseClasses(value: string): EventClass[] {
  const classes = value.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = classes.filter((name) => !(EVENT_CLASSES as readonly string[]).includes(name));
  if (classes.length === 0 || unknown.length > 0) {
    throw new CliError(`--class takes a comma-separated list of ${EVENT_CLASSES.join(", ")}${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}`, EXIT.usage);
  }
  return classes as EventClass[];
}

export const events: Command = {
  name: "events",
  summary: "print the event log (every recorded change), optionally following it",
  options: {
    follow: { type: "boolean", description: "keep printing new events until interrupted" },
    issue: { type: "string", value: "<item>", description: "only events about this item, e.g. conveyor:90" },
    type: { type: "string", value: "<type>", description: "only this event type, or a group ending in a dot, e.g. item." },
    correlation: { type: "string", value: "<id>", description: "only the events one command caused" },
    class: { type: "string", value: "<classes>", description: "only these classes, comma-separated: fact (Conveyor's changes), ingest (what a plugin observed), trace (the service's own activity)" },
    "caused-by": { type: "string", value: "<seq>", description: "only the events that the event with this sequence number caused, directly or through other reactions" },
    since: { type: "string", value: "<duration>", description: "only events from this long ago, e.g. 30m, 1h, 7d" },
    lines: { type: "string", value: "<n>", description: "print at most the last n matching events (default 200; 0 for all)" },
  },
  details: "Reads the database directly, so it works whether or not the service is running. Every line shows the event's class; reactions show the event that caused them (cause=<seq>), and plugin observations their source. Payloads carry identifiers and states, never secrets; user-written text appears only in event types that declare it. Traces are kept for a day.",
  async run(context) {
    const config = await loadCommandConfig(context, null);
    const store = await ConveyorStore.open(config.settings.database, { migrateExisting: false });
    try {
      const items = new Map(store.listIssues().map((issue) => [issue.id, `${issue.repositoryId}:${issue.sourceNumber}`]));
      const reference = stringOption(context, "issue");
      let issueId: string | undefined;
      if (reference !== undefined) {
        const match = /^(.+)[:#](\d+)$/.exec(reference);
        const issue = match
          ? store.listIssues(match[1]).find((candidate) => candidate.sourceNumber === Number(match[2]))
          : store.getIssue(reference);
        if (!issue) throw new CliError(`no item ${reference}`, EXIT.failure);
        issueId = issue.id;
      }
      const since = stringOption(context, "since");
      const type = stringOption(context, "type");
      const correlation = stringOption(context, "correlation");
      const classes = stringOption(context, "class");
      const causedBy = stringOption(context, "caused-by");
      if (causedBy !== undefined && !/^\d+$/.test(causedBy)) throw new CliError("--caused-by takes an event sequence number", EXIT.usage);
      const query: EventQuery = {
        ...(classes !== undefined ? { classes: parseClasses(classes) } : {}),
        ...(causedBy !== undefined ? { causedBy: Number(causedBy) } : {}),
        ...(issueId !== undefined ? { issueId } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(correlation !== undefined ? { correlationId: correlation } : {}),
        ...(since !== undefined ? { since: new Date(Date.now() - parseDuration(since, "--since")).toISOString() } : {}),
      };
      const lines = Number(stringOption(context, "lines") ?? "200");
      if (!Number.isInteger(lines) || lines < 0) throw new CliError("--lines must be a whole number", EXIT.usage);
      const print = (event: StoredEvent) => context.out(context.json ? JSON.stringify(event) : formatEvent(event, items));
      // Each read covers events up to a sequence captured first, so moving the cursor past events
      // that do not match never skips one recorded meanwhile.
      const readUpTo = (after: number, upTo: number): StoredEvent[] => {
        const found: StoredEvent[] = [];
        for (let batch = store.events().read({ ...query, afterSeq: after, limit: 5_000 }); batch.length > 0; batch = store.events().read({ ...query, afterSeq: after, limit: 5_000 })) {
          const inRange = batch.filter((event) => event.seq <= upTo);
          found.push(...inRange);
          if (lines > 0 && !context.options.follow && found.length > lines) found.splice(0, found.length - lines);
          if (inRange.length < batch.length) break;
          after = batch.at(-1)!.seq;
        }
        return found;
      };
      let cursor = store.events().latestSeq();
      const history = readUpTo(0, cursor);
      for (const event of lines === 0 ? history : history.slice(-lines)) print(event);
      if (!context.options.follow) return;
      let stopped = false;
      const stop = () => { stopped = true; };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      while (!stopped) {
        await Bun.sleep(FOLLOW_POLL_MS);
        const latest = store.events().latestSeq();
        for (const event of readUpTo(cursor, latest)) print(event);
        cursor = latest;
      }
    } finally {
      store.close();
    }
  },
};
