// The CLI's side of the local control interface (src/control/server.ts).

import { userInfo } from "node:os";

import { CliError, EXIT } from "./args";
import type { CommandContext } from "./command";

export class ServiceUnavailable extends CliError {
  constructor(socket: string) {
    super(`Conveyor is not running for this home (no control socket at ${socket}). Start it with conveyor service start or conveyor serve.`, EXIT.unavailable);
  }
}

function caller(): string {
  try {
    return userInfo().username;
  } catch {
    return "operator";
  }
}

/** Calls the running service; refusals exit 5, a missing item 1, an unreachable service 4. */
export async function control<T>(context: CommandContext, method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://conveyor${route}`, {
      unix: context.paths.controlSocket,
      method,
      headers: { "content-type": "application/json", "x-conveyor-actor": caller() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ServiceUnavailable(context.paths.controlSocket);
  }
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.ok) return payload;
  const message = payload.error ?? `the service answered ${response.status}`;
  if (response.status === 409) throw new CliError(message, EXIT.rejected);
  if (response.status === 400) throw new CliError(message, EXIT.usage);
  throw new CliError(message, EXIT.failure);
}

/** True when the service answers on its control socket. */
export async function serviceRunning(context: CommandContext): Promise<boolean> {
  return control(context, "GET", "/v1/status").then(() => true, () => false);
}
