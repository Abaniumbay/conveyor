// The dashboard application: loads the live model once, then redraws from the patches the server
// streams. Preact compares each new view with the last one, so only what changed touches the page.

import { render } from "preact";

import { DashboardBody, LiveDetailsContext, prepareDashboardRender, viewTitle, type LiveDetails } from "../render";
import { olderDoneSchema, type DashboardItem } from "../model";
import type { IssueCardViewModel, RecentActivityViewModel, SteeringEventViewModel } from "../types";
import { afterRender, bindBoardBehaviour, captureReadingPosition, restoreReadingPosition, showConnection, view } from "./behaviour";
import { boardSelectionFromUrl, boardViewModel, itemTabOf, selectedItem, viewDataUrl, type BoardSelection, type ViewData } from "./derive";
import { ActivityPanel, ConversationPanel, JourneyPanel } from "./details";
import { LiveStore } from "./store";

const root = document.getElementById("app");
if (!root) throw new Error("the dashboard root is missing");

const store = new LiveStore({
  fetch: (input, init) => fetch(input, init),
  openStream: (url) => new EventSource(url),
  onSignedOut: () => {
    location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
  },
});

/** The open item's tabs, loaded from their endpoints and reloaded when the item changes. */
function liveDetails(issue: IssueCardViewModel): LiveDetails {
  const item = store.state?.model.items[issue.id];
  return {
    tab: view.tab,
    conversation: <ConversationPanel issueId={issue.id} active={view.tab === "conversation"} revision={item?.conversation ?? null} />,
    journey: <JourneyPanel issueId={issue.id} active={view.tab === "journey"} revision={[issue.stage, issue.state, issue.stateChangedAt]} />,
    activity: <ActivityPanel issueId={issue.id} active={view.tab === "activity"} revision={[issue.activity, issue.working, issue.stateChangedAt]} />,
  };
}

let frame: number | null = null;
let bound = false;
/** The address last drawn: a redraw of the same address keeps the reader's place, a new one starts at the top. */
let drawnAddress: string | null = null;

/** The Recent page for the address: loaded when Recent is shown, and again after changes arrive. */
const recent: { key: string | null; page: RecentActivityViewModel | null; timer: ReturnType<typeof setTimeout> | null; seq: number } = { key: null, page: null, timer: null, seq: -1 };

function loadRecent(key: string): void {
  recent.key = key;
  void fetch(`/api/v1/recent${key}`, { headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) return location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      if (!response.ok || recent.key !== key) return;
      recent.page = await response.json() as RecentActivityViewModel;
      schedule();
    })
    .catch(() => { /* The feed shows its last page; the next change tries again. */ });
}

function syncRecent(view: string, seq: number): void {
  if (view !== "recent") {
    recent.key = null;
    recent.page = null;
    return;
  }
  const key = location.search;
  if (recent.key !== key) {
    recent.page = null;
    recent.seq = seq;
    loadRecent(key);
  } else if (seq !== recent.seq && recent.timer === null) {
    // A change can add an entry; read the page again once a burst has passed.
    recent.seq = seq;
    recent.timer = setTimeout(() => {
      recent.timer = null;
      if (recent.key !== null) loadRecent(recent.key);
    }, 1_000);
  }
}

/** What the shown view loaded for itself (Team, Reports, Operator, …), by the address it was loaded for. */
const viewData: { url: string | null; data: ViewData | null } = { url: null, data: null };

function syncViewData(url: string | null): void {
  if (url === viewData.url) return;
  viewData.url = url;
  viewData.data = null;
  stopSteering();
  if (url === null) return;
  void fetch(url, { headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) return location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      if (viewData.url !== url) return;
      const body: unknown = await response.json().catch(() => null);
      viewData.data = response.ok && body && typeof body === "object" ? body as ViewData : {};
      followSteering();
      schedule();
    })
    .catch(() => { /* The view stays empty; reopening it tries again. */ });
}

/** A running Operator run streams its conversation; it is appended as it arrives. */
let steeringSource: EventSource | null = null;

function stopSteering(): void {
  steeringSource?.close();
  steeringSource = null;
}

function followSteering(): void {
  const selected = viewData.data?.steering?.selected;
  if (!selected || selected.status !== "running" || steeringSource) return;
  const url = viewData.url;
  const last = selected.events.at(-1)?.sequence ?? 0;
  const source = new EventSource(`/steering/${encodeURIComponent(selected.id)}/events?after=${last}`);
  steeringSource = source;
  source.addEventListener("update", (message) => {
    const current = viewData.data?.steering?.selected;
    if (viewData.url !== url || !current) return;
    try {
      const event = JSON.parse(message.data) as SteeringEventViewModel;
      if (!Number.isSafeInteger(event.sequence) || current.events.some((existing) => existing.sequence === event.sequence)) return;
      viewData.data = { ...viewData.data, steering: { ...viewData.data!.steering!, selected: { ...current, events: [...current.events, event] } } };
      schedule();
    } catch { /* A malformed event is skipped. */ }
  });
  source.addEventListener("done", () => {
    stopSteering();
    // The finished run's status and final report come with a fresh read.
    if (viewData.url === url) {
      viewData.url = null;
      setTimeout(schedule, 500);
    }
  });
}

/** Finished items matching the board's search or repositories, searched on the server among all of them. */
const doneSearch: { key: string | null; items: DashboardItem[] | null; timer: ReturnType<typeof setTimeout> | null } = { key: null, items: null, timer: null };

function syncDoneSearch(selection: BoardSelection): void {
  const q = selection.q.trim();
  const active = selection.view === "board" && (q !== "" || selection.repositoryIds.length > 0);
  const query = new URLSearchParams({ limit: String(selection.doneLimit) });
  if (q) query.set("q", q);
  for (const repository of selection.repositoryIds) query.append("repo", repository);
  const key = active ? `/api/v1/done?${query}` : null;
  if (key === doneSearch.key) return;
  doneSearch.key = key;
  if (doneSearch.timer !== null) clearTimeout(doneSearch.timer);
  doneSearch.timer = null;
  // The last matches stay until the new ones arrive, so the column does not flicker while typing.
  if (key === null) {
    doneSearch.items = null;
    return;
  }
  doneSearch.timer = setTimeout(() => {
    doneSearch.timer = null;
    void fetch(key, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
        if (!response.ok || doneSearch.key !== key) return;
        doneSearch.items = olderDoneSchema.parse(await response.json()).items;
        schedule();
      })
      .catch(() => { /* Done shows the matches among the items the browser holds. */ });
  }, 300);
}

/** An open item the live model does not hold (finished long ago or offboarded), loaded on its own. */
const outside: { key: string | null; item: IssueCardViewModel | null } = { key: null, item: null };

function syncOutsideItem(selection: BoardSelection): void {
  const state = store.state;
  const issue = selection.issue;
  const held = state && selectedItem(selection, [...Object.values(state.model.items), ...state.olderDone]);
  const key = issue && !held ? `/api/v1/items/${encodeURIComponent(issue.repository)}/${issue.number}` : null;
  if (key === outside.key) return;
  outside.key = key;
  outside.item = null;
  if (key === null) return;
  void fetch(key, { headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401) return location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      if (!response.ok || outside.key !== key) return;
      outside.item = await response.json() as IssueCardViewModel;
      schedule();
    })
    .catch(() => { /* The board shows without the item; opening it again tries again. */ });
}

function draw(): void {
  frame = null;
  const state = store.state;
  if (!state) return;
  // Rows being dragged or saved are moved by hand; the board redraws once they settle.
  if (view.backlogBusy) return;
  const from: unknown = history.state?.from;
  const selection = boardSelectionFromUrl(new URL(location.href), typeof from === "string" ? from : null);
  syncRecent(selection.view, state.seq);
  syncViewData(viewDataUrl(selection, location.search));
  syncOutsideItem(selection);
  syncDoneSearch(selection);
  const model = boardViewModel({
    model: state.model,
    account: state.account,
    csrfToken: state.csrfToken,
    selection,
    olderDone: state.olderDone,
    recent: recent.page,
    viewData: viewData.data,
    outsideItem: outside.item,
    doneMatches: doneSearch.items,
  });
  prepareDashboardRender(model);
  document.body.dataset.dashboardView = model.view;
  if (!model.selectedIssue) document.title = `${viewTitle(model)} · ${model.title}`;
  // The loading skeleton is the shell's own markup, not Preact's; it goes before the first draw.
  if (!bound) root!.replaceChildren();
  const address = location.pathname + location.search;
  const position = bound && address === drawnAddress ? captureReadingPosition(root!) : null;
  drawnAddress = address;
  render(<LiveDetailsContext.Provider value={liveDetails}><DashboardBody model={model} /></LiveDetailsContext.Provider>, root!);
  if (!bound) {
    bound = true;
    bindBoardBehaviour({ root: root!, store, redraw: schedule });
  }
  afterRender(root!, selection.agentId);
  if (position) restoreReadingPosition(root!, position);
  showConnection(root!, state);
  // Page parts with their own scripts (browser push settings) bind to what was drawn.
  document.dispatchEvent(new CustomEvent("conveyor:dashboard-rendered"));
}

/** Many patches in one moment draw once, on the next frame. */
function schedule(): void {
  if (frame === null) frame = requestAnimationFrame(draw);
}

/** Done shows as many finished items as the address asks for, loading older ones when needed. */
function ensureDone(): void {
  const state = store.state;
  if (!state) return;
  const limit = boardSelectionFromUrl(new URL(location.href)).doneLimit;
  const live = Object.values(state.model.items).filter((item) => item.placement === "done").length;
  if (limit > live && limit > state.olderDone.length && state.olderDone.length + live < state.model.system.doneTotal) void store.loadDone(limit);
}

// A change the view made itself (an account added or removed) reads its data again.
window.addEventListener("conveyor:view-data-stale", () => { viewData.url = null; });
// An item address can name the tab to open (`/issues/<repository>/<n>/journey`).
view.tab = itemTabOf(location.pathname);
store.subscribe(schedule);
window.addEventListener("conveyor:done-limit", ensureDone);
window.addEventListener("popstate", schedule);
// A page that comes back (unlocked phone, restored tab, network again) checks its stream at once.
const checkStream = () => store.check();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkStream(); });
for (const type of ["focus", "online", "pageshow"]) window.addEventListener(type, checkStream);
setInterval(checkStream, 5_000);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
void store.start().then(ensureDone).catch(() => {
  root.querySelector("[data-app-skeleton]")?.setAttribute("data-failed", "true");
});
