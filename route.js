// Route forecast — the weather where you will be, when you will be there.
// Draw a path on the map, say when you leave and how fast you move, and the
// strip chart under the map shows what the run says at each point's own valid
// time, with the bad stretches shaded. Everything comes from /api/route.
//
// Also carries the PWA bootstrap at the bottom (service-worker registration +
// the offline banner) — it is a dozen lines and needs a script tag, and this
// file already has one. Marked clearly; lift it into app.js whenever.
(function () {
  "use strict";
  const WX = window.WX;
  if (!WX) return;                      // app.js owns the namespace; nothing to hang off yet
  const $ = (s) => document.querySelector(s);
  const M = () => WX.map;

  // ── units ──────────────────────────────────────────────────────────────
  // Everything numeric goes through WX.units when it is there. It is resolved
  // per call, not captured at load: units.js may be a later script tag, and a
  // build could ship without it — in which case these fall back to the SI-ish
  // units the API itself returns.
  const U = () => window.WX && window.WX.units;
  const uTemp = (k, d) => (k == null ? null : (U() && U().temp ? U().temp(k, d) : { v: k - 273.15, unit: "°C" }));
  const uDist = (km, d) => (km == null ? null : (U() && U().dist ? U().dist(km, d) : { v: km, unit: "km" }));
  const uPrecip = (mm, d) => (mm == null ? null : (U() && U().precip ? U().precip(mm, d) : { v: mm, unit: "mm" }));
  const uPress = (pa) => (pa == null ? null : (U() && U().press ? U().press(pa) : { v: pa / 100, unit: "hPa" }));
  const uAlt = (m) => (m == null ? null : (U() && U().alt ? U().alt(m) : { v: Math.round(m), unit: "m" }));
  // Snowfall arrives as mm water-equivalent; the app's snow unit is cm at the
  // same 10:1 the sf6 ramp uses, so the number passes through unscaled.
  const uSnow = (mmwe) => (mmwe == null ? null : (U() && U().snow ? U().snow(mmwe) : { v: mmwe, unit: "cm" }));
  const uTime = (iso, extra) => (U() && U().time ? U().time(iso, extra)
    : new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(extra || {}) }));
  const uWhen = (iso) => (U() && U().dateTime ? U().dateTime(iso, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }));
  const spd = (ms) => (ms == null ? null : WX.speed(ms));
  const spdUnit = () => WX.speedUnit();
  // Travel speed is typed in whatever unit the wind is shown in; the API wants
  // km/h. WX.speed(1) is "display units per m/s", so this inverts cleanly for
  // every unit the app supports without a second conversion table.
  const toKmh = (v) => v * 3.6 / (WX.speed(1) || 3.6);
  const fromKmh = (kmh) => kmh / 3.6 * (WX.speed(1) || 3.6);
  const n1 = (x) => (x == null ? "—" : (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10));

  const MODES = [
    { key: "walk", label: "Walk", kmh: 5 },
    { key: "run", label: "Run", kmh: 10 },
    { key: "bike", label: "Bike", kmh: 22 },
    { key: "sail", label: "Sail", kmh: 12 },
    { key: "drive", label: "Drive", kmh: 90 },
    { key: "fly", label: "Fly", kmh: 700 },
  ];
  const HAZ_LABEL = { gust: "gusts", rain: "heavy rain", snow: "snow", ice: "freezing rain", freezing: "below freezing level", vis: "poor visibility" };

  let pts = [];                 // route vertices, [lon, lat]
  let data = null;              // last /api/route payload
  let markers = [];             // vertex + midpoint handles
  let req = 0, hoverI = null, selI = null, active = false, loading = false;
  let speedKmh = Number(localStorage.getItem("wxgrid.routeSpeed") || 90);
  let departISO = null;
  let styleWatch = null;

  // ── styles ─────────────────────────────────────────────────────────────
  // The strip reuses the forecast tape's own table classes (`wtape`, `r-hour`,
  // `r-wind`, …) so a colour in the route means the colour in the tape and on
  // the map. Only the route-specific parts — the head, the controls, the
  // hazard ribbon, the waypoint pips — are defined here.
  const style = document.createElement("style");
  style.textContent = `
  /* The panel is as wide as the strip needs and no wider: a six-stop walk in a
     full-width slab is mostly empty slab. It still caps at the viewport, and
     the strip scrolls inside it once the route is long. */
  #wxr { position: absolute; left: 12px; bottom: calc(var(--tb-h) + 22px + env(safe-area-inset-bottom)); z-index: 7;
         width: fit-content; min-width: min(520px, calc(100vw - 24px)); max-width: calc(100vw - 24px);
         background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(10px);
         padding: 10px 12px 7px; box-shadow: 0 20px 60px rgba(0,0,0,.45); color: var(--fg); }
  #wxr[hidden] { display: none; }
  #wxr .wxr-head { display: flex; align-items: center; gap: 8px 18px; flex-wrap: wrap; padding-right: 28px; }
  #wxr .wxr-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  #wxr .wxr-title { font: 800 17px/1.1 var(--font-display); letter-spacing: -.01em; }
  #wxr .wxr-run { font: 700 9px var(--font-display); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  #wxr .wxr-hero { display: flex; gap: 4px 18px; flex-wrap: wrap; }
  #wxr .wxr-hero div { display: flex; flex-direction: column; gap: 1px; }
  #wxr .wxr-hero small { font: 600 9px var(--font-display); text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
  #wxr .wxr-hero b { font: 800 19px/1.05 var(--font-num); color: var(--fg); font-variant-numeric: tabular-nums; }
  #wxr .wxr-hero b i { font: 700 10px var(--font-display); font-style: normal; margin-left: 2px; color: var(--fg-2); }
  #wxr .wxr-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; justify-content: flex-end; }
  #wxr .wxr-chip { display: inline-flex; align-items: center; font: 700 10.5px var(--font-display); letter-spacing: .02em;
                   color: var(--fg-2); border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; white-space: nowrap; }
  #wxr .wxr-chip.warn { color: var(--warm); border-color: color-mix(in srgb, var(--warm) 45%, transparent); background: color-mix(in srgb, var(--warm) 10%, transparent); }
  #wxr .wxr-chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 50%, transparent); background: color-mix(in srgb, var(--bad) 12%, transparent); }

  #wxr .wxr-ctls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  #wxr .wxr-ctl { display: inline-flex; align-items: center; gap: 6px; font: 700 9px var(--font-display); letter-spacing: .06em;
                  text-transform: uppercase; color: var(--dim); background: rgba(127,127,127,.12);
                  border: 1px solid var(--line); border-radius: 9px; padding: 3px 8px; }
  #wxr .wxr-ctl input, #wxr .wxr-ctl select { background: transparent; border: 0; color: var(--fg); outline: none;
                  font: 600 12px var(--font-num); letter-spacing: 0; text-transform: none; }
  #wxr .wxr-ctl input[type=number] { width: 3.4em; text-align: right; }
  #wxr .wxr-ctl input[type=datetime-local] { color-scheme: dark; }
  :root[data-theme=light] #wxr .wxr-ctl input[type=datetime-local] { color-scheme: light; }
  #wxr .wxr-ctl select { cursor: pointer; }
  #wxr .wxr-ctl select option { background: var(--panel-solid); color: var(--fg); }
  #wxr .wxr-ctl b { font: 600 11px var(--font-display); color: var(--fg-2); text-transform: none; letter-spacing: 0; }
  #wxr button.wxr-mini { font: 700 10px var(--font-display); letter-spacing: .06em; text-transform: uppercase; color: var(--dim);
                         background: transparent; border: 1px solid var(--line); border-radius: 9px; padding: 5px 10px; cursor: pointer; }
  #wxr button.wxr-mini:hover { color: var(--fg); border-color: var(--line-strong); }
  #wxr .wxr-x { position: absolute; top: 6px; right: 8px; width: 24px; height: 24px; font-size: 13px; }
  #wxr .wxr-bests { display: inline-flex; gap: 5px; flex-wrap: wrap; }
  #wxr .wxr-pick { cursor: pointer; background: transparent; gap: 5px; }
  #wxr .wxr-pick small { font: 500 9.5px var(--font-num); color: var(--dim); text-transform: none; letter-spacing: 0; }
  #wxr .wxr-pick.best { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
  #wxr .wxr-bests .idle { font: 600 10px var(--font-display); color: var(--dim); }

  #wxr .wxr-strip { overflow-x: auto; overflow-y: hidden; margin-top: 7px; }
  #wxr table.wtape th.lab { background: transparent; }
  #wxr table.wtape td.past { opacity: .38; }
  #wxr table.wtape td.haz1 { background: color-mix(in srgb, var(--warm) 13%, transparent); }
  #wxr table.wtape td.haz2 { background: color-mix(in srgb, var(--bad) 15%, transparent); }
  #wxr table.wtape td.on { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-glow); }
  /* the hazard ribbon: one flat bar over the columns a warning covers */
  #wxr table.wtape tr.r-haz td { height: 6px; padding: 0 0 3px; background: transparent; cursor: default; }
  #wxr table.wtape tr.r-haz i { display: block; height: 3px; border-radius: 2px; background: transparent; }
  #wxr table.wtape tr.r-haz td.haz1 i { background: var(--warm); }
  #wxr table.wtape tr.r-haz td.haz2 i { background: var(--bad); }
  /* a waypoint you dropped, marked in the column nearest it */
  #wxr table.wtape tr.r-hour td.wpt::before { content: ""; position: absolute; left: 50%; top: 0; width: 5px; height: 5px;
    margin-left: -2.5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); }
  #wxr table.wtape tr.r-hour td { position: relative; }
  #wxr table.wtape tr.r-dist td { font: 500 10.5px var(--font-num); color: var(--dim); height: 17px; }
  #wxr table.wtape tr.r-cloud td { font: 600 11px var(--font-num); color: #9fb0c8; }
  #wxr table.wtape tr.r-vis td { font: 600 11px var(--font-num); color: var(--fg-2); }
  #wxr table.wtape tr.r-frz td { font: 600 11px var(--font-num); color: #7fd8e8; }

  #wxr .wxr-readout { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 12px; min-height: 17px;
                      margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line);
                      font: 500 11px var(--font-num); color: var(--fg-2); }
  #wxr .wxr-readout span { display: inline-flex; align-items: baseline; gap: 4px; }
  #wxr .wxr-readout i { font: 700 8.5px var(--font-display); font-style: normal; letter-spacing: .08em;
                        text-transform: uppercase; color: var(--dim); }
  #wxr .wxr-readout b { font-weight: 700; color: var(--fg); }
  #wxr .wxr-readout .f { color: var(--bad); font-weight: 700; }
  #wxr .wxr-readout .idle { color: var(--dim); font-weight: 500; }
  #wxr .wxr-hint { font: 600 12px var(--font-display); color: var(--dim); padding: 22px 4px; text-align: center; }

  .wxr-vertex { width: 15px; height: 15px; border-radius: 50%; background: var(--accent); border: 2.5px solid var(--panel-solid);
                box-shadow: 0 2px 8px rgba(0,0,0,.5); cursor: grab; }
  .wxr-vertex.end { background: var(--fg); }
  .wxr-ghost { width: 11px; height: 11px; border-radius: 50%; background: transparent; border: 2px dashed var(--accent);
               opacity: .55; cursor: cell; }
  .wxr-ghost:hover { opacity: 1; }
  @media (max-width: 820px) {
    #wxr { left: 6px; min-width: calc(100vw - 12px); max-width: calc(100vw - 12px); padding: 8px 8px 5px; }
    #wxr .wxr-head { gap: 6px 12px; padding-right: 24px; }
    #wxr .wxr-title { font-size: 15px; }
    #wxr .wxr-hero { gap: 4px 12px; }
    #wxr .wxr-hero b { font-size: 16px; }
    #wxr .wxr-chips .opt { display: none; }
    #wxr .wxr-ctls { margin-top: 6px; padding-top: 6px; }
    #wxr .wxr-ctl { padding: 2px 6px; }
    #wxr .wxr-ctl input, #wxr .wxr-ctl select { font-size: 11px; }
    /* The native datetime field wants a whole row to itself; it does not get one. */
    #wxr .wxr-ctl input[type=datetime-local] { width: 8.8em; }
    #wxr .wxr-ctl input[type=number] { width: 2.8em; }
    #wxr .wxr-chip { font-size: 10px; padding: 2px 7px; }
    #wxr table.wtape tr.r-dir, #wxr table.wtape tr.r-cloud, #wxr table.wtape tr.r-vis { display: none; }
    #wxr .wxr-readout { font-size: 10.5px; gap: 2px 9px; }
    #wxr .wxr-hint { padding: 14px 4px; font-size: 11px; }
  }
  `;
  document.head.appendChild(style);

  // ── panel ──────────────────────────────────────────────────────────────
  function box() {
    let el = $("#wxr");
    if (el) return el;
    el = document.createElement("div");
    el.id = "wxr"; el.hidden = true;
    el.innerHTML = `
      <div class="wxr-head">
        <div class="wxr-id"><span class="wxr-title">Route</span><span class="wxr-run"></span></div>
        <div class="wxr-hero"></div>
        <div class="wxr-chips"></div>
      </div>
      <button class="icon wxr-x" type="button" title="Close route" aria-label="Close route">×</button>
      <div class="wxr-ctls">
        <label class="wxr-ctl" title="Departure (local time)">Leave<input type="datetime-local" class="wxr-depart" aria-label="Departure time"></label>
        <button class="wxr-mini wxr-best" title="Score departures over the next 24 h and pick the driest, calmest">Best time</button>
        <span class="wxr-bests"></span>
        <label class="wxr-ctl" title="Travel speed"><select class="wxr-mode" aria-label="Travel mode"><option value="">Mode</option>${MODES.map((m) => `<option value="${m.key}">${m.label}</option>`).join("")}</select><input type="number" class="wxr-speed" min="1" step="1" aria-label="Travel speed"><b class="wxr-unit"></b></label>
        <button class="wxr-mini wxr-clear" type="button" title="Remove all points">Clear</button>
      </div>
      <div class="wxr-strip"></div>
      <div class="wxr-readout"></div>`;
    document.body.appendChild(el);
    el.querySelector(".wxr-x").onclick = stop;
    el.querySelector(".wxr-clear").onclick = () => { clear(); WX.fn.toast("Route cleared", 3000); };
    const dep = el.querySelector(".wxr-depart");
    dep.value = localISO(new Date(Math.ceil(Date.now() / 9e5) * 9e5));
    dep.onchange = () => { departISO = dep.value ? new Date(dep.value).toISOString() : null; load(); };
    el.querySelector(".wxr-best").onclick = () => bestDepartures();
    const sp = el.querySelector(".wxr-speed");
    sp.value = Math.round(fromKmh(speedKmh));
    sp.onchange = () => {
      const v = Math.max(0.5, Number(sp.value) || 1);
      speedKmh = toKmh(v);
      localStorage.setItem("wxgrid.routeSpeed", String(speedKmh));
      syncMode(); load();
    };
    el.querySelector(".wxr-strip").addEventListener("mouseleave", () => setHover(null));
    const mode = el.querySelector(".wxr-mode");
    mode.onchange = () => {
      const m = MODES.find((x) => x.key === mode.value);
      if (!m) return;
      speedKmh = m.kmh; sp.value = Math.round(fromKmh(speedKmh));
      localStorage.setItem("wxgrid.routeSpeed", String(speedKmh));
      load();
    };
    return el;
  }

  const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  function syncMode() {
    const el = $("#wxr"); if (!el) return;
    const m = MODES.find((x) => Math.abs(x.kmh - speedKmh) < 0.6);
    el.querySelector(".wxr-mode").value = m ? m.key : "";
  }
  function setHover(i) { if (i === hoverI) return; hoverI = i; markSelection(); paintCursor(); readout(); }
  function flyTo(i) {
    selI = i;
    const s = data.samples[i];
    M().flyTo({ center: [s.lon, s.lat], zoom: Math.max(M().getZoom(), 7), speed: 1.1 });
    setHover(i);
  }

  // ── map drawing ────────────────────────────────────────────────────────
  const SRC = ["wxr-line", "wxr-haz", "wxr-dots", "wxr-cursor"];
  function ensureLayers() {
    const m = M(); if (!m || !m.isStyleLoaded()) return false;
    if (m.getSource("wxr-line")) return true;
    const empty = { type: "FeatureCollection", features: [] };
    SRC.forEach((s) => m.addSource(s, { type: "geojson", data: empty }));
    m.addLayer({ id: "wxr-line", type: "line", source: "wxr-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff8a3d", "line-width": 3.2, "line-opacity": 0.95 } });
    m.addLayer({ id: "wxr-haz", type: "line", source: "wxr-haz",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["match", ["get", "level"], 2, "#ef786f", "#ffb454"], "line-width": 7, "line-opacity": 0.55, "line-blur": 1 } });
    m.addLayer({ id: "wxr-dots", type: "circle", source: "wxr-dots",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.6, 9, 4.5],
               "circle-color": ["match", ["get", "level"], 2, "#ef786f", 1, "#ffb454", "#ffffff"],
               "circle-stroke-color": "rgba(0,0,0,.55)", "circle-stroke-width": 1 } });
    m.addLayer({ id: "wxr-cursor", type: "circle", source: "wxr-cursor",
      paint: { "circle-radius": 8, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ff8a3d", "circle-stroke-width": 2.5 } });
    return true;
  }
  function setData(id, fc) { const s = M() && M().getSource(id); if (s) s.setData(fc); }
  const fc = (features) => ({ type: "FeatureCollection", features });

  function paintPath() {
    if (!ensureLayers()) { M().once("idle", paintPath); return; }
    setData("wxr-line", fc(pts.length >= 2 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } }] : []));
    if (!data) { setData("wxr-haz", fc([])); setData("wxr-dots", fc([])); }
    rebuildMarkers();
  }
  function paintSamples() {
    if (!data || !ensureLayers()) return;
    const ss = data.samples;
    setData("wxr-dots", fc(ss.map((s) => ({ type: "Feature", properties: { level: s.hazard, i: s.i },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] } }))));
    setData("wxr-haz", fc((data.summary.segments || []).map((seg) => ({
      type: "Feature", properties: { level: seg.level },
      geometry: { type: "LineString", coordinates: ss.slice(Math.max(0, seg.from_i - 1), seg.to_i + 2).map((s) => [s.lon, s.lat]) } }))
      .filter((f) => f.geometry.coordinates.length > 1)));
  }
  function paintCursor() {
    if (!ensureLayers()) return;
    const i = hoverI != null ? hoverI : selI;
    const s = data && i != null ? data.samples[i] : null;
    setData("wxr-cursor", fc(s ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [s.lon, s.lat] } }] : []));
  }

  // Vertex handles: solid dots you can drag, plus a dashed ghost in the middle
  // of every leg — drag the ghost and it becomes a new vertex, the way every
  // routing UI has worked since Google Maps taught everyone the gesture.
  function rebuildMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
    if (!M()) return;
    pts.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "wxr-vertex" + (i === 0 || i === pts.length - 1 ? " end" : "");
      el.title = "Drag to move · double-click to remove";
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(M());
      mk.on("drag", () => { pts[i] = [mk.getLngLat().lng, mk.getLngLat().lat]; setData("wxr-line", fc([{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } }])); });
      mk.on("dragend", () => { pts[i] = [mk.getLngLat().lng, mk.getLngLat().lat]; load(); });
      el.addEventListener("dblclick", (e) => { e.stopPropagation(); removePoint(i); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); removePoint(i); });
      markers.push(mk);
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
      const el = document.createElement("div");
      el.className = "wxr-ghost"; el.title = "Drag to bend the route here";
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(mid).addTo(M());
      let idx = null;
      mk.on("dragstart", () => { idx = i + 1; pts.splice(idx, 0, mid.slice()); el.className = "wxr-vertex"; });
      mk.on("drag", () => { if (idx == null) return; pts[idx] = [mk.getLngLat().lng, mk.getLngLat().lat]; setData("wxr-line", fc([{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } }])); });
      mk.on("dragend", () => { if (idx == null) return; pts[idx] = [mk.getLngLat().lng, mk.getLngLat().lat]; idx = null; load(); });
      markers.push(mk);
    }
  }
  function removePoint(i) {
    if (pts.length <= 2) { WX.fn.toast("A route needs two points", 3000); return; }
    pts.splice(i, 1); load();
  }

  // ── load ───────────────────────────────────────────────────────────────
  async function load() {
    paintPath();
    if (pts.length < 2) { data = null; render(); return; }
    if (window.WXStatic) { data = null; render("The static demo has no route API. Run wxgrid locally for route forecasts."); return; }
    const my = ++req;
    loading = true; render();
    try {
      const body = {
        path: pts.map((p) => [Number(WX.wlon(p[0]).toFixed(4)), Number(p[1].toFixed(4))]),
        depart: departISO || new Date().toISOString(),
        speed_kmh: Math.round(speedKmh * 10) / 10,
        model: WX.state.model, run: WX.state.run,
      };
      const r = await fetch(`${WX.API}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      if (my !== req) return;
      data = d; loading = false;
      if (selI != null && selI >= d.samples.length) selI = null;
      paintSamples(); paintCursor(); render();
    } catch (e) {
      if (my !== req) return;
      loading = false; data = null;
      render(navigator.onLine ? "Route forecast unavailable for this model." : "Offline. Route forecasts need the server.");
    }
  }

  // Leave-at: the same route scored at every second hour of the next 24,
  // ranked by what you would actually avoid — rain on the road first, gusts,
  // then poor visibility and ice — and the three best offered as buttons.
  // Eight forecasts, four in flight at a time; the head says "scoring".
  function scoreSummary(s, thr) {
    let sc = 0;
    sc += (s.total_precip_mm || 0) * 1.0 + (s.total_snow_mm || 0) * 2.5;
    if (s.worst_gust && s.worst_gust.value != null) sc += Math.max(0, s.worst_gust.value - (thr.gust_ms || 15) * 0.6) * 0.8;
    if (s.min_vis_km && s.min_vis_km.value != null && s.min_vis_km.value < 10) sc += (10 - s.min_vis_km.value) * 0.5;
    sc += (s.hazard || 0) * 3 + (s.flags || []).length * 1.5 + (s.alerts || []).length * 4;
    return sc;
  }
  async function bestDepartures() {
    if (pts.length < 2 || window.WXStatic) return;
    const el = box(), out = el.querySelector(".wxr-bests"), btn = el.querySelector(".wxr-best");
    btn.disabled = true; out.innerHTML = `<span class="idle">scoring…</span>`;
    const base = new Date(); base.setMinutes(0, 0, 0);
    const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
    const body = (dep) => ({ path: pts.map((p) => [Number(WX.wlon(p[0]).toFixed(4)), Number(p[1].toFixed(4))]), depart: dep.toISOString(), speed_kmh: Math.round(speedKmh * 10) / 10, model: WX.state.model, run: WX.state.run });
    const results = [];
    const queue = hours.slice();
    const worker = async () => { while (queue.length) { const h = queue.shift(); const dep = new Date(base.getTime() + h * 3600e3);
      try { const r = await fetch(`${WX.API}/route`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(dep)) }); if (!r.ok) continue; const d = await r.json(); results.push({ h, dep, score: scoreSummary(d.summary, d.thresholds || {}), s: d.summary }); } catch (e) { /* one sample lost, the rest still rank */ } } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    btn.disabled = false;
    if (!results.length) { out.innerHTML = `<span class="idle">no scores</span>`; return; }
    results.sort((a, b) => a.score - b.score || a.h - b.h);
    const why = (x) => { const s = x.s, bits = []; if ((s.total_precip_mm || 0) < 0.05 && (s.total_snow_mm || 0) < 0.05) bits.push("dry"); else { const p = uPrecip(s.total_precip_mm || 0); bits.push(`${n1(p.v)} ${p.unit}`); }
      if (s.worst_gust && s.worst_gust.value != null) bits.push(`gusts ${Math.round(spd(s.worst_gust.value))}`); return bits.join(" · "); };
    out.innerHTML = results.slice(0, 3).map((x, k) => `<button class="wxr-chip wxr-pick${k === 0 ? " best" : ""}" data-t="${x.dep.toISOString()}" title="${esc(why(x))}">${esc(uTime(x.dep.toISOString(), { weekday: "short" }))}<small>${esc(why(x))}</small></button>`).join("");
    out.querySelectorAll(".wxr-pick").forEach((b) => b.onclick = () => { departISO = b.dataset.t; const dep = el.querySelector(".wxr-depart"); if (dep) dep.value = localISO(new Date(departISO)); load(); });
  }

  // ── render (head, strip, readout) ──────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  // The same duration split into its own markup, so the hero can size the
  // numbers and the units differently.
  function heroDur(h) {
    const m = Math.round(h * 60);
    return m < 60 ? `${m}<i>min</i>` : `${Math.floor(m / 60)}<i>h</i> ${String(m % 60).padStart(2, "0")}<i>m</i>`;
  }

  function render(msg) {
    const el = box(); el.hidden = !active;
    const runEl = el.querySelector(".wxr-run"), hero = el.querySelector(".wxr-hero"), chips = el.querySelector(".wxr-chips");
    el.querySelector(".wxr-unit").textContent = spdUnit();
    if (!data) {
      runEl.textContent = loading ? "loading" : "";
      hero.innerHTML = ""; chips.innerHTML = "";
      note(msg || (pts.length < 2 ? "Tap the map to drop points. Drag a dot to move it, drag a dashed handle to bend the leg." : ""));
      readout();
      return;
    }
    note("");
    const km = uDist(data.length_km);
    runEl.textContent = `${data.model.toUpperCase()} · ${data.run.slice(5).replace("T", " ")}Z`;
    hero.innerHTML = [
      `<div><small>Distance</small><b>${n1(km.v)}<i>${esc(km.unit)}</i></b></div>`,
      `<div><small>Travel</small><b>${heroDur(data.duration_h)}</b></div>`,
      data.arrive ? `<div><small>Arrive</small><b>${esc(uWhen(data.arrive))}</b></div>` : "",
    ].join("");
    const s = data.summary;
    const out = [];
    const gust = s.worst_gust && s.worst_gust.value != null ? `${Math.round(spd(s.worst_gust.value))} ${spdUnit()}` : null;
    if (gust) out.push([`gust ${gust}`, s.worst_gust.value >= data.thresholds.gust_ms ? "bad" : ""]);
    if (s.total_precip_mm > 0.05) { const p = uPrecip(s.total_precip_mm); out.push([`${n1(p.v)} ${p.unit} en route`, ""]); }
    if (s.total_snow_mm > 0.05) { const p = uSnow(s.total_snow_mm); out.push([`${n1(p.v)} ${p.unit} snow`, "warn"]); }
    if (s.min_vis_km && s.min_vis_km.value != null && s.min_vis_km.value < 10) { const d = uDist(s.min_vis_km.value); out.push([`vis ${n1(d.v)} ${d.unit}`, s.min_vis_km.value <= data.thresholds.vis_km ? "bad" : "warn"]); }
    if (s.flags.length) out.push([s.flags.map((f) => HAZ_LABEL[f] || f).join(", "), s.hazard >= 2 ? "bad" : "warn"]);
    (s.alerts || []).slice(0, 2).forEach((a) => out.push([`⚠ ${a.event}`, (a.sev || 0) >= 3 ? "bad" : "warn"]));
    if (s.outside_run) out.push([`${s.outside_run} past the run`, "warn"]);
    chips.innerHTML = out.map(([t, k], i) => `<span class="wxr-chip ${k}${i > 1 ? " opt" : ""}">${esc(t)}</span>`).join("");
    drawStrip(); readout();
  }
  function note(msg) {
    const el = box(), strip = el.querySelector(".wxr-strip");
    if (!msg) return;
    strip.innerHTML = `<div class="wxr-hint">${esc(msg)}</div>`;
  }

  // ── the strip ──────────────────────────────────────────────────────────
  // Cumulative distance at each vertex you dropped, so the strip can mark the
  // column where one leg hands over to the next. Great-circle, like the server.
  function vertexKm() {
    const rad = (x) => x * Math.PI / 180, R = 6371.0088;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
      cum.push(cum[i - 1] + 2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
    }
    return cum;
  }
  const dayOpts = () => (U() && U().timeOpts ? U().timeOpts({ weekday: "short", month: "short", day: "numeric" })
                                             : { weekday: "short", month: "short", day: "numeric" });
  const nightAt = (iso) => { const h = new Date(iso).getHours(); return h < 6 || h >= 21; };
  const glyphFor = (s) => (WX.tape && WX.tape.glyph
    ? WX.tape.glyph(s.cloud, (s.precip_mm_h || 0) + (s.snow_mm_h || 0), s.t2m, nightAt(s.eta)) : "");
  // The tape's own wind colouring: dark ink once the cell is bright enough.
  const windCell = (v) => `background:${WX.rampColor("wind", v, 0.92)};color:${v * 3.6 > 45 ? "#160b03" : "var(--fg)"}`;

  function drawStrip() {
    const el = box(), strip = el.querySelector(".wxr-strip");
    const ss = data.samples, n = ss.length;
    if (!n) { strip.innerHTML = ""; return; }
    // A waypoint lands between samples; mark the column nearest to it.
    const wpt = new Set();
    const cum = vertexKm();
    cum.slice(1, -1).forEach((km) => {
      let best = 0;
      ss.forEach((s, k) => { if (Math.abs(s.dist_km - km) < Math.abs(ss[best].dist_km - km)) best = k; });
      wpt.add(best);
    });
    // day headers, grouped in the zone the times are shown in
    const days = [];
    ss.forEach((s, i) => {
      const k = new Date(s.eta).toLocaleDateString(undefined, dayOpts());
      if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, first: i, span: 0 });
      days[days.length - 1].span++;
    });
    const hazOf = (s) => (s.hazard >= 2 ? " haz2" : s.hazard >= 1 ? " haz1" : "");
    const cell = (i, inner, cls = "") =>
      `<td class="${cls}${nightAt(ss[i].eta) ? " night" : ""}${ss[i].outside_run ? " past" : ""}${hazOf(ss[i])}" data-i="${i}">${inner}</td>`;
    const lab = (t, u) => `<th class="lab">${esc(t)}${u ? `<small>${esc(u)}</small>` : ""}</th>`;

    const anyHaz = ss.some((s) => s.hazard > 0);
    const hazRow = anyHaz ? `<tr class="r-haz"><th class="lab"></th>${ss.map((s) => `<td class="${hazOf(s).trim()}"><i></i></td>`).join("")}</tr>` : "";
    // "7:15 PM" with the meridiem set small, the way the tape sets its hours
    const hourLab = (iso) => { const t = uTime(iso); const m = /^(.*?)\s*([AP]M)$/i.exec(t);
      return m ? `${esc(m[1])}<small>${esc(m[2])}</small>` : esc(t); };
    const hourRow = ss.map((s, i) => cell(i, `<span class="hr">${hourLab(s.eta)}</span>`, "hour" + (wpt.has(i) ? " wpt" : ""))).join("");
    const dKm = uDist(1);
    // Whole units once you are past the first ten: "89.9 km along" is a
    // precision the route does not have and a digit the column cannot spare.
    const alongTxt = (v) => (v >= 10 ? Math.round(v) : n1(v));
    const distRow = ss.map((s, i) => cell(i, alongTxt(uDist(s.dist_km).v))).join("");
    const iconRow = ss.map((s, i) => cell(i, glyphFor(s))).join("");
    const tUnit = (uTemp(273.15) || {}).unit || "°C";
    const tempRow = ss.map((s, i) => cell(i, s.t2m == null ? "—" : `${n1(uTemp(s.t2m).v)}°`)).join("");
    const anyWet = ss.some((s) => (s.precip_mm_h || 0) >= 0.05 || (s.snow_mm_h || 0) >= 0.05);
    const precipRow = !anyWet ? "" : ss.map((s, i) => {
      const snow = s.ptype === "snow" || s.ptype === "mixed";
      if (snow && (s.snow_mm_h || 0) >= 0.05) return cell(i, `<span class="snow">${n1(uSnow(s.snow_mm_h).v)}</span>`);
      if ((s.precip_mm_h || 0) >= 0.05) return cell(i, `<span>${n1(uPrecip(s.precip_mm_h).v)}</span>`);
      return cell(i, "");
    }).join("");
    const windRow = ss.map((s, i) => cell(i, s.wind == null ? "—" : `<span style="${windCell(s.wind)}">${Math.round(spd(s.wind))}</span>`)).join("");
    const anyGust = ss.some((s) => s.gust != null);
    const gustRow = anyGust ? ss.map((s, i) => cell(i, s.gust == null ? "—" : `<span style="${windCell(s.gust)}">${Math.round(spd(s.gust))}</span>`)).join("") : "";
    const dirRow = ss.map((s, i) => cell(i, s.wdir == null ? "" : `<i class="dirarrow" style="${WX.arrowRot(s.wdir)}"></i>`)).join("");
    // Rows that only earn their height sometimes: a flat cloud deck, a
    // visibility that never drops and a freezing level miles overhead say
    // nothing, so they are not drawn.
    const anyCloud = ss.some((s) => s.cloud != null);
    const cloudRow = anyCloud ? ss.map((s, i) => cell(i, s.cloud == null ? "" : `<span style="opacity:${(0.4 + 0.6 * s.cloud).toFixed(2)}">${Math.round(s.cloud * 100)}</span>`)).join("") : "";
    const lowVis = ss.some((s) => s.vis_km != null && s.vis_km < 10);
    const visRow = lowVis ? ss.map((s, i) => cell(i, s.vis_km == null ? "" : n1(uDist(s.vis_km).v))).join("") : "";
    // The freezing level matters when it is near the ground you are on.
    const nearFrz = ss.some((s) => s.freezing_level_m != null && s.elev_m != null && s.freezing_level_m - s.elev_m < 900);
    const frzRow = nearFrz ? ss.map((s, i) => cell(i, s.freezing_level_m == null ? "" : Math.round(uAlt(s.freezing_level_m).v))).join("") : "";
    const altUnit = (uAlt(0) || {}).unit || "m";

    strip.innerHTML = `<table class="wtape"><thead><tr><th class="lab corner"></th>${
      days.map((dy) => `<th colspan="${dy.span}" class="day" data-first="${dy.first}" title="Fly to this day">${esc(dy.key)}</th>`).join("")
    }</tr></thead><tbody>
      ${hazRow}
      <tr class="r-hour">${lab("Arrive")}${hourRow}</tr>
      <tr class="r-dist">${lab("Along", dKm.unit)}${distRow}</tr>
      <tr class="r-icon">${lab("")}${iconRow}</tr>
      <tr class="r-temp">${lab("Temp", tUnit)}${tempRow}</tr>
      ${precipRow ? `<tr class="r-rain">${lab("Precip", `${uPrecip(1).unit} · ${uSnow(1).unit}/h`)}${precipRow}</tr>` : ""}
      <tr class="r-wind">${lab("Wind", spdUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${lab("Gusts", spdUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${lab("Direction")}${dirRow}</tr>
      ${cloudRow ? `<tr class="r-cloud">${lab("Cloud", "%")}${cloudRow}</tr>` : ""}
      ${visRow ? `<tr class="r-vis">${lab("Visibility", dKm.unit)}${visRow}</tr>` : ""}
      ${frzRow ? `<tr class="r-frz">${lab("Freezing lvl", altUnit)}${frzRow}</tr>` : ""}
    </tbody></table>`;
    strip.querySelectorAll("td[data-i]").forEach((c) => {
      const i = Number(c.dataset.i);
      c.addEventListener("mouseenter", () => setHover(i));
      c.addEventListener("click", () => flyTo(i));
    });
    strip.querySelectorAll("th.day[data-first]").forEach((c) => c.onclick = () => flyTo(Number(c.dataset.first)));
    markSelection();
  }

  // Hover moves a class, not the whole strip: rebuilding the table on every
  // mouse move threw away the scroll position mid-drag.
  function markSelection() {
    const el = $("#wxr"); if (!el) return;
    const i = hoverI != null ? hoverI : selI;
    el.querySelectorAll(".wxr-strip td[data-i]").forEach((c) => c.classList.toggle("on", Number(c.dataset.i) === i));
  }

  function readout() {
    const el = box(), out = el.querySelector(".wxr-readout");
    const i = hoverI != null ? hoverI : selI;
    if (!data || i == null || !data.samples[i]) {
      out.innerHTML = data ? `<span class="idle">${data.samples.length} stops · tap a column to fly there</span>` : "";
      return;
    }
    const s = data.samples[i];
    if (s.outside_run) { out.innerHTML = `<span><b>${esc(uWhen(s.eta))}</b></span><span class="idle">past the end of this run</span>`; return; }
    const bits = [`<span><b>${esc(uWhen(s.eta))}</b></span>`];
    const kv = (k, v) => bits.push(`<span><i>${esc(k)}</i><b>${v}</b></span>`);
    const d = uDist(s.dist_km); kv("at", `${n1(d.v)} ${esc(d.unit)}`);
    const t = uTemp(s.t2m); if (t) kv("temp", `${n1(t.v)}${esc(t.unit)}`);
    if (s.wind != null) kv("wind", `${WX.arrow(s.wdir)} ${Math.round(spd(s.wind))}${s.gust != null ? `/${Math.round(spd(s.gust))}` : ""} ${esc(spdUnit())}`);
    if (s.precip_mm_h) { const p = uPrecip(s.precip_mm_h); kv(s.ptype || "precip", `${n1(p.v)} ${esc(p.unit)}/h`); }
    if (s.cloud != null) kv("cloud", `${Math.round(s.cloud * 100)}%`);
    if (s.vis_km != null) { const v = uDist(s.vis_km); kv("vis", `${n1(v.v)} ${esc(v.unit)}`); }
    if (s.freezing_level_m != null) { const z = uAlt(s.freezing_level_m); kv("freezing", `${Math.round(z.v)} ${esc(z.unit)}`); }
    if (s.elev_m != null) { const z = uAlt(s.elev_m); kv("ground", `${Math.round(z.v)} ${esc(z.unit)}`); }
    if (s.msl != null) { const p = uPress(s.msl); kv("pressure", `${n1(p.v)} ${esc(p.unit)}`); }
    if (s.flags.length) bits.push(`<span class="f">${esc(s.flags.map((f) => HAZ_LABEL[f] || f).join(" · "))}</span>`);
    out.innerHTML = bits.join("");
  }

  // ── map click capture ──────────────────────────────────────────────────
  // Taking the click in the CAPTURE phase on #map means MapLibre's own click
  // handlers (app.js's included) never see it while route mode is on, so a
  // tap adds a point instead of also opening the point card. No change to
  // app.js required — and if the parent wires WX.route.click() into app.js's
  // handler anyway, this stops that path from firing twice.
  function onCapture(e) {
    if (!active) return;
    if (e.target.closest(".wxr-vertex, .wxr-ghost, .maplibregl-ctrl, .maplibregl-marker")) return;
    e.stopPropagation();
    const m = M(), r = m.getCanvas().getBoundingClientRect();
    const ll = m.unproject([e.clientX - r.left, e.clientY - r.top]);
    addPoint(ll);
  }

  // ── public ─────────────────────────────────────────────────────────────
  function start() {
    if (active) return;
    active = true;
    WX.state.route = true;
    const host = document.getElementById("map");
    if (host) host.addEventListener("click", onCapture, true);
    box().hidden = false;
    syncMode();
    const el = box();
    el.querySelector(".wxr-speed").value = Math.round(fromKmh(speedKmh));
    if (!departISO) departISO = new Date(Math.ceil(Date.now() / 9e5) * 9e5).toISOString();
    el.querySelector(".wxr-depart").value = localISO(new Date(departISO));
    styleWatch = () => { paintPath(); paintSamples(); paintCursor(); };
    M().on("styledata", styleWatch);
    WX.fn.toast("Tap the map to drop route points", 4500);
    render();
    if (pts.length) load();          // a route closed and reopened comes back
  }
  function stop() {
    active = false;
    WX.state.route = false;
    const host = document.getElementById("map");
    if (host) host.removeEventListener("click", onCapture, true);
    if (styleWatch && M()) M().off("styledata", styleWatch);
    styleWatch = null;
    box().hidden = true;
    markers.forEach((m) => m.remove()); markers = [];
    const m = M();
    if (m) {
      SRC.forEach((s) => { if (m.getLayer(s)) m.removeLayer(s); });
      SRC.forEach((s) => { if (m.getSource(s)) m.removeSource(s); });
    }
    const t = document.querySelector("#route-toggle"); if (t) t.classList.remove("on");
  }
  function addPoint(lngLat) {
    if (!lngLat) return;
    const p = Array.isArray(lngLat) ? [lngLat[0], lngLat[1]] : [lngLat.lng, lngLat.lat];
    pts.push(p);
    if (!active) start();
    load();
  }
  function clear() {
    pts = []; data = null; selI = hoverI = null;
    paintPath(); render();
  }

  WX.route = {
    start, stop, addPoint, clear,
    refresh: () => load(),
    click: (lngLat) => addPoint(lngLat),           // optional app.js hook; capture handles it already
    get active() { return active; },
    get points() { return pts.slice(); },
    get data() { return data; },
  };

  // units.js announces a preference change; every number on the strip is
  // rendered through it, so the whole panel just redraws.
  document.addEventListener("wx-units", () => { if (active) { const el = $("#wxr"); if (el) el.querySelector(".wxr-speed").value = Math.round(fromKmh(speedKmh)); render(); } });

  // ══ PWA bootstrap ═══════════════════════════════════════════════════════
  // Registration + the offline banner. Self-contained and guarded, so lifting
  // it into app.js later is a copy-paste with nothing left behind here.
  (function pwa() {
    if (window.__wxSW || !("serviceWorker" in navigator)) return;
    window.__wxSW = true;
    const bar = () => {
      let b = document.getElementById("wx-offline");
      if (!b) {
        b = document.createElement("div");
        b.id = "wx-offline"; b.hidden = true; b.setAttribute("role", "status");
        b.innerHTML = `<span class="dot"></span><span class="txt"></span>`;
        const s = document.createElement("style");
        s.textContent = `#wx-offline{position:fixed;top:calc(var(--top-h,52px) + 8px);left:50%;transform:translateX(-50%);z-index:40;
          display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:999px;background:var(--panel,rgba(0,0,0,.8));
          border:1px solid var(--line,rgba(255,255,255,.12));backdrop-filter:blur(10px);color:var(--warm,#ffb454);
          font:600 11.5px var(--font-body,system-ui);box-shadow:0 8px 30px rgba(0,0,0,.5)}
          #wx-offline[hidden]{display:none}
          #wx-offline .dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}`;
        document.head.appendChild(s);
        document.body.appendChild(b);
      }
      return b;
    };
    const show = (msg) => { const b = bar(); b.querySelector(".txt").textContent = msg; b.hidden = false; };
    const hide = () => { const b = document.getElementById("wx-offline"); if (b) b.hidden = true; };
    const sync = () => (navigator.onLine ? hide() : show("offline — last loaded data only"));
    addEventListener("online", sync);
    addEventListener("offline", sync);
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.type === "wx-offline") show(d.boot ? "offline — showing the cached app" : "offline — last loaded data only");
      // the worker served a cached script because the network was slow, then
      // fetched a newer one: offer the reload rather than wait for next time
      if (d.type === "wx-shell-updated" && window.WX && WX.fn) WX.fn.toast("Update ready · tap to reload", 30000, "", () => location.reload());
      if (d.type === "wx-online") sync();
    });
    const boot = () => {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).then((reg) => {
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed" && navigator.serviceWorker.controller && window.WX && WX.fn) {
              // A stale tab running yesterday's scripts against today's API is
              // the one bug class users cannot see; the toast is the reload,
              // not advice to perform one.
              WX.fn.toast("Update ready · tap to reload", 30000, "", () => location.reload());
            }
          });
        });
      }).catch((e) => console.warn("service worker not registered:", e));
      sync();
    };
    // Registering during page load competes with the map's first paint, so it
    // waits for `load` — but a script that arrives after `load` (deferred, or
    // injected) would then never register at all.
    if (document.readyState === "complete") boot();
    else addEventListener("load", boot);
  })();
})();
