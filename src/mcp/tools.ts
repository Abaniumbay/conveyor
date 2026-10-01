import { AGENT_DENIED_TOOLS } from "../tasks/aliases";
import { createTaskRegistry } from "../tasks/catalogue";

/** The canonical names of every registered tool task. */
export function registeredToolNames(): string[] {
  return createTaskRegistry().list("tool").map((task) => task.name);
}

/** Every tool an agent may be granted: the registered tools minus the never-grantable ones. */
export function agentGrantableTools(): string[] {
  return registeredToolNames().filter((name) => !AGENT_DENIED_TOOLS.includes(name));
}

/** What a verifier (a read-only checker) may use: the item/change/CI/workspace/conversation getters and the report tools. */
export const MCP_VERIFIER_TOOLS: readonly string[] = [
  "item.get",
  "item.guidance",
  "workspace.get",
  "change.get",
  "ci.getLogs",
  "conversation.get",
  "agent.askQuestion",
  "agent.reportProgress",
  "agent.reportRationale",
  "agent.reportBlocker",
  "agent.reportResult",
  "agent.reportMilestone",
  "agent.recordArtifact",
];

export function verifierToolGrant(tasks: readonly string[]): string[] {
  const permitted = new Set(MCP_VERIFIER_TOOLS);
  return tasks.filter((task) => permitted.has(task));
}
