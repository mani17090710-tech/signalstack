// Keeps a copy of the app so it opens instantly even while the free host is waking up. It only handles the app's own pages and files;
// data (/api), the RSS feed, embeds and the legal pages always go straight to the network. Fresh copies win whenever the server answers within 2.5 seconds.
const CACHE = 'ss-shell-v1', WAIT = 2500, PATHS = /^\/(css\/|js\/|icons\/|favicon\.svg$|manifest\.webmanifest$)/;
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.add('/')).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  const shell = r.mode === 'navigate' && u.pathname === '/', asset = PATHS.test(u.pathname);
  if (!shell && !asset) return;
  const key = shell ? '/' : r.url;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE), hit = await cache.match(key);
    const net = fetch(r).then(res => { if (res.ok && res.type === 'basic') cache.put(key, res.clone()); return res; });
    e.waitUntil(net.catch(() => {}));
    if (!hit) return net;
    return Promise.race([net, new Promise(ok => setTimeout(() => ok(hit), WAIT))]).catch(() => hit);
  })());
});
