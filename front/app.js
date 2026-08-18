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
  // Every raster layer the API can draw. The rail shows FAMILIES; a family
  // with variants (rain 6h/24h/72h …) gets a variant picker in the time bar.
  const LAYERS = ["wind", "temp", "gust", "tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "tcc", "msl", "d2m", "rh", "frz", "cape", "waves", "wperiod"];
  const FAMILIES = [
    { key: "wind", label: "Wind", layers: ["wind"] },
    { key: "gust", label: "Gusts", layers: ["gust"] },
    { key: "temp", label: "Temp", layers: ["temp"] },
    { key: "rain", label: "Rain", layers: ["tp6", "tp24", "tp72"], variants: { tp6: "6 h", tp24: "24 h", tp72: "72 h" }, section: "Precipitation" },
    { key: "snow", label: "New snow", layers: ["sf6", "sf24", "sf72"], variants: { sf6: "6 h", sf24: "24 h", sf72: "72 h" } },
    { key: "sd", label: "Snow depth", layers: ["sd_cm"] },
    { key: "frz", label: "Freezing lvl", layers: ["frz"] },
    { key: "tcc", label: "Clouds", layers: ["tcc"], section: "Air" },
    { key: "msl", label: "Pressure", layers: ["msl"] },
    { key: "hum", label: "Humidity", layers: ["rh", "d2m"], variants: { rh: "RH %", d2m: "Dew pt" } },
    { key: "cape", label: "CAPE", layers: ["cape"] },
    { key: "uvi", label: "UV index", layers: ["uvi"] },
    { key: "waves", label: "Waves", layers: ["waves", "wperiod"], variants: { waves: "Height", wperiod: "Period" }, section: "Sea" },
  ];
  const familyOf = (layer) => FAMILIES.find((f) => f.layers.includes(layer)) || FAMILIES[0];
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", msl: "Pressure", tp6: "Rain 6 h", tp24: "Rain 24 h", tp72: "Rain 72 h", sf6: "New snow 6 h", sf24: "New snow 24 h", sf72: "New snow 72 h", sd_cm: "Snow depth", tcc: "Clouds", cape: "CAPE", d2m: "Dew point", rh: "Humidity", frz: "Freezing lvl", waves: "Waves", wperiod: "Wave period", uvi: "UV index" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, tp24: 0.9, tp72: 0.9, sf6: 0.9, sf24: 0.9, sf72: 0.9, sd_cm: 0.85, tcc: 0.9, cape: 0.85, d2m: 0.75, rh: 0.75, frz: 0.7, waves: 0.8, wperiod: 0.8, uvi: 0.8 };
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
    rh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/></svg>',
    uvi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    waves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>',
  };
  const FAMILY_ICON = { wind: "wind", gust: "gust", temp: "temp", rain: "tp6", snow: "sf6", sd: "sd_cm", frz: "frz", tcc: "tcc", msl: "msl", hum: "rh", cape: "cape", waves: "waves", uvi: "uvi" };
  const LEVEL_FT = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "FL180", 400: "FL240", 300: "FL300", 250: "FL340", 200: "FL390" };
  const LEVEL_M = { 1000: "≈100 m", 925: "≈750 m", 850: "≈1.5 km", 700: "≈3 km", 600: "≈4.2 km", 500: "≈5.5 km", 400: "≈7.2 km", 300: "≈9 km", 250: "≈10.5 km", 200: "≈12 km" };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
    alerts: false, storms: false, sat: false, barbs: false, smoke: false, fires: false, quakes: false, aod: false, thunder: false,
    opacity: Number(localStorage.getItem("wxgrid.opacity") || 100),
  };
  let map, wind, catalog, playTimer = null, marker = null;

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : state.units === "mph" ? ms * 2.236936 : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s", mph: "mph" }[state.units]);
  const arrowRot = (deg) => `transform: rotate(${(deg + 180 + 45) % 360}deg)`;   // chevron points TO where wind goes
  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];
  // Static (GitHub Pages) builds load static-api.js first; it rewrites URLs
  // and answers the JSON endpoints from files. Live builds pass straight through.
  const U = (u) => (window.WXStatic ? window.WXStatic.url(u) : u);
  const apiJson = (u) => window.WXStatic ? window.WXStatic.api(u) : fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  window.WX = { state, speed, speedUnit, arrowRot, f, arrow, LEVEL_FT, LEVEL_M, AVY_COLORS, API, LAYER_ALPHA, $, $$,
                get map() { return map; }, get catalog() { return catalog; }, toast, modelEntry: () => modelEntry(), openPoint, closePoint,
                get validDate() { return validDate(); }, get stepHours() { return stepHours(); }, api: apiJson, url: U };
  // Functions the split-out modules (overlays.js, tape.js, search.js) call back into.
  window.WX.fn = { applyStep: (...a) => applyStep(...a), openPoint: (...a) => openPoint(...a), setStep: (...a) => setStep(...a), toast, firstSymbolId: () => firstSymbolId(),
                   renderPoint: () => renderPoint(), refreshPoint: () => refreshPoint(), closePoint: () => closePoint(), placeMarker: (...a) => placeMarker(...a),
                   stepHours: () => stepHours(), steps: () => steps(), layerUrl: () => layerUrl(), runEntry: () => runEntry(), modelEntry: () => modelEntry(), validDate: () => validDate(), pushHash: () => pushHash(), nudge: (d) => nudge(d) };

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
      if (!state.point) WX.tape.refreshTapePoint();
      pushHash();
    });
    wind = new WindLayer(map, $("#particles"));
    WX.windLayer = wind;
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
        if (state.measure) { WX.ov.measureClick(e.lngLat); return; }
        const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-pts", "avy-fill"].filter((l) => map.getLayer(l)) });
        const resort = feats.find((x) => x.layer.id === "resort-pts");
        if (resort) { WX.ov.selectResort(resort.properties.id); return; }
        openPoint(e.lngLat.lat, e.lngLat.lng);
        const avy = feats.find((x) => x.layer.id === "avy-fill");
        if (avy) { state.tab = "winter"; }
      });
      map.on("mousemove", (e) => { if (WX.provider) WX.provider.hover(e.lngLat); if (WX.probe) WX.probe.hover(e.lngLat); });
      map.on("mouseout", () => { if (WX.provider) WX.provider.hover(null); if (WX.probe) WX.probe.hover(null); });
      map.on("moveend", () => { if (!matchMedia("(hover: hover)").matches && WX.provider) WX.provider.hover(map.getCenter()); });
      map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
      map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");
      renderControls();
      applyStep();
      loadWind();
      WX.tape.refreshTapePoint();
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
    if (state.radar && state.radarFrames.length) WX.ov.applyRadarFrame();
    if (state.iso) WX.ov.loadIso();
    if (state.avy) WX.ov.loadAvy();
    if (state.resorts) WX.ov.loadResorts();
    if (state.resort) WX.ov.selectResort(state.resort.resort.id);
    if (state.alerts) WX.ov.loadAlerts();
    if (state.storms) WX.ov.loadStorms();
    if (state.sat) WX.ov.loadSat();
    if (state.smoke) WX.ov.loadSmoke();
    if (state.fires) WX.fires.load();
    if (state.quakes) WX.ov.loadQuakes();
    if (state.aod) WX.ov.loadAod();
    if (state.thunder) WX.ov.loadThunder();
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

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + stepHours() * 3600e3);
  const hasLevel = () => ["wind", "temp"].includes(state.layer);
  const isWaves = () => ["waves", "wperiod"].includes(state.layer);
  const levelQ = () => (state.level && hasLevel()) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => U(`${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  const windUrl = (h = stepHours()) => U(`${API}/wind/${state.model}/${state.run}/${h}.json${isWaves() ? "?field=waves" : state.level ? `?level=${state.level}` : ""}`);

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
    const avail = runEntry().layers;
    const fam = familyOf(state.layer);
    rail.innerHTML = FAMILIES.map((f) => {
      const ok = f.layers.some((l) => avail.includes(l));
      const on = f.key === fam.key;
      return `${f.section ? `<div class="rail-sec">${f.section}</div>` : ""}<button class="${on ? "on" : ""}" data-family="${f.key}" ${ok ? "" : "disabled"} title="${f.label}${ok ? "" : " (not in this model)"}">${LAYER_ICON[FAMILY_ICON[f.key]]}<span>${f.label}</span>${f.variants ? `<i class="var">${f.variants[on ? state.layer : f.layers.find((l) => avail.includes(l)) || f.layers[0]] || ""}</i>` : ""}</button>`;
    }).join("");
    rail.querySelectorAll("button").forEach((b) => b.onclick = () => {
      const f = FAMILIES.find((x) => x.key === b.dataset.family);
      // remember the last variant used per family
      const pref = localStorage.getItem("wxgrid.variant." + f.key);
      state.layer = (pref && f.layers.includes(pref) && avail.includes(pref)) ? pref : f.layers.find((l) => avail.includes(l)) || f.layers[0];
      localStorage.setItem("wxgrid.layer", state.layer);
      if (!hasLevel()) state.level = 0;
      renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    // variant picker (rain 6h/24h/72h …) sits in the time bar next to the legend
    const vp = $("#variant");
    if (fam.variants) {
      vp.hidden = false;
      vp.innerHTML = fam.layers.map((l) => `<button data-layer="${l}" class="${l === state.layer ? "on" : ""}" ${avail.includes(l) ? "" : "disabled"}>${fam.variants[l]}</button>`).join("");
      vp.querySelectorAll("button").forEach((b) => b.onclick = () => { state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer); localStorage.setItem("wxgrid.variant." + fam.key, state.layer); renderControls(); applyStep(); loadWind(); });
    } else { vp.hidden = true; vp.innerHTML = ""; }

    const lv = $("#levels");
    const levels = runEntry().levels || [];
    const showLevels = hasLevel() && levels.length;
    lv.hidden = !showLevels;
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      // Native title tooltips: hover a level for a beat and the metres/FL show.
      lv.innerHTML = opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" title="${l ? `${l} hPa · ${LEVEL_M[l]} · ${LEVEL_FT[l]}` : "surface · 10 m wind · 2 m temperature"}">${l ? l : "sfc"}</button>`).join("");
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => { state.level = Number(b.dataset.level); renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    slider.value = String(state.stepIdx);
    slider.oninput = () => { state.stepIdx = Number(slider.value); applyStep(false); };
    slider.onchange = () => { applyStep(true); loadWind(); };

    renderLegend();
    $("#play").onclick = togglePlay;
    $("#particles-toggle").onclick = () => { state.particles = !state.particles; $("#particles-toggle").classList.toggle("on", state.particles); if (state.particles) { state.barbs = false; $("#barbs-toggle").classList.remove("on"); wind.setMode("particles"); } wind.setEnabled(state.particles || state.barbs); };
    $("#barbs-toggle").onclick = () => { state.barbs = !state.barbs; $("#barbs-toggle").classList.toggle("on", state.barbs); if (state.barbs) { state.particles = false; $("#particles-toggle").classList.remove("on"); wind.setEnabled(true); wind.setMode("barbs"); } else { wind.setMode("particles"); wind.setEnabled(state.particles); } };
    $("#units-toggle").querySelector(".val").textContent = speedUnit();
    $("#units-toggle").onclick = () => {
      state.units = { kmh: "kt", kt: "ms", ms: "mph", mph: "kmh" }[state.units];
      localStorage.setItem("wxgrid.units", state.units);
      $("#units-toggle").querySelector(".val").textContent = speedUnit();
      renderLegend(); renderPoint(); WX.tape.renderTape();
    };
    const op = $("#opacity"); op.value = String(state.opacity);
    op.oninput = () => { state.opacity = Number(op.value); localStorage.setItem("wxgrid.opacity", op.value); applyStep(false); };
    op.onclick = (e) => e.stopPropagation();
    buildStrip();
    $("#fires-toggle").onclick = () => { state.fires = !state.fires; $("#fires-toggle").classList.toggle("on", state.fires); if (state.fires) WX.fires.load(); else WX.fires.clear(); };
    $("#share-btn").onclick = async () => { pushHash(); await new Promise((r) => setTimeout(r, 300)); try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch (e) { toast(location.href, 6000); } };
    $("#keys-btn").onclick = () => toast("← → step · space play · / search · esc close · L layers", 6000);
    $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    $("#radar-toggle").onclick = () => WX.ov.toggleRadar();
    $("#alerts-toggle").onclick = () => { state.alerts = !state.alerts; $("#alerts-toggle").classList.toggle("on", state.alerts); if (state.alerts) WX.ov.loadAlerts(); else WX.ov.clearAlerts(); };
    $("#storms-toggle").onclick = () => { state.storms = !state.storms; $("#storms-toggle").classList.toggle("on", state.storms); if (state.storms) WX.ov.loadStorms(); else WX.ov.clearStorms(); };
    $("#sat-toggle").onclick = () => { state.sat = !state.sat; $("#sat-toggle").classList.toggle("on", state.sat); if (state.sat) WX.ov.loadSat(); else WX.ov.clearSat(); };
    for (const [k, load, clear] of [["smoke", "loadSmoke", "clearSmoke"], ["quakes", "loadQuakes", "clearQuakes"], ["aod", "loadAod", "clearAod"], ["thunder", "loadThunder", "clearThunder"]]) {
      $(`#${k}-toggle`).onclick = () => { state[k] = !state[k]; $(`#${k}-toggle`).classList.toggle("on", state[k]); if (state[k]) WX.ov[load](); else WX.ov[clear](); };
    }
    $("#theme-toggle").onclick = () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme; };
    $("#measure-toggle").onclick = () => { state.measure = !state.measure; $("#measure-toggle").classList.toggle("on", state.measure); $("#measure-toggle").querySelector(".val").textContent = state.measure ? "on" : "off"; if (!state.measure) WX.ov.clearMeasure(); else toast("Measure: tap two points"); };
    $("#iso-toggle").onclick = () => { state.iso = !state.iso; $("#iso-toggle").classList.toggle("on", state.iso); if (state.iso) WX.ov.loadIso(); else WX.ov.clearIso(); };
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts(); };
    $("#locate").onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(
      (p) => { map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 7) }); openPoint(p.coords.latitude, p.coords.longitude); },
      () => toast("Location unavailable", 4000, "error"));
    $("#point-close").onclick = closePoint;
    $("#point-fav").onclick = () => { if (!state.point) return; const on = WX.search.toggleFav(state.point.lat, state.point.lon, state.point.name); $("#point-fav").textContent = on ? "★" : "☆"; $("#point-fav").classList.toggle("on", on); toast(on ? "Saved. Focus the search box to see your places." : "Removed", 2500); };
    WX.search.wireSearch();
    $$(".menu .menu-btn").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const m = b.parentElement; const open = m.classList.contains("open"); $$(".menu.open").forEach((x) => x.classList.remove("open")); if (!open) m.classList.add("open"); });
    // menu buttons show a tick when any of their toggles is on
    new MutationObserver(() => $$(".menu").forEach((m) => m.querySelector(".menu-btn").classList.toggle("has-on", !!m.querySelector(".menu-pop .chip.on:not(#particles-toggle):not(#barbs-toggle)")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $$(".menu.open").forEach((x) => x.classList.remove("open")); });
    $$(".point-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderPoint(); });
    document.addEventListener("keydown", (e) => {
      if (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "Escape") { closePoint(); WX.search.hideResults(); $$(".menu.open").forEach((x) => x.classList.remove("open")); }
      else if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
      else if (e.key === "l" || e.key === "L") { $("#overlays-menu").classList.toggle("open"); }
    });
  }

  // Desktop tool strip: icon proxies for the toggles that live in the topbar
  // menus. Clicking proxies the real button; the observer below mirrors state.
  const STRIP = [
    ["radar", "Radar"], ["sat", "Satellite"], ["aod", "Aerosol"], ["iso", "Isolines"], null,
    ["alerts", "Alerts", "warn"], ["storms", "Storms", "warn"], ["thunder", "Thunder", "warn"], ["fires", "Fires", "warn"], ["smoke", "Smoke"], ["quakes", "Quakes"], null,
    ["avy", "Avalanche"], ["resorts", "Ski resorts"], null,
    ["particles", "Particles"], ["barbs", "Barbs"], ["measure", "Measure"],
  ];
  function buildStrip() {
    const st = $("#tstrip"); if (!st) return;
    st.innerHTML = STRIP.map((it) => {
      if (!it) return '<div class="sep"></div>';
      const [k, tip, cls] = it; const src = $(`#${k}-toggle`); if (!src) return "";
      const svg = src.querySelector("svg") ? src.querySelector("svg").outerHTML : "";
      return `<button data-for="${k}-toggle" data-tip="${tip}" class="${cls || ""}${src.classList.contains("on") ? " on" : ""}" aria-label="${tip}">${svg}</button>`;
    }).join("");
    st.querySelectorAll("button").forEach((b) => b.onclick = () => $("#" + b.dataset.for).click());
    new MutationObserver(() => st.querySelectorAll("button").forEach((b) => b.classList.toggle("on", $("#" + b.dataset.for).classList.contains("on")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
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
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; WX.ov.applyRadarFrame(); return; }
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso();
  }
  function setStep(i) { state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); }

  function applyStep(prefetch = true) {
    pushHash();
    const src = map.getSource("wx");
    if (src) { try { src.updateImage({ url: layerUrl(), coordinates: WORLD }); } catch (e) { /* superseded */ } }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", ((state.radar || state.sat) ? Math.min(0.45, LAYER_ALPHA[state.layer]) : LAYER_ALPHA[state.layer]) * state.opacity / 100);
    if (state.thunder && WX.ov) WX.ov.loadThunder();
    if (WX.probe) WX.probe.refresh();
    const v = validDate();
    $("#valid-local").textContent = v.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    $("#lead").textContent = `+${stepHours()}h`;
    if (prefetch) { const img = new Image(); img.src = layerUrl(steps()[(state.stepIdx + 1) % steps().length]); if (state.resorts && WX.ov) WX.ov.loadResorts(); }
    WX.tape.renderTapeSelection();
    if (state.point) renderPoint();
  }

  let windReq = 0;
  async function loadWind() {
    if (!runEntry().layers.includes(isWaves() ? "waves" : "wind")) { wind.setField(null); return; }
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

  // ── point card ────────────────────────────────────────────────────────
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    state.point = { lat, lon, data: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    $("#point-title").textContent = name || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    $("#point-local").textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${modelEntry().short}`;
    $("#point-now").textContent = "…";
    $$(".point-tabs button[data-tab=resort]").forEach((b) => b.hidden = !state.resort);
    { const on = WX.search.isFav(lat, lon); $("#point-fav").textContent = on ? "★" : "☆"; $("#point-fav").classList.toggle("on", on); }
    placeMarker(lat, lon);
    pushHash();
    try {
      const d = await WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&model=${state.model}&run=${state.run}`);
      if (my !== pointReq) return;
      state.point.data = d;
      renderPoint(); WX.tape.renderTape();
      const rd = new Date(d.run + ":00Z");
      $("#point-foot").textContent = `${modelEntry().short} run ${rd.toLocaleString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} ${String(rd.getUTCHours()).padStart(2, "0")}Z · 0.25° gridpoint · ${modelEntry().attribution.replace("ECMWF open data", "ECMWF").replace(" (AIFS)", "").replace("NOAA NCEP GFS via NOMADS", "NOAA")}`;
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.local = r; if (!state.point.name && r.place && r.place.name) { state.point.name = r.place.name; $("#point-title").textContent = r.place.name; WX.tape.renderTape(); } renderPoint(); } }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.obs = r; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/alerts/point?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.alerts = r.alerts || []; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/air?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.air = r; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/tides?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.tides = r; renderPoint(); } }).catch(() => { if (my === pointReq) state.point.tides = false; });
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { state.point = null; state.resort = null; $("#point").hidden = true; if (marker) { marker.remove(); marker = null; } WX.tape.renderTape(); WX.tape.refreshTapePoint(); }
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
  function toast(msg, ms = 3000, kind = "") {
    const t = $("#toast"); t.textContent = msg; t.hidden = false; t.className = kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  // Boot failure: a proper panel, not a toast. Says what is wrong in words
  // and offers a retry; the raw error stays available underneath.
  function fatal(err) {
    const msg = String(err && err.message || err);
    const offline = /Load failed|Failed to fetch|NetworkError|network/i.test(msg);
    const why = offline ? "The wxgrid server did not answer. It may be restarting, or this device is off the network it lives on."
      : /^(5\d\d)$/.test(msg) ? "The server answered with an error while loading the model catalog." : "Something broke while starting.";
    let box = $("#fatal");
    if (!box) { box = document.createElement("div"); box.id = "fatal"; document.body.appendChild(box); }
    box.innerHTML = `<div class="fatal-card" role="alert"><div class="fatal-head"><span class="fatal-dot"></span><b>wxgrid can't start</b></div><p>${why}</p><div class="fatal-actions"><button id="fatal-retry" class="chip">Try again</button><span class="dim mono">${msg.replace(/[<>&]/g, "")}</span></div></div>`;
    $("#fatal-retry").onclick = () => location.reload();
  }

  window.addEventListener("unhandledrejection", (e) => { if (e.reason && e.reason.name === "AbortError") e.preventDefault(); });
  boot().catch((e) => { console.error(e); fatal(e); });
})();
