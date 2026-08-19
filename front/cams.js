// Global air-quality layers (PM2.5, PM10, dust, aerosol optical depth) from
// /api/cams. One raster image source draped over the world, drawn under the
// basemap's symbol layers so labels stay readable, plus a legend it owns.
//
// Loaded after app.js and overlays.js; talks to the app only through window.WX
// and exposes itself as WX.cams = { load(varName), clear() }.
(function () {
  "use strict";
  const WX = window.WX;
  const M = () => WX.map;
  const WORLD = [[-180, 85.05112878], [180, 85.05112878], [180, -85.05112878], [-180, -85.05112878]];
  const SRC = "cams", LYR = "cams";
  const ALPHA = { pm2_5: 0.85, pm10: 0.85, dust: 0.9, aod550: 0.8 };

  let catalog = null;     // /api/cams/catalog, fetched once per page load
  let current = null;     // variable currently shown, or null
  let reqSeq = 0;

  // ── legend ──────────────────────────────────────────────────────────────
  // Its own <style> element so this file drops in without touching styles.css.
  const CSS = `
  .cams-legend{position:absolute;left:62px;z-index:5;padding:8px 10px 7px;
  bottom:calc(var(--tb-h) + 22px + env(safe-area-inset-bottom));
    border-radius:8px;background:rgba(18,20,26,.82);color:#e8ecf3;
    font:11px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;
    box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px);pointer-events:none;
    max-width:230px}
  :root[data-theme="light"] .cams-legend{background:rgba(252,252,253,.88);color:#1a1d23;
    box-shadow:0 2px 10px rgba(0,0,0,.18)}
  .cams-legend b{font-weight:600;font-size:11.5px;display:block;margin-bottom:5px}
  .cams-legend .bar{height:9px;border-radius:3px;margin:0 0 3px}
  .cams-legend .ticks{display:flex;justify-content:space-between;opacity:.75;
    font-variant-numeric:tabular-nums}
  .cams-legend .src{margin-top:5px;opacity:.6;font-size:10px;line-height:1.3}`;

  function ensureStyle() {
    if (document.getElementById("cams-style")) return;
    const s = document.createElement("style");
    s.id = "cams-style"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Labels come from our own catalog, but the legend is built with innerHTML
  // (a gradient string is awkward otherwise), so escape anything textual.
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Sample the ramp the server sent so the bar matches the PNG exactly.
  function gradient(stops, lo, hi) {
    const span = (hi - lo) || 1;
    const n = (x) => Math.max(0, Math.min(255, Number(x) || 0));   // never interpolate a string into CSS
    return stops.map((s) => `rgb(${s.rgb.map(n).join(",")}) ${(((s.v - lo) / span) * 100).toFixed(1)}%`).join(",");
  }

  function drawLegend(varName) {
    ensureStyle();
    const lg = (catalog.legends || {})[varName];
    if (!lg) return;
    let el = document.querySelector(".cams-legend");
    if (!el) { el = document.createElement("div"); el.className = "cams-legend"; document.body.appendChild(el); document.body.classList.add("has-aq-legend"); }
    const mid = lg.stops[Math.floor(lg.stops.length / 2)].v;
    const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v) : v);
    el.innerHTML =
      `<b>${esc(lg.label)}${lg.units ? ` <span style="opacity:.65">(${esc(lg.units)})</span>` : ""}</b>` +
      `<div class="bar" style="background:linear-gradient(90deg,${gradient(lg.stops, lg.lo, lg.hi)})"></div>` +
      `<div class="ticks"><span>${fmt(lg.lo)}</span><span>${fmt(mid)}</span><span>${fmt(lg.hi)}+</span></div>` +
      `<div class="src">${esc(catalog.run || "?")} Z · ${esc(catalog.source)}</div>`;
  }

  function clearLegend() {
    document.body.classList.remove("has-aq-legend");
    const el = document.querySelector(".cams-legend");
    if (el) el.remove();
  }

  // ── layer ───────────────────────────────────────────────────────────────
  // Snap the app's current forecast hour onto the nearest hour this run has.
  function nearestStep() {
    const steps = (catalog && catalog.steps) || [];
    if (!steps.length) return null;
    const want = (WX.fn && WX.fn.stepHours) ? WX.fn.stepHours() : 0;
    return steps.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  }

  function layerUrl(varName, step) {
    return WX.url(`${WX.API}/cams/layer/${varName}/${String(step).padStart(3, "0")}.png`);
  }

  async function load(varName) {
    const my = ++reqSeq;
    try {
      if (!catalog) catalog = await WX.api(WX.url(`${WX.API}/cams/catalog`));
    } catch (e) {
      WX.fn.toast("Air-quality layers unavailable", 4000, "error");
      return;
    }
    if (my !== reqSeq) return;
    if (!catalog.run || !catalog.steps || !catalog.steps.length) {
      WX.fn.toast("No air-quality data cached. Run wxgrid.cams --refresh.", 5000, "error");
      return;
    }
    if (!catalog.vars || !catalog.vars[varName]) {
      WX.fn.toast(`Air quality: no such variable ${varName}`, 4000, "error");
      return;
    }
    const step = nearestStep();
    const url = layerUrl(varName, step);
    const alpha = ALPHA[varName] != null ? ALPHA[varName] : 0.85;
    if (M().getSource(SRC)) {
      try { M().getSource(SRC).updateImage({ url, coordinates: WORLD }); } catch (e) { /* superseded */ }
      M().setPaintProperty(LYR, "raster-opacity", alpha);
    } else {
      // an `image` source takes no `attribution` (MapLibre rejects the whole
      // source); the credit rides in the legend and the load toast instead
      M().addSource(SRC, { type: "image", url, coordinates: WORLD });
      M().addLayer({ id: LYR, type: "raster", source: SRC,
                     paint: { "raster-opacity": alpha, "raster-fade-duration": 0, "raster-resampling": "linear" } },
                   WX.fn.firstSymbolId());
    }
    const first = current !== varName;
    current = varName;
    drawLegend(varName);
    if (first) {
      const v = catalog.vars[varName];
      WX.fn.toast(`${v.label} · ${catalog.source}. ${catalog.run}Z run, +${step} h`, 5500);
    }
  }

  function clear() {
    reqSeq++;
    current = null;
    if (M() && M().getLayer(LYR)) M().removeLayer(LYR);
    if (M() && M().getSource(SRC)) M().removeSource(SRC);
    clearLegend();
  }

  // Re-point the image at a new forecast hour without a full reload; safe to
  // call on every step change, a no-op when no air-quality layer is showing.
  function refresh() { if (current) load(current); }

  WX.cams = { load, clear, refresh, get active() { return current; },
              get catalog() { return catalog; } };
})();
