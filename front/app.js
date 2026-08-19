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
    iso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c3-4 6-4 9 0s6 4 9 0"/><path d="M3 9c3-4 6-4 9 0s6 4 9 0"/></svg>',
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
  const levelBadge = (level) => (LEVEL_FT[level] || "").startsWith("FL") ? LEVEL_FT[level] : (LEVEL_M[level] || "").replace(/^≈/, "");
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
    alerts: false, storms: false, sat: false, barbs: false, smoke: false, fires: false, quakes: false, aod: false, thunder: false,
    sigmet: false, aurora: false, lightning: false, aq: false, route: false, aqVar: localStorage.getItem("wxgrid.aqVar") || "pm2_5",
    opacity: Number(localStorage.getItem("wxgrid.opacity") || 100), xsection: false,
    playMs: Number(localStorage.getItem("wxgrid.playMs") || 900),
  };
  let map, wind, catalog, playTimer = null, marker = null;
  let restorePointPanelSize = () => {};
  let restoreSheetHeight = () => {};
  let setTapeState = () => {};
  let tapeState = "full";

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : state.units === "mph" ? ms * 2.236936 : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s", mph: "mph" }[state.units]);
  const arrowRot = (deg) => `transform: rotate(${(deg + 180 + 45) % 360}deg)`;   // chevron points TO where wind goes
  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];
  // The map renders world copies, so a click east of the antimeridian gives
  // lng 200 or -200. The marker keeps the raw value (it belongs in the copy
  // the user clicked); every API call gets the wrapped one, since the store
  // is one world wide.
  const wlon = (x) => ((x + 180) % 360 + 360) % 360 - 180;
  const hasNonLatinScript = (s) => /[\u0370-\u052f\u0590-\u08ff\u0900-\u1cff\u2c00-\ud7ff\uf900-\ufaff]/u.test(s || "");
  // The map's ramps come from the server (`/api/models` → layers[].stops). Any
  // chip that colours a value uses THIS, so a colour means the same thing in
  // the tape, the card and the map instead of three private gradients.
  function rampColor(layer, v, alpha) {
    const lg = catalog && catalog.layers && catalog.layers.find((l) => l.layer === layer);
    if (!lg || v == null) return "transparent";
    const st = lg.stops;
    let a = st[0], b = st[st.length - 1];
    for (let k = 0; k < st.length - 1; k++) if (v >= st[k].v && v <= st[k + 1].v) { a = st[k]; b = st[k + 1]; break; }
    if (v <= st[0].v) { a = b = st[0]; } else if (v >= st[st.length - 1].v) { a = b = st[st.length - 1]; }
    const q = b.v === a.v ? 0 : Math.max(0, Math.min(1, (v - a.v) / (b.v - a.v)));
    const c = a.rgb.map((x, i) => Math.round(x + (b.rgb[i] - x) * q));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha == null ? 1 : alpha})`;
  }
  // Static (GitHub Pages) builds load static-api.js first; it rewrites URLs
  // and answers the JSON endpoints from files. Live builds pass straight through.
  const U = (u) => (window.WXStatic ? window.WXStatic.url(u) : u);
  const apiJson = (u) => window.WXStatic ? window.WXStatic.api(u) : fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  window.WX = { state, speed, speedUnit, arrowRot, f, arrow, wlon, rampColor, LEVEL_FT, LEVEL_M, AVY_COLORS, API, LAYER_ALPHA, $, $$,
                get map() { return map; }, get catalog() { return catalog; }, toast, modelEntry: () => modelEntry(), openPoint, closePoint,
                get validDate() { return validDate(); }, get stepHours() { return stepHours(); }, api: apiJson, url: U };
  // Functions the split-out modules (overlays.js, tape.js, search.js) call back into.
  window.WX.fn = { applyStep: (...a) => applyStep(...a), openPoint: (...a) => openPoint(...a), setStep: (...a) => setStep(...a), toast, firstSymbolId: () => firstSymbolId(),
                   renderPoint: () => renderPoint(), refreshPoint: () => refreshPoint(), closePoint: () => closePoint(), placeMarker: (...a) => placeMarker(...a),
                   stepHours: () => stepHours(), steps: () => steps(), layerUrl: () => layerUrl(),
                   applyTheme: (t) => applyTheme(t), setMotion: (m) => setMotion(m), restartPlay: () => restartPlay(), fitStrip: () => fitStrip(), runEntry: () => runEntry(), modelEntry: () => modelEntry(), validDate: () => validDate(), pushHash: () => pushHash(), nudge: (d) => nudge(d), clearOtherCover: (k) => clearOtherCover(k),
                   jumpModelTime: (key, iso) => switchModel(key, new Date(iso).getTime()) };

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const saved = JSON.parse(localStorage.getItem("wxgrid.view") || "null");
    const currentMapScale = localStorage.getItem("wxgrid.mapScaleVersion") === "4";
    if (!currentMapScale) localStorage.setItem("wxgrid.mapScaleVersion", "4");
    // Opening on a hemisphere shows weather nobody asked about. A first view is
    // regional: close enough that the coastline under the field is a place.
    const defaultZoom = innerWidth > 820 ? 5 : 4;
    applyTheme(localStorage.getItem("wxgrid.theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"), false);
    const hash = readHash();
    map = new maplibregl.Map({
      container: "map", style: mapStyle(),
      center: hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], zoom: hash ? hash.zoom : saved && currentMapScale ? saved.zoom : defaultZoom,
      // Past z11 the field is one world-sized image being stretched, and what
      // you actually want is the ground: streets, lifts, runs. So the map keeps
      // zooming to where the basemap still has detail, and the field steps back.
      minZoom: 1.2, maxZoom: 15, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // Subscribe before the catalog request. A cached style can emit
    // `style.load` while /api/models is still in flight.
    const styleReady = new Promise((resolve) => {
      map.once("style.load", resolve);
      if (map.isStyleLoaded()) resolve();
    });
    map.on("moveend", () => {
      localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      if (!state.point) WX.tape.refreshTapePoint();
      if (WX.provider) WX.provider.refresh();
      if (state.radar && WX.ov.refreshRadarSource) WX.ov.refreshRadarSource();
      pushHash();
    });
    wind = new WindLayer(map, $("#particles"));
    WX.windLayer = wind;
    // A taller tape leaves less room for a hand-sized card, so re-clamp it —
    // but never mid-drag, where it would fight the pointer.
    new ResizeObserver(() => { document.documentElement.style.setProperty("--tb-h", $("#timebar").offsetHeight + "px");
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      if (!document.body.classList.contains("resizing-tape")) restorePointPanelSize(); }).observe($("#timebar"));
    new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $("#topbar").offsetHeight + "px")).observe($("#topbar"));
    wirePanelResizers();

    catalog = await WX.api(`${API}/models?ts=${Date.now()}`);
    if (catalog.static) toast(`Static demo, run ${catalog.static.built}Z. ${catalog.static.note}.`, 9000);
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs yet. Ingest is still running.", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];

    if (hash) { if (hash.model && catalog.models.some((m) => m.key === hash.model && m.runs.length)) state.model = hash.model; if (hash.layer && LAYERS.includes(hash.layer)) state.layer = hash.layer; state.level = hash.level || 0; state.run = modelEntry().runs[0].run; if (hash.step != null) state.stepIdx = Math.min(hash.step, steps().length - 1); }
    // The controls and forecast table only need the local catalog. Painting
    // them behind MapLibre's `load` event made a cold start wait for the
    // remote basemap's tiles, glyphs and sprites before showing local data.
    renderControls();
    if (WX.mapmenu) WX.mapmenu.wire();
    applyStep(false);
    const tapeReady = hash && hash.pt ? Promise.resolve() : WX.tape.refreshTapePoint();
    if (hash && hash.pt) openPoint(hash.pt[0], hash.pt[1]);
    const windReady = loadWind(false);
    const initialDataReady = Promise.allSettled([windReady, tapeReady]);
    WX.initialDataReady = initialDataReady;
    initialDataReady.then(() => document.dispatchEvent(new Event("wx-initial-data")));
    if (WX.tour) setTimeout(() => WX.tour.start(), 1200);

    map.on("click", (e) => {
      // isStyleLoaded() is about TILES, not the style: it goes false whenever a
      // source is streaming, which at street zoom is most of the time. Guarding
      // on it swallowed clicks — resort pins stopped opening. Ask instead
      // whether the layer we are about to query exists.
      const has = (l) => { try { return !!map.getLayer(l); } catch (_) { return false; } };
      if (state.measure) { WX.ov.measureClick(e.lngLat); return; }
      if (state.xsection) { WX.xs.click(e.lngLat); return; }
      if (state.route && WX.route && !WX.route.active) { WX.route.addPoint(e.lngLat); return; }
      // Something on the map that has its own popup owns the click. Without
      // this a fire report opened underneath a location card nobody asked for.
      const owned = ["fire-inc", "fire-perim-fill", "sigmet-fill", "quakes", "storm-pts"].filter(has);
      if (owned.length && map.queryRenderedFeatures(e.point, { layers: owned }).length) return;
      const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-pts", "avy-fill"].filter(has) });
      const resort = feats.find((x) => x.layer.id === "resort-pts");
      if (resort) { WX.ov.selectResort(resort.properties.id); return; }
      openPoint(e.lngLat.lat, e.lngLat.lng);
      const avy = feats.find((x) => x.layer.id === "avy-fill");
      if (avy) { state.tab = "winter"; }
    });
    map.on("mousemove", (e) => { if (WX.probe) WX.probe.hover(e.lngLat); });
    map.on("mouseout", () => { if (WX.probe) WX.probe.hover(null); });
    map.on("moveend", () => { if (WX.provider) WX.provider.refresh(); });
    map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");

    const loadInitialWeather = () => {
      // Add the selected image as soon as the style exists; `load` waits for
      // the basemap's initial tiles as well. Do not immediately update the
      // source to the same URL or prefetch the next 1 MB frame alongside it.
      const prefetchNext = (e) => {
        if (e.sourceId !== "wx" || !e.isSourceLoaded) return;
        map.off("sourcedata", prefetchNext);
        // The next frame is useful, but only after the current image, wind
        // field and tape have finished. It must not compete with first paint.
        initialDataReady.then(() => {
          const img = new Image();
          img.src = layerUrl(steps()[(state.stepIdx + 1) % steps().length]);
        });
      };
      map.on("sourcedata", prefetchNext);
      ensureWxLayer();
    };
    styleReady.then(loadInitialWeather).catch(() => ensureWxLayer());
  }
  // How solid the weather field is. Past z9 it steps back: at street zoom the
  // field is one world-sized image being stretched, and the ground underneath
  // it — streets, lifts, runs — is what you zoomed in for.
  function rasterOpacity() {
    const a = ((state.radar || state.sat) ? Math.min(0.45, LAYER_ALPHA[state.layer]) : LAYER_ALPHA[state.layer]) * state.opacity / 100;
    return ["interpolate", ["linear"], ["zoom"], 9, a, 13, Math.max(0.1, a * 0.22)];
  }
  const firstSymbolId = () => { const l = map.getStyle().layers.find((x) => x.type === "symbol"); return l ? l.id : undefined; };
  const mapStyle = () => document.documentElement.dataset.theme === "light" ? "https://tiles.openfreemap.org/styles/positron" : "https://tiles.openfreemap.org/styles/dark";
  function ensureWxLayer() {
    if (map.getSource("wx")) return;
    map.addSource("wx", { type: "image", url: layerUrl(), coordinates: WORLD });
    map.addLayer({ id: "wx", type: "raster", source: "wx", paint: { "raster-opacity": rasterOpacity(), "raster-fade-duration": 0, "raster-resampling": "linear" } }, firstSymbolId());
    ensureCoastLayer();
  }
  // A weather field painted over the whole world hides the one thing you need
  // to read it: where the land stops. The basemap's own coastline is under the
  // field, so trace it again on top — thin, low contrast, wider as you zoom in.
  function ensureCoastLayer() {
    if (!map.getSource("openmaptiles") || map.getLayer("wx-coast")) return;
    const light = document.documentElement.dataset.theme === "light";
    map.addLayer({
      id: "wx-coast", type: "line", source: "openmaptiles", "source-layer": "water",
      paint: {
        "line-color": light ? "rgba(22,32,48,.62)" : "rgba(226,238,255,.66)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 4, 0.9, 7, 1.3, 11, 2],
        "line-blur": 0.3,
      },
    }, firstSymbolId());
  }
  // After a basemap swap every custom source is gone; put back whatever was on.
  function restoreLayers() {
    ensureWxLayer(); ensureCoastLayer(); applyStep();
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
    if (state.sigmet) WX.sigmet.load();
    if (state.aurora && WX.sky) WX.sky.aurora.load(true);
    if (state.aq) WX.cams.load(state.aqVar);
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
  let hashTimer = null, ownHash = "";
  // Paste a permalink into an already-open tab and the view should move. The
  // browser treats a hash-only change as same-document, so nothing reloads —
  // we have to apply it ourselves, ignoring the hashes we write.
  function applyHash() {
    if (location.hash === ownHash) return;
    const h = readHash();
    if (!h) return;
    // A hash can change while boot is still waiting on the catalog — paste a
    // permalink into a cold tab and this ran with nothing to read. boot() reads
    // the hash itself, so there is nothing to do here until it has landed.
    if (!catalog) return;
    if (h.model && catalog.models.some((m) => m.key === h.model && m.runs.length)) { state.model = h.model; state.run = modelEntry().runs[0].run; }
    if (h.layer && LAYERS.includes(h.layer) && runEntry().layers.includes(h.layer)) state.layer = h.layer;
    state.level = h.level || 0;
    if (h.step != null) state.stepIdx = Math.min(h.step, steps().length - 1);
    map.jumpTo({ center: [h.lon, h.lat], zoom: h.zoom });
    renderControls(); applyStep(); loadWind();
    if (h.pt) openPoint(h.pt[0], h.pt[1]); else closePoint();
  }
  window.addEventListener("hashchange", applyHash);

  function pushHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      if (!map) return;
      const c = map.getCenter();
      let h = `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(2)};${state.model};${state.layer}${state.level ? "/" + state.level : ""};s${state.stepIdx}`;
      if (state.point) h += `;p${state.point.lat.toFixed(3)},${state.point.lon.toFixed(3)}`;
      ownHash = "#" + h;
      history.replaceState(null, "", ownHash);
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
  // Opacity has two entry points — the settings drawer and the rail — so it
  // gets one setter that leaves both showing the same number.
  function setOpacity(v) {
    state.opacity = v;
    localStorage.setItem("wxgrid.opacity", v);
    const drawer = $("#opacity"), rail = document.querySelector(".rail-opacity input");
    if (drawer) drawer.value = String(v);
    if (rail) { rail.value = String(v); rail.parentElement.querySelector("i").textContent = `${v}%`; }
    applyStep(false);
  }
  // The model and pressure pickers share one sliding selection plate. Keep the
  // old plate's geometry across a re-render so changing model metadata (the
  // selected grid badge) does not turn a smooth move into a flash.
  function renderSlidingSeg(el, buttons) {
    const old = el.querySelector(".seg-cursor");
    const prior = old ? old.getBoundingClientRect() : null;
    el.classList.add("sliding");
    el.innerHTML = `<i class="seg-cursor" aria-hidden="true"></i>${buttons}`;
    const cursor = el.querySelector(".seg-cursor");
    const place = () => {
      const active = el.querySelector("button.on");
      if (!active) { cursor.style.opacity = "0"; return; }
      cursor.style.opacity = "1";
      cursor.style.width = `${active.offsetWidth}px`;
      cursor.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    if (prior && prior.width) {
      const box = el.getBoundingClientRect();
      cursor.style.width = `${prior.width}px`;
      cursor.style.transform = `translateX(${prior.left - box.left + el.scrollLeft}px)`;
      cursor.getBoundingClientRect();
      cursor.classList.add("ready");
      requestAnimationFrame(place);
    } else {
      place();
      requestAnimationFrame(() => cursor.classList.add("ready"));
    }
  }
  // Overlays that paint the whole ground — radar, satellite, smoke, aerosol,
  // air quality — cannot be read two at a time; the top one just hides the one
  // under it. Turning one on turns the others off. Overlays that draw MARKS on
  // the map (fires, quakes, alerts, storms, SIGMET, aurora, lightning) stack
  // fine and are left alone.
  const GROUND_COVER = [["radar", "#radar-toggle"], ["sat", "#sat-toggle"], ["smoke", "#smoke-toggle"],
                        ["aod", "#aod-toggle"], ["aq", "#aq-toggle"]];
  function clearOtherCover(keep) {
    for (const [key, sel] of GROUND_COVER) {
      if (key === keep || !state[key]) continue;
      const btn = $(sel);
      if (btn) btn.click();                      // each toggle owns its own teardown
    }
  }

  function renderControls() {
    const ms = $("#models");
    // The selected model also says what it resolves. Only the selected one:
    // six grid figures across the top bar is noise, one is information.
    renderSlidingSeg(ms, catalog.models.map((m) => { const on = m.key === state.model;
      return `<button data-model="${m.key}" class="${on ? "on" : ""}" ${m.runs.length ? "" : "disabled"} title="${m.label}${m.grid ? ` · ${m.grid}` : ""}">${m.short}${on && m.grid ? `<i class="grid">${m.grid}</i>` : ""}</button>`; }).join(""));
    ms.querySelectorAll("button").forEach((b) => b.onclick = () => switchModel(b.dataset.model));

    const rs = $("#run");
    // On a phone the month is dead weight: two runs of the same model are hours
    // apart, never months. Dropping it buys the run picker a place on the
    // model row instead of a row of its own.
    const narrow = innerWidth <= 820;
    rs.innerHTML = modelEntry().runs.map((r) => `<option value="${r.run}">${(narrow ? r.run.slice(8) : r.run.slice(5)).replace("T", " ")}Z</option>`).join("");
    rs.value = state.run;
    rs.onchange = () => { state.run = rs.value; clampStep(); renderControls(); applyStep(); loadWind(); refreshPoint(); };

    const rail = $("#layers");
    const avail = runEntry().layers;
    const fam = familyOf(state.layer);
    rail.innerHTML = FAMILIES.map((f) => {
      const ok = f.layers.some((l) => avail.includes(l));
      const on = f.key === fam.key;
      return `${f.section ? `<div class="rail-sec">${f.section}</div>` : ""}<button class="${on ? "on" : ""}" data-family="${f.key}" ${ok ? "" : "disabled"} title="${f.label}${ok ? "" : " (not in this model)"}">${LAYER_ICON[FAMILY_ICON[f.key]]}<span>${f.label}</span>${f.variants ? `<i class="var">${f.variants[on ? state.layer : f.layers.find((l) => avail.includes(l)) || f.layers[0]] || ""}</i>` : ""}</button>`;
    }).join("") + `<div class="rail-sec">Field</div>
      <div class="rail-seg" role="group" aria-label="Wind animation">
        <span>Motion</span>
        <div class="seg small">
          <button data-motion="particles" class="${state.particles ? "on" : ""}">Streams</button>
          <button data-motion="barbs" class="${state.barbs ? "on" : ""}">Barbs</button>
          <button data-motion="off" class="${!state.particles && !state.barbs ? "on" : ""}">Off</button>
        </div>
      </div>
      <button class="rail-flat ${state.iso ? "on" : ""}" data-rail="iso">${LAYER_ICON.iso || ""}<span>Isolines</span></button>
      <label class="rail-opacity" title="Layer opacity">
        <span>Opacity</span><input type="range" min="20" max="100" step="5" value="${state.opacity}"><i>${state.opacity}%</i></label>`;
    const railOp = rail.querySelector(".rail-opacity input");
    railOp.oninput = () => { setOpacity(Number(railOp.value)); };
    // The rail proxies the buttons that already own this state, so there is
    // still one place a toggle actually lives.
    rail.querySelectorAll("[data-motion]").forEach((b) => b.onclick = () => {
      const want = b.dataset.motion;
      if (want === "particles" && !state.particles) $("#particles-toggle").click();
      else if (want === "barbs" && !state.barbs) $("#barbs-toggle").click();
      else if (want === "off") { if (state.particles) $("#particles-toggle").click(); if (state.barbs) $("#barbs-toggle").click(); }
      renderControls();
    });
    const railIso = rail.querySelector('[data-rail="iso"]');
    if (railIso) railIso.onclick = () => { $("#iso-toggle").click(); renderControls(); };
    // Only the layer buttons: the rail also holds motion, isolines and opacity,
    // and this handler used to claim their clicks as well.
    rail.querySelectorAll("button[data-family]").forEach((b) => b.onclick = () => {
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
    // Desktop keeps the row for every layer, greyed out: disappearing chrome
    // makes the bar jump and reads like a bug (Jeff 2026-08-18). A phone has
    // four rows of chrome and no room for one that cannot be pressed, so there
    // it goes away — see `body.no-levels` (Jeff 2026-08-19).
    lv.hidden = !levels.length;
    document.body.classList.toggle("no-levels", !showLevels);
    lv.classList.toggle("disabled", !showLevels);
    lv.title = showLevels ? "" : `${LAYER_LABEL[state.layer]} is a surface field`;
    if (!showLevels && levels.length) {
      renderSlidingSeg(lv, [0, ...levels].map((l) => `<button data-level="${l}" class="${l === 0 ? "on" : ""}" disabled>${l || "sfc"}</button>`).join(""));
    }
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      // Native title tooltips: hover a level for a beat and the metres/FL show.
      renderSlidingSeg(lv, opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" title="${l ? `${l} hPa · ${LEVEL_M[l]} · ${LEVEL_FT[l]}` : "surface · 10 m wind · 2 m temperature"}">${l ? `${l}${l === state.level ? `<i class="level-alt">${levelBadge(l)}</i>` : ""}` : "sfc"}</button>`).join(""));
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => { state.level = Number(b.dataset.level); renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    slider.value = String(state.stepIdx);
    slider.oninput = () => { state.stepIdx = Number(slider.value); applyStep(false); };
    slider.onchange = () => { applyStep(true); loadWind(); };

    renderLegend();
    $("#play").onclick = togglePlay;
    // Back to the present in one tap: scrubbing four days out and finding your
    // way home by dragging is the kind of thing a button fixes.
    $("#tape-now").onclick = () => { setStep(currentStepIdx()); WX.tape.renderTapeSelection(); };
    const tb = $("#timebar"), tmin = $("#tape-min");
    // Three states, because "collapsed" and "gone" are different wants: full
    // table, header only, or out of the way entirely with just its grip left.
    setTapeState = (s, persist = true) => {
      tapeState = s;
      tb.classList.toggle("mini", s === "mini");
      tb.classList.toggle("tape-away", s === "away");
      if (persist) localStorage.setItem("wxgrid.tapeState", s);
      tmin.title = s === "full" ? "Collapse the forecast table" : "Show the forecast table";
      requestAnimationFrame(() => document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px"));
    };
    const savedState = localStorage.getItem("wxgrid.tapeState")
      || (localStorage.getItem("wxgrid.tapeMini") === "1" ? "mini" : "full");
    setTapeState(["full", "mini", "away"].includes(savedState) ? savedState : "full", false);
    tmin.onclick = () => setTapeState(tapeState === "full" ? "mini" : "full");
    // the crosshair button map apps have: centre here and open the card
    const goToMe = () => {
      if (!navigator.geolocation) { toast("This browser has no location service", 4000, "error"); return; }
      $("#locate-btn").classList.add("on");
      navigator.geolocation.getCurrentPosition(
        (pos) => { $("#locate-btn").classList.remove("on"); map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 8), duration: 900 }); openPoint(pos.coords.latitude, pos.coords.longitude); },
        () => { $("#locate-btn").classList.remove("on"); toast("Location unavailable. Allow it for this site and try again.", 5000, "error"); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    };
    $("#locate-btn").onclick = goToMe;
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
    op.oninput = () => setOpacity(Number(op.value));
    op.onclick = (e) => e.stopPropagation();
    buildStrip();
    $("#aurora-toggle").onclick = () => { if (!WX.sky) return; state.aurora = !state.aurora; $("#aurora-toggle").classList.toggle("on", state.aurora); if (state.aurora) WX.sky.aurora.load(); else WX.sky.aurora.clear(); };
    $("#lightning-toggle").onclick = () => WX.sky && WX.sky.lightning.load();
    $("#sigmet-toggle").onclick = () => { if (!WX.sigmet) return; state.sigmet = !state.sigmet; $("#sigmet-toggle").classList.toggle("on", state.sigmet); if (state.sigmet) WX.sigmet.load(); else WX.sigmet.clear(); };
    $("#aq-toggle").onclick = () => { if (!WX.cams) return; state.aq = !state.aq; $("#aq-toggle").classList.toggle("on", state.aq); if (state.aq) { clearOtherCover("aq"); WX.cams.load(state.aqVar); } else WX.cams.clear(); };
    $("#fires-toggle").onclick = () => { if (!WX.fires) { toast("Fire overlay is still loading", 2500); return; } state.fires = !state.fires; $("#fires-toggle").classList.toggle("on", state.fires); if (state.fires) WX.fires.load(); else WX.fires.clear(); };
    $("#share-btn").onclick = async () => { pushHash(); await new Promise((r) => setTimeout(r, 300)); try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch (e) { toast(location.href, 6000); } };
    $("#settings-btn").onclick = () => { $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(); };
    $("#keys-btn").onclick = () => { $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(); };
    // a unit change repaints every number on screen at once
    document.addEventListener("wx-units", () => { renderLegend(); renderPoint(); WX.tape.renderTape(); if (WX.probe) WX.probe.hover(null); if (state.xsection && WX.xs) WX.xs.refresh(); $("#units-toggle").querySelector(".val").textContent = speedUnit(); });
    $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    $("#radar-toggle").onclick = () => WX.ov.toggleRadar();
    $("#alerts-toggle").onclick = () => { state.alerts = !state.alerts; $("#alerts-toggle").classList.toggle("on", state.alerts); if (state.alerts) WX.ov.loadAlerts(); else WX.ov.clearAlerts(); };
    $("#storms-toggle").onclick = () => { state.storms = !state.storms; $("#storms-toggle").classList.toggle("on", state.storms); if (state.storms) WX.ov.loadStorms(); else WX.ov.clearStorms(); };
    $("#sat-toggle").onclick = () => { state.sat = !state.sat; $("#sat-toggle").classList.toggle("on", state.sat); if (state.sat) { clearOtherCover("sat"); WX.ov.loadSat(); } else WX.ov.clearSat(); };
    for (const [k, load, clear] of [["smoke", "loadSmoke", "clearSmoke"], ["quakes", "loadQuakes", "clearQuakes"], ["aod", "loadAod", "clearAod"], ["thunder", "loadThunder", "clearThunder"]]) {
      $(`#${k}-toggle`).onclick = () => { state[k] = !state[k]; $(`#${k}-toggle`).classList.toggle("on", state[k]);
        if (state[k]) { if (k === "smoke" || k === "aod") clearOtherCover(k); WX.ov[load](); } else WX.ov[clear](); };
    }
    $("#theme-toggle").onclick = () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme; };
    $("#route-toggle").onclick = () => {
      if (!WX.route) { toast("Route forecast is not in this build.", 4000, "error"); return; }
      const on = !state.route; state.route = on; $("#route-toggle").classList.toggle("on", on);
      if (on) WX.route.start(); else WX.route.stop();
    };
    $("#xsection-toggle").onclick = () => { if (!WX.xs) { toast("Cross section is still loading", 2500); return; } const on = !state.xsection; $("#xsection-toggle").classList.toggle("on", on); if (on) WX.xs.start(); else WX.xs.stop(); };
    $("#measure-toggle").onclick = () => { state.measure = !state.measure; $("#measure-toggle").classList.toggle("on", state.measure); $("#measure-toggle").querySelector(".val").textContent = state.measure ? "on" : "off"; if (!state.measure) WX.ov.clearMeasure(); else toast("Tap two points to measure."); };
    $("#iso-toggle").onclick = () => { state.iso = !state.iso; $("#iso-toggle").classList.toggle("on", state.iso); if (state.iso) WX.ov.loadIso(); else WX.ov.clearIso(); };
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts(); };
    $("#locate").onclick = goToMe;
    $("#point-close").onclick = closePoint;
    wireSheet();
    $("#point-fav").onclick = () => { if (!state.point) return; const on = WX.search.toggleFav(state.point.lat, state.point.lon, state.point.name); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; toast(on ? "Saved. Find it in the search box." : "Removed", 2500); };
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
    ["radar", "Radar"], ["sat", "Satellite"], ["aurora", "Aurora"], ["aod", "Aerosol"], ["iso", "Isolines"], null,
    ["alerts", "Alerts", "warn"], ["storms", "Storms", "warn"], ["thunder", "Thunder", "warn"], ["sigmet", "SIGMET", "warn"], ["fires", "Fires", "warn"], ["smoke", "Smoke"], ["aq", "Air quality"], ["quakes", "Quakes"], null,
    ["avy", "Avalanche"], ["resorts", "Ski resorts"], null,
    ["particles", "Particles"], ["barbs", "Barbs"], null,
    ["xsection", "Cross section"], ["route", "Route forecast"], ["measure", "Measure"],
  ];
  function buildStrip() {
    const st = $("#tstrip"); if (!st) return;
    // renderControls runs for every model, level and layer change. The strip is
    // structural, not model data: building it again appended another flyout
    // to body and duplicated the overflow controls on every selection.
    if (st.dataset.built === "1") { fitStrip(); return; }
    document.querySelectorAll("#strip-more-pop").forEach((el) => el.remove());
    st.dataset.built = "1";
    st.innerHTML = STRIP.map((it) => {
      if (!it) return '<div class="sep"></div>';
      const [k, tip, cls] = it; const src = $(`#${k}-toggle`); if (!src) return "";
      const svg = src.querySelector("svg") ? src.querySelector("svg").outerHTML : "";
      return `<button data-for="${k}-toggle" data-tip="${tip}" class="${cls || ""}${src.classList.contains("on") ? " on" : ""}" aria-label="${tip}">${svg}</button>`;
    }).join("");
    // settings is not a proxy for a menu toggle — it opens the drawer
    st.insertAdjacentHTML("beforeend", `<div class="sep"></div>
      <button data-tip="Units and settings" aria-label="Settings" id="strip-settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.5.66.86 1.2.98H21a2 2 0 1 1 0 4h-.09c-.54.02-1 .38-1.2.88z"/></svg></button>`);
    st.querySelectorAll("button[data-for]").forEach((b) => b.onclick = () => $("#" + b.dataset.for).click());
    $("#strip-settings").onclick = () => WX.settings.toggle();
    // the crosshair is part of the strip on desktop, so the two can never
    // collide the way a floating button did
    st.insertAdjacentHTML("beforeend", `<button class="strip-locate" data-tip="My location" aria-label="My location">${$("#locate-btn").innerHTML}</button>`);
    st.querySelector(".strip-locate").onclick = () => $("#locate-btn").click();
    // overflow flyout: the strip stays fixed, the extras animate out beside it
    st.insertAdjacentHTML("beforeend", `<button id="strip-more" data-tip="More layers and tools" aria-label="More" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>`);
    document.body.insertAdjacentHTML("beforeend", '<div id="strip-more-pop" class="tstrip strip-pop"></div>');
    $("#strip-more").onclick = (e) => { e.stopPropagation(); st.classList.toggle("more-open"); positionMorePop(); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#tstrip") && !e.target.closest("#strip-more-pop")) st.classList.remove("more-open"); });
    fitStrip();
    addEventListener("resize", () => { if (!pageIsPinchZoomed()) fitStrip(); });
    new MutationObserver(() => st.querySelectorAll("button[data-for]").forEach((b) => b.classList.toggle("on", $("#" + b.dataset.for).classList.contains("on")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  // Bottom-sheet drag on phones: pull the grip up to cover the tape, down to
  // put it back or close it. Pointer events so a mouse works too.
  // One write per animation frame, whatever the pointer does. Pointer events
  // fire faster than the screen refreshes and each of these handlers writes
  // layout; without the gate a drag stutters instead of following the finger.
  const perFrame = (fn) => {
    let id = 0, args = null;
    return (...a) => { args = a; if (id) return; id = requestAnimationFrame(() => { id = 0; fn(...args); }); };
  };
  // Safari emits resize events while page pinch-zooming. That is visual
  // magnification, not a new layout viewport; re-clamping the panels against
  // it makes the card and tape jump under the user's fingers.
  const pageIsPinchZoomed = () => window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02;

  function wireSheet() {
    const grip = $(".sheet-grip"), card = $("#point");
    if (!grip) return;
    // The phone card is a sheet you size with your thumb: the drag sets its
    // height directly and keeps it, rather than snapping to two fixed stops.
    // Pulling it below the minimum still closes it.
    // visualViewport is what the reader can actually see; innerHeight on iOS
    // still counts the strip behind Safari's toolbars, and a card sized to that
    // hides its own header — and its close button — off the top.
    const viewH = () => Math.round((window.visualViewport && !pageIsPinchZoomed() && window.visualViewport.height) || innerHeight);
    const bounds = () => {
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 52;
      return { min: 168, max: Math.max(220, viewH() - top - 18) };
    };
    const stored = Number(localStorage.getItem("wxgrid.sheetHeight")) || 0;
    let y0 = 0, dy = 0, startH = 0, dragging = false, closing = false, height = stored;
    const setHeight = (h, persist) => {
      const b = bounds();
      height = Math.max(b.min, Math.min(b.max, Math.round(h)));
      card.style.height = `${height}px`;
      card.classList.add("sheet-sized");
      if (persist) localStorage.setItem("wxgrid.sheetHeight", String(height));
      return height;
    };
    restoreSheetHeight = () => {
      if (innerWidth > 820) { card.style.height = ""; card.classList.remove("sheet-sized"); return; }
      if (height) setHeight(height, false);
    };
    const track = perFrame((clientY) => {
      if (!dragging) return;
      dy = clientY - y0;
      const b = bounds();
      closing = startH - dy < b.min - 64;
      card.style.opacity = closing ? ".62" : "";
      setHeight(startH - dy, false);
    });
    grip.addEventListener("pointerdown", (e) => {
      if (innerWidth > 820) return;
      dragging = true; y0 = e.clientY; dy = 0; closing = false;
      startH = card.getBoundingClientRect().height;
      card.classList.add("sheet-drag"); grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => { if (dragging) track(e.clientY); });
    const end = (cancel) => {
      if (!dragging) return;
      dragging = false; card.classList.remove("sheet-drag"); card.style.opacity = "";
      if (!cancel && closing) { closePoint(); return; }
      if (!cancel && Math.abs(dy) < 6) {                    // a tap toggles tall / short
        const b = bounds();
        setHeight(height > (b.min + b.max) / 2 ? Math.round(b.max * 0.5) : b.max, true);
        return;
      }
      localStorage.setItem("wxgrid.sheetHeight", String(height));
    };
    grip.addEventListener("pointerup", () => end(false));
    grip.addEventListener("pointercancel", () => end(true));
    addEventListener("resize", () => { if (!pageIsPinchZoomed()) restoreSheetHeight(); });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => { if (!pageIsPinchZoomed()) restoreSheetHeight(); });
  }

  // Persisted panel sizing. Pointer capture keeps each drag stable even when
  // the cursor outruns its handle; double-click or Home returns to the default.
  function wirePanelResizers() {
    const tb = $("#timebar"), tapeGrip = $("#tape-resize"), card = $("#point"), cardGrip = $("#point-resize");
    if (!tb || !tapeGrip || !card || !cardGrip || tb.dataset.resizeWired) return;
    tb.dataset.resizeWired = "1";
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const topHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 52;
    const tapeBounds = () => ({ min: 118, max: Math.max(118, Math.min(480, Math.round(innerHeight * 0.58), innerHeight - topHeight() - 180)) });
    let tapeHeight = Number(localStorage.getItem("wxgrid.tapeHeight")) || null;
    const setTapeHeight = (height, persist = false) => {
      const bounds = tapeBounds();
      tapeHeight = clamp(Math.round(height), bounds.min, bounds.max);
      tb.style.height = `${tapeHeight}px`; tb.classList.add("user-sized");
      tapeGrip.setAttribute("aria-valuemin", bounds.min); tapeGrip.setAttribute("aria-valuemax", bounds.max); tapeGrip.setAttribute("aria-valuenow", tapeHeight);
      if (persist) localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
    };
    const resetTapeHeight = () => {
      tapeHeight = null; localStorage.removeItem("wxgrid.tapeHeight");
      tb.style.height = ""; tb.classList.remove("user-sized");
      requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    };
    if (tapeHeight) setTapeHeight(tapeHeight);
    else requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    let tapeDrag = null;
    // The grip drags through the three states: pull it down past the minimum
    // and the tape collapses to its header, further and it goes away. The
    // height itself is only written once per frame — see perFrame.
    const trackTape = perFrame((clientY) => {
      if (!tapeDrag) return;
      tapeDrag.want = tapeDrag.height + tapeDrag.y - clientY;
      const min = tapeBounds().min;
      if (tapeDrag.want >= min) { if (tapeState !== "full") setTapeState("full", false); setTapeHeight(tapeDrag.want); }
      else if (tapeState === "full" && tapeDrag.want < min - 40) setTapeState("mini", false);
      else if (tapeState === "mini" && tapeDrag.want < min - 110) setTapeState("away", false);
    });
    tapeGrip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      tapeDrag = { id: e.pointerId, y: e.clientY, height: tb.getBoundingClientRect().height, want: 0, from: tapeState };
      tapeGrip.setPointerCapture(e.pointerId); tb.classList.add("is-resizing"); document.body.classList.add("resizing-tape");
    });
    tapeGrip.addEventListener("pointermove", (e) => { if (tapeDrag && e.pointerId === tapeDrag.id) trackTape(e.clientY); });
    const finishTape = (e) => {
      if (!tapeDrag || (e && e.pointerId !== tapeDrag.id)) return;
      const tap = Math.abs(tapeDrag.want - tapeDrag.height) < 5;
      tapeDrag = null; tb.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
      if (tap) setTapeState(tapeState === "full" ? "mini" : "full");     // a tap on the grip cycles
      else localStorage.setItem("wxgrid.tapeState", tapeState);
      if (tapeHeight && tapeState === "full") localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
      restorePointPanelSize();
    };
    tapeGrip.addEventListener("pointerup", finishTape); tapeGrip.addEventListener("pointercancel", finishTape);
    tapeGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetTapeHeight(); restorePointPanelSize(); });
    tapeGrip.addEventListener("keydown", (e) => {
      if (e.key === "Home") { e.preventDefault(); resetTapeHeight(); restorePointPanelSize(); return; }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault(); setTapeHeight((tb.getBoundingClientRect().height || 180) + (e.key === "ArrowUp" ? 16 : -16), true); restorePointPanelSize();
    });

    let pointSize = null;
    try { pointSize = JSON.parse(localStorage.getItem("wxgrid.pointSize") || "null"); } catch (_) { pointSize = null; }
    const pointBounds = () => {
      const rect = card.getBoundingClientRect();
      const tbHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || tb.getBoundingClientRect().height || 150;
      return { minW: 340, maxW: Math.max(340, innerWidth - rect.left - 12), minH: 230, maxH: Math.max(230, innerHeight - rect.top - tbHeight - 20) };
    };
    const setPointSize = (width, height, persist = false) => {
      if (innerWidth <= 820) { card.style.width = ""; card.style.height = ""; card.classList.remove("user-sized"); return; }
      const bounds = pointBounds();
      pointSize = { width: clamp(Math.round(width), bounds.minW, bounds.maxW), height: clamp(Math.round(height), bounds.minH, bounds.maxH) };
      card.style.width = `${pointSize.width}px`; card.style.height = `${pointSize.height}px`; card.classList.add("user-sized");
      cardGrip.setAttribute("aria-valuetext", `${pointSize.width} by ${pointSize.height} pixels`);
      if (persist) localStorage.setItem("wxgrid.pointSize", JSON.stringify(pointSize));
    };
    restorePointPanelSize = () => {
      if (innerWidth <= 820) { card.style.width = ""; card.style.height = ""; card.classList.remove("user-sized"); return; }
      if (!card.hidden && pointSize && pointSize.width && pointSize.height) setPointSize(pointSize.width, pointSize.height);
    };
    const resetPointSize = () => {
      pointSize = null; localStorage.removeItem("wxgrid.pointSize");
      card.style.width = ""; card.style.height = ""; card.classList.remove("user-sized"); cardGrip.removeAttribute("aria-valuetext");
      if (state.point) renderPoint();
    };
    let pointDrag = null;
    cardGrip.addEventListener("pointerdown", (e) => {
      if (innerWidth <= 820) return;
      e.preventDefault(); e.stopPropagation();
      const rect = card.getBoundingClientRect();
      pointDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
      cardGrip.setPointerCapture(e.pointerId); card.classList.add("is-resizing"); document.body.classList.add("resizing-point");
    });
    const trackPoint = perFrame((x, y) => {
      if (!pointDrag) return;
      setPointSize(pointDrag.width + x - pointDrag.x, pointDrag.height + y - pointDrag.y);
    });
    cardGrip.addEventListener("pointermove", (e) => { if (pointDrag && e.pointerId === pointDrag.id) trackPoint(e.clientX, e.clientY); });
    const finishPoint = (e) => {
      if (!pointDrag || (e && e.pointerId !== pointDrag.id)) return;
      pointDrag = null; card.classList.remove("is-resizing"); document.body.classList.remove("resizing-point");
      if (pointSize) localStorage.setItem("wxgrid.pointSize", JSON.stringify(pointSize));
      if (state.point) renderPoint();
    };
    cardGrip.addEventListener("pointerup", finishPoint); cardGrip.addEventListener("pointercancel", finishPoint);
    cardGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetPointSize(); });
    cardGrip.addEventListener("keydown", (e) => {
      if (e.key === "Home") { e.preventDefault(); resetPointSize(); return; }
      if (!e.key.startsWith("Arrow") || innerWidth <= 820) return;
      e.preventDefault(); const rect = card.getBoundingClientRect(), step = e.shiftKey ? 32 : 16;
      setPointSize(rect.width + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0), rect.height + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0), true);
      if (state.point) renderPoint();
    });
    // The layer rail: one axis, because its width is set by the longest label
    // and dragging it sideways would only ever cut a word in half.
    const rail = $("#layers"), side = $("#side"), sideGrip = $("#side-resize");
    if (rail && sideGrip) {
      const railMax = () => Math.max(140, side.getBoundingClientRect().height ? innerHeight - side.getBoundingClientRect().top - 40 : 400);
      let railH = Number(localStorage.getItem("wxgrid.railHeight")) || null;
      const setRailHeight = (h) => { railH = clamp(Math.round(h), 140, railMax()); rail.style.maxHeight = `${railH}px`;
        sideGrip.setAttribute("aria-valuenow", railH); };
      const resetRail = () => { railH = null; localStorage.removeItem("wxgrid.railHeight"); rail.style.maxHeight = ""; };
      if (railH) setRailHeight(railH);
      let railDrag = null;
      const trackRail = perFrame((y) => { if (railDrag) setRailHeight(railDrag.height + y - railDrag.y); });
      sideGrip.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        railDrag = { id: e.pointerId, y: e.clientY, height: rail.getBoundingClientRect().height };
        sideGrip.setPointerCapture(e.pointerId); side.classList.add("is-resizing"); document.body.classList.add("resizing-tape");
      });
      sideGrip.addEventListener("pointermove", (e) => { if (railDrag && e.pointerId === railDrag.id) trackRail(e.clientY); });
      const finishRail = (e) => { if (!railDrag || (e && e.pointerId !== railDrag.id)) return;
        railDrag = null; side.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
        if (railH) localStorage.setItem("wxgrid.railHeight", railH); };
      sideGrip.addEventListener("pointerup", finishRail); sideGrip.addEventListener("pointercancel", finishRail);
      sideGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetRail(); });
      sideGrip.addEventListener("keydown", (e) => {
        if (e.key === "Home") { e.preventDefault(); resetRail(); return; }
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault(); setRailHeight(rail.getBoundingClientRect().height + (e.key === "ArrowDown" ? 24 : -24));
        localStorage.setItem("wxgrid.railHeight", railH);
      });
    }
    addEventListener("resize", () => { if (pageIsPinchZoomed()) return; if (tapeHeight) setTapeHeight(tapeHeight); restorePointPanelSize(); });
  }

  // Size the strip's buttons so the whole set fits between the top bar and the
  // time bar. It never scrolls: a toolbar that scrolls hides its own controls.
  function fitStrip() {
    const st = $("#tstrip"); if (!st || getComputedStyle(st).display === "none") return;
    const items = Array.from(st.querySelectorAll("button, .sep"));
    const more = $("#strip-more"), pop = $("#strip-more-pop");
    if (!items.length || !more) return;
    // put everything back in the strip, then move the tail into the flyout
    Array.from(pop.children).forEach((el) => st.insertBefore(el, more));
    const all = Array.from(st.querySelectorAll("button, .sep")).filter((el) => el !== more);
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 52;
    const tb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || 150;
    const btns = all.filter((el) => el.tagName === "BUTTON").length;
    const seps = all.length - btns;
    const avail = window.innerHeight - top - tb - 46;
    st.style.setProperty("--strip-btn", Math.max(26, Math.min(34, Math.floor((avail - 14 - seps * 7 - (all.length - 1) * 3) / Math.max(1, btns)))) + "px");
    // Then MEASURE and trim: arithmetic on gaps, borders and margins gets this
    // wrong every time, and being wrong here means a toolbar under the tape.
    const limit = st.getBoundingClientRect().top + avail;
    more.hidden = false;
    let guard = all.length;
    while (guard-- > 0 && st.getBoundingClientRect().bottom > limit) {
      const last = Array.from(st.querySelectorAll("button, .sep")).filter((el) => el !== more).pop();
      if (!last) break;
      pop.insertBefore(last, pop.firstChild);
    }
    // a separator that lands at the top or bottom of a column just hides
    [st, pop].forEach((box) => {
      const kids = Array.from(box.children).filter((el) => el !== more);
      kids.forEach((el) => el.classList.remove("sep-hide"));
      if (kids.length && kids[0].classList.contains("sep")) kids[0].classList.add("sep-hide");
      if (kids.length && kids[kids.length - 1].classList.contains("sep")) kids[kids.length - 1].classList.add("sep-hide");
    });
    const overflowed = pop.children.length > 0;
    more.hidden = !overflowed;
    if (!overflowed) st.classList.remove("more-open");
  }

  function positionMorePop() {
    const st = $("#tstrip"), pop = $("#strip-more-pop"), more = $("#strip-more");
    if (!st || !pop || !more) return;
    const r = more.getBoundingClientRect(), sr = st.getBoundingClientRect();
    pop.style.left = (sr.right + 8) + "px";
    const tb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || 150;
    const floor = window.innerHeight - tb - 30;                     // never over the tape
    pop.style.top = Math.max(sr.top, Math.min(floor - pop.offsetHeight, r.top - pop.offsetHeight + r.height)) + "px";
  }

  function switchModel(key, target = validDate().getTime()) {
    // Keep the VALID time, not the step index: comparing models means the same moment.
    if (WX.tape) WX.tape.clearFineSelection();
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
  function currentStepIdx() {
    const ms = Date.now(), valid = steps().map((h) => runDate().getTime() + h * 3600e3);
    let best = 0;
    valid.forEach((t, k) => { if (Math.abs(t - ms) < Math.abs(valid[best] - ms)) best = k; });
    return best;
  }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; WX.ov.applyRadarFrame(); return; }
    if (WX.tape) WX.tape.clearFineSelection();
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso();
  }
  function setStep(i) { if (WX.tape) WX.tape.clearFineSelection(); state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); }

  function applyStep(prefetch = true) {
    pushHash();
    const src = map.getSource("wx");
    if (src) { try { src.updateImage({ url: layerUrl(), coordinates: WORLD }); } catch (e) { /* superseded */ } }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", rasterOpacity());
    if (state.thunder && WX.ov) WX.ov.loadThunder();
    if (state.xsection && WX.xs) WX.xs.refresh();
    if (state.aq && WX.cams) WX.cams.refresh();
    if (state.route && WX.route) WX.route.refresh();
    if (WX.probe) WX.probe.refresh();
    const v = validDate();
    $("#valid-local").textContent = v.toLocaleString(undefined, WX.units.timeOpts({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    $("#lead").textContent = `+${stepHours()}h`;
    $("#tape-now").classList.toggle("on", state.stepIdx === currentStepIdx());
    $("#tape-now").setAttribute("aria-pressed", state.stepIdx === currentStepIdx() ? "true" : "false");
    if (prefetch) { const img = new Image(); img.src = layerUrl(steps()[(state.stepIdx + 1) % steps().length]); if (state.resorts && WX.ov) WX.ov.loadResorts(); }
    WX.tape.renderTapeSelection();
    if (state.point) renderPoint();
  }

  let windReq = 0;
  async function loadWind(prefetch = true) {
    if (!runEntry().layers.includes(isWaves() ? "waves" : "wind")) { wind.setField(null); return; }
    const my = ++windReq;
    try {
      const fld = await WX.api(windUrl());
      if (my !== windReq) return;
      wind.setField(fld);
      if (prefetch) fetch(windUrl(steps()[(state.stepIdx + 1) % steps().length])).catch(() => {});
    } catch (e) { /* keep the previous field */ }
  }

  function togglePlay() {
    state.playing = !state.playing;
    $("#play").textContent = state.playing ? "❚❚" : "▶";
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (state.playing) playTimer = setInterval(() => nudge(1), state.radar ? Math.min(500, state.playMs) : state.playMs);
  }

  // one switch for the wind animation, shared by the menu chips and settings
  function setMotion(mode) {
    state.particles = mode === "particles"; state.barbs = mode === "barbs";
    $("#particles-toggle").classList.toggle("on", state.particles);
    $("#barbs-toggle").classList.toggle("on", state.barbs);
    wind.setMode(state.barbs ? "barbs" : "particles");
    wind.setEnabled(state.particles || state.barbs);
  }
  function restartPlay() { if (state.playing) { togglePlay(); togglePlay(); } }

  function renderLegend() {
    const lg = catalog.layers.find((l) => l.layer === state.layer);
    if (!lg) { $("#legend").hidden = true; return; }
    $("#legend").hidden = false;
    const grad = lg.stops.map((s) => `rgb(${s.rgb.join(",")}) ${((s.v - lg.lo) / (lg.hi - lg.lo) * 100).toFixed(1)}%`).join(", ");
    $(".legend-bar").style.background = `linear-gradient(to right, ${grad})`;
    const isSpeed = ["wind", "gust"].includes(state.layer);
    const cv = { temp: (v) => WX.units.tempC(v), d2m: (v) => WX.units.tempC(v),
                 msl: (v) => WX.units.press(v * 100), frz: (v) => WX.units.alt(v),
                 tp6: (v) => WX.units.precip(v), tp24: (v) => WX.units.precip(v), tp72: (v) => WX.units.precip(v),
                 sf6: (v) => WX.units.snow(v), sf24: (v) => WX.units.snow(v), sf72: (v) => WX.units.snow(v),
                 sd_cm: (v) => WX.units.snow(v), waves: (v) => WX.units.alt(v, 1) }[state.layer];
    const conv = (v) => isSpeed ? Math.round(speed(v)) : cv ? cv(v).v : Math.round(v);
    const unit = isSpeed ? speedUnit() : cv ? cv(0).unit : lg.units;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => lg.lo + (lg.hi - lg.lo) * q);
    // The layer's name belongs over the bar, not wedged into the middle tick
    // where it collided with the value under it. Ticks are numbers only.
    const name = LAYER_LABEL[state.layer] + (state.level && hasLevel() ? ` ${state.level}` : "");
    $("#legend .legend-head b").textContent = name;
    $("#legend .legend-head i").textContent = unit;
    $(".legend-ticks").innerHTML = ticks.map((t) => `<span>${conv(t)}</span>`).join("");
  }

  // ── point card ────────────────────────────────────────────────────────
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    state.point = { lat, lon, data: null, ai: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    restorePointPanelSize(); restoreSheetHeight();
    document.body.classList.add("has-point");
    $("#point-title").textContent = name || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    $("#point-local").textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${modelEntry().short}`;
    $("#point-now").textContent = "…";
    $$(".point-tabs button[data-tab=resort]").forEach((b) => b.hidden = !state.resort);
    { const on = WX.search.isFav(lat, lon); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; }
    placeMarker(lat, lon);
    if (WX.provider) WX.provider.refresh();
    pushHash();
    try {
      const d = await WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=${state.model}&run=${state.run}`);
      if (my !== pointReq) return;
      state.point.data = d;
      renderPoint(); WX.tape.renderTape();
      const rd = new Date(d.run + ":00Z");
      $("#point-foot").textContent = `${modelEntry().short} run ${rd.toLocaleString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} ${String(rd.getUTCHours()).padStart(2, "0")}Z · 0.25° gridpoint · ${modelEntry().attribution.replace("ECMWF open data", "ECMWF").replace(" (AIFS)", "").replace("NOAA NCEP GFS via NOMADS", "NOAA")}`;
      // A shorter model can hand the daily outlook to AI-GFS after its own
      // final valid time. Keep the primary series untouched: only the day
      // strip uses this continuation, and labels the change of model plainly.
      const aiModel = catalog.models.find((m) => m.key === "aigfs" && m.runs.length);
      if (state.model !== "aigfs" && aiModel) {
        const aiRun = aiModel.runs[0];
        const aiEnd = new Date(aiRun.valid_from).getTime() + Math.max(...aiRun.steps) * 3600e3;
        const primaryEnd = new Date(d.valid[d.valid.length - 1]).getTime();
        if (aiEnd > primaryEnd + 3600e3) {
          WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=aigfs&run=${aiRun.run}`)
            .then((r) => { if (my === pointReq) { state.point.ai = r; renderPoint(); } })
            .catch(() => {});
        }
      }
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.local = r; if (r.timezone && r.timezone.tz) { WX.units.pointZone = r.timezone.tz; if (WX.units.followsPoint) { WX.tape.renderTape(); applyStep(false); } } if ((!state.point.name || hasNonLatinScript(state.point.name)) && r.place && r.place.name) { state.point.name = r.place.name; $("#point-title").textContent = r.place.name; } WX.tape.renderTape(); renderPoint(); } }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.obs = r; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/alerts/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.alerts = r.alerts || []; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/air?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.air = r; renderPoint(); } }).catch(() => {});
    WX.api(`${API}/tides?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) { state.point.tides = r; renderPoint(); } }).catch(() => { if (my === pointReq) state.point.tides = false; });
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { state.point = null; state.resort = null; $("#point").hidden = true; document.body.classList.remove("has-point"); if (WX.provider) WX.provider.refresh(); if (marker) { marker.remove(); marker = null; } WX.tape.renderTape(); WX.tape.refreshTapePoint(); }
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
