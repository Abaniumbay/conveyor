export const dashboardClient = String.raw`(() => {
  const body = document.body;
  const board = document.querySelector('.board');
  const scrollKey = 'conveyor:scroll';
  let pendingReload = false;
  let conversationRefreshTimer = null;
  let activityRefreshTimer = null;

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

  const formatDateTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  };

  const localizeTimes = (root = document) => {
    for (const time of root.querySelectorAll('time[datetime]')) {
      time.textContent = formatDateTime(time.getAttribute('datetime'));
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
      const meta = document.createElement('small');
      if (message.stageId) meta.append(String(message.stageId) + ' · ');
      const time = document.createElement('time');
      time.dateTime = String(message.createdAt || '');
      time.textContent = formatDateTime(message.createdAt);
      meta.append(time);
      const body = document.createElement('p');
      body.textContent = String(message.message || '');
      header.append(actor, meta);
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

  const validDetailTab = (name) => name === 'conversation' || name === 'activity' ? name : 'summary';

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
    }
    if (updateUrl && dialog.dataset.issueId) {
      const url = new URL(location.href);
      url.searchParams.set('issue', dialog.dataset.issueId);
      if (name === 'summary') url.searchParams.delete('tab');
      else url.searchParams.set('tab', name);
      history.replaceState({ conveyorIssue: dialog.dataset.issueId, conveyorTab: name }, '', url.pathname + url.search + url.hash);
    }
  };

  const issueUrl = (issueId, tab = 'summary') => {
    const url = new URL(location.href);
    url.searchParams.set('issue', issueId);
    if (tab === 'summary') url.searchParams.delete('tab');
    else url.searchParams.set('tab', validDetailTab(tab));
    return url.pathname + url.search + url.hash;
  };

  const openIssueDialog = (opener, updateUrl = true) => {
    const id = opener.getAttribute('data-dialog-open');
    const dialog = id ? document.getElementById(id) : null;
    if (dialog instanceof HTMLDialogElement && !dialog.open) {
      selectDetailTab(dialog, 'summary');
      dialog.showModal();
      const issueId = dialog.dataset.issueId;
      if (updateUrl && issueId && new URL(location.href).searchParams.get('issue') !== issueId) {
        history.pushState({ conveyorIssue: issueId }, '', issueUrl(issueId));
      }
    }
  };

  const findIssueDialog = (issueId) => {
    const dialogs = document.querySelectorAll('dialog[data-issue-id]');
    for (const dialog of dialogs) {
      if (dialog.dataset.issueId === issueId && dialog.dataset.selectedIssue === 'true') return dialog;
    }
    for (const dialog of dialogs) {
      if (dialog.dataset.issueId === issueId) return dialog;
    }
    return null;
  };

  const openDialogElement = (dialog) => {
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
    selectDetailTab(dialog, validDetailTab(new URL(location.href).searchParams.get('tab')));
    dialog.showModal();
  };

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

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
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element)) return;
    const opener = event.target.closest('[data-dialog-open]');
    if (!opener || event.target !== opener) return;
    event.preventDefault();
    openIssueDialog(opener);
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.defaultPrevented) return;
    const link = event.target.closest('.tab, .active-work a, .relationships a, .relation-summary a, .pagination a, .agent-history a');
    if (!(link instanceof HTMLAnchorElement) || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    body.classList.add('page-loading');
  }, true);

  document.addEventListener('submit', async (event) => {
    const form = event.target;
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
    const issueId = event.target.dataset.issueId;
    const url = new URL(location.href);
    if (!issueId || url.searchParams.get('issue') !== issueId) return;
    url.searchParams.delete('issue');
    url.searchParams.delete('tab');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (pendingReload) {
      preserveScroll();
      location.reload();
    }
  }, true);

  window.addEventListener('popstate', () => {
    const requested = new URL(location.href).searchParams.get('issue');
    for (const dialog of document.querySelectorAll('dialog[data-issue-id][open]')) {
      if (dialog.dataset.issueId !== requested) dialog.close();
    }
    if (requested) openDialogElement(findIssueDialog(requested));
    const dialog = requested ? findIssueDialog(requested) : null;
    if (dialog instanceof HTMLDialogElement && dialog.open) {
      selectDetailTab(dialog, new URL(location.href).searchParams.get('tab'));
    }
  });

  const requestedIssue = new URL(location.href).searchParams.get('issue');
  if (requestedIssue) openDialogElement(findIssueDialog(requestedIssue));

  localizeTimes();

  const serverStatus = document.querySelector('[data-server-status]');
  const connectionState = serverStatus && serverStatus.querySelector('[data-connection-state]');
  const serverMetrics = serverStatus && serverStatus.querySelector('[data-server-metrics]');
  let revision = body.dataset.dashboardRevision || '';
  const dashboardEvents = new EventSource('/events/dashboard');
  const setConnection = (connected) => {
    if (!serverStatus || !connectionState) return;
    serverStatus.dataset.connected = connected ? 'true' : 'false';
    connectionState.textContent = connected ? 'Connected' : 'Reconnecting';
  };
  dashboardEvents.onopen = () => setConnection(true);
  dashboardEvents.onerror = () => setConnection(false);
  dashboardEvents.addEventListener('status', (message) => {
    if (!serverMetrics) return;
    try {
      const status = JSON.parse(message.data);
      serverMetrics.textContent = 'Memory ' + formatBytes(status.memory.usedBytes) + ' / ' + formatBytes(status.memory.totalBytes) +
        ' · Disk ' + formatBytes(status.disk.usedBytes) + ' / ' + formatBytes(status.disk.totalBytes) +
        ' · App ' + formatBytes(status.memory.processBytes) + ' · Up ' + formatElapsed(status.uptimeSeconds);
    } catch {
      serverMetrics.textContent = 'Server metrics unavailable';
    }
  });
  dashboardEvents.addEventListener('revision', (message) => {
    try {
      const next = JSON.parse(message.data);
      if (typeof next.revision !== 'string' || next.revision === revision) return;
      revision = next.revision;
      body.dataset.dashboardRevision = revision;
      const openDialog = document.querySelector('dialog[open]');
      if (openDialog) {
        pendingReload = true;
        return;
      }
      preserveScroll();
      location.reload();
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
        role.textContent = event.type === 'user' ? 'You' : event.type === 'report' ? 'Report' : 'Agent';
        const text = document.createElement('p');
        text.textContent = String(event.text || '');
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
      setTimeout(() => location.reload(), 500);
    });
  }
})();`;
