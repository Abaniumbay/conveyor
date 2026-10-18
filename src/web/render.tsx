import { Fragment, type ComponentChildren } from "preact";
import renderToString from "preact-render-to-string";
import { Accounts, Profile } from "./account-pages";
import { Notifications } from "./notification-page";
import { Reports } from "./report-page";

import { IndicatorChips, IndicatorDetails } from "./indicators";
import { Team } from "./agent-pages";
import { AgentAvatar } from "./avatar";
import { renderSafeMarkdown } from "./markdown";
import { dashboardCss, graphCss, quotaHeaderCss, stickyNavigationCss, stickyNavigationOverridesCss } from "./styles";
import type {
  DashboardView,
  DashboardViewModel,
  GraphNodeViewModel,
  GraphRelationshipViewModel,
  IssueCardViewModel,
  IssueCriterionViewModel,
  IssueRelationViewModel,
  RecentActivityType,
  RepositoryDashboardSummary,
  StageActorViewModel,
  StageColumnViewModel,
} from "./types";
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

function criterionState(criterion: IssueCriterionViewModel): { label: string; mark: string; className: string } {
  if (criterion.manual) return { label: "Manual", mark: "◌", className: "criterion-state--manual" };
  if (criterion.approved) return { label: "Approved", mark: "☑☑", className: "criterion-state--approved" };
  if (criterion.tests.length > 0) return { label: "Tests linked", mark: "☑", className: "criterion-state--tests-linked" };
  return { label: "Waiting", mark: "☐", className: "criterion-state--waiting" };
}

function issueHref(repository: string, number: number, tab?: "conversation" | "journey" | "logs"): string {
  const suffix = tab ? `/${tab}` : "";
  return `/issues/${encodeURIComponent(repository)}/${number}${suffix}`;
}

function viewHref(view: DashboardView): string {
  if (view === "graph") return "/graph";
  if (view === "recent") return "/recent";
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
  const stageBadge = issue.stageBadge;
  const historyOnly = issue.historyOnly === true;
  const summaryId = `${id}-summary`;
  const conversationId = `${id}-conversation`;
  const journeyId = `${id}-journey`;
  const activityId = `${id}-activity`;
  return (
    <dialog class="issue-details issue-inspector" id={id} aria-labelledby={`${id}-title`} data-issue-id={issue.id} data-details-url={`/api/issues/${encodeURIComponent(issue.id)}/details`} data-repository-id={issue.repository} data-issue-number={issue.number} data-selected-issue={selected ? "true" : undefined}>
      <header class="details-header">
        <div>
          <p class={`details-kicker repo-color-${issue.repositoryColor}`}>
            <RepositoryBadge repository={issue.repository} />
            <span class="issue-number">#{issue.number}</span>
            {stageBadge && <span class="repository-badge details-stage-badge" data-details-stage-badge>
              {stageBadge.icon && <span aria-hidden="true"><span class="details-stage-icon">{stageBadge.icon}</span>{" "}</span>}
              <span class="sr-only">Stage: </span>{stageBadge.name}{stageBadge.offboarded && " (offboarded)"}
            </span>}
            {url && <a class="details-source-link" href={url} target="_blank" rel="noopener noreferrer">Open issue source ↗</a>}
          </p>
          <h2 id={`${id}-title`}>{issue.title}</h2>
        </div>
        <div class="details-header-actions">
          <form method="dialog"><button class="dialog-close" aria-label="Close issue details">×</button></form>
        </div>
      </header>
      <nav class="details-tabs" aria-label="Issue detail sections" role="tablist">
        {historyOnly
          ? <button type="button" role="tab" id={`${journeyId}-tab`} aria-controls={journeyId} aria-selected="true" data-detail-tab="journey">Journey</button>
          : <>
            <button type="button" role="tab" id={`${summaryId}-tab`} aria-controls={summaryId} aria-selected="true" data-detail-tab="summary">Summary</button>
            <button type="button" role="tab" id={`${conversationId}-tab`} aria-controls={conversationId} aria-selected="false" data-detail-tab="conversation">Conversation</button>
            <button type="button" role="tab" id={`${journeyId}-tab`} aria-controls={journeyId} aria-selected="false" data-detail-tab="journey">Journey</button>
            <button type="button" role="tab" id={`${activityId}-tab`} aria-controls={activityId} aria-selected="false" data-detail-tab="activity">Technical logs</button>
          </>}
      </nav>
      {!historyOnly && <>
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
        {issue.manualGates && issue.manualGates.length > 0 && (
          <section class="criteria" aria-label="Manual gate approvals" data-manual-gates>
            <h3>Manual gate approvals</h3>
            <ul class="criteria-list">{issue.manualGates.map((gate) => (
              <li key={`${gate.stageId}:${gate.kind}:${gate.gateId ?? "board"}`}>
                <strong>{gate.kind === "board" ? gate.stageId : gate.kind === "follow-up" ? `${gate.stageId} · Follow-ups` : `${gate.stageId} · ${gate.gateId}`}</strong>{" "}
                <span>{gate.kind === "board" ? (gate.required ? "Board approval required" : "No board approval required") : gate.kind === "follow-up" ? "Follow-up acknowledgement required" : "Configured manual requirement"}</span>
                {gate.waiting && <p>{gate.kind === "board" ? "Waiting for board approval" : gate.kind === "follow-up" ? "Waiting for follow-up acknowledgement." : `Waiting for configured manual gate \"${gate.gateId}\".`}</p>}
                {gate.kind === "follow-up" && gate.notes?.map((note) => <p key={note}>{note}</p>)}
                {gate.approvedBy && <p>Approved by {gate.approvedBy}{gate.approvedAt ? ` at ${new Date(gate.approvedAt).toLocaleString()}` : ""}.</p>}
                {canManage && <div class="manual-gate-actions">
                  {gate.kind === "board" && <form method="post" action="/manual-gates/requirement" data-manual-gate-form>
                    <input type="hidden" name="csrf" value={issue.csrfToken ?? ""} />
                    <input type="hidden" name="issueId" value={issue.id} />
                    <input type="hidden" name="stageId" value={gate.stageId} />
                    <input type="hidden" name="required" value={gate.required ? "false" : "true"} />
                    <button type="submit" class="manual-gate-switch" role="switch" aria-checked={gate.required ? "true" : "false"}><span class="switch-track" aria-hidden="true"><span class="switch-knob" /></span><span>Require board approval before leaving {gate.stageId}</span></button>
                  </form>}
                  {gate.waiting && <form method="post" action="/manual-gates/approve" data-manual-gate-form>
                    <input type="hidden" name="csrf" value={issue.csrfToken ?? ""} />
                    <input type="hidden" name="issueId" value={issue.id} />
                    <input type="hidden" name="stageId" value={gate.stageId} />
                    {gate.gateId !== null && <input type="hidden" name="gateId" value={gate.gateId} />}
                    <button type="submit" class="manual-gate-approve">{gate.kind === "follow-up" ? "Done" : "Approve"}</button>
                  </form>}
                  <p class="manual-gate-status" role="status" data-manual-gate-status />
                </div>}
              </li>
            ))}</ul>
          </section>
        )}
        <TodoChecklist issue={issue} />
        <section class="criteria" aria-label="Acceptance criteria" data-criterion-evidence>
          <h3>Acceptance criteria</h3>
          <p class="criterion-guidance">Marker key: the first check is an implementer-linked test; the second is reviewer approval.</p>
          {issue.acceptanceCriteria.length > 0
            ? <ul class="criteria-list criterion-list">{issue.acceptanceCriteria.map((criterion) => {
              const state = criterionState(criterion);
              const approvedWithoutTests = !criterion.manual && criterion.approved && criterion.tests.length === 0;
              return (
              <li key={criterion.id}>
                <details class="criterion-evidence">
                  <summary class="criterion-summary">
                    <span class={`criterion-state ${state.className}`} aria-label={state.label}>
                      <span aria-hidden="true">{state.mark}</span> {state.label}
                    </span>
                    <span class="criterion-text">{criterion.text}</span>
                    <span class="criterion-evidence-summary">
                      <span class="criterion-test-count">{criterion.tests.length} linked test{criterion.tests.length === 1 ? "" : "s"}</span>
                      {approvedWithoutTests && <span class="criterion-no-tests">No test linked</span>}
                    </span>
                  </summary>
                  {criterion.manual
                    ? <p class="criterion-empty">manual</p>
                    : criterion.tests.length === 0
                    ? <p class="criterion-empty">no tests linked</p>
                    : <ul class="criterion-tests">{criterion.tests.map((test, index) => {
                      const sourceUrl = safeUrl(test.sourceUrl);
                      const location = `${test.file}${test.line === null ? "" : `:${test.line}`}`;
                      return <li class="criterion-test" key={`${test.name}:${test.file}:${index}`}>
                        <strong>{test.name}</strong>
                        {sourceUrl ? <a class="criterion-test-location" href={sourceUrl}>{location}</a> : <span class="criterion-test-location">{location}</span>}
                        {test.description && <span class="criterion-test-description">{test.description}</span>}
                      </li>;
                    })}</ul>}
                </details>
              </li>
              );
            })}</ul>
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
      </>}
      <section
        id={journeyId}
        role="tabpanel"
        aria-labelledby={`${journeyId}-tab`}
        data-detail-panel="journey"
        data-journey-url={`/api/issues/${encodeURIComponent(issue.id)}/journey`}
        hidden={!historyOnly}
      >
        {historyOnly && <p class="details-empty">This item is no longer enrolled. Its history is read-only.</p>}
        <p class="journey-status" data-journey-status>Open Journey to load the stage history.</p>
        <ol class="journey-list" data-journey-list />
      </section>
      {!historyOnly && <>
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
      </>}
    </dialog>
  );
}

/** Renders the one details dialog fetched when a board card is opened. */
export function renderIssueDetails(issue: IssueCardViewModel, canManage = false): string {
  const id = `issue-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${issue.number}`;
  return renderToString(<DetailsDialog issue={issue} id={id} canManage={canManage} />);
}

function RelativeTime({ value }: { value: string }) {
  return <time dateTime={value} data-relative-time title={value} aria-label={value} tabIndex={0}>recently</time>;
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
  // Progress shows while work is open; a finished or closed-out list stays in the item's details.
  if (!todos?.current) return null;
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
    <section class="todos" aria-label="Todos">
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
function boardSearchText(issue: IssueCardViewModel, actors: readonly StageActorViewModel[] = []): string {
  return [issue.title, issue.number, `#${issue.number}`, issue.repository, ...issue.labels,
    issue.issueType ?? "", ...issue.issueFields.flatMap((field) => [field.name, field.value]),
    ...(issue.searchActors ?? actors).map((actor) => actor.name)].join(" ").toLocaleLowerCase();
}

function boardFilterState(issue: IssueCardViewModel): "needs-you" | "running" | "waiting" {
  return issue.needsAttention ? "needs-you" : issue.working ? "running" : "waiting";
}

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
  const search = boardSearchText(issue, actors);
  const filterState = boardFilterState(issue);
  return (
    <article
      class={`issue issue--${issue.tone}${issue.working ? " issue--working" : ""}${glowClass}${rollup ? " issue--rollup" : ""} repo-color-${issue.repositoryColor}`}
      data-issue-id={issue.id}
      data-dialog-open={dialogId}
      data-details-url={`/api/issues/${encodeURIComponent(issue.id)}/details`}
      data-card-revision={revision}
      data-number={issue.number}
      data-state-word={issue.waiting ? waitingStateWord(issue.waiting.kind) : stateWords(issue)}
      data-waits={idList(issue.dependencies)}
      data-filter-card
      data-board-search={search}
      data-board-repository={issue.repository}
      data-board-state={filterState}
    >
      <p class="issue-kicker"><RepositoryBadge repository={issue.repository} /><span class="issue-number">#{issue.number}</span>{issue.repositoryPaused && <span class="repository-pause-badge">Repository paused</span>}{stageLabel && <span class="issue-stage">{stageLabel}</span>}</p>
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
// Backlog and Done are Conveyor's own columns around the pipeline. A stage's icon comes only from
// its configuration: Conveyor knows no stage by name.
const BACKLOG_ICON = "📥";
const DONE_ICON = "🏁";

function boardStations(model: DashboardViewModel): Station[] {
  return [
    { id: "backlog", name: "Backlog", icon: BACKLOG_ICON, description: "Enrolled items waiting for their first stage, in the order they will start.", count: model.backlog.length, actors: [], cost: null, issues: model.backlog, column: null, kind: "backlog" },
    ...model.stages.map((column): Station => ({ id: column.id, name: column.name, icon: column.icon ?? null, description: column.description ?? null, count: column.totalIssues, actors: column.actors, cost: column.cost, issues: column.issues, column, kind: "stage" })),
    { id: "done", name: "Done", icon: DONE_ICON, description: "Delivered and closed items, the most recent first.", count: model.done.totalIssues, actors: [], cost: null, issues: model.done.issues, column: model.done, kind: "done" },
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
        {station.actors.length > 0 && <span class="stage-head-actors" aria-label={`${station.actors.map((actor) => actor.name).join(", ")} work in ${station.name}`}>{station.actors.slice(0, 2).map((actor) => <AgentAvatar name={actor.name} script={actor.type === "script"} key={`${actor.type}:${actor.name}`} />)}</span>}
        <StationInfoButton station={station} />
        <span class="count" data-board-station-count={station.id} data-board-total={station.count} aria-label={`${station.count} issues`}>{station.count}</span>
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
  const dialogId = `issue-${parent.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${parent.number}`;
  const done = parent.children.filter((child) => child.satisfied);
  const doneIds = new Set(done.map((child) => child.id));
  const stopped = parent.needsAttention || parent.tone === "danger";
  const parentStation = stations.find((station) => station.issues.some((issue) => issue.id === parent.id));
  const parentActors = parentStation?.actors ?? [];
  return (
    <section class={`board-row family-row repo-color-${parent.repositoryColor}`} data-family-row={parent.id} data-number={parent.number} data-state-word={stateWords(parent)} data-waits={idList(parent.dependencies)} data-parts={idList(parent.children)} aria-label={`#${parent.number} ${parent.title}`}>
      <div class="row-band">
      <div class="family-head" data-dialog-open={dialogId} data-details-url={`/api/issues/${encodeURIComponent(parent.id)}/details`} data-filter-card data-board-search={boardSearchText(parent, parentActors)} data-board-repository={parent.repository} data-board-state={boardFilterState(parent)} data-board-station={parentStation?.id ?? "backlog"}>
        <FoldButton target={rowId} label={`the #${parent.number} family`} />
        <RepositoryBadge repository={parent.repository} />
        <span class="family-number">#{parent.number}</span>
        <strong class="family-title" title={parent.title}>{parent.title}</strong>
        <FamilySquares parent={parent} />
        <span class="family-progress"><strong>{done.length}/{parent.children.length}</strong> done</span>
        {stopped && <span class="family-stop" title={parent.reason ?? undefined}><i class="andon andon--stop" aria-hidden="true" />{stateWords(parent)}</span>}
        <BlocksChip issue={parent} />
        <button type="button" class="family-details card-open" aria-haspopup="dialog">Details</button>
      </div>
      </div>
      <div class="row-body">
      <div class="board-cells" id={`${rowId}-cells`}>
        {stations.map((station) => {
          const cards = station.kind === "done" ? [] : station.issues.filter((issue) => issue.parent?.id === parent.id && !doneIds.has(issue.id));
          return (
          <div class={`board-cell${narrowStation(station) ? " board-cell--narrow" : ""}`} data-board-filter-station={station.id} key={station.id}>
              {cards.length > 0 && <ol class="issue-list">{cards.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={station.actors} canManage={canManage} stageLabel={station.name} /></li>)}</ol>}
              {station.kind === "done" && done.length > 0 && (
                <ol class="issue-list">{done.map((child) => (
                  <li key={child.id}>
                    <a class={`issue issue--compact issue--success repo-color-${parent.repositoryColor}`} href={issueHref(child.repository, child.number)} data-filter-card data-board-search={`${child.title} ${child.number} #${child.number} ${child.repository}`.toLocaleLowerCase()} data-board-repository={child.repository} data-board-state="waiting">
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

/** Compact browser-first filters. The form remains a useful GET fallback when JavaScript is absent. */
function BoardFilters({ model }: { model: DashboardViewModel }) {
  const active = [
    ...model.backlog,
    ...model.stages.flatMap((stage) => stage.issues),
  ];
  const byRepository = new Map<string, { count: number; needsYou: number }>();
  for (const issue of active) {
    const entry = byRepository.get(issue.repository) ?? { count: 0, needsYou: 0 };
    entry.count++;
    if (issue.needsAttention) entry.needsYou++;
    byRepository.set(issue.repository, entry);
  }
  const selected = new Set(model.boardFilters?.repositories ?? []);
  const q = model.boardFilters?.q ?? "";
  const state = model.boardFilters?.state ?? null;
  const repositories = model.repositories.filter((repository) => byRepository.has(repository.id) || repository.health === "degraded");
  return (
    <section class="board-filters" data-board-filters aria-label="Board filters">
      <form method="get" action="/board" data-filter-form>
        <label class="board-filter-search">Search board
          <input type="search" name="q" value={q} placeholder="Search items" data-filter-search />
        </label>
        <button type="button" class="board-filter-more" data-filter-more aria-expanded="false">Filters <span data-filter-count>0</span></button>
        <div class="board-filter-choices" data-filter-choices>
          <fieldset><legend>Repositories</legend>
            {repositories.map((repository) => {
              const counts = byRepository.get(repository.id) ?? { count: 0, needsYou: 0 };
              const pressed = selected.has(repository.id);
              return <span class="repository-filter" key={repository.id}>
                <label>
                  <input type="checkbox" name="repo" value={repository.id} data-filter-repository={repository.id} checked={pressed} />
                  <i class={`repository-dot repo-color-${repository.color}`} aria-hidden="true" />{repository.id} {repository.pause && <span class="repository-pause-badge">Paused</span>}<b>{counts.count}</b>{counts.needsYou > 0 && <em>{counts.needsYou} needs you</em>}{repository.health === "degraded" && <strong aria-label="Degraded">!</strong>}
                </label>
              </span>;
            })}
            <a href="/repositories" class="repository-filter-all">Show all</a>
          </fieldset>
          <fieldset><legend>State</legend>
            {[['needs-you', 'Needs you'], ['running', 'Running'], ['waiting', 'Waiting / Queued']].map(([value, label]) =>
              <label data-filter-state={value} key={value}><input type="radio" name="state" value={value} checked={state === value} />{label}</label>)}
          </fieldset>
        </div>
        <button type="submit" class="board-filter-submit">Apply filters</button>
        <button type="button" class="board-filter-clear" data-filter-clear hidden>Clear filters</button>
        <p class="board-filter-summary" data-filter-summary aria-live="polite">Showing {active.length} of {active.length} active board items</p>
      </form>
    </section>
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
    <section class="board board--rows" aria-label="Delivery board" data-done-total={model.done.totalIssues}>
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
                <div class={`board-cell${narrow ? " board-cell--narrow" : ""}${station.kind === "backlog" ? " stage--backlog" : ""}`} data-station-cell={station.id} data-board-filter-station={station.id} aria-label={station.name} key={station.id}>
                  <p class="board-cell-label"><span>{station.icon && <span class="stage-emoji" aria-hidden="true">{station.icon} </span>}{station.name}</span><StationInfoButton station={station} /><span class="count" data-board-station-count={station.id} data-board-total={station.count}>{station.count}</span></p>
                  {station.kind === "backlog"
                    ? issues.length > 0 && <BacklogCell issues={issues} model={model} canManage={canManage} thread={thread} />
                    : issues.length > 0 && <ol class="issue-list">{issues.map((issue) => <li key={issue.id}><IssueCard issue={issue} actors={station.actors} canManage={canManage} thread={thread(issue)} /></li>)}</ol>}
                  {station.kind === "stage" && station.column && <Pagination column={station.column} view="board" />}
                  {done && remaining > 0 && (
                    <form class="load-more" method="get" action="/board">
                      {model.boardFilters?.repositories.map((repository) => <input type="hidden" name="repo" value={repository} />)}
                      {model.boardFilters?.q && <input type="hidden" name="q" value={model.boardFilters.q} />}
                      {model.boardFilters?.state && <input type="hidden" name="state" value={model.boardFilters.state} />}
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

const GRAPH_NODE_WIDTH = 248;
const GRAPH_NODE_HEIGHT = 140;
const GRAPH_COLUMN_GAP = 92;
const GRAPH_ROW_GAP = 34;
const GRAPH_GROUP_GAP = 76;
const GRAPH_NODE_TEXT_X = 16;
const GRAPH_NODE_TEXT_WIDTH = GRAPH_NODE_WIDTH - 28;

interface GraphPosition { x: number; y: number; }

interface GraphLayout {
  positions: Map<string, GraphPosition>;
  width: number;
  height: number;
}

function graphEdgeId(relationship: GraphRelationshipViewModel): string {
  return `${relationship.kind}:${relationship.from}:${relationship.to}`;
}

function graphText(text: string, maximumCharacters: number): string {
  return text.length > maximumCharacters ? `${text.slice(0, maximumCharacters - 1)}…` : text;
}

/** Produces stable left-to-right layers while putting unrelated graph components on separate rows. */
function graphLayout(nodes: readonly GraphNodeViewModel[], relationships: readonly GraphRelationshipViewModel[]): GraphLayout {
  const sortedIds = nodes.map((node) => node.id).sort((left, right) => left.localeCompare(right));
  const nodeIds = new Set(sortedIds);
  const neighbours = new Map(sortedIds.map((id) => [id, new Set<string>()]));
  const predecessors = new Map(sortedIds.map((id) => [id, [] as string[]]));
  const successors = new Map(sortedIds.map((id) => [id, [] as string[]]));
  for (const relationship of [...relationships].sort((left, right) => graphEdgeId(left).localeCompare(graphEdgeId(right)))) {
    if (!nodeIds.has(relationship.from) || !nodeIds.has(relationship.to)) continue;
    neighbours.get(relationship.from)?.add(relationship.to);
    neighbours.get(relationship.to)?.add(relationship.from);
    predecessors.get(relationship.to)?.push(relationship.from);
    successors.get(relationship.from)?.push(relationship.to);
  }
  const components: string[][] = [];
  const remaining = new Set(sortedIds);
  while (remaining.size > 0) {
    const first = [...remaining].sort((left, right) => left.localeCompare(right))[0];
    if (!first) break;
    const component: string[] = [];
    const pending = [first];
    remaining.delete(first);
    while (pending.length > 0) {
      const id = pending.shift();
      if (!id) continue;
      component.push(id);
      for (const neighbour of neighbours.get(id) ?? []) {
        if (!remaining.delete(neighbour)) continue;
        pending.push(neighbour);
      }
    }
    components.push(component.sort((left, right) => left.localeCompare(right)));
  }

  const positions = new Map<string, GraphPosition>();
  let offsetY = 24;
  let widestLayer = 1;
  for (const component of components) {
    const componentIds = new Set(component);
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string): number => {
      const known = depths.get(id);
      if (known !== undefined) return known;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const depth = Math.max(0, ...(predecessors.get(id) ?? [])
        .filter((predecessor) => componentIds.has(predecessor))
        .map((predecessor) => depthOf(predecessor) + 1));
      visiting.delete(id);
      depths.set(id, depth);
      return depth;
    };
    const layers = new Map<number, string[]>();
    for (const id of component) {
      const depth = depthOf(id);
      const layer = layers.get(depth) ?? [];
      layer.push(id);
      layers.set(depth, layer);
    }
    const layerDepths = [...layers.keys()].sort((left, right) => left - right);
    for (const depth of layerDepths) layers.get(depth)?.sort((left, right) => left.localeCompare(right));
    const orderByNeighbours = (ids: string[], neighboursAtOtherDepth: (id: string) => readonly string[], rowsById: Map<string, number>) => ids.sort((left, right) => {
      const average = (id: string): number | undefined => {
        const rows = neighboursAtOtherDepth(id)
          .map((neighbour) => rowsById.get(neighbour))
          .filter((row): row is number => row !== undefined);
        return rows.length === 0 ? undefined : rows.reduce((total, row) => total + row, 0) / rows.length;
      };
      const leftAverage = average(left);
      const rightAverage = average(right);
      if (leftAverage === undefined && rightAverage === undefined) return left.localeCompare(right);
      if (leftAverage === undefined) return 1;
      if (rightAverage === undefined) return -1;
      return leftAverage - rightAverage || left.localeCompare(right);
    });
    for (const depth of layerDepths.slice(1)) {
      const prior = layers.get(depth - 1) ?? [];
      const priorRows = new Map(prior.map((id, row) => [id, row]));
      const layer = layers.get(depth);
      if (layer) orderByNeighbours(layer, (id) => (predecessors.get(id) ?? []).filter((predecessor) => depths.get(predecessor) === depth - 1), priorRows);
    }
    for (const depth of [...layerDepths].reverse().slice(1)) {
      const next = layers.get(depth + 1) ?? [];
      const nextRows = new Map(next.map((id, row) => [id, row]));
      const layer = layers.get(depth);
      if (layer) orderByNeighbours(layer, (id) => (successors.get(id) ?? []).filter((successor) => depths.get(successor) === depth + 1), nextRows);
    }

    let rows = 1;
    for (const depth of layerDepths) {
      const layer = layers.get(depth) ?? [];
      rows = Math.max(rows, layer.length);
      widestLayer = Math.max(widestLayer, depth + 1);
      layer.forEach((id, row) => positions.set(id, {
        x: 24 + depth * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
        y: offsetY + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
      }));
    }
    offsetY += rows * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP) + GRAPH_GROUP_GAP;
  }
  return {
    positions,
    width: 48 + widestLayer * GRAPH_NODE_WIDTH + Math.max(0, widestLayer - 1) * GRAPH_COLUMN_GAP,
    height: Math.max(164, offsetY - GRAPH_GROUP_GAP + 24),
  };
}

function GraphFilters({ model }: { model: DashboardViewModel }) {
  const filters = model.graphFilters ?? { repositories: [], stage: null, stages: [] };
  return <form class="graph-filters" method="get" action="/graph">
    <label>Repository
      <select name="repo" multiple size={Math.min(Math.max(model.repositories.length, 1), 4)} aria-label="Graph repositories">
        {model.repositories.map((repository) => <option value={repository.id} selected={filters.repositories.includes(repository.id)} key={repository.id}>{repository.id}</option>)}
      </select>
    </label>
    <label>Stage
      <select name="stage" aria-label="Graph stage">
        <option value="" selected={!filters.stage}>All stages</option>
        {filters.stages.map((stage) => <option value={stage.id} selected={filters.stage === stage.id} key={stage.id}>{stage.name}</option>)}
      </select>
    </label>
    <div class="graph-filter-actions"><button type="submit">Apply filters</button><a href="/graph">Clear</a></div>
  </form>;
}

function GraphRelationshipText({ relationship, nodesById }: { relationship: GraphRelationshipViewModel; nodesById: Map<string, GraphNodeViewModel> }) {
  const from = nodesById.get(relationship.from);
  const to = nodesById.get(relationship.to);
  if (!from || !to) return null;
  return relationship.kind === "parent-child"
    ? <><strong>Parent #{from.number} ({from.title}) → child #{to.number} ({to.title})</strong><span> Family relationship</span></>
    : <><strong>Issue #{to.number} ({to.title}) waits for prerequisite #{from.number} ({from.title})</strong><span> Status: {relationship.status} prerequisite</span></>;
}

/** A read-only, relationship-first view of the current workflow. */
function Graph({ model }: { model: DashboardViewModel }) {
  const nodes = [...model.graph.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const relationships = [...model.graph.relationships].sort((left, right) => graphEdgeId(left).localeCompare(graphEdgeId(right)));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (nodes.length === 0) return <section class="graph-view" aria-labelledby="graph-heading">
    <header class="graph-header"><h2 id="graph-heading">Workflow graph</h2><p>Relationships between current workflow items appear here.</p></header>
    <GraphFilters model={model} />
    <p class="graph-empty">There are no current workflow items to show.</p>
  </section>;
  const layout = graphLayout(nodes, relationships);
  return <section class="graph-view" aria-labelledby="graph-heading">
    <header class="graph-header">
      <h2 id="graph-heading">Workflow graph</h2>
      <p>Nodes show current workflow items and directly related context. Lines point from parents and prerequisites to the items they affect.</p>
    </header>
    <GraphFilters model={model} />
    <div class="graph-canvas" tabindex={0} aria-label="Drawn workflow graph">
      <svg class="graph-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="group" aria-labelledby="graph-svg-title graph-svg-description">
        <title id="graph-svg-title">Workflow graph</title>
        <desc id="graph-svg-description">A directed graph of current workflow items and their directly related context.</desc>
        <defs>
          <marker id="graph-arrow-parent" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" /></marker>
          <marker id="graph-arrow-dependency" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" /></marker>
        </defs>
        {relationships.flatMap((relationship) => {
          const from = layout.positions.get(relationship.from);
          const to = layout.positions.get(relationship.to);
          if (!from || !to) return [];
          const startX = from.x + GRAPH_NODE_WIDTH;
          const startY = from.y + GRAPH_NODE_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + GRAPH_NODE_HEIGHT / 2;
          const midX = startX + (endX - startX) / 2;
          const statusClass = relationship.kind === "dependency" && relationship.status ? ` graph-edge--${relationship.status}` : "";
          return <g class={`graph-edge graph-edge--${relationship.kind}${statusClass}`} data-graph-edge={graphEdgeId(relationship)} key={graphEdgeId(relationship)}>
            <path d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`} marker-end={`url(#graph-arrow-${relationship.kind === "parent-child" ? "parent" : "dependency"})`} />
            {relationship.kind === "dependency" && <text x={midX} y={(startY + endY) / 2 - 7} text-anchor="middle">{relationship.status === "satisfied" ? "Met" : relationship.status === "stopped" ? "Blocked" : "Waiting"}</text>}
          </g>;
        })}
        {nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const label = `${node.repository} #${node.number}: ${node.title}${node.stage ? `; stage ${node.stage}` : ""}; state ${node.state}${node.context ? "; context item" : ""}${node.signal === "stop" ? "; stopped" : ""}`;
          const dialogId = `issue-${node.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${node.number}`;
          const clipId = `graph-node-clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          return <a href={issueHref(node.repository, node.number)} class={`graph-node card-open repo-color-${node.repositoryColor}${node.context ? " graph-node--context" : ""}${node.signal === "stop" ? " graph-node--stop" : ""}`} data-graph-node={node.id} data-dialog-open={dialogId} data-details-url={`/api/issues/${encodeURIComponent(node.id)}/details`} aria-haspopup="dialog" aria-label={label} tabIndex={0} key={node.id}>
            <title>{label}</title>
            <rect x={position.x} y={position.y} width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx="4" />
            <rect
              class="graph-node-color"
              style="fill:var(--repo-color)"
              x={position.x}
              y={position.y}
              width="7"
              height={GRAPH_NODE_HEIGHT}
              rx="3"
            />
            <clipPath id={clipId}><rect x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 8} width={GRAPH_NODE_TEXT_WIDTH} height={GRAPH_NODE_HEIGHT - 16} /></clipPath>
            <g clip-path={`url(#${clipId})`}>
              <text class="graph-node-reference" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 23}>{graphText(`${node.repository} #${node.number}`, 27)}</text>
              <text class="graph-node-title" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 47}>{graphText(node.title, 27)}</text>
              <text class="graph-node-detail" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 71}>Stage: {graphText(node.stage ?? "None", 27)}</text>
              <text class="graph-node-detail" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 91}>State: {graphText(node.state, 27)}</text>
              {node.context && <text class="graph-node-badge" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 110}>Context item</text>}
              {node.signal === "stop" && <text class="graph-node-stop" x={position.x + GRAPH_NODE_TEXT_X} y={position.y + 128}>Stopped</text>}
            </g>
          </a>;
        })}
      </svg>
    </div>
    <section class="graph-relationships sr-only" aria-labelledby="graph-relationships-heading">
      <h3 id="graph-relationships-heading">Graph items and directed relationships</h3>
      <h4>Items</h4>
      <ol>{nodes.map((node) => <li key={node.id}>Issue #{node.number} ({node.title}): stage {node.stage ?? "None"}; state {node.state}{node.context ? "; context item" : ""}{node.signal === "stop" ? "; stopped" : ""}</li>)}</ol>
      <h4>Relationships</h4>
      <ol>{relationships.flatMap((relationship) => {
        if (!nodesById.has(relationship.from) || !nodesById.has(relationship.to)) return [];
        const statusClass = relationship.kind === "dependency" && relationship.status ? ` graph-relationship--${relationship.status}` : "";
        return <li class={`graph-relationship graph-relationship--${relationship.kind}${statusClass}`} key={graphEdgeId(relationship)}><GraphRelationshipText relationship={relationship} nodesById={nodesById} /></li>;
      })}</ol>
    </section>
  </section>;
}

function NeedsYou({ model }: { model: DashboardViewModel }) {
  const canManage = canManageDashboard(model);
  const { stopped, followUps, total } = needsYouItems(model);
  return (
    <section class="needs-you" aria-labelledby="needs-you-heading">
      <header><h2 id="needs-you-heading">Needs you <span>({total})</span></h2></header>
      {total === 0 ? <p class="needs-you-empty">No items need your attention right now.</p> : <ol>
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
        {followUps.map(({ issue, gate }) => (
          <li class={`needs-you-item needs-you-item--follow-up repo-color-${issue.repositoryColor}`} key={issue.id}>
            <span class="needs-you-follow-up" aria-hidden="true">✓</span>
            <div>
              <h3><RepositoryBadge repository={issue.repository} /> · #{issue.number} {issue.title}</h3>
              {gate.notes?.map((note) => <p key={note}>{note}</p>)}
            </div>
            {canManage ? <form method="post" action="/manual-gates/approve" data-manual-gate-form>
              <input type="hidden" name="csrf" value={model.csrfToken} />
              <input type="hidden" name="issueId" value={issue.id} />
              <input type="hidden" name="stageId" value={gate.stageId} />
              {gate.gateId !== null && <input type="hidden" name="gateId" value={gate.gateId} />}
              <button type="submit" class="manual-gate-approve">Done</button>
            </form> : <a class="needs-you-action" href={issueHref(issue.repository, issue.number)}>Open</a>}
          </li>
        ))}
        {model.questions.map((question, questionIndex) => (
          <li class={`needs-you-item needs-you-item--question repo-color-${question.repositoryColor}`} key={question.id}>
            <span class="needs-you-question" aria-hidden="true">?</span>
            <div>
              <h3><RepositoryBadge repository={question.repository} /> · #{question.issueNumber} {question.prompt}</h3>
              <p>{question.reason}</p>
            </div>
            {canManage && question.answerError ? <p role="alert">{question.answerError}</p> : canManage && <form method="post" action={`/questions/${encodeURIComponent(question.id)}/answer`} data-answer-form>
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
              <p class="answer-status" role="status" data-answer-status />
            </form>}
          </li>
        ))}
      </ol>}
    </section>
  );
}

function needsYouItems(model: DashboardViewModel) {
  const questionIssueIds = new Set(model.questions.map((question) => question.issueId));
  const followUps = model.needsYou.flatMap((issue) => {
    const gate = issue.manualGates?.find((candidate) => candidate.kind === "follow-up" && candidate.waiting);
    return gate ? [{ issue, gate }] : [];
  });
  const followUpIssueIds = new Set(followUps.map(({ issue }) => issue.id));
  const stopped = model.needsYou.filter((issue) => !questionIssueIds.has(issue.id) && !followUpIssueIds.has(issue.id));
  return { stopped, followUps, total: model.questions.length + followUps.length + stopped.length };
}

function Navigation({ model }: { model: DashboardViewModel }) {
  const tabs: Array<{ view: DashboardView; label: string; count: number | null }> = [
    { view: "board", label: "Board", count: model.counts.board },
    { view: "graph", label: "Graph", count: null },
    { view: "recent", label: "Recent", count: null },
    { view: "team", label: "Team", count: null },
    { view: "reports", label: "Reports", count: null },
    { view: "repositories", label: "Repositories", count: null },
    { view: "agent", label: "Operator", count: null },
  ];
  if (model.counts.attention > 0 || model.view === "attention") tabs.splice(1, 0, { view: "attention", label: "Label problems", count: model.counts.attention });
  return (
    <nav class="tabs" aria-label="Dashboard views">
      {tabs.map((tab) => (
        <a href={viewHref(tab.view)} class={model.view === tab.view ? "tab tab--active" : "tab"} aria-current={model.view === tab.view ? "page" : undefined} key={tab.view}>
          {tab.label}{tab.count !== null && <span class="tab-count">{tab.count}</span>}
        </a>
      ))}
    </nav>
  );
}

const recentTypeLabels: Record<RecentActivityType, string> = {
  done: "Done",
  stopped: "Stopped",
  "sent-back": "Sent back",
  "moved-forward": "Moved forward",
  new: "New",
  resumed: "Restarted / resumed",
  rollup: "Roll-up",
};

const recentTypes: readonly RecentActivityType[] = ["done", "stopped", "sent-back", "moved-forward", "new", "resumed", "rollup"];

function recentHref(model: DashboardViewModel, cursor?: { occurredAt: string; id: string | null }): string {
  const recent = model.recent!;
  const search = new URLSearchParams();
  for (const type of recent.types) search.append("type", type);
  for (const repository of recent.repositoryIds) search.append("repo", repository);
  if (cursor) {
    search.set("beforeAt", cursor.occurredAt);
    if (cursor.id !== null) search.set("beforeId", cursor.id);
  }
  const query = search.toString();
  return query ? `/recent?${query}` : "/recent";
}

function Recent({ model }: { model: DashboardViewModel }) {
  const recent = model.recent!;
  const typeClass = (type: RecentActivityType) => `recent-type recent-type--${type}`;
  return (
    <section class="recent-activity" aria-labelledby="recent-heading">
      <header class="recent-header">
        <h2 id="recent-heading">Recent activity</h2>
        <p>{recent.rangeStartedAt ? "Events from the last 24 hours." : "Earlier events."}</p>
      </header>
      <form class="recent-filters" action="/recent" method="get">
        <fieldset>
          <legend>Event types</legend>
          <div class="recent-filter-options">
            {recentTypes.map((type) => (
              <label class={typeClass(type)} key={type}>
                <input type="checkbox" name="type" value={type} checked={recent.types.includes(type)} />
                <span>{recentTypeLabels[type]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Repositories</legend>
          <div class="recent-filter-options">
            {model.repositories.map((repository) => (
              <label class="recent-repository-filter" key={repository.id}>
                <input type="checkbox" name="repo" value={repository.id} checked={recent.repositoryIds.includes(repository.id)} />
                <span>{repository.id}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button class="recent-filter-submit" type="submit">Apply filters</button>
      </form>
      {recent.events.length === 0
        ? <p class="recent-empty" role="status">{recent.rangeStartedAt ? "No activity matches these filters." : "You've reached the end of the activity feed."}</p>
        : <><ol class="recent-list">
          {recent.events.map((event) => (
            <li class="recent-event" key={event.id}>
              <RelativeTime value={event.occurredAt} />
              <span class={typeClass(event.type)}>{recentTypeLabels[event.type]}</span>
              <div class="recent-item">
                <RepositoryBadge repository={event.repository} />
                <a href={event.issueUrl}>#{event.issueNumber} {event.issueTitle}</a>
              </div>
              {event.fromStage && event.toStage && <p class="recent-move"><span>{event.fromStage}</span><span aria-hidden="true">→</span><span>{event.toStage}</span></p>}
              {event.reason
                ? <details class="recent-reason"><summary><span>Reason</span><span>{event.reason}</span></summary><p>{event.reason}</p></details>
                : <p class="recent-no-reason">No reason recorded.</p>}
            </li>
          ))}
        </ol>{!recent.nextCursor && <p class="recent-empty recent-end" role="status">You've reached the end of the activity feed.</p>}</>}
      {recent.nextCursor && <a class="recent-load-more" href={recentHref(model, recent.nextCursor)}>Load more</a>}
    </section>
  );
}

function StickyFilterSummary({ model }: { model: DashboardViewModel }) {
  const filters = model.boardFilters;
  const labels = [
    ...(filters?.repositories ?? []),
    ...(filters?.q ? [`“${filters.q}”`] : []),
    ...(filters?.state ? [filters.state.replaceAll("-", " ")] : []),
  ];
  const text = `Filters: ${labels.join(", ")}`;
  return <span class="sticky-filter-summary" data-sticky-filter-summary data-filter-count={labels.length} title={text} hidden={labels.length === 0}>{text}</span>;
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
  if (repository.pause) return "Paused";
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
      <span class="repository-card-heading"><i class="repository-dot" aria-hidden="true" /><strong title={repository.id}>{repository.id}</strong>{repository.pause && <span class="repository-pause-badge">Paused</span>}<span class="repository-health" role="img" aria-label={health}>{repository.health === "healthy" ? "✓" : "!"}</span></span>
      <span class="repository-address">{repository.address}</span>
      <span class="repository-status" title={repository.errorSummary ?? undefined}>{repositoryStatus(repository)}</span>
    </a>
  );
}

function RepositoryEmpty() {
  return <p class="repository-empty">No repositories are configured.</p>;
}

function Repositories({ model }: { model: DashboardViewModel }) {
  const repositories = [...model.repositories].sort(repositoryOrder);
  return (
    <section class="repositories" aria-labelledby="repositories-heading">
      <header class="section-heading repositories-heading">
        <div><h2 id="repositories-heading">Repositories</h2><p>Every configured delivery source</p></div>
      </header>
      {repositories.length === 0 ? <RepositoryEmpty /> : <ol class="repository-grid">{repositories.map((repository) => <li key={repository.id}><RepositoryCard repository={repository} /></li>)}</ol>}
    </section>
  );
}

// The board does not list repositories, so a repository that cannot sync says so here: its items may be stale.
function RepositoryWarnings({ model }: { model: DashboardViewModel }) {
  const degraded = [...model.repositories].filter((repository) => repository.health === "degraded").sort(repositoryOrder);
  if (degraded.length === 0) return null;
  return (
    <section class="repository-warnings" aria-label="Repositories that cannot sync">
      <ul>{degraded.map((repository) => (
        <li key={repository.id} class={`repo-color-${repository.color}`}>
          <span class="repository-warning-mark" aria-hidden="true">!</span>
          <span class="repository-warning-text"><strong>{repository.id}</strong> is not syncing{repository.errorSummary ? <>: {repository.errorSummary}</> : null}. Its items may be out of date.</span>
          <a href={repositoryHref(repository.id)}>Details</a>
        </li>
      ))}</ul>
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
  const trustStatus = repository.trust.visibility === "public"
    ? "GitHub reports this repository is public."
    : repository.trust.visibility === "private"
      ? "GitHub reports this repository is private; the public-source safeguards are not required."
      : "Repository visibility is uncertain; public-repository safeguards cannot be confirmed.";
  return (
    <article class="repository-detail">
      <header class={`repository-detail-header repo-color-${repository.color}`}>
        <a class="repository-back-link" href="/repositories">‹ Repositories</a>
        <p class="repository-detail-kind"><i class="repository-dot" aria-hidden="true" /> Repository</p>
        <h2>{repository.id}</h2>
        <p class="repository-address">{addressUrl ? <a href={addressUrl}>{repository.address}</a> : repository.address} · <span role="img" aria-label={repository.health === "healthy" ? "Healthy" : "Degraded"}>{repository.health === "healthy" ? "✓ Healthy" : "! Degraded"}</span></p>
        {repository.pause && <p class="repository-paused-detail"><strong>Paused</strong> by {repository.pause.actor} <LocalTime value={repository.pause.pausedAt} />{repository.pause.reason && <> · {repository.pause.reason}</>}</p>}
        {repository.lastReconciledAt && <p class="repository-last-checked">Last checked <RelativeTime value={repository.lastReconciledAt} /></p>}
        {repository.error && <p class="repository-error">{repository.error}</p>}
      </header>
      <section><h3>Line</h3><p>{line.join(" · ")}</p><p class="repository-empty">Completed all-time includes completed roll-up parents; Last 30 days counts deliveries only.</p></section>
      <section><h3>Now</h3>{repository.items.length > 0 ? <><p>{repository.capacity.busy} of {repository.capacity.slots} run slots busy</p><ol class="repository-items">{repository.items.map((item) => <li key={item.number}><a href={issueHref(repository.id, item.number)}>#{item.number} {item.title}</a><span>{item.stage ?? "Backlog"} · {item.state}</span></li>)}</ol></> : <p class="repository-empty">No work is in progress.</p>}</section>
      <section><h3>Recently delivered</h3>{repository.deliveries.length > 0 ? <ol class="repository-items">{repository.deliveries.map((delivery) => <li key={delivery.number}><a href={issueHref(repository.id, delivery.number)}>#{delivery.number} {delivery.title}</a><time dateTime={delivery.deliveredAt} data-local-time>…</time></li>)}</ol> : <p class="repository-empty">Nothing has been delivered yet.</p>}</section>
      <section><div class="repository-section-heading"><h3>Setup</h3>{canManageDashboard(model) && <div class="repository-actions"><form class="repository-sync" method="post" action={`${repositoryHref(repository.id)}/sync`} data-repository-sync><input type="hidden" name="csrf" value={model.csrfToken} /><button type="submit" data-repository-sync-submit>Sync now</button></form>{repository.pause ? <form method="post" action={`${repositoryHref(repository.id)}/resume`}><input type="hidden" name="csrf" value={model.csrfToken} /><button type="submit">Resume repository</button></form> : <form method="post" action={`${repositoryHref(repository.id)}/pause`}><input type="hidden" name="csrf" value={model.csrfToken} /><label>Pause reason <input name="reason" maxLength={500} /></label><button type="submit">Pause repository</button></form>}</div>}</div>{canManageDashboard(model) && <p class="repository-sync-status" role="status" data-repository-sync-status>Sync now reads every issue, permission, relationship and pull request again, for changes GitHub sends no webhook for.</p>}<dl class="repository-facts"><dt>Pipeline</dt><dd>{repository.setup.pipeline}</dd><dt>Base branch</dt><dd>{repository.setup.baseBranch}</dd><dt>Item source</dt><dd>{repository.setup.itemProvider} · {repository.setup.itemSync}{repository.setup.webhooks ? ` (${repository.setup.webhooks === "healthy" ? "deliveries healthy" : "deliveries stopped arriving: check the webhook"})` : ""}</dd><dt>GitHub calls, last hour</dt><dd>{repository.setup.githubCalls.total}{repository.setup.githubCalls.bySource.length > 0 ? ` (${repository.setup.githubCalls.bySource.map((entry) => `${entry.source} ${entry.count}`).join(", ")})` : ""}</dd><dt>Slots</dt><dd>{repository.capacity.busy} of {repository.capacity.slots}</dd><dt>CI</dt><dd>{repository.setup.ciProvider ?? "None"} · {repository.setup.ciMode}</dd><dt>System labels</dt><dd>{repository.setup.systemLabels.length > 0 ? repository.setup.systemLabels.join(", ") : "None"}</dd>{restricted && <><dt>Local folder</dt><dd>{restricted.folder}</dd><dt>Agent egress hosts</dt><dd>{restricted.agentEgressHosts.length > 0 ? restricted.agentEgressHosts.join(", ") : "None"}</dd></>}</dl></section>
      <section><h3>Last 30 days</h3><a href={`/reports/${encodeURIComponent(repository.id)}?period=30d`}>Full report →</a><dl class="repository-facts"><dt>Delivered</dt><dd>{repository.report30d.delivered}</dd><dt>Tokens</dt><dd>{repository.report30d.inputTokens.toLocaleString()} in · {repository.report30d.outputTokens.toLocaleString()} out</dd><dt>Agent time</dt><dd>{Math.round(repository.report30d.agentMs / 60_000).toLocaleString()} min</dd></dl></section>
      <section><h3>Public repository trust</h3><p>{trustStatus}</p><dl class="repository-facts"><dt>Default permission threshold</dt><dd>{repository.trust.permissionThreshold}</dd><dt>Extra trusted logins</dt><dd>{repository.trust.extraTrustedLogins.length > 0 ? repository.trust.extraTrustedLogins.join(", ") : "None"}</dd><dt>Ignored inputs</dt><dd><ul class="repository-trust-list">{repository.trust.ignoredInputCategories.map((category) => <li key={category}>{category}</li>)}</ul></dd></dl>{repository.skippedReviewItems.length > 0 ? <p class="repository-empty">Ignored native reviews: {repository.skippedReviewItems.map((item, index) => <span key={item.number}>{index > 0 && ", "}<a href={issueHref(repository.id, item.number, "journey")}>#{item.number} {item.title} Journey history</a> ({item.count})</span>)}</p> : <p class="repository-empty">No ignored native reviews have been recorded. Their text is never shown here.</p>}{repository.trust.warning && <p class="repository-error">Source checks uncertain: {repository.trust.warning}</p>}</section>
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
  if (issue.needsAttention) return "stop";
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
      <h2 id="line-heading">
        <button type="button" class="line-toggle" data-line-toggle aria-expanded="true" aria-controls="line-stations">
          The line
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
        </button>
      </h2>
      <div class="line-body">
      <ol id="line-stations">
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
                  <strong data-board-line-count={station.id} data-board-total={station.count}>{station.count}</strong>
                  <span class="andon-signals" aria-label={`${station.name} state signals`}>
                    {signals.map((signal) => {
                      const label = signal === "run" ? "running" : signal === "wait" ? "waiting" : "stopped";
                      return <span class="andon-count" data-board-signal-count={signal} data-board-station={station.id} data-board-total={signalCounts[signal]} aria-label={`${signalCounts[signal]} ${label}`} key={signal}><i class={`andon andon--${signal}`} aria-hidden="true" /><small>{signalCounts[signal]}</small></span>;
                    })}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      </div>
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
        <ActiveWorkList runs={runs} />
      </div>
    </details>
  );
}

function ActiveWorkList({ runs }: { runs: DashboardViewModel["activeWork"]["runs"] }) {
  return runs.length > 0
    ? <ul>{runs.map((run) => <li key={run.id}><a href={issueHref(run.repository, run.issueNumber)}><strong>#{run.issueNumber} {run.issueTitle}</strong><span>{run.stageId} · <LocalTime value={run.startedAt} /></span></a></li>)}</ul>
    : <p>No issue is being worked on right now.</p>;
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
        <ThemeOptions />
      </div>
    </details>
  );
}

function ThemeOptions() {
  return <div class="theme-options">
    {(["system", "light", "dark"] as const).map((theme) => (
      <button type="button" data-theme-choice={theme} aria-pressed={theme === "system" ? "true" : "false"} key={theme}>
        {theme[0]!.toUpperCase()}{theme.slice(1)}
      </button>
    ))}
  </div>;
}

function MobileSystemControls({ model }: { model: DashboardViewModel }) {
  const { runnerCount, runnerCapacity, runs } = model.activeWork;
  return <div class="mobile-system-controls" data-theme-control>
    <p><strong>{runnerCount} of {runnerCapacity}</strong> runners</p>
    {runs.length > 0 && <section class="mobile-active-work"><h3>Active work</h3><ActiveWorkList runs={runs} /></section>}
    <HarnessUsage model={model} />
    <p class="mobile-total-usage" title={model.totalUsage}>{model.totalUsage}</p>
    <a class="header-link" href="/settings/notifications">Notifications</a>
    <section class="mobile-theme-options" aria-label="Theme">
      <h3>Theme</h3>
      <ThemeOptions />
    </section>
  </div>;
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
    graph: "Graph",
    recent: "Recent",
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
  if (model.view === "graph") content = <Graph model={model} />;
  else if (model.view === "recent" && model.recent) content = <Recent model={model} />;
  else if (model.view === "attention") content = <Attention model={model} />;
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
        <style dangerouslySetInnerHTML={{ __html: dashboardCss + graphCss + quotaHeaderCss + stickyNavigationCss + stickyNavigationOverridesCss }} />
        <script src="/assets/dashboard.js" defer />
        <script src="/assets/notifications.js" defer />
      </head>
      <body data-dashboard-revision={model.revision} data-dashboard-view={model.view} data-view-title={`${viewTitle(model)} · ${model.title}`} data-csrf-token={model.csrfToken}>
        <a class="skip-link" href="#content">Skip to content</a>
        <main class="dashboard">
          <div class="dashboard-sticky">
            <header class="dashboard-header">
              <h1 class="wordmark"><a href="/board">Conveyor</a></h1>
              <details class="server-status" data-server-status>
                <summary aria-label="Connection state: Connecting"><span class="server-dot" aria-hidden="true" /><strong class="connection-state" data-connection-state>Connecting</strong><a data-session-sign-in hidden>Sign in again</a><span class="server-storage-warning" data-storage-warning hidden><span aria-hidden="true">!</span><span class="sr-only">Storage pressure warning</span></span></summary>
              <div class="header-popover server-popover">
                <h2>System</h2>
                <p data-server-metrics>Waiting for server status…</p>
                <p class="updated"><span>Dashboard updated</span> <LocalTime value={model.updatedAt} /></p>
                <MobileSystemControls model={model} />
              </div>
              </details>
              <a href="/board#needs-you-heading" class="needs-you-link"><i class="andon andon--stop" aria-hidden="true" /><span><strong>{needsYouItems(model).total}</strong> {needsYouItems(model).total === 1 ? "needs" : "need"} you</span></a>
              <StickyFilterSummary model={model} />
              <span class="header-desktop-control"><RunnerStatus model={model} /></span>
              <span class="header-desktop-control"><HarnessUsage model={model} /></span>
              <span class="total-usage header-desktop-control" title={model.totalUsage}>{model.totalUsage}</span>
              <span class="header-desktop-control"><ThemeControl /></span>
              <a class={`header-link header-desktop-control${model.view === "notifications" ? " header-link--active" : ""}`} href="/settings/notifications" aria-current={model.view === "notifications" ? "page" : undefined}>Notifications</a>
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
            <Navigation model={model} />
          </div>
          {model.systemWarnings.length > 0 && <section class="system-warnings" role="alert"><h2>System attention</h2><ul>{model.systemWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
          <div class="content-anchor" id="content" tabIndex={-1} />
          {model.view === "board" && <><RepositoryWarnings model={model} /><Line model={model} /><BoardFilters model={model} /><NeedsYou model={model} /></>}
          {content}
          {model.selectedIssue && (
            <DetailsDialog
              issue={model.selectedIssue}
              id={`selected-issue-${model.selectedIssue.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${model.selectedIssue.number}`}
              selected
              canManage={canManageDashboard(model)}
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
