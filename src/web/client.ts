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

  document.addEventListener('click', (event) => {
    const opener = event.target instanceof Element
      ? event.target.closest('[data-dialog-open]')
      : null;
    if (opener) {
      const id = opener.getAttribute('data-dialog-open');
      const dialog = id ? document.getElementById(id) : null;
      if (dialog instanceof HTMLDialogElement) dialog.showModal();
      return;
    }
    if (event.target instanceof HTMLDialogElement && event.target.open) {
      const rectangle = event.target.getBoundingClientRect();
      const inside = event.clientX >= rectangle.left && event.clientX <= rectangle.right &&
        event.clientY >= rectangle.top && event.clientY <= rectangle.bottom;
      if (!inside) event.target.close();
    }
  });

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
