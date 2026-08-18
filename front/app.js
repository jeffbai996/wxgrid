// wxgrid front end — core: map, controls, layers/overlays, time bar + tape,
// place/resort search, tapped-point marker. The point card's panes live in
// panes.js and hang off window.WX. Everything comes from /api (plus
// RainViewer tiles for radar and OpenFreeMap for the basemap).
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const API = "api";
  const WORLD = [[-180, 85.05112878], [180, 85.05112878], [180, -85.05112878], [-180, -85.05112878]];
  const LAYERS = ["wind", "temp", "gust", "tp6", "sf6", "sd_cm", "tcc", "msl", "d2m", "frz", "cape"];
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", msl: "Pressure", tp6: "Rain", sf6: "New snow", sd_cm: "Snow depth", tcc: "Clouds", cape: "CAPE", d2m: "Dew point", frz: "Freezing lvl" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, sf6: 0.9, sd_cm: 0.85, tcc: 0.9, cape: 0.85, d2m: 0.75, frz: 0.7 };
  const LAYER_ICON = {
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>',
    gust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v8"/><path d="M12.8 21.6A2 2 0 1 0 14 18H2"/><path d="M17.5 10a2.5 2.5 0 1 1 2 4H2"/><path d="m6 6 4 4 4-4"/></svg>',
    tp6: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
    sf6: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
    sd_cm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/></svg>',
    tcc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    msl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
    d2m: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>',
    frz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h10"/><path d="M9 4v16"/><path d="m3 9 3 3-3 3"/><path d="M12 6 9 9"/><path d="M12 18l-3-3"/><path d="M14 4v10.54a4 4 0 1 1-4 0"/></svg>',
    cape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  };
  const LEVEL_FT = { 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 500: "FL180", 300: "FL300", 250: "FL340" };
  const LEVEL_M = { 925: "≈750 m", 850: "≈1.5 km", 700: "≈3 km", 500: "≈5.5 km", 300: "≈9 km", 250: "≈10.5 km" };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
  };
  let map, wind, catalog, playTimer = null, marker = null;

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s" }[state.units]);
  const arrowRot = (deg) => `transform: rotate(${(deg + 180 + 45) % 360}deg)`;   // chevron points TO where wind goes
  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];
  // Static (GitHub Pages) builds load static-api.js first; it rewrites URLs
  // and answers the JSON endpoints from files. Live builds pass straight through.
  const U = (u) => (window.WXStatic ? window.WXStatic.url(u) : u);
  const apiJson = (u) => window.WXStatic ? window.WXStatic.api(u) : fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  window.WX = { state, speed, speedUnit, arrowRot, f, arrow, LEVEL_FT, LEVEL_M, AVY_COLORS, API,
                get map() { return map; }, get catalog() { return catalog; }, toast, modelEntry: () => modelEntry(), openPoint, closePoint,
                get validDate() { return validDate(); }, get stepHours() { return stepHours(); }, api: apiJson, url: U };

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const saved = JSON.parse(localStorage.getItem("wxgrid.view") || "null");
    applyTheme(localStorage.getItem("wxgrid.theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"), false);
    const hash = readHash();
    map = new maplibregl.Map({
      container: "map", style: mapStyle(),
      center: hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], zoom: hash ? hash.zoom : saved ? saved.zoom : 4,
      minZoom: 1.2, maxZoom: 11, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("moveend", () => {
      localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      if (!state.point) refreshTapePoint();
      pushHash();
    });
    wind = new WindLayer(map, $("#particles"));
    new ResizeObserver(() => document.documentElement.style.setProperty("--tb-h", $("#timebar").offsetHeight + "px")).observe($("#timebar"));
    new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $("#topbar").offsetHeight + "px")).observe($("#topbar"));

    catalog = await WX.api(`${API}/models?ts=${Date.now()}`);
    if (catalog.static) toast(`Static demo snapshot — ${catalog.static.note}. Run ${catalog.static.built}Z. Self-host for the full thing.`, 9000);
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs in the store yet — ingest is still running.", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];

    if (hash) { if (hash.model && catalog.models.some((m) => m.key === hash.model && m.runs.length)) state.model = hash.model; if (hash.layer && LAYERS.includes(hash.layer)) state.layer = hash.layer; state.level = hash.level || 0; state.run = modelEntry().runs[0].run; if (hash.step != null) state.stepIdx = Math.min(hash.step, steps().length - 1); }
    map.on("load", () => {
      ensureWxLayer();
      map.on("click", (e) => {
        if (state.measure) { measureClick(e.lngLat); return; }
        const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-pts", "avy-fill"].filter((l) => map.getLayer(l)) });
        const resort = feats.find((x) => x.layer.id === "resort-pts");
        if (resort) { selectResort(resort.properties.id); return; }
        openPoint(e.lngLat.lat, e.lngLat.lng);
        const avy = feats.find((x) => x.layer.id === "avy-fill");
        if (avy) { state.tab = "winter"; }
      });
      map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
      map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");
      renderControls();
      applyStep();
      loadWind();
      refreshTapePoint();
      if (hash && hash.pt) openPoint(hash.pt[0], hash.pt[1]);
    });
  }
  const firstSymbolId = () => { const l = map.getStyle().layers.find((x) => x.type === "symbol"); return l ? l.id : undefined; };
  const mapStyle = () => document.documentElement.dataset.theme === "light" ? "https://tiles.openfreemap.org/styles/positron" : "https://tiles.openfreemap.org/styles/dark";
  function ensureWxLayer() {
    if (map.getSource("wx")) return;
    map.addSource("wx", { type: "image", url: layerUrl(), coordinates: WORLD });
    map.addLayer({ id: "wx", type: "raster", source: "wx", paint: { "raster-opacity": LAYER_ALPHA[state.layer], "raster-fade-duration": 0, "raster-resampling": "linear" } }, firstSymbolId());
  }
  // After a basemap swap every custom source is gone; put back whatever was on.
  function restoreLayers() {
    ensureWxLayer(); applyStep();
    if (state.radar && state.radarFrames.length) applyRadarFrame();
    if (state.iso) loadIso();
    if (state.avy) loadAvy();
    if (state.resorts) loadResorts();
    if (state.resort) selectResort(state.resort.resort.id);
    if (marker) marker.addTo(map);
  }
  function applyTheme(theme, swapMap = true) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("wxgrid.theme", theme);
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#eef1f5" : "#000000";
    if (swapMap && map) {
      map.setStyle(mapStyle(), { diff: false });
      // style.load is what fires once the new style's sources exist; idle
      // is the belt for the braces on builds where it doesn't.
      map.once("style.load", restoreLayers);
      map.once("idle", () => { if (!map.getSource("wx")) restoreLayers(); });
    }
  }

  // ── permalink: #lat,lon,zoom · model · layer[/level] · step [· pt lat,lon]
  function readHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return null;
    const m = h.match(/^(-?[\d.]+),(-?[\d.]+),([\d.]+)(?:;([a-z]+))?(?:;([a-z_0-9]+)(?:\/(\d+))?)?(?:;s(\d+))?(?:;p(-?[\d.]+),(-?[\d.]+))?/);
    if (!m) return null;
    return { lat: +m[1], lon: +m[2], zoom: +m[3], model: m[4], layer: m[5], level: m[6] ? +m[6] : 0, step: m[7] != null ? +m[7] : null, pt: m[8] ? [+m[8], +m[9]] : null };
  }
  let hashTimer = null;
  function pushHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      if (!map) return;
      const c = map.getCenter();
      let h = `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(2)};${state.model};${state.layer}${state.level ? "/" + state.level : ""};s${state.stepIdx}`;
      if (state.point) h += `;p${state.point.lat.toFixed(3)},${state.point.lon.toFixed(3)}`;
      history.replaceState(null, "", "#" + h);
    }, 250);
  }

  // ── measure tool: two taps → distance (km / nm) and true bearing ──────
  let measurePts = [];
  function measureClick(ll) {
    measurePts.push([ll.lng, ll.lat]);
    if (measurePts.length > 2) measurePts = [[ll.lng, ll.lat]];
    const gj = { type: "FeatureCollection", features: measurePts.length === 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: measurePts } }] : [] };
    if (map.getSource("measure")) map.getSource("measure").setData(gj);
    else { map.addSource("measure", { type: "geojson", data: gj }); map.addLayer({ id: "measure-line", type: "line", source: "measure", paint: { "line-color": "#ffb454", "line-width": 2, "line-dasharray": [1.5, 1.5] } }); }
    const box = $("#measure"); box.hidden = false;
    if (measurePts.length < 2) { box.textContent = "tap the second point"; return; }
    const [a, b] = measurePts;
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(h));
    const y = Math.sin(dLon) * Math.cos(b[1] * toR), x = Math.cos(a[1] * toR) * Math.sin(b[1] * toR) - Math.sin(a[1] * toR) * Math.cos(b[1] * toR) * Math.cos(dLon);
    const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    box.innerHTML = `<b>${km.toFixed(km < 100 ? 1 : 0)} km</b> · ${(km / 1.852).toFixed(km < 100 ? 1 : 0)} nm · ${(km * 0.621371).toFixed(0)} mi · true bearing <b>${brg.toFixed(0).padStart(3, "0")}°</b>`;
  }
  function clearMeasure() { measurePts = []; $("#measure").hidden = true; if (map.getLayer("measure-line")) map.removeLayer("measure-line"); if (map.getSource("measure")) map.removeSource("measure"); }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + stepHours() * 3600e3);
  const hasLevel = () => ["wind", "temp"].includes(state.layer);
  const levelQ = () => (state.level && hasLevel()) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => U(`${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  const windUrl = (h = stepHours()) => U(`${API}/wind/${state.model}/${state.run}/${h}.json${state.level ? `?level=${state.level}` : ""}`);

  // ── controls ──────────────────────────────────────────────────────────
  function renderControls() {
    const ms = $("#models");
    ms.innerHTML = catalog.models.map((m) => `<button data-model="${m.key}" class="${m.key === state.model ? "on" : ""}" ${m.runs.length ? "" : "disabled"} title="${m.label}">${m.short}</button>`).join("");
    ms.querySelectorAll("button").forEach((b) => b.onclick = () => switchModel(b.dataset.model));

    const rs = $("#run");
    rs.innerHTML = modelEntry().runs.map((r) => `<option value="${r.run}">${r.run.slice(5).replace("T", " ")}Z</option>`).join("");
    rs.value = state.run;
    rs.onchange = () => { state.run = rs.value; clampStep(); renderControls(); applyStep(); loadWind(); refreshPoint(); };

    const rail = $("#layers");
    rail.innerHTML = LAYERS.map((l) =>
      `<button class="${l === state.layer ? "on" : ""}" data-layer="${l}" ${runEntry().layers.includes(l) ? "" : "disabled"} title="${LAYER_LABEL[l]}">${LAYER_ICON[l]}<span>${LAYER_LABEL[l]}</span></button>`).join("");
    rail.querySelectorAll("button").forEach((b) => b.onclick = () => {
      state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer);
      if (!hasLevel()) state.level = 0;
      renderControls(); applyStep(); loadWind(); if (state.iso) loadIso(); });

    const alt = $("#alt"), lv = $("#levels");
    const levels = runEntry().levels || [];
    const showLevels = hasLevel() && levels.length;
    alt.hidden = !showLevels;
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      $("#alt-label").textContent = state.level ? `${state.level} hPa` : "sfc";
      lv.innerHTML = `<div class="hd"><span>level</span><span>metres</span><span>feet</span></div>` + opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" role="menuitem"><b>${l ? l + " hPa" : "sfc"}</b><small>${l ? LEVEL_M[l].replace("≈", "≈ ") : "10 m / 2 m"}</small><small>${l ? LEVEL_FT[l] : "—"}</small></button>`).join("");
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => { state.level = Number(b.dataset.level); lv.hidden = true; renderControls(); applyStep(); loadWind(); if (state.iso) loadIso(); pushHash(); });
      $("#alt-btn").onclick = (e) => { e.stopPropagation(); lv.hidden = !lv.hidden; };
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    slider.value = String(state.stepIdx);
    slider.oninput = () => { state.stepIdx = Number(slider.value); applyStep(false); };
    slider.onchange = () => { applyStep(true); loadWind(); };

    renderLegend();
    $("#play").onclick = togglePlay;
    $("#particles-toggle").onclick = () => { state.particles = !state.particles; $("#particles-toggle").classList.toggle("on", state.particles); wind.setEnabled(state.particles); };
    $("#units-toggle").textContent = speedUnit();
    $("#units-toggle").onclick = () => {
      state.units = { kmh: "kt", kt: "ms", ms: "kmh" }[state.units];
      localStorage.setItem("wxgrid.units", state.units);
      $("#units-toggle").textContent = speedUnit();
      renderLegend(); renderPoint(); renderTape();
    };
    $("#radar-toggle").onclick = toggleRadar;
    $("#theme-toggle").onclick = () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    $("#measure-toggle").onclick = () => { state.measure = !state.measure; $("#measure-toggle").classList.toggle("on", state.measure); if (!state.measure) clearMeasure(); else toast("Measure: tap two points"); };
    $("#iso-toggle").onclick = () => { state.iso = !state.iso; $("#iso-toggle").classList.toggle("on", state.iso); if (state.iso) loadIso(); else clearIso(); };
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) loadAvy(); else clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) loadResorts(); else clearResorts(); };
    $("#locate").onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(
      (p) => { map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 7) }); openPoint(p.coords.latitude, p.coords.longitude); },
      () => toast("Location unavailable"));
    $("#point-close").onclick = closePoint;
    wireSearch();
    $$(".point-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderPoint(); });
    document.addEventListener("keydown", (e) => {
      if (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "Escape") { closePoint(); hideResults(); }
    });
  }

  function switchModel(key) {
    // Keep the VALID time, not the step index: comparing models means the same moment.
    const target = validDate().getTime();
    state.model = key; localStorage.setItem("wxgrid.model", key);
    state.run = modelEntry().runs[0].run;
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); refreshTapePoint(); if (state.iso) loadIso();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; applyRadarFrame(); return; }
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) loadIso();
  }
  function setStep(i) { state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) loadIso(); }

  function applyStep(prefetch = true) {
    pushHash();
    const src = map.getSource("wx");
    if (src) { try { src.updateImage({ url: layerUrl(), coordinates: WORLD }); } catch (e) { /* superseded */ } }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", state.radar ? Math.min(0.45, LAYER_ALPHA[state.layer]) : LAYER_ALPHA[state.layer]);
    const v = validDate();
    $("#valid-local").textContent = v.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    $("#lead").textContent = `+${stepHours()}h`;
    if (prefetch) { const img = new Image(); img.src = layerUrl(steps()[(state.stepIdx + 1) % steps().length]); }
    renderTapeSelection();
    if (state.point) renderPoint();
  }

  let windReq = 0;
  async function loadWind() {
    if (!runEntry().layers.includes("wind")) { wind.setField(null); return; }
    const my = ++windReq;
    try {
      const fld = await WX.api(windUrl());
      if (my !== windReq) return;
      wind.setField(fld);
      fetch(windUrl(steps()[(state.stepIdx + 1) % steps().length])).catch(() => {});
    } catch (e) { /* keep the previous field */ }
  }

  function togglePlay() {
    state.playing = !state.playing;
    $("#play").textContent = state.playing ? "❚❚" : "▶";
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (state.playing) playTimer = setInterval(() => nudge(1), state.radar ? 450 : 900);
  }

  function renderLegend() {
    const lg = catalog.layers.find((l) => l.layer === state.layer);
    if (!lg) { $("#legend").hidden = true; return; }
    $("#legend").hidden = false;
    const grad = lg.stops.map((s) => `rgb(${s.rgb.join(",")}) ${((s.v - lg.lo) / (lg.hi - lg.lo) * 100).toFixed(1)}%`).join(", ");
    $(".legend-bar").style.background = `linear-gradient(to right, ${grad})`;
    const isSpeed = ["wind", "gust"].includes(state.layer);
    const conv = (v) => isSpeed ? Math.round(speed(v)) : Math.round(v);
    const unit = isSpeed ? speedUnit() : lg.units;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => lg.lo + (lg.hi - lg.lo) * q);
    const name = LAYER_LABEL[state.layer] + (state.level && hasLevel() ? ` ${state.level}` : "");
    $(".legend-ticks").innerHTML = ticks.map((t, i) => `<span>${i === 2 ? `<b>${name}</b> ` : ""}${conv(t)}${i === 4 ? " " + unit : ""}</span>`).join("");
  }

  // ── isolines overlay ──────────────────────────────────────────────────
  let isoReq = 0;
  function isoVar() {
    if (state.layer === "temp") return state.level ? `temp?level=${state.level}` : "temp";
    if (state.layer === "frz") return "frz";
    if (state.layer === "wind" && state.level === 500) return "gh_500";
    return "msl";
  }
  async function loadIso() {
    const my = ++isoReq;
    const v = isoVar();
    const url = U(`${API}/isolines/${state.model}/${state.run}/${stepHours()}/${v.includes("?") ? v.replace("?", ".json?") : v + ".json"}`);
    try {
      const gj = await WX.api(url);
      if (my !== isoReq || !state.iso) return;
      if (map.getSource("iso")) map.getSource("iso").setData(gj);
      else {
        map.addSource("iso", { type: "geojson", data: gj });
        map.addLayer({ id: "iso-line", type: "line", source: "iso", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": ["case", ["==", ["%", ["get", "value"], ["*", 4, gj.interval || 4]], 0], 1.4, 0.7] } }, firstSymbolId());
        map.addLayer({ id: "iso-label", type: "symbol", source: "iso", layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Regular"], "symbol-spacing": 320 }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.7)", "text-halo-width": 1.2 } });
      }
    } catch (e) { toast("Isolines unavailable for this layer"); }
  }
  function clearIso() { ["iso-label", "iso-line"].forEach((l) => map.getLayer(l) && map.removeLayer(l)); if (map.getSource("iso")) map.removeSource("iso"); }

  // ── avalanche regions overlay ─────────────────────────────────────────
  async function loadAvy() {
    try {
      const gj = await WX.api(`${API}/avy/layer`);
      if (!state.avy) return;
      if (map.getSource("avy")) map.getSource("avy").setData(gj);
      else {
        map.addSource("avy", { type: "geojson", data: gj });
        map.addLayer({ id: "avy-fill", type: "fill", source: "avy", paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", [">", ["get", "danger_level"], 0], 0.32, 0.12] } }, firstSymbolId());
        map.addLayer({ id: "avy-line", type: "line", source: "avy", paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.8 } }, firstSymbolId());
      }
      const rated = gj.features.filter((x) => x.properties.danger_level > 0).length;
      toast(rated ? `Avalanche regions: ${rated} with a current rating` : "Avalanche regions loaded — off season, no current ratings (forecasts resume ~November)", 5000);
    } catch (e) { toast("Avalanche layer unavailable"); state.avy = false; $("#avy-toggle").classList.remove("on"); }
  }
  function clearAvy() { ["avy-line", "avy-fill"].forEach((l) => map.getLayer(l) && map.removeLayer(l)); if (map.getSource("avy")) map.removeSource("avy"); }

  // ── ski resorts overlay ───────────────────────────────────────────────
  let resortsCatalog = null;
  async function loadResorts() {
    try {
      if (!resortsCatalog) resortsCatalog = (await WX.api(`${API}/resorts/all`)).resorts;
      if (!state.resorts) return;
      const gj = { type: "FeatureCollection", features: resortsCatalog.map((r) => ({ type: "Feature", properties: { id: r.id, name: r.name }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } })) };
      if (map.getSource("resorts")) map.getSource("resorts").setData(gj);
      else {
        map.addSource("resorts", { type: "geojson", data: gj });
        map.addLayer({ id: "resort-pts", type: "circle", source: "resorts", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.5, 8, 6], "circle-color": "#ffb454", "circle-stroke-color": "#0b0d10", "circle-stroke-width": 1.2, "circle-opacity": 0.9 } });
        map.addLayer({ id: "resort-lbl", type: "symbol", source: "resorts", minzoom: 7, layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.2 } });
      }
    } catch (e) { toast("Resort catalog unavailable"); }
  }
  function clearResorts() { ["resort-lbl", "resort-pts"].forEach((l) => map.getLayer(l) && map.removeLayer(l)); if (map.getSource("resorts")) map.removeSource("resorts"); }

  async function selectResort(id) {
    try {
      const d = await WX.api(`${API}/resorts/${id}`);
      state.resort = d;
      const r = d.resort;
      // lifts + boundary on the map
      const lifts = d.lifts || { type: "FeatureCollection", features: [] };
      if (map.getSource("lifts")) map.getSource("lifts").setData(lifts);
      else {
        map.addSource("lifts", { type: "geojson", data: lifts });
        map.addLayer({ id: "lifts-line", type: "line", source: "lifts", paint: { "line-color": "#ffb454", "line-width": 2, "line-opacity": 0.9 } });
        map.addLayer({ id: "lifts-lbl", type: "symbol", source: "lifts", minzoom: 11, layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 10, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1 } });
      }
      const bnd = d.boundary ? { type: "FeatureCollection", features: [d.boundary] } : { type: "FeatureCollection", features: [] };
      if (map.getSource("bnd")) map.getSource("bnd").setData(bnd);
      else { map.addSource("bnd", { type: "geojson", data: bnd }); map.addLayer({ id: "bnd-line", type: "line", source: "bnd", paint: { "line-color": "#ffb454", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, firstSymbolId()); }
      map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 10.5), duration: 900 });
      state.tab = "resort";
      openPoint(r.lat, r.lon, r.name);
    } catch (e) { toast("Resort detail unavailable"); }
  }
  WX.selectResort = selectResort;

  // ── radar (RainViewer) ────────────────────────────────────────────────
  async function toggleRadar() {
    state.radar = !state.radar;
    $("#radar-toggle").classList.toggle("on", state.radar);
    if (!state.radar) {
      if (map.getLayer("radar")) map.removeLayer("radar");
      if (map.getSource("radar")) map.removeSource("radar");
      state.radarFrames = [];
      renderTape(); applyStep();
      return;
    }
    try {
      const j = await (await fetch(RAINVIEWER, { cache: "no-store" })).json();
      state.radarHost = j.host;
      state.radarFrames = [...j.radar.past.map((x) => ({ ...x, kind: "past" })), ...j.radar.nowcast.map((x) => ({ ...x, kind: "nowcast" }))];
      state.radarIdx = j.radar.past.length - 1;
      applyRadarFrame();
      renderTape();
      toast("Radar: RainViewer composite, last 2 h + 30 min nowcast. Coverage where radars exist.", 5000);
    } catch (e) { toast("Radar unavailable right now"); state.radar = false; $("#radar-toggle").classList.remove("on"); }
  }
  function radarTiles(fr) { return [`${state.radarHost}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`]; }
  function applyRadarFrame() {
    const fr = state.radarFrames[state.radarIdx];
    if (!fr) return;
    if (map.getSource("radar")) map.getSource("radar").setTiles(radarTiles(fr));
    else {
      map.addSource("radar", { type: "raster", tiles: radarTiles(fr), tileSize: 256, attribution: "Radar © RainViewer" });
      map.addLayer({ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, firstSymbolId());
    }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", Math.min(0.45, LAYER_ALPHA[state.layer]));
    const t = new Date(fr.time * 1000);
    $("#valid-local").textContent = t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) + (fr.kind === "nowcast" ? " · nowcast" : " · radar");
    $("#valid-utc").textContent = t.toISOString().slice(11, 16) + "Z";
    const ageMin = Math.round((Date.now() / 1000 - fr.time) / 60);
    $("#lead").textContent = ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`;
    renderTapeSelection();
  }

  // ── weather tape ──────────────────────────────────────────────────────
  let tapeReq = 0;
  async function refreshTapePoint() {
    const c = map.getCenter();
    const my = ++tapeReq;
    try {
      const d = await WX.api(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&model=${state.model}&run=${state.run}`);
      if (my !== tapeReq) return;
      state.tapePoint = d;
      renderTape();
    } catch (e) { /* keep last */ }
  }
  function tapeData() { return (state.point && state.point.data) || state.tapePoint; }

  // Windy-style tape: a table whose columns are forecast steps grouped under
  // day headers and whose rows are variables (icon, temp, feels like, rain,
  // wind, gusts, direction). Click a column to jump.
  function renderTape() {
    const tape = $("#tape");
    tape.classList.toggle("radar", state.radar && state.radarFrames.length > 0);
    if (state.radar && state.radarFrames.length) {
      let html = "", lastDay = null;
      state.radarFrames.forEach((fr, i) => {
        const t = new Date(fr.time * 1000), day = t.toDateString();
        if (day !== lastDay) { if (lastDay !== null) html += "</div></div>"; html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short" })} · radar</div><div class="tape-cols">`; lastDay = day; }
        html += `<div class="tape-col ${fr.kind}" data-radar="${i}"><span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span class="tape-glyph" style="color:${fr.kind === "nowcast" ? "var(--warm)" : "var(--rain)"};text-align:center">${fr.kind === "nowcast" ? "◌" : "●"}</span></div>`;
      });
      tape.innerHTML = html + "</div></div>";
      tape.querySelectorAll(".tape-col").forEach((c) => c.onclick = () => { state.radarIdx = Number(c.dataset.radar); applyRadarFrame(); });
      $("#tape-where").textContent = "";
      renderTapeSelection();
      return;
    }
    const d = tapeData();
    if (!d) { tape.innerHTML = ""; return; }
    const s = d.series, n = d.steps.length;
    const dates = d.valid.map((iso) => new Date(iso));
    // day header cells: colspan per day
    const days = [];
    dates.forEach((dt, i) => { const k = dt.toDateString(); if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, start: dt, span: 0 }); days[days.length - 1].span++; });
    const dayRow = days.map((dy) => `<th colspan="${dy.span}" class="day">${dy.start.toLocaleDateString(undefined, { weekday: "long", day: "numeric" })}</th>`).join("");
    const cell = (i, inner, cls = "") => `<td class="${cls} ${dates[i].getHours() < 6 || dates[i].getHours() >= 21 ? "night" : ""}" data-i="${i}">${inner}</td>`;
    const hourRow = dates.map((dt, i) => cell(i, `<span class="hr">${dt.toLocaleTimeString(undefined, { hour: "numeric" }).replace(":00", "").replace(/\s/, "<small>") + (/[ap]m/i.test(dt.toLocaleTimeString(undefined, { hour: "numeric" })) ? "</small>" : "")}</span>`, "hour")).join("");
    const iconRow = dates.map((_, i) => cell(i, glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, dates[i].getHours() < 6 || dates[i].getHours() >= 21), "ico")).join("");
    const tempRow = dates.map((_, i) => cell(i, s.t2m && s.t2m[i] != null ? `${Math.round(s.t2m[i] - 273.15)}°` : "—", "temp")).join("");
    const feels = (i) => { const t = s.t2m ? s.t2m[i] - 273.15 : null, w = s.wind ? s.wind[i] : null; if (t == null) return null; if (w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; } if (s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); return t + 0.5555 * (e - 10); } return t; };
    const feelsRow = dates.map((_, i) => { const v = feels(i); return cell(i, v == null ? "—" : `${Math.round(v)}°`, "feels"); }).join("");
    const rainRow = dates.map((_, i) => { const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0; if (r == null) return cell(i, "", "rain"); if (sn >= 0.3) return cell(i, `<span class="snow">${sn.toFixed(sn < 10 ? 1 : 0)}</span>`, "rain"); return cell(i, r >= 0.1 ? `<span>${r.toFixed(r < 10 ? 1 : 0)}</span>` : "", "rain"); }).join("");
    const windCol = (v) => { const kmh = v * 3.6; const p = Math.min(1, kmh / 70); return `background: rgba(${Math.round(60 + 180 * p)}, ${Math.round(160 - 60 * p)}, ${Math.round(220 - 200 * p)}, ${0.15 + 0.6 * p})`; };
    const windRow = dates.map((_, i) => { const v = s.wind ? s.wind[i] : null; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("");
    const gustRow = s.gust ? dates.map((_, i) => { const v = s.gust[i]; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("") : "";
    const dirRow = dates.map((_, i) => cell(i, s.wdir && s.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(s.wdir[i])}"></i>` : "", "dir")).join("");
    const label = (t, u) => `<th class="lab">${t}${u ? `<small>${u}</small>` : ""}</th>`;
    tape.innerHTML = `<table class="wtape"><thead><tr><th class="lab corner"></th>${dayRow}</tr></thead><tbody>
      <tr class="r-hour">${label("Hours")}${hourRow}</tr>
      <tr class="r-icon">${label("")}${iconRow}</tr>
      <tr class="r-temp">${label("Temp", "°C")}${tempRow}</tr>
      <tr class="r-feels">${label("Feels like", "°C")}${feelsRow}</tr>
      <tr class="r-rain">${label("Rain / snow", "mm · cm")}${rainRow}</tr>
      <tr class="r-wind">${label("Wind", speedUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${label("Gusts", speedUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${label("Wind dir.")}${dirRow}</tr>
    </tbody></table>`;
    tape.querySelectorAll("td[data-i]").forEach((c) => c.onclick = () => setStep(Number(c.dataset.i)));
    $("#tape-where").textContent = state.point ? (state.point.name || `${state.point.lat.toFixed(2)}, ${state.point.lon.toFixed(2)}`) : "map centre";
    renderTapeSelection();
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const radar = state.radar && state.radarFrames.length;
    let on = null;
    tape.querySelectorAll(radar ? ".tape-col" : "td[data-i]").forEach((c) => {
      const isOn = radar ? Number(c.dataset.radar) === state.radarIdx : Number(c.dataset.i) === state.stepIdx;
      c.classList.toggle("on", isOn); if (isOn && !on) on = c;
    });
    if (on) { const r = on.getBoundingClientRect(), tr = tape.getBoundingClientRect(); if (r.left < tr.left + 40 || r.right > tr.right - 40) on.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }
  }

  function glyph(cloud, precip, tK, night) {
    const c = cloud == null ? 0 : cloud;
    const snow = tK != null && tK - 273.15 < 1 && precip > 0.2;
    const body = night ? `<circle cx="7" cy="7" r="4" fill="#cfd6e3"/>` : `<circle cx="7" cy="7" r="4" fill="#ffd166"/>`;
    const cl = c > 0.25 ? `<path d="M6 12h9a3 3 0 0 0 0-6 4 4 0 0 0-7.6-1A3.5 3.5 0 0 0 6 12z" fill="rgba(210,218,230,${0.35 + 0.65 * c})"/>` : "";
    const rn = precip > 0.2 ? (snow ? `<text x="9" y="15" font-size="6" fill="#dfe8ff">✱</text>` : `<path d="M8 12.5v2M12 12.5v2M16 12.5v2" stroke="#6cb6ff" stroke-width="1.4" stroke-linecap="round"/>`) : "";
    return `<svg class="tape-glyph" viewBox="0 0 20 16">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  }

  // ── search: places + resorts ──────────────────────────────────────────
  let searchTimer = null, searchSel = -1, searchHits = [];
  function wireSearch() {
    const q = $("#q");
    q.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q.value.trim()), 350); };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); searchSel = Math.min(searchHits.length - 1, searchSel + 1); paintResults(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); searchSel = Math.max(0, searchSel - 1); paintResults(); }
      else if (e.key === "Escape") hideResults();
    };
    $("#search").onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); if (searchHits.length) pickResult(searchHits[Math.max(0, searchSel)]); else runSearch(q.value.trim(), true); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#search") && !e.target.closest("#search-results")) hideResults(); if (!e.target.closest("#alt")) $("#levels").hidden = true; });
  }
  async function runSearch(text, go = false) {
    if (text.length < 2) { hideResults(); return; }
    try {
      const [geo, res] = await Promise.all([WX.api(`${API}/geo?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ hits: [] })), WX.api(`${API}/resorts?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ resorts: [] }))]);
      searchHits = [...res.resorts.map((r) => ({ kind: "resort", name: r.name, sub: `${r.region || ""} ${r.country || ""}`.trim(), lat: r.lat, lon: r.lon, id: r.id })),
                    ...geo.hits.map((h) => ({ kind: "place", name: h.name, sub: h.display.split(",").slice(1, 3).join(",").trim(), lat: h.lat, lon: h.lon }))];
      searchSel = searchHits.length ? 0 : -1;
      if (go && searchHits.length) { pickResult(searchHits[0]); return; }
      paintResults();
    } catch (e) { toast("Search unavailable"); }
  }
  function paintResults() {
    const box = $("#search-results");
    if (!searchHits.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = searchHits.map((h, i) => `<button class="${i === searchSel ? "sel" : ""}" data-i="${i}"><span class="kind ${h.kind}">${h.kind}</span><span>${h.name}</span><span class="sub">${h.sub}</span></button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => pickResult(searchHits[Number(b.dataset.i)]));
  }
  function hideResults() { $("#search-results").hidden = true; }
  function pickResult(h) {
    hideResults(); $("#q").blur();
    if (h.kind === "resort") { selectResort(h.id); return; }
    map.flyTo({ center: [h.lon, h.lat], zoom: Math.max(map.getZoom(), 7), duration: 900 });
    openPoint(h.lat, h.lon, h.name);
  }

  // ── point card ────────────────────────────────────────────────────────
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    state.point = { lat, lon, data: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    $("#point-title").textContent = `${name ? name + " · " : ""}${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${modelEntry().short}`;
    $("#point-local").textContent = "";
    $("#point-now").textContent = "…";
    $$(".point-tabs button[data-tab=resort]").forEach((b) => b.hidden = !state.resort);
    placeMarker(lat, lon);
    pushHash();
    try {
      const d = await WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&model=${state.model}&run=${state.run}`);
      if (my !== pointReq) return;
      state.point.data = d;
      renderPoint(); renderTape();
      $("#point-foot").textContent = `${modelEntry().attribution} · run ${d.run}Z · nearest 0.25° gridpoint`;
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.local = r; if (!state.point.name && r.place && r.place.name) { state.point.name = r.place.name; $("#point-title").textContent = `${r.place.name} · ${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${modelEntry().short}`; renderTape(); } renderPoint(); } }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.obs = r; renderPoint(); } }).catch(() => {});
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { state.point = null; state.resort = null; $("#point").hidden = true; if (marker) { marker.remove(); marker = null; } renderTape(); refreshTapePoint(); }
  function placeMarker(lat, lon) {
    if (!marker) { const el = document.createElement("div"); el.className = "wx-marker"; marker = new maplibregl.Marker({ element: el, anchor: "center" }); }
    marker.setLngLat([lon, lat]).addTo(map);
  }
  function renderPoint() {
    const d = state.point && state.point.data; if (!d || !window.WXPanes) return;
    $$(".point-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$("#point-body section").forEach((s) => s.hidden = s.dataset.pane !== state.tab);
    window.WXPanes.render(state.tab, state.point, Math.min(state.stepIdx, d.steps.length - 1));
  }
  WX.renderPoint = renderPoint;
  WX.setStep = setStep;

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  window.addEventListener("unhandledrejection", (e) => { if (e.reason && e.reason.name === "AbortError") e.preventDefault(); });
  boot().catch((e) => { console.error(e); toast("wxgrid failed to start: " + e.message, 10000); });
})();
