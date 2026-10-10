// The CLI's side of the local control interface (src/control/server.ts).

import { statSync } from "node:fs";
import net from "node:net";
import { userInfo } from "node:os";

import { CliError, EXIT } from "./args";
import type { CommandContext } from "./command";

export class ServiceUnavailable extends CliError {
  /** `reason` is set when the socket exists but cannot be used (for example, another account owns it). */
  constructor(readonly socket: string, readonly reason?: string) {
    super(
      reason
        ? `cannot reach Conveyor at ${socket}: ${reason}. ${reason === "permission denied" ? "Run the command as the account that runs Conveyor (or with sudo)." : "See conveyor service status."}`
        : `Conveyor is not running for this home (no control socket at ${socket}). Start it with conveyor service start or conveyor serve.`,
      EXIT.unavailable,
    );
  }
}

function caller(): string {
  try {
    return userInfo().username;
  } catch {
    return "operator";
  }
}

/** Why the socket cannot be used, or undefined when there is none (the service is not running). */
async function unreachableReason(socket: string): Promise<string | undefined> {
  try {
    statSync(socket);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES" ? "permission denied" : undefined;
  }
  // Bun's fetch reports every failure alike; a plain connection tells them apart.
  const code = await new Promise<string>((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => { probe.destroy(); resolve("connected"); });
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
  if (code === "ECONNREFUSED") return "nothing is listening (the service stopped without removing its socket)";
  if (code === "EACCES") return "permission denied";
  return code === "connected" ? "the service did not answer" : code;
}

/** Calls the running service; refusals exit 5, a missing item 1, an unreachable service 4. */
export async function control<T>(context: CommandContext, method: "GET" | "POST" | "DELETE", route: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://conveyor${route}`, {
      unix: context.paths.controlSocket,
      method,
      headers: { "content-type": "application/json", "x-conveyor-actor": caller() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new ServiceUnavailable(context.paths.controlSocket, await unreachableReason(context.paths.controlSocket));
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
