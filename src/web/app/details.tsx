// The details dialog's live tabs: the shared conversation, the stage journey and the technical logs.
// Each loads from its JSON endpoint when it is first shown, and reloads only when the item changed.

import { useEffect, useRef, useState } from "preact/hooks";

import { renderSafeMarkdown } from "../markdown";
import { FINDING_TYPES } from "../../engine/finding-types";
import type { FindingViewModel, IssueActivityViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRunEventViewModel, IssueRunViewModel } from "../types";
import { formatDateTime } from "./format";

type Load<T> = { status: "idle" | "loading" | "ready" | "failed"; data: T | null };

/** Fetches `url` as JSON while `active`, and again whenever `revision` changes. */
function useJson<T>(url: string, active: boolean, revision: unknown): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "idle", data: null });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setState((previous) => ({ status: previous.data ? "ready" : "loading", data: previous.data }));
    fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`request failed with ${response.status}`);
        setState({ status: "ready", data: await response.json() as T });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((previous) => ({ status: "failed", data: previous.data }));
      });
    return () => controller.abort();
  }, [url, active, JSON.stringify(revision)]);
  return state;
}

function Time({ value }: { value: string | null | undefined }) {
  return <time dateTime={value ?? ""}>{formatDateTime(value)}</time>;
}

const humanize = (value: string | null | undefined): string => String(value ?? "")
  .split(/[-_]/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

function actorInitials(name: string, type: string): string {
  if (type === "conveyor") return "C";
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((word) => word.charAt(0).toUpperCase()).join("") || "A";
}

function actorTone(name: string): number {
  let hash = 0;
  for (const character of name) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6 + 1;
}

function Avatar({ name, type, avatar }: { name: string; type: string; avatar: string | null | undefined }) {
  if (typeof avatar === "string" && avatar.length <= 8) return <span class="agent-avatar" aria-hidden="true">{avatar}</span>;
  return <span class={`agent-avatar agent-avatar--${actorTone(name)}`} aria-hidden="true">{actorInitials(name, type)}</span>;
}

export function ConversationPanel({ issueId, active, revision }: { issueId: string; active: boolean; revision: number | null }) {
  const { status, data } = useJson<IssueConversationViewModel>(`/api/issues/${encodeURIComponent(issueId)}/conversation`, active, revision);
  const list = useRef<HTMLOListElement>(null);
  const messages = data?.messages ?? [];
  useEffect(() => {
    // A reader at the bottom follows new messages; one reading back is left where they are.
    const element = list.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) element.scrollTop = element.scrollHeight;
  }, [messages.length]);
  const summary = status === "failed" && !data
    ? "Conversation is temporarily unavailable. Retrying…"
    : !data
    ? "Loading shared conversation…"
    : messages.length === 0
    ? "No shared messages yet."
    : `${messages.length} shared message${messages.length === 1 ? "" : "s"}.`;
  return <>
    <p class={`conversation-status${status === "loading" ? " status--loading" : ""}`} data-conversation-status>{summary}</p>
    <ol class="conversation-messages" data-conversation-messages ref={list}>
      {messages.map((message) => {
        const name = message.actorName || (message.actorType === "user" ? "User" : "Agent");
        return (
          <li key={message.id} class={`conversation-message conversation-message--${message.actorType.replace(/[^a-z0-9_-]/gi, "")}`}>
            <header>
              <span class="conversation-actor"><Avatar name={name} type={message.actorType} avatar={message.actorAvatar} /><strong>{name}{message.actorTitle ? ` · ${message.actorTitle}` : ""}</strong></span>
              <small>{message.stageId ? `${message.stageId} · ` : ""}<Time value={message.createdAt} /></small>
            </header>
            <div class="markdown" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(message.message) }} />
          </li>
        );
      })}
    </ol>
  </>;
}

function transitionTitle(kind: string, fromStage: string | null, toStage: string | null): string {
  const from = fromStage ? humanize(fromStage) : null;
  const to = toStage ? humanize(toStage) : null;
  if (kind === "onboarded") return `Entered ${to ?? "Conveyor"}`;
  if (kind === "correction") return `${from ?? "Stage"} returned to ${to ?? "previous stage"}`;
  if (kind === "stopped") return `${from ?? to ?? "Stage"} stopped`;
  if (kind === "resumed" || kind === "restarted") return `${to ?? from ?? "Stage"} ${kind}`;
  if (from && to && from !== to) return `${from} advanced to ${to}`;
  return `${to ?? from ?? "Stage"} completed`;
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value, location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** One stored finding with its type; a superuser also gets the control that changes the type. */
function FindingRow({ issueId, finding, csrfToken, canReclassify }: { issueId: string; finding: FindingViewModel; csrfToken: string; canReclassify: boolean }) {
  const [type, setType] = useState(finding.type);
  const [choice, setChoice] = useState(finding.type);
  const [status, setStatus] = useState<"idle" | "saving" | "failed">("idle");
  useEffect(() => { setType(finding.type); setChoice(finding.type); }, [finding.type]);
  const url = safeExternalUrl(finding.url);
  const save = async (event: Event) => {
    event.preventDefault();
    setStatus("saving");
    try {
      const response = await fetch(`/api/issues/${encodeURIComponent(issueId)}/findings/${encodeURIComponent(finding.id)}/type`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ type: choice }),
      });
      if (!response.ok) throw new Error(`request failed with ${response.status}`);
      setType(choice);
      setStatus("idle");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <li class="finding" data-finding-id={finding.id}>
      <header><strong class="finding-type" data-finding-type>{humanize(type)}</strong><span class="journey-kind">{humanize(finding.state)}</span></header>
      <p class="journey-meta">{finding.author}{finding.location && ` · ${finding.location}`}</p>
      {finding.summary && <p class="journey-reason">{finding.summary}</p>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Open on the code host ↗</a>}
      {canReclassify && (
        <form class="finding-type-form" onSubmit={(event) => void save(event)}>
          <label>Type <select name="type" value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
            {FINDING_TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </select></label>
          <button type="submit" class="action-button action-button--secondary" disabled={status === "saving" || choice === type}>Change type</button>
          {status === "failed" && <small class="journey-lifecycle" role="alert">The type could not be changed.</small>}
        </form>
      )}
    </li>
  );
}

export function JourneyPanel({ issueId, active, revision, csrfToken, canReclassify }: { issueId: string; active: boolean; revision: unknown; csrfToken: string; canReclassify: boolean }) {
  const { status, data } = useJson<IssueJourneyViewModel>(`/api/issues/${encodeURIComponent(issueId)}/journey`, active, revision);
  const findings = data?.findings ?? [];
  const transitions = data?.transitions ?? [];
  const skipped = data?.skippedReviews ?? [];
  const summary = status === "failed" && !data
    ? "Journey is temporarily unavailable. Retry by reopening this tab."
    : !data
    ? "Loading stage journey…"
    : transitions.length === 0 && skipped.length === 0
    ? "No stage changes or ignored native reviews have been recorded yet."
    : `${transitions.length} recorded stage change${transitions.length === 1 ? "" : "s"}; ${skipped.length} ignored native review${skipped.length === 1 ? "" : "s"}.`;
  const now = data?.now ?? null;
  return <>
    <p class={`journey-status${status === "loading" ? " status--loading" : ""}`} data-journey-status>{summary}</p>
    {findings.length > 0 && (
      <section class="findings" data-findings>
        <h3>Review findings</h3>
        <ul class="finding-list">{findings.map((finding) => <FindingRow key={finding.id} issueId={issueId} finding={finding} csrfToken={csrfToken} canReclassify={canReclassify} />)}</ul>
      </section>
    )}
    <ol class="journey-list" data-journey-list>
      {transitions.map((transition) => {
        const kind = (transition.kind || "observed").replace(/[^a-z0-9_-]/gi, "");
        return (
          <li key={transition.id} class={`journey-entry journey-entry--${kind}`}>
            <header><strong>{transitionTitle(kind, transition.fromStage, transition.toStage)}</strong><span class={`journey-kind journey-kind--${kind}`}>{humanize(kind)}</span></header>
            <p class="journey-meta">{transition.actor || "Conveyor"} · <Time value={transition.createdAt} /></p>
            {transition.reason && <p class="journey-reason">{transition.reason}</p>}
            {transition.requiredFixes.length > 0 && <ul>{transition.requiredFixes.map((fix) => <li key={fix}>{fix}</li>)}</ul>}
            {transition.status !== "completed" && <small class="journey-lifecycle">Transition {transition.status || "pending"}</small>}
          </li>
        );
      })}
      {skipped.map((review) => {
        const url = safeExternalUrl(review.url);
        return (
          <li key={`${review.url}:${review.skippedAt}`} class="journey-entry journey-entry--ignored-review">
            <header><strong>Native review ignored by trust safeguards</strong><span class="journey-kind">{review.active ? "Ignored" : "Previously ignored"}</span></header>
            <p class="journey-meta">{review.author ?? "Unknown author"} · <Time value={review.skippedAt} /></p>
            {url && <a href={url} target="_blank" rel="noopener noreferrer">Open review ↗</a>}
          </li>
        );
      })}
      {now && (
        <li class="journey-entry journey-entry--now">
          <header>
            <strong>{now.state === "done" || now.state === "completed" ? "Done" : `${now.stage ? `${humanize(now.stage)} · ` : ""}${humanize(now.state || "active")}`}</strong>
            <span class="journey-kind">Now</span>
          </header>
          {now.since && <p class="journey-meta">Since <Time value={now.since} /></p>}
          {now.reason && <p class="journey-reason">{now.reason}</p>}
        </li>
      )}
    </ol>
  </>;
}

const payloadText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

function RunEvents({ issueId, run }: { issueId: string; run: IssueRunViewModel }) {
  const [older, setOlder] = useState<IssueRunEventViewModel[]>([]);
  const [next, setNext] = useState<number | null>(run.nextEventBefore);
  const [loading, setLoading] = useState<"idle" | "loading" | "failed">("idle");
  const loadOlder = async () => {
    if (next === null) return;
    setLoading("loading");
    try {
      const url = new URL(`/api/issues/${encodeURIComponent(issueId)}/activity/runs/${encodeURIComponent(run.id)}/events`, location.origin);
      url.searchParams.set("before", String(next));
      const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("event request failed");
      const page = await response.json() as { events: IssueRunEventViewModel[]; nextEventBefore: number | null };
      setOlder((previous) => [...previous, ...page.events]);
      setNext(page.nextEventBefore);
      setLoading("idle");
    } catch {
      setLoading("failed");
    }
  };
  const events = [...run.events, ...older];
  return <>
    <ol class="activity-events">
      {events.map((event) => (
        <li key={event.sequence}>
          <div><strong>{event.type || "event"}</strong><Time value={event.createdAt} /></div>
          <pre>{payloadText(event.payload)}</pre>
        </li>
      ))}
    </ol>
    {next !== null && <div class="activity-more"><button type="button" class="action-button action-button--secondary" disabled={loading === "loading"} onClick={() => void loadOlder()}>{loading === "failed" ? "Retry loading older events" : "Load older events"}</button></div>}
    {events.length === 0 && (run.result === null || run.result === undefined) && (
      <p class="details-empty">{run.status === "running" ? "Waiting for the first recorded event…" : "No event payloads were recorded."}</p>
    )}
  </>;
}

export function ActivityPanel({ issueId, active, revision }: { issueId: string; active: boolean; revision: unknown }) {
  // A running item's log grows without the item changing, so it is read again every few seconds while shown.
  const [tick, setTick] = useState(0);
  const { status, data } = useJson<IssueActivityViewModel>(`/api/issues/${encodeURIComponent(issueId)}/activity`, active, [revision, tick]);
  const running = data?.runs.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!active || !running) return;
    const timer = setTimeout(() => setTick((value) => value + 1), 3_000);
    return () => clearTimeout(timer);
  }, [active, running, data]);
  const [older, setOlder] = useState<{ runs: IssueRunViewModel[]; next: string | null; state: "idle" | "loading" | "failed" }>({ runs: [], next: null, state: "idle" });
  const nextBefore = older.runs.length > 0 ? older.next : data?.nextRunBefore ?? null;
  const loadOlder = async () => {
    if (!nextBefore) return;
    setOlder((previous) => ({ ...previous, state: "loading" }));
    try {
      const url = new URL(`/api/issues/${encodeURIComponent(issueId)}/activity`, location.origin);
      url.searchParams.set("before", nextBefore);
      const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("activity request failed");
      const page = await response.json() as IssueActivityViewModel;
      setOlder((previous) => ({ runs: [...previous.runs, ...page.runs], next: page.nextRunBefore, state: "idle" }));
    } catch {
      setOlder((previous) => ({ ...previous, state: "failed" }));
    }
  };
  const recent = data?.runs ?? [];
  const seen = new Set(recent.map((run) => run.id));
  const runs = [...recent, ...older.runs.filter((run) => !seen.has(run.id))];
  const summary = status === "failed" && !data
    ? "Activity is temporarily unavailable. Retry by reopening this tab."
    : !data
    ? "Loading recent activity…"
    : runs.length === 0
    ? "No runs have been recorded for this issue."
    : `Showing ${runs.length} recent run${runs.length === 1 ? "" : "s"}.`;
  return <>
    <p class={`activity-status${status === "loading" ? " status--loading" : ""}`} data-activity-status>{summary}</p>
    <div data-activity-runs>
      {runs.map((run) => (
        <article class="activity-run" data-run-id={run.id} key={run.id}>
          <header><h3>{run.stageId || "unknown"} · {run.kind || "run"} · attempt {run.attempt || 1}</h3><span class={`run-status run-status--${(run.status || "unknown").replace(/[^a-z0-9_-]/gi, "")}`}>{run.status || "unknown"}</span></header>
          <p class="activity-run-time"><Time value={run.startedAt} /> → {run.finishedAt ? <Time value={run.finishedAt} /> : "now"}</p>
          {run.result !== null && run.result !== undefined && <details><summary>Final result</summary><pre>{payloadText(run.result)}</pre></details>}
          <RunEvents issueId={issueId} run={run} />
        </article>
      ))}
      {nextBefore && <div class="activity-more"><button type="button" class="action-button action-button--secondary" disabled={older.state === "loading"} onClick={() => void loadOlder()}>{older.state === "failed" ? "Retry loading older runs" : "Load older runs"}</button></div>}
    </div>
  </>;
}
