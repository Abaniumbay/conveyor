// The board's interactions in the browser application. The shared components render plain markup
// with data attributes; these handlers act on it through event delegation and re-apply the
// reader's own choices (folds, filters, tracing) after every redraw. Actions are sent as commands;
// the board changes when their patches arrive, never by reloading anything.

import { serverStatusHasPressure, serverStatusMetrics } from "../server-status";
import { updateQuotaWindow, quotaCountdown } from "../../usage/quota-time";
import type { DetailTab } from "../render";
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

function writeBoardFilters(next: BoardFilters, redraw: () => void): void {
  const target = new URL(location.href);
  for (const key of ["repo", "q", "state"]) target.searchParams.delete(key);
  for (const repository of new Set(next.repositories.filter(Boolean))) target.searchParams.append("repo", repository);
  if (next.q) target.searchParams.set("q", next.q);
  if (next.state && FILTER_STATES.has(next.state)) target.searchParams.set("state", next.state);
  history.replaceState(history.state, "", target.pathname + target.search + target.hash);
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

/** Opens the selected item's dialog, closes any other, and marks the card behind it. */
function syncDialog(root: ParentNode): void {
  const selected = root.querySelector("dialog[data-selected-issue='true']");
  for (const dialog of root.querySelectorAll("dialog[open]")) if (dialog !== selected && dialog instanceof HTMLDialogElement) dialog.close();
  for (const card of root.querySelectorAll(".issue.is-selected")) card.classList.remove("is-selected");
  if (!(selected instanceof HTMLDialogElement)) return;
  const issueId = selected.getAttribute("data-issue-id") ?? "";
  for (const card of root.querySelectorAll(".issue[data-issue-id]")) if (card.getAttribute("data-issue-id") === issueId) card.classList.add("is-selected");
  if (!selected.open) {
    selected.showModal();
    const tab = selected.querySelector("[role='tab'][aria-selected='true']");
    if (tab instanceof HTMLElement) tab.focus({ preventScroll: true });
  }
  const heading = selected.querySelector(".details-header h2");
  if (heading) document.title = `#${selected.getAttribute("data-issue-number") ?? ""} ${heading.textContent ?? ""} · Conveyor`;
}

/** What every redraw re-applies. */
export function afterRender(root: ParentNode): void {
  localizeTimes(root);
  updateQuotaCountdowns(root);
  syncThemeControls(root);
  applyRowFolds(root);
  applyLineFold(root);
  applyBoardFilters(root);
  applyTrace(root);
  syncStickyHeight(root);
  syncDialog(root);
}

// ---------------------------------------------------------------------------------------------
// Navigation inside the application.

/** The application's address for an item, from a dashboard item link. */
function appItemPath(href: string): string | null {
  const match = /^\/issues\/([^/]+)\/([1-9]\d*)(?:\/(?:conversation|journey|logs))?$/.exec(new URL(href, location.origin).pathname);
  return match ? `/app/issues/${match[1]}/${match[2]}${location.search}` : null;
}

function openItem(repository: string, number: string, redraw: () => void): void {
  view.tab = "summary";
  history.pushState({ conveyorItem: true }, "", `/app/issues/${encodeURIComponent(repository)}/${encodeURIComponent(number)}${location.search}`);
  redraw();
}

function closeItem(redraw: () => void): void {
  if (!location.pathname.startsWith("/app/issues/")) return;
  history.pushState({}, "", `/app${location.search}`);
  document.title = "Board · Conveyor";
  redraw();
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

function formFields(form: HTMLFormElement, csrfToken: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const [name, value] of new FormData(form)) if (typeof value === "string") fields.append(name, value);
  fields.set("csrf", csrfToken);
  return fields;
}

async function submitForm(form: HTMLFormElement, csrfToken: string): Promise<boolean> {
  if (form.matches("[data-answer-form]")) {
    const button = form.querySelector("button[type='submit']");
    const status = form.querySelector("[data-answer-status]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return true;
    const label = button.textContent;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Answering…";
    if (status) status.textContent = "";
    try {
      await post(form.action, formFields(form, csrfToken));
      button.textContent = "Answered";
      if (status) status.textContent = "Answer recorded. The agent continues.";
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = label;
      if (status) status.textContent = error instanceof Error ? error.message : "Your answer could not be recorded. Try again.";
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
  if (form.matches("[data-retry-form], [data-resume-rollup-form]")) {
    const retry = form.matches("[data-retry-form]");
    const url = form.getAttribute(retry ? "data-retry-url" : "data-resume-rollup-url");
    const button = form.querySelector(retry ? "[data-retry-submit]" : "[data-resume-rollup-submit]");
    const status = form.querySelector(retry ? "[data-retry-status]" : "[data-resume-rollup-status]");
    const field = form.querySelector("textarea[name='note']");
    if (!url || !(button instanceof HTMLButtonElement)) return true;
    button.disabled = true;
    if (field instanceof HTMLTextAreaElement) field.disabled = true;
    if (status) status.textContent = retry ? "Retrying…" : "Resuming…";
    try {
      await post(url, new URLSearchParams({ ...(retry ? { note: field instanceof HTMLTextAreaElement ? field.value : "" } : {}), csrf: csrfToken }));
      if (status) status.textContent = retry ? "Retry accepted. A fresh attempt is queued." : "The parent is waiting for its children again.";
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
    const panel = form.closest("[data-conversation-url]");
    const url = panel?.getAttribute("data-conversation-url");
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
    const link = element(target, "a[href]", HTMLAnchorElement);
    if (link && event instanceof MouseEvent && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !link.target) {
      const item = appItemPath(link.href);
      if (item) {
        event.preventDefault();
        view.tab = "summary";
        history.pushState({ conveyorItem: true }, "", item);
        redraw();
        return;
      }
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && (url.pathname === "/board" || url.pathname === "/")) {
        event.preventDefault();
        history.pushState({}, "", `/app${url.search}${url.hash}`);
        redraw();
        return;
      }
      // Other views are still served by the server-rendered dashboard.
      return;
    }
    if (!target.closest(".card-open") && target.closest("a, button, input, textarea, select, label, form")) return;
    const card = target.closest(".issue[data-issue-id]");
    if (card) {
      const repository = card.getAttribute("data-board-repository") ?? "";
      const number = card.getAttribute("data-number") ?? "";
      if (repository && number) openItem(repository, number, redraw);
    }
  });

  root.addEventListener("close", (event) => {
    if (event.target instanceof HTMLDialogElement && event.target.matches("[data-selected-issue='true']")) closeItem(redraw);
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
    if (event.target instanceof HTMLInputElement && event.target.matches("[data-filter-search]")) writeBoardFilters(currentFilters(), redraw);
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.closest("[data-board-filters]")) return;
    const next = currentFilters();
    if (input.matches("[data-filter-repository]")) {
      next.repositories = [...root.querySelectorAll<HTMLInputElement>("[data-filter-repository]:checked")].map((choice) => choice.value);
    } else if (input.name === "state") {
      // Choosing the selected state again clears it.
      next.state = input.value === filtersFromUrl().state ? null : input.value;
    } else return;
    writeBoardFilters(next, redraw);
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-filter-clear]")) writeBoardFilters({ repositories: [], q: "", state: null }, redraw);
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
      writeBoardFilters(currentFilters(), redraw);
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
    if (form.matches(".logout-form")) return;
    event.preventDefault();
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
