export const pwaManifest = {
  id: "/",
  name: "Conveyor",
  short_name: "Conveyor",
  description: "The Conveyor delivery dashboard",
  start_url: "/board",
  scope: "/",
  display: "standalone",
  background_color: "#e8ebe8",
  theme_color: "#087f72",
  icons: [
    { src: "/icons/conveyor-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any maskable" },
    { src: "/icons/conveyor-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
  ],
} as const;

const icon = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}"><rect width="64" height="64" rx="14" fill="#087f72"/><path d="M15 21h34M15 43h34" stroke="#dff8f0" stroke-width="6" stroke-linecap="round"/><path d="m25 14 10 18-10 18" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const pwaIcons = new Map([
  ["/icons/conveyor-192.svg", icon(192)],
  ["/icons/conveyor-512.svg", icon(512)],
]);

export const serviceWorker = String.raw`self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(fetch(request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Offline · Conveyor</title><body><main><h1>You’re offline</h1><p>Reconnect to the network to open the Conveyor dashboard.</p></main></body></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const target = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/board';
  event.waitUntil(self.registration.showNotification('Conveyor update', {
    body: 'There is an update in Conveyor.',
    icon: '/icons/conveyor-192.svg',
    badge: '/icons/conveyor-192.svg',
    data: { url: target },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url || '/board';
  const url = new URL(target, self.location.origin);
  event.waitUntil(self.clients.openWindow((url.origin === self.location.origin ? url : new URL('/board', self.location.origin)).href));
});`;
