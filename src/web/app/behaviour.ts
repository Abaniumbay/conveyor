// The board's interactions in the browser application. The shared components render plain markup
// with data attributes; these handlers act on it through event delegation and re-apply the
// reader's own choices (folds, filters, tracing) after every redraw. Actions are sent as commands;
// the board changes when their patches arrive, never by reloading anything.

import { serverStatusHasPressure, serverStatusMetrics } from "../server-status";
import { updateQuotaWindow, quotaCountdown } from "../../usage/quota-time";
import type { DetailTab } from "../render";
import { dashboardPath, isItemPath, itemTabOf } from "./derive";
import { formatBytes, formatClock, formatDateTime, formatElapsed } from "./format";
import type { LiveState, LiveStore } from "./store";

/** The reader's view state that lives outside the URL. */
export const view = {
  tab: "summary" as DetailTab,
  trace: null as string | null,
  /** A drag or a save is moving backlog rows; redraws wait for it. */
  backlogBusy: false,
};

const detailTab = (value: string | null): DetailTab =>
  value === "conversation" || value === "journey" || value === "activity" ? value : "summary";

const FOLDED_ROWS_KEY = "conveyor-folded-rows";
const foldedRows = new Set<string>();
try {
  const stored: unknown = JSON.parse(localStorage.getItem(FOLDED_ROWS_KEY) ?? "[]");
  if (Array.isArray(stored)) for (const id of stored) if (typeof id === "string") foldedRows.add(id);
} catch {
  // Storage can be unavailable (private windows); folds then last for the page.
}

const element = <T extends Element>(target: EventTarget | null, selector: string, type: new () => T): T | null => {
  if (!(target instanceof Element)) return null;
  const found = target.closest(selector);
  return found instanceof type ? found : null;
};

// ---------------------------------------------------------------------------------------------
// Re-applied after every redraw.

function localizeTimes(root: ParentNode): void {
  for (const time of root.querySelectorAll("time[datetime]:not([data-relative-time]):not([data-local-clock])")) {
    time.textContent = formatDateTime(time.getAttribute("datetime"));
  }
  for (const time of root.querySelectorAll("time[data-local-clock][datetime]")) time.textContent = formatClock(time.getAttribute("datetime"));
  for (const time of root.querySelectorAll("time[data-relative-time][datetime]")) {
    const changedAt = new Date(time.getAttribute("datetime") ?? "").getTime();
    if (!Number.isNaN(changedAt)) time.textContent = formatElapsed((Date.now() - changedAt) / 1000);
  }
}

function updateQuotaCountdowns(root: ParentNode): void {
  for (const quotaWindow of root.querySelectorAll("[data-quota-window]")) {
    if (quotaWindow instanceof HTMLElement) updateQuotaWindow(quotaWindow, quotaCountdown);
  }
}

function selectedTheme(): "system" | "light" | "dark" {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

function syncThemeControls(root: ParentNode): void {
  const selected = selectedTheme();
  for (const control of root.querySelectorAll("[data-theme-control]")) {
    const label = control.querySelector("[data-theme-label]");
    if (label) label.textContent = selected.charAt(0).toUpperCase() + selected.slice(1);
    for (const button of control.querySelectorAll("[data-theme-choice]")) {
      button.setAttribute("aria-pressed", button.getAttribute("data-theme-choice") === selected ? "true" : "false");
    }
  }
}

function setRowFolded(button: Element, folded: boolean): void {
  const cells = document.getElementById(button.getAttribute("aria-controls") ?? "");
  const rowBody = cells?.closest(".row-body");
  rowBody?.toggleAttribute("data-folded", folded);
  if (cells instanceof HTMLElement) cells.inert = folded;
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.setAttribute("aria-label", `${folded ? "Unfold" : "Fold"} ${button.getAttribute("data-fold-label") ?? "this row"}`);
}

function applyRowFolds(root: ParentNode): void {
  for (const button of root.querySelectorAll("[data-row-fold]")) setRowFolded(button, foldedRows.has(button.getAttribute("data-row-fold") ?? ""));
}

const narrow = () => window.matchMedia("(max-width: 760px)").matches;
const lineOpen = () => document.documentElement.dataset.line === "open" || (document.documentElement.dataset.line !== "closed" && !narrow());

function applyLineFold(root: ParentNode): void {
  const open = lineOpen();
  root.querySelector("[data-line-toggle]")?.setAttribute("aria-expanded", open ? "true" : "false");
  const stations = document.getElementById("line-stations");
  if (stations) stations.inert = !open;
}

const FILTER_STATES = new Set(["needs-you", "running", "waiting"]);

interface BoardFilters { repositories: string[]; q: string; state: string | null }

function filtersFromUrl(): BoardFilters {
  const params = new URLSearchParams(location.search);
  const states = params.getAll("state");
  return {
    repositories: [...new Set(params.getAll("repo").filter(Boolean))],
    q: params.getAll("q").length === 1 ? params.get("q") ?? "" : "",
    state: states.length === 1 && FILTER_STATES.has(states[0]!) ? states[0]! : null,
  };
}

const stationForCard = (card: Element): string | null =>
  card.getAttribute("data-board-station") ?? card.closest("[data-board-filter-station]")?.getAttribute("data-board-filter-station") ?? null;

function applyBoardFilters(root: ParentNode): void {
  const filter = root.querySelector("[data-board-filters]");
  const board = root.querySelector(".board");
  if (!filter || !board) return;
  filter.setAttribute("data-enhanced", "true");
  const values = filtersFromUrl();
  const repositories = new Set(values.repositories);
  const words = values.q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const cards = [...board.querySelectorAll<HTMLElement>("[data-filter-card]")];
  const matches = (card: Element) =>
    (repositories.size === 0 || repositories.has(card.getAttribute("data-board-repository") ?? "")) &&
    words.every((word) => (card.getAttribute("data-board-search") ?? "").includes(word)) &&
    (values.state === null || card.getAttribute("data-board-state") === values.state);
  for (const card of cards) {
    const visible = matches(card) && !(values.state !== null && stationForCard(card) === "done");
    card.hidden = !visible;
    const item = card.closest("li");
    if (item) item.hidden = !visible;
  }
  for (const row of board.querySelectorAll<HTMLElement>("[data-family-row]")) {
    const rowCards = [...row.querySelectorAll<HTMLElement>("[data-filter-card]")];
    row.hidden = rowCards.length > 0 && rowCards.every((card) => card.hidden);
  }
  const openCards = cards.filter((card) => stationForCard(card) !== "done");
  const visibleOpen = openCards.filter((card) => !card.hidden);
  const doneCards = cards.filter((card) => stationForCard(card) === "done");
  const byStation = new Map<string, number>();
  const bySignal = new Map<string, number>();
  for (const card of visibleOpen) {
    const station = stationForCard(card) ?? "";
    byStation.set(station, (byStation.get(station) ?? 0) + 1);
    const state = card.getAttribute("data-board-state");
    const signal = state === "needs-you" ? "stop" : state === "running" ? "run" : "wait";
    bySignal.set(`${station}:${signal}`, (bySignal.get(`${station}:${signal}`) ?? 0) + 1);
  }
  const active = values.repositories.length > 0 || words.length > 0 || values.state !== null;
  // Done holds the most recent finished items; a filter counts the ones loaded.
  const doneShown = values.state ? 0 : doneCards.filter((card) => !card.hidden).length;
  for (const count of root.querySelectorAll("[data-board-station-count], [data-board-line-count]")) {
    const station = count.getAttribute("data-board-station-count") ?? count.getAttribute("data-board-line-count");
    const total = Number(count.getAttribute("data-board-total") ?? 0);
    const value = station === "done" ? doneShown : byStation.get(station ?? "") ?? 0;
    count.textContent = active ? `${value} of ${total}` : String(total);
    if (count.hasAttribute("data-board-station-count")) count.setAttribute("aria-label", `${active ? `${value} of ${total}` : total} issues`);
  }
  for (const count of root.querySelectorAll("[data-board-signal-count]")) {
    const station = count.getAttribute("data-board-station") ?? "";
    const signal = count.getAttribute("data-board-signal-count") ?? "";
    const total = Number(count.getAttribute("data-board-total") ?? 0);
    const value = bySignal.get(`${station}:${signal}`) ?? 0;
    const small = count.querySelector("small");
    if (small) small.textContent = active ? `${value} of ${total}` : String(total);
    count.setAttribute("aria-label", `${active ? `${value} of ${total}` : total} ${signal === "run" ? "running" : signal === "wait" ? "waiting" : "stopped"}`);
  }
  for (const input of filter.querySelectorAll<HTMLInputElement>("[data-filter-repository]")) {
    input.checked = repositories.has(input.value);
    input.setAttribute("aria-pressed", input.checked ? "true" : "false");
  }
  for (const choice of filter.querySelectorAll("[data-filter-state]")) {
    const input = choice.querySelector("input");
    if (!input) continue;
    input.checked = input.value === values.state;
    choice.setAttribute("aria-pressed", input.checked ? "true" : "false");
  }
  const search = filter.querySelector("[data-filter-search]");
  if (search instanceof HTMLInputElement && document.activeElement !== search) search.value = values.q;
  const selectedCount = values.repositories.length + (words.length > 0 ? 1 : 0) + (values.state ? 1 : 0);
  const more = filter.querySelector("[data-filter-more]");
  if (more) {
    const counter = more.querySelector("[data-filter-count]");
    if (counter) counter.textContent = String(selectedCount);
    more.setAttribute("aria-label", `Filters (${selectedCount})`);
  }
  const labels = [
    ...values.repositories.map((repository) => [...filter.querySelectorAll<HTMLInputElement>("[data-filter-repository]")].find((input) => input.value === repository)?.closest("label")?.textContent?.trim() ?? repository),
    ...(words.length > 0 ? [`“${values.q.trim()}”`] : []),
    ...(values.state ? [filter.querySelector(`[data-filter-state="${values.state}"]`)?.textContent?.trim() ?? values.state] : []),
  ];
  const summary = filter.querySelector("[data-filter-summary]");
  if (summary) summary.textContent = `Showing ${visibleOpen.length} of ${openCards.length} active board items${labels.length ? ` · ${labels.join(", ")}` : ""}`;
  const sticky = root.querySelector("[data-sticky-filter-summary]");
  if (sticky instanceof HTMLElement) {
    const text = `Filters: ${labels.join(", ")}`;
    sticky.hidden = labels.length === 0;
    sticky.dataset.filterCount = String(labels.length);
    sticky.textContent = text;
    sticky.setAttribute("title", text);
  }
  const clear = filter.querySelector("[data-filter-clear]");
  if (clear instanceof HTMLElement) clear.hidden = !active;
}

/** Writes the filters to the address and applies them at once; the redraw then brings the rest (Done matches, counts). */
function writeBoardFilters(root: ParentNode, next: BoardFilters, redraw: () => void): void {
  const target = new URL(location.href);
  for (const key of ["repo", "q", "state"]) target.searchParams.delete(key);
  for (const repository of new Set(next.repositories.filter(Boolean))) target.searchParams.append("repo", repository);
  if (next.q) target.searchParams.set("q", next.q);
  if (next.state && FILTER_STATES.has(next.state)) target.searchParams.set("state", next.state);
  history.replaceState(history.state, "", target.pathname + target.search + target.hash);
  applyBoardFilters(root);
  redraw();
}

function applyTrace(root: ParentNode): void {
  type Node = { element: Element; waits: string[]; parts: string[] };
  const nodes = new Map<string, Node>();
  for (const element of root.querySelectorAll(".board article.issue[data-issue-id], .board [data-family-row]")) {
    const id = element.getAttribute("data-family-row") ?? element.getAttribute("data-issue-id");
    const ids = (name: string) => (element.getAttribute(name) ?? "").split(" ").filter(Boolean);
    if (id && !nodes.has(id)) nodes.set(id, { element, waits: ids("data-waits"), parts: ids("data-parts") });
  }
  if (view.trace !== null && !nodes.has(view.trace)) view.trace = null;
  const focus = view.trace;
  const upstream = new Set<string>();
  const downstream = new Set<string>();
  if (focus !== null) {
    const dependents = new Map<string, string[]>();
    for (const [id, node] of nodes) for (const wait of [...node.waits, ...node.parts]) dependents.set(wait, [...(dependents.get(wait) ?? []), id]);
    const walk = (next: (id: string) => string[], seen: Set<string>) => {
      const stack = [...next(focus)];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === focus || seen.has(id) || !nodes.has(id)) continue;
        seen.add(id);
        stack.push(...next(id));
      }
    };
    walk((id) => { const node = nodes.get(id); return node ? [...node.waits, ...node.parts] : []; }, upstream);
    walk((id) => dependents.get(id) ?? [], downstream);
  }
  document.body.classList.toggle("tracing", focus !== null);
  for (const [id, node] of nodes) {
    const role = focus === null ? null : id === focus ? "focus" : upstream.has(id) ? "up" : downstream.has(id) ? "down" : null;
    const holder = node.element.matches("[data-family-row]") ? node.element.querySelector(".family-head") : node.element.querySelector(".issue-kicker");
    let tag = holder?.querySelector(":scope > .trace-role") ?? null;
    if (!role) {
      node.element.removeAttribute("data-trace-role");
      tag?.remove();
      continue;
    }
    node.element.setAttribute("data-trace-role", role);
    if (!tag && holder) {
      tag = document.createElement("span");
      holder.append(tag);
    }
    if (tag) {
      tag.className = `trace-role trace-role--${role}`;
      tag.textContent = role === "focus" ? "Traced" : role === "up" ? "Holding it up" : "Waiting on it";
    }
  }
  for (const chip of root.querySelectorAll("[data-trace]")) chip.setAttribute("aria-pressed", focus !== null && chip.getAttribute("data-trace") === focus ? "true" : "false");
  // A trace opens the folded rows its chain runs through; once it clears, they fold again.
  applyRowFolds(root);
  if (focus !== null) {
    for (const button of root.querySelectorAll("[data-row-fold]")) {
      if (button.closest(".board-row")?.querySelector("[data-trace-role]")) setRowFolded(button, false);
    }
  }
  const banner = root.querySelector("[data-trace-banner]");
  if (!(banner instanceof HTMLElement)) return;
  banner.hidden = focus === null;
  const text = banner.querySelector("[data-trace-text]");
  const focusNode = focus === null ? undefined : nodes.get(focus);
  if (!text || focus === null || !focusNode) return;
  const numbers = (ids: Iterable<string>) => [...ids].map((id) => Number(nodes.get(id)?.element.getAttribute("data-number")) || 0).sort((a, b) => a - b).map((number) => `#${number}`).join(", ");
  const directDown = [...nodes].filter(([, node]) => node.waits.includes(focus)).map(([id]) => id);
  const directUp = [...focusNode.waits, ...focusNode.parts].filter((id) => nodes.has(id));
  const state = (focusNode.element.getAttribute("data-state-word") ?? "").toLowerCase();
  const held = directDown.length === 0 ? "" : `${directDown.length} ${directDown.length === 1 ? "waits on it" : "wait on it"} directly (${numbers(directDown)})${downstream.size > directDown.length ? `, ${downstream.size} in all` : ""}`;
  const holding = directUp.length === 0 ? "It waits on nothing." : `It waits on ${numbers(directUp)}${upstream.size > directUp.length ? `, ${upstream.size} in all.` : "."}`;
  text.textContent = `#${focusNode.element.getAttribute("data-number") ?? ""}${state ? ` (${state})` : ""}: ${held ? `${held}. ` : "Nothing waits on it. "}${holding}`;
}

function syncStickyHeight(root: ParentNode): void {
  const dashboard = root.querySelector("main.dashboard");
  const sticky = dashboard?.querySelector(".dashboard-sticky");
  if (dashboard instanceof HTMLElement && sticky instanceof HTMLElement) {
    dashboard.style.setProperty("--dashboard-sticky-height", `${sticky.getBoundingClientRect().height}px`);
  }
}

/** The connection and server status in the header, from the live state. */
export function showConnection(root: ParentNode, state: LiveState): void {
  const status = root.querySelector("[data-server-status]");
  if (!(status instanceof HTMLElement)) return;
  const label = state.connection === "signed-out" ? "Session ended" : state.connection === "live" ? "Connected" : "Reconnecting…";
  status.dataset.connected = state.connection === "live" ? "true" : "false";
  const word = status.querySelector("[data-connection-state]");
  if (word) word.textContent = label;
  const signIn = status.querySelector("[data-session-sign-in]");
  if (signIn instanceof HTMLAnchorElement) {
    signIn.hidden = state.connection !== "signed-out";
    signIn.href = `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  }
  const metrics = status.querySelector("[data-server-metrics]");
  const pressure = state.status ? serverStatusHasPressure(state.status) : false;
  if (metrics && state.status) {
    metrics.textContent = serverStatusMetrics(state.status, formatBytes, formatElapsed);
    metrics.classList.toggle("server-status-metrics--warning", pressure);
  }
  status.dataset.storagePressure = pressure ? "true" : "false";
  const warning = status.querySelector("[data-storage-warning]");
  if (warning instanceof HTMLElement) warning.hidden = !pressure;
  status.querySelector("summary")?.setAttribute("aria-label", `Connection state: ${label}${pressure ? "; storage pressure warning" : ""}`);
}

/** What had focus when a dialog opened, so focus goes back there when it closes. */
let opener: { element: Element | null; issueId: string } | null = null;

/** Gives focus back to what opened the closed dialog, or to its item's card when that was redrawn. */
function restoreFocus(root: ParentNode): void {
  const from = opener;
  opener = null;
  if (!from || (document.activeElement && document.activeElement !== document.body)) return;
  const fallback = [...root.querySelectorAll(".issue[data-issue-id] .card-open, [data-graph-node]")]
    .find((candidate) => (candidate.closest("[data-issue-id]")?.getAttribute("data-issue-id") ?? candidate.getAttribute("data-graph-node")) === from.issueId);
  const target = from.element?.isConnected ? from.element : fallback;
  if (target instanceof HTMLElement || target instanceof SVGElement) target.focus({ preventScroll: true });
}

/** Opens the selected item's (or agent's) dialog, closes any other, and marks the card behind it. */
function syncDialog(root: ParentNode, agentId: string | null): void {
  const agent = agentId === null ? null : [...root.querySelectorAll("dialog[data-agent-id]")].find((dialog) => dialog.getAttribute("data-agent-id") === agentId) ?? null;
  const selected = agent ?? root.querySelector("dialog[data-selected-issue='true']");
  // Only the dialogs the address opens are closed here; a stage's information stays open across redraws.
  for (const dialog of root.querySelectorAll("dialog.issue-details[open], dialog[data-agent-id][open]")) if (dialog !== selected && dialog instanceof HTMLDialogElement) dialog.close();
  for (const card of root.querySelectorAll(".issue.is-selected")) card.classList.remove("is-selected");
  if (!(selected instanceof HTMLDialogElement)) {
    restoreFocus(root);
    return;
  }
  const issueId = selected.getAttribute("data-issue-id") ?? "";
  for (const card of root.querySelectorAll(".issue[data-issue-id]")) if (card.getAttribute("data-issue-id") === issueId) card.classList.add("is-selected");
  if (!selected.open) {
    opener ??= { element: document.activeElement === document.body ? null : document.activeElement, issueId };
    selected.showModal();
    const tab = selected.querySelector("[role='tab'][aria-selected='true']");
    if (tab instanceof HTMLElement) tab.focus({ preventScroll: true });
  }
  const heading = selected.querySelector(".details-header h2");
  if (heading) document.title = `${agent ? "" : `#${selected.getAttribute("data-issue-number") ?? ""} `}${heading.textContent ?? ""} · Conveyor`;
}

/** Where the reader is: the card nearest the middle of the screen, its station, and the scroll offsets. */
export interface ReadingPosition {
  scrollX: number;
  boardY: number;
  scrollY: number;
  issue: { id: string; top: number } | null;
  stage: { id: string; left: number } | null;
}

const clampScroll = (value: number, maximum: number) => Math.min(Math.max(0, value), Math.max(0, maximum));
const documentScrollMaximum = () => Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);

/** Records what the reader is looking at before a redraw. */
export function captureReadingPosition(root: ParentNode): ReadingPosition {
  const board = root.querySelector<HTMLElement>(".board");
  const inView = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth;
  };
  const middle = window.innerHeight / 2;
  const issue = [...(board ?? root).querySelectorAll<HTMLElement>("article.issue[data-issue-id]")].filter(inView)
    .sort((left, right) => Math.abs(left.getBoundingClientRect().top - middle) - Math.abs(right.getBoundingClientRect().top - middle))[0];
  const boardBounds = board?.getBoundingClientRect();
  const mostInView = board && boardBounds ? [...board.querySelectorAll("[data-station-cell]")]
    .map((stage) => {
      const bounds = stage.getBoundingClientRect();
      return { stage, overlap: Math.max(0, Math.min(bounds.right, boardBounds.right) - Math.max(bounds.left, boardBounds.left)) };
    })
    .sort((left, right) => right.overlap - left.overlap)[0]?.stage : undefined;
  const stage = issue?.closest("[data-station-cell]") ?? mostInView;
  return {
    scrollX: board?.scrollLeft ?? 0,
    boardY: board?.scrollTop ?? 0,
    scrollY: window.scrollY,
    issue: issue ? { id: issue.dataset.issueId ?? "", top: issue.getBoundingClientRect().top } : null,
    stage: stage ? { id: stage.getAttribute("data-station-cell") ?? "", left: stage.getBoundingClientRect().left } : null,
  };
}

/**
 * Undoes only what a redraw moved: a scroller is written only when the reader's card or station
 * shifted, and then by that distance, so a scroll or fling in progress is never reset.
 */
export function restoreReadingPosition(root: ParentNode, position: ReadingPosition): void {
  const board = root.querySelector<HTMLElement>(".board");
  const issue = position.issue ? root.querySelector(`article.issue[data-issue-id="${CSS.escape(position.issue.id)}"]`) : null;
  if (issue && position.issue) {
    const shift = issue.getBoundingClientRect().top - position.issue.top;
    if (Math.abs(shift) >= 1) {
      // On wide screens the board scrolls vertically inside itself; on phones the page does.
      if (board && board.contains(issue) && board.scrollHeight > board.clientHeight) board.scrollTop = clampScroll(board.scrollTop + shift, board.scrollHeight - board.clientHeight);
      else window.scrollTo(0, clampScroll(window.scrollY + shift, documentScrollMaximum()));
    }
  } else {
    // The card the reader was looking at is gone: keep the offsets they had, within the new bounds.
    if (Math.abs(window.scrollY - position.scrollY) >= 1) window.scrollTo(0, clampScroll(position.scrollY, documentScrollMaximum()));
    if (board && Math.abs(board.scrollTop - position.boardY) >= 1) board.scrollTop = clampScroll(position.boardY, board.scrollHeight - board.clientHeight);
  }
  if (!board) return;
  const stage = position.stage ? board.querySelector(`[data-station-cell="${CSS.escape(position.stage.id)}"]`) : null;
  const drift = stage && position.stage ? stage.getBoundingClientRect().left - position.stage.left : board.scrollLeft - position.scrollX;
  if (Math.abs(drift) >= 1) board.scrollLeft = clampScroll(board.scrollLeft + (stage ? drift : -drift), board.scrollWidth - board.clientWidth);
}

/** What every redraw re-applies; `agentId` names the Team profile the address opens. */
export function afterRender(root: ParentNode, agentId: string | null = null): void {
  localizeTimes(root);
  updateQuotaCountdowns(root);
  syncThemeControls(root);
  applyRowFolds(root);
  applyLineFold(root);
  applyBoardFilters(root);
  applyTrace(root);
  syncStickyHeight(root);
  syncDialog(root, agentId);
}

// ---------------------------------------------------------------------------------------------
// Navigation inside the application.

/** The history state for an item opened over the current view, which stays behind it. */
function itemState(): { conveyorItem: true; from: string } {
  const from: unknown = history.state?.from;
  return { conveyorItem: true, from: isItemPath(location.pathname) && typeof from === "string" ? from : location.pathname };
}

function openItem(repository: string, number: string, redraw: () => void): void {
  view.tab = "summary";
  history.pushState(itemState(), "", `/issues/${encodeURIComponent(repository)}/${encodeURIComponent(number)}${location.search}`);
  redraw();
}

function closeItem(redraw: () => void): void {
  if (!isItemPath(location.pathname)) return;
  // An item opened from a view returns to it; one opened directly returns to the board.
  if (history.state?.conveyorItem === true && history.length > 1) history.back();
  else {
    history.pushState({}, "", `/${location.search}`);
    redraw();
  }
}

// ---------------------------------------------------------------------------------------------
// Actions.

async function post(url: string, fields: URLSearchParams): Promise<{ ok: true; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: fields,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = Object.fromEntries(Object.entries(parsed));
  } catch {
    // A plain-text error body is reported as it is.
  }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : text.trim() || `The request failed (${response.status}).`);
  return { ok: true, body };
}

function questionAnswer(form: HTMLFormElement): string | null {
  const custom = form.querySelector<HTMLInputElement>("[data-answer-free-text]");
  const choice = form.querySelector<HTMLInputElement>("[data-answer-choice]:checked");
  const customAnswer = custom?.value;
  if (form.dataset.answerSource === "free-text" && customAnswer?.trim()) return customAnswer;
  if (form.dataset.answerSource === "choice" && choice) return choice.value;
  if (customAnswer?.trim()) return customAnswer;
  return choice?.value ?? null;
}

function formFields(form: HTMLFormElement, csrfToken: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const [name, value] of new FormData(form)) if (typeof value === "string") fields.append(name, value);
  if (form.matches("[data-answer-form]")) {
    const answer = questionAnswer(form);
    fields.delete("answer");
    fields.delete("freeText");
    if (answer !== null) fields.set("answer", answer);
  }
  fields.set("csrf", csrfToken);
  return fields;
}

/** The forms the application sends itself; any other form posts to the server as it always did. */
const HANDLED_FORMS = "[data-answer-form], [data-manual-gate-form], [data-retry-form], [data-resume-form], [data-resume-rollup-form], [data-conversation-form], [data-repository-sync], [data-account-action-form], [data-profile-avatar-form], [data-account-create-form], form.agent-compose";

/** Shows a form's outcome in its status line. */
function formStatus(form: HTMLFormElement, message: string, error: boolean): void {
  const status = form.querySelector("[data-form-status]");
  if (!(status instanceof HTMLElement)) return;
  status.textContent = message;
  status.dataset.error = error ? "true" : "false";
}

async function submitAccountForm(form: HTMLFormElement, csrfToken: string, onDone: () => void): Promise<void> {
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  formStatus(form, "", false);
  try {
    const { body } = await post(form.action, formFields(form, csrfToken));
    const username = form.dataset.accountUsername ?? "the account";
    if (form.matches("[data-profile-avatar-form]")) {
      if (typeof body.avatar !== "string") throw new Error("The server returned an invalid profile update.");
      for (const avatar of document.querySelectorAll(".account-avatar, [data-profile-avatar]")) avatar.textContent = body.avatar;
      formStatus(form, "Saved.", false);
    } else if (form.matches("[data-account-create-form]") || form.hasAttribute("data-account-delete")) {
      // The list is read again with the new or removed account.
      onDone();
    } else {
      form.reset();
      formStatus(form, `Password reset for ${username}.`, false);
    }
  } catch (error) {
    formStatus(form, error instanceof Error ? error.message : "The change could not be saved.", true);
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

async function startSteering(form: HTMLFormElement, csrfToken: string, redraw: () => void): Promise<void> {
  const button = form.querySelector("button[type='submit']");
  const field = form.querySelector("textarea[name='prompt']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const { body } = await post("/steering", formFields(form, csrfToken));
    if (typeof body.runId !== "string") throw new Error("The server did not return the new run.");
    if (field instanceof HTMLTextAreaElement) field.value = "";
    history.pushState({}, "", `/operator/runs/${encodeURIComponent(body.runId)}`);
    redraw();
  } catch (error) {
    const hint = form.querySelector(".compose-actions span");
    if (hint) hint.textContent = error instanceof Error ? error.message : "The request could not be sent.";
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

async function submitForm(form: HTMLFormElement, csrfToken: string): Promise<boolean> {
  if (form.matches("[data-repository-sync]")) {
    const button = form.querySelector("[data-repository-sync-submit]");
    const status = form.closest("section")?.querySelector("[data-repository-sync-status]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Syncing…";
    if (status instanceof HTMLElement) {
      status.textContent = "Reading the repository from GitHub…";
      delete status.dataset.error;
    }
    try {
      const { body } = await post(form.action, new URLSearchParams({ csrf: csrfToken }));
      if (body.failed) throw new Error("GitHub could not be read; the repository status shows why.");
      if (status) status.textContent = `Synced ${typeof body.issues === "number" ? `${body.issues} issues` : "the repository"} just now.`;
    } catch (error) {
      if (status instanceof HTMLElement) {
        status.textContent = `Sync failed: ${error instanceof Error ? error.message : "unknown error"}`;
        status.dataset.error = "true";
      }
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Sync now";
    }
    return true;
  }
  if (form.matches("[data-answer-form]")) {
    const button = form.querySelector("button[type='submit']");
    const status = form.querySelector("[data-answer-status]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return true;
    if (questionAnswer(form) === null) {
      if (status instanceof HTMLElement) {
        status.textContent = "An answer is required.";
        status.dataset.error = "true";
      }
      return true;
    }
    const label = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Answering…";
    if (status instanceof HTMLElement) {
      status.textContent = "";
      delete status.dataset.error;
    }
    try {
      await post(form.action, formFields(form, csrfToken));
      button.textContent = "Answered";
      if (status instanceof HTMLElement) status.textContent = "Answer recorded. The agent continues.";
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = label;
      if (status instanceof HTMLElement) {
        status.textContent = error instanceof Error ? error.message : "Your answer could not be recorded. Try again.";
        status.dataset.error = "true";
      }
    }
    return true;
  }
  if (form.matches("[data-manual-gate-form]")) {
    const button = form.querySelector("button[type='submit']");
    const actions = form.closest(".manual-gate-actions");
    const status = actions?.querySelector("[data-manual-gate-status]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return true;
    const buttons = actions ? [...actions.querySelectorAll("button")] : [button];
    for (const each of buttons) each.disabled = true;
    button.setAttribute("aria-busy", "true");
    const isSwitch = button.getAttribute("role") === "switch";
    const label = button.innerHTML;
    if (isSwitch) button.setAttribute("aria-checked", button.getAttribute("aria-checked") === "true" ? "false" : "true");
    else button.textContent = "Approving…";
    if (status instanceof HTMLElement) {
      status.textContent = "";
      delete status.dataset.error;
    }
    try {
      await post(form.action, formFields(form, csrfToken));
      // The redraw does not undo what was set here by hand. The switch keeps its new position;
      // an approve button stays busy until the change removes it.
      for (const each of buttons) if (each !== button || isSwitch) each.disabled = false;
      if (isSwitch) button.removeAttribute("aria-busy");
    } catch (error) {
      for (const each of buttons) each.disabled = false;
      button.removeAttribute("aria-busy");
      if (isSwitch) button.setAttribute("aria-checked", button.getAttribute("aria-checked") === "true" ? "false" : "true");
      else button.innerHTML = label;
      if (status instanceof HTMLElement) {
        status.textContent = error instanceof Error ? error.message : "The gate could not be updated. Try again.";
        status.dataset.error = "true";
      }
    }
    return true;
  }
  if (form.matches("[data-retry-form], [data-resume-form], [data-resume-rollup-form]")) {
    const retry = form.matches("[data-retry-form]");
    const rollup = form.matches("[data-resume-rollup-form]");
    const url = form.getAttribute(retry ? "data-retry-url" : rollup ? "data-resume-rollup-url" : "data-resume-url");
    const button = form.querySelector(retry ? "[data-retry-submit]" : rollup ? "[data-resume-rollup-submit]" : "[data-resume-submit]");
    const status = form.querySelector(retry ? "[data-retry-status]" : rollup ? "[data-resume-rollup-status]" : "[data-resume-status]");
    const field = form.querySelector("textarea[name='note']");
    if (!url || !(button instanceof HTMLButtonElement)) return true;
    button.disabled = true;
    if (field instanceof HTMLTextAreaElement) field.disabled = true;
    if (status) status.textContent = retry ? "Retrying…" : "Resuming…";
    try {
      await post(url, new URLSearchParams({ ...(retry ? { note: field instanceof HTMLTextAreaElement ? field.value : "" } : {}), csrf: csrfToken }));
      if (status) status.textContent = retry ? "Retry accepted. A fresh attempt is queued." : rollup ? "The parent is waiting for its children again." : "Item resumed. It will begin or queue shortly.";
      if (field instanceof HTMLTextAreaElement) field.value = "";
    } catch (error) {
      if (status) status.textContent = `${retry ? "Retry" : "Resume"} failed${error instanceof Error ? `: ${error.message}` : "."}`;
      button.disabled = false;
    } finally {
      if (field instanceof HTMLTextAreaElement) field.disabled = false;
    }
    return true;
  }
  if (form.matches("[data-conversation-form]")) {
    const panel = form.closest("[data-detail-panel='conversation']");
    const issueId = form.closest("dialog[data-issue-id]")?.getAttribute("data-issue-id");
    const url = issueId ? `/api/issues/${encodeURIComponent(issueId)}/conversation` : null;
    const button = form.querySelector("button[type='submit']");
    const field = form.querySelector("textarea[name='message']");
    if (!url || !(field instanceof HTMLTextAreaElement)) return true;
    const message = field.value;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    field.value = "";
    field.disabled = true;
    try {
      // The conversation reloads itself when the patch for the new message arrives.
      await post(url, new URLSearchParams({ message, csrf: csrfToken }));
    } catch (error) {
      field.value = message;
      const status = panel?.querySelector("[data-conversation-status]");
      if (status) status.textContent = error instanceof Error ? error.message : "Message could not be sent. Please try again.";
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
      field.disabled = false;
      field.focus();
    }
    return true;
  }
  return false;
}

async function cardAction(button: HTMLButtonElement, url: string, done: string, failed: string, csrfToken: string): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await post(url, new URLSearchParams({ note: "", csrf: csrfToken }));
    button.textContent = done;
  } catch {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = failed;
  }
}

// Backlog ordering: drag a row or use its arrows. The row moves at once, the position is saved in
// the background, and a failed save puts it back. Redraws wait while rows are moving.
function showBacklogError(list: Element, message: string): void {
  const column = list.closest(".stage--backlog");
  if (!column) return;
  let note = column.querySelector(".backlog-error");
  if (!message) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.className = "backlog-error";
    note.setAttribute("role", "alert");
    column.append(note);
  }
  note.textContent = message;
}

function rememberPosition(row: Element): () => void {
  const list = row.parentElement;
  const next = row.nextElementSibling;
  return () => {
    if (!list) return;
    if (next && next.parentElement === list) list.insertBefore(row, next);
    else list.append(row);
  };
}

async function saveBacklogPosition(row: HTMLElement, restore: () => void, csrfToken: string, redraw: () => void): Promise<void> {
  const list = row.parentElement;
  if (!list) return;
  const next = row.nextElementSibling;
  const beforeIssueId = next instanceof HTMLElement && next.matches(".backlog-row") ? next.dataset.backlogId ?? "" : "";
  view.backlogBusy = true;
  row.classList.add("backlog-row--saving");
  try {
    await post("/backlog/move", new URLSearchParams({ csrf: csrfToken, issueId: row.dataset.backlogId ?? "", beforeIssueId }));
    showBacklogError(list, "");
  } catch (error) {
    restore();
    showBacklogError(list, error instanceof Error ? error.message : "The new order could not be saved.");
  } finally {
    row.classList.remove("backlog-row--saving");
    view.backlogBusy = false;
    redraw();
  }
}

// ---------------------------------------------------------------------------------------------

/** Binds the board's interactions once; they act on whatever the application has drawn. */
export function bindBoardBehaviour(options: { root: HTMLElement; store: LiveStore; redraw: () => void }): void {
  const { root, store, redraw } = options;
  const csrf = () => store.state?.csrfToken ?? "";
  const closeHeaderPopovers = (except: Element | null = null) => {
    for (const details of root.querySelectorAll<HTMLDetailsElement>(".dashboard-header details[open]")) if (details !== except) details.open = false;
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    closeHeaderPopovers(target.closest(".dashboard-header details"));

    const trace = element(target, "[data-trace]", HTMLButtonElement);
    if (trace) {
      const id = trace.getAttribute("data-trace");
      view.trace = id && view.trace !== id ? id : null;
      applyTrace(root);
      return;
    }
    if (target.closest("[data-trace-clear]")) {
      view.trace = null;
      applyTrace(root);
      return;
    }
    if (target.closest("[data-line-toggle]")) {
      const open = !lineOpen();
      document.documentElement.dataset.line = open ? "open" : "closed";
      try { localStorage.setItem("conveyor-line", open ? "open" : "closed"); } catch { /* Kept for the page. */ }
      applyLineFold(root);
      return;
    }
    const fold = element(target, "[data-row-fold]", HTMLButtonElement);
    if (fold) {
      const row = fold.getAttribute("data-row-fold");
      if (row) {
        if (foldedRows.has(row)) foldedRows.delete(row);
        else foldedRows.add(row);
        try { localStorage.setItem(FOLDED_ROWS_KEY, JSON.stringify([...foldedRows])); } catch { /* Kept for the page. */ }
        applyRowFolds(root);
        if (view.trace !== null) applyTrace(root);
      }
      return;
    }
    const retry = element(target, "[data-retry-card]", HTMLButtonElement);
    if (retry) {
      void cardAction(retry, retry.getAttribute("data-retry-url") ?? "", "Retry accepted", "Retry failed · try again", csrf());
      return;
    }
    const resumeItem = element(target, "[data-resume-card]", HTMLButtonElement);
    if (resumeItem) {
      void cardAction(resumeItem, resumeItem.getAttribute("data-resume-url") ?? "", "Item resumed", "Resume failed · try again", csrf());
      return;
    }
    const resume = element(target, "[data-resume-rollup-card]", HTMLButtonElement);
    if (resume) {
      void cardAction(resume, resume.getAttribute("data-resume-rollup-url") ?? "", "Waiting resumed", "Resume failed · try again", csrf());
      return;
    }
    const theme = element(target, "[data-theme-choice]", HTMLButtonElement);
    if (theme) {
      const choice = theme.getAttribute("data-theme-choice");
      if (choice !== "system" && choice !== "light" && choice !== "dark") return;
      if (choice === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = choice;
      try { localStorage.setItem("conveyor-theme", choice); } catch { /* Kept for the page. */ }
      syncThemeControls(root);
      const control = theme.closest("[data-theme-control]");
      if (control instanceof HTMLDetailsElement) control.open = false;
      return;
    }
    const dialog = target.closest("dialog");
    if (dialog instanceof HTMLDialogElement) {
      const tab = target.closest("[data-detail-tab]");
      if (tab) {
        view.tab = detailTab(tab.getAttribute("data-detail-tab"));
        redraw();
        return;
      }
      // A click on the backdrop (outside the dialog's box) closes it.
      if (target === dialog && dialog.open) {
        const box = dialog.getBoundingClientRect();
        const inside = event instanceof MouseEvent && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) dialog.close();
      }
      return;
    }
    // Graph nodes are SVG links, whose address and target are animated strings.
    const link = target.closest("a[href]");
    const href = link instanceof HTMLAnchorElement ? link.href : link instanceof SVGAElement ? link.href.baseVal : null;
    const opensElsewhere = link instanceof HTMLAnchorElement ? link.target !== "" : link instanceof SVGAElement && link.target.baseVal !== "";
    if (href !== null && event instanceof MouseEvent && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !opensElsewhere) {
      const url = new URL(href, location.href);
      const destination = url.origin === location.origin ? dashboardPath(url.pathname) : null;
      if (destination) {
        event.preventDefault();
        const item = isItemPath(destination);
        if (item) view.tab = itemTabOf(destination);
        // An item opens over the current view; any other view starts at the top.
        history.pushState(item ? itemState() : {}, "", `${destination}${item ? location.search : url.search}${url.hash}`);
        closeHeaderPopovers();
        redraw();
        if (!item) window.scrollTo(0, 0);
        return;
      }
      return;
    }
    const cancel = element(target, "[data-account-delete-cancel]", HTMLButtonElement);
    if (cancel) {
      const details = cancel.closest("details");
      if (details instanceof HTMLDetailsElement) {
        details.open = false;
        details.querySelector("summary")?.focus();
      }
      return;
    }
    if (!target.closest(".card-open") && target.closest("a, button, input, textarea, select, label, form")) return;
    // A stage's heading and its information button open the stage's dialog.
    const stageInfo = target.closest("[data-dialog-open]")?.getAttribute("data-dialog-open");
    const stageDialog = stageInfo ? document.getElementById(stageInfo) : null;
    if (stageDialog instanceof HTMLDialogElement && stageDialog.matches(".stage-dialog")) {
      if (!stageDialog.open) stageDialog.showModal();
      return;
    }
    const member = target.closest(".team-card");
    const profile = member?.querySelector("dialog[data-agent-id]");
    if (profile) {
      history.pushState({ conveyorAgent: true }, "", `/team/${encodeURIComponent(profile.getAttribute("data-agent-id") ?? "")}`);
      redraw();
      return;
    }
    // A family row's header opens its parent, which has no card of its own.
    const family = target.closest(".family-details") ? target.closest("[data-family-row]") : null;
    if (family) {
      const repository = family.querySelector(".family-head")?.getAttribute("data-board-repository") ?? "";
      const number = family.getAttribute("data-number") ?? "";
      if (repository && number) openItem(repository, number, redraw);
      return;
    }
    const card = target.closest(".issue[data-issue-id]");
    if (card) {
      const repository = card.getAttribute("data-board-repository") ?? "";
      const number = card.getAttribute("data-number") ?? "";
      if (repository && number) openItem(repository, number, redraw);
    }
  });

  root.addEventListener("close", (event) => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    if (event.target.matches("[data-selected-issue='true']")) closeItem(redraw);
    else if (event.target.matches("[data-agent-id]") && location.pathname.startsWith("/team/")) {
      history.pushState({}, "", "/team");
      redraw();
    }
  }, true);

  root.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.key === "Escape") {
      const open = root.querySelector(".dashboard-header details[open]");
      if (open instanceof HTMLDetailsElement) {
        event.preventDefault();
        open.open = false;
        open.querySelector("summary")?.focus();
        return;
      }
      if (!root.querySelector("dialog[open]") && view.trace !== null) {
        view.trace = null;
        applyTrace(root);
      }
      return;
    }
    const tab = target instanceof Element ? target.closest("[role='tab'][data-detail-tab]") : null;
    if (!tab) return;
    const tabs = [...(tab.closest("[role='tablist']")?.querySelectorAll("[data-detail-tab]") ?? [])];
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? tabs[(index + 1) % tabs.length]
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? tabs[(index - 1 + tabs.length) % tabs.length]
      : event.key === "Home" ? tabs[0]
      : event.key === "End" ? tabs[tabs.length - 1]
      : undefined;
    if (next instanceof HTMLElement) {
      event.preventDefault();
      view.tab = detailTab(next.getAttribute("data-detail-tab"));
      redraw();
      requestAnimationFrame(() => next.focus());
    }
  });

  root.addEventListener("toggle", (event) => {
    const opened = event.target;
    if (opened instanceof HTMLDetailsElement && opened.open && opened.matches(".dashboard-header details")) closeHeaderPopovers(opened);
  }, true);

  // Board filters.
  const currentFilters = (): BoardFilters => {
    const search = root.querySelector("[data-filter-search]");
    return { ...filtersFromUrl(), ...(search instanceof HTMLInputElement ? { q: search.value } : {}) };
  };
  root.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.matches("[data-answer-free-text]")) {
      const form = input.closest<HTMLFormElement>("[data-answer-form]");
      if (form) {
        const choice = form.querySelector<HTMLInputElement>("[data-answer-choice]:checked");
        if (input.value.trim()) form.dataset.answerSource = "free-text";
        else if (choice) form.dataset.answerSource = "choice";
        else delete form.dataset.answerSource;
      }
    }
    if (input.matches("[data-filter-search]")) writeBoardFilters(root, currentFilters(), redraw);
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.matches("[data-answer-choice]") && input.checked) {
      const form = input.closest<HTMLFormElement>("[data-answer-form]");
      if (form) form.dataset.answerSource = "choice";
    }
    if (!(input instanceof HTMLInputElement) || !input.closest("[data-board-filters]")) return;
    const next = currentFilters();
    if (input.matches("[data-filter-repository]")) {
      next.repositories = [...root.querySelectorAll<HTMLInputElement>("[data-filter-repository]:checked")].map((choice) => choice.value);
    } else if (input.name === "state") {
      // Choosing the selected state again clears it.
      next.state = input.value === filtersFromUrl().state ? null : input.value;
    } else return;
    writeBoardFilters(root, next, redraw);
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-filter-clear]")) {
      // The field empties at once; the board redraws on the next frame.
      const search = root.querySelector("[data-filter-search]");
      if (search instanceof HTMLInputElement) search.value = "";
      writeBoardFilters(root, { repositories: [], q: "", state: null }, redraw);
    }
    const more = target.closest("[data-filter-more]");
    if (more) {
      const expanded = more.getAttribute("aria-expanded") === "true";
      more.setAttribute("aria-expanded", expanded ? "false" : "true");
      more.closest("[data-board-filters]")?.toggleAttribute("data-filters-open", !expanded);
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-filter-form]")) {
      event.preventDefault();
      writeBoardFilters(root, currentFilters(), redraw);
      return;
    }
    if (form.matches("[data-backlog-list] .reorder form")) {
      event.preventDefault();
      if (view.backlogBusy) return;
      const row = form.closest(".backlog-row");
      const list = row?.parentElement;
      const direction = form.querySelector("input[name='direction']");
      if (!(row instanceof HTMLElement) || !list || !(direction instanceof HTMLInputElement)) return;
      const restore = rememberPosition(row);
      if (direction.value === "up") {
        const previous = row.previousElementSibling;
        if (!previous) return;
        list.insertBefore(row, previous);
      } else {
        const next = row.nextElementSibling;
        if (!next) return;
        list.insertBefore(row, next.nextElementSibling);
      }
      void saveBacklogPosition(row, restore, csrf(), redraw);
      return;
    }
    if (form.matches(".load-more")) {
      event.preventDefault();
      const limit = new FormData(form).get("doneLimit");
      const target = new URL(location.href);
      if (typeof limit === "string") target.searchParams.set("doneLimit", limit);
      history.replaceState(history.state, "", target.pathname + target.search + target.hash);
      window.dispatchEvent(new Event("conveyor:done-limit"));
      redraw();
      return;
    }
    if (form.getAttribute("method")?.toLowerCase() === "get" && form.hasAttribute("action")) {
      // A view's filter form (Graph, Recent): its fields become the address. Forms the page script
      // sends itself name no method, so they are not mistaken for one.
      const destination = dashboardPath(new URL(form.action, location.href).pathname);
      if (!destination) return;
      event.preventDefault();
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form)) if (typeof value === "string" && value !== "") query.append(name, value);
      const search = query.toString();
      history.pushState({}, "", `${destination}${search ? `?${search}` : ""}`);
      redraw();
      return;
    }
    if (!form.matches(HANDLED_FORMS)) return;
    event.preventDefault();
    if (form.matches("form.agent-compose")) return void startSteering(form, csrf(), redraw);
    if (form.matches("[data-account-action-form], [data-profile-avatar-form], [data-account-create-form]")) {
      return void submitAccountForm(form, csrf(), () => {
        window.dispatchEvent(new Event("conveyor:view-data-stale"));
        redraw();
      });
    }
    void submitForm(form, csrf());
  });

  let dragged: HTMLElement | null = null;
  let restoreDragged: (() => void) | null = null;
  let draggedFrom: Element | null = null;
  root.addEventListener("dragstart", (event) => {
    const row = event.target instanceof Element ? event.target.closest("[data-backlog-list] > .backlog-row") : null;
    if (!(row instanceof HTMLElement) || view.backlogBusy) return;
    dragged = row;
    restoreDragged = rememberPosition(row);
    draggedFrom = row.nextElementSibling;
    view.backlogBusy = true;
    row.classList.add("backlog-row--dragging");
    event.dataTransfer?.setData("text/plain", row.dataset.backlogId ?? "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  root.addEventListener("dragover", (event) => {
    const list = dragged?.parentElement;
    if (!dragged || !list || !(event.target instanceof Element) || !list.contains(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const target = event.target.closest(".backlog-row");
    if (!target || target === dragged || target.parentElement !== list) return;
    const box = target.getBoundingClientRect();
    list.insertBefore(dragged, event.clientY > box.top + box.height / 2 ? target.nextElementSibling : target);
  });
  root.addEventListener("drop", (event) => { if (dragged) event.preventDefault(); });
  root.addEventListener("dragend", () => {
    const row = dragged;
    const restore = restoreDragged;
    const from = draggedFrom;
    dragged = null;
    restoreDragged = null;
    draggedFrom = null;
    if (!row || !restore) return;
    row.classList.remove("backlog-row--dragging");
    view.backlogBusy = false;
    if (row.nextElementSibling === from) {
      redraw();
      return;
    }
    void saveBacklogPosition(row, restore, csrf(), redraw);
  });

  window.addEventListener("resize", () => syncStickyHeight(root));
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => applyLineFold(root));
  // Relative times and quota countdowns move on without new data.
  setInterval(() => {
    localizeTimes(root);
    updateQuotaCountdowns(root);
  }, 60_000);
  // Rows animate only after the first state is drawn, so loading the page does not replay a fold.
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("board-motion")));
}
