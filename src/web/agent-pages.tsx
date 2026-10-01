import type { ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";

import { dashboardCss } from "./styles";
import type { AgentProfileViewModel, AgentSummaryViewModel } from "./types";

export function agentHref(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}

function Shell({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{title} · Conveyor</title>
        <style dangerouslySetInnerHTML={{ __html: dashboardCss }} />
      </head>
      <body>
        <main class="dashboard agent-page">{children}</main>
      </body>
    </html>
  );
}

function Header({ page, parent }: { page: string; parent?: { href: string; label: string } }) {
  return (
    <header class="dashboard-header agent-page-header">
      <h1 class="wordmark"><a href="/">Conveyor</a></h1>
      <span class="agent-page-title">{page}</span>
      <nav aria-label="Page links">
        {parent && <a href={parent.href}>{parent.label}</a>}
        <a href="/">Dashboard</a>
      </nav>
    </header>
  );
}

function stageName(value: string): string {
  const acronyms = new Set(["api", "ci", "qa", "sre", "ui", "ux"]);
  return value.split(/[-_]/).filter(Boolean).map((part) => acronyms.has(part.toLowerCase())
    ? part.toUpperCase()
    : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function AgentList({ agents }: { agents: readonly AgentSummaryViewModel[] }) {
  return (
    <Shell title="Agents">
      <Header page="Agents" />
      <ul class="agent-list">
        {agents.map((agent) => (
          <li key={agent.id}><a href={agentHref(agent.id)}><strong>{agent.name}</strong> <span>{agent.title}</span></a></li>
        ))}
      </ul>
    </Shell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function AgentProfile({ agent }: { agent: AgentProfileViewModel }) {
  const stations = [...new Set(agent.usage.flatMap((use) => use.stage ? [use.stage] : []))];
  return (
    <Shell title={agent.name}>
      <Header page={agent.name} parent={{ href: "/agents", label: "Agents" }} />
      <p class="agent-title">{agent.title}</p>
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
    </Shell>
  );
}

export function renderAgentList(agents: readonly AgentSummaryViewModel[]): string {
  return `<!doctype html>${renderToString(<AgentList agents={agents} />)}`;
}

export function renderAgentProfile(agent: AgentProfileViewModel): string {
  return `<!doctype html>${renderToString(<AgentProfile agent={agent} />)}`;
}
