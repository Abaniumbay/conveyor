export const dashboardClient = String.raw`(() => {
  const body = document.body;
  let board = document.querySelector('.board');
  const scrollKey = 'conveyor:scroll';
  let pendingRefresh = false;
  let conversationRefreshTimer = null;
  let journeyRefreshTimer = null;
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

  const actorAvatar = (name, type) => {
    const avatar = document.createElement('span');
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
      const actorName = message.actorType === 'user' ? 'You' : String(message.actorName || 'Agent');
      actor.textContent = actorName + (message.actorTitle ? ' · ' + String(message.actorTitle) : '');
      const identity = document.createElement('span');
      identity.className = 'conversation-actor';
      identity.append(actorAvatar(actorName, message.actorType), actor);
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
    const now = journey.now && typeof journey.now === 'object' ? journey.now : null;
    if (now) {
      const item = document.createElement('li');
      item.className = 'journey-entry journey-entry--now';
      const header = document.createElement('header');
      const title = document.createElement('strong');
      title.textContent = (now.stage ? humanize(now.stage) + ' · ' : '') + humanize(now.state || 'active');
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
      root.append(item);
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
    markOpener(dialog, true);
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

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const clickedDetails = event.target.closest('.dashboard-header details');
    closeHeaderPopovers(clickedDetails);

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

    if (event.target.closest('a, button, input, textarea, select, label, form')) return;
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
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element)) return;
    const opener = event.target.closest('[data-dialog-open]');
    if (!opener || event.target !== opener) return;
    event.preventDefault();
    openIssueDialog(opener);
  });

  document.addEventListener('toggle', (event) => {
    const opened = event.target;
    if (opened instanceof HTMLDetailsElement && opened.open && opened.matches('.dashboard-header details')) {
      closeHeaderPopovers(opened);
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.defaultPrevented) return;
    const link = event.target.closest('.tab, .active-work a, .relationships a, .relation-summary a, .pagination a, .agent-history a');
    if (!(link instanceof HTMLAnchorElement) || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    body.classList.add('page-loading');
  }, true);

  document.addEventListener('submit', async (event) => {
    const form = event.target;
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
    const currentPath = parseDashboardPath();
    const agentId = event.target.dataset.agentId;
    if (agentId && currentPath.agent === agentId) {
      history.replaceState(null, '', '/team' + paginationSearch());
      return;
    }
    if (!currentPath.issue || currentPath.issue.repository !== event.target.dataset.repositoryId || currentPath.issue.number !== event.target.dataset.issueNumber) return;
    history.replaceState(null, '', '/board' + paginationSearch());
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshDashboard();
    }
  }, true);

  window.addEventListener('popstate', () => {
    const requestedPath = parseDashboardPath();
    const requestedAgent = requestedPath.agent;
    for (const dialog of document.querySelectorAll('dialog[data-agent-id][open]')) {
      if (dialog.dataset.agentId !== requestedAgent) dialog.close();
    }
    const agentDialog = requestedAgent ? findAgentDialog(requestedAgent) : null;
    if (agentDialog && !agentDialog.open) showDialog(agentDialog);
    const requested = requestedPath.issue;
    for (const dialog of document.querySelectorAll('dialog[data-issue-id][open]')) {
      if (!requested || dialog.dataset.repositoryId !== requested.repository || dialog.dataset.issueNumber !== requested.number) dialog.close();
    }
    if (requested) openDialogElement(findIssueDialog(requested), requestedPath.tab);
    const dialog = requested ? findIssueDialog(requested) : null;
    if (dialog instanceof HTMLDialogElement && dialog.open) {
      selectDetailTab(dialog, requestedPath.tab);
    }
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

  const requestedPath = parseDashboardPath();
  if (requestedPath.issue) openDialogElement(findIssueDialog(requestedPath.issue), requestedPath.tab);
  const requestedAgent = requestedPath.agent;
  const requestedAgentDialog = requestedAgent ? findAgentDialog(requestedAgent) : null;
  if (requestedAgentDialog) showDialog(requestedAgentDialog);

  localizeTimes();

  let serverStatus = null;
  let connectionState = null;
  let serverMetrics = null;
  let connected = false;
  let latestServerStatus = null;
  let dashboardRefresh = null;
  let dashboardRefreshQueued = false;
  let revision = body.dataset.dashboardRevision || '';
  const dashboardEvents = new EventSource('/events/dashboard');
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
  const refreshDashboard = async () => {
    if (dashboardRefresh) {
      dashboardRefreshQueued = true;
      return dashboardRefresh;
    }
    const scrollX = board ? board.scrollLeft : 0;
    const scrollY = window.scrollY;
    dashboardRefresh = (async () => {
      try {
        const response = await fetch(location.pathname + location.search, {
          headers: { accept: 'text/html' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('dashboard refresh failed');
        const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
        const currentDashboard = document.querySelector('main.dashboard');
        const nextDashboard = nextDocument.querySelector('main.dashboard');
        if (!currentDashboard || !nextDashboard) throw new Error('dashboard response is incomplete');
        currentDashboard.replaceWith(nextDashboard);
        body.dataset.csrfToken = nextDocument.body.dataset.csrfToken || body.dataset.csrfToken || '';
        body.dataset.dashboardView = nextDocument.body.dataset.dashboardView || body.dataset.dashboardView || '';
        body.dataset.dashboardRevision = revision;
        body.classList.remove('page-loading');
        board = document.querySelector('.board');
        localizeTimes(nextDashboard);
        syncThemeControls(nextDashboard);
        bindServerStatus();
        window.scrollTo(0, scrollY);
        if (board) board.scrollLeft = scrollX;
      } catch {
        pendingRefresh = true;
      }
    })().finally(() => {
      dashboardRefresh = null;
      if (dashboardRefreshQueued) {
        dashboardRefreshQueued = false;
        void refreshDashboard();
      }
    });
    return dashboardRefresh;
  };
  bindServerStatus();
  syncThemeControls();
  dashboardEvents.onopen = () => setConnection(true);
  dashboardEvents.onerror = () => setConnection(false);
  dashboardEvents.addEventListener('status', (message) => {
    try {
      latestServerStatus = JSON.parse(message.data);
      renderServerStatus();
    } catch {
      if (serverMetrics) serverMetrics.textContent = 'Server metrics unavailable';
    }
  });
  dashboardEvents.addEventListener('revision', (message) => {
    try {
      const next = JSON.parse(message.data);
      if (typeof next.revision !== 'string' || next.revision === revision) return;
      revision = next.revision;
      body.dataset.dashboardRevision = revision;
      if (body.dataset.dashboardView === 'agent') return;
      if (backlogBusy) {
        pendingRefresh = true;
        return;
      }
      const openDialog = document.querySelector('dialog[open]');
      if (openDialog) {
        scheduleJourneyRefresh();
        pendingRefresh = true;
        return;
      }
      void refreshDashboard();
    } catch {}
  });
  dashboardEvents.addEventListener('conversation', scheduleConversationRefresh);
  dashboardEvents.addEventListener('activity', scheduleActivityRefresh);

  const panel = document.querySelector('[data-steering-run]');
  const runId = panel && panel.getAttribute('data-steering-run');
  const events = document.getElementById('steering-events');
  if (runId && events) {
    const next = Number(events.dataset.nextSequence || '1');
    const source = new EventSource('/steering/' + encodeURIComponent(runId) + '/events?after=' + String(Math.max(0, next - 1)));
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
      setTimeout(() => void refreshDashboard(), 500);
    });
  }
})();`;
