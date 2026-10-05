import { canonicalToolName } from "../tasks/aliases";

/** Guidance must describe the same canonical grant the MCP server actually advertises. */
export function conveyorToolGuidance(grantedTools: readonly string[] = []): string {
  const names = [...new Set(grantedTools.map(canonicalToolName))];
  if (names.length === 0) return "";
  return [
    "Conveyor tool names:",
    "The names in Conveyor instructions are MCP operation names. In Codex code execution, their callable names are normalized as follows:",
    ...names.map((name) => `- ${name} → tools.mcp__conveyor__${name.replace(/[^a-zA-Z0-9_]/g, "_")}`),
    "Use the native tool interface when it is exposed directly. In Codex code execution, use the callable above or inspect its metadata in ALL_TOOLS before calling it.",
    'For broad discovery, use: text(ALL_TOOLS.filter(tool => tool.name.startsWith("mcp__conveyor__")));',
    "An empty dotted-name search does not establish that tools are unavailable. Search the Conveyor prefix and normalized names before reporting a missing tool.",
    "If a required granted tool still cannot be found, report the searches attempted and their results. If it is found but fails, report the actual call error. Do not repeat a previous run's missing-tool claim without checking the current run.",
  ].join("\n");
}
