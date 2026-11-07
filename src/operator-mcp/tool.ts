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
  /** Finds an item by `<repository>:<number>`; null when Conveyor does not know it. */
  findItem(reference: string): { issueId: string; running: boolean } | null;
  /** Sends a command as the operator MCP client. */
  dispatch<N extends CommandName>(name: N, input: CommandInput<N>): ReturnType<CommandBus["dispatch"]>;
}

export interface OperatorToolContext<I> {
  input: I;
  facade: OperatorFacade;
}

/** A tool as authored: its handler receives the input typed by its own schema. */
export interface OperatorToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  handler(context: OperatorToolContext<z.infer<S>>): unknown | Promise<unknown>;
}

/** A tool as registered: the handler takes unvalidated input and validates it against the schema. */
export interface OperatorTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  handler(context: OperatorToolContext<unknown>): unknown | Promise<unknown>;
}

/** One operator MCP tool; register it with one line in `registry.ts`. */
export const defineOperatorTool = <S extends z.ZodObject>(tool: OperatorToolDefinition<S>): OperatorTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  handler: ({ input, facade }) => tool.handler({ input: tool.inputSchema.parse(input), facade }),
});
