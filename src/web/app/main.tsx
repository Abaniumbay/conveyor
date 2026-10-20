// The dashboard application: loads the live model once, then redraws from the patches the server
// streams. Preact compares each new view with the last one, so only what changed touches the page.

import { render } from "preact";

import { DashboardBody, LiveDetailsContext, prepareDashboardRender, type LiveDetails } from "../render";
import type { IssueCardViewModel, RecentActivityViewModel } from "../types";
import { afterRender, bindBoardBehaviour, showConnection, view } from "./behaviour";
import { boardSelectionFromUrl, boardViewModel } from "./derive";
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

const VIEW_TITLES: Record<string, string> = { board: "Board", graph: "Graph", recent: "Recent", attention: "Label problems", repositories: "Repositories", repository: "Repository" };

function draw(): void {
  frame = null;
  const state = store.state;
  if (!state) return;
  // Rows being dragged or saved are moved by hand; the board redraws once they settle.
  if (view.backlogBusy) return;
  const selection = boardSelectionFromUrl(new URL(location.href));
  syncRecent(selection.view, state.seq);
  const model = boardViewModel({
    model: state.model,
    account: state.account,
    csrfToken: state.csrfToken,
    selection,
    olderDone: state.olderDone,
    recent: recent.page,
  });
  prepareDashboardRender(model);
  document.body.dataset.dashboardView = model.view;
  if (!model.selectedIssue) document.title = `${model.view === "repository" && model.repositoryId ? model.repositoryId : VIEW_TITLES[model.view] ?? "Board"} · ${model.title}`;
  // The loading skeleton is the shell's own markup, not Preact's; it goes before the first draw.
  if (!bound) root!.replaceChildren();
  render(<LiveDetailsContext.Provider value={liveDetails}><DashboardBody model={model} /></LiveDetailsContext.Provider>, root!);
  if (!bound) {
    bound = true;
    bindBoardBehaviour({ root: root!, store, redraw: schedule });
  }
  afterRender(root!);
  showConnection(root!, state);
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

store.subscribe(schedule);
window.addEventListener("conveyor:done-limit", ensureDone);
window.addEventListener("popstate", schedule);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
void store.start().then(ensureDone).catch(() => {
  root.querySelector("[data-app-skeleton]")?.setAttribute("data-failed", "true");
});
