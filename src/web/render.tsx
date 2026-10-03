import { Fragment, type ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";
import { Accounts, Profile } from "./account-pages";
import { Reports } from "./report-page";

import { Team } from "./agent-pages";
import { AgentAvatar } from "./avatar";
import { renderSafeMarkdown } from "./markdown";
import { dashboardCss, quotaHeaderCss } from "./styles";
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

function issueHref(repository: string, number: number, tab?: "conversation" | "journey" | "logs"): string {
  const suffix = tab ? `/${tab}` : "";
  return `/issues/${encodeURIComponent(repository)}/${number}${suffix}`;
}

function viewHref(view: DashboardView): string {
  if (view === "attention") return "/attention";
  if (view === "team") return "/team";
  if (view === "agent") return "/operator";
  if (view === "reports") return "/reports";
  if (view === "accounts") return "/accounts";
  if (view === "profile") return "/profile";
  return "/board";
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

function RepositoryBadge({ repository }: { repository: string }) {
  return <span class="repository-badge"><i class="repository-dot" aria-hidden="true" />{repository}</span>;
}

function canManageDashboard(model: DashboardViewModel): boolean {
  return !model.account || model.account.role === "superuser";
}

function RelationLink({ relation, showCompletion = false }: { relation: IssueRelationViewModel; showCompletion?: boolean }) {
  const completed = showCompletion && relation.satisfied;
  return <a class={completed ? "relation-link--satisfied" : undefined} href={issueHref(relation.repository, relation.number)}>{relation.repository}:#{relation.number} {relation.title}</a>;
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
          <Fragment key={dependency.number}>{index > 0 && ", "}<a href={issueHref(dependency.repository, dependency.number)}>#{dependency.number}</a></Fragment>
        ))}
      </span>
    </div>
  );
}

function DetailsDialog({ issue, id, selected = false, canManage = false }: { issue: IssueCardViewModel; id: string; selected?: boolean; canManage?: boolean }) {
  const url = safeUrl(issue.url);
  const summaryId = `${id}-summary`;
  const conversationId = `${id}-conversation`;
  const journeyId = `${id}-journey`;
  const activityId = `${id}-activity`;
  return (
    <dialog class="issue-details issue-inspector" id={id} aria-labelledby={`${id}-title`} data-issue-id={issue.id} data-repository-id={issue.repository} data-issue-number={issue.number} data-selected-issue={selected ? "true" : undefined}>
      <header class="details-header">
        <div>
          <p class={`details-kicker repo-color-${issue.repositoryColor}`}><RepositoryBadge repository={issue.repository} />:#{issue.number}</p>
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
        {canManage && issue.retryable && <form class="retry-form" data-retry-form data-retry-url={`/api/issues/${encodeURIComponent(issue.id)}/retry`}>
          <label for={`${id}-retry-note`}>Optional note for the next attempt</label>
          <textarea id={`${id}-retry-note`} name="note" rows={2} maxLength={4000} placeholder="Add feedback for the next attempt…" />
          <button type="submit" data-retry-submit>Retry</button>
          <span role="status" aria-live="polite" data-retry-status />
        </form>}
        {issue.waiting && <WaitingLine issue={issue} className="waiting-detail" />}
        {issue.blocked && (
          <section class="blocked-summary" aria-label="Blocking reason">
            <h3>Blocking reason</h3>
            <p>{issue.reason ?? "Conveyor received a stopped state, but no reason was recorded. Add the concrete blocker and required action in Conversation before resuming this item."}</p>
          </section>
        )}
        <dl class="details-facts">
          {issue.activity && <Fragment><dt>Current step</dt><dd>{issue.activity}</dd></Fragment>}
          {!issue.blocked && issue.reason && <Fragment><dt>Source note</dt><dd>{issue.reason}</dd></Fragment>}
          {issue.cost && <Fragment><dt>Usage</dt><dd>{issue.cost}</dd></Fragment>}
          {issue.duration && <Fragment><dt>Duration</dt><dd>{issue.duration}</dd></Fragment>}
        </dl>
        <Relationships issue={issue} />
        <TodoChecklist issue={issue} />
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

function TodoProgress({ issue }: { issue: IssueCardViewModel }) {
  const todos = issue.todos;
  if (!todos) return null;
  const label = `${todos.done} of ${todos.total} todos done`;
  return (
    <div class="todo-progress" aria-label={`Todo progress for #${issue.number}: ${label}`}>
      <meter min={0} max={todos.total} value={todos.done} aria-hidden="true" />
      <span class="todo-progress-count">{todos.done}/{todos.total}</span>
      {todos.current && <span class="todo-progress-current" title={todos.current}>{todos.current}</span>}
    </div>
  );
}

function TodoChecklist({ issue }: { issue: IssueCardViewModel }) {
  const todos = issue.todos;
  if (!todos) return null;
  const marks = { done: "Done", in_progress: "In progress", pending: "Pending" } as const;
  return (
    <section class="todos" aria-label="Implementation todos">
      <h3>Todos <span class="todos-count">{todos.done}/{todos.total}</span></h3>
      <ol class="todo-list">
        {todos.items.map((item) => (
          <li class={`todo todo--${item.status}`} key={item.id}>
            <span class="todo-mark" aria-label={marks[item.status]} />
            <span class="todo-text">{item.text}</span>
            {item.note && <span class="todo-note">{item.note}</span>}
          </li>
        ))}
      </ol>
    </section>
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

function IssueCard({ issue, actors = [], canManage = false }: { issue: IssueCardViewModel; actors?: StageColumnViewModel["actors"]; canManage?: boolean }) {
  const dialogId = `issue-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${issue.number}`;
  const rollup = issue.children.length > 0;
  const completedChildren = issue.children.filter((child) => child.satisfied).length;
  const glowClass = issue.needsAttention
    ? " issue--glow-attention"
    : issue.working ? " issue--glow-running" : "";
  const statusContext = issue.waiting
    ? null
    : issue.working && actors[0]
    ? actors[0].name
    : (issue.tone === "danger" || issue.tone === "warning")
      ? issue.reason ?? issue.activity
      : null;
  return (
    <article
      class={`issue issue--${issue.tone}${issue.working ? " issue--working" : ""}${glowClass}${rollup ? " issue--rollup" : ""} repo-color-${issue.repositoryColor}`}
      data-issue-id={issue.id}
      data-dialog-open={dialogId}
      tabIndex={0}
      aria-label={`Open details for issue #${issue.number}`}
      aria-haspopup="dialog"
    >
      <p class="issue-kicker"><RepositoryBadge repository={issue.repository} />:#{issue.number}</p>
      <h3 class="issue-title">{issue.title}</h3>
      <p class="issue-status">
        <span class={`andon andon--${issueSignal(issue)}`} aria-hidden="true" />
        <strong>{issue.waiting ? "Waiting" : stateWords(issue)}</strong>
        {statusContext && <> · <span class="issue-status-context" title={statusContext}>{statusContext}</span></>}
        {!issue.waiting && issue.stateChangedAt && <> · <RelativeTime value={issue.stateChangedAt} /></>}
      </p>
      {canManage && issue.retryable && <button type="button" class="issue-retry" data-retry-card data-retry-url={`/api/issues/${encodeURIComponent(issue.id)}/retry`}>Retry</button>}
      {issue.waiting && <WaitingLine issue={issue} className="issue-waiting" />}
      <RelationshipSummary issue={issue} />
      <TodoProgress issue={issue} />
      {rollup && <p class="rollup-summary">Roll-up · {issue.children.length} {issue.children.length === 1 ? "child" : "children"}, {completedChildren} done</p>}
      <DetailsDialog issue={issue} id={dialogId} canManage={canManage} />
    </article>
  );
}

function pageHref(view: DashboardView, column: string, page: number): string {
  return `${viewHref(view)}?${new URLSearchParams({ column, page: String(page) })}`;
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

function StageColumn({ column, canManage = false }: { column: StageColumnViewModel; canManage?: boolean }) {
  const headingId = `stage-${column.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const rollupParents = column.issues.filter((issue) => issue.children.length > 0);
  const regularIssues = column.issues.filter((issue) => issue.children.length === 0);
  const issueList = (issues: readonly IssueCardViewModel[]) => (
    <ol class="issue-list">{issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={column.actors} canManage={canManage} /></li>)}</ol>
  );
  return (
    <section class={`stage${column.issues.length === 0 ? " stage--empty" : ""}`} id={stationId(column.id)} aria-labelledby={headingId}>
      <header class="stage-heading">
        <div class="stage-identity">
          <h2 id={headingId}>{column.name}</h2>
          {column.actors.length > 0 && (
            <div class="stage-actors">{column.actors.map((actor) => (
              <span class="stage-actor" key={`${actor.type}:${actor.name}:${actor.title ?? ""}`}>
                <AgentAvatar name={actor.name} script={actor.type === "script"} />
                <span><strong>{actor.name}</strong>{actor.title && <small>{actor.title}</small>}</span>
              </span>
            ))}</div>
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
  const canManage = canManageDashboard(model);
  const questionIssueIds = new Set(model.questions.map((question) => question.issueId));
  const stopped = model.needsYou.filter((issue) => !questionIssueIds.has(issue.id));
  const total = model.questions.length + stopped.length;
  if (total === 0) return null;
  return (
    <section class="needs-you" aria-labelledby="needs-you-heading">
      <header><h2 id="needs-you-heading">Needs you <span>({total})</span></h2></header>
      <ol>
        {stopped.map((issue) => (
          <li class={`needs-you-item repo-color-${issue.repositoryColor}`} key={issue.id}>
            <span class="andon andon--stop" aria-hidden="true" />
            <div>
              <h3><RepositoryBadge repository={issue.repository} /> · #{issue.number} {issue.title}</h3>
              <p>{issue.reason ?? issue.activity ?? `${issue.state.replaceAll("-", " ")} needs intervention`}</p>
            </div>
            <a class="needs-you-action" href={issueHref(issue.repository, issue.number)}>Open</a>
          </li>
        ))}
        {model.questions.map((question, questionIndex) => (
          <li class={`needs-you-item needs-you-item--question repo-color-${question.repositoryColor}`} key={question.id}>
            <span class="needs-you-question" aria-hidden="true">?</span>
            <div>
              <h3><RepositoryBadge repository={question.repository} /> · #{question.issueNumber} {question.prompt}</h3>
              <p>{question.reason}</p>
            </div>
            {canManage && <form method="post" action={`/questions/${encodeURIComponent(question.id)}/answer`}>
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
            </form>}
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
    { view: "team", label: "Team", count: null },
    { view: "reports", label: "Reports", count: null },
    { view: "agent", label: "Operator", count: null },
  ];
  return (
    <nav class="tabs" aria-label="Dashboard views">
      {tabs.map((tab) => (
        <a href={viewHref(tab.view)} class={model.view === tab.view ? "tab tab--active" : "tab"} aria-current={model.view === tab.view ? "page" : undefined} key={tab.view}>
          {tab.label}{tab.count !== null && <span class="tab-count">{tab.count}</span>}
        </a>
      ))}
      {canManageDashboard(model) && <a href="/accounts" class={model.view === "accounts" ? "tab tab--active" : "tab"} aria-current={model.view === "accounts" ? "page" : undefined}>Accounts</a>}
      <a href="/profile" class={model.view === "profile" ? "tab tab--active" : "tab"} aria-current={model.view === "profile" ? "page" : undefined}><span data-profile-avatar>{model.account?.avatar ?? "🐼"}</span> Profile</a>
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
          {canManageDashboard(model) && <form class="agent-compose" method="post" action="/steering">
            <input type="hidden" name="csrf" value={model.csrfToken} />
            <label for="steering-prompt">Request</label>
            <textarea id="steering-prompt" name="prompt" maxLength={12000} rows={5} required disabled={!steering.enabled || running} placeholder="For example: inspect why issue #152 is blocked and fix any clear Conveyor configuration problem." />
            <div class="compose-actions">
              <span>{running ? "Wait for the current agent to finish." : "The final response is retained as a report."}</span>
              <button type="submit" disabled={!steering.enabled || running}>Send to operator</button>
            </div>
          </form>}
        </div>
        {steering.recent.length > 0 && (
          <aside class="agent-history" aria-label="Recent operator runs">
            <h3>Recent</h3>
            <ol>{steering.recent.map((run) => <li key={run.id}><a href={`/operator/runs/${encodeURIComponent(run.id)}`} class={selected?.id === run.id ? "history-active" : undefined}><LocalTime value={run.startedAt} /><small>{run.status}</small></a></li>)}</ol>
          </aside>
        )}
      </div>
    </section>
  );
}

function BacklogColumn({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  return (
    <section class={`stage stage--backlog${model.backlog.length === 0 ? " stage--empty" : ""}`} id={stationId("backlog")} aria-labelledby="backlog-heading">
      <header class="stage-heading stage-heading--simple"><h2 id="backlog-heading">Backlog</h2><span class="count" aria-label={`${model.backlog.length} issues`}>{model.backlog.length}</span></header>
      {model.backlog.length > 0 ? (
        <ol class="issue-list" data-backlog-list>
          {model.backlog.map((issue, index) => (
            <li class="backlog-row" key={issue.id} data-backlog-id={issue.id} draggable>
              <IssueCard issue={issue} canManage={canManage} />
              {canManage && <div class="reorder" role="group" aria-label={`Reorder issue #${issue.number}`}>
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
              </div>}
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
        ? <ol class="issue-list">{column.issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} canManage={canManageDashboard(model)} /></li>)}</ol>
        : <p class="empty">No closed issues</p>}
      {remaining > 0 && (
        <form class="load-more" method="get" action="/board">
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
        ? <ol class="attention-grid">{column.issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} canManage={canManageDashboard(model)} /></li>)}</ol>
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
          ? <ul>{runs.map((run) => <li key={run.id}><a href={issueHref(run.repository, run.issueNumber)}><strong>#{run.issueNumber} {run.issueTitle}</strong><span>{run.stageId} · <LocalTime value={run.startedAt} /></span></a></li>)}</ul>
          : <p>No issue is being worked on right now.</p>}
      </div>
    </details>
  );
}

function HarnessUsage({ model }: { model: DashboardViewModel }) {
  if (model.harnessUsage.length === 0) return null;
  const names = { fiveHour: "5-hour", weekly: "weekly" } as const;
  return (
    <div class="harness-usage" aria-label="Harness usage remaining">
      {model.harnessUsage.map((harness) => (
        <section class="harness-quota" key={harness.id} aria-label={`${harness.name} usage`}>
          <strong>{harness.name}</strong>
          {Object.entries(names).map(([key, label]) => {
            const window = harness.windows[key as keyof typeof names];
            if (!window) return null;
            const remaining = Math.floor(window.remaining);
            const stale = Date.parse(window.resetsAt) <= Date.now();
            const reset = new Date(window.resetsAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            const reported = new Date(window.reportedAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            return (
              <span
                class={`quota-window${remaining < 10 ? " quota-window--low" : ""}${stale ? " quota-window--stale" : ""}`}
                data-quota-window
                data-reset-at={window.resetsAt}
                data-remaining={remaining}
                data-window-name={label}
                tabIndex={0}
                title={`Reset: ${reset}. Last reported: ${reported}.`}
                aria-label={`${harness.name} ${label}: ${stale ? "stale, " : ""}${remaining}% remaining. Resets ${reset}. Last reported ${reported}.`}
                key={key}
              >
                <span class="quota-value">{stale ? "Stale · " : ""}{remaining}% left</span>
                {remaining < 10 && <span class="quota-low-label">Low capacity</span>}
                <span class="quota-countdown" data-countdown>{stale ? "stale" : "resets in —"}</span>
                <span class="quota-window-details">Reset: {reset}<br />Last reported: {reported}</span>
              </span>
            );
          })}
          {Object.keys(harness.windows).length === 0 && <span class="quota-unavailable">Usage unavailable</span>}
        </section>
      ))}
    </div>
  );
}

function ThemeControl() {
  return (
    <details class="theme-control" data-theme-control>
      <summary aria-label="Choose colour theme"><strong data-theme-label>System</strong></summary>
      <div class="header-popover theme-popover">
        <h2>Theme</h2>
        <div class="theme-options">
          {(["system", "light", "dark"] as const).map((theme) => (
            <button type="button" data-theme-choice={theme} aria-pressed={theme === "system" ? "true" : "false"} key={theme}>
              {theme[0]!.toUpperCase()}{theme.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

function Page({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  let content: ComponentChildren;
  if (model.view === "attention") content = <Attention model={model} />;
  else if (model.view === "agent") content = <AgentPanel model={model} />;
  else if (model.view === "team") content = <Team agents={model.team ?? []} />;
  else if (model.view === "reports" && model.report) content = <Reports report={model.report} />;
  else if (model.view === "accounts") content = <Accounts accounts={model.accounts ?? []} csrfToken={model.csrfToken} />;
  else if (model.view === "profile" && model.account) content = <Profile account={model.account} csrfToken={model.csrfToken} />;
  else content = (
    <section class="board" aria-label="Delivery board">
      <BacklogColumn model={model} />
      {model.stages.map((stage) => <StageColumn column={stage} key={stage.id} canManage={canManage} />)}
      <DoneColumn model={model} />
    </section>
  );

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#087f72" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{model.title} · Conveyor</title>
        <script src="/assets/theme.js" />
        <style dangerouslySetInnerHTML={{ __html: dashboardCss + quotaHeaderCss }} />
        <script src="/assets/dashboard.js" defer />
      </head>
      <body data-dashboard-revision={model.revision} data-dashboard-view={model.view} data-csrf-token={model.csrfToken}>
        <main class="dashboard">
          <header class="dashboard-header">
            <h1 class="wordmark"><a href="/board">Conveyor</a></h1>
            <details class="server-status" data-server-status>
              <summary><span class="server-dot" aria-hidden="true" /><strong data-connection-state>Connecting</strong></summary>
              <div class="header-popover server-popover">
                <h2>Server status</h2>
                <p data-server-metrics>Waiting for server status…</p>
                <p class="updated"><span>Dashboard updated</span> <LocalTime value={model.updatedAt} /></p>
              </div>
            </details>
            <RunnerStatus model={model} />
            <HarnessUsage model={model} />
            <span class="total-usage">{model.totalUsage}</span>
            <ThemeControl />
            <a class="header-link" href="/settings/notifications">Notifications</a>
            <details class="account-menu">
              <summary aria-label={`Account menu for ${model.account?.username ?? "user"}`}><span class="account-avatar">{model.account?.avatar ?? "🐼"}</span><span class="account-username">{model.account?.username}</span></summary>
              <div class="header-popover account-popover">
                <a href="/profile">Profile</a>
                <a href="/profile#change-password">Change password</a>
                <form class="logout-form" method="post" action="/logout"><input type="hidden" name="csrf" value={model.csrfToken} /><input type="hidden" name="pushEndpoint" value="" /><button class="logout" type="submit">Sign out</button></form>
              </div>
            </details>
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
