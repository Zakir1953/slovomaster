'use strict';
// Офлайн-работа: страницы игры хранятся в телефоне (словарь - отдельно, в IndexedDB, см. app.js).
// Открывается сохранённая копия сразу, а свежая подкачивается в фоне, если есть интернет.
// После изменения файлов игры увеличить VERSION - телефон заберёт новые при следующем запуске.
const VERSION = 'slovomaster-20261123184444';
const FILES = ['./', 'index.html', 'app.js', 'app.css', 'solver.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // словарь и его версия - только из сети (словарь хранит само приложение)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/data/')) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const key = url.pathname.endsWith('/') ? './' : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
