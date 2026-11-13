/**
 * How Codex shows Conveyor's tools to its agent: in code execution each MCP tool is a callable whose
 * name is normalized, so the agent gets the mapping and how to discover them.
 */
export function codexToolNameGuidance(names: readonly string[]): string[] {
  return [
    "In Codex code execution, the callable names of these tools are normalized as follows:",
    ...names.map((name) => `- ${name} → tools.mcp__conveyor__${name.replace(/[^a-zA-Z0-9_]/g, "_")}`),
    "In Codex code execution, use the callable above or inspect its metadata in ALL_TOOLS before calling it.",
    'For broad discovery, use: text(ALL_TOOLS.filter(tool => tool.name.startsWith("mcp__conveyor__")));',
  ];
}
