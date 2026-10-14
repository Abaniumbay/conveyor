import { quotaCountdown, updateQuotaWindow } from "../usage/quota-time";

/** The quota helpers, embedded by their source; each must be self-contained (see updateQuotaWindow). */
export const quotaClient = `const quotaCountdown = ${quotaCountdown.toString()};
  const updateQuotaWindow = ${updateQuotaWindow.toString()};`;

type DashboardEventSource = {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
};

export function createDashboardEventConnection(options: {
  createEventSource?: () => DashboardEventSource;
  onConnectionChange: (connected: boolean) => void;
  onReconnect: () => void;
  onEvent: (type: string, event: { data: string }) => void;
  pageActive?: () => boolean;
  online?: () => boolean;
  now?: () => number;
  retryDelay?: number;
  staleAfter?: number;
  setTimeout?: (callback: () => void, delay: number) => any;
  clearTimeout?: (timer: any) => void;
  setInterval?: (callback: () => void, delay: number) => any;
  clearInterval?: (timer: any) => void;
}) {
  const createEventSource = options.createEventSource ?? (() => new EventSource('/events/dashboard'));
  const pageActive = options.pageActive ?? (() => document.visibilityState === 'visible');
  const online = options.online ?? (() => navigator.onLine);
  const now = options.now ?? (() => Date.now());
  const retryDelay = options.retryDelay ?? 5_000;
  const staleAfter = options.staleAfter ?? 30_000;
  const setTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const setWatchdog = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
  const clearWatchdog = options.clearInterval ?? ((timer) => clearInterval(timer));
  const eventTypes = ['status', 'revision', 'conversation', 'activity'];
  let source: DashboardEventSource | null = null;
  let retryTimer: any = null;
  let lastActivity = now();
  let opened = false;
  let closed = false;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  };
  const closeSource = () => {
    if (!source) return;
    const current = source;
    source = null;
    current.close();
  };
  const canConnect = () => !closed && pageActive() && online();
  const scheduleRetry = () => {
    if (!canConnect() || retryTimer !== null) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      open();
    }, retryDelay);
  };
  const reconnect = () => {
    options.onConnectionChange(false);
    closeSource();
    scheduleRetry();
  };
  const open = () => {
    if (!canConnect() || source) return;
    const current = createEventSource();
    source = current;
    lastActivity = now();
    current.onopen = () => {
      if (source !== current) return;
      lastActivity = now();
      clearRetry();
      options.onConnectionChange(true);
      if (opened) options.onReconnect();
      opened = true;
    };
    current.onerror = () => {
      if (source !== current) return;
      reconnect();
    };
    for (const type of eventTypes) current.addEventListener(type, (event) => {
      if (source !== current) return;
      lastActivity = now();
      options.onEvent(type, event);
    });
  };
  const check = () => {
    if (closed || !pageActive()) return;
    if (!online()) {
      options.onConnectionChange(false);
      closeSource();
      return;
    }
    if (!source || now() - lastActivity >= staleAfter) reconnect();
  };

  const watchdog = setWatchdog(check, Math.min(retryDelay, staleAfter));
  open();
  return {
    check,
    close: () => {
      closed = true;
      clearRetry();
      clearWatchdog(watchdog);
      closeSource();
    },
  };
}

/**
 * Makes `current` match `next` in place, touching only the nodes that differ, so what the reader is
 * looking at is never taken out of the page. Children are matched by item id or element id, then by
 * position. A card the server sent as a placeholder (`data-keep`) stands for the card this page
 * already holds with that revision; it throws when the page holds none, and the caller reloads.
 */
export function morphDashboard(current: any, next: any): void {
  const keyOf = (node: any): string | null => {
    if (node.nodeType !== 1) return null;
    const own = node.getAttribute("data-issue-id") || node.id;
    if (own) return node.tagName + "#" + own;
    const card = node.tagName === "LI" ? node.firstElementChild : null;
    const inner = card && card.getAttribute("data-issue-id");
    return inner ? "LI#" + inner : null;
  };
  const held = (placeholder: any): any => {
    const card = [...current.querySelectorAll("article[data-issue-id]")].find((candidate: any) =>
      candidate.getAttribute("data-issue-id") === placeholder.getAttribute("data-issue-id") &&
      candidate.getAttribute("data-card-revision") === placeholder.getAttribute("data-card-revision"));
    if (!card) throw new Error("the page does not hold a card the update kept");
    return card.cloneNode(true);
  };
  const adopt = (node: any): any => {
    if (node.nodeType !== 1) return current.ownerDocument.importNode(node, true);
    if (node.hasAttribute("data-keep")) return held(node);
    const copy = current.ownerDocument.importNode(node, true);
    for (const placeholder of copy.querySelectorAll("[data-keep]")) placeholder.replaceWith(held(placeholder));
    return copy;
  };
  const morph = (from: any, to: any): void => {
    if (to.nodeType === 1 && to.hasAttribute("data-keep")) {
      if (from.getAttribute("data-card-revision") !== to.getAttribute("data-card-revision")) from.replaceWith(held(to));
      return;
    }
    if (from.isEqualNode(to)) return;
    if (from.nodeType !== 1) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    for (const name of from.getAttributeNames()) {
      // A disclosure the reader opened stays open.
      if (!to.hasAttribute(name) && !(name === "open" && from.tagName === "DETAILS")) from.removeAttribute(name);
    }
    for (const name of to.getAttributeNames()) {
      if (from.getAttribute(name) !== to.getAttribute(name)) from.setAttribute(name, to.getAttribute(name));
    }
    const keyed = new Map<string, any>();
    for (const child of from.childNodes) {
      const key = keyOf(child);
      if (key && !keyed.has(key)) keyed.set(key, child);
    }
    // Everything before the cursor is in place; the cursor and what follows are still to be matched.
    let cursor: any = from.firstChild;
    for (const wanted of [...to.childNodes] as any[]) {
      const key = keyOf(wanted);
      let match: any = null;
      if (key) {
        match = keyed.get(key) ?? null;
        keyed.delete(key);
      } else {
        let candidate = cursor;
        while (candidate && keyOf(candidate)) candidate = candidate.nextSibling;
        if (candidate && candidate.nodeType === wanted.nodeType && candidate.nodeName === wanted.nodeName) match = candidate;
      }
      if (!match) {
        from.insertBefore(adopt(wanted), cursor);
        continue;
      }
      if (match === cursor) cursor = cursor.nextSibling;
      else from.insertBefore(match, cursor);
      morph(match, wanted);
    }
    while (cursor) {
      const stale = cursor;
      cursor = cursor.nextSibling;
      stale.remove();
    }
  };
  morph(current, next);
}

export function createDashboardNavigation<T>(options: {
  load: (target: T, historyMode: string) => Promise<boolean>;
  start: () => void;
  finish: () => void;
  fallback: (target: T) => void;
}) {
  let navigationVersion = 0;
  return async (target: T, historyMode = 'push') => {
    const requestVersion = ++navigationVersion;
    options.start();
    const loaded = await options.load(target, historyMode).catch(() => false);
    if (requestVersion !== navigationVersion) return true;
    options.finish();
    if (loaded) return true;
    options.fallback(target);
    return false;
  };
}

export const dashboardClient = String.raw`(() => {
  ${quotaClient}
  const createDashboardEventConnection = ${createDashboardEventConnection.toString()};
  const createDashboardNavigation = ${createDashboardNavigation.toString()};
  const morphDashboard = ${morphDashboard.toString()};
  const body = document.body;
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {});
  let board = document.querySelector('.board');
  let renderedUrl = location.pathname + location.search;
  const scrollKey = 'conveyor:scroll';
  let pendingRefresh = false;
  let conversationRefreshTimer = null;
  let journeyRefreshTimer = null;
  let summaryRefreshTimer = null;
  let activityRefreshTimer = null;

  const selectedTheme = () => {
    const theme = document.documentElement.dataset.theme;
    return theme === 'light' || theme === 'dark' ? theme : 'system';
  };
  const syncThemeControls = (root = document) => {
    const selected = selectedTheme();
    for (const control of root.querySelectorAll('[data-theme-control]')) {
      const label = control.querySelector('[data-theme-label]');
      if (label) label.textContent = selected.charAt(0).toUpperCase() + selected.slice(1);
      for (const button of control.querySelectorAll('[data-theme-choice]')) {
        button.setAttribute('aria-pressed', button.getAttribute('data-theme-choice') === selected ? 'true' : 'false');
      }
    }
  };
  const closeHeaderPopovers = (except = null) => {
    for (const details of document.querySelectorAll('.dashboard-header details[open]')) {
      if (details !== except) details.open = false;
    }
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem(scrollKey) || 'null');
    if (saved && Number.isFinite(saved.y)) window.scrollTo(0, saved.y);
    if (board && saved && Number.isFinite(saved.x)) board.scrollLeft = saved.x;
    sessionStorage.removeItem(scrollKey);
  } catch {}

  const preserveScroll = () => {
    try {
      sessionStorage.setItem(scrollKey, JSON.stringify({
        x: board ? board.scrollLeft : 0,
        y: window.scrollY,
      }));
    } catch {}
  };

  const conversationSnapshots = new WeakMap();
  const journeySnapshots = new WeakMap();

  const formatDateTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  };

  const formatClock = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  };

  const actorAvatar = (name, type, selectedAvatar) => {
    const avatar = document.createElement('span');
    if (typeof selectedAvatar === 'string' && selectedAvatar.length <= 8) {
      avatar.textContent = selectedAvatar;
      avatar.className = 'agent-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      return avatar;
    }
    const words = String(name || 'Agent').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    avatar.textContent = words.map((word) => word.charAt(0).toUpperCase()).join('') || 'A';
    let hash = 0;
    for (const character of String(name || 'Agent')) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    avatar.className = 'agent-avatar agent-avatar--' + (Math.abs(hash) % 6 + 1);
    avatar.setAttribute('aria-hidden', 'true');
    if (type === 'conveyor') avatar.textContent = 'C';
    return avatar;
  };

  // Plain-text messages with http(s) URLs made clickable. Built from text nodes
  // and anchors, never innerHTML, so message content cannot inject markup.
  const appendLinkedText = (parent, text) => {
    const pattern = /https?:\/\/[^\s<>"')\]]+/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      if (match.index > last) parent.append(text.slice(last, match.index));
      const link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
      last = match.index + url.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  };

  const appendInlineMarkdown = (parent, value) => {
    const pattern = /(\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > last) appendLinkedText(parent, value.slice(last, match.index));
      const token = match[0];
      let element = null;
      let content = '';
      if (token.charCodeAt(0) === 96) {
        element = document.createElement('code');
        content = token.slice(1, -1);
      } else if (token.startsWith('[')) {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        try {
          const url = new URL(parts ? parts[2] : '', location.origin);
          if (parts && (url.protocol === 'http:' || url.protocol === 'https:')) {
            element = document.createElement('a');
            element.href = url.href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
            content = parts[1];
          }
        } catch {}
      } else if (token.startsWith('**')) {
        element = document.createElement('strong');
        content = token.slice(2, -2);
      } else {
        element = document.createElement('em');
        content = token.slice(1, -1);
      }
      if (element) {
        appendLinkedText(element, content);
        parent.append(element);
      } else parent.append(token);
      last = match.index + token.length;
    }
    if (last < value.length) appendLinkedText(parent, value.slice(last));
  };

  const appendMarkdown = (parent, value) => {
    let list = null;
    for (const line of String(value).replace(/\r\n?/g, '\n').split('\n')) {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      const listName = bullet ? 'ul' : numbered ? 'ol' : null;
      if (listName) {
        if (!list || list.localName !== listName) {
          list = document.createElement(listName);
          parent.append(list);
        }
        const item = document.createElement('li');
        appendInlineMarkdown(item, (bullet || numbered)[1]);
        list.append(item);
      } else {
        list = null;
        if (!line.trim()) continue;
        const paragraph = document.createElement('p');
        appendInlineMarkdown(paragraph, line);
        parent.append(paragraph);
      }
    }
  };

  const localizeTimes = (root = document) => {
    for (const time of root.querySelectorAll('time[datetime]:not([data-relative-time]):not([data-local-clock])')) {
      time.textContent = formatDateTime(time.getAttribute('datetime'));
    }
    for (const time of root.querySelectorAll('time[data-local-clock][datetime]')) {
      time.textContent = formatClock(time.getAttribute('datetime'));
    }
    for (const time of root.querySelectorAll('time[data-relative-time][datetime]')) {
      const changedAt = new Date(time.getAttribute('datetime')).getTime();
      if (!Number.isNaN(changedAt)) time.textContent = formatElapsed((Date.now() - changedAt) / 1000);
    }
  };

  const updateQuotaCountdowns = () => {
    for (const quotaWindow of document.querySelectorAll('[data-quota-window]')) {
      if (quotaWindow instanceof HTMLElement) updateQuotaWindow(quotaWindow, quotaCountdown);
    }
  };

  const formatBytes = (value) => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
    return (amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)) + ' ' + units[index];
  };

  const formatElapsed = (secondsValue) => {
    const total = Math.max(0, Math.floor(Number(secondsValue) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  };

  const payloadText = (value) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  };

  const renderIssueConversation = (panel, conversation) => {
    const snapshot = JSON.stringify(conversation);
    if (conversationSnapshots.get(panel) === snapshot) return;
    conversationSnapshots.set(panel, snapshot);
    const root = panel.querySelector('[data-conversation-messages]');
    const status = panel.querySelector('[data-conversation-status]');
    if (!root || !status) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
    root.replaceChildren();
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    status.textContent = messages.length === 0
      ? 'No shared messages yet.'
      : messages.length + (messages.length === 1 ? ' shared message.' : ' shared messages.');
    for (const message of messages) {
      const item = document.createElement('li');
      item.className = 'conversation-message conversation-message--' + String(message.actorType || 'agent').replace(/[^a-z0-9_-]/gi, '');
      const header = document.createElement('header');
      const actor = document.createElement('strong');
      const actorName = String(message.actorName || (message.actorType === 'user' ? 'User' : 'Agent'));
      actor.textContent = actorName + (message.actorTitle ? ' · ' + String(message.actorTitle) : '');
      const identity = document.createElement('span');
      identity.className = 'conversation-actor';
      identity.append(actorAvatar(actorName, message.actorType, message.actorAvatar), actor);
      const meta = document.createElement('small');
      if (message.stageId) meta.append(String(message.stageId) + ' · ');
      const time = document.createElement('time');
      time.dateTime = String(message.createdAt || '');
      time.textContent = formatDateTime(message.createdAt);
      meta.append(time);
      const body = document.createElement('div');
      body.className = 'markdown';
      appendMarkdown(body, String(message.message || ''));
      header.append(identity, meta);
      item.append(header, body);
      root.append(item);
    }
    if (nearBottom) root.scrollTop = root.scrollHeight;
  };

  const loadIssueConversation = async (panel) => {
    if (panel.dataset.loading === 'true') return;
    const url = panel.dataset.conversationUrl;
    const status = panel.querySelector('[data-conversation-status]');
    if (!url) return;
    panel.dataset.loading = 'true';
    if (status) {
      status.classList.add('status--loading');
      if (!conversationSnapshots.has(panel)) status.textContent = 'Loading shared conversation…';
    }
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('conversation request failed');
      renderIssueConversation(panel, await response.json());
    } catch {
      if (status) status.textContent = 'Conversation is temporarily unavailable. Retrying…';
    } finally {
      delete panel.dataset.loading;
      if (status) status.classList.remove('status--loading');
    }
  };

  const humanize = (value) => String(value || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const renderIssueJourney = (panel, journey) => {
    const snapshot = JSON.stringify(journey);
    if (journeySnapshots.get(panel) === snapshot) return;
    journeySnapshots.set(panel, snapshot);
    const root = panel.querySelector('[data-journey-list]');
    const status = panel.querySelector('[data-journey-status]');
    if (!root || !status) return;
    root.replaceChildren();
    const transitions = Array.isArray(journey.transitions) ? journey.transitions : [];
    status.textContent = transitions.length === 0
      ? 'No stage changes have been recorded yet.'
      : transitions.length + (transitions.length === 1 ? ' recorded stage change.' : ' recorded stage changes.');
    // Oldest first, like the stored history; where the item is now comes last.
    const now = journey.now && typeof journey.now === 'object' ? journey.now : null;
    let nowItem = null;
    if (now) {
      const item = document.createElement('li');
      nowItem = item;
      item.className = 'journey-entry journey-entry--now';
      const header = document.createElement('header');
      const title = document.createElement('strong');
      title.textContent = now.state === 'done' || now.state === 'completed'
        ? 'Done'
        : (now.stage ? humanize(now.stage) + ' · ' : '') + humanize(now.state || 'active');
      const badge = document.createElement('span');
      badge.className = 'journey-kind';
      badge.textContent = 'Now';
      header.append(title, badge);
      item.append(header);
      if (now.since) {
        const meta = document.createElement('p');
        meta.className = 'journey-meta';
        const time = document.createElement('time');
        time.dateTime = String(now.since);
        time.textContent = formatDateTime(now.since);
        meta.append('Since ', time);
        item.append(meta);
      }
      if (now.reason) {
        const reason = document.createElement('p');
        reason.className = 'journey-reason';
        reason.textContent = String(now.reason);
        item.append(reason);
      }
    }
    for (const transition of transitions) {
      const item = document.createElement('li');
      const kind = String(transition.kind || 'observed').replace(/[^a-z0-9_-]/gi, '');
      item.className = 'journey-entry journey-entry--' + kind;
      const header = document.createElement('header');
      const title = document.createElement('strong');
      const from = transition.fromStage ? humanize(transition.fromStage) : null;
      const to = transition.toStage ? humanize(transition.toStage) : null;
      if (kind === 'onboarded') title.textContent = 'Entered ' + (to || 'Conveyor');
      else if (kind === 'correction') title.textContent = (from || 'Stage') + ' returned to ' + (to || 'previous stage');
      else if (kind === 'stopped') title.textContent = (from || to || 'Stage') + ' stopped';
      else if (kind === 'resumed' || kind === 'restarted') title.textContent = (to || from || 'Stage') + ' ' + kind;
      else if (from && to && from !== to) title.textContent = from + ' advanced to ' + to;
      else title.textContent = (to || from || 'Stage') + ' completed';
      const badge = document.createElement('span');
      badge.className = 'journey-kind journey-kind--' + kind;
      badge.textContent = humanize(kind);
      header.append(title, badge);
      const meta = document.createElement('p');
      meta.className = 'journey-meta';
      const time = document.createElement('time');
      time.dateTime = String(transition.createdAt || '');
      time.textContent = formatDateTime(transition.createdAt);
      meta.append(String(transition.actor || 'Conveyor'), ' · ', time);
      item.append(header, meta);
      if (transition.reason) {
        const reason = document.createElement('p');
        reason.className = 'journey-reason';
        reason.textContent = String(transition.reason);
        item.append(reason);
      }
      const fixes = Array.isArray(transition.requiredFixes) ? transition.requiredFixes : [];
      if (fixes.length > 0) {
        const list = document.createElement('ul');
        for (const fix of fixes) {
          const entry = document.createElement('li');
          entry.textContent = String(fix);
          list.append(entry);
        }
        item.append(list);
      }
      if (transition.status !== 'completed') {
        const lifecycle = document.createElement('small');
        lifecycle.className = 'journey-lifecycle';
        lifecycle.textContent = 'Transition ' + String(transition.status || 'pending');
        item.append(lifecycle);
      }
      root.append(item);
    }
    if (nowItem) root.append(nowItem);
  };

  const loadIssueJourney = async (panel) => {
    if (panel.dataset.loading === 'true') return;
    const url = panel.dataset.journeyUrl;
    const status = panel.querySelector('[data-journey-status]');
    if (!url) return;
    panel.dataset.loading = 'true';
    if (status) {
      status.classList.add('status--loading');
      if (!journeySnapshots.has(panel)) status.textContent = 'Loading stage journey…';
    }
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('journey request failed');
      renderIssueJourney(panel, await response.json());
    } catch {
      if (status) status.textContent = 'Journey is temporarily unavailable. Retry by reopening this tab.';
    } finally {
      delete panel.dataset.loading;
      if (status) status.classList.remove('status--loading');
    }
  };

  const activityEvent = (item) => {
    const eventItem = document.createElement('li');
    const meta = document.createElement('div');
    const type = document.createElement('strong');
    type.textContent = String(item.type || 'event');
    const time = document.createElement('time');
    time.dateTime = String(item.createdAt || '');
    time.textContent = formatDateTime(item.createdAt);
    meta.append(type, time);
    const payload = document.createElement('pre');
    payload.textContent = payloadText(item.payload);
    eventItem.append(meta, payload);
    return eventItem;
  };

  const moreButton = (label, attribute, cursor) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'activity-more';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute(attribute, String(cursor));
    wrapper.append(button);
    return wrapper;
  };

  const activityRun = (run) => {
    const article = document.createElement('article');
    article.className = 'activity-run';
    article.dataset.runId = String(run.id || '');
    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = String(run.stageId || 'unknown') + ' · ' + String(run.kind || 'run') + ' · attempt ' + String(run.attempt || 1);
    const badge = document.createElement('span');
    badge.className = 'run-status run-status--' + String(run.status || 'unknown').replace(/[^a-z0-9_-]/gi, '');
    badge.textContent = String(run.status || 'unknown');
    header.append(title, badge);
    const timing = document.createElement('p');
    timing.className = 'activity-run-time';
    const started = document.createElement('time');
    started.dateTime = String(run.startedAt || '');
    started.textContent = formatDateTime(run.startedAt);
    timing.append(started, ' → ');
    if (run.finishedAt) {
      const finished = document.createElement('time');
      finished.dateTime = String(run.finishedAt);
      finished.textContent = formatDateTime(run.finishedAt);
      timing.append(finished);
    } else timing.append('now');
    article.append(header, timing);
    if (run.result !== null && run.result !== undefined) {
      const result = document.createElement('details');
      const label = document.createElement('summary');
      label.textContent = 'Final result';
      const payload = document.createElement('pre');
      payload.textContent = payloadText(run.result);
      result.append(label, payload);
      article.append(result);
    }
    const events = Array.isArray(run.events) ? run.events : [];
    const list = document.createElement('ol');
    list.className = 'activity-events';
    for (const item of events) list.append(activityEvent(item));
    article.append(list);
    if (run.nextEventBefore) article.append(moreButton('Load older events', 'data-more-events', run.nextEventBefore));
    if (events.length === 0 && (run.result === null || run.result === undefined)) {
      const empty = document.createElement('p');
      empty.className = 'details-empty';
      empty.textContent = run.status === 'running' ? 'Waiting for the first recorded event…' : 'No event payloads were recorded.';
      article.append(empty);
    }
    return article;
  };

  const renderIssueActivity = (panel, activity, append = false) => {
    const runsRoot = panel.querySelector('[data-activity-runs]');
    const status = panel.querySelector('[data-activity-status]');
    if (!runsRoot || !status) return;
    const previousMore = runsRoot.querySelector('[data-more-runs]')?.closest('.activity-more');
    if (previousMore) previousMore.remove();
    if (!append) runsRoot.replaceChildren();
    const runs = Array.isArray(activity.runs) ? activity.runs : [];
    panel.dataset.live = runs.some((run) => run.status === 'running') ? 'true' : panel.dataset.live || 'false';
    for (const run of runs) {
      const existing = runsRoot.querySelector('[data-run-id="' + CSS.escape(String(run.id || '')) + '"]');
      if (existing) existing.replaceWith(activityRun(run));
      else runsRoot.append(activityRun(run));
    }
    if (activity.nextRunBefore) runsRoot.append(moreButton('Load older runs', 'data-more-runs', activity.nextRunBefore));
    const count = runsRoot.querySelectorAll('.activity-run').length;
    status.textContent = count === 0 ? 'No runs have been recorded for this issue.' : 'Showing ' + count + (count === 1 ? ' recent run.' : ' recent runs.');
  };

  const loadIssueActivity = async (panel, before = null, append = false) => {
    if (panel.dataset.loading === 'true') return;
    const baseUrl = panel.dataset.activityUrl;
    const status = panel.querySelector('[data-activity-status]');
    if (!baseUrl) return;
    const url = new URL(baseUrl, location.origin);
    if (before) url.searchParams.set('before', before);
    panel.dataset.loading = 'true';
    if (status) { status.classList.add('status--loading'); status.textContent = append ? 'Loading older runs…' : 'Loading recent activity…'; }
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('activity request failed');
      renderIssueActivity(panel, await response.json(), append);
    } catch {
      if (status) status.textContent = 'Activity is temporarily unavailable. Retry by reopening this tab.';
    } finally {
      delete panel.dataset.loading;
      if (status) status.classList.remove('status--loading');
    }
  };

  const scheduleConversationRefresh = () => {
    if (conversationRefreshTimer !== null) return;
    conversationRefreshTimer = setTimeout(() => {
      conversationRefreshTimer = null;
      const panel = document.querySelector('dialog[open] [data-detail-panel="conversation"]:not([hidden])');
      if (panel) void loadIssueConversation(panel);
    }, 250);
  };

  const scheduleJourneyRefresh = () => {
    if (journeyRefreshTimer !== null) return;
    journeyRefreshTimer = setTimeout(() => {
      journeyRefreshTimer = null;
      const panel = document.querySelector('dialog[open] [data-detail-panel="journey"]:not([hidden])');
      if (panel) void loadIssueJourney(panel);
    }, 250);
  };

  // An open issue dialog postpones the full board refresh (it would wipe what is being read or typed),
  // so its live parts are swapped in place: the status line, the todo checklist and the facts.
  const SUMMARY_LIVE_PARTS = ['.details-status', '.indicators', '.todos', '.details-facts'];
  const scheduleSummaryRefresh = () => {
    if (summaryRefreshTimer !== null) return;
    summaryRefreshTimer = setTimeout(async () => {
      summaryRefreshTimer = null;
      const dialog = document.querySelector('dialog[open][data-issue-id]');
      const panel = dialog && dialog.querySelector('[data-detail-panel="summary"]');
      if (!dialog || !panel) return;
      try {
        const response = await fetch(location.pathname + location.search, { headers: { accept: 'text/html' }, cache: 'no-store' });
        if (!response.ok) return;
        const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
        const issueId = dialog.getAttribute('data-issue-id');
        const candidates = [...nextDocument.querySelectorAll('dialog[data-issue-id]')].filter((candidate) => candidate.getAttribute('data-issue-id') === issueId);
        const next = candidates.find((candidate) => candidate.id === dialog.id) || candidates[0];
        const nextPanel = next && next.querySelector('[data-detail-panel="summary"]');
        if (!nextPanel) return;
        for (const selector of SUMMARY_LIVE_PARTS) {
          const current = panel.querySelector(selector);
          const replacement = nextPanel.querySelector(selector);
          if (current && replacement) current.replaceWith(document.importNode(replacement, true));
          else if (current) current.remove();
          else if (replacement) {
            // A part that appeared (a first todo list): place it where the server renders it.
            const anchor = panel.querySelector(selector === '.todos' ? '.criteria' : '.relationships, .todos, .criteria');
            if (anchor) anchor.before(document.importNode(replacement, true));
            else panel.append(document.importNode(replacement, true));
          }
        }
        localizeTimes(panel);
        // The card's progress bar behind the dialog follows too.
        const card = [...document.querySelectorAll('article[data-issue-id]')].find((candidate) => candidate.getAttribute('data-issue-id') === issueId);
        const nextCard = [...nextDocument.querySelectorAll('article[data-issue-id]')].find((candidate) => candidate.getAttribute('data-issue-id') === issueId);
        const progress = card && card.querySelector(':scope > .todo-progress');
        const nextProgress = nextCard && nextCard.querySelector(':scope > .todo-progress');
        if (progress && nextProgress) progress.replaceWith(document.importNode(nextProgress, true));
        else if (progress) progress.remove();
        else if (card && nextProgress) {
          const anchor = card.querySelector(':scope > .rollup-summary, :scope > dialog');
          if (anchor) anchor.before(document.importNode(nextProgress, true));
        }
        const chips = card && card.querySelector(':scope > .indicator-chips');
        const nextChips = nextCard && nextCard.querySelector(':scope > .indicator-chips');
        if (chips && nextChips) chips.replaceWith(document.importNode(nextChips, true));
        else if (chips) chips.remove();
        else if (card && nextChips) {
          const anchor = card.querySelector(':scope > .todo-progress, :scope > .rollup-summary, :scope > dialog');
          if (anchor) anchor.before(document.importNode(nextChips, true));
        }
      } catch {}
    }, 250);
  };

  const scheduleActivityRefresh = () => {
    if (activityRefreshTimer !== null) return;
    activityRefreshTimer = setTimeout(() => {
      activityRefreshTimer = null;
      const panel = document.querySelector('dialog[open] [data-detail-panel="activity"]:not([hidden])');
      if (panel) void loadIssueActivity(panel);
    }, 3_000);
  };

  const loadOlderEvents = async (button) => {
    const panel = button.closest('[data-activity-url]');
    const article = button.closest('[data-run-id]');
    const before = button.getAttribute('data-more-events');
    const baseUrl = panel && panel.getAttribute('data-activity-url');
    const runId = article && article.getAttribute('data-run-id');
    if (!panel || !article || !baseUrl || !runId || !before) return;
    button.disabled = true;
    try {
      const url = new URL(baseUrl + '/runs/' + encodeURIComponent(runId) + '/events', location.origin);
      url.searchParams.set('before', before);
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('event request failed');
      const page = await response.json();
      const list = article.querySelector('.activity-events');
      if (list) for (const item of Array.isArray(page.events) ? page.events : []) list.append(activityEvent(item));
      const wrapper = button.closest('.activity-more');
      if (page.nextEventBefore) button.setAttribute('data-more-events', String(page.nextEventBefore));
      else if (wrapper) wrapper.remove();
    } catch {
      button.textContent = 'Retry loading older events';
    } finally {
      button.disabled = false;
    }
  };

  const validDetailTab = (name) => name === 'conversation' || name === 'journey' || name === 'activity' ? name : 'summary';

  const paginationSearch = () => {
    const current = new URL(location.href);
    const kept = new URLSearchParams();
    for (const key of ['doneLimit', 'column', 'page']) {
      const values = current.searchParams.getAll(key);
      if (values.length === 1) kept.set(key, values[0]);
    }
    const query = kept.toString();
    return query ? '?' + query : '';
  };

  const parseDashboardPath = () => {
    const issue = /^\/issues\/([^/]+)\/([1-9]\d*)(?:\/(conversation|journey|logs))?$/.exec(location.pathname);
    if (issue) {
      try {
        return {
          issue: { repository: decodeURIComponent(issue[1]), number: issue[2] },
          tab: issue[3] === 'logs' ? 'activity' : validDetailTab(issue[3]),
          agent: null,
        };
      } catch {}
    }
    const agent = /^\/team\/([^/]+)$/.exec(location.pathname);
    if (agent) {
      try { return { issue: null, tab: 'summary', agent: decodeURIComponent(agent[1]) }; } catch {}
    }
    return { issue: null, tab: 'summary', agent: null };
  };

  const issuePath = (dialog, tab = 'summary') => {
    const repository = dialog.dataset.repositoryId || '';
    const number = dialog.dataset.issueNumber || '';
    const suffix = tab === 'conversation' || tab === 'journey'
      ? '/' + tab
      : tab === 'activity' ? '/logs' : '';
    return '/issues/' + encodeURIComponent(repository) + '/' + encodeURIComponent(number) + suffix + paginationSearch();
  };

  const selectDetailTab = (dialog, name, updateUrl = false) => {
    name = validDetailTab(name);
    for (const tab of dialog.querySelectorAll('[data-detail-tab]')) {
      const selected = tab.getAttribute('data-detail-tab') === name;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of dialog.querySelectorAll('[data-detail-panel]')) {
      const selected = panel.getAttribute('data-detail-panel') === name;
      panel.hidden = !selected;
      if (selected && name === 'activity') void loadIssueActivity(panel);
      if (selected && name === 'conversation') void loadIssueConversation(panel);
      if (selected && name === 'journey') void loadIssueJourney(panel);
    }
    if (updateUrl && dialog.dataset.issueId) {
      history.replaceState({ conveyorIssue: dialog.dataset.issueId, conveyorTab: name }, '', issuePath(dialog, name));
    }
  };

  // The card (or team member) whose modal is open is marked, so the selection stays visible behind the overlay.
  const markOpener = (dialog, selected) => {
    const openers = new Set(document.querySelectorAll('[data-dialog-open="' + CSS.escape(dialog.id) + '"]'));
    if (dialog.dataset.issueId) {
      for (const card of document.querySelectorAll('.issue[data-issue-id="' + CSS.escape(dialog.dataset.issueId) + '"]')) openers.add(card);
    }
    for (const opener of openers) opener.classList.toggle('is-selected', selected);
  };

  const showDialog = (dialog) => {
    for (const openDialog of document.querySelectorAll('dialog[open]')) openDialog.close();
    dialog.showModal();
    // Start on the current section rather than on the first link in the header.
    const selectedTab = dialog.querySelector('[role="tab"][aria-selected="true"]');
    if (selectedTab instanceof HTMLElement) selectedTab.focus({ preventScroll: true });
    markOpener(dialog, true);
    // An item opened in place gets the title the server gives its own page; closing it restores the view's.
    const viewTitle = body.dataset.viewTitle || document.title;
    const heading = dialog.querySelector('.details-header h2');
    if (dialog.dataset.issueId && heading) {
      document.title = '#' + dialog.dataset.issueNumber + ' ' + heading.textContent + viewTitle.slice(viewTitle.lastIndexOf(' · '));
    }
  };

  const openIssueDialog = (opener, updateUrl = true) => {
    const id = opener.getAttribute('data-dialog-open');
    const dialog = id ? document.getElementById(id) : null;
    if (dialog instanceof HTMLDialogElement && !dialog.open) {
      selectDetailTab(dialog, 'summary');
      showDialog(dialog);
      const issueId = dialog.dataset.issueId;
      const currentPath = parseDashboardPath();
      if (updateUrl && issueId && (!currentPath.issue || currentPath.issue.repository !== dialog.dataset.repositoryId || currentPath.issue.number !== dialog.dataset.issueNumber)) {
        history.pushState({ conveyorIssue: issueId }, '', issuePath(dialog));
      }
      const agentId = dialog.dataset.agentId;
      if (updateUrl && agentId && currentPath.agent !== agentId) {
        history.pushState({ conveyorAgent: agentId }, '', '/team/' + encodeURIComponent(agentId) + paginationSearch());
      }
    }
  };

  const findIssueDialog = (issue) => {
    const dialogs = document.querySelectorAll('dialog[data-issue-id]');
    for (const dialog of dialogs) {
      if (dialog.dataset.repositoryId === issue.repository && dialog.dataset.issueNumber === issue.number && dialog.dataset.selectedIssue === 'true') return dialog;
    }
    for (const dialog of dialogs) {
      if (dialog.dataset.repositoryId === issue.repository && dialog.dataset.issueNumber === issue.number) return dialog;
    }
    return null;
  };

  const findAgentDialog = (agentId) => {
    for (const dialog of document.querySelectorAll('dialog[data-agent-id]')) {
      if (dialog.dataset.agentId === agentId && dialog instanceof HTMLDialogElement) return dialog;
    }
    return null;
  };

  const openDialogElement = (dialog, tab = 'summary') => {
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
    selectDetailTab(dialog, validDetailTab(tab));
    showDialog(dialog);
  };

  // A board row (a family, or the items without a parent) can be folded to its header; each browser remembers which.
  const foldedRows = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem('conveyor-folded-rows') || '[]');
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') foldedRows.add(id);
  } catch {}
  const applyRowFolds = () => {
    for (const button of document.querySelectorAll('[data-row-fold]')) {
      const folded = foldedRows.has(button.getAttribute('data-row-fold') || '');
      const cells = document.getElementById(button.getAttribute('aria-controls') || '');
      if (cells) cells.hidden = folded;
      button.setAttribute('aria-expanded', folded ? 'false' : 'true');
      button.setAttribute('aria-label', (folded ? 'Unfold ' : 'Fold ') + (button.getAttribute('data-fold-label') || 'this row'));
    }
  };
  applyRowFolds();
  document.addEventListener('conveyor:dashboard-rendered', applyRowFolds);

  // A board wider than the window gets a scrollbar pinned to the bottom of the window while the board
  // is on screen and its own scrollbar is not, so it can always be scrolled sideways.
  const pinnedScrollbar = document.createElement('div');
  pinnedScrollbar.className = 'board-scrollbar';
  pinnedScrollbar.hidden = true;
  pinnedScrollbar.setAttribute('aria-hidden', 'true');
  pinnedScrollbar.append(document.createElement('div'));
  document.body.append(pinnedScrollbar);
  let syncingPinnedScroll = false;
  const currentBoard = () => document.querySelector('main.dashboard .board.board--rows');
  const updatePinnedScrollbar = () => {
    const current = currentBoard();
    const bounds = current ? current.getBoundingClientRect() : null;
    pinnedScrollbar.hidden = !current || current.scrollWidth <= current.clientWidth + 1 ||
      bounds.bottom <= window.innerHeight || bounds.top >= window.innerHeight - 40;
    if (pinnedScrollbar.hidden) return;
    pinnedScrollbar.style.left = Math.max(0, bounds.left) + 'px';
    pinnedScrollbar.style.right = Math.max(0, window.innerWidth - bounds.right) + 'px';
    pinnedScrollbar.firstElementChild.style.width = current.scrollWidth + 'px';
    if (Math.abs(pinnedScrollbar.scrollLeft - current.scrollLeft) > 1) {
      syncingPinnedScroll = true;
      pinnedScrollbar.scrollLeft = current.scrollLeft;
    }
  };
  pinnedScrollbar.addEventListener('scroll', () => {
    if (syncingPinnedScroll) {
      syncingPinnedScroll = false;
      return;
    }
    const current = currentBoard();
    if (current) current.scrollLeft = pinnedScrollbar.scrollLeft;
  });
  document.addEventListener('scroll', (event) => {
    if (event.target === document || (event.target instanceof Element && event.target.matches('.board'))) updatePinnedScrollbar();
  }, { capture: true, passive: true });
  window.addEventListener('resize', updatePinnedScrollbar);
  document.addEventListener('conveyor:dashboard-rendered', updatePinnedScrollbar);
  updatePinnedScrollbar();

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const clickedDetails = event.target.closest('.dashboard-header details');
    closeHeaderPopovers(clickedDetails);

    const rowFold = event.target.closest('[data-row-fold]');
    if (rowFold instanceof HTMLButtonElement) {
      const row = rowFold.getAttribute('data-row-fold');
      if (row) {
        if (foldedRows.has(row)) foldedRows.delete(row);
        else foldedRows.add(row);
        try { localStorage.setItem('conveyor-folded-rows', JSON.stringify([...foldedRows])); } catch {}
        applyRowFolds();
      }
      return;
    }

    const retryCard = event.target.closest('[data-retry-card]');
    if (retryCard instanceof HTMLButtonElement) {
      const url = retryCard.getAttribute('data-retry-url');
      if (!url || retryCard.disabled) return;
      retryCard.disabled = true;
      retryCard.setAttribute('aria-busy', 'true');
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ note: '', csrf: body.dataset.csrfToken || '' }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text() || 'Retry failed');
        retryCard.textContent = 'Retry accepted';
      }).catch(() => {
        retryCard.disabled = false;
        retryCard.removeAttribute('aria-busy');
        retryCard.textContent = 'Retry failed · try again';
      });
      return;
    }

    const themeButton = event.target.closest('[data-theme-choice]');
    if (themeButton instanceof HTMLButtonElement) {
      const theme = themeButton.getAttribute('data-theme-choice');
      if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return;
      if (theme === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('conveyor-theme', theme); } catch {}
      syncThemeControls();
      const control = themeButton.closest('[data-theme-control]');
      if (control instanceof HTMLDetailsElement) control.open = false;
      return;
    }

    const deleteCancel = event.target.closest('[data-account-delete-cancel]');
    if (deleteCancel instanceof HTMLButtonElement) {
      const details = deleteCancel.closest('details');
      if (details instanceof HTMLDetailsElement) {
        details.open = false;
        const summary = details.querySelector('summary');
        if (summary instanceof HTMLElement) summary.focus();
      }
      return;
    }

    const containingDialog = event.target.closest('dialog');
    if (containingDialog instanceof HTMLDialogElement) {
      const tab = event.target.closest('[data-detail-tab]');
      if (tab) {
        selectDetailTab(containingDialog, tab.getAttribute('data-detail-tab') || 'summary', true);
        return;
      }
      const moreRuns = event.target.closest('[data-more-runs]');
      if (moreRuns) {
        const panel = moreRuns.closest('[data-activity-url]');
        if (panel) void loadIssueActivity(panel, moreRuns.getAttribute('data-more-runs'), true);
        return;
      }
      const moreEvents = event.target.closest('[data-more-events]');
      if (moreEvents instanceof HTMLButtonElement) {
        void loadOlderEvents(moreEvents);
        return;
      }
      if (event.target !== containingDialog || !containingDialog.open) return;
      const rectangle = containingDialog.getBoundingClientRect();
      const inside = event.clientX >= rectangle.left && event.clientX <= rectangle.right &&
        event.clientY >= rectangle.top && event.clientY <= rectangle.bottom;
      if (!inside) containingDialog.close();
      return;
    }

    if (!event.target.closest('.card-open') && event.target.closest('a, button, input, textarea, select, label, form')) return;
    const opener = event.target.closest('[data-dialog-open]');
    if (opener) openIssueDialog(opener);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const openDetails = document.querySelector('.dashboard-header details[open]');
      if (openDetails instanceof HTMLDetailsElement) {
        event.preventDefault();
        openDetails.open = false;
        const summary = openDetails.querySelector('summary');
        if (summary instanceof HTMLElement) summary.focus();
        return;
      }
      const inspector = document.querySelector('dialog[open]');
      if (inspector instanceof HTMLDialogElement) {
        event.preventDefault();
        inspector.close();
      }
      return;
    }
    // Only the selected detail tab is a tab stop; the arrow keys, Home and End reach the others.
    const detailTab = event.target instanceof Element ? event.target.closest('[role="tab"][data-detail-tab]') : null;
    if (detailTab) {
      const tabs = [...detailTab.closest('[role="tablist"]').querySelectorAll('[data-detail-tab]')];
      const index = tabs.indexOf(detailTab);
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs[tabs.length - 1]
        : null;
      const dialog = detailTab.closest('dialog');
      if (next instanceof HTMLElement && dialog instanceof HTMLDialogElement) {
        event.preventDefault();
        selectDetailTab(dialog, next.getAttribute('data-detail-tab') || 'summary', true);
        next.focus();
      }
      return;
    }
  });

  document.addEventListener('toggle', (event) => {
    const opened = event.target;
    if (opened instanceof HTMLDetailsElement && opened.open && opened.matches('.dashboard-header details')) {
      closeHeaderPopovers(opened);
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.defaultPrevented) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || !link.closest('main.dashboard') || link.target || link.hasAttribute('download') || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (destination.origin !== location.origin || (destination.protocol !== 'http:' && destination.protocol !== 'https:')) return;
    if (destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
    event.preventDefault();
    closeHeaderPopovers();
    void navigateDashboard(destination);
  }, true);

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.matches('.logout-form')) {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (button instanceof HTMLButtonElement) button.disabled = true;
      try {
        const registration = await navigator.serviceWorker?.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        const endpoint = form.querySelector('input[name="pushEndpoint"]');
        if (endpoint instanceof HTMLInputElement && subscription) endpoint.value = subscription.endpoint;
      } catch {}
      form.submit();
      return;
    }
    if (form instanceof HTMLFormElement && form.matches('[data-account-action-form]')) {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const status = form.querySelector('[data-form-status]');
      const fields = new URLSearchParams();
      for (const [name, value] of new FormData(form)) {
        if (typeof value === 'string') fields.append(name, value);
      }
      if (button instanceof HTMLButtonElement) button.disabled = true;
      if (status instanceof HTMLElement) {
        status.textContent = '';
        status.dataset.error = 'false';
      }
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: fields,
        });
        if (response.redirected) {
          window.location.assign(response.url);
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload && typeof payload.error === 'string' ? payload.error : 'The account could not be updated.');
        const username = form.dataset.accountUsername ?? 'the account';
        if (form.hasAttribute('data-account-delete')) {
          const row = form.closest('tr');
          row?.remove();
          const listStatus = document.querySelector('[data-account-list-status]');
          if (listStatus instanceof HTMLElement) listStatus.textContent = 'Account ' + username + ' deleted.';
        } else {
          form.reset();
          if (status instanceof HTMLElement) status.textContent = 'Password reset for ' + username + '.';
        }
      } catch (error) {
        if (status instanceof HTMLElement) {
          status.textContent = error instanceof Error ? error.message : 'The account could not be updated.';
          status.dataset.error = 'true';
        }
      } finally {
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
      return;
    }
    if (form instanceof HTMLFormElement && form.matches('[data-profile-avatar-form], [data-account-create-form]')) {
      event.preventDefault();
      const isAvatar = form.matches('[data-profile-avatar-form]');
      const button = form.querySelector('button[type="submit"]');
      const status = form.querySelector('[data-form-status]');
      const fields = new URLSearchParams();
      for (const [name, value] of new FormData(form)) {
        if (typeof value === 'string') fields.append(name, value);
      }
      if (button instanceof HTMLButtonElement) button.disabled = true;
      if (status instanceof HTMLElement) {
        status.textContent = '';
        status.dataset.error = 'false';
      }
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: fields,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload && typeof payload.error === 'string' ? payload.error : 'The change could not be saved.');
        if (isAvatar) {
          if (!payload || typeof payload.avatar !== 'string') throw new Error('The server returned an invalid profile update.');
          for (const avatar of document.querySelectorAll('.account-avatar, [data-profile-avatar]')) avatar.textContent = payload.avatar;
          if (status instanceof HTMLElement) status.textContent = 'Saved.';
        } else {
          const account = payload && payload.account;
          if (!account || typeof account.username !== 'string') {
            throw new Error('The server returned an invalid account.');
          }
          window.location.assign('/accounts');
          return;
        }
      } catch (error) {
        if (status instanceof HTMLElement) {
          status.textContent = error instanceof Error ? error.message : 'The change could not be saved.';
          status.dataset.error = 'true';
        }
      } finally {
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
      return;
    }
    if (form instanceof HTMLFormElement && form.matches('[data-retry-form]')) {
      event.preventDefault();
      const url = form.getAttribute('data-retry-url');
      const button = form.querySelector('[data-retry-submit]');
      const status = form.querySelector('[data-retry-status]');
      const field = form.querySelector('textarea[name="note"]');
      if (!url || !(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      if (field instanceof HTMLTextAreaElement) field.disabled = true;
      if (status) status.textContent = 'Retrying…';
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ note: field instanceof HTMLTextAreaElement ? field.value : '', csrf: body.dataset.csrfToken || '' }),
        });
        if (!response.ok) throw new Error(await response.text() || 'Retry failed');
        if (status) status.textContent = 'Retry accepted. A fresh attempt is queued.';
        if (field instanceof HTMLTextAreaElement) field.value = '';
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? 'Retry failed: ' + error.message : 'Retry failed.';
        button.disabled = false;
      } finally {
        if (field instanceof HTMLTextAreaElement) field.disabled = false;
      }
      return;
    }
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-conversation-form]')) return;
    event.preventDefault();
    const panel = form.closest('[data-conversation-url]');
    const url = panel && panel.getAttribute('data-conversation-url');
    const button = form.querySelector('button[type="submit"]');
    const status = panel && panel.querySelector('[data-conversation-status]');
    if (!url || !(panel instanceof HTMLElement)) return;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    const field = form.querySelector('textarea[name="message"]');
    const submittedMessage = field instanceof HTMLTextAreaElement ? field.value : '';
    if (field instanceof HTMLTextAreaElement) {
      field.value = '';
      field.disabled = true;
    }
    const data = new URLSearchParams({
      message: submittedMessage,
      csrf: body.dataset.csrfToken || '',
    });
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: data,
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Message request failed.');
      await loadIssueConversation(panel);
    } catch (error) {
      if (field instanceof HTMLTextAreaElement) field.value = submittedMessage;
      if (status) status.textContent = error instanceof Error ? error.message : 'Message could not be sent. Please try again.';
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
      if (field instanceof HTMLTextAreaElement) {
        field.disabled = false;
        field.focus();
      }
    }
  });

  document.addEventListener('close', (event) => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    markOpener(event.target, false);
    // Opening one item from another closes the first after the second has set its title.
    if (body.dataset.viewTitle && !document.querySelector('dialog[open]')) document.title = body.dataset.viewTitle;
    const currentPath = parseDashboardPath();
    const agentId = event.target.dataset.agentId;
    if (agentId && currentPath.agent === agentId) {
      history.replaceState(null, '', '/team' + paginationSearch());
      renderedUrl = '/team' + paginationSearch();
      return;
    }
    if (!currentPath.issue || currentPath.issue.repository !== event.target.dataset.repositoryId || currentPath.issue.number !== event.target.dataset.issueNumber) return;
    history.replaceState(null, '', '/board' + paginationSearch());
    renderedUrl = '/board' + paginationSearch();
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshDashboard();
    }
  }, true);

  const syncRouteDialogs = () => {
    const requestedPath = parseDashboardPath();
    const requestedAgent = requestedPath.agent;
    const agentDialog = requestedAgent ? findAgentDialog(requestedAgent) : null;
    const requested = requestedPath.issue;
    const dialog = requested ? findIssueDialog(requested) : null;
    if (requestedAgent && !agentDialog) return false;
    if (requested && !dialog) return false;
    if (!requestedAgent && !requested && location.pathname + location.search !== renderedUrl) return false;
    for (const dialog of document.querySelectorAll('dialog[data-agent-id][open]')) {
      if (dialog.dataset.agentId !== requestedAgent) dialog.close();
    }
    if (agentDialog && !agentDialog.open) showDialog(agentDialog);
    for (const dialog of document.querySelectorAll('dialog[data-issue-id][open]')) {
      if (!requested || dialog.dataset.repositoryId !== requested.repository || dialog.dataset.issueNumber !== requested.number) dialog.close();
    }
    if (requested) openDialogElement(dialog, requestedPath.tab);
    if (dialog instanceof HTMLDialogElement && dialog.open) {
      selectDetailTab(dialog, requestedPath.tab);
    }
    if (!requested && !requestedAgent && location.hash) {
      try {
        const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target) target.scrollIntoView();
      } catch {}
    }
    return true;
  };

  window.addEventListener('popstate', () => {
    if (!syncRouteDialogs()) void navigateDashboard(new URL(location.href), 'none');
  });

  // Backlog ordering happens in place: drag a row, or use its arrow buttons. The
  // DOM moves immediately, the new position is saved in the background, and a
  // failed save puts the row back. Dashboard refreshes wait while this is busy.
  let backlogBusy = false;
  const backlogRows = (list) => Array.from(list.children).filter((row) => row.matches('.backlog-row'));
  const syncBacklogButtons = (list) => {
    const rows = backlogRows(list);
    rows.forEach((row, index) => {
      for (const form of row.querySelectorAll('form')) {
        const direction = form.querySelector('input[name="direction"]');
        const button = form.querySelector('button');
        if (!direction || !(button instanceof HTMLButtonElement)) continue;
        button.disabled = direction.value === 'up' ? index === 0 : index === rows.length - 1;
      }
    });
  };
  const showBacklogError = (list, message) => {
    const column = list.closest('.stage--backlog');
    if (!column) return;
    let note = column.querySelector('.backlog-error');
    if (!message) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement('p');
      note.className = 'backlog-error';
      note.setAttribute('role', 'alert');
      column.append(note);
    }
    note.textContent = message;
  };
  const saveBacklogPosition = async (row, restore) => {
    const list = row.parentElement;
    if (!list) return;
    const next = row.nextElementSibling;
    const beforeIssueId = next && next.matches('.backlog-row') ? next.dataset.backlogId || '' : '';
    backlogBusy = true;
    row.classList.add('backlog-row--saving');
    syncBacklogButtons(list);
    try {
      const response = await fetch('/backlog/move', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf: body.dataset.csrfToken || '',
          issueId: row.dataset.backlogId || '',
          beforeIssueId,
        }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'The new order could not be saved.');
      showBacklogError(list, '');
    } catch (error) {
      restore();
      syncBacklogButtons(list);
      showBacklogError(list, error instanceof Error ? error.message : 'The new order could not be saved.');
    } finally {
      row.classList.remove('backlog-row--saving');
      backlogBusy = false;
      if (pendingRefresh && !document.querySelector('dialog[open]')) {
        pendingRefresh = false;
        void refreshDashboard();
      }
    }
  };
  const rememberPosition = (row) => {
    const list = row.parentElement;
    const next = row.nextElementSibling;
    return () => {
      if (!list) return;
      if (next && next.parentElement === list) list.insertBefore(row, next);
      else list.append(row);
    };
  };

  let draggedRow = null;
  let restoreDragged = null;
  let draggedFrom = null;
  document.addEventListener('dragstart', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-backlog-list] > .backlog-row') : null;
    if (!row || backlogBusy) return;
    draggedRow = row;
    restoreDragged = rememberPosition(row);
    draggedFrom = row.nextElementSibling;
    backlogBusy = true;
    row.classList.add('backlog-row--dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.backlogId || '');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (!draggedRow) return;
    const list = draggedRow.parentElement;
    const target = event.target instanceof Element ? event.target.closest('.backlog-row') : null;
    if (!list || !(event.target instanceof Element) || !list.contains(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!target || target === draggedRow || target.parentElement !== list) return;
    const box = target.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    list.insertBefore(draggedRow, after ? target.nextElementSibling : target);
  });
  document.addEventListener('drop', (event) => {
    if (draggedRow) event.preventDefault();
  });
  document.addEventListener('dragend', () => {
    const row = draggedRow;
    const restore = restoreDragged;
    const from = draggedFrom;
    draggedRow = null;
    restoreDragged = null;
    draggedFrom = null;
    if (!row || !restore) return;
    row.classList.remove('backlog-row--dragging');
    backlogBusy = false;
    if (row.nextElementSibling === from) {
      if (pendingRefresh) {
        pendingRefresh = false;
        void refreshDashboard();
      }
      return;
    }
    void saveBacklogPosition(row, restore);
  });

  // Arrow buttons: same in-place move. Without JavaScript the form still posts.
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-backlog-list] .reorder form')) return;
    event.preventDefault();
    if (backlogBusy) return;
    const row = form.closest('.backlog-row');
    const list = row && row.parentElement;
    const direction = form.querySelector('input[name="direction"]');
    if (!row || !list || !direction) return;
    const restore = rememberPosition(row);
    if (direction.value === 'up') {
      const previous = row.previousElementSibling;
      if (!previous) return;
      list.insertBefore(row, previous);
    } else {
      const next = row.nextElementSibling;
      if (!next) return;
      list.insertBefore(row, next.nextElementSibling);
    }
    const button = form.querySelector('button');
    void saveBacklogPosition(row, restore).then(() => {
      if (button instanceof HTMLButtonElement && !button.disabled) button.focus();
    });
  }, true);

  syncRouteDialogs();

  localizeTimes();
  updateQuotaCountdowns();
  window.setInterval(updateQuotaCountdowns, 60_000);

  let serverStatus = null;
  let connectionState = null;
  let serverMetrics = null;
  let connected = false;
  let latestServerStatus = null;
  let dashboardRefresh = null;
  let dashboardRefreshQueued = false;
  let dashboardRequestVersion = 0;
  let revision = body.dataset.dashboardRevision || '';
  const setConnection = (nextConnected) => {
    connected = nextConnected;
    if (!serverStatus || !connectionState) return;
    serverStatus.dataset.connected = nextConnected ? 'true' : 'false';
    connectionState.textContent = nextConnected ? 'Connected' : 'Reconnecting';
  };
  const renderServerStatus = () => {
    if (!serverMetrics || !latestServerStatus) return;
    const status = latestServerStatus;
    serverMetrics.textContent = 'Memory ' + formatBytes(status.memory.usedBytes) + ' / ' + formatBytes(status.memory.totalBytes) +
      ' · Disk ' + formatBytes(status.disk.usedBytes) + ' / ' + formatBytes(status.disk.totalBytes) +
      ' · App ' + formatBytes(status.memory.processBytes) + ' · Up ' + formatElapsed(status.uptimeSeconds);
  };
  const bindServerStatus = () => {
    serverStatus = document.querySelector('[data-server-status]');
    connectionState = serverStatus && serverStatus.querySelector('[data-connection-state]');
    serverMetrics = serverStatus && serverStatus.querySelector('[data-server-metrics]');
    setConnection(connected);
    renderServerStatus();
  };
  // The whole dashboard is swapped on navigation and on live updates, so the focused control and
  // anything half-entered are carried over by hand.
  const describeFocus = (main) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !main.contains(active)) return null;
    const card = active.closest('[data-dialog-open]');
    const selector = active.id ? '#' + CSS.escape(active.id)
      : card && active.matches('.card-open') ? '[data-dialog-open="' + CSS.escape(card.getAttribute('data-dialog-open') || '') + '"] .card-open'
      : active instanceof HTMLAnchorElement ? 'a[href="' + CSS.escape(active.getAttribute('href') || '') + '"]'
      : active.tagName.toLowerCase();
    return { selector, index: [...main.querySelectorAll(selector)].indexOf(active), link: active instanceof HTMLAnchorElement };
  };
  const restoreFocus = (main, focus) => {
    const target = focus ? main.querySelectorAll(focus.selector)[focus.index] : null;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    return target instanceof HTMLElement;
  };
  const fieldKey = (field) => [field.form ? field.form.getAttribute('action') || field.form.getAttribute('data-retry-url') || '' : '', field.id, field.name, field.type === 'radio' || field.type === 'checkbox' ? field.value : ''].join('|');
  const editableFields = (main) => [...main.querySelectorAll('textarea, select, input:not([type=hidden])')];
  const describeEntries = (main) => {
    const entries = new Map();
    for (const field of editableFields(main)) {
      if (field.type === 'radio' || field.type === 'checkbox') {
        if (field.checked !== field.defaultChecked) entries.set(fieldKey(field), field.checked);
      } else if (!(field instanceof HTMLSelectElement) && field.value !== field.defaultValue) entries.set(fieldKey(field), field.value);
    }
    return entries;
  };
  const restoreEntries = (main, entries) => {
    if (entries.size === 0) return;
    for (const field of editableFields(main)) {
      const entry = entries.get(fieldKey(field));
      if (entry === undefined) continue;
      if (typeof entry === 'boolean') field.checked = entry;
      else field.value = entry;
    }
  };
  const clampScrollOffset = (value, maximum) => Math.min(Math.max(0, value), Math.max(0, maximum));
  const documentScrollMaximum = () => Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);
  const boardScrollMaximum = () => board ? Math.max(0, board.scrollWidth - board.clientWidth) : 0;
  const captureDashboardPosition = () => {
    const stages = board ? [...board.querySelectorAll('[data-station-cell]')].map((stage) => {
      const bounds = stage.getBoundingClientRect();
      const boardBounds = board.getBoundingClientRect();
      return { stage, overlap: Math.max(0, Math.min(bounds.right, boardBounds.right) - Math.max(bounds.left, boardBounds.left)) };
    }).sort((left, right) => right.overlap - left.overlap) : [];
    const stage = stages[0]?.stage;
    // Cards of the reader's station, and of any family row, are what the reader may be looking at.
    const visibleIssues = [...(board || document).querySelectorAll('article.issue[data-issue-id]')].filter((issue) => {
      const bounds = issue.getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.right > 0 && bounds.left < window.innerWidth && (!stage || !issue.closest('[data-station-cell]') || stage.contains(issue));
    });
    const issue = visibleIssues.sort((left, right) => {
      const target = window.innerHeight / 2;
      return Math.abs(left.getBoundingClientRect().top - target) - Math.abs(right.getBoundingClientRect().top - target);
    })[0];
    return {
      scrollX: board ? board.scrollLeft : 0,
      // On wide screens the board scrolls vertically inside its own area.
      boardY: board ? board.scrollTop : 0,
      scrollY: window.scrollY,
      issue: issue ? { id: issue.dataset.issueId, top: issue.getBoundingClientRect().top } : null,
      stage: stage ? { id: stage.getAttribute('data-station-cell'), left: stage.getBoundingClientRect().left } : null,
    };
  };
  const restoreDashboardPosition = (position) => {
    window.scrollTo(0, clampScrollOffset(position.scrollY, documentScrollMaximum()));
    if (board) {
      board.scrollTop = clampScrollOffset(position.boardY || 0, Math.max(0, board.scrollHeight - board.clientHeight));
      board.scrollLeft = clampScrollOffset(position.scrollX, boardScrollMaximum());
      const stage = position.stage && board.querySelector('[data-station-cell="' + CSS.escape(position.stage.id) + '"]');
      if (stage) board.scrollLeft = clampScrollOffset(board.scrollLeft + stage.getBoundingClientRect().left - position.stage.left, boardScrollMaximum());
    }
    if (position.issue?.id) {
      const issue = document.querySelector('article.issue[data-issue-id="' + CSS.escape(position.issue.id) + '"]');
      const shift = issue ? issue.getBoundingClientRect().top - position.issue.top : 0;
      if (issue && board && board.contains(issue) && board.scrollHeight > board.clientHeight) {
        board.scrollTop = clampScrollOffset(board.scrollTop + shift, board.scrollHeight - board.clientHeight);
      } else if (issue) window.scrollTo(0, clampScrollOffset(window.scrollY + shift, documentScrollMaximum()));
    }
  };
  const interactionInProgress = () => {
    if (document.querySelector('.dashboard-header details[open]')) return true;
    const active = document.activeElement;
    return active instanceof HTMLElement && active.matches('main.dashboard textarea, main.dashboard select, main.dashboard input:not([type=hidden]):not([type=radio]):not([type=checkbox])');
  };
  const replaceDashboard = async (target, options = {}) => {
    const requestVersion = ++dashboardRequestVersion;
    const preservePosition = options.preservePosition === true;
    // A live update tells the server which cards this page holds, and gets back only the others.
    const heldCards = preservePosition && options.everyCard !== true
      ? [...new Set([...document.querySelectorAll('main.dashboard article.issue[data-card-revision]')].map((card) => card.getAttribute('data-card-revision')))].join(' ')
      : '';
    try {
      const response = await fetch(target.pathname + target.search, {
        headers: heldCards && heldCards.length < 16000 ? { accept: 'text/html', 'x-conveyor-cards': heldCards } : { accept: 'text/html' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('dashboard navigation failed');
      const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
      const currentDashboard = document.querySelector('main.dashboard');
      const nextDashboard = nextDocument.querySelector('main.dashboard');
      if (!currentDashboard || !nextDashboard) throw new Error('dashboard response is incomplete');
      if (requestVersion !== dashboardRequestVersion) return true;
      const focus = describeFocus(currentDashboard);
      const entries = preservePosition ? describeEntries(currentDashboard) : new Map();
      // Measured here, not before the request: the reader may have scrolled while it was in flight.
      const position = preservePosition ? captureDashboardPosition() : null;
      // A live update is patched into the page; navigation swaps the page.
      let rendered = nextDashboard;
      if (preservePosition) {
        try {
          morphDashboard(currentDashboard, nextDashboard);
          rendered = currentDashboard;
        } catch {
          // The update kept a card this page no longer holds: take every card instead.
          if (heldCards) return replaceDashboard(target, { ...options, everyCard: true });
          currentDashboard.replaceWith(nextDashboard);
        }
      } else {
        currentDashboard.replaceWith(nextDashboard);
      }
      if (rendered === nextDashboard) restoreEntries(nextDashboard, entries);
      if (options.historyMode === 'push') history.pushState({ conveyorPage: true }, '', target.pathname + target.search + target.hash);
      else if (options.historyMode === 'replace') history.replaceState({ conveyorPage: true }, '', target.pathname + target.search + target.hash);
      renderedUrl = target.pathname + target.search;
      document.title = nextDocument.title;
      body.dataset.csrfToken = nextDocument.body.dataset.csrfToken || body.dataset.csrfToken || '';
      body.dataset.dashboardView = nextDocument.body.dataset.dashboardView || body.dataset.dashboardView || '';
      body.dataset.viewTitle = nextDocument.body.dataset.viewTitle || '';
      revision = nextDocument.body.dataset.dashboardRevision || revision;
      body.dataset.dashboardRevision = revision;
      body.classList.remove('page-loading', 'dashboard-navigating');
      board = document.querySelector('.board');
      localizeTimes(rendered);
      syncThemeControls(rendered);
      updateQuotaCountdowns();
      bindServerStatus();
      document.dispatchEvent(new CustomEvent('conveyor:dashboard-rendered'));
      if (preservePosition) {
        restoreDashboardPosition(position);
      } else if (target.hash) {
        try {
          const anchor = document.getElementById(decodeURIComponent(target.hash.slice(1)));
          if (anchor) anchor.scrollIntoView();
          else window.scrollTo(0, 0);
        } catch { window.scrollTo(0, 0); }
      } else {
        window.scrollTo(0, 0);
      }
      syncRouteDialogs();
      if (!document.querySelector('dialog[open]')) {
        if (preservePosition) restoreFocus(rendered, focus);
        else if (focus && !(focus.link && restoreFocus(rendered, focus))) {
          const content = rendered.querySelector('#content');
          if (content instanceof HTMLElement) content.focus({ preventScroll: true });
        }
      }
      if (!preservePosition) {
        const announcer = document.querySelector('[data-route-announcer]');
        if (announcer) announcer.textContent = document.title;
      }
      return true;
    } catch {
      return requestVersion !== dashboardRequestVersion;
    }
  };
  const navigateDashboard = createDashboardNavigation({
    load: (target, historyMode) => replaceDashboard(target, { historyMode, preservePosition: false }),
    start: () => body.classList.add('page-loading', 'dashboard-navigating'),
    finish: () => body.classList.remove('page-loading', 'dashboard-navigating'),
    fallback: (target) => location.assign(target.href),
  });
  const refreshDashboard = async () => {
    if (dashboardRefresh) {
      dashboardRefreshQueued = true;
      return dashboardRefresh;
    }
    dashboardRefresh = replaceDashboard(new URL(location.href), { historyMode: 'none', preservePosition: true }).then((loaded) => {
      if (!loaded) pendingRefresh = true;
    }).finally(() => {
      dashboardRefresh = null;
      if (dashboardRefreshQueued) {
        dashboardRefreshQueued = false;
        void refreshDashboard();
      }
    });
    return dashboardRefresh;
  };
  const refreshDashboardWhenSafe = () => {
    if (body.dataset.dashboardView === 'agent') return;
    if (backlogBusy) {
      pendingRefresh = true;
      return;
    }
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) {
      scheduleJourneyRefresh();
      scheduleSummaryRefresh();
      pendingRefresh = true;
      return;
    }
    // Typing in a field or reading an open header menu is not interrupted; the update lands afterwards.
    if (interactionInProgress()) {
      pendingRefresh = true;
      return;
    }
    // Nor is a finger on the screen or a scroll still coasting: the update waits for it to settle.
    if (touching || performance.now() - lastScrolledAt < 150) {
      if (gestureRetry === null) gestureRetry = setTimeout(() => {
        gestureRetry = null;
        refreshDashboardWhenSafe();
      }, 200);
      return;
    }
    void refreshDashboard();
  };
  let touching = false;
  let lastScrolledAt = -Infinity;
  let gestureRetry = null;
  document.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  for (const finished of ['touchend', 'touchcancel']) {
    document.addEventListener(finished, (event) => {
      touching = event.touches.length > 0;
      lastScrolledAt = performance.now();
    }, { passive: true });
  }
  document.addEventListener('scroll', () => { lastScrolledAt = performance.now(); }, { passive: true, capture: true });
  const resumePendingRefresh = () => setTimeout(() => {
    if (!pendingRefresh || backlogBusy || document.querySelector('dialog[open]') || interactionInProgress()) return;
    pendingRefresh = false;
    void refreshDashboard();
  }, 0);
  document.addEventListener('focusout', resumePendingRefresh);
  document.addEventListener('toggle', resumePendingRefresh, true);
  bindServerStatus();
  syncThemeControls();
  const dashboardEvents = createDashboardEventConnection({
    onConnectionChange: setConnection,
    onReconnect: refreshDashboardWhenSafe,
    onEvent: (type, message) => {
      if (type === 'status') {
        try {
          latestServerStatus = JSON.parse(message.data);
          renderServerStatus();
        } catch {
          if (serverMetrics) serverMetrics.textContent = 'Server metrics unavailable';
        }
        return;
      }
      if (type === 'conversation') return scheduleConversationRefresh();
      if (type === 'activity') return scheduleActivityRefresh();
      try {
        const next = JSON.parse(message.data);
        if (typeof next.revision !== 'string' || next.revision === revision) return;
        revision = next.revision;
        body.dataset.dashboardRevision = revision;
        refreshDashboardWhenSafe();
      } catch {}
    },
  });
  document.addEventListener('visibilitychange', dashboardEvents.check);
  window.addEventListener('online', dashboardEvents.check);
  window.addEventListener('offline', dashboardEvents.check);

  let steeringSource = null;
  let steeringPanel = null;
  const bindSteering = () => {
  const panel = document.querySelector('[data-steering-run]');
  if (panel === steeringPanel) return;
  if (steeringSource) steeringSource.close();
  steeringSource = null;
  steeringPanel = panel;
  const runId = panel && panel.getAttribute('data-steering-run');
  const events = document.getElementById('steering-events');
  if (runId && events) {
    const next = Number(events.dataset.nextSequence || '1');
    const source = new EventSource('/steering/' + encodeURIComponent(runId) + '/events?after=' + String(Math.max(0, next - 1)));
    steeringSource = source;
    source.addEventListener('update', (message) => {
      try {
        const event = JSON.parse(message.data);
        if (!Number.isSafeInteger(event.sequence) || events.querySelector('[data-sequence="' + event.sequence + '"]')) return;
        const item = document.createElement('li');
        item.className = 'agent-event agent-event--' + String(event.type).replace(/[^a-z0-9_-]/gi, '');
        item.dataset.sequence = String(event.sequence);
        const role = document.createElement('span');
        role.className = 'agent-event-role';
        role.textContent = event.type === 'user' ? 'You' : event.type === 'report' ? 'Report' : 'Operator';
        const text = document.createElement('div');
        text.className = 'markdown';
        appendMarkdown(text, String(event.text || ''));
        const time = document.createElement('time');
        time.dateTime = String(event.createdAt || '');
        time.textContent = formatDateTime(event.createdAt);
        item.append(role, text, time);
        events.append(item);
        events.scrollTop = events.scrollHeight;
      } catch {}
    });
    source.addEventListener('done', () => {
      source.close();
      if (steeringSource === source) steeringSource = null;
      setTimeout(() => void refreshDashboard(), 500);
    });
  }
  };
  document.addEventListener('conveyor:dashboard-rendered', bindSteering);
  bindSteering();
})();`;
