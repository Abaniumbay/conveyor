import { canonicalToolName } from "../tasks/aliases";

/** A harness's own lines about how its agent sees Conveyor's tools, given the granted canonical names. */
export type ToolNameGuidance = (names: readonly string[]) => readonly string[];

/**
 * Guidance must describe the same canonical grant the MCP server actually advertises. The harness
 * adds what only its agents need, such as the names its code execution calls the tools by.
 */
export function conveyorToolGuidance(grantedTools: readonly string[] = [], toolNameGuidance?: ToolNameGuidance): string {
  const names = [...new Set(grantedTools.map(canonicalToolName))];
  if (names.length === 0) return "";
  const descriptionGuidance = names.includes("change.setMetadata")
    ? [
      "Use change.setMetadata's description to explain the pull request itself. Criteria that require a statement in the pull request can be met by writing that statement there.",
    ]
    : [];
  return [
    "Conveyor tool names:",
    `The names in Conveyor instructions are MCP operation names of the conveyor server. This run is granted: ${names.join(", ")}.`,
    "Use the native tool interface when it is exposed directly.",
    ...(toolNameGuidance?.(names) ?? []),
    "An empty dotted-name search does not establish that tools are unavailable. Search the Conveyor prefix and normalized names before reporting a missing tool.",
    "If a required granted tool still cannot be found, report the searches attempted and their results. If it is found but fails, report the actual call error. Do not repeat a previous run's missing-tool claim without checking the current run.",
    ...descriptionGuidance,
  ].join("\n");
}
