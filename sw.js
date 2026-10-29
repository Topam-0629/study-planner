/* 앱 껍데기를 캐시해서 인터넷이 약해도 열리게 한다. 데이터(api.github.com)는 건드리지 않는다. */
var V = "sp-shell-v1";
var SHELL = ["./", "index.html", "gh-store.js?v=1", "manifest.webmanifest", "icon.svg", "icon-192.png", "apple-touch-icon.png",
  "fonts/GmarketSans-Light.woff", "fonts/GmarketSans-Medium.woff", "fonts/GmarketSans-Bold.woff"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  /* HTML·스크립트는 네트워크 우선(업데이트 즉시 반영), 실패하면 캐시. 폰트·아이콘은 캐시 우선 */
  var shellFirst = /\.(woff|png|svg)$/.test(u.pathname);
  if (shellFirst) {
    e.respondWith(caches.match(e.request).then(function (r) { return r || fetch(e.request); }));
  } else {
    e.respondWith(fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(V).then(function (c) { c.put(e.request, copy); });
      return r;
    }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match("index.html"); }); }));
  }
});
