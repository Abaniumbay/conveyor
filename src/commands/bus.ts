// The one way in for an action: validate, authorize, run its handler inside a correlation scope and
// record whether it succeeded. The dashboard and the control socket only translate requests into
// commands and results into responses.

import type { EventLog } from "../events/log";
import { newCorrelationId, withEventContext } from "../events/context";
import { log } from "../log/logger";
import { withGitHubCallSource } from "../source/github/call-meter";
import { COMMANDS, type CommandInput, type CommandName, type CommandRole } from "./registry";

/** What each command returns to the dashboard or the CLI. */
export interface CommandResults {
  "item.retry": { status: "started" | "queued"; stageId: string };
  "item.resumeRollup": { stageId: string };
  "item.pause": { stageId: string | null };
  "item.resume": { status: "started" | "queued"; stageId: string | null };
  "item.postMessage": unknown;
  "question.answer": void;
  "gate.approve": void;
  "gate.setItemApproval": void;
  "finding.dismiss": void;
  "backlog.reorder": void;
  "backlog.move": void;
  "steering.start": string;
  "account.create": { id: string; username: string; role: "superuser" | "user"; avatar: string };
  "account.setPassword": void;
  "account.delete": "deleted" | "not_found" | "superuser";
  "account.setAvatar": void;
  "notifications.updateSettings": void;
  "notifications.subscribe": void;
  "notifications.unsubscribe": void;
  "repository.sync": { issues: number; failed: boolean };
  "repository.pause": { pausedAt: string };
  "repository.resume": { resumedAt: string };
  "admission.drain": { since: string; reason: string };
  "admission.resume": boolean;
  "service.restart": void;
  "service.cleanup": unknown;
  "release.schedule": unknown;
  "release.cancel": unknown;
}

// Every command has a result type and every result type a command.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const exhaustive: Exact<keyof CommandResults, CommandName> = true;
void exhaustive;

/** Who sends a command: a signed-in dashboard account or the CLI on the control socket. */
export interface CommandActor {
  kind: "user" | "cli";
  /** The dashboard account id; null for the CLI. */
  id: string | null;
  /** The name recorded on what the command changes (an answer, a journey entry). */
  name: string;
  role: CommandRole;
}

export type CommandHandler<N extends CommandName> = (input: CommandInput<N>, actor: CommandActor) => CommandResults[N] | Promise<CommandResults[N]>;

export interface CommandOutcome<N extends CommandName> {
  correlationId: string;
  result: CommandResults[N];
}

/** The input does not match the command's schema. */
export class CommandInputError extends Error {
  override readonly name = "CommandInputError";
}

/** The actor may not send the command. */
export class CommandForbiddenError extends Error {
  override readonly name = "CommandForbiddenError";
}

/** No handler is registered for the command in this process. */
export class CommandUnavailableError extends Error {
  override readonly name = "CommandUnavailableError";
}

const REASON_LIMIT = 300;

export class CommandBus {
  /** Handlers with their input type erased; the bus validates input against the same command's schema. */
  readonly #handlers = new Map<CommandName, (input: unknown, actor: CommandActor) => unknown>();

  constructor(private readonly events: EventLog) {}

  /** Registers the handler of a command; a command has exactly one. */
  handle<N extends CommandName>(name: N, handler: CommandHandler<N>): void {
    if (this.#handlers.has(name)) throw new Error(`command ${name} already has a handler`);
    this.#handlers.set(name, (input, actor) => handler(input as CommandInput<N>, actor));
  }

  has(name: CommandName): boolean {
    return this.#handlers.has(name);
  }

  /**
   * Runs one command. Every event its handler causes carries the returned correlation id; the
   * handler's own error is rethrown unchanged after `command.rejected` is recorded.
   */
  async dispatch<N extends CommandName>(name: N, input: CommandInput<N>, actor: CommandActor): Promise<CommandOutcome<N>> {
    const correlationId = newCorrelationId();
    return withEventContext({ actor: { kind: actor.kind, id: actor.id }, correlationId }, () => withGitHubCallSource("command", async () => {
      const reject = (error: Error): never => {
        const reason = error.message.slice(0, REASON_LIMIT) || error.name;
        this.events.append("command.rejected", { command: name, reason });
        log.info("Command rejected", { command: name, actor: actor.name, reason });
        throw error;
      };
      const definition = COMMANDS[name];
      const parsed = definition.input.safeParse(input);
      if (!parsed.success) return reject(new CommandInputError(`invalid ${name} input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`));
      if (definition.role === "superuser" && actor.role !== "superuser") return reject(new CommandForbiddenError(`${name} requires a superuser`));
      const handler = this.#handlers.get(name);
      if (!handler) return reject(new CommandUnavailableError(`${name} is unavailable`));
      let result: CommandResults[N];
      try {
        // The handler registered under `name` returns that command's result.
        result = await handler(parsed.data, actor) as CommandResults[N];
      } catch (error) {
        return reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.events.append("command.accepted", { command: name });
      return { correlationId, result };
    }));
  }
}
