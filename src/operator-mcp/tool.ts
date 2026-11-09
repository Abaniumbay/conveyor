import type { z } from "zod";

import type { ConveyorStore } from "../db/store";
import type { CommandBus } from "../commands/bus";
import type { CommandInput, CommandName } from "../commands/registry";

/**
 * What an operator tool may reach: read-only service state and the command bus. A tool never sees
 * an HTTP request, and a write goes through `dispatch`, as every other action does.
 */
export type OperatorReadStore = Pick<ConveyorStore,
  | "listRepositories" | "listIssues" | "getIssue" | "getIssueByNumber" | "listDependencies" | "listChildren"
  | "listConversationMessages" | "getCurrentPullRequest" | "listIndicators" | "criterionTestEvidence"
  | "listOpenQuestions" | "listIssueRuns">;

export interface OperatorFacade {
  /** Read-only view of Conveyor's stored state. */
  store: OperatorReadStore;
  /** The service status, as `conveyor status` reports it. */
  status(): unknown;
  /** Finds an item by `<repository>:<number>`; null when Conveyor does not know it. */
  findItem(reference: string): { issueId: string; running: boolean } | null;
  /** Creates and enrolls an issue in an onboarded repository. Not a command: only the operator MCP offers it. */
  createIssue(input: { repository: string; title: string; body: string; idempotencyKey?: string | undefined }): Promise<{ issueId: string; number: number; url: string }>;
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
