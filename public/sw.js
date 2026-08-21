/*
 * Seer — app shell, installable from the desktop route and /m alike
 *
 * This worker used to pin the app to an old build, which is a worse failure
 * than having no worker at all: every deploy looked like it had not happened.
 *
 * Two rules did it together. The shell HTML was served from the cache whenever
 * a navigation fetch failed — which on an installed iOS app happens routinely
 * when it is resumed from the background — and `/_next/static` was cache-first
 * with a cache name that never changed, so the old hashed chunks that stale
 * shell referenced were still there to serve it. The app booted entirely on
 * last week's code and looked perfectly normal doing it.
 *
 * So the shell and the app code now always come from the network. Next's
 * chunks are content-hashed and served immutable, so the browser's own HTTP
 * cache already does the only caching that was worth having, and it cannot
 * serve a shell and a chunk from different builds. Only the icons and the
 * manifest are held here, because those are the things a launcher asks for
 * before the app is running.
 *
 * The trade is that Seer will not boot with no network. It could not do
 * anything useful in that state anyway: every screen it has is a read of the
 * server's projection.
 */
const CACHE = "seer-mobile-v3";
const PRECACHE = [
  "/manifest.webmanifest",
  "/manifest.mobile.webmanifest",
  "/seer-eye.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Renaming the cache is what evicts the stale shell and the old chunks
      // from every installation already out there.
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Launcher assets: network-first so a changed mark is not sticky, cache only
  // as the fallback when there is nothing else to show.
  if (
    url.pathname === "/seer-eye.png" ||
    url.pathname === "/seer-mark.png" ||
    url.pathname.startsWith("/seer-mark-") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.endsWith(".webmanifest")
  ) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Everything else — the shell and the application code — is left to the
  // network and the browser's HTTP cache, so the two can never disagree about
  // which build is running.
});
