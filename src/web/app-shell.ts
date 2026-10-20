// The page the browser application starts from: the same for every reader, with no data in it. It
// shows a board-shaped skeleton until the application has loaded the live model.

import { dashboardCss, graphCss, quotaHeaderCss, stickyNavigationCss, stickyNavigationOverridesCss } from "./styles";

const skeletonCss = `
.app-skeleton{box-sizing:border-box;min-height:100vh;padding:1rem clamp(.75rem,2vw,1.5rem);display:grid;gap:1rem;align-content:start}
.app-skeleton [data-bone]{background:var(--panel);border:1px solid var(--line);border-radius:2px;opacity:.55;animation:app-skeleton-pulse 1.4s ease-in-out infinite}
.app-skeleton-header{height:3rem}
.app-skeleton-line{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.5rem}
.app-skeleton-line [data-bone]{height:3.5rem}
.app-skeleton-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem}
.app-skeleton-column{display:grid;gap:.6rem;align-content:start}
.app-skeleton-column [data-bone]{height:6.5rem}
.app-skeleton-column [data-bone]:first-child{height:1.75rem}
.app-skeleton[data-failed] [data-bone]{animation:none}
.app-skeleton-failed{display:none;margin:0;color:var(--stop-text)}
.app-skeleton[data-failed] .app-skeleton-failed{display:block}
@keyframes app-skeleton-pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.app-skeleton [data-bone]{animation:none}}
@media(max-width:760px){.app-skeleton-line{grid-template-columns:repeat(3,minmax(0,1fr))}.app-skeleton-board{grid-template-columns:minmax(0,1fr)}.app-skeleton-column:nth-child(n+2){display:none}}
`;

const column = `<div class="app-skeleton-column"><div data-bone></div><div data-bone></div><div data-bone></div><div data-bone></div></div>`;

/** The application's page; `scriptVersion` names the script so each version is cached on its own. */
export function dashboardAppShell(scriptVersion: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#087f72"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Conveyor</title><script src="/assets/theme.js"></script><style>${dashboardCss}${graphCss}${quotaHeaderCss}${stickyNavigationCss}${stickyNavigationOverridesCss}${skeletonCss}</style><script type="module" src="/assets/app.js?v=${encodeURIComponent(scriptVersion)}"></script><script src="/assets/notifications.js" defer></script></head><body data-dashboard-view="board"><div id="app"><div class="app-skeleton" data-app-skeleton role="status" aria-live="polite" aria-busy="true"><span class="sr-only">Loading the dashboard…</span><div class="app-skeleton-header" data-bone></div><div class="app-skeleton-line">${"<div data-bone></div>".repeat(6)}</div><div class="app-skeleton-board">${column.repeat(4)}</div><p class="app-skeleton-failed" role="alert">The dashboard could not load. Reload the page to try again.</p></div></div></body></html>`;
}
