// The dashboard application: loads the live model once, then redraws from the patches the server
// streams. Preact compares each new view with the last one, so only what changed touches the page.

import { render } from "preact";

import { DashboardBody, LiveDetailsContext, prepareDashboardRender, type LiveDetails } from "../render";
import type { IssueCardViewModel } from "../types";
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

function draw(): void {
  frame = null;
  const state = store.state;
  if (!state) return;
  // Rows being dragged or saved are moved by hand; the board redraws once they settle.
  if (view.backlogBusy) return;
  const model = boardViewModel({
    model: state.model,
    account: state.account,
    csrfToken: state.csrfToken,
    selection: boardSelectionFromUrl(new URL(location.href)),
    olderDone: state.olderDone,
  });
  prepareDashboardRender(model);
  if (!model.selectedIssue) document.title = `Board · ${model.title}`;
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
