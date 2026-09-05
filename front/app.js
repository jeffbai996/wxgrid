// wxgrid front end — core: map, controls, layers/overlays, time bar + tape,
// place/resort search, tapped-point marker. The point card's panes live in
// panes.js and hang off window.WX. Everything comes from /api (plus
// RainViewer tiles for radar and OpenFreeMap for the basemap).
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const API = "api";
  const WORLD = [[-180, 89.99], [180, 89.99], [180, -89.99], [-180, -89.99]];
  // Every raster layer the API can draw. The rail shows FAMILIES; a family
  // with variants (rain 6h/24h/72h …) gets a variant picker in the time bar.
  const FAMILIES = [
    { key: "wind", label: "Wind", layers: ["wind"] },
    { key: "gust", label: "Gusts", layers: ["gust", "gfactor"], variants: { gust: "Peak", gfactor: "Factor" } },
    { key: "temp", label: "Temp", layers: ["temp", "feels", "wbt", "dt24"], variants: { temp: "Air", feels: "Feels", wbt: "Wet-bulb", dt24: "Δ" } },
    { key: "rain", label: "Rain", layers: ["tp6", "tp24", "tp72"], variants: { tp6: "6 h", tp24: "24 h", tp72: "72 h" }, section: "Precipitation" },
    { key: "ptype", label: "Precip type", layers: ["ptype"] },
    { key: "snow", label: "New snow", layers: ["sf6", "sf24", "sf72"], variants: { sf6: "6 h", sf24: "24 h", sf72: "72 h" } },
    { key: "sd", label: "Snow depth", layers: ["sd_cm"] },
    { key: "frz", label: "Freezing lvl", layers: ["frz"] },
    { key: "tcc", label: "Clouds", layers: ["tcc", "cloudlow", "cloudmid", "cloudhigh"],
      variants: { tcc: "Total", cloudlow: "Low", cloudmid: "Mid", cloudhigh: "High" }, section: "Air" },
    { key: "fog", label: "Fog potential", layers: ["fog"] },
    { key: "msl", label: "Pressure", layers: ["msl", "ptend", "gh"], variants: { msl: "MSL", ptend: "Change", gh: "Height" } },
    { key: "hum", label: "Humidity", layers: ["rh", "d2m"], variants: { rh: "RH %", d2m: "Dew pt" } },
    { key: "cape", label: "CAPE", layers: ["cape"] },
    { key: "vis", label: "Visibility", layers: ["vis"] },
    { key: "cbase", label: "Cloud base", layers: ["cbase"] },
    { key: "vort", label: "Vorticity", layers: ["vort500"] },
    { key: "uvi", label: "UV index", layers: ["uvi"] },
    { key: "solar", label: "Solar power", layers: ["solar"] },
    { key: "waves", label: "Waves", layers: ["waves", "swell", "windsea", "wperiod", "pp1d", "wavepower"], variants: { waves: "Height", swell: "Swell", windsea: "Wind sea", wperiod: "Period", pp1d: "Peak", wavepower: "Power" }, section: "Sea" },
    { key: "sst", label: "Sea temp", layers: ["sst"] },
    // member counts, drawn from the GEFS run only — the one model that has them
    { key: "chance", label: "Chance", layers: ["prob_rain", "prob_gust"], variants: { prob_rain: "Rain", prob_gust: "Gale" }, section: "Ensemble" },
  ];
  const familyOf = (layer) => FAMILIES.find((f) => f.layers.includes(layer)) || FAMILIES[0];
  // Winter mode is a focused workspace, not another meteorological field.
  // Keep the useful mountain layers in an intentional order and leave ocean,
  // convection and ensemble furniture one tap away by turning the mode off.
  const WINTER_FAMILY_ORDER = ["snow", "sd", "frz", "ptype", "rain", "temp", "wind", "gust", "tcc", "fog"];
  const WINTER_LAYER_PREFERENCE = ["sf72", "sf24", "sf6", "sd_cm", "ptype", "frz", "temp"];
  // Every layer the rail can reach. Derived from FAMILIES rather than kept as
  // a second list: the hand-written one had gone stale, so a permalink to
  // visibility, sea temp, precip type or vorticity quietly landed on wind.
  const LAYERS = FAMILIES.flatMap((f) => f.layers);
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", feels: "Feels like", prob_rain: "Rain chance", prob_gust: "Gale chance", gfactor: "Gust factor", vis: "Visibility", sst: "Sea temp", ptype: "Precip type", vort500: "Vorticity 500", ptend: "Pressure change", gh: "Height", cbase: "Cloud base", wbt: "Wet-bulb", dt24: "Temp Δ 24h", msl: "Pressure", tp6: "Rain 6h", tp24: "Rain 24h", tp72: "Rain 72h", sf6: "New snow 6h", sf24: "New snow 24h", sf72: "New snow 72h", sd_cm: "Snow depth", tcc: "Total cloud", cloudlow: "Low cloud", cloudmid: "Mid cloud", cloudhigh: "High cloud", fog: "Fog potential", solar: "Solar power", cape: "CAPE", d2m: "Dew point", rh: "Humidity", frz: "Freezing lvl", waves: "Waves", swell: "Swell", windsea: "Wind sea", wperiod: "Wave period", pp1d: "Peak period", wavepower: "Wave power", uvi: "UV index" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, tp24: 0.9, tp72: 0.9, sf6: 0.9, sf24: 0.9, sf72: 0.9, sd_cm: 0.85, tcc: 0.9, cloudlow: 0.85, cloudmid: 0.85, cloudhigh: 0.85, fog: 0.85, solar: 0.82, cape: 0.85, d2m: 0.75, rh: 0.75, frz: 0.7, waves: 0.8, swell: 0.8, windsea: 0.8, wperiod: 0.8, pp1d: 0.8, wavepower: 0.82, uvi: 0.8, feels: 0.78, prob_rain: 0.82, prob_gust: 0.82, vis: 0.85, sst: 0.8, ptype: 0.85, gfactor: 0.78, vort500: 0.75, ptend: 0.8, gh: 0.72, cbase: 0.75, wbt: 0.78, dt24: 0.8 };
  const LAYER_ICON = {
    iso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c5.5 0 8.9 3.5 8.4 8.5-.5 5-3.9 8.5-8.9 8.5S3.1 17 3.6 12 6.5 3.5 12 3.5z"/><path d="M12 8c3 0 5 1.5 4.7 4-.3 2.5-2.2 4-4.7 4s-4.7-1.5-4.4-4C7.9 9.5 9.5 8 12 8z"/><path d="M12 11.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>',
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
  const FAMILY_ICON = { wind: "wind", gust: "gust", temp: "temp", rain: "tp6", snow: "sf6", sd: "sd_cm", frz: "frz", tcc: "tcc", fog: "tcc", solar: "uvi", msl: "msl", hum: "rh", cape: "cape", waves: "waves", uvi: "uvi", chance: "tp6", ptype: "sf6", vis: "tcc", vort: "msl", sst: "waves", cbase: "tcc" };
  const LEVEL_FT = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "FL180", 400: "FL240", 300: "FL300", 250: "FL340", 200: "FL390", 150: "FL450", 100: "FL530" };
  const LEVEL_FEET = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "18k ft", 400: "24k ft", 300: "30k ft", 250: "34k ft", 200: "39k ft", 150: "45k ft", 100: "53k ft" };
  const LEVEL_M = { 1000: "≈100 m", 925: "≈750 m", 850: "≈1.5 km", 700: "≈3 km", 600: "≈4.2 km", 500: "≈5.5 km", 400: "≈7.2 km", 300: "≈9 km", 250: "≈10.5 km", 200: "≈12 km", 150: "≈13.6 km", 100: "≈16 km" };
  const levelBadge = (level) => {
    const system = WX.units && WX.units.pref.baro || "metric";
    const labels = system === "flight" ? LEVEL_FT : system === "feet" ? LEVEL_FEET : LEVEL_M;
    return (labels[level] || "").replace(/^≈/, "");
  };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  // Embed mode (?embed=1): the map, the legend and the clock, nothing else.
  // For iframes on other pages; the brand link opens the full app on the
  // same view. Set before anything measures the chrome.
  const EMBED = new URLSearchParams(location.search).get("embed") === "1";
  if (EMBED) document.body.classList.add("embed");
  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    // where the map sits BETWEEN stepIdx and the next step, 0..1. Only the
    // GPU field path can draw it; the raster path rounds it away.
    frac: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
    winterMode: localStorage.getItem("wxgrid.winterMode") === "1",
    alerts: false, storms: false, sat: false, barbs: false, smoke: false, fires: false, quakes: false, aod: false, thunder: false, obs: false,
    sigmet: false, aurora: false, lightning: false, aq: false, route: false,
    probeChip: localStorage.getItem("wxgrid.probe") === "1",
    base: localStorage.getItem("wxgrid.base") || "", night: false,
    terrain: localStorage.getItem("wxgrid.terrain") === "1", aqVar: localStorage.getItem("wxgrid.aqVar") || "pm2_5",
    opacity: Number(localStorage.getItem("wxgrid.opacity") || 100),
    particleDensity: Number(localStorage.getItem("wxgrid.particleDensity") || 60), xsection: false,
    playMs: Number(localStorage.getItem("wxgrid.playMs") || 900),
  };
  let map, wind, catalog, playTimer = null, playRaf = 0, playFrom = 0, marker = null;
  let restorePointPanelSize = () => {};
  let restoreSheetHeight = () => {};
  let focusMobileSheet = () => {};
  let pointTapeReturn = null;
  let uiWired = false;
  let setTapeState = () => {};
  let tapeState = "full";
  const nextTapeState = () => ({ full: "mini", mini: "away", away: "full" })[tapeState] || "full";

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : state.units === "mph" ? ms * 2.236936 : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s", mph: "mph" }[state.units]);
  // Forecast direction is where the wind comes FROM; the needle points where
  // it is going.  Its SVG points north before rotation, so no mystery 45°
  // compensation belongs here.
  const arrowRot = (deg) => `transform: rotate(${(deg + 180) % 360}deg)`;
  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];
  // The map renders world copies, so a click east of the antimeridian gives
  // lng 200 or -200. The marker keeps the raw value (it belongs in the copy
  // the user clicked); every API call gets the wrapped one, since the store
  // is one world wide.
  const wlon = (x) => ((x + 180) % 360 + 360) % 360 - 180;
  // "50.77° N, 120.99° W" reads as a place; a signed pair reads as debug
  // output. Longitude is wrapped first so a map copy east of the antimeridian
  // still names the hemisphere people expect.
  const fmtCoords = (lat, lon, nd = 2) => {
    const wl = wlon(lon);
    return `${Math.abs(lat).toFixed(nd)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(wl).toFixed(nd)}° ${wl >= 0 ? "E" : "W"}`;
  };
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
  window.WX = { state, speed, speedUnit, arrowRot, f, arrow, wlon, fmtCoords, rampColor, LEVEL_FT, LEVEL_M, AVY_COLORS, API, LAYER_ALPHA, $, $$,
                get map() { return map; }, get catalog() { return catalog; }, toast, modelEntry: () => modelEntry(), openPoint, closePoint,
                get validDate() { return validDate(); }, get stepHours() { return stepHours(); }, api: apiJson, url: U };
  // Functions the split-out modules (overlays.js, tape.js, search.js) call back into.
  window.WX.fn = { applyStep: (...a) => applyStep(...a), openPoint: (...a) => openPoint(...a), setStep: (...a) => setStep(...a), toast, firstSymbolId: () => firstSymbolId(),
                   renderPoint: () => renderPoint(), refreshPoint: () => refreshPoint(), closePoint: () => closePoint(), placeMarker: (...a) => placeMarker(...a),
                   stepHours: () => stepHours(), steps: () => steps(), layerUrl: () => layerUrl(),
                   applyTheme: (t) => applyTheme(t), setMotion: (m) => setMotion(m), restartPlay: () => restartPlay(), fitStrip: () => fitStrip(), runEntry: () => runEntry(), modelEntry: () => modelEntry(), validDate: () => validDate(), pushHash: () => pushHash(), nudge: (d) => nudge(d), clearOtherCover: (k) => clearOtherCover(k), updateMarkerFlag: () => updateMarkerFlag(),
                   renderTapePill: () => renderTapePill(),
                   setTapeState: (s, persist) => setTapeState(s, persist), getTapeState: () => tapeState,
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
    // No WebGL — a locked-down laptop, a remote desktop, a headless browser —
    // used to kill the whole app before the card opened: MapLibre came up
    // with no painter and the first map call threw on null. The forecast does
    // not need the map. A shim answers every map call inertly, the map pane
    // says why it is blank, and the tape, card and search carry on.
    map = hasWebGL() ? new maplibregl.Map({
      container: "map", style: mapStyle(),
      center: hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], zoom: hash ? hash.zoom : saved && currentMapScale ? saved.zoom : defaultZoom,
      // Past z11 the field is one world-sized image being stretched, and what
      // you actually want is the ground: streets, lifts, runs. So the map keeps
      // zooming to where the basemap still has detail, and the field steps back.
      minZoom: 1.2, maxZoom: 15, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    }) : noMap(hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], hash ? hash.zoom : defaultZoom);
    if (map.noMap) { document.body.classList.add("no-map"); toast("No WebGL here: the map is off, the forecast still works", 9000); }
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // The globe. MapLibre's "globe" projection IS the nullschool behaviour:
    // a sphere when zoomed out, easing itself flat around z6 so streets stay
    // streets. Set on every style.load — a basemap or theme swap replaces the
    // style wholesale and would silently flatten the planet again.
    map.on("style.load", () => {
      if (map.setProjection) map.setProjection({ type: "globe" });
      // No setSky here: the v5 atmosphere brings sun-position shading with
      // it, and on the real hardware the lit/dark gradient read as jank, not
      // physics (Jeff 2026-08-20). The bare globe on the page background is
      // the cleaner look.
    });
    // Subscribe before the catalog request. A cached style can emit
    // `style.load` while /api/models is still in flight.
    const styleReady = new Promise((resolve) => {
      map.once("style.load", resolve);
      if (map.isStyleLoaded()) resolve();
    });
    map.on("moveend", () => {
      localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      if (catalog) renderControls();
      if (!state.point) WX.tape.refreshTapePoint();
      renderTapePill();
      if (WX.provider) WX.provider.refresh();
      if (state.radar && WX.ov.refreshRadarSource) WX.ov.refreshRadarSource();
      if (state.obs && WX.ov.refreshObs) WX.ov.refreshObs();
      pushHash();
    });
    wind = map.noMap ? { setDensity() {}, setEnabled() {}, setField() {}, setMode() {} } : new WindLayer(map, $("#particles"));
    if (WX.probe && WX.probe.wireCityValues) WX.probe.wireCityValues();
    WX.windLayer = wind;
    wind.setDensity(state.particleDensity);
    // A taller tape leaves less room for a hand-sized card, so re-clamp it —
    // but never mid-drag, where it would fight the pointer.
    const liveTimebar = $("#timebar");
    new ResizeObserver(() => {
      const dragging = document.body.classList.contains("resizing-tape");
      const animating = liveTimebar.classList.contains("tape-anim");
      // Dragging writes the live height itself. During a state glide the
      // observer only moves dependent panels; fitting the strip and
      // reclamping the card on every animation frame was the remaining jank.
      if (!dragging) document.documentElement.style.setProperty("--tb-h", liveTimebar.offsetHeight + "px");
      if (dragging || animating) return;
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      restorePointPanelSize();
    }).observe(liveTimebar);
    new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $("#topbar").offsetHeight + "px")).observe($("#topbar"));
    wirePanelResizers();

    catalog = await WX.api(`${API}/models?ts=${Date.now()}`);
    if (catalog.static) toast(`Static demo · run ${catalog.static.built}Z`, 9000);
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs yet", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = state.winterMode ? preferredWinterLayer(runEntry().layers) : runEntry().layers[0];

    if (hash) { if (hash.model && catalog.models.some((m) => m.key === hash.model && m.runs.length)) state.model = hash.model; if (hash.layer && LAYERS.includes(hash.layer)) state.layer = hash.layer; state.level = hash.level || 0; state.run = modelEntry().runs[0].run; if (hash.step != null) state.stepIdx = Math.min(hash.step, steps().length - 1); }
    if (state.winterMode) {
      const allowed = WINTER_FAMILY_ORDER.includes(familyOf(state.layer).key) && runEntry().layers.includes(state.layer);
      if (!allowed) state.layer = preferredWinterLayer(runEntry().layers);
      state.base = "topo";
      state.terrain = true;
      state.resorts = true;
      state.avy = true;
    }
    // A fresh load opens at the current hour, whatever the link said — the
    // map should show now, not the run's first frame (Jeff 2026-08-22).
    state.stepIdx = currentStepIdx();
    // One decision, before the first frame: colour on the GPU from the field
    // files, or take the server's coloured PNGs. Everything downstream reads
    // WX.field.live and nothing asks twice. It runs here, after the model and
    // run are settled, because giving up has to be able to draw the raster.
    if (WX.field) { WX.field.onFallback = fieldGaveUp; WX.field.enable(catalog); }
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
      const owned = ["fire-inc", "fire-perim-fill", "sigmet-fill", "quakes", "storm-pts", "storm-now", "storm-eye"].filter(has);
      if (owned.length && map.queryRenderedFeatures(e.point, { layers: owned }).length) return;
      const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-icon", "resort-pts", "resort-all-pts", "avy-fill"].filter(has) });
      const resort = feats.find((x) => ["resort-icon", "resort-pts", "resort-all-pts"].includes(x.layer.id));
      if (resort) { WX.ov.selectResort(resort.properties.id); return; }
      openPoint(e.lngLat.lat, e.lngLat.lng);
      const avy = feats.find((x) => x.layer.id === "avy-fill");
      if (avy) { state.tab = "winter"; }
    });
    map.on("mousemove", (e) => {
      // iPadOS reports its primary input as touch even while a trackpad is
      // moving the MapLibre mouse cursor. Judge this event, not the device;
      // only the synthetic mouse event emitted by an actual touch is ignored.
      const oe = e.originalEvent;
      const fromTouch = !!(oe && ((oe.pointerType && oe.pointerType !== "mouse")
        || (oe.sourceCapabilities && oe.sourceCapabilities.firesTouchEvents)));
      if (WX.probe && state.probeChip) WX.probe.hover(fromTouch ? null : e.lngLat);
    });
    map.on("mouseout", () => { if (WX.probe) WX.probe.hover(null); });
    map.on("moveend", () => { if (WX.provider) WX.provider.refresh(); });
    map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");
    map.on("mouseenter", "resort-all-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-all-pts", () => map.getCanvas().style.cursor = "");
    map.on("mouseenter", "resort-icon", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-icon", () => map.getCanvas().style.cursor = "");

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
          const h = steps()[(state.stepIdx + 1) % steps().length];
          if (fieldLive()) WX.field.prefetch(fieldUrl(h));
          else { const img = new Image(); img.src = layerUrl(h); }
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
  // Streets is a whole style (OpenFreeMap Liberty: every road class, names,
  // shields), not a raster under the vector map like Topo/Satellite.
  const STREETS_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const mapStyle = () => state.base === "streets" ? STREETS_STYLE
    : document.documentElement.dataset.theme === "light" ? "https://tiles.openfreemap.org/styles/positron" : "https://tiles.openfreemap.org/styles/dark";
  // A 1x1 transparent PNG. On the GPU path the raster layer draws nothing, but
  // it stays in the style on purpose: it is the layer overlays.js dims for
  // radar and satellite, and the one the field shader reads its opacity back
  // from. Pointing its source here means no layer PNG is ever fetched.
  const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==";
  const fieldLive = () => !!(WX.field && WX.field.live);
  function ensureWxLayer() {
    if (!map.getSource("wx")) {
      const gpu = fieldLive();
      map.addSource("wx", { type: "image", url: gpu ? BLANK : layerUrl(), coordinates: modelCoords() });
      map.addLayer({ id: "wx", type: "raster", source: "wx",
                     layout: { visibility: gpu ? "none" : "visible" },
                     paint: { "raster-opacity": rasterOpacity(), "raster-fade-duration": 0, "raster-resampling": "linear" } }, firstSymbolId());
      // Directly above the raster, so the coastline trace and everything the
      // overlays put before the first symbol layer still land on top.
      if (gpu && !map.getLayer("wx-field")) map.addLayer(WX.field.layer, firstSymbolId());
    }
    ensureCoastLayer();
    // roads and borders back on top of the field, with halos (overlays.js)
    if (WX.ov && WX.ov.boostBasemap) WX.ov.boostBasemap();
  }
  // The GPU path can give up at any point: no WebGL, a shader that will not
  // compile, a field the server does not have. Put the raster layer back and
  // carry on where it left off.
  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); }
    catch (e) { return false; }
  }
  // The map that is not there. Same surface app.js and the overlays call,
  // answers that keep them quiet: no layers, no features, a centre and zoom
  // it remembers, a flat equirectangular project/unproject over the pane so
  // the probe and the marker land somewhere sane. `style.load` and `load`
  // fire once so the boot sequence that waits on them proceeds.
  function noMap(center, zoom) {
    const el = $("#map"); const handlers = {}; let c = { lng: center[0], lat: center[1] }, z = zoom;
    const emit = (ev) => (handlers[ev] || []).slice().forEach((h) => { try { h({ target: shim }); } catch (e) { console.warn(e); } });
    const size = () => ({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    const bounds = () => { const { w, h } = size(); const dpp = 360 / (256 * Math.pow(2, z)); return { west: c.lng - w / 2 * dpp, east: c.lng + w / 2 * dpp, south: c.lat - h / 2 * dpp, north: c.lat + h / 2 * dpp }; };
    const shim = {
      noMap: true,
      on(ev, a, b) { (handlers[ev] = handlers[ev] || []).push(typeof a === "function" ? a : b); return shim; },
      once(ev, a, b) { const h = typeof a === "function" ? a : b; const w = (e) => { shim.off(ev, w); h(e); }; return shim.on(ev, w); },
      off(ev, a, b) { const h = typeof a === "function" ? a : b; handlers[ev] = (handlers[ev] || []).filter((x) => x !== h); return shim; },
      getCenter: () => ({ lng: c.lng, lat: c.lat, toArray: () => [c.lng, c.lat] }),
      getZoom: () => z, isMoving: () => false, isStyleLoaded: () => true, loaded: () => true,
      getProjection: () => ({ type: "mercator" }), setProjection() {}, setStyle() { setTimeout(() => emit("style.load"), 0); },
      getStyle: () => ({ layers: [], sources: {} }), getLayer: () => undefined, getSource: () => undefined,
      addLayer() {}, removeLayer() {}, addSource() {}, removeSource() {}, addImage() {}, hasImage: () => false,
      setLayoutProperty() {}, setPaintProperty() {}, getPaintProperty: () => undefined, setFilter() {}, setLayerZoomRange() {},
      queryRenderedFeatures: () => [], triggerRepaint() {}, resize() {}, remove() {}, addControl() {}, removeControl() {},
      // what Marker and Popup ask their map for on addTo()
      _getUIString: (k) => k, _requestRenderFrame: () => 0, _cancelRenderFrame() {}, getPitch: () => 0, getBearing: () => 0,
      getMaxPitch: () => 0, getTerrain: () => null, transform: { width: 800, height: 600 },
      getContainer: () => el, getCanvasContainer: () => el, getCanvas: () => el.querySelector("canvas") || Object.assign(document.createElement("canvas"), { width: size().w, height: size().h }),
      getBounds() { const b = bounds(); return { getWest: () => b.west, getEast: () => b.east, getSouth: () => b.south, getNorth: () => b.north, toArray: () => [[b.west, b.south], [b.east, b.north]] }; },
      project(ll) { const b = bounds(), { w, h } = size(); const lng = Array.isArray(ll) ? ll[0] : ll.lng, lat = Array.isArray(ll) ? ll[1] : ll.lat; return { x: (lng - b.west) / (b.east - b.west) * w, y: (b.north - lat) / (b.north - b.south) * h }; },
      unproject(pt) { const b = bounds(), { w, h } = size(); const x = Array.isArray(pt) ? pt[0] : pt.x, y = Array.isArray(pt) ? pt[1] : pt.y; return { lng: b.west + x / w * (b.east - b.west), lat: b.north - y / h * (b.north - b.south) }; },
      jumpTo(o) { if (o.center) c = { lng: o.center[0] ?? o.center.lng, lat: o.center[1] ?? o.center.lat }; if (o.zoom != null) z = o.zoom; emit("move"); emit("moveend"); },
      flyTo(o) { shim.jumpTo(o); }, easeTo(o) { shim.jumpTo(o); }, fitBounds() { emit("moveend"); },
    };
    // Markers, popups and controls are MapLibre objects that reach into the
    // real map's transform on addTo(); with no map they become inert
    // stand-ins with the same chainable surface, so route pins, the probe
    // pin and quake popups neither draw nor throw.
    const inert = class { constructor(o) { this._el = (o && o.element) || document.createElement("div"); this._ll = { lng: 0, lat: 0 }; }
      setLngLat(ll) { this._ll = Array.isArray(ll) ? { lng: ll[0], lat: ll[1] } : ll; return this; } getLngLat() { return this._ll; }
      addTo() { return this; } remove() { return this; } getElement() { return this._el; } on() { return this; } off() { return this; }
      setDraggable() { return this; } setOffset() { return this; } setHTML() { return this; } setDOMContent() { return this; }
      setText() { return this; } isOpen() { return false; } setMaxWidth() { return this; } toggleClassName() { return this; }
      addClassName() { return this; } removeClassName() { return this; } getPopup() { return null; } setPopup() { return this; }
      togglePopup() { return this; } setRotation() { return this; } onAdd() { return document.createElement("div"); } onRemove() {} };
    maplibregl.Marker = inert; maplibregl.Popup = inert; maplibregl.AttributionControl = inert; maplibregl.NavigationControl = inert; maplibregl.ScaleControl = inert;
    el.innerHTML = `<div class="nomap"><b>Map unavailable</b><span>This browser has no WebGL, so the map is off. Search a place or use the tape and card — the forecast is all here.</span></div>`;
    setTimeout(() => { emit("style.load"); emit("load"); }, 0);
    return shim;
  }
  function fieldGaveUp() {
    if (!map || !catalog || !state.model) return;         // gave up before the first frame
    state.stepIdx = Math.min(steps().length - 1, state.stepIdx + Math.round(state.frac));
    state.frac = 0;
    if (map.getLayer("wx-field")) map.removeLayer("wx-field");
    if (map.getLayer("wx")) map.setLayoutProperty("wx", "visibility", "visible");
    if (catalog) { renderControls(); applyStep(); }
    if (WX.probe) WX.probe.refresh();
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
    if (state.base) WX.ov.setBase(state.base);
    if (state.terrain) WX.ov.loadTerrain();
    if (state.night) WX.ov.updateNight();
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
      const brand = $("#embed-brand");
      if (brand) brand.href = location.origin + location.pathname + ownHash;
      history.replaceState(null, "", ownHash);
    }, 250);
  }

  // One share action behind both entry points: the tools menu row and the
  // point card's icon. pushHash debounces by 250 ms, so the URL is given a
  // moment to become the view before it is read back and copied.
  async function shareLink() {
    pushHash();
    await new Promise((r) => setTimeout(r, 300));
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (e) {
      // No clipboard: an insecure origin, a permissions policy, or an old
      // browser. A prompt is the last place the user can still select the
      // link by hand — a toast this long only overflows the pill.
      try { window.prompt("Copy this link", url); } catch (e2) { toast("Copy failed", 4000, "error"); }
    }
  }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  // The forecast hour the map is actually showing. Whole steps are the only
  // ones the model published, so they are the only ones a URL names; the
  // fraction is what the field layer is mixing towards.
  function shownHours() {
    const st = steps(), i = Math.min(state.stepIdx, st.length - 1);
    const next = i + 1 < st.length ? st[i + 1] : st[i];
    return st[i] + (next - st[i]) * state.frac;
  }
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + shownHours() * 3600e3);
  const hasLevel = () => ["wind", "temp", "gh"].includes(state.layer);
  const isWaves = () => ["waves", "swell", "windsea", "wperiod", "pp1d", "wavepower"].includes(state.layer);
  const levelQ = () => (state.level && hasLevel()) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => U(`${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  // The same frame as data. Same query, same run, different noun: the browser
  // colours this one itself (front/field.js).
  const fieldUrl = (h = stepHours()) => U(`${API}/field/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  // What the field layer should be drawing right now: this step, the next one,
  // and how far between them the timeline is sitting.
  function fieldSpec() {
    const st = steps(), i = Math.min(state.stepIdx, st.length - 1);
    const next = i + 1 < st.length ? st[i + 1] : null;
    return { a: fieldUrl(st[i]), b: next == null ? null : fieldUrl(next),
             t: next == null ? 0 : state.frac, layer: state.layer,
             level: hasLevel() ? state.level : 0, model: modelEntry() };
  }
  const windUrl = (h = stepHours()) => U(`${API}/wind/${state.model}/${state.run}/${h}.json${isWaves() ? "?field=waves" : state.level ? `?level=${state.level}` : ""}`);

  const modelCoords = (m = modelEntry()) => {
    if (!m || !m.regional) return WORLD;
    const [w, s, e, n] = m.domain;
    return [[w, n], [e, n], [e, s], [w, s]];
  };
  // A regional model is offered when its grid covers a real part of what you
  // are looking at — not when the map CENTRE happens to sit inside it. The
  // centre test disabled HRRR the moment you panned a little south, with most
  // of the continental grid still on screen (Jeff 2026-08-25: "HRRR is not
  // loading"); one degree of pan flipped a model on and off. Rendering already
  // clips to the domain, so a partly-covered view draws the part it has.
  const modelInView = (m) => {
    if (!m || !m.regional || !map) return true;
    const [w, s, e, n] = m.domain;
    const c = map.getCenter();
    if (c.lat >= s && c.lat <= n) { const lo = wlon(c.lng); if (lo >= w && lo <= e) return true; }
    let b;
    try { b = map.getBounds(); } catch { return false; }
    if (!b) return false;
    const vs = b.getSouth(), vn = b.getNorth(), vw = b.getWest(), ve = b.getEast();
    const latOverlap = Math.min(vn, n) - Math.max(vs, s);
    if (latOverlap <= 0) return false;
    // A view wider than the world, or one wrapped past the antimeridian, has
    // no meaningful west/east span to intersect — fall back to latitude alone.
    const lonOverlap = (ve - vw >= 360 || ve < vw)
      ? e - w : Math.min(ve, e) - Math.max(vw, w);
    if (lonOverlap <= 0) return false;
    // Ignore a sliver at the edge of the screen: a model worth switching to
    // has to cover enough of the view to be worth looking at.
    const area = (latOverlap * lonOverlap) /
                 Math.max(1e-9, (vn - vs) * Math.min(360, ve - vw));
    return area >= 0.12;
  };

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
  // Phone only: the model, run, level and layer rows fold into one chip that
  // names what the map is showing. The chip is the way back out.
  function renderTucked(showLevels) {
    const el = $("#tucked"); if (!el) return;
    const m = modelEntry();
    const fam = FAMILIES.find((f) => f.layers.includes(state.layer));
    const parts = [`${m.short}${m.grid ? `<i class="grid">${m.grid}</i>` : ""}`];
    if (showLevels) parts.push(state.level ? `${state.level}` : "sfc");
    parts.push(fam ? fam.label : LAYER_LABEL[state.layer] || state.layer);
    el.innerHTML = parts.join(`<i>·</i>`) + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  }
  const phoneMQ = matchMedia("(max-width: 820px)");
  let softTucked = false;
  function setTucked(on, persist = true) {
    const phone = phoneMQ.matches;
    document.body.classList.toggle("tucked", on && phone);
    $("#tuck").hidden = !phone || on;
    $("#tucked").hidden = !phone || !on;
    if (persist) localStorage.setItem("wxgrid.tucked", on ? "1" : "0");
  }
  function setParticleDensity(v) {
    state.particleDensity = Math.max(0, Math.min(100, v));
    localStorage.setItem("wxgrid.particleDensity", state.particleDensity);
    const rail = document.querySelector(".rail-density input");
    if (rail) {
      rail.value = String(state.particleDensity);
      rail.parentElement.querySelector("i").textContent = `${state.particleDensity}%`;
    }
    if (wind) wind.setDensity(state.particleDensity);
  }
  // The model and pressure pickers share one sliding selection plate. Keep the
  // old plate's geometry across a re-render so changing model metadata (the
  // selected grid badge) does not turn a smooth move into a flash.
  let levelApply = 0;
  const LEVEL_SLIDE_MS = 260;          // the plate's .24s slide, plus a frame
  // A re-render that changes nothing the eye can see (same buttons, same
  // one lit) keeps its DOM: rebuilding restarted the badge animation and
  // re-created the plate mid-slide.
  const segSignature = (root) => [...root.querySelectorAll("button")]
    .map((b) => `${b.dataset.level ?? b.dataset.model ?? b.textContent}|${b.disabled ? 1 : 0}|${b.classList.contains("on") ? 1 : 0}`).join(",");
  function renderSlidingSeg(el, buttons) {
    const old = el.querySelector(".seg-cursor");
    if (old && el._segPlace) {
      const probe = document.createElement("div"); probe.innerHTML = buttons;
      if (segSignature(probe) === segSignature(el)) { el._segPlace(); return; }
    }
    const prior = old ? old.getBoundingClientRect() : null;
    el.classList.add("sliding");
    el.innerHTML = `<i class="seg-cursor" aria-hidden="true"></i>${buttons}`;
    const cursor = el.querySelector(".seg-cursor");
    const place = () => {
      const active = el.querySelector("button.on");
      if (!active) { cursor.style.opacity = "0"; return; }
      // Rects, not offsetWidth/offsetLeft: those are rounded to integers,
      // and on a page-zoomed layout the real boxes are fractional — the
      // rounding drift put the plate half a button off (Jeff 2026-08-20).
      const br = active.getBoundingClientRect(), sr = el.getBoundingClientRect();
      // Measured while hidden (the tucked topbar folds #models away): every
      // rect is zero and placing now bakes a ghost. The observer below
      // replays the moment the seg has a size again.
      if (!sr.width) return;
      cursor.style.opacity = "1";
      cursor.style.width = `${br.width}px`;
      cursor.style.transform = `translateX(${br.left - sr.left + el.scrollLeft}px)`;
    };
    el._segPlace = place;
    if (!el._segRo && window.ResizeObserver) {
      el._segRo = new ResizeObserver(() => el._segPlace && el._segPlace());
      el._segRo.observe(el);
    }
    // The altitude badge grows and folds by animation, and the cursor plate
    // measured mid-peek kept the wide width forever — the "elongated pill"
    // (Jeff 2026-08-21, twice). Re-place at both ends of any child animation.
    if (!el._segAnim) {
      el._segAnim = true;
      el.addEventListener("animationstart", () => requestAnimationFrame(() => el._segPlace && el._segPlace()));
      el.addEventListener("animationend", () => el._segPlace && el._segPlace());
    }
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
    // The first placement can measure before the display font arrives, and a
    // plate sized to fallback-font text sits half a button off. Re-measure
    // when the fonts land (and belt-and-braces, once more a beat later).
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => requestAnimationFrame(place));
    setTimeout(place, 600);
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

  const preferredWinterLayer = (avail) => WINTER_LAYER_PREFERENCE.find((l) => avail.includes(l)) || avail[0];
  function syncWinterUI() {
    document.body.classList.toggle("winter-mode", state.winterMode);
    const canonical = $("#winter-toggle");
    if (canonical) {
      canonical.classList.toggle("on", state.winterMode);
      canonical.setAttribute("aria-pressed", state.winterMode ? "true" : "false");
    }
    const railButton = document.querySelector('[data-rail="winter"]');
    if (railButton) {
      railButton.classList.toggle("on", state.winterMode);
      railButton.setAttribute("aria-pressed", state.winterMode ? "true" : "false");
    }
    $$(".base-row button").forEach((b) => b.classList.toggle("on", b.dataset.base === state.base));
    const terrain = $("#terrain-toggle"), resorts = $("#resorts-toggle"), avy = $("#avy-toggle");
    if (terrain) terrain.classList.toggle("on", state.terrain);
    if (resorts) resorts.classList.toggle("on", state.resorts);
    if (avy) avy.classList.toggle("on", state.avy);
  }
  function applyWinterMapState() {
    const apply = () => {
      WX.ov.setBase(state.base);
      if (state.terrain) WX.ov.loadTerrain(); else WX.ov.clearTerrain();
      if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts();
      if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy();
    };
    const styleExists = map && map.getStyle && (map.getStyle().layers || []).length;
    if (styleExists || (map && map.noMap)) apply();
    else if (map) map.once("style.load", apply);
  }
  function setWinterMode(on) {
    on = !!on;
    if (on === state.winterMode) return;
    if (on) {
      localStorage.setItem("wxgrid.winterReturn", JSON.stringify({
        layer: state.layer, base: state.base, terrain: state.terrain,
        resorts: state.resorts, avy: state.avy,
      }));
      state.winterMode = true;
      state.layer = preferredWinterLayer(runEntry().layers);
      state.base = "topo";
      state.terrain = true;
      state.resorts = true;
      state.avy = true;
    } else {
      let back = null;
      try { back = JSON.parse(localStorage.getItem("wxgrid.winterReturn") || "null"); } catch (_) { back = null; }
      state.winterMode = false;
      if (back) {
        state.layer = runEntry().layers.includes(back.layer) ? back.layer : runEntry().layers[0];
        state.base = ["", "topo", "sat", "streets"].includes(back.base) ? back.base : "";
        state.terrain = !!back.terrain;
        state.resorts = !!back.resorts;
        state.avy = !!back.avy;
      } else {
        // Be deterministic if storage was partially cleared while Winter mode
        // was active: returning to the normal map should actually return.
        state.layer = runEntry().layers.includes("wind") ? "wind" : runEntry().layers[0];
        state.base = "";
        state.terrain = false;
        state.resorts = false;
        state.avy = false;
      }
      localStorage.removeItem("wxgrid.winterReturn");
    }
    localStorage.setItem("wxgrid.winterMode", state.winterMode ? "1" : "0");
    localStorage.setItem("wxgrid.layer", state.layer);
    localStorage.setItem("wxgrid.base", state.base);
    localStorage.setItem("wxgrid.terrain", state.terrain ? "1" : "0");
    syncWinterUI();
    renderControls();
    applyStep();
    loadWind();
    applyWinterMapState();
    if (!state.resorts && state.resort) closePoint();
    toast(state.winterMode ? "Winter mode · snow, terrain, avalanche regions and resorts" : "Back to the full weather map", 3500);
  }

  function renderControls() {
    const ms = $("#models");
    // The selected model also says what it resolves. Only the selected one:
    // six grid figures across the top bar is noise, one is information.
    // Every model, always visible, flat — the AI-children fold was vetoed
    // (Jeff 2026-08-21: "go back to how it was"). A long row swipes/scrolls
    // sideways; it never hides members.
    renderSlidingSeg(ms, catalog.models.map((m) => {
      const on = m.key === state.model;
      const inView = modelInView(m);
      const enabled = m.runs.length && inView;
      const why = !m.runs.length ? "no ingested run" : !inView ? "map centre outside forecast domain" : "";
      return `<button data-model="${m.key}" class="${on ? "on" : ""}" ${enabled ? "" : "disabled"} title="${m.label}${m.grid ? ` · ${m.grid}` : ""}${why ? ` · ${why}` : ""}">${m.short}${on && m.grid ? `<i class="grid">${m.grid}</i>` : ""}</button>`;
    }).join(""));
    ms.querySelectorAll("button").forEach((b) => b.onclick = () => switchModel(b.dataset.model));

    // The run dropdown is retired (Jeff 2026-08-21: switching it "doesn't
    // seem to change anything" — the honest answer is that two runs six
    // hours apart usually LOOK identical, so the control read as broken).
    // The app always reads the newest run; the API still serves older ones.
    const rs = $("#run");
    rs.hidden = true;
    // Always the newest CONCRETE run id — never the string "latest": layer
    // URLs are cached immutable by the service worker, so a "latest" URL
    // would freeze the field at whatever it first showed.
    if (modelEntry().runs.length && !modelEntry().runs.some((r) => r.run === state.run)) { state.run = modelEntry().runs[0].run; clampStep(); }

    const rail = $("#layers");
    const avail = runEntry().layers;
    const fam = familyOf(state.layer);
    const shownFamilies = state.winterMode
      ? WINTER_FAMILY_ORDER.map((key) => FAMILIES.find((f) => f.key === key)).filter(Boolean)
      : FAMILIES;
    const winterSections = { snow: "Snow season", temp: "Mountain weather", tcc: "Cloud" };
    const railLabel = (full, phone = "") => phone
      ? `<span class="rail-label"><span class="rail-label-full">${full}</span><span class="rail-label-phone" aria-hidden="true">${phone}</span></span>`
      : `<span>${full}</span>`;
    const winterButton = `<button class="rail-flat rail-winter ${state.winterMode ? "on" : ""}" data-rail="winter" aria-label="Winter mode" aria-pressed="${state.winterMode ? "true" : "false"}" title="Show the snow-season map">${LAYER_ICON.sd_cm}${railLabel("Winter mode", "Winter")}</button>`;
    rail.innerHTML = shownFamilies.map((f) => {
      const ok = f.layers.some((l) => avail.includes(l));
      const on = f.key === fam.key;
      const section = state.winterMode ? winterSections[f.key] : f.section;
      return `${section ? `<div class="rail-sec">${section}</div>` : ""}<button class="${on ? "on" : ""}" data-family="${f.key}" aria-label="${f.label}" ${ok ? "" : "disabled"} title="${f.label}${ok ? "" : " (not in this model)"}">${LAYER_ICON[FAMILY_ICON[f.key]]}${railLabel(f.label, f.key === "ptype" ? "Precip" : "")}${f.variants ? `<i class="var">${f.variants[on ? state.layer : f.layers.find((l) => avail.includes(l)) || f.layers[0]] || ""}</i>` : ""}</button>${on && f.variants ? `<div class="rail-vars seg small" role="group" aria-label="${f.label} options">${f.layers.map((l) => `<button data-layer="${l}" class="${l === state.layer ? "on" : ""}" ${avail.includes(l) ? "" : "disabled"}>${f.variants[l]}</button>`).join("")}</div>` : ""}`;
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
        <span>Opacity</span><input type="range" min="20" max="100" step="5" value="${state.opacity}"><i>${state.opacity}%</i></label>
      <label class="rail-opacity rail-density" title="Particle density">
        <span>Density</span><input type="range" min="0" max="100" step="5" value="${state.particleDensity}"><i>${state.particleDensity}%</i></label>
      <div class="rail-seg rail-run" title="Forecast run (UTC)">
        <span>Model run</span>
        <select id="rail-run">${modelEntry().runs.map((r) => `<option value="${r.run}"${r.run === state.run ? " selected" : ""}>${r.run.slice(5, 10)} · ${r.run.slice(11)}Z</option>`).join("")}</select>
      </div>
      <div class="rail-sec rail-winter-sec">Season</div>
      ${winterButton}`;
    const railRun = rail.querySelector("#rail-run");
    railRun.onchange = () => switchRun(railRun.value);
    const railOp = rail.querySelector(".rail-opacity input");
    railOp.oninput = () => { setOpacity(Number(railOp.value)); };
    const density = rail.querySelector(".rail-density input");
    density.oninput = () => { setParticleDensity(Number(density.value)); };
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
    const railWinter = rail.querySelector('[data-rail="winter"]');
    if (railWinter) railWinter.onclick = () => $("#winter-toggle").click();
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
    // The same options under the active family in the rail: Rain's 24 h and
    // 72 h windows were only in the time bar, where nobody looked for them
    // (Jeff 2026-08-23).
    rail.querySelectorAll(".rail-vars button").forEach((b) => b.onclick = () => { state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer); localStorage.setItem("wxgrid.variant." + fam.key, state.layer); renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    // On a phone the rail is a sideways strip and re-rendering it resets the
    // scroll: pick Waves, and the rail snaps back to Wind with the chip you
    // just chose — and its variants — a thousand pixels off screen. Scroll the
    // rail itself, never scrollIntoView: that walks every scrollable ancestor
    // and drags the page sideways under an overflow:hidden body.
    const railOn = rail.querySelector("button[data-family].on");
    if (railOn && rail.scrollWidth > rail.clientWidth + 1) {
      const r = railOn.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      if (r.left < rr.left + 8 || r.right > rr.right - 8) {
        rail.scrollLeft += (r.left + r.width / 2) - (rr.left + rr.width / 2);
      }
    }
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
    renderTucked(showLevels);
    if (!showLevels && levels.length) {
      renderSlidingSeg(lv, [0, ...levels].map((l) => `<button data-level="${l}" class="${l === 0 ? "on" : ""}" disabled>${l || "sfc"}</button>`).join(""));
    }
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      // Native title tooltips show all three systems; the badge follows the
      // explicit pressure-level unit chosen in Settings.
      renderSlidingSeg(lv, opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" title="${l ? `${l} hPa · ${LEVEL_M[l]} · ${LEVEL_FEET[l]} · ${LEVEL_FT[l]}` : "surface · 10 m wind · 2 m temperature"}">${l ? `${l}${l === state.level ? `<i class="level-alt">${levelBadge(l)}</i>` : ""}` : "sfc"}</button>`).join(""));
      // The plate slides first, alone; the field swap (re-render, texture
      // upload, particle reseed) lands once it has stopped. Doing both in the
      // tap's frame made the slide stutter on a phone (Jeff 2026-09-05).
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => {
        const level = Number(b.dataset.level);
        if (level === state.level) return;
        state.level = level;
        // move the badge with the selection so the plate grows to its final
        // width in the same slide, instead of a second hitch when the badge
        // arrives with the deferred re-render (Jeff 2026-09-05)
        lv.querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === b); const alt = x.querySelector(".level-alt"); if (alt && x !== b) alt.remove(); });
        if (level && !b.querySelector(".level-alt")) b.insertAdjacentHTML("beforeend", `<i class="level-alt">${levelBadge(level)}</i>`);
        if (lv._segPlace) lv._segPlace();
        clearTimeout(levelApply);
        levelApply = setTimeout(() => { renderControls(); applyStep(false); loadWind(false); if (state.iso) WX.ov.loadIso(); }, LEVEL_SLIDE_MS);
      });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    // Dragging is continuous when the field layer can mix two steps, and the
    // release lands on a real one: the wind, the isobars and the tape all
    // belong to a step the model published, and a scrub that stopped between
    // them would leave the map ahead of everything else.
    slider.step = fieldLive() ? "0.02" : "1";
    slider.value = String(state.stepIdx + state.frac);
    slider.oninput = () => {
      const v = Number(slider.value), last = steps().length - 1;
      state.stepIdx = Math.min(last, Math.floor(v));
      state.frac = fieldLive() ? Math.min(0.999, v - state.stepIdx) : 0;
      applyStep(false);
    };
    slider.onchange = () => { settleStep(); applyStep(true); loadWind(); };

    renderLegend();
    if (!uiWired) { uiWired = true; wireOnce(); }
  }

  // Everything here binds once. It used to live at the tail of
  // renderControls, which runs on every model, level and layer change, so
  // every document listener stacked one copy per change: arrow keys stepped
  // twice, then three times, and the menu buttons toggled themselves shut.
  function wireOnce() {
    $("#play").onclick = togglePlay;
    // the minimized pill keeps a small play/pause of its own; it must not open the tape
    const pillPP = $("#tape-pill .pp"); if (pillPP) pillPP.onclick = (e) => { e.stopPropagation(); togglePlay(); };
    // Back to the present in one tap: scrubbing four days out and finding your
    // way home by dragging is the kind of thing a button fixes.
    $("#tape-now").onclick = () => { setStep(currentStepIdx()); WX.tape.renderTapeSelection(); };
    // The tape answers LEFT-RIGHT only. Mapping vertical wheel to time
    // steps lasted one day: an iPad trackpad's two-finger scroll fired it
    // continuously and the tape went haywire (Jeff 2026-08-20). Vertical
    // motion over the tape is now simply locked out, so the tape holds
    // still and horizontal swipes keep scrolling it natively.
    $("#timebar").addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.target.closest("input")) e.preventDefault();
    }, { passive: false });
    $("#tuck").onclick = () => setTucked(true);
    $("#tucked").onclick = () => setTucked(false);
    // A phone's search box is a third of the row; the long placeholder was
    // always cut mid-word.
    const fitPhone = () => {
      setTucked(localStorage.getItem("wxgrid.tucked") === "1", false);
    };
    fitPhone(); phoneMQ.addEventListener("change", fitPhone);
    // An upstream going dark used to announce itself only as a blank pane.
    // The wordmark wears a small amber dot instead; hover names the culprits.
    const health = async () => {
      try {
        const h = await WX.api(`${API}/health`);
        const brand = $(".brand");
        brand.classList.toggle("degraded", h.down.length > 0);
        brand.title = h.down.length ? `Not answering: ${h.down.join(", ")}` : "wxgrid";
      } catch (e) { /* the app itself being down needs no dot */ }
    };
    if (!window.WXStatic) { setTimeout(health, 15e3); setInterval(health, 300e3); }
    const tb = $("#timebar"), tmin = $("#tape-min");
    // Three states, because "collapsed" and "gone" are different wants: full
    // table, header only, or out of the way entirely with just its grip left.
    let tapeAnim = 0;
    const TAPE_ANIM_MS = 380;
    setTapeState = (s, persist = true) => {
      if (phoneMQ.matches && state.point) {
        if (persist) pointTapeReturn = null;
        focusMobileSheet(s === "full");
      }
      const prev = tapeState;
      tapeState = s;
      const apply = () => {
        tb.classList.toggle("mini", s === "mini");
        tb.classList.toggle("tape-away", s === "away");
      };
      // The fold used to CUT between heights. Glide instead: measure both
      // ends, clip the box, and slide — the row swap happens at the short
      // end of the glide where the eye is on motion, not content.
      // Every change of state glides, away included (it used to cut for
      // anything but full<->mini, and cut again whenever the tape had been
      // hand-sized — the "major transitions" that still jumped, Jeff
      // 2026-09-02). Measure both ends, run the height, swap the pinned class
      // in at the end. A hand-set height is kept as an inline style and comes
      // back when the tape returns to full.
      const animatable = prev !== s && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      const pinned = s === "mini" || s === "away";
      if (animatable) {
        clearTimeout(tapeAnim);
        const from = tb.getBoundingClientRect().height;
        const sized = tb.style.height;           // a hand-set height, if any
        tb.style.height = "";
        apply();
        const to = tb.getBoundingClientRect().height;
        // .mini/.tape-away pin height with !important, so the glide runs
        // WITHOUT the class and swaps it in at the end; going to full the
        // class state is already right and the box just opens onto the rows.
        // The box glides on --tape-anim-h (which .tape-anim lets override the
        // pinned heights), so the content classes can stay honest during the
        // slide: leaving or entering mini keeps the compact rows on screen
        // instead of flashing the full table for 380 ms (Jeff 2026-09-04,
        // "small to fully minimized still not smooth"). Away swaps in at the
        // end, once the box is down to pill height.
        if (s === "away") { tb.classList.remove("tape-away"); if (prev === "mini") tb.classList.add("mini"); }
        // Commit the restored classes before the transition switches on.
        // Measuring `to` left a 38 px height in the last computed style, and
        // with the transition live the box would animate 38 → from and then
        // retarget to 38: a snap. A plain reflow here resets the start value.
        tb.getBoundingClientRect();
        tb.classList.add("tape-anim");
        tb.classList.toggle("tape-anim-away", s === "away");
        tb.style.setProperty("--tape-anim-h", from + "px");
        tb.getBoundingClientRect();
        tb.style.setProperty("--tape-anim-h", (s === "full" && sized ? parseFloat(sized) : to) + "px");
        // the pill fades in over the last third of the glide so box and pill
        // read as one motion rather than a slide, a stop, then a pop
        if (s === "away") setTimeout(() => { const pill = $("#tape-pill"); if (pill && tapeState === "away") pill.hidden = false; }, TAPE_ANIM_MS * 0.6);
        tapeAnim = setTimeout(() => {
          tb.classList.remove("tape-anim", "tape-anim-away");
          tb.style.removeProperty("--tape-anim-h");
          tb.style.height = s === "full" && sized ? sized : "";
          if (s === "away") { tb.classList.remove("mini"); tb.classList.add("tape-away"); }
          const pill = $("#tape-pill");
          if (pill) pill.hidden = s !== "away";
          document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px");
          if (WX.fn.fitStrip) WX.fn.fitStrip();
          restoreSheetHeight();
          restorePointPanelSize();
        }, TAPE_ANIM_MS);
      } else apply();
      // the pill appears when the glide lands (above); leaving away it goes at once
      const pill = $("#tape-pill");
      if (pill && (s !== "away" || !animatable)) pill.hidden = s !== "away";
      if (persist) localStorage.setItem("wxgrid.tapeState", s);
      const nextAction = s === "full" ? "Show compact forecast" : s === "mini" ? "Hide forecast timeline" : "Show full forecast";
      tmin.title = nextAction; tmin.setAttribute("aria-label", nextAction);
      requestAnimationFrame(() => document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px"));
    };
    const savedState = localStorage.getItem("wxgrid.tapeState")
      || (localStorage.getItem("wxgrid.tapeMini") === "1" ? "mini" : "full");
    setTapeState(["full", "mini", "away"].includes(savedState) ? savedState : "full", false);
    // One control walks the three states: full → header → away → full.
    // "Collapse completely" was only reachable by dragging the grip past a
    // hidden threshold, which read as broken (Jeff 2026-09-02).
    tmin.onclick = () => setTapeState(nextTapeState());
    const pillBtn = $("#tape-pill");
    if (pillBtn) pillBtn.onclick = () => setTapeState("full");
    // the crosshair button map apps have: centre here and open the card
    const goToMe = () => {
      if (!navigator.geolocation) { toast("This browser has no location service", 4000, "error"); return; }
      $("#locate-btn").classList.add("on");
      navigator.geolocation.getCurrentPosition(
        (pos) => { $("#locate-btn").classList.remove("on"); map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 8), duration: 900 }); openPoint(pos.coords.latitude, pos.coords.longitude); },
        () => { $("#locate-btn").classList.remove("on"); toast("Location blocked for this site", 5000, "error"); },
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
    $("#share-btn").onclick = shareLink;
    $("#point-share").onclick = shareLink;
    const openSettings = (e) => {
      const opener = e.currentTarget.closest(".menu")?.querySelector(".menu-btn") || e.currentTarget;
      $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(opener);
    };
    $("#settings-btn").onclick = openSettings;
    $("#keys-btn").onclick = openSettings;
    // a unit change repaints every number on screen at once
    document.addEventListener("wx-units", () => { renderControls(); renderLegend(); renderPoint(); WX.tape.renderTape(); if (WX.probe) WX.probe.hover(null); if (state.xsection && WX.xs) WX.xs.refresh(); $("#units-toggle").querySelector(".val").textContent = speedUnit(); });
    $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    $("#radar-toggle").onclick = () => WX.ov.toggleRadar();
    $$(".base-row button").forEach((b) => b.onclick = () => {
      const wasStreets = state.base === "streets";
      state.base = b.dataset.base; localStorage.setItem("wxgrid.base", state.base);
      $$(".base-row button").forEach((x) => x.classList.toggle("on", x === b));
      if (state.base === "streets" || wasStreets) {
        // a style swap, the way a theme change is one
        map.setStyle(mapStyle(), { diff: false });
        map.once("style.load", restoreLayers);
        map.once("idle", () => { if (!map.getSource("wx")) restoreLayers(); });
      }
      WX.ov.setBase(state.base);
    });
    $$(".base-row button").forEach((x) => x.classList.toggle("on", x.dataset.base === state.base));
    if (state.base) WX.ov.setBase(state.base);
    $("#terrain-toggle").onclick = () => { state.terrain = !state.terrain; localStorage.setItem("wxgrid.terrain", state.terrain ? "1" : "0"); $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain(); else WX.ov.clearTerrain(); };
    $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain();
    $("#night-toggle").onclick = () => { state.night = !state.night; $("#night-toggle").classList.toggle("on", state.night); if (state.night) WX.ov.updateNight(); else WX.ov.clearNight(); };
    const pt = $("#probe-toggle");
    if (pt) {
      pt.classList.toggle("on", state.probeChip);
      pt.setAttribute("aria-pressed", state.probeChip ? "true" : "false");
      pt.onclick = () => { state.probeChip = !state.probeChip; localStorage.setItem("wxgrid.probe", state.probeChip ? "1" : "0"); pt.classList.toggle("on", state.probeChip); pt.setAttribute("aria-pressed", state.probeChip ? "true" : "false"); if (!state.probeChip && WX.probe) WX.probe.hover(null);
        // the strip carries the same switch; toggling either must light both
        const sp = document.querySelector(".strip-probe");
        if (sp) { sp.classList.toggle("on", state.probeChip); sp.setAttribute("aria-pressed", state.probeChip ? "true" : "false"); } };
    }
    $("#alerts-toggle").onclick = () => { state.alerts = !state.alerts; $("#alerts-toggle").classList.toggle("on", state.alerts); if (state.alerts) WX.ov.loadAlerts(); else WX.ov.clearAlerts(); };
    $("#storms-toggle").onclick = () => { state.storms = !state.storms; $("#storms-toggle").classList.toggle("on", state.storms);
      // storm positions are "now"; the particles must be too, or the wind
      // field and the eye disagree on where the storm is
      if (state.storms) { if (state.stepIdx !== currentStepIdx()) setStep(currentStepIdx()); WX.ov.loadStorms(); } else WX.ov.clearStorms(); };
    $("#sat-toggle").onclick = () => { state.sat = !state.sat; $("#sat-toggle").classList.toggle("on", state.sat); if (state.sat) { clearOtherCover("sat"); WX.ov.loadSat(); } else WX.ov.clearSat(); };
    for (const [k, load, clear] of [["smoke", "loadSmoke", "clearSmoke"], ["quakes", "loadQuakes", "clearQuakes"], ["aod", "loadAod", "clearAod"], ["thunder", "loadThunder", "clearThunder"], ["obs", "loadObs", "clearObs"]]) {
      $(`#${k}-toggle`).onclick = () => { state[k] = !state[k]; $(`#${k}-toggle`).classList.toggle("on", state[k]);
        if (state[k]) { if (k === "smoke" || k === "aod") clearOtherCover(k); WX.ov[load](true); } else WX.ov[clear](); };
    }
    $("#theme-toggle").onclick = () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme; };
    $("#route-toggle").onclick = () => {
      if (!WX.route) { toast("Route forecast is not in this build", 4000, "error"); return; }
      const on = !state.route; state.route = on; $("#route-toggle").classList.toggle("on", on);
      if (on) WX.route.start(); else WX.route.stop();
    };
    $("#xsection-toggle").onclick = () => { if (!WX.xs) { toast("Cross section is still loading", 2500); return; } const on = !state.xsection; $("#xsection-toggle").classList.toggle("on", on); if (on) WX.xs.start(); else WX.xs.stop(); };
    $("#measure-toggle").onclick = () => { state.measure = !state.measure; $("#measure-toggle").classList.toggle("on", state.measure); $("#measure-toggle").querySelector(".val").textContent = state.measure ? "on" : "off"; if (!state.measure) WX.ov.clearMeasure(); else toast("Tap two points to measure."); };
    $("#iso-toggle").onclick = () => { state.iso = !state.iso; localStorage.setItem("wxgrid.iso", state.iso ? "1" : "0"); $("#iso-toggle").classList.toggle("on", state.iso); if (state.iso) WX.ov.loadIso(); else WX.ov.clearIso(); };
    // Isolines come back the way you left them (Jeff 2026-08-21). Deferred
    // to map load: loadIso adds a source, and the style may still be inbound.
    const restoreIso = () => { if (localStorage.getItem("wxgrid.iso") === "1" && !state.iso) $("#iso-toggle").click(); };
    if (map && map.isStyleLoaded && map.isStyleLoaded()) restoreIso(); else if (map) map.once("load", restoreIso);
    $("#winter-toggle").onclick = () => setWinterMode(!state.winterMode);
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts(); };
    syncWinterUI();
    if (state.winterMode) applyWinterMapState();
    $("#locate").onclick = goToMe;
    $("#point-close").onclick = closePoint;
    wireSheet();
    $("#point-fav").onclick = () => { if (!state.point) return; const on = WX.search.toggleFav(state.point.lat, state.point.lon, state.point.name); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; toast(on ? "Saved to search" : "Removed", 2500); };
    WX.search.wireSearch();
    const toggleMenu = (b) => { const m = b.parentElement; const open = m.classList.contains("open"); $$(".menu.open").forEach((x) => x.classList.remove("open")); if (!open) m.classList.add("open"); };
    // iOS Safari was swallowing taps on these two buttons (the only top-bar
    // controls that are icon-only inside a pointer-events:none bar). Answer
    // the touch itself and cancel the click it would have synthesised.
    $$(".menu .menu-btn").forEach((b) => {
      let touched = 0;
      b.addEventListener("touchend", (e) => { touched = Date.now(); e.preventDefault(); toggleMenu(b); }, { passive: false });
      b.onclick = (e) => { e.stopPropagation(); if (Date.now() - touched < 700) return; toggleMenu(b); };
    });
    // menu buttons show a tick when any of their toggles is on
    new MutationObserver(() => $$(".menu").forEach((m) => m.querySelector(".menu-btn").classList.toggle("has-on", !!m.querySelector(".menu-pop .chip.on:not(#particles-toggle):not(#barbs-toggle)")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
    const closeMenusOutside = (e) => { if (!e.target.closest(".menu")) $$(".menu.open").forEach((x) => x.classList.remove("open")); };
    document.addEventListener("click", closeMenusOutside);
    document.addEventListener("touchend", closeMenusOutside, { passive: true });
    $$(".point-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderPoint(); });
    document.addEventListener("keydown", (e) => {
      if (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "Escape" && $("#tstrip").classList.contains("more-open")) {
        $("#tstrip").classList.remove("more-open"); fitStrip(); $("#strip-more").focus(); return;
      }
      if (e.target.closest("button, summary, #strip-more-pop") && [" ", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "Escape") { closePoint(); WX.search.hideResults(); $$(".menu.open").forEach((x) => x.classList.remove("open")); }
      else if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
      else if (e.key === "l" || e.key === "L") { $("#overlays-menu").classList.toggle("open"); }
      else if (e.key === "n" || e.key === "N") { setStep(currentStepIdx()); WX.tape.renderTapeSelection(); }
      else if (e.key === "?") { WX.settings.open(); }
      else if (e.key >= "1" && e.key <= "9") {                 // 1-9 pick a layer
        const btns = $$(".rail button[data-family]:not(:disabled)");
        const b = btns[Number(e.key) - 1]; if (b) b.click();
      } else if (e.key === "[" || e.key === "]") {             // walk the altitude
        const opts = $$("#levels button:not(:disabled)");
        const k = opts.findIndex((b) => b.classList.contains("on"));
        const next = opts[k + (e.key === "]" ? 1 : -1)]; if (k >= 0 && next) next.click();
      }
    });
  }

  // Desktop tool strip: icon proxies for the toggles that live in the topbar
  // menus. Clicking proxies the real button; the observer below mirrors state.
  const STRIP = [
    ["winter", "Winter mode"], null,
    ["radar", "Radar"], ["sat", "Satellite"], ["aurora", "Aurora"], ["aod", "Aerosol"], ["iso", "Isolines"], null,
    ["alerts", "Alerts", "warn"], ["storms", "Storms", "warn"], ["thunder", "Thunder", "warn"], ["sigmet", "SIGMET", "warn"], null,
    ["fires", "Fires", "warn"], ["smoke", "Smoke"], null,
    ["aq", "Air quality"], ["quakes", "Quakes"], ["obs", "Stations"], null,
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
    // Keep one canonical settings action, just like every other strip proxy.
    // The strip is built before the menu handlers are wired, but the proxy
    // resolves the menu button at click time after wiring has completed.
    $("#strip-settings").onclick = () => $("#settings-btn").click();
    // the crosshair is part of the strip on desktop, so the two can never
    // collide the way a floating button did. It goes at the HEAD of the strip
    // and is exempt from fitStrip's trim: appended last it was the first thing
    // the overflow exiled, so "my location" lived in the ⋮ flyout on every
    // screen where the strip did not fit (Jeff 2026-08-25: "pin to my location
    // should be on the outside rather than hiding in the three-dot menu").
    // At the foot of the strip with settings, not the head: a locate button
    // above twenty overlay toggles read as one of them and went unfound
    // (Jeff 2026-09-02: "kinda hiding up there").
    st.insertAdjacentHTML("beforeend", `<div class="sep strip-locate-sep"></div><button class="strip-locate" data-tip="My location" aria-label="My location">${$("#locate-btn").innerHTML}</button>`);
    st.querySelector(".strip-locate").onclick = () => $("#locate-btn").click();
    // Reading a value off the map is the other thing people come to a weather
    // map to do, and its switch was buried in the same flyout — the feature
    // reads as missing when you cannot find the toggle (Jeff 2026-08-25: "the
    // feature where u can toggle data card on hover ... never implemented").
    // Same treatment: head of the strip, never trimmed, state mirrored so the
    // strip and the menu can never disagree about whether it is on.
    const pt0 = $("#probe-toggle");
    if (pt0) {
      st.insertAdjacentHTML("afterbegin", `<button class="strip-probe" data-tip="Show value under cursor" aria-label="Show value under cursor" aria-pressed="false">${pt0.querySelector("svg").outerHTML}</button>`);
      const sp = st.querySelector(".strip-probe");
      const syncProbe = () => {
        const on = !!state.probeChip;
        sp.classList.toggle("on", on);
        sp.setAttribute("aria-pressed", on ? "true" : "false");
      };
      sp.onclick = () => { pt0.click(); syncProbe(); };
      syncProbe();
    }
    // overflow flyout: the strip stays fixed, the extras animate out beside it
    st.insertAdjacentHTML("beforeend", `<button id="strip-more" data-tip="More layers and tools" aria-label="More" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>`);
    document.body.insertAdjacentHTML("beforeend", '<div id="strip-more-pop" class="tstrip strip-pop" inert></div>');
    $("#strip-more").onclick = (e) => { e.stopPropagation(); st.classList.toggle("more-open"); fitStrip(); positionMorePop(); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#tstrip") && !e.target.closest("#strip-more-pop") && st.classList.contains("more-open")) { st.classList.remove("more-open"); fitStrip(); } });
    fitStrip();
    addEventListener("resize", () => { if (!pageIsPinchZoomed()) fitStrip(); });
    new MutationObserver(fitStrip).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
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
  // A guard that only SKIPS during a pinch leaves everything stale when the
  // pinch never quite returns to 1.0 (iOS parks at 1.03 happily) — that is
  // how the card grew past the screen top and lost its close button. Defer
  // instead: run now if unpinched, or the moment the pinch settles.
  let unpinchWait = 0;
  const whenUnpinched = (fn) => {
    if (!pageIsPinchZoomed()) { fn(); return; }
    clearInterval(unpinchWait);
    unpinchWait = setInterval(() => { if (!pageIsPinchZoomed()) { clearInterval(unpinchWait); fn(); } }, 400);
  };

  function wireSheet() {
    const grip = $(".sheet-grip"), card = $("#point");
    if (!grip) return;
    // The phone card is a sheet you size with your thumb: the drag sets its
    // height directly and keeps it, rather than snapping to two fixed stops.
    // Pulling it below the minimum still closes it.
    // visualViewport is what the reader can actually see; innerHeight on iOS
    // still counts the strip behind Safari's toolbars, and a card sized to that
    // hides its own header — and its close button — off the top.
    const viewH = () => {
      // While pinch-zoomed, visualViewport.height is the MAGNIFIED slice, not
      // the layout viewport — clamping to it sized cards to a fiction. Use
      // height×scale (≈ layout height) so the clamp stays honest mid-pinch.
      const vv = window.visualViewport;
      if (!vv) return innerHeight;
      return Math.round(Math.min(vv.height * (vv.scale || 1), innerHeight || 1e9));
    };
    const bounds = () => {
      const cs = getComputedStyle(document.documentElement);
      const top = parseFloat(cs.getPropertyValue("--top-h")) || 52;
      // The card lives ABOVE the tape (bottom: --tb-h + 10), so the tape's
      // height is part of the budget. Ignoring it let a maximised tape shove
      // the card's head — and its × — off the top of the screen.
      const tbH = parseFloat(cs.getPropertyValue("--tb-h")) || 120;
      // min is the PEEK: name, temperature and the sentence, map above it
      return { min: 128, max: Math.max(200, viewH() - top - tbH - 24) };
    };
    const stored = Number(localStorage.getItem("wxgrid.sheetHeight")) || 0;
    let y0 = 0, dy = 0, startH = 0, dragging = false, closing = false, height = stored;
    let peeking = false, expandedHeight = stored, expandedTab = null;
    const setHeight = (h, persist) => {
      const b = bounds();
      height = Math.max(b.min, Math.min(b.max, Math.round(h)));
      card.style.height = `${height}px`;
      card.classList.add("sheet-sized");
      // below this the tabs and telemetry stop pretending: hero only
      card.classList.toggle("sheet-peek", height < 190);
      if (persist) localStorage.setItem("wxgrid.sheetHeight", String(height));
      return height;
    };
    restoreSheetHeight = () => {
      if (innerWidth > 820) { card.style.height = ""; card.classList.remove("sheet-sized", "sheet-peek"); return; }
      if (height) setHeight(height, false);
    };
    focusMobileSheet = (peek) => {
      if (innerWidth > 820) return;
      if (peek && !peeking) { expandedHeight = height; expandedTab = state.tab; state.tab = "now"; }
      if (!peek && peeking && expandedTab) { state.tab = expandedTab; expandedTab = null; }
      peeking = peek;
      setHeight(peek ? 170 : expandedHeight || Math.round(viewH() * 0.52), false);
      if (state.point && state.point.data) renderPoint();
    };
    // While the thumb is down the card is laid out ONCE at its ceiling and
    // slid with a transform; the real height lands on release. Setting the
    // height per move re-laid-out the whole card each frame (Jeff 2026-09-05).
    let dragMax = 0, dragH = 0;
    const track = perFrame((clientY) => {
      if (!dragging) return;
      dy = clientY - y0;
      const b = bounds();
      closing = startH - dy < b.min - 64;
      card.style.opacity = closing ? ".62" : "";
      dragH = Math.max(b.min, Math.min(dragMax, Math.round(startH - dy)));
      card.style.transform = `translateY(${dragMax - dragH}px)`;
    });
    let openedFromPeek = false;
    grip.addEventListener("pointerdown", (e) => {
      if (innerWidth > 820) return;
      openedFromPeek = tapeState === "full";
      if (tapeState === "full") setTapeState("mini", false);
      dragging = true; y0 = e.clientY; dy = 0; closing = false;
      startH = card.getBoundingClientRect().height;
      dragMax = bounds().max; dragH = startH;
      card.classList.add("sheet-drag");
      card.style.height = `${dragMax}px`; card.classList.add("sheet-sized");
      card.style.transform = `translateY(${dragMax - startH}px)`;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => { if (dragging) track(e.clientY); });
    const end = (cancel) => {
      if (!dragging) return;
      dragging = false; card.style.opacity = "";
      card.style.transform = "";
      setHeight(cancel ? startH : dragH, false);   // the one real layout of the drag
      card.classList.remove("sheet-drag");
      if (!cancel && closing) { closePoint(); return; }
      if (!cancel && Math.abs(dy) < 6) {                    // a tap cycles peek → half → full
        if (openedFromPeek) return;
        const b = bounds();
        setHeight(height < 190 ? Math.round(b.max * 0.5) : height < b.max - 40 ? b.max : b.min, true);
        expandedHeight = height;
        return;
      }
      localStorage.setItem("wxgrid.sheetHeight", String(height));
      expandedHeight = height;
    };
    grip.addEventListener("pointerup", () => end(false));
    grip.addEventListener("pointercancel", () => end(true));
    addEventListener("resize", () => whenUnpinched(restoreSheetHeight));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => whenUnpinched(restoreSheetHeight));
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
    // Measure the full, unsized tape itself. scrollHeight cannot answer this
    // once flex has stretched the tape: it simply reports the already-wrong
    // tall box and lets every drag ratchet the maximum higher.
    const tapeContentMax = () => {
      const t = tb.querySelector(".tape");
      if (!t || !t.firstElementChild || t.querySelector(".tape-empty")) return Infinity;
      const classes = tb.className, style = tb.getAttribute("style");
      const pill = $("#tape-pill"), pillHidden = pill ? pill.hidden : true;
      tb.classList.remove("mini", "tape-away", "user-sized", "tape-dragging", "tape-anim", "tape-anim-away");
      tb.style.height = "auto"; tb.style.removeProperty("--tape-drag-height");
      if (pill) pill.hidden = true;
      const height = Math.ceil(tb.getBoundingClientRect().height) + 1;
      tb.className = classes;
      if (style == null) tb.removeAttribute("style"); else tb.setAttribute("style", style);
      if (pill) pill.hidden = pillHidden;
      return height;
    };
    const tapeMaxHeight = (bounds = tapeBounds()) => Math.max(bounds.min, Math.min(bounds.max, tapeContentMax()));
    const setTapeHeight = (height, persist = false, measuredMax = null) => {
      const bounds = tapeBounds();
      const maxH = measuredMax == null ? tapeMaxHeight(bounds) : measuredMax;
      tapeHeight = clamp(Math.round(height), bounds.min, maxH);
      tb.style.height = `${tapeHeight}px`; tb.classList.add("user-sized");
      tapeGrip.setAttribute("aria-valuemin", bounds.min); tapeGrip.setAttribute("aria-valuemax", Math.round(maxH)); tapeGrip.setAttribute("aria-valuenow", tapeHeight);
      if (persist) localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
    };
    const resetTapeHeight = () => {
      tapeHeight = null; localStorage.removeItem("wxgrid.tapeHeight");
      tb.style.height = ""; tb.classList.remove("user-sized");
      requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    };
    if (tapeHeight) setTapeHeight(tapeHeight);
    else requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    // The tape is populated after these controls are wired. Clamp an old
    // persisted over-height as soon as a forecast/radar render arrives.
    let contentClampFrame = 0;
    new MutationObserver(() => {
      if (contentClampFrame) return;
      contentClampFrame = requestAnimationFrame(() => {
        contentClampFrame = 0;
        if (tapeState !== "full" || document.body.classList.contains("resizing-tape") || tb.classList.contains("tape-anim")) return;
        const maxH = tapeMaxHeight();
        tapeGrip.setAttribute("aria-valuemax", Math.round(maxH));
        if (!tapeHeight) tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height));
        else if (tapeHeight > maxH) setTapeHeight(tapeHeight, true, maxH);
      });
    }).observe(tb.querySelector(".tape"), { childList: true, subtree: true });
    let tapeDrag = null, suppressGripClickUntil = 0;
    const TAPE_AWAY_HEIGHT = 38, TAPE_TAP_SLOP = 14;
    const tapeTargetState = (height) => {
      const min = tapeBounds().min;
      return height <= Math.round((TAPE_AWAY_HEIGHT + min) / 2) ? "away" : height < min ? "mini" : "full";
    };
    // Follow the pointer continuously all the way to the 38 px away state.
    // Switching classes at two hidden thresholds made the last leg jump from
    // a compact table to a pill while the finger was still moving. During a
    // drag this is one clipped surface; the semantic state is chosen once,
    // on release, then the existing glide finishes the small remainder.
    // The drag never changes layout. The box is laid out ONCE at its ceiling
    // (--tape-drag-height = max) and the pointer moves it with a transform:
    // its top edge sits `want` px above the bottom, the rest slides under the
    // screen edge. The sheet and the locate button ride the same transform.
    // Writing the height per frame reflowed the forecast table and every
    // --tb-h dependant on each move — the "steppy" drag on a phone
    // (Jeff 2026-09-05, "it's dogged us forever").
    const riders = () => [$("#point"), $(".locate-btn")].filter(Boolean);
    const previewTapeDrag = (clientY) => {
      if (!tapeDrag) return;
      tapeDrag.lastY = clientY;
      tapeDrag.want = clamp(tapeDrag.height + tapeDrag.y - clientY, TAPE_AWAY_HEIGHT, tapeDrag.max);
      if (tapeDrag.from === "away" && tapeDrag.want > TAPE_AWAY_HEIGHT + 4) {
        tb.classList.remove("tape-away"); tb.classList.add("mini");
        const pill = $("#tape-pill"); if (pill) pill.hidden = true;
      }
      tb.style.transform = `translateY(${(tapeDrag.max - tapeDrag.want).toFixed(2)}px)`;
      const rise = tapeDrag.want - tapeDrag.height;
      for (const el of riders()) el.style.transform = `translateY(${(-rise).toFixed(2)}px)`;
      tapeGrip.setAttribute("aria-valuenow", Math.round(tapeDrag.want));
    };
    const clearTapeDragTransforms = () => {
      tb.style.transform = "";
      for (const el of riders()) { el.style.transform = ""; el.classList.remove("tape-riding"); }
    };
    const trackTape = perFrame(previewTapeDrag);
    const restoreTapeDragStart = (drag) => {
      clearTapeDragTransforms();
      tb.classList.remove("tape-dragging"); tb.style.removeProperty("--tape-drag-height");
      tb.classList.toggle("mini", drag.from === "mini");
      tb.classList.toggle("tape-away", drag.from === "away");
      tb.style.height = drag.inlineHeight;
      const pill = $("#tape-pill"); if (pill) pill.hidden = drag.from !== "away";
      document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px");
    };
    tapeGrip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const h0 = tb.getBoundingClientRect().height;
      const maxH = tapeMaxHeight();
      tapeGrip.setAttribute("aria-valuemax", Math.round(maxH));
      tapeDrag = { id: e.pointerId, y: e.clientY, lastY: e.clientY, height: h0, want: h0,
        max: maxH, distance: 0, from: tapeState, inlineHeight: tb.style.height };
      tb.style.setProperty("--tape-drag-height", `${maxH.toFixed(2)}px`);
      tb.style.transform = `translateY(${(maxH - h0).toFixed(2)}px)`;
      for (const el of riders()) el.classList.add("tape-riding");
      tapeGrip.setPointerCapture(e.pointerId); tb.classList.add("is-resizing", "tape-dragging"); document.body.classList.add("resizing-tape");
    });
    tapeGrip.addEventListener("pointermove", (e) => {
      if (!tapeDrag || e.pointerId !== tapeDrag.id) return;
      const samples = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const sample = samples && samples.length ? samples[samples.length - 1] : e;
      tapeDrag.distance = Math.max(tapeDrag.distance, Math.abs(sample.clientY - tapeDrag.y));
      tapeDrag.lastY = sample.clientY; trackTape(sample.clientY);
    });
    const finishTape = (e, cancelled = false) => {
      if (!tapeDrag || (e && e.pointerId !== tapeDrag.id)) return;
      const drag = tapeDrag;
      if (e && Number.isFinite(e.clientY)) {
        drag.distance = Math.max(drag.distance, Math.abs(e.clientY - drag.y));
        drag.lastY = e.clientY;
      }
      const tap = !cancelled && drag.distance < TAPE_TAP_SLOP;
      if (!tap && !cancelled) previewTapeDrag(drag.lastY); // do not lose the last pre-RAF move
      tapeDrag = null; tb.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
      suppressGripClickUntil = Date.now() + 500;
      if (cancelled) {
        restoreTapeDragStart(drag);
      } else if (tap) {
        restoreTapeDragStart(drag);
        setTapeState(nextTapeState());
      } else {
        const visualHeight = drag.want;          // the box is at its ceiling; `want` is what the eye saw
        const target = tapeTargetState(drag.want);
        // Land the real layout at exactly the release height (one reflow)
        // while setTapeState measures the other end. Removing the drag class
        // first without this explicit height was the remaining mini → away snap.
        clearTapeDragTransforms();
        tb.classList.remove("tape-dragging", "mini", "tape-away");
        tb.style.removeProperty("--tape-drag-height");
        tb.style.height = `${visualHeight}px`;
        document.documentElement.style.setProperty("--tb-h", `${visualHeight}px`);
        const pill = $("#tape-pill"); if (pill) pill.hidden = true;
        if (target === "full") {
          setTapeHeight(drag.want, true, drag.max);
          setTapeState("full");
        } else {
          const unchanged = target === tapeState;
          setTapeState(target);
          if (unchanged) tb.style.height = "";
        }
      }
      if (tapeHeight && tapeState === "full") localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      restoreSheetHeight();                    // the card re-budgets around the new tape
      restorePointPanelSize();
    };
    tapeGrip.addEventListener("pointerup", (e) => finishTape(e, false));
    tapeGrip.addEventListener("pointercancel", (e) => finishTape(e, true));
    tapeGrip.addEventListener("lostpointercapture", (e) => { if (tapeDrag) finishTape(e, false); });
    // Pointer-up handles real taps. This is the keyboard/synthetic-click
    // fallback; the short suppression window prevents one physical tap from
    // walking two states when the browser also synthesises click.
    tapeGrip.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (Date.now() < suppressGripClickUntil) return;
      setTapeState(nextTapeState());
    });
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
      // On a phone the sheet owns the height; clearing it here was wiping the
      // user's sheet size every time the tape resized (the timebar observer
      // calls this). Clear only the desktop sizing and hand back to the sheet.
      if (innerWidth <= 820) { card.style.width = ""; card.classList.remove("user-sized"); restoreSheetHeight(); return; }
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
    addEventListener("resize", () => whenUnpinched(() => { if (tapeHeight) setTapeHeight(tapeHeight); restorePointPanelSize(); }));
  }

  // Keep the pinned rail in bounds; the complete named list can scroll.
  function fitStrip() {
    if (WX.toolstrip) WX.toolstrip.fit();
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
    state.frac = 0;
    // Keep the VALID time, not the step index: comparing models means the same moment.
    if (WX.tape) WX.tape.clearFineSelection();
    state.model = key; localStorage.setItem("wxgrid.model", key);
    state.run = modelEntry().runs[0].run;
    if (!runEntry().layers.includes(state.layer)) state.layer = state.winterMode ? preferredWinterLayer(runEntry().layers) : runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  // Same job as switchModel, one model: hold the valid time, swap the run.
  function switchRun(runId, target = validDate().getTime()) {
    state.frac = 0;
    if (!modelEntry().runs.some((r) => r.run === runId) || runId === state.run) return;
    if (WX.tape) WX.tape.clearFineSelection();
    state.run = runId;
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  // Round the sub-step position away onto the nearer real step. Everything
  // except the field layer works in whole steps, so this is what a scrub, a
  // model change and the end of a playback loop all come back to.
  function settleStep() {
    if (!state.frac) return;
    state.stepIdx = Math.min(steps().length - 1, state.stepIdx + Math.round(state.frac));
    state.frac = 0;
    const slider = $("#step");
    if (slider) slider.value = String(state.stepIdx);
  }
  function currentStepIdx() {
    const ms = Date.now(), valid = steps().map((h) => runDate().getTime() + h * 3600e3);
    let best = 0;
    valid.forEach((t, k) => { if (Math.abs(t - ms) < Math.abs(valid[best] - ms)) best = k; });
    return best;
  }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; WX.ov.applyRadarFrame(); return; }
    if (WX.tape) WX.tape.clearFineSelection();
    state.frac = 0;
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso();
  }
  function setStep(i) { if (WX.tape) WX.tape.clearFineSelection(); state.frac = 0; state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); }

  // Valid time, lead time, and whether the map is sitting on the present.
  // Split out of applyStep because a glide between two steps redraws this
  // sixty times a second and nothing else.
  const selectedLayerName = () => (LAYER_LABEL[state.layer] || state.layer)
    + (state.level && hasLevel() ? ` ${state.level}${/^\d+$/.test(String(state.level)) ? " hPa" : ""}` : "");

  function renderTapePill() {
    const pill = $("#tape-pill"); if (!pill) return;
    const local = $("#valid-local");
    const time = local ? local.textContent.split(" · ")[0] : "";
    const off = $("#tape-now .off");
    const status = off ? off.textContent : "Now";
    const field = state.radar ? "Radar" : selectedLayerName();
    let reading = null;
    if (state.radar) {
      reading = state.radarSource && state.radarSource.label ? { text: state.radarSource.label, sub: "" } : null;
    } else if (WX.probe && WX.probe.valueAt && map) {
      try { const c = map.getCenter(); reading = WX.probe.valueAt(c.lng, c.lat); } catch (_) { reading = null; }
    }
    const put = (sel, value) => { const el = pill.querySelector(sel); if (el) el.textContent = value || ""; };
    put(".t", time); put(".status", status); put(".field", field);
    const st = pill.querySelector(".status"); if (st) st.classList.toggle("away", status !== "Now");   // red offset, same as the Now pill
    const value = pill.querySelector(".value"), sub = pill.querySelector(".sub");
    if (value) { value.textContent = reading && reading.text || ""; value.hidden = !(reading && reading.text); }
    if (sub) { sub.textContent = reading && reading.sub || ""; sub.hidden = !(reading && reading.sub); }
    pill.setAttribute("aria-label", ["Show forecast timeline", time, status, field,
      reading && reading.text, reading && reading.sub].filter(Boolean).join(", "));
  }

  function renderClock() {
    const v = validDate();
    // the phone row has room for the weekday and the hour; the date is the UTC line under it
    const narrow = matchMedia("(max-width: 820px)").matches;
    $("#valid-local").textContent = v.toLocaleString(undefined, WX.units.timeOpts(narrow ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    const atNow = state.stepIdx === currentStepIdx() && !state.frac;
    // one pill, two states: lit "Now" when live, a red "+36h" once stepped —
    // the offset is both the status and the way home (a "jump to live"), so
    // nothing else moves and no extra word is needed
    $("#tape-now").innerHTML = atNow ? "Now" : `<b class="off">+${Math.round(shownHours())}h</b>`;
    $("#tape-now").classList.toggle("on", atNow);
    $("#tape-now").classList.toggle("away", !atNow);
    $("#tape-now").setAttribute("aria-pressed", atNow ? "true" : "false");
    renderTapePill();
  }

  function applyStep(prefetch = true) {
    pushHash();
    if (fieldLive()) {
      WX.field.show(fieldSpec());
    } else {
      const src = map.getSource("wx");
      if (src) { try { src.updateImage({ url: layerUrl(), coordinates: modelCoords() }); } catch (e) { /* superseded */ } }
    }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", rasterOpacity());
    if (state.thunder && WX.ov) WX.ov.loadThunder();
    if (state.xsection && WX.xs) WX.xs.refresh();
    if (state.aq && WX.cams) WX.cams.refresh();
    if (state.route && WX.route) WX.route.refresh();
    if (WX.probe) WX.probe.refresh();
    renderClock();
    if (state.night && WX.ov) WX.ov.updateNight();
    if (WX.probe) { WX.probe.pinUpdate(); }
    updateMarkerFlag();
    if (prefetch) {
      // Warm the neighbours: a cold frame renders in ~1-2 s server-side, and
      // scrubbing waits for each one. Fetching +1/+2/-1 in the background
      // makes the scrub read from cache instead (Jeff 2026-08-21).
      const st = steps();
      for (const d of [1, 2, -1]) {
        const j = state.stepIdx + d;
        if (j < 0 || j >= st.length) continue;
        if (fieldLive()) WX.field.prefetch(fieldUrl(st[j]));
        else { const im = new Image(); im.src = layerUrl(st[j]); }
      }
      if (state.resorts && WX.ov) WX.ov.loadResorts();
    }
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
    const pp = $("#tape-pill .pp"); if (pp) { pp.textContent = state.playing ? "❚❚" : "▶"; pp.setAttribute("aria-label", state.playing ? "Pause" : "Play"); }
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = 0; }
    if (!state.playing) { settleStep(); applyStep(); loadWind(); return; }
    // The field layer can draw the hours between two model steps, so playback
    // glides through them. Radar and the raster path swap whole frames.
    if (fieldLive() && !state.radar && steps().length > 1) {
      playFrom = performance.now();
      playRaf = requestAnimationFrame(playFrame);
      return;
    }
    playTimer = setInterval(() => nudge(1), state.radar ? Math.min(500, state.playMs) : state.playMs);
  }
  // One step per playMs, in real time. A backgrounded tab comes back with a
  // huge dt; cap it so the map resumes rather than jumping a day.
  function playFrame(now) {
    playRaf = 0;
    if (!state.playing) return;
    const last = steps().length - 1;
    const dt = Math.min(250, Math.max(0, now - playFrom));
    playFrom = now;
    let pos = state.stepIdx + state.frac + dt / Math.max(120, state.playMs);
    if (pos >= last) pos -= last;                        // round the tape and start again
    const i = Math.min(last, Math.floor(pos));
    const crossed = i !== state.stepIdx;
    state.stepIdx = i;
    state.frac = Math.min(0.999, pos - i);
    const slider = $("#step");
    if (slider) slider.value = String(pos);
    // Crossing into a new step is the moment everything else has to catch up:
    // the wind field, the isobars, the tape's highlight. Between them only the
    // mix and the clock move.
    if (crossed) { applyStep(true); loadWind(); if (state.iso) WX.ov.loadIso(); }
    else { WX.field.show(fieldSpec()); renderClock(); }
    playRaf = requestAnimationFrame(playFrame);
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
    renderTapePill();
    const cat = catalog.layers.find((l) => l.layer === state.layer);
    if (!cat) { $("#legend").hidden = true; return; }
    // Geopotential height sits in a different band at every pressure level, so
    // the catalog ships a ramp per level and the bar shows the one on the map.
    const lg = (state.level && cat.levels && cat.levels[state.level]) || cat;
    $("#legend").hidden = false;
    const grad = lg.stops.map((s) => `rgb(${s.rgb.join(",")}) ${((s.v - lg.lo) / (lg.hi - lg.lo) * 100).toFixed(1)}%`).join(", ");
    $(".legend-bar").style.background = `linear-gradient(to right, ${grad})`;
    const isSpeed = ["wind", "gust", "gfactor"].includes(state.layer);
    const U_ = WX.units;
    // Every layer whose server unit is not the user's unit converts here —
    // cbase stayed in metres for aviation preset until 2026-08-20. dt24 is a
    // DELTA: °F deltas scale by 1.8 and never add 32. vis follows the
    // altitude preset: a pilot reads distance in miles, not km.
    const cv = { temp: (v) => U_.tempC(v), d2m: (v) => U_.tempC(v), feels: (v) => U_.tempC(v),
                 wbt: (v) => U_.tempC(v), sst: (v) => U_.tempC(v),
                 dt24: (v) => (U_.tempUnit === "°F" ? { v: Math.round(v * 1.8), unit: "°F/24h" } : { v: Math.round(v), unit: "°C/24h" }),
                 vis: (v) => (U_.altUnit === "ft" ? { v: Math.round(v * 0.621371), unit: "mi" } : { v: Math.round(v), unit: "km" }),
                 msl: (v) => U_.press(v * 100), frz: (v) => U_.alt(v), cbase: (v) => U_.alt(v), gh: (v) => U_.alt(v),
                 tp6: (v) => U_.precip(v), tp24: (v) => U_.precip(v), tp72: (v) => U_.precip(v),
                 sf6: (v) => U_.snow(v), sf24: (v) => U_.snow(v), sf72: (v) => U_.snow(v),
                 sd_cm: (v) => U_.snow(v), waves: (v) => U_.alt(v, 1), swell: (v) => U_.alt(v, 1), windsea: (v) => U_.alt(v, 1) }[state.layer];
    const conv = (v) => isSpeed ? Math.round(speed(v)) : cv ? cv(v).v : Math.round(v);
    const unit = isSpeed ? speedUnit() : cv ? cv(0).unit : lg.units;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => lg.lo + (lg.hi - lg.lo) * q);
    // The layer's name belongs over the bar, not wedged into the middle tick
    // where it collided with the value under it. Ticks are numbers only.
    const name = selectedLayerName();
    $("#legend .legend-head b").textContent = name;
    // "mm/6h": the window rides smaller and faded, set apart from the unit
    const um = /^([^/]+)(\/.+)$/.exec(unit || "");
    $("#legend .legend-head i").innerHTML = um ? `${um[1]}<span class="per">${um[2]}</span>` : (unit || "");
    if (state.layer === "ptype") {                 // categorical: names, not numbers
      $(".legend-bar").style.background = "linear-gradient(to right, rgb(60,130,220) 33%, rgb(190,110,220) 33% 66%, rgb(235,240,255) 66%)";
      $(".legend-ticks").innerHTML = "<span>rain</span><span>mixed</span><span>snow</span>";
      $("#legend .legend-head i").textContent = "";
      return;
    }
    $(".legend-ticks").innerHTML = ticks.map((t) => `<span>${conv(t)}</span>`).join("");
  }

  // ── point card ────────────────────────────────────────────────────────
  // The failure the card shows, in the same styled note the outside-domain
  // path uses. It was a bare text node in a flex row, which read as a layout
  // accident rather than an answer.
  const POINT_FAILED = "The forecast for this point did not load. The server may be restarting.";
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    if (phoneMQ.matches && !state.point) pointTapeReturn = tapeState;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { if (WX.ov && WX.ov.clearResortDetail) WX.ov.clearResortDetail(); else state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    document.body.classList.toggle("has-resort", !!keepResort);
    state.point = { lat, lon, data: null, ai: null, prob: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    restorePointPanelSize(); restoreSheetHeight();
    document.body.classList.add("has-point");
    // A phone's card sits over the layer row anyway, so the controls fold
    // while it is open and come back when it closes. A fold the user chose
    // themselves stays.
    if (phoneMQ.matches && !document.body.classList.contains("tucked")) { softTucked = true; setTucked(true, false); }
    if (phoneMQ.matches) { setTapeState("mini", false); focusMobileSheet(false); }
    $("#point-title").textContent = name || "Locating…";
    // if the geocoder never answers, the coordinates are the name
    if (!name) setTimeout(() => { if (my === pointReq && !state.point.name) $("#point-title").textContent = fmtCoords(lat, lon); }, 8000);
    $("#point-local").textContent = `${fmtCoords(lat, lon)} · ${modelEntry().short}`;
    $("#point-now").textContent = "…";
    $$(".point-tabs button[data-tab=resort]").forEach((b) => b.hidden = !state.resort);
    { const on = WX.search.isFav(lat, lon); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; }
    placeMarker(lat, lon);
    if (WX.provider) WX.provider.refresh();
    pushHash();
    const gotPoint = (d) => {
      if (d && d.available === false) {
        state.point.data = null;
        state.point.outside = d;
        $("#point-now").innerHTML = `<div class="note">${d.reason || "This point is outside the selected model's forecast domain."}</div>`;
        $("#point-foot").textContent = `${modelEntry().short} · ${modelEntry().grid} regional domain`;
        WX.tape.renderTape();
        return;
      }
      state.point.data = d;
      state.point.outside = null;
      renderPoint(); WX.tape.renderTape();
      const rd = new Date(d.run + ":00Z");
      $("#point-foot").textContent = `${modelEntry().short} run ${rd.toLocaleString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} ${String(rd.getUTCHours()).padStart(2, "0")}Z · ${modelEntry().grid} gridpoint · ${modelEntry().attribution.replace("ECMWF open data", "ECMWF").replace(" (AIFS)", "").replace("NOAA NCEP GFS via NOMADS", "National Weather Service").replace("NOAA NCEP AI-GFS (GraphCast lineage) via AWS Open Data", "National Weather Service").replace("NOAA NCEP GEFS ensemble mean via NOMADS", "National Weather Service")}`;
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
            .then((r) => { if (my === pointReq && r.available !== false) { state.point.ai = r; renderPoint(); WX.tape.renderTape(); } })
            .catch(() => {});
        }
      }
    };
    const gotLocal = (r) => { state.point.local = r; if (r.timezone && r.timezone.tz) { WX.units.pointZone = r.timezone.tz; if (WX.units.followsPoint) { WX.tape.renderTape(); applyStep(false); } } if ((!state.point.name || hasNonLatinScript(state.point.name)) && r.place && r.place.name) { state.point.name = r.place.name; $("#point-title").textContent = r.place.name; } else if (!state.point.name) { $("#point-title").textContent = fmtCoords(state.point.lat, state.point.lon); } WX.tape.renderTape(); renderPoint(); };
    // The stream lands six answers inside ~100 ms; six full card renders in a
    // row is most of the "slow pin" feel on a tablet. One render per frame.
    const renderSoon = perFrame(() => { if (my === pointReq) renderPoint(); });
    const got = {
      point: gotPoint, local: gotLocal,
      obs: (r) => { state.point.obs = r; renderSoon(); },
      alerts: (r) => { state.point.alerts = r.alerts || []; renderSoon(); },
      air: (r) => { state.point.air = r; renderSoon(); },
      tides: (r) => { state.point.tides = r || false; renderSoon(); },
      prob: (r) => { if (r) { state.point.prob = r; renderSoon(); } },
    };
    // One streamed response instead of six requests: the six were queueing
    // behind map tiles on the browser's per-origin connection cap, so the
    // card sat on "…" while the server had answered in milliseconds. The
    // static demo has no such endpoint and keeps the fan-out.
    if (!window.WXStatic) {
      try {
        const res = await fetch(`${U(API + "/card")}?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=${state.model}&run=${state.run}`, { priority: "high" });
        if (!res.ok || !res.body) throw new Error(res.status);
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "", gotAny = false;
        const seen = new Set();
        for (;;) {
          const { done, value } = await reader.read();
          if (my !== pointReq) { reader.cancel().catch(() => {}); return; }
          buf += dec.decode(value || new Uint8Array(), { stream: !done });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const row = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!row.trim()) continue;
            const msg = JSON.parse(row);
            if (msg.kind === "point" && msg.error) $("#point-now").innerHTML = `<div class="note">${POINT_FAILED}</div>`;
            if (msg.error || msg.pending) continue;         // fetched alone below
            if (got[msg.kind]) { seen.add(msg.kind); gotAny = true; got[msg.kind](msg.data); }
          }
          if (done) break;
        }
        if (gotAny) {
          // Anything the stream gave up on (a slow geocoder, a dead upstream)
          // arrives on its own request whenever it is ready — the card's
          // connection is already free.
          const single = {
            local: `${API}/geo/reverse`, obs: `${API}/obs`, alerts: `${API}/alerts/point`,
            air: `${API}/air`, tides: `${API}/tides`, prob: `${API}/prob`,
          };
          for (const [kind, base] of Object.entries(single)) {
            if (seen.has(kind)) continue;
            WX.api(`${base}?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`)
              .then((r) => { if (my === pointReq) got[kind](r); })
              .catch(() => { if (my === pointReq && kind === "tides") got.tides(false); });
          }
          return;
        }
      } catch (e) { if (my !== pointReq) return; /* fall through to the fan-out */ }
    }
    try {
      const d = await WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=${state.model}&run=${state.run}`);
      if (my !== pointReq) return;
      gotPoint(d);
    } catch (e) { if (my !== pointReq) return; $("#point-now").innerHTML = `<div class="note">${POINT_FAILED}</div>`; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) gotLocal(r); }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.obs(r); }).catch(() => {});
    WX.api(`${API}/alerts/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.alerts(r); }).catch(() => {});
    WX.api(`${API}/air?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.air(r); }).catch(() => {});
    WX.api(`${API}/tides?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.tides(r); }).catch(() => { if (my === pointReq) got.tides(false); });
    WX.api(`${API}/prob?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.prob(r); }).catch(() => {});
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { ++pointReq; state.point = null; if (WX.ov && WX.ov.clearResortDetail) WX.ov.clearResortDetail(); else state.resort = null; $("#point").hidden = true; document.body.classList.remove("has-point", "has-resort");
    if (pointTapeReturn != null) { const previous = pointTapeReturn; pointTapeReturn = null; setTapeState(previous, false); }
    if (softTucked) { softTucked = false; setTucked(false, false); } if (WX.provider) WX.provider.refresh(); if (marker) { marker.remove(); marker = null; } WX.tape.renderTape(); WX.tape.refreshTapePoint(); }
  function placeMarker(lat, lon) {
    if (!marker) {
      const el = document.createElement("div"); el.className = "wx-marker";
      el.innerHTML = `<span class="mflag" hidden></span>`;
      marker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    marker.setLngLat([lon, lat]).addTo(map);
    updateMarkerFlag();
  }
  // The tapped point reads the map it sits on: a small flag with the current
  // layer's value there, following the layer and the scrub (the Windy pin,
  // in this house's dress).
  function updateMarkerFlag() {
    if (!marker) return;
    const el = marker.getElement().querySelector(".mflag");
    const ll = marker.getLngLat();
    const v = WX.probe && WX.probe.valueAt ? WX.probe.valueAt(ll.lng, ll.lat) : null;
    if (!v || v.text === "—") { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<b>${v.text}</b>${v.sub ? `<span>${v.sub}</span>` : ""}`;
  }
  function renderPoint() {
    const d = state.point && state.point.data; if (!d || !window.WXPanes) return;
    // Winter has nothing to say where it cannot snow: a tab that answers
    // "n/a" nine rows deep is worse than no tab (see WXPanes.canSnow).
    const snow = !window.WXPanes.canSnow || window.WXPanes.canSnow(state.point, d);
    $$(".point-tabs button[data-tab=winter]").forEach((b) => b.hidden = !snow);
    if (!snow && state.tab === "winter") state.tab = "now";
    $$(".point-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$("#point-body section").forEach((s) => s.hidden = s.dataset.pane !== state.tab);
    window.WXPanes.render(state.tab, state.point, Math.min(state.stepIdx, d.steps.length - 1));
  }
  WX.renderPoint = renderPoint;
  WX.setStep = setStep;

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000, kind = "", onTap = null) {
    // One line, one fact. Anything longer is a card, not a toast.
    msg = String(msg).replace(/\.\s*$/, ""); if (msg.length > 72) msg = msg.slice(0, 70).replace(/\s+\S*$/, "") + "…";
    const t = $("#toast"); t.textContent = msg; t.hidden = false; t.className = kind + (onTap ? " tappable" : "");
    t.onclick = onTap ? () => { t.hidden = true; onTap(); } : null;
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
