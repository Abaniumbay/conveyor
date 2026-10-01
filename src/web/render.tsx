import { Fragment, type ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";

import { agentHref } from "./agent-pages";
import { renderSafeMarkdown } from "./markdown";
import { dashboardCss } from "./styles";
import type {
  DashboardView,
  DashboardViewModel,
  IssueCardViewModel,
  IssueRelationViewModel,
  StageColumnViewModel,
} from "./types";

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function issueHref(issueId: string): string {
  return `/?${new URLSearchParams({ issue: issueId })}`;
}

function stationId(value: string): string {
  return `station-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function LocalTime({ value }: { value: string }) {
  return <time dateTime={value} data-local-time>…</time>;
}

function LocalClock({ value }: { value: string }) {
  return <time dateTime={value} data-local-clock>…</time>;
}

function Markdown({ text }: { text: string }) {
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(text) }} />;
}

function RelationLink({ relation, showCompletion = false }: { relation: IssueRelationViewModel; showCompletion?: boolean }) {
  const completed = showCompletion && relation.satisfied;
  return <a class={completed ? "relation-link--satisfied" : undefined} href={issueHref(relation.id)}>{relation.repository}:#{relation.number} {relation.title}</a>;
}

function Relationships({ issue }: { issue: IssueCardViewModel }) {
  if (!issue.parent && issue.children.length === 0 && issue.dependencies.length === 0) return null;
  return (
    <section class="relationships" aria-label={`Issue relationships for #${issue.number}`}>
      {issue.parent && <p><strong>Parent:</strong> <RelationLink relation={issue.parent} /></p>}
      {issue.dependencies.length > 0 && (
        <div>
          <strong>Blocked by:</strong>
          <ul>{issue.dependencies.map((dependency) => <li key={dependency.number}><RelationLink relation={dependency} showCompletion /></li>)}</ul>
        </div>
      )}
      {issue.children.length > 0 && (
        <div>
          <strong>Children:</strong>
          <ul>{issue.children.map((child) => <li key={child.number}><RelationLink relation={child} /></li>)}</ul>
        </div>
      )}
    </section>
  );
}

function RelationshipSummary({ issue }: { issue: IssueCardViewModel }) {
  const waiting = issue.dependencies.filter((dependency) => !dependency.satisfied);
  if (waiting.length === 0) return null;
  return (
    <div class="relation-summary" aria-label={`Relationship summary for #${issue.number}`}>
      <span class="relation-group relation-group--blocked">
        Waiting on {waiting.map((dependency, index) => (
          <Fragment key={dependency.number}>{index > 0 && ", "}<a href={issueHref(dependency.id)}>#{dependency.number}</a></Fragment>
        ))}
      </span>
    </div>
  );
}

function DetailsDialog({ issue, id, selected = false }: { issue: IssueCardViewModel; id: string; selected?: boolean }) {
  const url = safeUrl(issue.url);
  const summaryId = `${id}-summary`;
  const conversationId = `${id}-conversation`;
  const journeyId = `${id}-journey`;
  const activityId = `${id}-activity`;
  return (
    <dialog class="issue-details issue-inspector" id={id} aria-labelledby={`${id}-title`} data-issue-id={issue.id} data-selected-issue={selected ? "true" : undefined}>
      <header class="details-header">
        <div>
          <p class="details-kicker">{issue.repository}:#{issue.number}</p>
          <h2 id={`${id}-title`}>{issue.title}</h2>
        </div>
        <div class="details-header-actions">
          <form method="dialog"><button class="dialog-close" aria-label="Close issue details">×</button></form>
        </div>
      </header>
      <nav class="details-tabs" aria-label="Issue detail sections" role="tablist">
        <button type="button" role="tab" id={`${summaryId}-tab`} aria-controls={summaryId} aria-selected="true" data-detail-tab="summary">Summary</button>
        <button type="button" role="tab" id={`${conversationId}-tab`} aria-controls={conversationId} aria-selected="false" data-detail-tab="conversation">Conversation</button>
        <button type="button" role="tab" id={`${journeyId}-tab`} aria-controls={journeyId} aria-selected="false" data-detail-tab="journey">Journey</button>
        <button type="button" role="tab" id={`${activityId}-tab`} aria-controls={activityId} aria-selected="false" data-detail-tab="activity">Technical logs</button>
      </nav>
      <section id={summaryId} role="tabpanel" aria-labelledby={`${summaryId}-tab`} data-detail-panel="summary">
        <div class="details-status">
          <span class={`andon andon--${issueSignal(issue)}`} aria-hidden="true" />
          <strong>{issue.waiting ? "Waiting" : stateWords(issue)}</strong>
          {issue.children.length > 0 && <span>· Roll-up</span>}
          {issue.closable && <span>· Closable</span>}
        </div>
        {issue.waiting && <WaitingLine issue={issue} className="waiting-detail" />}
        <dl class="details-facts">
          {issue.activity && <Fragment><dt>Current step</dt><dd>{issue.activity}</dd></Fragment>}
          {issue.reason && <Fragment><dt>Source note</dt><dd>{issue.reason}</dd></Fragment>}
          {issue.cost && <Fragment><dt>Usage</dt><dd>{issue.cost}</dd></Fragment>}
          {issue.duration && <Fragment><dt>Duration</dt><dd>{issue.duration}</dd></Fragment>}
        </dl>
        <Relationships issue={issue} />
        <section class="criteria" aria-label="Acceptance criteria">
          <h3>Acceptance criteria</h3>
          {issue.acceptanceCriteria.length > 0
            ? <ul class="criteria-list">{issue.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
            : <p class="details-empty">No acceptance criteria recorded.</p>}
        </section>
        {issue.labels.length > 0 && (
          <section class="source-labels" aria-label="Source labels">
            <h3>Source labels</h3>
            <div>{issue.labels.map((label) => <span class="source-label" key={label}>{label}</span>)}</div>
          </section>
        )}
        {url && <p class="details-source"><a href={url} target="_blank" rel="noopener noreferrer">Open issue source ↗</a></p>}
      </section>
      <section
        id={conversationId}
        role="tabpanel"
        aria-labelledby={`${conversationId}-tab`}
        data-detail-panel="conversation"
        data-conversation-url={`/api/issues/${encodeURIComponent(issue.id)}/conversation`}
        hidden
      >
        <p class="conversation-status" data-conversation-status>Open Conversation to load the shared handoff.</p>
        <ol class="conversation-messages" data-conversation-messages />
        <form class="conversation-compose" data-conversation-form>
          <label for={`${conversationId}-message`}>Message to the current or next agent</label>
          <textarea id={`${conversationId}-message`} name="message" rows={3} maxLength={4000} required placeholder="Add context or steer the work…" />
          <div class="conversation-compose-actions">
            <span>Shared with the next run.</span>
            <button type="submit">Send</button>
          </div>
        </form>
      </section>
      <section
        id={journeyId}
        role="tabpanel"
        aria-labelledby={`${journeyId}-tab`}
        data-detail-panel="journey"
        data-journey-url={`/api/issues/${encodeURIComponent(issue.id)}/journey`}
        hidden
      >
        <p class="journey-status" data-journey-status>Open Journey to load the stage history.</p>
        <ol class="journey-list" data-journey-list />
      </section>
      <section
        id={activityId}
        role="tabpanel"
        aria-labelledby={`${activityId}-tab`}
        data-detail-panel="activity"
        data-activity-url={`/api/issues/${encodeURIComponent(issue.id)}/activity`}
        hidden
      >
        <p class="activity-status" data-activity-status>Open Technical logs to load the persisted run log.</p>
        <div data-activity-runs />
      </section>
    </dialog>
  );
}

function RelativeTime({ value }: { value: string }) {
  return <time dateTime={value} data-relative-time>recently</time>;
}

function WaitingLine({ issue, className }: { issue: IssueCardViewModel; className?: string }) {
  const waiting = issue.waiting;
  if (!waiting) return null;
  return (
    <p class={className}>
      <span>{waiting.reason}</span> · for <RelativeTime value={waiting.since} />
      {waiting.nextCheckAt && <> · next check <LocalClock value={waiting.nextCheckAt} /></>}
      {waiting.deadline && <> · gives up <LocalClock value={waiting.deadline} /></>}
    </p>
  );
}

function stateWords(issue: IssueCardViewModel): string {
  if (issue.working) return "Working";
  const words: Record<string, string> = {
    active: "Queued",
    blocked: "Blocked",
    closed: "Closed",
    completed: "Done",
    done: "Done",
    error: "Stopped",
    inconsistent: "Needs attention",
    "in-progress": "Working",
    in_progress: "Working",
    "needs-input": "Needs input",
    "needs-intervention": "Needs intervention",
    paused: "Waiting",
  };
  return words[issue.state] ?? issue.state.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function IssueCard({ issue, actors = [] }: { issue: IssueCardViewModel; actors?: StageColumnViewModel["actors"] }) {
  const dialogId = `issue-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${issue.number}`;
  const rollup = issue.children.length > 0;
  const completedChildren = issue.children.filter((child) => child.satisfied).length;
  const statusContext = issue.waiting
    ? null
    : issue.working && actors[0]
    ? actors[0].name
    : (issue.tone === "danger" || issue.tone === "warning")
      ? issue.reason ?? issue.activity
      : null;
  return (
    <article
      class={`issue issue--${issue.tone}${issue.working ? " issue--working" : ""}${rollup ? " issue--rollup" : ""}`}
      data-issue-id={issue.id}
      data-dialog-open={dialogId}
      tabIndex={0}
      aria-label={`Open details for issue #${issue.number}`}
      aria-haspopup="dialog"
    >
      <p class="issue-kicker">{issue.repository}:#{issue.number}</p>
      <h3 class="issue-title">{issue.title}</h3>
      <p class="issue-status">
        <span class={`andon andon--${issueSignal(issue)}`} aria-hidden="true" />
        <strong>{issue.waiting ? "Waiting" : stateWords(issue)}</strong>
        {statusContext && <> · <span>{statusContext}</span></>}
        {!issue.waiting && issue.stateChangedAt && <> · <RelativeTime value={issue.stateChangedAt} /></>}
      </p>
      {issue.waiting && <WaitingLine issue={issue} className="issue-waiting" />}
      <RelationshipSummary issue={issue} />
      {rollup && <p class="rollup-summary">Roll-up · {issue.children.length} {issue.children.length === 1 ? "child" : "children"}, {completedChildren} done</p>}
      <DetailsDialog issue={issue} id={dialogId} />
    </article>
  );
}

function pageHref(view: DashboardView, column: string, page: number): string {
  return `/?${new URLSearchParams({ view, column, page: String(page) })}`;
}

function Pagination({ column, view }: { column: StageColumnViewModel; view: DashboardView }) {
  if (column.totalPages <= 1) return null;
  return (
    <nav class="pagination" aria-label={`${column.name} pages`}>
      {column.page > 1
        ? <a href={pageHref(view, column.id, column.page - 1)} rel="prev">Previous</a>
        : <span aria-disabled="true">Previous</span>}
      <span>Page {column.page} of {column.totalPages}</span>
      {column.page < column.totalPages
        ? <a href={pageHref(view, column.id, column.page + 1)} rel="next">Next</a>
        : <span aria-disabled="true">Next</span>}
    </nav>
  );
}

function StageColumn({ column }: { column: StageColumnViewModel }) {
  const headingId = `stage-${column.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const rollupParents = column.issues.filter((issue) => issue.children.length > 0);
  const regularIssues = column.issues.filter((issue) => issue.children.length === 0);
  const issueList = (issues: readonly IssueCardViewModel[]) => (
    <ol class="issue-list">{issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={column.actors} /></li>)}</ol>
  );
  return (
    <section class={`stage${column.issues.length === 0 ? " stage--empty" : ""}`} id={stationId(column.id)} aria-labelledby={headingId}>
      <header class="stage-heading">
        <div class="stage-identity">
          <h2 id={headingId}>{column.name}</h2>
          {column.actors.length > 0 && (
            <p>{column.actors.map((actor, index) => (
              <Fragment key={`${actor.type}:${actor.name}:${actor.title ?? ""}`}>
                {index > 0 && " · "}
                <strong>{actor.name}</strong>{actor.title && <> ({actor.title})</>}
              </Fragment>
            ))}</p>
          )}
        </div>
        <div class="stage-summary">
          {column.cost && <span class="stage-cost">{column.cost}</span>}
          <span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span>
        </div>
      </header>
      {column.issues.length > 0
        ? rollupParents.length > 0
          ? <Fragment>
              <section class="stage-group stage-group--rollups" aria-label="Roll-up parents">
                <h3>Roll-up parents</h3>
                {issueList(rollupParents)}
              </section>
              {regularIssues.length > 0 && (
                <section class="stage-group" aria-label="Issues">
                  <h3>Issues</h3>
                  {issueList(regularIssues)}
                </section>
              )}
            </Fragment>
          : issueList(regularIssues)
        : <p class="empty">No issues in this stage</p>}
      <Pagination column={column} view="board" />
    </section>
  );
}

function NeedsYou({ model }: { model: DashboardViewModel }) {
  const questionIssueIds = new Set(model.questions.map((question) => question.issueId));
  const stopped = model.needsYou.filter((issue) => !questionIssueIds.has(issue.id));
  const total = model.questions.length + stopped.length;
  if (total === 0) return null;
  return (
    <section class="needs-you" aria-labelledby="needs-you-heading">
      <header><h2 id="needs-you-heading">Needs you <span>({total})</span></h2></header>
      <ol>
        {stopped.map((issue) => (
          <li class="needs-you-item" key={issue.id}>
            <span class="andon andon--stop" aria-hidden="true" />
            <div>
              <h3>#{issue.number} {issue.title}</h3>
              <p>{issue.reason ?? issue.activity ?? `${issue.state.replaceAll("-", " ")} needs intervention`}</p>
            </div>
            <a class="needs-you-action" href={issueHref(issue.id)}>Open</a>
          </li>
        ))}
        {model.questions.map((question, questionIndex) => (
          <li class="needs-you-item needs-you-item--question" key={question.id}>
            <span class="needs-you-question" aria-hidden="true">?</span>
            <div>
              <h3>#{question.issueNumber} {question.prompt}</h3>
              <p>{question.reason}</p>
            </div>
            <form method="post" action={`/questions/${encodeURIComponent(question.id)}/answer`}>
              <input type="hidden" name="csrf" value={model.csrfToken} />
              {question.allowFreeText ? (
                <Fragment>
                  <label class="free-text">Your answer<input name="answer" list={`question-options-${questionIndex}`} required /></label>
                  <datalist id={`question-options-${questionIndex}`}>
                    {question.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                  </datalist>
                </Fragment>
              ) : question.options.map((option, optionIndex) => (
                <label class="option" key={option.id}>
                  <input type="radio" name="answer" value={option.id} required={optionIndex === 0} /> {option.label}
                </label>
              ))}
              <button class="answer-button" type="submit">Answer</button>
            </form>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Navigation({ model }: { model: DashboardViewModel }) {
  const tabs: Array<{ view: DashboardView; label: string; count: number | null }> = [
    { view: "board", label: "Board", count: model.counts.board },
    { view: "attention", label: "Needs attention", count: model.counts.attention },
    { view: "agent", label: "Operator", count: null },
  ];
  return (
    <nav class="tabs" aria-label="Dashboard views">
      {tabs.map((tab) => (
        <a href={`/?view=${tab.view}`} class={model.view === tab.view ? "tab tab--active" : "tab"} aria-current={model.view === tab.view ? "page" : undefined} key={tab.view}>
          {tab.label}{tab.count !== null && <span class="tab-count">{tab.count}</span>}
        </a>
      ))}
    </nav>
  );
}

function AgentPanel({ model }: { model: DashboardViewModel }) {
  const steering = model.steering;
  const selected = steering.selected;
  const running = selected?.status === "running";
  return (
    <section class="agent-panel" data-steering-run={running ? selected.id : undefined}>
      <header class="section-heading agent-heading">
        <div>
          <h2>Operator</h2>
          <p>{steering.enabled ? `Connected to ${steering.agent}. Ask the operator to inspect or change the system.` : "No operator is configured."}</p>
        </div>
        {selected && <span class={`run-status run-status--${selected.status}`}>{selected.status}</span>}
      </header>
      <div class="agent-layout">
        <div class="agent-main">
          <ol class="agent-events" id="steering-events" data-next-sequence={(selected?.events.at(-1)?.sequence ?? 0) + 1} aria-live="polite">
            {selected?.events.map((event) => (
              <li class={`agent-event agent-event--${event.type}`} data-sequence={event.sequence} key={event.sequence}>
                <span class="agent-event-role">{event.type === "user" ? "You" : event.type === "report" ? "Report" : "Operator"}</span>
                <Markdown text={event.text} />
                <LocalTime value={event.createdAt} />
              </li>
            ))}
          </ol>
          {!selected && <p class="agent-empty">No conversation yet. Send a concrete request below.</p>}
          <form class="agent-compose" method="post" action="/steering">
            <input type="hidden" name="csrf" value={model.csrfToken} />
            <label for="steering-prompt">Request</label>
            <textarea id="steering-prompt" name="prompt" maxLength={12000} rows={5} required disabled={!steering.enabled || running} placeholder="For example: inspect why issue #152 is blocked and fix any clear Conveyor configuration problem." />
            <div class="compose-actions">
              <span>{running ? "Wait for the current agent to finish." : "The final response is retained as a report."}</span>
              <button type="submit" disabled={!steering.enabled || running}>Send to operator</button>
            </div>
          </form>
        </div>
        {steering.recent.length > 0 && (
          <aside class="agent-history" aria-label="Recent operator runs">
            <h3>Recent</h3>
            <ol>{steering.recent.map((run) => <li key={run.id}><a href={`/?view=agent&run=${encodeURIComponent(run.id)}`} class={selected?.id === run.id ? "history-active" : undefined}><LocalTime value={run.startedAt} /><small>{run.status}</small></a></li>)}</ol>
          </aside>
        )}
      </div>
    </section>
  );
}

function BacklogColumn({ model }: { model: DashboardViewModel }) {
  return (
    <section class={`stage stage--backlog${model.backlog.length === 0 ? " stage--empty" : ""}`} id={stationId("backlog")} aria-labelledby="backlog-heading">
      <header class="stage-heading stage-heading--simple"><h2 id="backlog-heading">Backlog</h2><span class="count" aria-label={`${model.backlog.length} issues`}>{model.backlog.length}</span></header>
      {model.backlog.length > 0 ? (
        <ol class="issue-list" data-backlog-list>
          {model.backlog.map((issue, index) => (
            <li class="backlog-row" key={issue.id} data-backlog-id={issue.id} draggable>
              <IssueCard issue={issue} />
              <div class="reorder" role="group" aria-label={`Reorder issue #${issue.number}`}>
                {(["up", "down"] as const).map((direction) => {
                  const disabled = direction === "up" ? index === 0 : index === model.backlog.length - 1;
                  return (
                    <form method="post" action="/backlog/reorder" key={direction}>
                      <input type="hidden" name="csrf" value={model.csrfToken} />
                      <input type="hidden" name="issueId" value={issue.id} />
                      <input type="hidden" name="direction" value={direction} />
                      <button type="submit" aria-label={`Move #${issue.number} ${direction}`} disabled={disabled}>{direction === "up" ? "↑" : "↓"}</button>
                    </form>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      ) : <p class="empty">No issues waiting to start</p>}
    </section>
  );
}

function DoneColumn({ model }: { model: DashboardViewModel }) {
  const column = model.done;
  const remaining = column.totalIssues - column.issues.length;
  const increment = Math.min(20, remaining);
  return (
    <section class={`stage stage--done${column.issues.length === 0 ? " stage--empty" : ""}`} id={stationId("done")} aria-labelledby="done-heading">
      <header class="stage-heading stage-heading--simple"><h2 id="done-heading">Done</h2><span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span></header>
      {column.issues.length > 0
        ? <ol class="issue-list">{column.issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} /></li>)}</ol>
        : <p class="empty">No closed issues</p>}
      {remaining > 0 && (
        <form class="load-more" method="get" action="/">
          <input type="hidden" name="view" value="board" />
          <input type="hidden" name="doneLimit" value={column.issues.length + increment} />
          <button type="submit">Load {increment} more</button>
          <span>{column.issues.length} of {column.totalIssues}</span>
        </form>
      )}
    </section>
  );
}

function Attention({ model }: { model: DashboardViewModel }) {
  const column = model.attention;
  return (
    <section class="panel" aria-labelledby="attention-heading">
      <header class="section-heading"><div><h2 id="attention-heading">Needs attention</h2><p>These enrolled issues have a missing, unknown, or conflicting stage label.</p></div><span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span></header>
      {column.issues.length > 0
        ? <ol class="attention-grid">{column.issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} /></li>)}</ol>
        : <p class="empty">No label inconsistencies</p>}
      <Pagination column={column} view="attention" />
    </section>
  );
}

function issueSignal(issue: IssueCardViewModel): "run" | "wait" | "stop" {
  if (issue.working) return "run";
  if (issue.waiting) return "wait";
  if (issue.tone === "success" || issue.tone === "muted") return "run";
  if (issue.tone === "danger") return "stop";
  return "wait";
}

function Line({ model }: { model: DashboardViewModel }) {
  const stations = [
    { id: "backlog", name: "Backlog", count: model.backlog.length, issues: model.backlog },
    ...model.stages.map((stage) => ({ id: stage.id, name: stage.name, count: stage.totalIssues, issues: stage.issues })),
    { id: "done", name: "Done", count: model.done.totalIssues, issues: model.done.issues },
  ];
  return (
    <nav class="line" aria-labelledby="line-heading">
      <h2 id="line-heading">The line</h2>
      <ol>
        {stations.map((station) => {
          const signalCounts = station.issues.reduce<Record<"run" | "wait" | "stop", number>>((counts, issue) => {
            counts[issueSignal(issue)] += 1;
            return counts;
          }, { run: 0, wait: 0, stop: 0 });
          const signals = (["run", "wait", "stop"] as const).filter((signal) => signalCounts[signal] > 0);
          const running = station.issues.some((issue) => issue.working);
          return (
            <li class={`line-station${running ? " line-station--running" : ""}`} key={station.id}>
              <a href={`#${stationId(station.id)}`} data-station-link={station.id}>
                <span class="line-station-name">{station.name}</span>
                <span class="line-station-state">
                  <strong>{station.count}</strong>
                  <span class="andon-signals" aria-label={`${station.name} state signals`}>
                    {signals.map((signal) => {
                      const label = signal === "run" ? "running" : signal === "wait" ? "waiting" : "stopped";
                      return <span class="andon-count" aria-label={`${signalCounts[signal]} ${label}`} key={signal}><i class={`andon andon--${signal}`} aria-hidden="true" /><small>{signalCounts[signal]}</small></span>;
                    })}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function RunnerStatus({ model }: { model: DashboardViewModel }) {
  const { runnerCount, runnerCapacity, runs } = model.activeWork;
  return (
    <details class="runner-status">
      <summary><strong>{runnerCount} of {runnerCapacity}</strong> runners</summary>
      <div class="header-popover">
        <h2>Active work</h2>
        {runs.length > 0
          ? <ul>{runs.map((run) => <li key={run.id}><a href={issueHref(run.issueId)}><strong>#{run.issueNumber} {run.issueTitle}</strong><span>{run.stageId} · <LocalTime value={run.startedAt} /></span></a></li>)}</ul>
          : <p>No issue is being worked on right now.</p>}
      </div>
    </details>
  );
}

function AgentsMenu({ agents }: { agents: DashboardViewModel["agents"] }) {
  return (
    <details class="agents-menu">
      <summary>Agents</summary>
      <div class="header-popover">
        <a class="agents-all" href="/agents">View all agents</a>
        {agents && agents.length > 0 && <ul>{agents.map((agent) => <li key={agent.id}><a href={agentHref(agent.id)}><strong>{agent.name}</strong><span>{agent.title}</span></a></li>)}</ul>}
      </div>
    </details>
  );
}

function Page({ model }: { model: DashboardViewModel }) {
  let content: ComponentChildren;
  if (model.view === "attention") content = <Attention model={model} />;
  else if (model.view === "agent") content = <AgentPanel model={model} />;
  else content = (
    <section class="board" aria-label="Delivery board">
      <BacklogColumn model={model} />
      {model.stages.map((stage) => <StageColumn column={stage} key={stage.id} />)}
      <DoneColumn model={model} />
    </section>
  );

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{model.title} · Conveyor</title>
        <style dangerouslySetInnerHTML={{ __html: dashboardCss }} />
        <script src="/assets/dashboard.js" defer />
      </head>
      <body data-dashboard-revision={model.revision} data-dashboard-view={model.view} data-csrf-token={model.csrfToken}>
        <main class="dashboard">
          <header class="dashboard-header">
            <h1 class="wordmark"><a href="/">Conveyor</a></h1>
            <details class="server-status" data-server-status>
              <summary><span class="server-dot" aria-hidden="true" /><strong data-connection-state>Connecting</strong></summary>
              <div class="header-popover server-popover">
                <h2>Server status</h2>
                <p data-server-metrics>Waiting for server status…</p>
                <p class="updated"><span>Dashboard updated</span> <LocalTime value={model.updatedAt} /></p>
              </div>
            </details>
            <RunnerStatus model={model} />
            <span class="total-usage">{model.totalUsage}</span>
            <AgentsMenu agents={model.agents} />
            <form class="logout-form" method="post" action="/logout"><input type="hidden" name="csrf" value={model.csrfToken} /><button class="logout" type="submit">Sign out</button></form>
          </header>
          <Line model={model} />
          {model.systemWarnings.length > 0 && <section class="system-warnings" role="alert"><h2>System attention</h2><ul>{model.systemWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
          <NeedsYou model={model} />
          <Navigation model={model} />
          {content}
          {model.selectedIssue && (
            <DetailsDialog
              issue={model.selectedIssue}
              id={`selected-issue-${model.selectedIssue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${model.selectedIssue.number}`}
              selected
            />
          )}
          <div class="page-loader" role="status" aria-live="polite"><span />Loading…</div>
        </main>
      </body>
    </html>
  );
}

export function renderDashboard(model: DashboardViewModel): string {
  return `<!doctype html>${renderToString(<Page model={model} />)}`;
}

export { dashboardCss } from "./styles";
export type { DashboardViewModel, IssueCardViewModel, QuestionViewModel, StageColumnViewModel } from "./types";
