export const MCP_READ_TOOLS = [
  "source.get_issue",
  "source.get_guidance",
  "workspace.get_context",
  "delivery.get_state",
] as const;

export const MCP_REPORT_TOOLS = [
  "run.report_progress",
  "run.ask_question",
  "run.report_rationale",
  "run.report_blocker",
  "run.report_result",
  "run.record_artifact",
  "run.report_milestone",
] as const;

export const MCP_MUTATION_TOOLS = [
  "source.set_labels",
  "source.set_system_labels",
  "source.add_comment",
  "source.set_acceptance_criteria",
  "source.set_parent",
  "source.set_dependencies",
  "source.create_child",
  "source.set_pull_request_metadata",
  "workspace.request_fetch",
  "workspace.request_push",
  "workspace.record_artifact",
] as const;

export const MCP_AGENT_TOOLS = [
  ...MCP_READ_TOOLS,
  ...MCP_REPORT_TOOLS,
  ...MCP_MUTATION_TOOLS,
] as const;

export const MCP_VERIFIER_TOOLS = [
  ...MCP_READ_TOOLS,
  ...MCP_REPORT_TOOLS,
] as const;

export type McpAgentTool = (typeof MCP_AGENT_TOOLS)[number];

export function verifierToolGrant(tools: readonly McpAgentTool[]): McpAgentTool[] {
  const permitted = new Set<McpAgentTool>(MCP_VERIFIER_TOOLS);
  return tools.filter((tool) => permitted.has(tool));
}
