// Map overlays: radar, isolines, avalanche regions, resorts + lifts, alerts,
// tropical systems, satellite, measure tool. Loaded after app.js; talks to it
// through window.WX (map/state/helpers) and exposes itself as WX.ov.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // app.js has its own `const RAINVIEWER` but it lives inside app.js's IIFE, so
  // it was never visible here — the direct-fetch fallback used to throw a
  // ReferenceError and land in the catch as "radar unavailable".
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  // ── isolines overlay ──────────────────────────────────────────────────
  let isoReq = 0;
  let quakePopup = null, quakeDepth = {};

  // ── polar caps ──────────────────────────────────────────────────────────
  // The basemap's tiles end at 85.05° (mercator's edge), and on the globe
  // the sphere above that renders the style's background — near-black, which
  // read as a hole drilled through the pole. Tint the
  // background to sit with the ocean instead. Re-applied on every
  // style.load: a theme or basemap swap replaces the style wholesale.
  function tintPoles() {
    const m = M(); if (!m || !m.getStyle) return;
    const light = document.documentElement.dataset.theme === "light";
    const color = light ? "#d3dde6" : "#101922";
    const layers = (m.getStyle().layers || []);
    const bg = layers.find((l) => l.type === "background");
    if (bg) m.setPaintProperty(bg.id, "background-color", color);
    else if (layers.length) m.addLayer({ id: "polar-bg", type: "background", paint: { "background-color": color } }, layers[0].id);
  }
  (function wirePoles() {
    const t = setInterval(() => {
      if (!WX.map) return;
      clearInterval(t);
      WX.map.on("style.load", tintPoles);
      if (WX.map.isStyleLoaded && WX.map.isStyleLoaded()) tintPoles(); else WX.map.once("load", tintPoles);
    }, 250);
  })();
  function isoVar() {
    if (state.layer === "temp") return state.level ? `temp?level=${state.level}` : "temp";
    if (state.layer === "frz") return "frz";
    if (state.layer === "wind" && state.level === 500) return "gh_500";
    return "msl";
  }
  async function loadIso() {
    const my = ++isoReq;
    const v = isoVar();
    const url = U(`${API}/isolines/${state.model}/${state.run}/${WX.fn.stepHours()}/${v.includes("?") ? v.replace("?", ".json?") : v + ".json"}`);
    try {
      const gj = await WX.api(url);
      if (my !== isoReq || !state.iso) return;
      // the rail's Isolines row says what the numbers are (12° needs no help;
      // a bare 4514 does)
      const flat = document.querySelector('.rail-flat[data-rail="iso"] span');
      if (flat) flat.textContent = gj.unit ? `Isolines · ${gj.unit}` : "Isolines";
      if (M().getSource("iso")) M().getSource("iso").setData(gj);
      else {
        M().addSource("iso", { type: "geojson", data: gj });
        M().addLayer({ id: "iso-line", type: "line", source: "iso", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": ["case", ["==", ["%", ["get", "value"], ["*", 4, gj.interval || 4]], 0], 1.4, 0.7] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "iso-label", type: "symbol", source: "iso", filter: ["==", ["geometry-type"], "LineString"], layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Regular"], "symbol-spacing": 320 }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.7)", "text-halo-width": 1.2 } });
        // pressure centres: H blue, L red, the way every surface chart draws them
        M().addLayer({ id: "iso-hl", type: "symbol", source: "iso", filter: ["==", ["geometry-type"], "Point"],
          layout: { "text-field": ["get", "label"], "text-size": 21, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true },
          paint: { "text-color": ["match", ["get", "kind"], "H", "#6ea8ff", "#ff6a5e"], "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.6 } });
      }
    } catch (e) { WX.fn.toast("No isolines for this layer", 4000, "error"); }
  }
  // ── satellite imagery base ────────────────────────────────────────────
  // Not a weather overlay: a ground truth to put UNDER the field. Vector
  // labels stay on top; the weather layer keeps painting above it.
  const BASES = {
    sat: { attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
           tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" },
    topo: { attribution: "Topo © Esri and contributors",
            tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}" },
  };
  function setBase(kind) {
    // restored from localStorage at boot, which can run before the style —
    // an addLayer then is a fatal, not a layer (2026-08-19, landscape probe)
    if (!M().getSource("openmaptiles")) { M().once("load", () => setBase(kind)); return; }
    if (M().getLayer("sat-base")) M().removeLayer("sat-base");
    if (M().getSource("sat-base")) M().removeSource("sat-base");
    const spec = BASES[kind];
    if (!spec) return;                               // "": the vector map itself
    M().addSource("sat-base", { type: "raster", tileSize: 256, maxzoom: 18,
      attribution: spec.attribution, tiles: [spec.tiles] });
    const before = M().getLayer("wx") ? "wx" : WX.fn.firstSymbolId();
    M().addLayer({ id: "sat-base", type: "raster", source: "sat-base", paint: { "raster-opacity": 1 } }, before);
  }
  const loadImagery = () => setBase(WX.state.base || "sat");   // legacy callers
  const clearImagery = () => setBase("");

  // ── terrain hillshade ─────────────────────────────────────────────────
  // Relief under the weather: AWS's public terrarium DEM tiles through
  // MapLibre's own hillshade renderer. No key, no quota drama, and it sits
  // under the field so ridgelines explain the precip shadows.
  function loadTerrain() {
    if (!M().getSource("openmaptiles")) { M().once("load", loadTerrain); return; }
    if (M().getSource("dem")) return;
    M().addSource("dem", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 13,
      attribution: "Terrain: Mapzen/AWS Terrain Tiles",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] });
    const before = M().getLayer("wx") ? "wx" : WX.fn.firstSymbolId();
    M().addLayer({ id: "hillshade", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": 0.45,
               "hillshade-shadow-color": "rgba(0,0,0,.55)",
               "hillshade-highlight-color": "rgba(255,255,255,.22)",
               "hillshade-accent-color": "rgba(0,0,0,.25)" } }, before);
  }
  function clearTerrain() { if (M().getLayer("hillshade")) M().removeLayer("hillshade"); if (M().getSource("dem")) M().removeSource("dem"); }

  // ── day/night terminator ──────────────────────────────────────────────
  // Follows the SELECTED time, not the wall clock: scrub the tape and watch
  // the night slide. Subsolar point from a low-precision solar ephemeris —
  // a degree of error is invisible at this scale.
  function nightPolygon(date) {
    const rad = Math.PI / 180, d = (date - new Date(Date.UTC(2000, 0, 1, 12))) / 86400e3;
    const L = (280.460 + 0.9856474 * d) % 360, g = ((357.528 + 0.9856003 * d) % 360) * rad;
    const ec = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const decl = Math.asin(Math.sin(23.439 * rad) * Math.sin(ec));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ra = Math.atan2(Math.cos(23.439 * rad) * Math.sin(ec), Math.cos(ec));
    const subLon = ((ra / rad) - gmst * 15 + 540) % 360 - 180;
    const subLat = decl / rad;
    // the terminator: every point 90° of arc from the subsolar point.
    // sin(lat2) = cos(lat1)·cos(az); lon2 = lon1 + atan2(sin(az)·cos(lat1), −sin(lat1)·sin(lat2))
    const ring = [];
    const lat1 = subLat * rad, lon1 = subLon * rad;
    for (let a = 0; a < 360; a += 3) {
      const az = a * rad;
      const lat2 = Math.asin(Math.cos(lat1) * Math.cos(az));
      const lon2 = lon1 + Math.atan2(Math.sin(az) * Math.cos(lat1), -Math.sin(lat1) * Math.sin(lat2));
      ring.push([((lon2 / rad + 540) % 360) - 180, lat2 / rad]);
    }
    // close over the dark pole: the pole opposite the sun's hemisphere
    const poleLat = subLat > 0 ? -90 : 90;
    ring.sort((p, q) => p[0] - q[0]);
    const coords = [[-180, poleLat], ...ring.map(([x, y]) => [x, y]), [180, poleLat], [-180, poleLat]];
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
  }
  function updateNight() {
    if (!state.night || !M().getSource) return;
    const gj = nightPolygon(WX.fn.validDate());
    if (M().getSource("night")) M().getSource("night").setData(gj);
    else {
      M().addSource("night", { type: "geojson", data: gj });
      M().addLayer({ id: "night", type: "fill", source: "night",
        paint: { "fill-color": "#03060f", "fill-opacity": 0.32 } }, WX.fn.firstSymbolId());
    }
  }
  function clearNight() { if (M().getLayer("night")) M().removeLayer("night"); if (M().getSource("night")) M().removeSource("night"); }

  function clearIso() { ["iso-hl", "iso-label", "iso-line"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("iso")) M().removeSource("iso"); }

  // ── avalanche regions overlay ─────────────────────────────────────────
  async function loadAvy() {
    try {
      const gj = await WX.api(`${API}/avy/layer`);
      if (!state.avy) return;
      if (M().getSource("avy")) M().getSource("avy").setData(gj);
      else {
        M().addSource("avy", { type: "geojson", data: gj });
        M().addLayer({ id: "avy-fill", type: "fill", source: "avy", paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", [">", ["get", "danger_level"], 0], 0.32, 0.12] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "avy-line", type: "line", source: "avy", paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.8 } }, WX.fn.firstSymbolId());
      }
      const rated = gj.features.filter((x) => x.properties.danger_level > 0).length;
      WX.fn.toast(rated ? `${rated} avalanche regions rated` : "Avalanche regions · off season, no ratings", 5000);
    } catch (e) { WX.fn.toast("Avalanche layer unavailable", 4000, "error"); state.avy = false; $("#avy-toggle").classList.remove("on"); }
  }
  function clearAvy() { ["avy-line", "avy-fill"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("avy")) M().removeSource("avy"); }

  // ── ski resorts overlay ───────────────────────────────────────────────
  // Pins for every resort; when a snow layer is showing, each pin is sized
  // and coloured by the forecast snowfall in the next 72 h from the selected
  // time (the OpenSnow map), with the amount as its label.
  let resortsCatalog = null, resortSnow = null, resortSnowKey = "", pendingSnow = null;
  const SNOW_STOPS = [0, "#8a8f98", 5, "#9dd3ff", 15, "#6cb6ff", 30, "#8b7cff", 60, "#e05bd0", 100, "#ff5c8a"];
  async function loadResorts() {
    try {
      if (!resortsCatalog) resortsCatalog = (await WX.api(`${API}/resorts/all`)).resorts;
      if (!state.resorts) return;
      const snowMode = ["sf6", "sf24", "sf72", "sd_cm"].includes(state.layer);
      const key = `${state.model}/${state.run}/${WX.stepHours}`;
      if (snowMode && resortSnowKey !== key && !pendingSnow) {
        // draw the pins now, recolour when the amounts land
        pendingSnow = WX.api(`${API}/resorts/snow?model=${state.model}&run=${state.run}&step=${WX.stepHours}&hours=72`)
          .then((r) => { resortSnow = r.snow_cm; resortSnowKey = key; }).catch(() => { resortSnow = null; })
          .finally(() => { pendingSnow = null; if (state.resorts) loadResorts(); });
      }
      const gj = { type: "FeatureCollection", features: resortsCatalog.map((r) => { const sn = snowMode && resortSnow && resortSnowKey === key ? resortSnow[r.id] : null; return { type: "Feature", properties: { id: r.id, name: r.name, snow: sn == null ? -1 : sn, label: sn == null ? r.name : (sn >= 1 ? `${Math.round(sn)} cm` : "") }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } }; }) };
      if (M().getSource("resorts")) M().getSource("resorts").setData(gj);
      else {
        M().addSource("resorts", { type: "geojson", data: gj });
        M().addLayer({ id: "resort-pts", type: "circle", source: "resorts", paint: {} });
        M().addLayer({ id: "resort-lbl", type: "symbol", source: "resorts", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.2 } });
      }
      // paint by mode
      const snowColor = ["case", ["<", ["get", "snow"], 0], "#ffb454", ["interpolate", ["linear"], ["get", "snow"], ...SNOW_STOPS]];
      M().setPaintProperty("resort-pts", "circle-color", snowMode ? snowColor : "#ffb454");
      M().setPaintProperty("resort-pts", "circle-radius", snowMode
        ? ["interpolate", ["linear"], ["zoom"], 3, ["+", 2, ["*", 0.05, ["max", 0, ["get", "snow"]]]], 8, ["+", 4, ["*", 0.12, ["max", 0, ["get", "snow"]]]]]
        : ["interpolate", ["linear"], ["zoom"], 3, 2.5, 8, 6]);
      M().setPaintProperty("resort-pts", "circle-stroke-color", "#0b0d10");
      M().setPaintProperty("resort-pts", "circle-stroke-width", 1.2);
      M().setPaintProperty("resort-pts", "circle-opacity", 0.92);
      M().setLayerZoomRange("resort-lbl", snowMode ? 4 : 7, 24);
      M().setPaintProperty("resort-lbl", "text-color", snowMode ? "#dfe8ff" : "#ffd39a");
    } catch (e) { WX.fn.toast("Resort catalog unavailable", 4000, "error"); }
  }
  function clearResorts() { ["resort-lbl", "resort-pts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("resorts")) M().removeSource("resorts"); }

  async function selectResort(id) {
    try {
      const d = await WX.api(`${API}/resorts/${id}`);
      state.resort = d;
      const r = d.resort;
      // lifts + boundary on the M()
      const lifts = d.lifts || { type: "FeatureCollection", features: [] };
      if (M().getSource("lifts")) M().getSource("lifts").setData(lifts);
      else {
        M().addSource("lifts", { type: "geojson", data: lifts });
        M().addLayer({ id: "lifts-line", type: "line", source: "lifts", paint: { "line-color": "#ffb454", "line-width": 2, "line-opacity": 0.9 } });
        M().addLayer({ id: "lifts-lbl", type: "symbol", source: "lifts", minzoom: 11, layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 10, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1 } });
      }
      // The runs, coloured the way a trail map colours them. Black diamonds are
      // drawn near-white here: this basemap is dark, and a black line on it is
      // an absent line. Every run gets a dark casing so it reads over snow,
      // forest and the weather field alike.
      const pistes = d.pistes || { type: "FeatureCollection", features: [] };
      const gradeColour = ["match", ["get", "grade"],
        "novice", "#5ad469", "easy", "#3d8bff", "intermediate", "#ff4d4d",
        "advanced", "#f2f2f2", "expert", "#c56bff", "freeride", "#ffb454", "extreme", "#ff7a2f",
        "#9aa5b4"];
      if (M().getSource("pistes")) M().getSource("pistes").setData(pistes);
      else {
        M().addSource("pistes", { type: "geojson", data: pistes });
        M().addLayer({ id: "pistes-case", type: "line", source: "pistes", minzoom: 9,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "rgba(0,0,0,.65)", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.6, 13, 6.5], "line-opacity": 0.9 } });
        // line-dasharray takes no data expression, so ungroomed runs get their
        // own layer rather than a condition MapLibre would reject silently.
        const pisteWidth = ["interpolate", ["linear"], ["zoom"], 9, 1.3, 13, 4];
        M().addLayer({ id: "pistes-line", type: "line", source: "pistes", minzoom: 9,
          filter: ["!=", ["get", "grade"], "freeride"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": gradeColour, "line-width": pisteWidth, "line-opacity": 0.95 } });
        M().addLayer({ id: "pistes-free", type: "line", source: "pistes", minzoom: 9,
          filter: ["==", ["get", "grade"], "freeride"],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: { "line-color": "#ffb454", "line-width": pisteWidth, "line-opacity": 0.95, "line-dasharray": [2, 1.4] } });
        M().addLayer({ id: "pistes-lbl", type: "symbol", source: "pistes", minzoom: 12.5,
          layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name"], ["get", "ref"]], "text-size": 10, "text-font": ["Noto Sans Regular"] },
          paint: { "text-color": "#eef1f5", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.2 } });
      }
      const bnd = d.boundary ? { type: "FeatureCollection", features: [d.boundary] } : { type: "FeatureCollection", features: [] };
      if (M().getSource("bnd")) M().getSource("bnd").setData(bnd);
      else { M().addSource("bnd", { type: "geojson", data: bnd }); M().addLayer({ id: "bnd-line", type: "line", source: "bnd", paint: { "line-color": "#ffb454", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, WX.fn.firstSymbolId()); }
      M().flyTo({ center: [r.lon, r.lat], zoom: Math.max(M().getZoom(), 10.5), duration: 900 });
      state.tab = "resort";
      WX.fn.openPoint(r.lat, r.lon, r.name);
    } catch (e) { WX.fn.toast("Resort detail unavailable", 4000, "error"); }
  }
  WX.selectResort = selectResort;

  // ── alerts: warning polygons (GeoJSON) + Environment Canada (GeoMet WMS) ─
  // A tap opens the shared map card. It used to open a toast clipped at 160
  // characters, which is shorter than the area list on a single British
  // thunderstorm warning, so the one thing a reader needed — where is this —
  // was the thing that got cut.
  const ALERT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>`;
  // MeteoAlarm ships its awareness type as a slug; every other source ships a
  // sentence. Spell the slugs out, title-case whatever else arrives.
  const ALERT_WORD = { "high-temp": "High temperature", "low-temp": "Low temperature",
    "snow-ice": "Snow and ice", thunderstorm: "Thunderstorm", forestfire: "Forest fire",
    coastal: "Coastal event", avalanche: "Avalanche", rain: "Rain", flood: "Flood",
    wind: "Wind", fog: "Fog", warning: "Weather warning" };
  const alertTitle = (ev) => ALERT_WORD[ev] || (ev ? String(ev).charAt(0).toUpperCase() + String(ev).slice(1) : "Weather alert");
  const alertWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : WX.units.dateTime(iso, { weekday: "short", hour: "numeric", minute: "2-digit" }); };
  // "3h 20m" / "2 days" / "" once it is past. The feeds give an absolute
  // expiry in UTC; what a reader wants is how long they have.
  function alertLeft(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const ms = t - Date.now();
    if (ms <= 0) return "";
    const m = Math.round(ms / 60e3);
    if (m < 60) return `${m}m`;
    if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.round(m / 1440)} days`;
  }

  let alertPopup = null, alertTick = null, alertReq = 0, alertsBound = false;
  // The polygon under the open card wears a heavier outline, so a card that
  // covers half the screen still says which shape it belongs to.
  const highlightAlert = (id) => M().getLayer("alerts-hi") &&
    M().setFilter("alerts-hi", ["==", ["get", "id"], id == null ? "" : id]);

  function closeAlertCard() {
    if (alertTick) { clearInterval(alertTick); alertTick = null; }
    if (alertPopup) { alertPopup.remove(); alertPopup = null; }
    highlightAlert("");
  }

  // p is the layer's properties (or an alert from /api/alerts/ec, same shape);
  // `detail` is the prose the layer does not carry, once it lands.
  function openAlertCard(lngLat, p, detail) {
    const d = detail || {};
    const ends = p.ends || d.ends, onset = p.onset || d.onset;
    const left = alertLeft(ends);
    const startsIn = alertLeft(onset);
    const text = [d.description || p.description || "", d.instruction || p.instruction || ""].filter(Boolean).join("\n\n");
    const urgency = d.urgency || p.urgency || "";
    const sender = d.sender || p.sender || "";
    const link = d.url || p.url || "";
    const my = ++alertReq;
    closeAlertCard();
    // On a phone the tape owns the bottom half of the screen. Anchor the card
    // near the top of the map there and let it open downward; anchored at the
    // tap it lands under the timebar, where nobody can read or close it.
    const narrow = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
    let at = lngLat;
    if (narrow) {
      const q = M().project(lngLat), h = M().getCanvas().clientHeight || 800;
      at = M().unproject([q.x, Math.round(h * 0.22)]);   // clear of the layer rails on top
    }
    alertPopup = mapCard(at, "alert-pop", {
      icon: ALERT_SVG, color: p.color || "#f0a020", title: alertTitle(p.event),
      pill: p.severity || "", sub: p.source || "", ago: left ? `expires in ${left}` : "expired",
      hero: [{ k: left ? "Expires in" : "Expires", v: left || "now" },
             startsIn ? { k: "Starts in", v: startsIn } : null,
             urgency ? { k: "Urgency", v: urgency } : null].filter(Boolean),
      // no headline row: every source writes it as the event plus the area plus
      // the issuing office, all three of which are already on this card
      rows: [["Area", p.area], ["Effective", alertWhen(onset)], ["Expires", alertWhen(ends)],
             ["Certainty", d.certainty || p.certainty || ""],
             ["Confidence", d.confidence || p.confidence || ""], ["Impact", d.impact || p.impact || ""],
             ["Issued by", sender]],
      raw: text || (detail ? "" : "loading the full text…"),
      src: p.source ? `Source: ${p.source}` : "",
      link: link ? { href: link, text: "Official bulletin" } : null,
      anchor: narrow ? "top" : undefined, maxWidth: "min(360px, 88vw)" });
    highlightAlert(p.id);
    alertPopup.on("close", () => { if (alertTick) { clearInterval(alertTick); alertTick = null; } highlightAlert(""); });
    // the countdown is the one number on this card that goes stale while you
    // read it
    if (left) alertTick = setInterval(() => {
      const el = alertPopup && alertPopup.getElement();
      const box = el && [...el.querySelectorAll(".mc-hero > div")].find((x) => x.querySelector("small") && /Expires/.test(x.querySelector("small").textContent));
      if (!box) return;
      const now = alertLeft(ends);
      box.querySelector("b").textContent = now || "now";
    }, 30000);
    if (!detail && p.id) {
      WX.api(U(`${API}/alerts/detail?id=${encodeURIComponent(p.id)}&source=${encodeURIComponent(p.source || "")}`))
        .then((got) => { if (my === alertReq && alertPopup && got) openAlertCard(lngLat, p, got); })
        .catch(() => { if (my === alertReq && alertPopup) openAlertCard(lngLat, p, { description: "" }); });
    }
  }
  WX.openAlertCard = openAlertCard;

  // The EC layer is a raster: a tap on it has no feature to read, so ask
  // GeoMet what it painted at that point. Only inside its own bounding box,
  // only when a vector alert has not already answered the same tap.
  const EC_BOX = [-141, 41, -52, 84];
  async function ecAlertAt(e) {
    if (!state.alerts || !M().getLayer("ec-alerts")) return;
    const lon = WX.wlon(e.lngLat.lng), lat = e.lngLat.lat;
    if (lon < EC_BOX[0] || lon > EC_BOX[2] || lat < EC_BOX[1] || lat > EC_BOX[3]) return;
    if (M().getLayer("alerts-fill") && M().queryRenderedFeatures(e.point, { layers: ["alerts-fill"] }).length) return;
    try {
      const r = await WX.api(U(`${API}/alerts/ec?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`));
      const hit = (r.alerts || [])[0];
      if (hit) openAlertCard(e.lngLat, hit, hit);
    } catch (err) { /* nothing painted there, or GeoMet is having a day */ }
  }

  async function loadAlerts() {
    try {
      const gj = await WX.api(`${API}/alerts/layer`);
      if (!state.alerts) return;
      if (M().getSource("alerts")) M().getSource("alerts").setData(gj);
      else {
        M().addSource("alerts", { type: "geojson", data: gj });
        M().addLayer({ id: "alerts-fill", type: "fill", source: "alerts", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.28 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-line", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": 1.6 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-hi", type: "line", source: "alerts", filter: ["==", ["get", "id"], ""],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 3.2, "line-opacity": 0.9 } }, WX.fn.firstSymbolId());
        M().on("click", "alerts-fill", (e) => { const f = e.features[0]; if (f) openAlertCard(e.lngLat, f.properties); });
        M().on("mouseenter", "alerts-fill", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "alerts-fill", () => { M().getCanvas().style.cursor = ""; });
        if (!alertsBound) { M().on("click", ecAlertAt); alertsBound = true; }
      }
      if (!M().getSource("ec-alerts")) {
        // "ALERTS" was GeoMet's old name for this and now answers
        // "Couche non disponible" — the Canadian layer had been painting
        // nothing at all. The current name is Current-Alerts, and it is
        // queryable, which is what makes the card above possible.
        M().addSource("ec-alerts", { type: "raster", tileSize: 256, attribution: "Alerts © Environment Canada",
          tiles: ["https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=Current-Alerts&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES="] });
        M().addLayer({ id: "ec-alerts", type: "raster", source: "ec-alerts", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
      WX.fn.toast(`${gj.features.length} warning areas plus Environment Canada · tap one to read it`, 4500);
    } catch (e) { WX.fn.toast("Alerts unavailable", 4000, "error"); state.alerts = false; $("#alerts-toggle").classList.remove("on"); }
  }
  function clearAlerts() { closeAlertCard(); ["alerts-hi", "alerts-line", "alerts-fill", "ec-alerts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); ["alerts", "ec-alerts"].forEach((sname) => M().getSource(sname) && M().removeSource(sname)); }

  // ── tropical systems (NHC): cone, track, current position ─────────────
  async function loadStorms() {
    try {
      const gj = await WX.api(`${API}/storms`);
      if (!state.storms) return;
      if (M().getSource("storms")) M().getSource("storms").setData(gj);
      else {
        M().addSource("storms", { type: "geojson", data: gj });
        // The cone is a whisper, not a warning sign: soft fill, hairline
        // dashed edge. The track reads as forecast (dashed) with waypoints.
        M().addLayer({ id: "storm-cone", type: "fill", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "fill-color": "#ffb454", "fill-opacity": 0.10 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "storm-cone-line", type: "line", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "line-color": "rgba(255,180,84,.55)", "line-width": 1, "line-dasharray": [3, 2.5] } }, WX.fn.firstSymbolId());
        // The GEFS members: thirty thin lines under the official track, the
        // width of the forecast before the cone smooths it. Off until the
        // card asks for them, and only ever for the storm whose card is open.
        M().addLayer({ id: "storm-ens", type: "line", source: "storms",
          filter: ["all", ["==", ["get", "layer"], "ens"], ["==", ["get", "id"], ""]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["case", ["get", "mean"], "rgba(255,255,255,.62)", "rgba(255,255,255,.26)"],
                   "line-width": ["case", ["get", "mean"], 1.7, 0.9] } });
        // Where it has been: solid and quiet, per storm, shown when its card
        // is open. Forecast stays dashed; history is fact, so it is solid.
        M().addLayer({ id: "storm-past", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], ""]], paint: { "line-color": "rgba(255,255,255,.45)", "line-width": 1.4 } });
        M().addLayer({ id: "storm-past-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], ""], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 3.2, "circle-color": ["coalesce", ["get", "color"], "#9aa4b2"], "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
        M().addLayer({ id: "storm-track", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "rgba(255,255,255,.72)", "line-width": 1.6, "line-dasharray": [1.6, 1.8] } });
        M().addLayer({ id: "storm-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 2.8, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
        // The eye wears its category colour — red deepens with the scale.
        // The eye is the hurricane symbol itself, one image per category
        // colour (Jeff 2026-08-22: the yellow circle was a placeholder).
        for (const col of STORM_COLORS) if (!M().hasImage(`cyc-${col}`)) M().addImage(`cyc-${col}`, cycloneIcon(col), { pixelRatio: 2 });
        M().addLayer({ id: "storm-now", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "icon-image": ["concat", "cyc-", ["coalesce", ["get", "category_color"], "#ef786f"]], "icon-size": 1.15, "icon-allow-overlap": true, "icon-ignore-placement": true } });
        // the category lives INSIDE the eye — "2" in the dark centre, "TD"
        // in the blue one — and the sub-label carries the motion instead
        M().addLayer({ id: "storm-eye", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "text-field": ["coalesce", ["get", "eye"], ""], "text-size": 8.5, "text-letter-spacing": -0.04, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#fff" } });
        M().addLayer({ id: "storm-lbl", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          // name in bold, motion a notch smaller in regular — two rows, two
          // weights. (The tile server only serves Noto Sans glyphs; the
          // app's Urbanist cannot reach map labels without its own PBFs.)
          layout: { "text-field": ["format", ["concat", ["get", "class"], " ", ["get", "name"]], { "font-scale": 1 }, "\n", {},
                                   ["coalesce", ["get", "moving_short"], ""], { "font-scale": 0.84, "text-font": ["literal", ["Noto Sans Regular"]] }],
                    "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top", "text-font": ["Noto Sans Bold"], "text-line-height": 1.15 },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.4 } });
        M().on("click", "storm-now", (e) => openStormCard(e.features[0]));
        M().on("click", "storm-eye", (e) => openStormCard(e.features[0]));
        M().on("mouseenter", "storm-now", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "storm-now", () => { M().getCanvas().style.cursor = ""; });
      }
      const names = (gj.storms || []).map((x) => `${x.class} ${x.name}`).join(", ");
      WX.fn.toast(names ? `${gj.storms.length} tropical system${gj.storms.length === 1 ? "" : "s"} on the map` : "No tropical systems", 5000);
      if (gj.storms && gj.storms.length && !state.point) { const st = gj.storms[0]; const f = gj.features.find((x) => x.properties.kind === "current" && x.properties.id === st.id); if (f) M().flyTo({ center: f.geometry.coordinates, zoom: Math.max(3.5, Math.min(M().getZoom(), 5)), duration: 1200 }); }
    } catch (e) { WX.fn.toast("Storm feed unavailable", 4000, "error"); state.storms = false; $("#storms-toggle").classList.remove("on"); }
  }
  // ── the map card ──────────────────────────────────────────────────────
  // One builder for every popup on the map. `o`: icon (svg string), color,
  // title, pill, sub, ago, hero [{k, v, unit, note}], rows [[k, v]], raw,
  // src, link {href, text}. Returns the popup; a small "close" bottom-right
  // and a tap anywhere else both close it.
  const escH = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function mapCard(lngLat, cls, o) {
    const hero = (o.hero || []).filter((h) => h && h.v != null && h.v !== "").map((h) =>
      `<div><small>${escH(h.k)}</small><b>${escH(h.v)}${h.unit ? `<i>${escH(h.unit)}</i>` : ""}</b>${h.note ? `<em>${escH(h.note)}</em>` : ""}</div>`).join("");
    const rows = (o.rows || []).filter((r) => r && r[1] != null && r[1] !== "").map(([k, v, rawHtml]) => `<dt>${escH(k)}</dt><dd>${rawHtml ? v : escH(v)}</dd>`).join("");
    const html = `<div class="mc-head">${o.icon ? `<i class="mc-ico" style="color:${o.color || "var(--accent)"}">${o.icon}</i>` : ""}
        <div class="mc-title"><b${o.titleColor ? ` style="color:${o.titleColor}"` : ""}>${escH(o.title)}</b>
        <div class="mc-sub">${o.pill ? `<span class="mc-pill" style="--cat:${o.color || "var(--accent)"}">${escH(o.pill)}</span>` : ""}${o.sub ? `<span>${escH(o.sub)}</span>` : ""}${o.ago ? `<span class="mc-ago">${escH(o.ago)}</span>` : ""}</div></div></div>
      <div class="mc-hero">${hero}</div>
      <dl>${rows}</dl>
      ${o.raw ? `<div class="mc-raw">${escH(o.raw)}</div>` : ""}
      ${o.src ? `<div class="mc-src">${escH(o.src)}</div>` : ""}
      <div class="mc-foot">${o.link ? `<a class="qp-link" href="${escH(o.link.href)}" target="_blank" rel="noopener">${escH(o.link.text)} ↗</a>` : "<span></span>"}<button class="mc-close" type="button">close</button></div>`;
    const pop = new maplibregl.Popup({ className: `quake-pop mapcard ${cls}`, closeButton: false, focusAfterOpen: false, maxWidth: o.maxWidth || "320px", offset: 12, anchor: o.anchor })
      .setLngLat(lngLat).setHTML(html).addTo(M());
    pop.getElement().querySelector(".mc-close").addEventListener("click", () => pop.remove());
    return pop;
  }
  WX.mapCard = mapCard;

  const QUAKE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2.5-6 3 12 3-9 2.5 6 1.5-3H22"/></svg>`;
  let stormPopup = null;
  function openStormCard(f) {
    const p = f.properties;
    const ago = p.updated ? (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`)(Date.now() - new Date(p.updated)) : "";
    const kmh = p.intensity_kt ? Math.round(p.intensity_kt * 1.852) : null;
    const [slon, slat] = f.geometry.coordinates;
    // Which desk is tracking it: the feed says (NHC, CPHC, JTWC).
    const agency = p.agency || (/^cp/i.test(p.id || "") ? "CPHC · Honolulu" : "NHC · Miami");
    const mv = p.movement && !/null/.test(p.movement) ? p.movement : "";
    let mvShown = false;
    if (stormPopup) stormPopup.remove();
    // the spaghetti follows the open card, the same way the past track does
    const showEns = (id) => M().getLayer("storm-ens") &&
      M().setFilter("storm-ens", ["all", ["==", ["get", "layer"], "ens"], ["==", ["get", "id"], id || ""]]);
    showEns("");
    // the card brings the storm's past with it
    const showPast = (id) => ["storm-past", "storm-past-pts"].forEach((l) => M().getLayer(l) && M().setFilter(l, ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], id || ""]].concat(l.endsWith("pts") ? [["==", ["geometry-type"], "Point"]] : [])));
    showPast(p.id);
    stormPopup = mapCard([slon, slat], "storm-pop", {
      icon: WX.CYCLONE_SVG || "", color: p.category_color || "#ef786f",
      title: `${p.class} ${p.name}`, pill: p.category, sub: p.category_label, ago,
      hero: (() => {
        const hero = [p.intensity_kt && { k: "Winds", v: p.intensity_kt, unit: "kt", note: `${kmh} km/h` },
                      p.gusts && { k: "Gusts", v: p.gusts, unit: "kt", note: `${Math.round(p.gusts * 1.852)} km/h` },
                      p.pressure_mb && { k: "Pressure", v: p.pressure_mb, unit: "mb" }].filter(Boolean);
        // A third stat fills the NHC card's empty right slot: heading as a
        // compass point, speed as the note. JTWC cards are already full.
        if (hero.length < 3 && mv) {
          const deg = /(\d+)\s*°/.exec(mv), kt = /at\s+(\d+)/.exec(mv);
          const dir = deg ? ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(+deg[1] / 22.5) % 16] : mv.split(" ")[0];
          hero.push({ k: "Moving", v: dir, unit: "", note: kt ? `at ${kt[1]} kt` : "" });
          mvShown = true;
        }
        return hero;
      })(),
      rows: [mvShown ? null : ["Moving", mv],
             p.ens_members ? ["Spread", `<button type="button" class="mc-ens" aria-pressed="false">${escH(p.ens_members)} GEFS tracks</button>`, true] : null,
             ["Position", WX.fmtCoords ? WX.fmtCoords(slat, slon, 1) : `${slat.toFixed(1)}, ${slon.toFixed(1)}`],
             ["Agency", agency], ["Advisory", p.advisory ? `#${p.advisory}` : ""]].filter(Boolean),
      link: p.url ? { href: p.url, text: "Public advisory" } : null });
    const ensBtn = stormPopup.getElement().querySelector(".mc-ens");
    if (ensBtn) ensBtn.addEventListener("click", () => {
      const on = ensBtn.getAttribute("aria-pressed") !== "true";
      ensBtn.setAttribute("aria-pressed", String(on));
      showEns(on ? p.id : "");
    });
    stormPopup.on("close", () => { showPast(""); showEns(""); });
  }
  WX.openStormCard = openStormCard;
  function clearStorms() {
    if (stormPopup) { stormPopup.remove(); stormPopup = null; } ["storm-lbl", "storm-eye", "storm-now", "storm-pts", "storm-past-pts", "storm-past", "storm-track", "storm-ens", "storm-cone-line", "storm-cone"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("storms")) M().removeSource("storms"); }

  // ── satellite: GOES GeoColor via NASA GIBS (timeless URL = latest) ────
  function loadSat() {
    for (const [id, name] of [["sat-east", "GOES-East_ABI_GeoColor"], ["sat-west", "GOES-West_ABI_GeoColor"]]) {
      if (M().getSource(id)) continue;
      M().addSource(id, { type: "raster", tileSize: 256, maxzoom: 7, attribution: "Satellite: NASA GIBS / NOAA GOES",
        tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${name}/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png?t=${Math.floor(Date.now() / 6e5)}`] });
      M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, "wx");
    }
    // The imagery is the point here: the field steps well back, and a badge
    // says what the pixels are and where they end, so a hard disc edge over
    // Asia reads as coverage, not a bug.
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.3, LAYER_ALPHA[state.layer]));
    badge("sat", `Satellite <b>GOES GeoColor</b> <small>~1 h old · Americas + Pacific only</small>`, "#9fb0c8");
  }
  function clearSat() { ["sat-east", "sat-west"].forEach((l) => { if (M().getLayer(l)) M().removeLayer(l); if (M().getSource(l)) M().removeSource(l); }); badge("sat", null); WX.fn.applyStep(); }

  // ── corner badges ─────────────────────────────────────────────────────
  // A keyed stack of small chips bottom-left, above the met-service badge:
  // "which radar am I looking at", "which aurora nowcast". Injected rather
  // than added to styles.css so each module carries its own presentation;
  // the values are the app's own tokens, so it follows the theme.
  const BADGE_CSS = `
  #wx-badges { position: absolute; z-index: 5; left: 62px; bottom: calc(var(--tb-h, 150px) + 14px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; align-items: flex-start; gap: 5px; pointer-events: none; }
  .wx-badge { display: inline-flex; align-items: baseline; gap: 7px; max-width: min(46vw, 420px);
    padding: 5px 11px; border-radius: 999px; background: var(--panel, rgba(12,14,18,.72)); border: 1px solid var(--line, rgba(255,255,255,.09));
    backdrop-filter: blur(8px); font: 700 11.5px var(--font-display, system-ui, sans-serif); color: var(--fg-2, #c3cad6); letter-spacing: .01em; }
  .wx-badge i { font-style: normal; width: 8px; height: 8px; border-radius: 50%; align-self: center; flex: 0 0 8px; box-shadow: 0 0 10px currentColor; }
  .wx-badge small { font: 600 10px var(--font-mono, ui-monospace, monospace); color: var(--dim, #7c8492); }
  .wx-badge b { color: var(--fg, #eef1f5); font-weight: 700; }
  @media (max-width: 820px) { #wx-badges { left: 12px; bottom: calc(var(--tb-h, 150px) + 22px + env(safe-area-inset-bottom)); } }
  `;
  function badgeBox() {
    let box = $("#wx-badges");
    if (!box) {
      const st = document.createElement("style"); st.id = "wx-badges-css"; st.textContent = BADGE_CSS;
      document.head.appendChild(st);
      box = document.createElement("div"); box.id = "wx-badges";
      (document.querySelector("#map") || document.body).appendChild(box);
    }
    return box;
  }
  // badge(key, html, color) — html null removes it. Keys keep the stack stable
  // so the radar chip doesn't jump when the aurora chip appears.
  function badge(key, html, color) {
    const box = badgeBox();
    let el = box.querySelector(`[data-badge="${key}"]`);
    if (html == null) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.className = "wx-badge"; el.dataset.badge = key; box.appendChild(el); }
    el.innerHTML = `<i style="color:${color || "var(--accent, #ff8a3d)"};background:currentColor"></i>${html}`;
  }

  // ── radar ─────────────────────────────────────────────────────────────
  // Agency composites where they exist, RainViewer everywhere else. The API
  // hands us every source with its frame timestamps and tile-URL templates
  // plus the id this map centre should prefer; we walk its fallback chain
  // until one has frames, so a dead upstream degrades instead of breaking the
  // toggle. Frames keep RainViewer's shape ({time, kind}) because tape.js
  // renders the strip straight off state.radarFrames.
  const RADAR_MAX_SUBLAYERS = 4;          // ECCC needs two (rain + snow)
  let radarReq = 0, radarMoveTimer = null;

  async function toggleRadar() {
    state.radar = !state.radar;
    if (state.radar && WX.fn.clearOtherCover) WX.fn.clearOtherCover("radar");
    $("#radar-toggle").classList.toggle("on", state.radar);
    if (!state.radar) { clearRadar(); WX.tape.renderTape(); WX.fn.applyStep(); return; }
    if (WX.fn.setTapeState) WX.fn.setTapeState("mini", false);
    await loadRadar();
  }

  // Only the outermost sources call: RainViewer straight from the browser, for
  // when our own API is the thing that is down.
  async function rainviewerDirect() {
    const j = await (await fetch(RAINVIEWER, { cache: "no-store" })).json();
    const frames = [...(j.radar.past || []).map((x) => ({ time: x.time, token: x.path, kind: "past" })),
                    ...(j.radar.nowcast || []).map((x) => ({ time: x.time, token: x.path, kind: "nowcast" }))];
    return { id: "rainviewer", label: "RainViewer", detail: "Global composite · last 2 h plus nowcast",
             attribution: "Radar © RainViewer", frames, templates: [`${j.host}{token}/256/{z}/{x}/{y}/2/1_1.png`] };
  }

  async function loadRadar(quiet) {
    const my = ++radarReq;
    const c = M().getCenter();
    let picked = null, catalog = null;
    try {
      catalog = await WX.api(U(`${API}/radar/sources?lat=${c.lat.toFixed(3)}&lon=${WX.wlon(c.lng).toFixed(3)}`));
      const byId = Object.fromEntries((catalog.sources || []).map((s) => [s.id, s]));
      for (const id of catalog.order || []) { const s = byId[id]; if (s && s.frames && s.frames.length) { picked = s; break; } }
      if (!picked) picked = (catalog.sources || []).find((s) => s.frames && s.frames.length) || null;
    } catch (e) { /* our API is down; go straight to the source below */ }
    if (!picked) { try { picked = await rainviewerDirect(); } catch (e) { /* nothing left */ } }
    if (my !== radarReq || !state.radar) return;
    if (!picked) {
      WX.fn.toast("No radar source answered", 4500, "error");
      state.radar = false; $("#radar-toggle").classList.remove("on"); clearRadar();
      return;
    }
    // Keep the same valid time across a source swap where we can, so panning
    // over the border doesn't jump the loop back to the start.
    const wasAt = state.radarFrames.length ? state.radarFrames[state.radarIdx] : null;
    const changed = !state.radarSource || state.radarSource.id !== picked.id;
    state.radarSource = picked;
    state.radarFrames = picked.frames.map((f) => ({ ...f, kind: f.kind || "past" }));
    const lastPast = state.radarFrames.map((f) => f.kind).lastIndexOf("past");
    state.radarIdx = lastPast >= 0 ? lastPast : state.radarFrames.length - 1;
    if (wasAt) {
      let best = state.radarIdx, err = Infinity;
      state.radarFrames.forEach((f, i) => { const d = Math.abs(f.time - wasAt.time); if (d < err) { err = d; best = i; } });
      if (err < 1800) state.radarIdx = best;
    }
    if (changed) clearRadarLayers();      // colour tables differ; don't cross-fade them
    applyRadarFrame();
    WX.tape.renderTape();
    const failed = (catalog && (catalog.sources || []).filter((s) => s.error).map((s) => s.id)) || [];
    if (!quiet) {
      const span = state.radarFrames.length ? Math.round((state.radarFrames[state.radarFrames.length - 1].time - state.radarFrames[0].time) / 60) : 0;
      WX.fn.toast(`${picked.label} · ${state.radarFrames.length} frames, ${span} min`
        + (failed.length ? ` (${failed.join(", ")} unavailable, fell back)` : ""), 5500);
    }
  }

  // Re-pick when the map moves far enough to change country. Debounced, and
  // the API caches frame lists for two minutes, so panning is cheap.
  function refreshRadarSource() {
    if (!state.radar) return;
    clearTimeout(radarMoveTimer);
    radarMoveTimer = setTimeout(() => loadRadar(true), 600);
  }

  // Only {token} is ours; {z}/{x}/{y} and {bbox-epsg-3857} belong to MapLibre.
  function radarTiles(fr) {
    const src = state.radarSource;
    if (!src || !fr) return [];
    return (src.templates || []).map((t) => t.split("{token}").join(fr.token == null ? "" : fr.token));
  }

  function applyRadarFrame() {
    const src = state.radarSource, fr = state.radarFrames[state.radarIdx];
    if (!src || !fr) return;
    const urls = radarTiles(fr);
    urls.slice(0, RADAR_MAX_SUBLAYERS).forEach((u, i) => {
      const id = `radar-${i}`;
      if (M().getSource(id)) M().getSource(id).setTiles([u]);
      else {
        M().addSource(id, { type: "raster", tiles: [u], tileSize: 256, attribution: src.attribution });
        M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
    });
    for (let i = urls.length; i < RADAR_MAX_SUBLAYERS; i++) dropLayer(`radar-${i}`);
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.45, LAYER_ALPHA[state.layer]));
    const t = new Date(fr.time * 1000);
    $("#valid-local").textContent = t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) + (fr.kind === "nowcast" ? " · nowcast" : " · radar");
    $("#valid-utc").textContent = t.toISOString().slice(11, 16) + "Z";
    const ageMin = Math.round((Date.now() / 1000 - fr.time) / 60);
    $("#lead").textContent = ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`;
    badge("radar", `Radar <b>${src.label}</b> <small>${t.toISOString().slice(11, 16)}Z${fr.kind === "nowcast" ? " nowcast" : ""}</small>`, "var(--rain, #6cb6ff)");
    WX.tape.renderTapeSelection();
  }

  function dropLayer(id) { if (M().getLayer(id)) M().removeLayer(id); if (M().getSource(id)) M().removeSource(id); }
  function clearRadarLayers() { dropLayer("radar"); for (let i = 0; i < RADAR_MAX_SUBLAYERS; i++) dropLayer(`radar-${i}`); }
  function clearRadar() {
    clearTimeout(radarMoveTimer); radarReq++;
    clearRadarLayers();
    state.radarFrames = []; state.radarSource = null;
    badge("radar", null);
  }

  // ── measure tool: two taps → distance (km / nm) and true bearing ──────
  let measurePts = [];
  function measureClick(ll) {
    measurePts.push([ll.lng, ll.lat]);
    if (measurePts.length > 2) measurePts = [[ll.lng, ll.lat]];
    const gj = { type: "FeatureCollection", features: measurePts.length === 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: measurePts } }] : [] };
    if (M().getSource("measure")) M().getSource("measure").setData(gj);
    else { M().addSource("measure", { type: "geojson", data: gj }); M().addLayer({ id: "measure-line", type: "line", source: "measure", paint: { "line-color": "#ffb454", "line-width": 2, "line-dasharray": [1.5, 1.5] } }); }
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
  function clearMeasure() { measurePts = []; $("#measure").hidden = true; if (M().getLayer("measure-line")) M().removeLayer("measure-line"); if (M().getSource("measure")) M().removeSource("measure"); }

  // ── smoke / fires / quakes ────────────────────────────────────────────
  const WMS = (layer, base) => `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES=`;
  function loadSmoke() {
    if (M().getSource("smoke")) return;
    M().addSource("smoke", { type: "raster", tileSize: 256, attribution: "Smoke/PM2.5: ECCC RAQDPS", tiles: [WMS("RAQDPS.SFC_PM2.5", "https://geo.weather.gc.ca/geomet")] });
    M().addLayer({ id: "smoke", type: "raster", source: "smoke", paint: { "raster-opacity": 0.6, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    toast("Smoke · surface PM2.5, ECCC RAQDPS", 4500);
  }
  function clearSmoke() { if (M().getLayer("smoke")) M().removeLayer("smoke"); if (M().getSource("smoke")) M().removeSource("smoke"); }
  function loadFires() {
    if (M().getSource("fires")) return;
    M().addSource("fires", { type: "raster", tileSize: 256, attribution: "Hotspots: NRCan CWFIS", tiles: [WMS("public:hotspots_last24hrs", "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms")] });
    M().addLayer({ id: "fires", type: "raster", source: "fires", paint: { "raster-opacity": 0.95, "raster-fade-duration": 0 } });
    toast("Hotspots, last 24 h · NRCan CWFIS", 4500);
  }
  function clearFires() { if (M().getLayer("fires")) M().removeLayer("fires"); if (M().getSource("fires")) M().removeSource("fires"); }
  async function loadQuakes() {
    try {
      const gj = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson").then((r) => r.json());
      if (!state.quakes) return;
      // tiles keep only lon/lat — the depth in the third coordinate is gone
      // by the time a click hands the feature back, so remember it by id
      quakeDepth = Object.fromEntries(gj.features.map((q) => [q.id || q.properties.ids, q.geometry.coordinates[2]]));
      if (M().getSource("quakes")) M().getSource("quakes").setData(gj);
      else {
        M().addSource("quakes", { type: "geojson", data: gj });
        M().addLayer({ id: "quakes", type: "circle", source: "quakes", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 4, 5, 9, 7, 18], "circle-color": ["interpolate", ["linear"], ["get", "mag"], 2.5, "#f5d33c", 5, "#e8590c", 7, "#b30000"], "circle-opacity": 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
        M().on("click", "quakes", (e) => {
          const f = e.features[0], p = f.properties;
          const mag = Number(p.mag);
          const col = mag >= 7 ? "#ff6a5e" : mag >= 5 ? "#e8590c" : "#e3c53c";
          const ago = (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 86400e3)} d ago`)(Date.now() - p.time);
          const depth = quakeDepth[f.id || p.ids] ?? f.geometry.coordinates[2] ?? null;
          if (quakePopup) quakePopup.remove();
          quakePopup = mapCard(f.geometry.coordinates.slice(0, 2), "eq-pop", {
            icon: QUAKE_SVG, color: col, title: `M${mag.toFixed(1)}`, titleColor: col,
            pill: mag >= 7 ? "major" : mag >= 5 ? "moderate" : "light", sub: p.place || "", ago,
            hero: [depth != null && { k: "Depth", v: Math.round(depth), unit: "km" },
                   Number(p.felt) > 0 && { k: "Felt", v: p.felt, unit: "reports" },
                   Number(p.tsunami) === 1 && { k: "Tsunami", v: "advisory" }],
            rows: [["Time", new Date(p.time).toLocaleString()], ["Source", "USGS"]],
            link: p.url ? { href: p.url, text: "USGS event page" } : null, maxWidth: "290px" });
        });
        M().on("mouseenter", "quakes", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "quakes", () => { M().getCanvas().style.cursor = ""; });
      }
      toast(`${gj.features.length} quakes M2.5+, 24 h · USGS`, 4000);
    } catch (e) { toast("USGS feed unavailable", 4000, "error"); }
  }
  // ── aerosol optical depth: MODIS Terra+Aqua combined, yesterday (NASA GIBS)
  function loadAod() {
    if (M().getSource("aod")) return;
    const d = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    M().addSource("aod", { type: "raster", tileSize: 256, maxzoom: 6, attribution: "Aerosol: NASA GIBS MODIS",
      tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/${d}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`] });
    M().addLayer({ id: "aod", type: "raster", source: "aod", paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    toast(`Aerosol depth · MODIS ${d}`, 5000);
  }
  function clearAod() { if (M().getLayer("aod")) M().removeLayer("aod"); if (M().getSource("aod")) M().removeSource("aod"); }

  // ── thunder marks: model CAPE + rain at the shown step ─────────────────
  let thunderReq = 0;
  async function loadThunder() {
    const my = ++thunderReq;
    try {
      const gj = await WX.api(`${API}/thunder/${state.model}/${state.run}/${WX.stepHours}.json`);
      if (my !== thunderReq || !state.thunder) return;
      if (M().getSource("thunder")) M().getSource("thunder").setData(gj);
      else {
        M().addSource("thunder", { type: "geojson", data: gj });
        if (!M().hasImage("bolt")) M().addImage("bolt", boltIcon(), { pixelRatio: 2 });
        M().addLayer({ id: "thunder", type: "symbol", source: "thunder", layout: { "icon-image": "bolt", "icon-size": ["interpolate", ["linear"], ["get", "cape"], 800, 0.55, 3000, 1.0], "icon-allow-overlap": true, "icon-ignore-placement": true },
                       paint: { "icon-opacity": 0.95 } });
      }
    } catch (e) { if (my === thunderReq) toast("No thunder marks for this model", 4000, "error"); }
  }
  // A yellow lightning bolt with a dark outline, drawn once into a canvas.
  // The hurricane symbol, tinted, with a dark eye the category text sits in.
  // Same path as CYCLONE_SVG in panes.js. Known category colours get an
  // image each at load; an unknown colour falls back to the red.
  const CYCLONE_PATH = "M12.50 2.16A7.9 7.9 0 1 1 4.57 13.80A7.1 7.1 0 1 0 12.50 2.16ZM11.50 21.84A7.9 7.9 0 1 1 19.43 10.20A7.1 7.1 0 1 0 11.50 21.84ZM17.8 12A5.8 5.8 0 1 1 6.2 12A5.8 5.8 0 1 1 17.8 12ZM14.9 12A2.9 2.9 0 1 0 9.1 12A2.9 2.9 0 1 0 14.9 12Z";
  const STORM_COLORS = ["#ff5b45", "#ff7a3d", "#ffa23c", "#ffc94d", "#ffe873", "#9fd0ff", "#8fb4d9", "#9aa4b2", "#ef786f"];
  function cycloneIcon(color) {
    const S = 80, c = document.createElement("canvas"); c.width = S; c.height = S; const x = c.getContext("2d");
    const P = new Path2D(CYCLONE_PATH);
    // same mirror + tilt as CYCLONE_SVG in panes.js
    x.translate(S / 2, S / 2); x.scale(S / 24, S / 24); x.rotate(55 * Math.PI / 180); x.scale(-1, 1); x.translate(-12, -12);
    x.lineJoin = "round"; x.lineWidth = 1.6; x.strokeStyle = "rgba(0,0,0,.7)"; x.stroke(P);
    x.fillStyle = color; x.fill(P);
    x.beginPath(); x.arc(12, 12, 4.3, 0, Math.PI * 2); x.fillStyle = "#10131a"; x.fill();
    return x.getImageData(0, 0, S, S);
  }
  function boltIcon() {
    const c = document.createElement("canvas"); c.width = 44; c.height = 44; const x = c.getContext("2d");
    const P = new Path2D("M25 3 L9 25 L21 25 L17 41 L35 17 L23 17 Z");
    x.lineJoin = "round"; x.lineWidth = 5; x.strokeStyle = "rgba(0,0,0,.65)"; x.stroke(P);
    x.fillStyle = "#ffd54a"; x.fill(P);
    return x.getImageData(0, 0, 44, 44);
  }
  function clearThunder() { if (M().getLayer("thunder")) M().removeLayer("thunder"); if (M().getSource("thunder")) M().removeSource("thunder"); }

  function clearQuakes() { if (M().getLayer("quakes")) M().removeLayer("quakes"); if (M().getSource("quakes")) M().removeSource("quakes"); }

  WX.ov = { loadImagery, clearImagery, setBase, loadTerrain, clearTerrain, updateNight, clearNight, loadSmoke, clearSmoke, loadFires, clearFires, loadQuakes, clearQuakes, loadAod, clearAod, loadThunder, clearThunder, toggleRadar, loadIso, clearIso, isoVar, loadAvy, clearAvy, loadResorts, clearResorts, selectResort, loadAlerts, clearAlerts, loadStorms, clearStorms, loadSat, clearSat, applyRadarFrame, measureClick, clearMeasure, radarTiles,
             loadRadar, clearRadar, refreshRadarSource, badge };
})();
