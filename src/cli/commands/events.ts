import type { StoredEvent } from "../../events/catalogue";
import type { EventQuery } from "../../events/log";
import { ConveyorStore } from "../../db/store";
import { CliError, EXIT, parseDuration } from "../args";
import { loadCommandConfig, stringOption, type Command } from "../command";

const FOLLOW_POLL_MS = 500;

/** One event as a line: sequence, time, type, item, actor, correlation and payload. */
function formatEvent(event: StoredEvent, items: Map<string, string>): string {
  const item = event.issueId ? (items.get(event.issueId) ?? event.issueId) : (event.repositoryId ?? "-");
  const actor = event.actor.id ? `${event.actor.kind}:${event.actor.id}` : event.actor.kind;
  const correlation = event.correlationId ? ` correlation=${event.correlationId}` : "";
  return `${event.seq} ${event.occurredAt} ${event.type} ${item} ${actor}${correlation} ${JSON.stringify(event.payload)}`;
}

export const events: Command = {
  name: "events",
  summary: "print the event log (every recorded change), optionally following it",
  options: {
    follow: { type: "boolean", description: "keep printing new events until interrupted" },
    issue: { type: "string", value: "<item>", description: "only events about this item, e.g. conveyor:90" },
    type: { type: "string", value: "<type>", description: "only this event type, or a group ending in a dot, e.g. item." },
    correlation: { type: "string", value: "<id>", description: "only the events one command caused" },
    since: { type: "string", value: "<duration>", description: "only events from this long ago, e.g. 30m, 1h, 7d" },
    lines: { type: "string", value: "<n>", description: "print at most the last n matching events (default 200; 0 for all)" },
  },
  details: "Reads the database directly, so it works whether or not the service is running. Payloads carry identifiers and states, never secrets or user-written text.",
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
      const query: EventQuery = {
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
