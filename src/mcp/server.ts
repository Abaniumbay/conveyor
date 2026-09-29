import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface RunMcpContext {
  version: 1;
  runId: string;
  stageId: string;
  repository: { id: string; address: string; baseBranch: string };
  issue: {
    id: string;
    number: number;
    title: string;
    body: string;
    labels: string[];
    url: string;
  };
  workspace: { path: string; branch: string } | null;
  delivery: { pullRequest: unknown | null; checks: unknown[] };
  sourceGuidance: string;
  control: { url: string; token: string };
  allowedTools: string[];
}

export interface ControlClient {
  call(tool: string, input: unknown): Promise<unknown>;
}

export class HttpControlClient implements ControlClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(tool: string, input: unknown): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool, input }),
    });
    if (!response.ok) {
      throw new Error(`control request failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  }
}

const questionOption = z.object({ id: z.string(), label: z.string() });
const questionInput = {
  prompt: z.string().min(1),
  reason: z.string().min(1),
  options: z.array(questionOption).min(1),
  minSelections: z.number().int().min(0),
  maxSelections: z.number().int().min(1),
  allowFreeText: z.boolean(),
};

const progressInput = {
  message: z.string().min(1).max(4_000),
  details: z.record(z.string(), z.unknown()).optional(),
};

const passthroughInput = z.object({}).passthrough();

const controlTools: Record<string, { description: string; schema: z.ZodType }> = {
  "conversation.get": {
    description: "Read the concise shared issue conversation. Use it for handoffs and user steering; it does not contain raw harness logs.",
    schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  },
  "run.report_progress": { description: "Report run progress.", schema: z.object(progressInput) },
  "run.ask_question": { description: "Ask the user a structured question.", schema: z.object(questionInput) },
  "run.report_rationale": { description: "Record a rationale summary.", schema: passthroughInput },
  "run.report_blocker": { description: "Report a run blocker.", schema: passthroughInput },
  "run.report_result": { description: "Report a stage result.", schema: passthroughInput },
  "run.record_artifact": { description: "Record a run artifact.", schema: passthroughInput },
  "run.report_milestone": { description: "Report a run milestone.", schema: passthroughInput },
  "source.set_labels": { description: "Update allowed issue labels.", schema: passthroughInput },
  "source.set_system_labels": {
    description: "Replace the issue's configured system-area labels while preserving workflow and unmanaged labels.",
    schema: passthroughInput,
  },
  "source.add_comment": { description: "Add an issue comment.", schema: passthroughInput },
  "source.set_acceptance_criteria": { description: "Update acceptance criteria.", schema: passthroughInput },
  "source.set_parent": { description: "Set issue hierarchy.", schema: passthroughInput },
  "source.set_dependencies": { description: "Update issue dependencies.", schema: passthroughInput },
  "source.create_child": { description: "Create a child issue in the scoped repository.", schema: passthroughInput },
  "source.set_pull_request_metadata": { description: "Update PR metadata.", schema: passthroughInput },
  "workspace.request_fetch": { description: "Request a scoped workspace fetch.", schema: passthroughInput },
  "workspace.request_push": { description: "Request a scoped workspace push.", schema: passthroughInput },
  "workspace.record_artifact": { description: "Record a workspace artifact.", schema: passthroughInput },
};

type ReadToolName = "source.get_issue" | "source.get_guidance" | "workspace.get_context" | "delivery.get_state";

export function createConveyorMcpServer(context: RunMcpContext, control: ControlClient): McpServer {
  const server = new McpServer(
    { name: "conveyor", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const reads: Record<ReadToolName, { description: string; value: unknown }> = {
    "source.get_issue": { description: "Read the scoped source issue.", value: context.issue },
    "source.get_guidance": { description: "Read source-specific agent guidance.", value: context.sourceGuidance },
    "workspace.get_context": { description: "Read scoped workspace metadata.", value: context.workspace },
    "delivery.get_state": { description: "Read delivery state for this issue.", value: context.delivery },
  };

  const granted = new Set<string>();
  for (const name of context.allowedTools) {
    if (granted.has(name)) throw new Error(`duplicate MCP tool grant: ${name}`);
    if (!(name in reads) && !(name in controlTools)) {
      throw new Error(`unsupported MCP tool grant: ${name}`);
    }
    granted.add(name);
  }

  for (const name of context.allowedTools) {
    if (name in reads) {
      const readName = name as ReadToolName;
      const read = reads[readName];
      server.registerTool(readName, { description: read.description, inputSchema: {} }, async () => ({
        content: [{ type: "text", text: JSON.stringify(read.value) }],
      }));
      continue;
    }

    const definition = controlTools[name];
    if (!definition) continue;
    server.registerTool(name, {
      description: definition.description,
      inputSchema: definition.schema,
    }, async (input) => {
      const data = input as Record<string, unknown>;
      const result = await control.call(name, {
        ...data,
        runId: context.runId,
        stageId: context.stageId,
        repositoryId: context.repository.id,
        issueId: context.issue.id,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  }

  return server;
}
