// wxgrid service worker — offline shell, and a cache that understands what a
// model run is.
//
// Three caches, three lifetimes:
//   shell    the app itself (html/js/css/fonts/vendor/icons). Cache-first;
//            replaced wholesale when VERSION changes.
//   runtime  /api/layer, /api/wind, /api/isolines, /api/thunder — these URLs
//            carry the run id, so their bytes never change: cache-first, and
//            pruned the moment /api/models says that run is gone. A layer PNG
//            therefore never outlives the run it belongs to.
//   data     everything else under /api — network-first, cache as fallback,
//            so an offline app shows the last thing it loaded instead of a
//            broken page. /api/models is in here on purpose: the catalog is
//            the one thing that must be fresh, because it names the runs.
//
// Scope is the DIRECTORY the page lives in (registered as "./sw.js"), never
// the domain root — GitHub Pages serves the demo from /<repo>/, alongside
// whatever else lives on that origin, and front/static-api.js rewrites URLs
// under that same prefix.
"use strict";

const VERSION = "wxgrid-v1";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const DATA = `${VERSION}-data`;
const BASEMAP = `${VERSION}-basemap`;
const MINE = [SHELL, RUNTIME, DATA, BASEMAP];

// The basemap is somebody else's origin, so by default we keep our hands off
// it. The exception: without the style document MapLibre never fires `load`,
// and app.js builds the entire UI inside that callback — an offline app would
// be a black rectangle. So the style, its sprite, its glyphs, the source
// TileJSON and the low-zoom shaded-relief rasters are cached (all small,
// all bounded). The vector tiles under /planet/ are NOT: that is a planet's
// worth of data and no cache should try.
const BASEMAP_HOST = "tiles.openfreemap.org";
const BASEMAP_KEEP = /^\/(styles\/|sprites\/|fonts\/|natural_earth\/|planet$)/;
const BASEMAP_MAX = 400;

// Rendered layers are ~0.3-3 MB each. A long tape session would happily fill
// the origin quota, and Safari evicts the WHOLE origin when it hits it — the
// shell with it. Bounded, oldest-inserted first.
const RUNTIME_MAX = 220;

const BASE = new URL("./", self.registration.scope);
const at = (p) => new URL(p, BASE).href;

// The shell. Anything the app cannot start without.
const SHELL_URLS = [
  "", "index.html", "manifest.webmanifest", "styles.css",
  "app.js", "particles.js", "overlays.js", "panes.js", "tape.js", "search.js",
  "probe.js", "provider.js", "sounding.js", "xsection.js", "fires.js", "sigmet.js",
  "cams.js", "route.js",
  "vendor/maplibre-gl.js", "vendor/maplibre-gl.css",
  "fonts/inter.woff2", "fonts/GeistMono-Variable.woff2", "fonts/Urbanist-Variable.woff2",
  "logo.svg", "icon-32.png", "icon-180.png", "icon-512.png",
].map(at);
// Present in some builds only: the private theme overlay is not shipped in a
// public deployment, static-api.js only exists in the Pages snapshot. Missing
// ones must not fail the install.
const OPTIONAL_URLS = ["private/theme.css", "private/theme.js", "static-api.js"].map(at);

const IMMUTABLE = /^api\/(layer|wind|isolines|thunder)\//;

// ── install / activate ────────────────────────────────────────────────────

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One request each, not cache.addAll: addAll is atomic, so a single 404
    // (a build without the private overlay) would throw away the whole shell.
    await Promise.allSettled(SHELL_URLS.concat(OPTIONAL_URLS).map(async (u) => {
      const res = await fetch(u, { cache: "reload" });
      if (res.ok) await cache.put(u, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("wxgrid-") && !MINE.includes(key)) await caches.delete(key);
    }
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "wx-skip-waiting") self.skipWaiting();
  if (msg.type === "wx-clear-runtime") e.waitUntil(caches.delete(RUNTIME));
});

// ── helpers ───────────────────────────────────────────────────────────────

async function tell(type, extra) {
  for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type, ...extra });
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();                 // insertion order
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Runs come and go (the store keeps two). Their layer URLs are immutable while
// the run exists and meaningless after — so the catalog is the eviction signal.
async function pruneRuns(catalog) {
  const live = new Set();
  for (const m of (catalog && catalog.models) || []) {
    for (const r of m.runs || []) live.add(`/${m.key}/${r.run}/`);
  }
  if (!live.size) return;
  const cache = await caches.open(RUNTIME);
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    // /api/<kind>/<model>/<run>/... — keep anything we cannot parse.
    const m = p.match(/\/api\/(?:layer|wind|isolines|thunder)(\/[^/]+\/[^/]+\/)/);
    if (m && !live.has(m[1])) await cache.delete(req);
  }
}

// ── strategies ────────────────────────────────────────────────────────────

// Shell: cache-first for speed and for offline, with a background refetch so
// a deployed change lands on the NEXT load instead of waiting for someone to
// remember to bump VERSION. Pure cache-first on a repo under active
// development is how you ship a permanently stale app.js.
async function staleWhileRevalidate(req, cacheName, event) {
  const hit = await caches.match(req, { cacheName });
  const network = fetch(req).then(async (res) => {
    if (res.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(req, res.clone());
    }
    return res;
  });
  if (hit) {
    if (event) event.waitUntil(network.catch(() => {}));
    return hit;
  }
  try {
    return await network;
  } catch (err) {
    tell("wx-offline", { url: req.url });
    throw err;
  }
}

// Cache-first, but bounded and pruned. `caches.match` honours the response's
// Vary header, so a WebP layer and a PNG of the same URL stay distinct once
// the API starts negotiating on Accept.
async function immutable(req, event) {
  const hit = await caches.match(req, { cacheName: RUNTIME });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(RUNTIME);
    await cache.put(req, res.clone());
    if (event) event.waitUntil(trim(RUNTIME, RUNTIME_MAX));
  }
  return res;
}

// `key` lets a caller store under a URL other than the request's own — app.js
// cache-busts /api/models with ?ts=<now>, so keying on the raw request would
// write a fresh entry on every load and match none of them when the network
// goes away. The catalog is keyed on its path alone.
async function networkFirst(req, cacheName, key) {
  const at_ = key || req;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(at_, res.clone());
      tell("wx-online", {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(at_, { cacheName });
    if (hit) {
      tell("wx-offline", { url: req.url, stale: true });
      return hit;
    }
    tell("wx-offline", { url: req.url });
    throw err;
  }
}

async function navigate(req, event) {
  try {
    const preload = event && event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(SHELL);
      await cache.put(at("index.html"), res.clone());
      return res;
    }
    if (res) return res;
    throw new Error("no response");
  } catch (err) {
    const shell = await caches.match(at("index.html"), { cacheName: SHELL })
      || await caches.match(at(""), { cacheName: SHELL });
    if (shell) {
      tell("wx-offline", { url: req.url, boot: true });
      return shell;
    }
    return new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

// Only reached when the shell itself was never cached — first visit, offline.
const OFFLINE_HTML = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>wxgrid — offline</title>
<style>html{background:#000;color:#eef1f5;font:15px/1.5 system-ui,sans-serif}
body{margin:0;display:grid;place-items:center;min-height:100dvh;padding:24px}
.c{max-width:26rem;text-align:center}b{font-size:1.1rem}p{color:#7c8492}
button{margin-top:14px;padding:9px 16px;border-radius:10px;border:1px solid #ffffff2e;background:#ffffff14;color:inherit;font:inherit}</style>
<div class=c><b>wxgrid is offline</b><p>Nothing is cached on this device yet — open it once with a connection and it will work offline after that.</p>
<button onclick="location.reload()">Try again</button></div>`;

// ── router ────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                       // POST /api/route etc. always go out
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // RainViewer, NASA GIBS and the vector tiles stay untouched — another
    // origin's bytes, another origin's cache headers. Only the handful of
    // basemap documents the map cannot start without are kept.
    if (url.host === BASEMAP_HOST && BASEMAP_KEEP.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(req, BASEMAP, event));
      event.waitUntil(trim(BASEMAP, BASEMAP_MAX));
    }
    return;
  }
  if (!url.href.startsWith(BASE.href)) return;            // outside our directory scope

  if (req.mode === "navigate") { event.respondWith(navigate(req, event)); return; }

  const rel = url.pathname.slice(BASE.pathname.length);
  if (IMMUTABLE.test(rel)) { event.respondWith(immutable(req, event)); return; }
  if (rel.startsWith("api/")) {
    // /api/models names the runs, so it is never served stale by choice; the
    // catalog that comes back also evicts layers of runs that have expired.
    const isCatalog = rel === "api/models" || rel === "api/models.json";
    event.respondWith((async () => {
      const res = await networkFirst(req, DATA, isCatalog ? new Request(url.origin + url.pathname) : null);
      if (isCatalog && res.ok) event.waitUntil(res.clone().json().then(pruneRuns).catch(() => {}));
      return res;
    })());
    return;
  }
  event.respondWith(staleWhileRevalidate(req, SHELL, event));
});
