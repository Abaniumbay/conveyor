import type { z } from "zod";

import type { CommandBus } from "../commands/bus";
import type { CommandInput, CommandName } from "../commands/registry";

/**
 * What an operator tool may reach: read-only service state and the command bus. A tool never sees
 * an HTTP request, and a write goes through `dispatch`, as every other action does.
 */
export interface OperatorFacade {
  /** The service status, as `conveyor status` reports it. */
  status(): unknown;
  /** Sends a command as the operator MCP client. */
  dispatch<N extends CommandName>(name: N, input: CommandInput<N>): ReturnType<CommandBus["dispatch"]>;
}

export interface OperatorToolContext<I> {
  input: I;
  facade: OperatorFacade;
}

/** One operator MCP tool; register it with one line in `registry.ts`. */
export interface OperatorTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  handler(context: OperatorToolContext<z.infer<S>>): unknown | Promise<unknown>;
}

export const defineOperatorTool = <S extends z.ZodObject>(tool: OperatorTool<S>): OperatorTool => tool as unknown as OperatorTool;
