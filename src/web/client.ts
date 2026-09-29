export const dashboardClient = String.raw`(() => {
  const body = document.body;
  const board = document.querySelector('.board');
  const scrollKey = 'conveyor:scroll';

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

  const activitySnapshots = new WeakMap();

  const payloadText = (value) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  };

  const renderIssueActivity = (panel, activity) => {
    const snapshot = JSON.stringify(activity);
    if (activitySnapshots.get(panel) === snapshot) return;
    activitySnapshots.set(panel, snapshot);
    const runsRoot = panel.querySelector('[data-activity-runs]');
    const status = panel.querySelector('[data-activity-status]');
    if (!runsRoot || !status) return;
    runsRoot.replaceChildren();
    const runs = Array.isArray(activity.runs) ? activity.runs : [];
    panel.dataset.live = runs.some((run) => run.status === 'running') ? 'true' : 'false';
    status.textContent = runs.length === 0
      ? 'No runs have been recorded for this issue.'
      : runs.length + (runs.length === 1 ? ' run retained.' : ' runs retained.');

    for (const run of runs) {
      const article = document.createElement('article');
      article.className = 'activity-run';
      const header = document.createElement('header');
      const title = document.createElement('h3');
      title.textContent = String(run.stageId || 'unknown') + ' · ' + String(run.kind || 'run') + ' · attempt ' + String(run.attempt || 1);
      const badge = document.createElement('span');
      badge.className = 'run-status run-status--' + String(run.status || 'unknown').replace(/[^a-z0-9_-]/gi, '');
      badge.textContent = String(run.status || 'unknown');
      header.append(title, badge);
      const timing = document.createElement('p');
      timing.className = 'activity-run-time';
      timing.textContent = String(run.startedAt || '') + (run.finishedAt ? ' → ' + String(run.finishedAt) : ' → now');
      article.append(header, timing);

      const events = Array.isArray(run.events) ? run.events : [];
      const list = document.createElement('ol');
      list.className = 'activity-events';
      for (const item of events) {
        const eventItem = document.createElement('li');
        const meta = document.createElement('div');
        const type = document.createElement('strong');
        type.textContent = String(item.type || 'event');
        const time = document.createElement('time');
        time.textContent = String(item.createdAt || '');
        meta.append(type, time);
        const payload = document.createElement('pre');
        payload.textContent = payloadText(item.payload);
        eventItem.append(meta, payload);
        list.append(eventItem);
      }
      if (events.length > 0) article.append(list);
      if (run.result !== null && run.result !== undefined) {
        const result = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = 'Final result';
        const payload = document.createElement('pre');
        payload.textContent = payloadText(run.result);
        result.append(label, payload);
        article.append(result);
      }
      if (events.length === 0 && (run.result === null || run.result === undefined)) {
        const empty = document.createElement('p');
        empty.className = 'details-empty';
        empty.textContent = run.status === 'running' ? 'Waiting for the first recorded event…' : 'No event payloads were recorded.';
        article.append(empty);
      }
      runsRoot.append(article);
    }
  };

  const loadIssueActivity = async (panel) => {
    if (panel.dataset.loading === 'true') return;
    const url = panel.dataset.activityUrl;
    const status = panel.querySelector('[data-activity-status]');
    if (!url) return;
    panel.dataset.loading = 'true';
    if (status && !activitySnapshots.has(panel)) status.textContent = 'Loading persisted activity…';
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('activity request failed');
      renderIssueActivity(panel, await response.json());
    } catch {
      if (status) status.textContent = 'Activity is temporarily unavailable. Retrying…';
    } finally {
      delete panel.dataset.loading;
    }
  };

  const selectDetailTab = (dialog, name) => {
    for (const tab of dialog.querySelectorAll('[data-detail-tab]')) {
      const selected = tab.getAttribute('data-detail-tab') === name;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of dialog.querySelectorAll('[data-detail-panel]')) {
      const selected = panel.getAttribute('data-detail-panel') === name;
      panel.hidden = !selected;
      if (selected && name === 'activity') void loadIssueActivity(panel);
    }
  };

  const openIssueDialog = (opener) => {
    const id = opener.getAttribute('data-dialog-open');
    const dialog = id ? document.getElementById(id) : null;
    if (dialog instanceof HTMLDialogElement && !dialog.open) {
      selectDetailTab(dialog, 'summary');
      dialog.showModal();
    }
  };

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const containingDialog = event.target.closest('dialog');
    if (containingDialog instanceof HTMLDialogElement) {
      const tab = event.target.closest('[data-detail-tab]');
      if (tab) {
        selectDetailTab(containingDialog, tab.getAttribute('data-detail-tab') || 'summary');
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

  setInterval(() => {
    for (const panel of document.querySelectorAll('dialog[open] [data-detail-panel="activity"]:not([hidden])')) {
      if (panel.dataset.live === 'true') void loadIssueActivity(panel);
    }
  }, 2000);

  const view = body.dataset.dashboardView;
  if (view !== 'agent') {
    let revision = body.dataset.dashboardRevision || '';
    const checkRevision = async () => {
      if (document.hidden || document.querySelector('dialog[open]')) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) return;
      try {
        const response = await fetch('/api/dashboard-revision', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = await response.json();
        if (typeof next.revision === 'string' && next.revision !== revision) {
          revision = next.revision;
          preserveScroll();
          location.reload();
        }
      } catch {}
    };
    setInterval(checkRevision, 4000);
  }

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
        item.append(role, text);
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
