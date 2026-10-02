/** A stable, friendly monogram avatar without external image assets. */
export function AgentAvatar({ name, script = false }: { name: string; script?: boolean }) {
  const initials = script
    ? "{}"
    : name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("") || "A";
  let hash = 0;
  for (const character of name) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const palette = Math.abs(hash) % 6 + 1;
  return (
    <span
      class={`agent-avatar ${script ? "agent-avatar--script" : `agent-avatar--${palette}`}`}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
