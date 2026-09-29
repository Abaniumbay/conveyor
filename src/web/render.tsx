import { Fragment, type ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";

import { dashboardCss } from "./styles";
import type {
  DashboardView,
  DashboardViewModel,
  IssueCardViewModel,
  IssueRelationViewModel,
  QuestionViewModel,
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

function RelationLink({ relation }: { relation: IssueRelationViewModel }) {
  const url = safeUrl(relation.url);
  const label = <>#{relation.number} {relation.title}</>;
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{label}</a> : label;
}

function Relationships({ issue }: { issue: IssueCardViewModel }) {
  if (!issue.parent && issue.children.length === 0 && issue.dependencies.length === 0) return null;
  return (
    <section class="relationships" aria-label={`Issue relationships for #${issue.number}`}>
      {issue.parent && <p><strong>Parent:</strong> <RelationLink relation={issue.parent} /></p>}
      {issue.dependencies.length > 0 && (
        <div>
          <strong>Blocked by:</strong>
          <ul>{issue.dependencies.map((dependency) => <li key={dependency.number}><RelationLink relation={dependency} /></li>)}</ul>
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
  if (!issue.parent && issue.children.length === 0 && issue.dependencies.length === 0) return null;
  return (
    <div class="relation-summary" aria-label={`Relationship summary for #${issue.number}`}>
      {issue.dependencies.length > 0 && (
        <span class="relation-group relation-group--blocked">
          <strong>Blocked by</strong>{" "}
          {issue.dependencies.map((dependency, index) => (
            <Fragment key={dependency.number}>{index > 0 && ", "}<RelationLink relation={dependency} /></Fragment>
          ))}
        </span>
      )}
      {issue.parent && <span class="relation-group"><strong>Parent</strong> <RelationLink relation={issue.parent} /></span>}
      {issue.children.length > 0 && <span class="relation-group"><strong>{issue.children.length}</strong> {issue.children.length === 1 ? "child" : "children"}</span>}
    </div>
  );
}

function DetailsDialog({ issue, id }: { issue: IssueCardViewModel; id: string }) {
  const url = safeUrl(issue.url);
  const summaryId = `${id}-summary`;
  const activityId = `${id}-activity`;
  return (
    <dialog class="issue-details" id={id} aria-labelledby={`${id}-title`} data-issue-id={issue.id}>
      <header class="details-header">
        <div>
          <p class="details-kicker">Issue #{issue.number}</p>
          <h2 id={`${id}-title`}>{issue.title}</h2>
        </div>
        <form method="dialog"><button class="dialog-close" aria-label="Close issue details">×</button></form>
      </header>
      <nav class="details-tabs" aria-label="Issue detail sections" role="tablist">
        <button type="button" role="tab" id={`${summaryId}-tab`} aria-controls={summaryId} aria-selected="true" data-detail-tab="summary">Summary</button>
        <button type="button" role="tab" id={`${activityId}-tab`} aria-controls={activityId} aria-selected="false" data-detail-tab="activity">Activity</button>
      </nav>
      <section id={summaryId} role="tabpanel" aria-labelledby={`${summaryId}-tab`} data-detail-panel="summary">
        <div class="details-status">
          <span class="issue-state">{issue.state}</span>
          {issue.working && <span class="working-indicator">Working now</span>}
          {issue.closable && <span class="indicator indicator-closable">Closable</span>}
          {issue.inconsistent && <span class="indicator indicator-inconsistent">Inconsistent</span>}
        </div>
        <dl class="details-facts">
          {issue.activity && <Fragment><dt>Activity</dt><dd>{issue.activity}</dd></Fragment>}
          {issue.reason && <Fragment><dt>Source note</dt><dd>{issue.reason}</dd></Fragment>}
          {issue.cost && <Fragment><dt>Cost</dt><dd>{issue.cost}</dd></Fragment>}
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
        id={activityId}
        role="tabpanel"
        aria-labelledby={`${activityId}-tab`}
        data-detail-panel="activity"
        data-activity-url={`/api/issues/${encodeURIComponent(issue.id)}/activity`}
        hidden
      >
        <p class="activity-status" data-activity-status>Open Activity to load the persisted run log.</p>
        <div data-activity-runs />
      </section>
    </dialog>
  );
}

function IssueCard({ issue }: { issue: IssueCardViewModel }) {
  const dialogId = `issue-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${issue.number}`;
  return (
    <article
      class={`issue issue--${issue.tone}${issue.working ? " issue--working" : ""}`}
      data-issue-id={issue.id}
      data-dialog-open={dialogId}
      tabIndex={0}
      aria-label={`Open details for issue #${issue.number}`}
      aria-haspopup="dialog"
    >
      <h3 class="issue-title">
        <span class="issue-number">#{issue.number}</span>
        <span>{issue.title}</span>
      </h3>
      <RelationshipSummary issue={issue} />
      {issue.activity && <p class="detail"><strong>Activity:</strong> {issue.activity}</p>}
      {issue.reason && issue.tone === "danger" && <p class="detail"><strong>Reason:</strong> {issue.reason}</p>}
      <footer class="issue-footer">
        <span class="issue-state">{issue.state}</span>
        {issue.working && <span class="working-indicator">Working now</span>}
      </footer>
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
  return (
    <section class="stage" aria-labelledby={headingId}>
      <header class="stage-heading">
        <h2 id={headingId}>{column.name}</h2>
        <div class="stage-summary">
          {column.cost && <span class="stage-cost">{column.cost}</span>}
          <span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span>
        </div>
      </header>
      {column.issues.length > 0
        ? <ol class="issue-list">{column.issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} /></li>)}</ol>
        : <p class="empty">No issues in this stage</p>}
      <Pagination column={column} view="board" />
    </section>
  );
}

function Questions({ questions, csrfToken }: { questions: readonly QuestionViewModel[]; csrfToken: string }) {
  if (questions.length === 0) return null;
  return (
    <section class="questions" aria-labelledby="questions-heading">
      <header class="section-heading">
        <h2 id="questions-heading">Needs your input</h2>
        <span class="count">{questions.length}</span>
      </header>
      <div class="question-grid">
        {questions.map((question, questionIndex) => (
          <article class="question" key={question.id}>
            <p class="question-issue">Issue #{question.issueNumber}</p>
            <h3>{question.prompt}</h3>
            <p>{question.reason}</p>
            <form method="post" action={`/questions/${encodeURIComponent(question.id)}/answer`}>
              <input type="hidden" name="csrf" value={csrfToken} />
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
          </article>
        ))}
      </div>
    </section>
  );
}

function Navigation({ model }: { model: DashboardViewModel }) {
  const tabs: Array<{ view: DashboardView; label: string; count: number | null }> = [
    { view: "board", label: "Board", count: model.counts.board },
    { view: "attention", label: "Needs attention", count: model.counts.attention },
    { view: "agent", label: "Agent", count: null },
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

function ActiveWork({ model }: { model: DashboardViewModel }) {
  const { runnerCount, runnerCapacity, runs } = model.activeWork;
  return (
    <section class={`active-work${runnerCount > 0 ? " active-work--running" : ""}`} aria-labelledby="active-work-heading">
      <div class="active-work-summary">
        <span class="live-dot" aria-hidden="true" />
        <div>
          <h2 id="active-work-heading">{runnerCount === 1 ? "1 runner working" : `${runnerCount} runners working`}</h2>
          <p>{runnerCount} of {runnerCapacity} runner slots active</p>
        </div>
      </div>
      {runs.length > 0
        ? <ul>{runs.map((run) => (
            <li key={run.id}>
              <strong>#{run.issueNumber} {run.issueTitle}</strong>
              <span>{run.stageId} · {run.kind.replaceAll("-", " ")}</span>
            </li>
          ))}</ul>
        : <p class="active-work-idle">No issue is being worked on right now.</p>}
    </section>
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
          <h2>Steering agent</h2>
          <p>{steering.enabled ? `Connected to ${steering.agent}. Ask it to inspect or change the system.` : "No steering agent is configured."}</p>
        </div>
        {selected && <span class={`run-status run-status--${selected.status}`}>{selected.status}</span>}
      </header>
      <div class="agent-layout">
        <div class="agent-main">
          <ol class="agent-events" id="steering-events" data-next-sequence={(selected?.events.at(-1)?.sequence ?? 0) + 1} aria-live="polite">
            {selected?.events.map((event) => (
              <li class={`agent-event agent-event--${event.type}`} data-sequence={event.sequence} key={event.sequence}>
                <span class="agent-event-role">{event.type === "user" ? "You" : event.type === "report" ? "Report" : "Agent"}</span>
                <p>{event.text}</p>
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
              <button type="submit" disabled={!steering.enabled || running}>Send to agent</button>
            </div>
          </form>
        </div>
        {steering.recent.length > 0 && (
          <aside class="agent-history" aria-label="Recent agent runs">
            <h3>Recent</h3>
            <ol>{steering.recent.map((run) => <li key={run.id}><a href={`/?view=agent&run=${encodeURIComponent(run.id)}`} class={selected?.id === run.id ? "history-active" : undefined}><span>{run.startedAt}</span><small>{run.status}</small></a></li>)}</ol>
          </aside>
        )}
      </div>
    </section>
  );
}

function BacklogColumn({ model }: { model: DashboardViewModel }) {
  return (
    <section class="stage stage--backlog" aria-labelledby="backlog-heading">
      <header class="stage-heading"><h2 id="backlog-heading">Backlog</h2><span class="count" aria-label={`${model.backlog.length} issues`}>{model.backlog.length}</span></header>
      {model.backlog.length > 0 ? (
        <ol class="issue-list">
          {model.backlog.map((issue, index) => (
            <li class="backlog-row" key={issue.id}>
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
    <section class="stage stage--done" aria-labelledby="done-heading">
      <header class="stage-heading"><h2 id="done-heading">Done</h2><span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span></header>
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
        <title>{model.title} · Conveyor</title>
        <style dangerouslySetInnerHTML={{ __html: dashboardCss }} />
        <script src="/assets/dashboard.js" defer />
      </head>
      <body data-dashboard-revision={model.revision} data-dashboard-view={model.view}>
        <main class="dashboard">
          <header class="dashboard-header">
            <div><p class="eyebrow">Conveyor</p><h1>{model.title}</h1><p class="project-meta">{model.project}</p></div>
            <div class="header-actions">
              <p class="updated"><span>Updated</span> <time dateTime={model.updatedAt}>{model.updatedAt}</time></p>
              <form method="post" action="/logout"><input type="hidden" name="csrf" value={model.csrfToken} /><button class="logout" type="submit">Sign out</button></form>
            </div>
          </header>
          {model.systemWarnings.length > 0 && <section class="system-warnings" role="alert"><h2>System attention</h2><ul>{model.systemWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
          <Questions questions={model.questions} csrfToken={model.csrfToken} />
          <Navigation model={model} />
          <ActiveWork model={model} />
          {content}
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
