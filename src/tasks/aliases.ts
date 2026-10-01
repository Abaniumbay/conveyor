// Agent-callable tool names. The task registry's camelCase names are canonical; the legacy
// snake_case MCP names stay accepted in grants and calls through this one table.

export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  "source.get_issue": "item.get",
  "source.get_guidance": "item.guidance",
  "source.add_comment": "item.comment",
  "source.set_acceptance_criteria": "item.setCriteria",
  "source.set_system_labels": "item.setSystemLabels",
  "source.set_parent": "item.setParent",
  "source.set_dependencies": "item.setDependencies",
  "source.create_child": "item.createChild",
  "source.set_pull_request_metadata": "change.setMetadata",
  "workspace.get_context": "workspace.get",
  "workspace.request_fetch": "workspace.fetch",
  "workspace.request_push": "workspace.push",
  "workspace.record_artifact": "agent.recordArtifact",
  "delivery.get_state": "change.get",
  "delivery.get_check_logs": "ci.getLogs",
  "run.report_progress": "agent.reportProgress",
  "run.ask_question": "agent.askQuestion",
  "run.report_rationale": "agent.reportRationale",
  "run.report_blocker": "agent.reportBlocker",
  "run.report_result": "agent.reportResult",
  "run.report_milestone": "agent.reportMilestone",
  "run.record_artifact": "agent.recordArtifact",
};

/** Tools no agent may ever be granted, however configured (a person decides these). */
export const AGENT_DENIED_TOOLS: readonly string[] = ["change.dismissFinding"];

/** The canonical name for a canonical or legacy tool name. */
export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}
