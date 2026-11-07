/* Caches the app shell only. Data is never cached: when offline the app
   says the data is unavailable instead of showing old numbers as current. */
var SHELL = "edge-shell-v1";
var FILES = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  var scope = new URL(self.registration.scope).pathname;
  if (u.pathname.indexOf(scope) !== 0) return;          // API calls go straight to the network
  e.respondWith(fetch(e.request).then(function (r) {
    var copy = r.clone();
    caches.open(SHELL).then(function (c) { c.put(e.request, copy); });
    return r;
  }).catch(function () { return caches.match(e.request); }));
});
