import type { AgentProfileViewModel } from "./types";
import { AgentAvatar } from "./avatar";

export function agentHref(agentId: string): string {
  return `/team/${encodeURIComponent(agentId)}`;
}

function agentDialogId(agentId: string): string {
  return `agent-${agentId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function stageName(value: string): string {
  const acronyms = new Set(["api", "ci", "qa", "sre", "ui", "ux"]);
  return value.split(/[-_]/).filter(Boolean).map((part) => acronyms.has(part.toLowerCase())
    ? part.toUpperCase()
    : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function Fact({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function AgentProfile({ agent, id }: { agent: AgentProfileViewModel; id: string }) {
  const stations = [...new Set(agent.usage.flatMap((use) => use.stage ? [use.stage] : []))];
  return (
    <dialog class="agent-dialog" id={id} aria-labelledby={`${id}-title`} data-agent-id={agent.id}>
      <header class="details-header">
        <div class="agent-identity">
          <AgentAvatar name={agent.name} />
          <div>
            <h2 id={`${id}-title`}>{agent.name}</h2>
            <p class="agent-title">{agent.title}</p>
          </div>
        </div>
        <form method="dialog"><button class="dialog-close" aria-label={`Close ${agent.name}'s profile`}>×</button></form>
      </header>
      <nav class="mini-line" aria-label={`${agent.name}'s stations`}>
        <h2>Stations</h2>
        {stations.length > 0
          ? <ol>{stations.map((stage) => <li key={stage}><span>{stageName(stage)}</span></li>)}</ol>
          : <p>No pipeline stations assigned.</p>}
      </nav>
      <section class="agent-section" aria-labelledby="agent-config">
        <h2 id="agent-config">Configuration</h2>
        <dl class="agent-facts">
          <Fact label="Id" value={agent.id} />
          <Fact label="Harness" value={agent.harness} />
          <Fact label="Model" value={agent.model ?? "Harness default"} />
          <Fact label="Effort" value={agent.effort ?? "Harness default"} />
          <Fact label="Workspace access" value={agent.access} />
        </dl>
      </section>
      <section class="agent-section" aria-labelledby="agent-usage">
        <h2 id="agent-usage">Where it works</h2>
        {agent.usage.length === 0
          ? <p>Not used by any pipeline stage.</p>
          : <ul>{agent.usage.map((use) => (
              <li key={`${use.pipeline}:${use.stage}:${use.role}`}>
                {use.pipeline ? <><strong>{use.pipeline}</strong> / {use.stage}: </> : null}{use.role}
              </li>
            ))}</ul>}
      </section>
      <section class="agent-section" aria-labelledby="agent-tasks">
        <h2 id="agent-tasks">Granted tools</h2>
        {agent.tasks.length === 0
          ? <p>No tools are granted.</p>
          : <dl class="agent-facts">{agent.tasks.map((group) => (
              <Fact key={group.group} label={group.group} value={group.tasks.join(", ")} />
            ))}</dl>}
      </section>
      <section class="agent-section" aria-labelledby="agent-instructions">
        <h2 id="agent-instructions">Instructions</h2>
        {agent.instructions === null
          ? <p>Instructions could not be read.</p>
          : <pre class="agent-instructions">{agent.instructions}</pre>}
      </section>
    </dialog>
  );
}

export function Team({ agents }: { agents: readonly AgentProfileViewModel[] }) {
  if (agents.length === 0) return <section class="team"><p class="team-empty">No agents are configured.</p></section>;
  return (
    <section class="team" aria-label="Team">
      <ul class="team-list">
        {agents.map((agent) => {
          const id = agentDialogId(agent.id);
          const stations = [...new Set(agent.usage.flatMap((use) => use.stage ? [use.stage] : []))];
          return (
            <li key={agent.id}>
              <article class="team-card" data-dialog-open={id} tabIndex={0} aria-haspopup="dialog" aria-label={`Open ${agent.name}'s profile`}>
                <div class="agent-identity">
                  <AgentAvatar name={agent.name} />
                  <div><h3>{agent.name}</h3><p class="team-card-title">{agent.title}</p></div>
                </div>
                <p class="team-card-meta">{stations.length > 0 ? stations.map(stageName).join(", ") : agent.usage[0]?.role ?? "No stations"} · {agent.model ?? agent.harness}</p>
                <AgentProfile agent={agent} id={id} />
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
