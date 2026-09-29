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

function IssueLink({ issue }: { issue: Pick<IssueCardViewModel, "number" | "title" | "url"> }) {
  const url = safeUrl(issue.url);
  if (!url) return <>{issue.title}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {issue.title}<span class="sr-only"> (opens issue #{issue.number} in a new tab)</span>
    </a>
  );
}

function RelationLink({ relation }: { relation: IssueRelationViewModel }) {
  const url = safeUrl(relation.url);
  const label = <>#{relation.number} {relation.title}</>;
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{label}</a> : label;
}

function Relationships({ issue }: { issue: IssueCardViewModel }) {
  if (!issue.parent && issue.children.length === 0) return null;
  return (
    <section class="relationships" aria-label={`Issue relationships for #${issue.number}`}>
      {issue.parent && <p><strong>Parent:</strong> <RelationLink relation={issue.parent} /></p>}
      {issue.children.length > 0 && (
        <div>
          <strong>Children:</strong>
          <ul>{issue.children.map((child) => <li key={child.number}><RelationLink relation={child} /></li>)}</ul>
        </div>
      )}
    </section>
  );
}

function IssueCard({ issue }: { issue: IssueCardViewModel }) {
  return (
    <article class={`issue issue--${issue.tone}`} data-issue-id={issue.id}>
      <h3 class="issue-title">
        <span class="issue-number">#{issue.number}</span>
        <span><IssueLink issue={issue} /></span>
      </h3>
      <span class="issue-state">{issue.state}</span>
      {issue.labels.length > 0 && (
        <div class="labels" aria-label="Labels">
          {issue.labels.map((label) => <span class="label" key={label}>{label}</span>)}
        </div>
      )}
      {(issue.blocked || issue.inconsistent || issue.closable) && (
        <div class="indicators" aria-label="Issue status">
          {issue.blocked && <span class="indicator indicator-blocked">Blocked</span>}
          {issue.inconsistent && <span class="indicator indicator-inconsistent">Inconsistent</span>}
          {issue.closable && <span class="indicator indicator-closable">Closable</span>}
        </div>
      )}
      {issue.acceptanceCriteria.length > 0 && (
        <section class="criteria" aria-label="Acceptance criteria">
          <h4>Acceptance criteria</h4>
          <ul class="criteria-list">
            {issue.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
          </ul>
        </section>
      )}
      {issue.activity && <p class="detail"><strong>Activity:</strong> {issue.activity}</p>}
      {issue.reason && <p class="detail"><strong>Reason:</strong> {issue.reason}</p>}
      {issue.cost && <p class="detail"><strong>Cost:</strong> {issue.cost}</p>}
      {issue.duration && <p class="detail"><strong>Duration:</strong> {issue.duration}</p>}
      <Relationships issue={issue} />
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
  const tabs: Array<{ view: DashboardView; label: string; count: number }> = [
    { view: "board", label: "Board", count: model.counts.board },
    { view: "attention", label: "Needs attention", count: model.counts.attention },
  ];
  return (
    <nav class="tabs" aria-label="Dashboard views">
      {tabs.map((tab) => (
        <a href={`/?view=${tab.view}`} class={model.view === tab.view ? "tab tab--active" : "tab"} aria-current={model.view === tab.view ? "page" : undefined} key={tab.view}>
          {tab.label}<span class="tab-count">{tab.count}</span>
        </a>
      ))}
    </nav>
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
      </head>
      <body>
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
