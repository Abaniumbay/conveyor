import { Fragment, type ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";
import { Accounts, Profile } from "./account-pages";
import { Notifications } from "./notification-page";
import { Reports } from "./report-page";

import { IndicatorChips, IndicatorDetails } from "./indicators";
import { Team } from "./agent-pages";
import { AgentAvatar } from "./avatar";
import { renderSafeMarkdown } from "./markdown";
import { dashboardCss, quotaHeaderCss } from "./styles";
import type {
  DashboardView,
  DashboardViewModel,
  IssueCardViewModel,
  IssueRelationViewModel,
  RepositoryDashboardSummary,
  StageColumnViewModel,
} from "./types";
import { TODO_OWNING_STAGE } from "../engine/todos";
import { BUILD } from "../version";

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
  if (view === "repositories") return "/repositories";
  if (view === "about") return "/about";
  if (view === "accounts") return "/accounts";
  if (view === "profile") return "/profile";
  if (view === "notifications") return "/settings/notifications";
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
  return <a class="repository-badge" href={`/repositories/${encodeURIComponent(repository)}`} title={repository}><i class="repository-dot" aria-hidden="true" /><span class="repository-name">{repository}</span></a>;
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

/**
 * What the board holds while it renders: which items are on it (a chip for one of them traces it in
 * place; any other links to it), and how many unfinished items wait on each.
 */
let boardLinks: { onBoard: ReadonlySet<string>; dependents: ReadonlyMap<string, number> } | null = null;

function boardLinksOf(model: DashboardViewModel): NonNullable<typeof boardLinks> {
  const cards = [...model.backlog, ...model.stages.flatMap((column) => column.issues), ...model.done.issues];
  const dependents = new Map<string, number>();
  for (const card of cards) {
    if (card.tone === "success" || card.tone === "muted") continue;
    for (const dependency of card.dependencies) {
      if (!dependency.satisfied) dependents.set(dependency.id, (dependents.get(dependency.id) ?? 0) + 1);
    }
  }
  return { onBoard: new Set(cards.map((card) => card.id)), dependents };
}

/** For the page script's trace: the ids of an item's unfinished dependencies, or of a parent's unfinished parts. */
function idList(relations: readonly IssueRelationViewModel[]): string | undefined {
  const ids = relations.filter((relation) => !relation.satisfied).map((relation) => relation.id);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function BlocksChip({ issue }: { issue: IssueCardViewModel }) {
  const count = boardLinks?.dependents.get(issue.id) ?? 0;
  if (count === 0) return null;
  return <button type="button" class="dep-chip dep-chip--blocks" data-trace={issue.id} aria-pressed="false" aria-label={`#${issue.number} blocks ${count}: trace them`}>Blocks {count}</button>;
}

/** Unfinished dependencies as chips (a stopped one in red, with its state), and what this item blocks. */
function RelationshipSummary({ issue }: { issue: IssueCardViewModel }) {
  const waiting = issue.dependencies.filter((dependency) => !dependency.satisfied);
  const blocks = (boardLinks?.dependents.get(issue.id) ?? 0) > 0;
  if (waiting.length === 0 && !blocks) return null;
  return (
    <div class="relation-summary" aria-label={`Relationship summary for #${issue.number}`}>
      {waiting.length > 0 && <span class="relation-group relation-group--blocked">Waiting on</span>}
      {waiting.map((dependency) => {
        const stopped = dependency.signal === "stop";
        const label = `#${dependency.number}${stopped && dependency.state ? ` · ${dependency.state}` : ""}`;
        return boardLinks?.onBoard.has(dependency.id)
          ? <button type="button" class={`dep-chip${stopped ? " dep-chip--stop" : ""}`} data-trace={dependency.id} aria-pressed="false" aria-label={`Trace #${dependency.number}${dependency.state ? `, ${dependency.state.toLowerCase()}` : ""}`} title={dependency.title} key={dependency.id}>{label}</button>
          : <a class={`dep-chip${stopped ? " dep-chip--stop" : ""}`} href={issueHref(dependency.repository, dependency.number)} title={dependency.title} key={dependency.id}>{label}</a>;
      })}
      <BlocksChip issue={issue} />
    </div>
  );
}

/** A child shown outside its family's row (its parent is not on the board): a link to the parent. */
function FamilyThread({ issue }: { issue: IssueCardViewModel }) {
  const parent = issue.parent;
  if (!parent) return null;
  const progress = issue.parentProgress;
  return (
    <p class="family-thread">
      <svg class="family-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2v6.5A2.5 2.5 0 0 0 5.5 11H13" /><path d="M10 8l3 3-3 3" /></svg>
      <span class="family-thread-label">Part of</span>
      <a href={issueHref(parent.repository, parent.number)} title={`#${parent.number} ${parent.title}`}>#{parent.number} {parent.title}</a>
      {progress && <span class="family-thread-progress">{progress.done}/{progress.total}</span>}
    </p>
  );
}

function partsSummary(parent: IssueCardViewModel): string {
  const total = parent.children.length;
  const done = parent.children.filter((child) => child.satisfied).length;
  const parts = total === 1 ? "part" : "parts";
  return done === total ? `All ${total} ${parts} done` : `${done} of ${total} ${parts} done`;
}

const FAMILY_SIGNAL_WORDS = { done: "done", run: "running", wait: "waiting", stop: "stopped" } as const;

/** One square per child, done first, then the furthest along: no connecting line, so it never reads as a strike-through. */
function FamilySquares({ parent }: { parent: IssueCardViewModel }) {
  const signalOf = (child: IssueRelationViewModel) => child.satisfied ? "done" : child.signal ?? "wait";
  const children = [...parent.children].sort((left, right) =>
    Number(right.satisfied) - Number(left.satisfied) || (right.station?.index ?? 0) - (left.station?.index ?? 0));
  const counts = (Object.keys(FAMILY_SIGNAL_WORDS) as Array<keyof typeof FAMILY_SIGNAL_WORDS>)
    .map((signal) => ({ signal, count: children.filter((child) => signalOf(child) === signal).length }))
    .filter((entry) => entry.count > 0);
  return (
    <span class="family-squares" role="img" aria-label={counts.map((entry) => `${entry.count} ${FAMILY_SIGNAL_WORDS[entry.signal]}`).join(", ")}>
      {children.map((child) => (
        <span class={`family-square family-square--${signalOf(child)}`} title={`#${child.number} ${child.title}${child.station ? ` · ${child.station.name}` : ""}`} key={child.id} />
      ))}
    </span>
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
          <p class={`details-kicker repo-color-${issue.repositoryColor}`}><RepositoryBadge repository={issue.repository} /><span class="issue-number">#{issue.number}</span></p>
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
          <strong>{issue.waiting ? waitingStateWord(issue.waiting.kind) : stateWords(issue)}</strong>
          {issue.children.length > 0 && <span>· Roll-up</span>}
          {issue.closable && <span>· Closable</span>}
          {issue.noSplit && <span>· No split</span>}
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
        <IndicatorDetails issue={issue} />
        <TodoChecklist issue={issue} />
        <section class="criteria" aria-label="Acceptance criteria">
          <h3>Acceptance criteria</h3>
          {issue.acceptanceCriteria.length > 0
            ? <ul class="criteria-list">{issue.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id}>
                <span aria-label={criterion.approved ? "Approved" : "Not approved"}>
                  {criterion.approved ? "☑ Approved" : "☐ Not approved"}
                </span>{" "}{criterion.text}
              </li>
            ))}</ul>
            : <p class="details-empty">No acceptance criteria recorded.</p>}
        </section>
        {(issue.issueType || issue.issueFields.length > 0) && (
          <section class="source-labels issue-metadata" aria-label="Issue type and fields">
            <h3>Issue type and fields</h3>
            <div>
              {issue.issueType && <span class="source-label" data-issue-type>Type: {issue.issueType}</span>}
              {issue.issueFields.map((field) => <span class="source-label" key={field.name}>{field.name}: {field.value}</span>)}
            </div>
          </section>
        )}
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

function waitingStateWord(kind: "waiting" | "queued"): string {
  return kind === "queued" ? "Queued" : "Waiting";
}

function TodoProgress({ issue }: { issue: IssueCardViewModel }) {
  const todos = issue.todos;
  if (!todos || issue.stage !== TODO_OWNING_STAGE) return null;
  const label = `${todos.finished} of ${todos.total} todos finished`;
  return (
    <div class="todo-progress" aria-label={`Todo progress for #${issue.number}: ${label}`}>
      <meter min={0} max={todos.total} value={todos.finished} aria-hidden="true" />
      <span class="todo-progress-count">{todos.finished}/{todos.total}</span>
      {todos.current && <span class="todo-progress-current" title={todos.current}>{todos.current}</span>}
    </div>
  );
}

function TodoChecklist({ issue }: { issue: IssueCardViewModel }) {
  const todos = issue.todos;
  if (!todos) return null;
  const marks = { done: "Done", in_progress: "In progress", pending: "Pending", skipped: "Skipped" } as const;
  return (
    <section class="todos" aria-label="Implementation todos">
      <h3>Todos <span class="todos-count">{todos.finished}/{todos.total}{todos.skipped > 0 && <>, {todos.skipped} skipped</>}</span></h3>
      <ol class="todo-list">
        {todos.items.map((item) => (
          <li class={`todo todo--${item.status}`} key={item.id}>
            <span class="todo-mark" aria-label={marks[item.status]} />
            <span class="todo-text">{item.status === "skipped" && <span class="todo-skipped-label">Skipped · </span>}{item.text}</span>
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
    inconsistent: "Label problems",
    "in-progress": "Working",
    in_progress: "Working",
    "needs-input": "Needs input",
    "needs-intervention": "Needs intervention",
    paused: "Waiting",
  };
  return words[issue.state] ?? issue.state.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * The cards the browser already holds, by revision, while a live update is rendered; null renders
 * every card. A card whose revision is among them is sent as a placeholder the browser keeps its
 * own node for, so an update carries only the cards that changed.
 */
let heldCards: ReadonlySet<string> | null = null;

/** Changes whenever anything the card shows does. */
function cardRevision(issue: IssueCardViewModel, actors: StageColumnViewModel["actors"], canManage: boolean, stageLabel: string | null, thread: boolean): string {
  const links = boardLinks && [boardLinks.dependents.get(issue.id) ?? 0, issue.dependencies.map((dependency) => boardLinks!.onBoard.has(dependency.id))];
  return Bun.hash(JSON.stringify([issue, actors, canManage, stageLabel, thread, links])).toString(36);
}

/**
 * `stageLabel`: the card's station, shown on phones where a family row lists its cards in one column.
 * `thread`: the card is outside its family's row, so it links to its parent.
 */
function IssueCard({ issue, actors = [], canManage = false, stageLabel = null, thread = false }: { issue: IssueCardViewModel; actors?: StageColumnViewModel["actors"]; canManage?: boolean; stageLabel?: string | null; thread?: boolean }) {
  const revision = cardRevision(issue, actors, canManage, stageLabel, thread);
  if (heldCards?.has(revision)) return <article class="issue" data-issue-id={issue.id} data-card-revision={revision} data-keep />;
  const dialogId = `issue-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${issue.number}`;
  const rollup = issue.children.length > 0;
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
      data-card-revision={revision}
      data-number={issue.number}
      data-state-word={issue.waiting ? waitingStateWord(issue.waiting.kind) : stateWords(issue)}
      data-waits={idList(issue.dependencies)}
    >
      <p class="issue-kicker"><RepositoryBadge repository={issue.repository} /><span class="issue-number">#{issue.number}</span>{stageLabel && <span class="issue-stage">{stageLabel}</span>}</p>
      {thread && <FamilyThread issue={issue} />}
      <h3 class="issue-title"><button type="button" class="card-open" aria-haspopup="dialog">{issue.title}</button></h3>
      <p class="issue-status">
        <span class={`andon andon--${issueSignal(issue)}`} aria-hidden="true" />
        <strong>{issue.waiting ? waitingStateWord(issue.waiting.kind) : stateWords(issue)}</strong>
        {statusContext && <> · <span class="issue-status-context" title={statusContext}>{statusContext}</span></>}
        {!issue.waiting && issue.stateChangedAt && <> · <RelativeTime value={issue.stateChangedAt} /></>}
        {issue.noSplit && <> · <span>No split</span></>}
      </p>
      {canManage && issue.retryable && <button type="button" class="issue-retry" data-retry-card data-retry-url={`/api/issues/${encodeURIComponent(issue.id)}/retry`}>Retry</button>}
      {issue.waiting && <WaitingLine issue={issue} className="issue-waiting" />}
      <RelationshipSummary issue={issue} />
      <IndicatorChips issue={issue} />
      <TodoProgress issue={issue} />
      {rollup && <p class="rollup-summary">{partsSummary(issue)}</p>}
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

/** An empty stage in the middle of the line collapses to a narrow heading; Backlog and Done never do. */
function narrowStation(station: { kind: "backlog" | "stage" | "done"; count: number }): boolean {
  return station.kind === "stage" && station.count === 0;
}

interface Station {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  count: number;
  actors: StageColumnViewModel["actors"];
  cost: string | null;
  issues: readonly IssueCardViewModel[];
  column: StageColumnViewModel | null;
  kind: "backlog" | "stage" | "done";
}

/** The emoji of a stage with none configured, by its usual id; any other stage shows none. */
const DEFAULT_STAGE_ICONS: Record<string, string> = {
  backlog: "📥", refinement: "🧭", implementation: "🛠️", review: "🔍", merge: "🔀",
  deploy: "🚀", verify: "✅", cleanup: "🧹", done: "🏁",
};

function stageIcon(id: string, configured: string | null | undefined): string | null {
  return configured ?? DEFAULT_STAGE_ICONS[id.replace(/^stage:/, "")] ?? null;
}

function boardStations(model: DashboardViewModel): Station[] {
  return [
    { id: "backlog", name: "Backlog", icon: stageIcon("backlog", null), description: "Enrolled items waiting for their first stage, in the order they will start.", count: model.backlog.length, actors: [], cost: null, issues: model.backlog, column: null, kind: "backlog" },
    ...model.stages.map((column): Station => ({ id: column.id, name: column.name, icon: stageIcon(column.id, column.icon), description: column.description ?? null, count: column.totalIssues, actors: column.actors, cost: column.cost, issues: column.issues, column, kind: "stage" })),
    { id: "done", name: "Done", icon: stageIcon("done", null), description: "Delivered and closed items, the most recent first.", count: model.done.totalIssues, actors: [], cost: null, issues: model.done.issues, column: model.done, kind: "done" },
  ];
}

const infoIcon = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v4" /><path d="M8 4.8v.01" /></svg>;

function stationSlug(station: Station): string {
  return station.id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Opens the stage's information dialog; usable from its heading and, on a phone, from its label in a row. */
function StationInfoButton({ station }: { station: Station }) {
  return <button type="button" class="stage-info card-open" data-dialog-open={`stage-info-${stationSlug(station)}`} aria-haspopup="dialog" aria-label={`About ${station.name}`}>{infoIcon}</button>;
}

/** A stage's heading on the board: its name, an information button and its count. */
function StationHeading({ station }: { station: Station }) {
  const headingId = `stage-${stationSlug(station)}`;
  const narrow = narrowStation(station);
  return (
    <section class={`stage${station.kind === "stage" ? "" : ` stage--${station.kind}`}${narrow ? " stage--empty" : ""}`} id={stationId(station.id)} aria-labelledby={headingId} data-dialog-open={`stage-info-${stationSlug(station)}`}>
      <header class="stage-heading">
        {station.icon && <span class="stage-emoji" aria-hidden="true">{station.icon}</span>}
        <h2 id={headingId}>{station.name}</h2>
        <StationInfoButton station={station} />
        <span class="count" aria-label={`${station.count} issues`}>{station.count}</span>
      </header>
    </section>
  );
}

/** What a stage is for, who works there and what it has used. */
function StationDialog({ station }: { station: Station }) {
  const dialogId = `stage-info-${stationSlug(station)}`;
  return (
    <dialog class="stage-dialog" id={dialogId} aria-labelledby={`${dialogId}-title`}>
      <header class="stage-dialog-header">
        <h2 id={`${dialogId}-title`}>{station.icon && <span class="stage-emoji" aria-hidden="true">{station.icon} </span>}{station.name}</h2>
        <form method="dialog"><button type="submit" class="stage-dialog-close" aria-label="Close">×</button></form>
      </header>
      {station.description && <p class="stage-dialog-description">{station.description}</p>}
      <p class="stage-dialog-count"><strong>{station.count}</strong> {station.count === 1 ? "item" : "items"}</p>
      {station.actors.length > 0 && (
        <section class="stage-dialog-team" aria-label={`Who works in ${station.name}`}>
          <h3>Team</h3>
          <ul>{station.actors.map((actor) => (
            <li class="stage-actor" key={`${actor.type}:${actor.name}:${actor.title ?? ""}`}>
              <AgentAvatar name={actor.name} script={actor.type === "script"} />
              <span><strong>{actor.name}</strong>{actor.title && <small>{actor.title}</small>}</span>
            </li>
          ))}</ul>
        </section>
      )}
      <p class="stage-dialog-usage"><span>Usage</span> {station.cost
        ?? (station.actors.length > 0 && station.actors.every((actor) => actor.type === "script")
          ? "Runs without an agent, so it uses no tokens."
          : station.kind === "stage" ? "No agent usage recorded yet." : "Not a stage agents work in.")}</p>
    </dialog>
  );
}

function FoldButton({ target, label }: { target: string; label: string }) {
  return (
    <button type="button" class="row-fold" data-row-fold={target} aria-controls={`${target}-cells`} aria-expanded="true" aria-label={`Fold ${label}`} data-fold-label={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
    </button>
  );
}

/** One open parent: its header (the parent itself) and its children, each in its own station's column. */
function FamilyRow({ parent, stations, canManage }: { parent: IssueCardViewModel; stations: readonly Station[]; canManage: boolean }) {
  const rowId = `family-${parent.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const dialogId = `issue-${parent.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${parent.number}-family`;
  const done = parent.children.filter((child) => child.satisfied);
  const doneIds = new Set(done.map((child) => child.id));
  const stopped = parent.needsAttention || parent.tone === "danger";
  return (
    <section class={`board-row family-row repo-color-${parent.repositoryColor}`} data-family-row={parent.id} data-number={parent.number} data-state-word={stateWords(parent)} data-waits={idList(parent.dependencies)} data-parts={idList(parent.children)} aria-label={`#${parent.number} ${parent.title}`}>
      <div class="row-band">
      <div class="family-head" data-dialog-open={dialogId}>
        <FoldButton target={rowId} label={`the #${parent.number} family`} />
        <RepositoryBadge repository={parent.repository} />
        <span class="family-number">#{parent.number}</span>
        <strong class="family-title" title={parent.title}>{parent.title}</strong>
        <FamilySquares parent={parent} />
        <span class="family-progress"><strong>{done.length}/{parent.children.length}</strong> done</span>
        {stopped && <span class="family-stop" title={parent.reason ?? undefined}><i class="andon andon--stop" aria-hidden="true" />{stateWords(parent)}</span>}
        <BlocksChip issue={parent} />
        <button type="button" class="family-details card-open" aria-haspopup="dialog">Details</button>
        <DetailsDialog issue={parent} id={dialogId} canManage={canManage} />
      </div>
      </div>
      <div class="row-body">
      <div class="board-cells" id={`${rowId}-cells`}>
        {stations.map((station) => {
          const cards = station.kind === "done" ? [] : station.issues.filter((issue) => issue.parent?.id === parent.id && !doneIds.has(issue.id));
          return (
            <div class={`board-cell${narrowStation(station) ? " board-cell--narrow" : ""}`} key={station.id}>
              {cards.length > 0 && <ol class="issue-list">{cards.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={station.actors} canManage={canManage} stageLabel={station.name} /></li>)}</ol>}
              {station.kind === "done" && done.length > 0 && (
                <ol class="issue-list">{done.map((child) => (
                  <li key={child.id}>
                    <a class={`issue issue--compact issue--success repo-color-${parent.repositoryColor}`} href={issueHref(child.repository, child.number)}>
                      <span class="issue-kicker"><span class="issue-number">#{child.number}</span>{station && <span class="issue-stage">{station.name}</span>}</span>
                      <span class="issue-title">{child.title}</span>
                      <span class="issue-status"><span class="andon andon--run" aria-hidden="true" /><strong>Done</strong></span>
                    </a>
                  </li>
                ))}</ol>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </section>
  );
}

function BacklogCell({ issues, model, canManage, thread }: { issues: readonly IssueCardViewModel[]; model: DashboardViewModel; canManage: boolean; thread: (issue: IssueCardViewModel) => boolean }) {
  return (
    <ol class="issue-list" data-backlog-list>
      {issues.map((issue, index) => (
        <li class="backlog-row" key={issue.id} data-backlog-id={issue.id} draggable>
          <IssueCard issue={issue} canManage={canManage} thread={thread(issue)} />
          {canManage && <div class="reorder" role="group" aria-label={`Reorder issue #${issue.number}`}>
            {(["up", "down"] as const).map((direction) => {
              const disabled = direction === "up" ? index === 0 : index === issues.length - 1;
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
  );
}

/**
 * The delivery board: the stations across the top, one foldable row per open parent with its children
 * in their stations, then a row for everything else. A finished family shows only its parent, in Done.
 */
function Board({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  const stations = boardStations(model);
  const openParents: IssueCardViewModel[] = [];
  for (const station of stations) {
    if (station.kind === "done") continue;
    for (const issue of station.issues) if (issue.children.length > 0) openParents.push(issue);
  }
  const openIds = new Set(openParents.map((parent) => parent.id));
  const doneIds = new Set(model.done.issues.map((issue) => issue.id));
  const inFamilyRow = (issue: IssueCardViewModel) => Boolean(issue.parent && openIds.has(issue.parent.id));
  // Outside a family row: not an open parent, not in one of their rows, and not a finished family's child.
  const elsewhere = (station: Station) => station.issues.filter((issue) =>
    !openIds.has(issue.id) && !inFamilyRow(issue) && !(station.kind === "done" && issue.parent && doneIds.has(issue.parent.id)));
  const thread = (issue: IssueCardViewModel) => Boolean(issue.parent);
  const columns = (wide: string, narrow: string) => stations.map((station) => narrowStation(station) ? narrow : wide).join(" ");
  const style = `--board-columns:${columns("min(20rem,86vw)", "4.5rem")};--board-columns-phone:${columns("calc(100vw - 1.5rem)", "3.25rem")}`;
  return (
    <>
    <p class="trace-banner" data-trace-banner role="status" hidden>
      <span data-trace-text />
      <button type="button" class="trace-clear" data-trace-clear>Show everything</button>
    </p>
    <section class="board board--rows" aria-label="Delivery board">
      <div class="board-track" style={style}>
        <div class="board-columns" aria-hidden="true">{stations.map((station) => <span class={`board-column${narrowStation(station) ? " board-column--narrow" : ""}`} key={station.id} />)}</div>
        <div class="board-head">{stations.map((station) => <StationHeading station={station} key={station.id} />)}</div>
        {openParents.map((parent) => <FamilyRow parent={parent} stations={stations} canManage={canManage} key={parent.id} />)}
        <section class={`board-row other-row${openParents.length === 0 ? " other-row--alone" : ""}`} aria-label="Items without a parent">
          {openParents.length > 0 && (
            <div class="row-band">
              <div class="family-head other-head">
                <FoldButton target="board-other" label="items without a parent" />
                <strong class="family-title">Items without a parent</strong>
              </div>
            </div>
          )}
          <div class="row-body">
          <div class="board-cells" id="board-other-cells">
            {stations.map((station) => {
              const issues = elsewhere(station);
              const narrow = narrowStation(station);
              const done = station.kind === "done" ? model.done : null;
              const remaining = done ? done.totalIssues - done.issues.length : 0;
              const increment = Math.min(20, remaining);
              return (
                <div class={`board-cell${narrow ? " board-cell--narrow" : ""}${station.kind === "backlog" ? " stage--backlog" : ""}`} data-station-cell={station.id} aria-label={station.name} key={station.id}>
                  <p class="board-cell-label"><span>{station.icon && <span class="stage-emoji" aria-hidden="true">{station.icon} </span>}{station.name}</span><StationInfoButton station={station} /><span class="count">{station.count}</span></p>
                  {station.kind === "backlog"
                    ? issues.length > 0 && <BacklogCell issues={issues} model={model} canManage={canManage} thread={thread} />
                    : issues.length > 0 && <ol class="issue-list">{issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={station.actors} canManage={canManage} thread={thread(issue)} /></li>)}</ol>}
                  {station.kind === "stage" && station.column && <Pagination column={station.column} view="board" />}
                  {done && remaining > 0 && (
                    <form class="load-more" method="get" action="/board">
                      <input type="hidden" name="doneLimit" value={done.issues.length + increment} />
                      <button type="submit">Load {increment} more</button>
                      <span>{done.issues.length} of {done.totalIssues}</span>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </section>
      </div>
      {stations.map((station) => <StationDialog station={station} key={station.id} />)}
    </section>
    </>
  );
}

function NeedsYou({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  const { stopped, total } = needsYouItems(model);
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
            {canManage && question.answerError ? <p role="alert">{question.answerError}</p> : canManage && <form method="post" action={`/questions/${encodeURIComponent(question.id)}/answer`}>
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

function needsYouItems(model: DashboardViewModel) {
  const questionIssueIds = new Set(model.questions.map((question) => question.issueId));
  const stopped = model.needsYou.filter((issue) => !questionIssueIds.has(issue.id));
  return { stopped, total: model.questions.length + stopped.length };
}

function Navigation({ model }: { model: DashboardViewModel }) {
  const tabs: Array<{ view: DashboardView; label: string; count: number | null }> = [
    { view: "board", label: "Board", count: model.counts.board },
    { view: "team", label: "Team", count: null },
    { view: "reports", label: "Reports", count: null },
    { view: "repositories", label: "Repositories", count: null },
    { view: "agent", label: "Operator", count: null },
  ];
  if (model.counts.attention > 0 || model.view === "attention") tabs.splice(1, 0, { view: "attention", label: "Label problems", count: model.counts.attention });
  const needsYou = needsYouItems(model);
  return (
    <nav class="tabs" aria-label="Dashboard views">
      {tabs.map((tab) => (
        <a href={viewHref(tab.view)} class={model.view === tab.view ? "tab tab--active" : "tab"} aria-current={model.view === tab.view ? "page" : undefined} key={tab.view}>
          {tab.label}{tab.count !== null && <span class="tab-count">{tab.count}</span>}
        </a>
      ))}
      {needsYou.total > 0 && <a href="/board#needs-you-heading" class="needs-you-link"><i class="andon andon--stop" aria-hidden="true" /><span><strong>{needsYou.total}</strong> {needsYou.total === 1 ? "needs" : "need"} you</span></a>}
    </nav>
  );
}

function repositoryHref(id: string): string {
  return `/repositories/${encodeURIComponent(id)}`;
}

function repositoryOrder(left: RepositoryDashboardSummary, right: RepositoryDashboardSummary): number {
  const score = (repository: RepositoryDashboardSummary) => repository.health === "degraded"
    ? 0
    : repository.items.some((item) => item.state === "Needs you") ? 1
      : repository.items.length > 0 ? 2 : 3;
  return score(left) - score(right) || left.id.localeCompare(right.id);
}

function repositoryStatus(repository: RepositoryDashboardSummary): string {
  if (repository.errorSummary) return repository.errorSummary;
  if (repository.items.length === 0) return "Idle";
  const needsYou = repository.items.filter((item) => item.state === "Needs you").length;
  const running = repository.items.filter((item) => item.state === "Running").length;
  return [
    `${repository.items.length} in progress`,
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null,
    running > 0 ? `${running} running` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function RepositoryCard({ repository }: { repository: RepositoryDashboardSummary }) {
  const health = repository.health === "healthy" ? "Healthy" : "Degraded";
  return (
    <a class={`repository-card repo-color-${repository.color} repository-card--${repository.health}`} href={repositoryHref(repository.id)}>
      <span class="repository-card-heading"><i class="repository-dot" aria-hidden="true" /><strong title={repository.id}>{repository.id}</strong><span class="repository-health" role="img" aria-label={health}>{repository.health === "healthy" ? "✓" : "!"}</span></span>
      <span class="repository-address">{repository.address}</span>
      <span class="repository-status" title={repository.errorSummary ?? undefined}>{repositoryStatus(repository)}</span>
    </a>
  );
}

function RepositoryEmpty() {
  return <p class="repository-empty">No repositories are configured.</p>;
}

function Repositories({ model, limited = false }: { model: DashboardViewModel; limited?: boolean }) {
  const repositories = [...model.repositories].sort(repositoryOrder);
  const visible = limited ? repositories.slice(0, 6) : repositories;
  return (
    <section class={limited ? "repositories repositories--strip" : "repositories"} aria-labelledby="repositories-heading">
      <header class="section-heading repositories-heading">
        <div><h2 id="repositories-heading">{limited ? <a href="/repositories">Repositories</a> : "Repositories"}</h2><p>{limited ? "Configured delivery sources" : "Every configured delivery source"}</p></div>
      </header>
      {visible.length === 0 ? <RepositoryEmpty /> : <ol class="repository-grid">{visible.map((repository) => <li key={repository.id}><RepositoryCard repository={repository} /></li>)}</ol>}
      {limited && repositories.length > visible.length && <a class="repositories-show-all" href="/repositories">Show all {repositories.length}</a>}
    </section>
  );
}

function RepositoryDetail({ model }: { model: DashboardViewModel }) {
  const repository = model.repositories.find((candidate) => candidate.id === model.repositoryId);
  if (!repository) return <section class="repository-detail"><h2>Repository not found</h2><p>The requested repository is not configured.</p></section>;
  const restricted = model.account?.role === "superuser"
    ? model.restrictedRepositories.find((candidate) => candidate.id === repository.id)
    : undefined;
  const addressUrl = safeUrl(repository.addressUrl);
  const line = [`${repository.backlog} backlog`, ...repository.stages.map((stage) => `${stage.count} ${stage.name}`), `${repository.done} completed all-time`];
  return (
    <article class="repository-detail">
      <header class={`repository-detail-header repo-color-${repository.color}`}>
        <a class="repository-back-link" href="/repositories">‹ Repositories</a>
        <p class="repository-detail-kind"><i class="repository-dot" aria-hidden="true" /> Repository</p>
        <h2>{repository.id}</h2>
        <p class="repository-address">{addressUrl ? <a href={addressUrl}>{repository.address}</a> : repository.address} · <span role="img" aria-label={repository.health === "healthy" ? "Healthy" : "Degraded"}>{repository.health === "healthy" ? "✓ Healthy" : "! Degraded"}</span></p>
        {repository.lastReconciledAt && <p class="repository-last-checked">Last checked <RelativeTime value={repository.lastReconciledAt} /></p>}
        {repository.error && <p class="repository-error">{repository.error}</p>}
      </header>
      <section><h3>Line</h3><p>{line.join(" · ")}</p><p class="repository-empty">Completed all-time includes completed roll-up parents; Last 30 days counts deliveries only.</p></section>
      <section><h3>Now</h3>{repository.items.length > 0 ? <><p>{repository.capacity.busy} of {repository.capacity.slots} run slots busy</p><ol class="repository-items">{repository.items.map((item) => <li key={item.number}><a href={issueHref(repository.id, item.number)}>#{item.number} {item.title}</a><span>{item.stage ?? "Backlog"} · {item.state}</span></li>)}</ol></> : <p class="repository-empty">No work is in progress.</p>}</section>
      <section><h3>Recently delivered</h3>{repository.deliveries.length > 0 ? <ol class="repository-items">{repository.deliveries.map((delivery) => <li key={delivery.number}><a href={issueHref(repository.id, delivery.number)}>#{delivery.number} {delivery.title}</a><time dateTime={delivery.deliveredAt} data-local-time>…</time></li>)}</ol> : <p class="repository-empty">Nothing has been delivered yet.</p>}</section>
      <section><h3>Setup</h3><dl class="repository-facts"><dt>Pipeline</dt><dd>{repository.setup.pipeline}</dd><dt>Base branch</dt><dd>{repository.setup.baseBranch}</dd><dt>Item source</dt><dd>{repository.setup.itemProvider} · {repository.setup.itemSync}</dd><dt>Slots</dt><dd>{repository.capacity.busy} of {repository.capacity.slots}</dd><dt>CI</dt><dd>{repository.setup.ciProvider ?? "None"} · {repository.setup.ciMode}</dd><dt>System labels</dt><dd>{repository.setup.systemLabels.length > 0 ? repository.setup.systemLabels.join(", ") : "None"}</dd>{restricted && <><dt>Local folder</dt><dd>{restricted.folder}</dd><dt>Agent egress hosts</dt><dd>{restricted.agentEgressHosts.length > 0 ? restricted.agentEgressHosts.join(", ") : "None"}</dd></>}</dl></section>
      <section><h3>Last 30 days</h3><a href={`/reports/${encodeURIComponent(repository.id)}?period=30d`}>Full report →</a><dl class="repository-facts"><dt>Delivered</dt><dd>{repository.report30d.delivered}</dd><dt>Tokens</dt><dd>{repository.report30d.inputTokens.toLocaleString()} in · {repository.report30d.outputTokens.toLocaleString()} out</dd><dt>Agent time</dt><dd>{Math.round(repository.report30d.agentMs / 60_000).toLocaleString()} min</dd></dl></section>
    </article>
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

function About() {
  const preOne = BUILD.version.startsWith("0.");
  return (
    <section class="panel about" aria-labelledby="about-heading">
      <header class="section-heading">
        <div>
          <h2 id="about-heading">About</h2>
          {preOne && <p>Conveyor {BUILD.version} is pre-1.0 software.</p>}
        </div>
      </header>
      <dl class="about-facts">
        <dt>Version</dt><dd>Version {BUILD.version}</dd>
        <dt>Build</dt><dd>{BUILD.commit === "development" ? "Development build" : `Commit ${BUILD.commit.slice(0, 12)}`}{BUILD.builtAt ? `, built ${BUILD.builtAt}` : ""}, Bun {BUILD.runtime}</dd>
        <dt>Source</dt><dd><a href="https://github.com/Abaniumbay/conveyor" target="_blank" rel="noopener noreferrer">github.com/Abaniumbay/conveyor</a></dd>
        <dt>Contributors</dt><dd>Conveyor contributors</dd>
        <dt>License</dt><dd>MIT license</dd>
      </dl>
    </section>
  );
}

function Attention({ model }: { model: DashboardViewModel }) {
  const column = model.attention;
  return (
    <section class="panel" aria-labelledby="attention-heading">
      <header class="section-heading"><div><h2 id="attention-heading">Label problems</h2><p>These enrolled issues have a missing, unknown, or conflicting stage label.</p></div><span class="count" aria-label={`${column.totalIssues} issues`}>{column.totalIssues}</span></header>
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
            return (
              <span
                class={`quota-window${!stale && remaining < 10 ? " quota-window--low" : ""}${stale ? " quota-window--stale" : ""}`}
                data-quota-window
                data-reset-at={window.resetsAt}
                data-reported-at={window.reportedAt}
                data-remaining={remaining}
                data-window-name={label}
                tabIndex={0}
                aria-label={`${harness.name} ${label} usage`}
                key={key}
              >
                <span class="quota-value">{stale ? "Stale" : `${remaining}% left`}</span>
                {!stale && remaining < 10 && <span class="quota-low-label">Low capacity</span>}
                <span class="quota-countdown" data-countdown>{stale ? "stale" : "resets in —"}</span>
                <span class="quota-window-details"><span data-reset-detail></span><br /><span data-reported-detail></span></span>
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
      <summary><span class="sr-only">Colour theme: </span><strong data-theme-label>System</strong></summary>
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

/** Names the view in the document title, so tabs, history entries and screen readers tell the pages apart. */
function pageTitle(model: DashboardViewModel): string {
  return model.selectedIssue ? `#${model.selectedIssue.number} ${model.selectedIssue.title}` : viewTitle(model);
}

/** The view's own name, which the title returns to when an item's details are closed. */
function viewTitle(model: DashboardViewModel): string {
  if (model.view === "repository") return model.repositoryId ?? "Repository";
  if (model.view === "reports" && model.report?.repository) return `Reports · ${model.report.repository}`;
  const names: Record<Exclude<DashboardView, "repository">, string> = {
    board: "Board",
    attention: "Label problems",
    agent: "Operator",
    team: "Team",
    reports: "Reports",
    repositories: "Repositories",
    about: "About",
    accounts: "Accounts",
    profile: "Profile",
    notifications: "Notifications",
  };
  return names[model.view];
}

function Page({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  let content: ComponentChildren;
  if (model.view === "attention") content = <Attention model={model} />;
  else if (model.view === "agent") content = <AgentPanel model={model} />;
  else if (model.view === "team") content = <Team agents={model.team ?? []} />;
  else if (model.view === "reports" && model.report) content = <Reports report={model.report} />;
  else if (model.view === "repositories") content = <Repositories model={model} />;
  else if (model.view === "repository") content = <RepositoryDetail model={model} />;
  else if (model.view === "about") content = <About />;
  else if (model.view === "accounts") content = <Accounts accounts={model.accounts ?? []} csrfToken={model.csrfToken} />;
  else if (model.view === "profile" && model.account) content = <Profile account={model.account} csrfToken={model.csrfToken} />;
  else if (model.view === "notifications" && model.notifications) content = <Notifications preferences={model.notifications} csrfToken={model.csrfToken} />;
  else content = <Board model={model} />;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#087f72" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <title>{pageTitle(model)} · {model.title}</title>
        <script src="/assets/theme.js" />
        <style dangerouslySetInnerHTML={{ __html: dashboardCss + quotaHeaderCss }} />
        <script src="/assets/dashboard.js" defer />
        <script src="/assets/notifications.js" defer />
      </head>
      <body data-dashboard-revision={model.revision} data-dashboard-view={model.view} data-view-title={`${viewTitle(model)} · ${model.title}`} data-csrf-token={model.csrfToken}>
        <a class="skip-link" href="#content">Skip to content</a>
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
            <span class="total-usage" title={model.totalUsage}>{model.totalUsage}</span>
            <ThemeControl />
            <a class={model.view === "notifications" ? "header-link header-link--active" : "header-link"} href="/settings/notifications" aria-current={model.view === "notifications" ? "page" : undefined}>Notifications</a>
            <details class="account-menu">
              <summary aria-label={`Account menu for ${model.account?.username ?? "user"}`}><span class="account-avatar">{model.account?.avatar ?? "🐼"}</span><span class="account-username">{model.account?.username}</span></summary>
              <div class="header-popover account-popover">
                <a href="/profile" class={model.view === "profile" ? "account-menu-link account-menu-link--active" : "account-menu-link"} aria-current={model.view === "profile" ? "page" : undefined}>Profile</a>
                {canManageDashboard(model) && <a href="/accounts" class={model.view === "accounts" ? "account-menu-link account-menu-link--active" : "account-menu-link"} aria-current={model.view === "accounts" ? "page" : undefined}>Accounts</a>}
                <a href="/about" class={model.view === "about" ? "account-menu-link account-menu-link--active" : "account-menu-link"} aria-current={model.view === "about" ? "page" : undefined}>About Conveyor</a>
                <form class="logout-form" method="post" action="/logout"><input type="hidden" name="csrf" value={model.csrfToken} /><input type="hidden" name="pushEndpoint" value="" /><button class="logout" type="submit">Sign out</button></form>
              </div>
            </details>
          </header>
          {model.systemWarnings.length > 0 && <section class="system-warnings" role="alert"><h2>System attention</h2><ul>{model.systemWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
          <Navigation model={model} />
          <div class="content-anchor" id="content" tabIndex={-1} />
          {model.view === "board" && <><Line model={model} /><NeedsYou model={model} /><Repositories model={model} limited /></>}
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
        <p class="sr-only" role="status" data-route-announcer />
      </body>
    </html>
  );
}

export function renderDashboard(model: DashboardViewModel, held: ReadonlySet<string> | null = null): string {
  heldCards = held;
  boardLinks = boardLinksOf(model);
  try {
    return `<!doctype html>${renderToString(<Page model={model} />)}`;
  } finally {
    heldCards = null;
    boardLinks = null;
  }
}

export { dashboardCss } from "./styles";
export type { DashboardViewModel, IssueCardViewModel, QuestionViewModel, StageColumnViewModel } from "./types";
