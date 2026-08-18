// Map overlays: radar, isolines, avalanche regions, resorts + lifts, alerts,
// tropical systems, satellite, measure tool. Loaded after app.js; talks to it
// through window.WX (map/state/helpers) and exposes itself as WX.ov.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
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
    const url = U(`${API}/isolines/${state.model}/${state.run}/${WX.fn.stepHours()}/${v.includes("?") ? v.replace("?", ".json?") : v + ".json"}`);
    try {
      const gj = await WX.api(url);
      if (my !== isoReq || !state.iso) return;
      if (M().getSource("iso")) M().getSource("iso").setData(gj);
      else {
        M().addSource("iso", { type: "geojson", data: gj });
        M().addLayer({ id: "iso-line", type: "line", source: "iso", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": ["case", ["==", ["%", ["get", "value"], ["*", 4, gj.interval || 4]], 0], 1.4, 0.7] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "iso-label", type: "symbol", source: "iso", layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Regular"], "symbol-spacing": 320 }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.7)", "text-halo-width": 1.2 } });
      }
    } catch (e) { WX.fn.toast("Isolines unavailable for this layer", 4000, "error"); }
  }
  function clearIso() { ["iso-label", "iso-line"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("iso")) M().removeSource("iso"); }

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
      WX.fn.toast(rated ? `Avalanche regions: ${rated} with a current rating` : "Avalanche regions loaded — off season, no current ratings (forecasts resume ~November)", 5000);
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
      const bnd = d.boundary ? { type: "FeatureCollection", features: [d.boundary] } : { type: "FeatureCollection", features: [] };
      if (M().getSource("bnd")) M().getSource("bnd").setData(bnd);
      else { M().addSource("bnd", { type: "geojson", data: bnd }); M().addLayer({ id: "bnd-line", type: "line", source: "bnd", paint: { "line-color": "#ffb454", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, WX.fn.firstSymbolId()); }
      M().flyTo({ center: [r.lon, r.lat], zoom: Math.max(M().getZoom(), 10.5), duration: 900 });
      state.tab = "resort";
      WX.fn.openPoint(r.lat, r.lon, r.name);
    } catch (e) { WX.fn.toast("Resort detail unavailable", 4000, "error"); }
  }
  WX.selectResort = selectResort;

  // ── alerts: NWS polygons (GeoJSON) + Environment Canada (GeoMet WMS) ─
  async function loadAlerts() {
    try {
      const gj = await WX.api(`${API}/alerts/layer`);
      if (!state.alerts) return;
      if (M().getSource("alerts")) M().getSource("alerts").setData(gj);
      else {
        M().addSource("alerts", { type: "geojson", data: gj });
        M().addLayer({ id: "alerts-fill", type: "fill", source: "alerts", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.28 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-line", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": 1.6 } }, WX.fn.firstSymbolId());
        M().on("click", "alerts-fill", (e) => { const p = e.features[0].properties; WX.fn.toast(`${p.event} · ${p.area}`.slice(0, 160), 6000); });
      }
      if (!M().getSource("ec-alerts")) {
        M().addSource("ec-alerts", { type: "raster", tileSize: 256, attribution: "Alerts © Environment Canada",
          tiles: ["https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ALERTS&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES="] });
        M().addLayer({ id: "ec-alerts", type: "raster", source: "ec-alerts", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
      WX.fn.toast(`Alerts: ${gj.features.length} NWS polygon alerts + Environment Canada layer`, 4000);
    } catch (e) { WX.fn.toast("Alerts unavailable", 4000, "error"); state.alerts = false; $("#alerts-toggle").classList.remove("on"); }
  }
  function clearAlerts() { ["alerts-line", "alerts-fill", "ec-alerts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); ["alerts", "ec-alerts"].forEach((sname) => M().getSource(sname) && M().removeSource(sname)); }

  // ── tropical systems (NHC): cone, track, current position ─────────────
  async function loadStorms() {
    try {
      const gj = await WX.api(`${API}/storms`);
      if (!state.storms) return;
      if (M().getSource("storms")) M().getSource("storms").setData(gj);
      else {
        M().addSource("storms", { type: "geojson", data: gj });
        M().addLayer({ id: "storm-cone", type: "fill", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "fill-color": "#ffb454", "fill-opacity": 0.18 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "storm-cone-line", type: "line", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "line-color": "#ffb454", "line-width": 1.2 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "storm-track", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "#fff", "line-width": 2 } });
        M().addLayer({ id: "storm-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
        M().addLayer({ id: "storm-now", type: "circle", source: "storms", filter: ["==", ["get", "kind"], "current"], paint: { "circle-radius": 9, "circle-color": "#ef786f", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        M().addLayer({ id: "storm-lbl", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"], layout: { "text-field": ["concat", ["get", "class"], " ", ["get", "name"], "\n", ["get", "intensity_kt"], " kt"], "text-size": 12, "text-offset": [0, 1.4], "text-anchor": "top", "text-font": ["Noto Sans Bold"] }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.4 } });
        M().on("click", "storm-now", (e) => { const p = e.features[0].properties; WX.fn.toast(`${p.class} ${p.name} · ${p.intensity_kt} kt · ${p.pressure_mb} mb · moving ${p.movement} · adv ${p.advisory}`, 8000); });
      }
      const names = (gj.storms || []).map((x) => `${x.class} ${x.name}`).join(", ");
      WX.fn.toast(names ? `Active: ${names}` : "No active tropical systems (NHC/CPHC)", 5000);
      if (gj.storms && gj.storms.length && !state.point) { const st = gj.storms[0]; const f = gj.features.find((x) => x.properties.kind === "current" && x.properties.id === st.id); if (f) M().flyTo({ center: f.geometry.coordinates, zoom: Math.max(3.5, Math.min(M().getZoom(), 5)), duration: 1200 }); }
    } catch (e) { WX.fn.toast("Storm feed unavailable", 4000, "error"); state.storms = false; $("#storms-toggle").classList.remove("on"); }
  }
  function clearStorms() { ["storm-lbl", "storm-now", "storm-pts", "storm-track", "storm-cone-line", "storm-cone"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("storms")) M().removeSource("storms"); }

  // ── satellite: GOES GeoColor via NASA GIBS (timeless URL = latest) ────
  function loadSat() {
    for (const [id, name] of [["sat-east", "GOES-East_ABI_GeoColor"], ["sat-west", "GOES-West_ABI_GeoColor"]]) {
      if (M().getSource(id)) continue;
      M().addSource(id, { type: "raster", tileSize: 256, maxzoom: 7, attribution: "Satellite: NASA GIBS / NOAA GOES",
        tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${name}/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png?t=${Math.floor(Date.now() / 6e5)}`] });
      M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, "wx");
    }
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.5, LAYER_ALPHA[state.layer]));
    WX.fn.toast("Satellite: GOES-East/West GeoColor, latest available (~1 h lag). Americas + Pacific.", 5000);
  }
  function clearSat() { ["sat-east", "sat-west"].forEach((l) => { if (M().getLayer(l)) M().removeLayer(l); if (M().getSource(l)) M().removeSource(l); }); WX.fn.applyStep(); }

  // ── radar (RainViewer) ────────────────────────────────────────────────
  async function toggleRadar() {
    state.radar = !state.radar;
    $("#radar-toggle").classList.toggle("on", state.radar);
    if (!state.radar) {
      if (M().getLayer("radar")) M().removeLayer("radar");
      if (M().getSource("radar")) M().removeSource("radar");
      state.radarFrames = [];
      WX.tape.renderTape(); WX.fn.applyStep();
      return;
    }
    try {
      const j = await (await fetch(RAINVIEWER, { cache: "no-store" })).json();
      state.radarHost = j.host;
      state.radarFrames = [...j.radar.past.map((x) => ({ ...x, kind: "past" })), ...j.radar.nowcast.map((x) => ({ ...x, kind: "nowcast" }))];
      state.radarIdx = j.radar.past.length - 1;
      applyRadarFrame();
      WX.tape.renderTape();
      WX.fn.toast("Radar: RainViewer composite, last 2 h + 30 min nowcast. Coverage where radars exist.", 5000);
    } catch (e) { WX.fn.toast("Radar unavailable right now", 4000, "error"); state.radar = false; $("#radar-toggle").classList.remove("on"); }
  }
  function radarTiles(fr) { return [`${state.radarHost}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`]; }
  function applyRadarFrame() {
    const fr = state.radarFrames[state.radarIdx];
    if (!fr) return;
    if (M().getSource("radar")) M().getSource("radar").setTiles(radarTiles(fr));
    else {
      M().addSource("radar", { type: "raster", tiles: radarTiles(fr), tileSize: 256, attribution: "Radar © RainViewer" });
      M().addLayer({ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    }
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.45, LAYER_ALPHA[state.layer]));
    const t = new Date(fr.time * 1000);
    $("#valid-local").textContent = t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) + (fr.kind === "nowcast" ? " · nowcast" : " · radar");
    $("#valid-utc").textContent = t.toISOString().slice(11, 16) + "Z";
    const ageMin = Math.round((Date.now() / 1000 - fr.time) / 60);
    $("#lead").textContent = ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`;
    WX.tape.renderTapeSelection();
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
    toast("Smoke: surface PM2.5 forecast (ECCC RAQDPS), North America, latest model hour", 4500);
  }
  function clearSmoke() { if (M().getLayer("smoke")) M().removeLayer("smoke"); if (M().getSource("smoke")) M().removeSource("smoke"); }
  function loadFires() {
    if (M().getSource("fires")) return;
    M().addSource("fires", { type: "raster", tileSize: 256, attribution: "Hotspots: NRCan CWFIS", tiles: [WMS("public:hotspots_last24hrs", "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms")] });
    M().addLayer({ id: "fires", type: "raster", source: "fires", paint: { "raster-opacity": 0.95, "raster-fade-duration": 0 } });
    toast("Fires: satellite hotspots, last 24 h (NRCan CWFIS — Canada + border states)", 4500);
  }
  function clearFires() { if (M().getLayer("fires")) M().removeLayer("fires"); if (M().getSource("fires")) M().removeSource("fires"); }
  async function loadQuakes() {
    try {
      const gj = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson").then((r) => r.json());
      if (!state.quakes) return;
      if (M().getSource("quakes")) M().getSource("quakes").setData(gj);
      else {
        M().addSource("quakes", { type: "geojson", data: gj });
        M().addLayer({ id: "quakes", type: "circle", source: "quakes", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 4, 5, 9, 7, 18], "circle-color": ["interpolate", ["linear"], ["get", "mag"], 2.5, "#f5d33c", 5, "#e8590c", 7, "#b30000"], "circle-opacity": 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
        M().on("click", "quakes", (e) => { const p = e.features[0].properties; toast(`M${p.mag} · ${p.place} · ${new Date(p.time).toLocaleString()}`, 7000); });
      }
      toast(`Quakes: ${gj.features.length} events M2.5+ in the past day (USGS)`, 4000);
    } catch (e) { toast("USGS feed unavailable", 4000, "error"); }
  }
  function clearQuakes() { if (M().getLayer("quakes")) M().removeLayer("quakes"); if (M().getSource("quakes")) M().removeSource("quakes"); }

  WX.ov = { loadSmoke, clearSmoke, loadFires, clearFires, loadQuakes, clearQuakes, toggleRadar, loadIso, clearIso, isoVar, loadAvy, clearAvy, loadResorts, clearResorts, selectResort, loadAlerts, clearAlerts, loadStorms, clearStorms, loadSat, clearSat, applyRadarFrame, measureClick, clearMeasure, radarTiles };
})();
