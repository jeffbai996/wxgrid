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
  const style = document.createElement("style");
  style.textContent = `
  #wxr { position: absolute; left: 12px; right: 12px; bottom: calc(var(--tb-h) + 22px + env(safe-area-inset-bottom)); z-index: 7;
         background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(10px);
         padding: 8px 10px 6px; box-shadow: 0 20px 60px rgba(0,0,0,.45); color: var(--fg); }
  #wxr[hidden] { display: none; }
  #wxr .wxr-head { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; margin-bottom: 4px; padding-right: 26px; }
  #wxr .wxr-title { font: 800 13px var(--font-display); letter-spacing: -.01em; }
  #wxr .wxr-sub { font: 500 11px var(--font-mono); color: var(--dim); }
  #wxr .wxr-ctl { display: inline-flex; align-items: center; gap: 5px; font: 600 11px var(--font-body); color: var(--fg-2);
                  background: var(--accent-soft); border: 1px solid var(--line); border-radius: 9px; padding: 2px 7px; }
  #wxr .wxr-ctl input, #wxr .wxr-ctl select { background: transparent; border: 0; color: var(--fg); font: 600 11.5px var(--font-mono); outline: none; }
  #wxr .wxr-ctl input[type=number] { width: 3.6em; text-align: right; }
  #wxr .wxr-ctl input[type=datetime-local] { color-scheme: dark; }
  :root[data-theme=light] #wxr .wxr-ctl input[type=datetime-local] { color-scheme: light; }
  #wxr .wxr-ctl select { cursor: pointer; }
  #wxr .wxr-ctl select option { background: var(--panel-solid); color: var(--fg); }
  #wxr .wxr-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  #wxr .wxr-chip { font: 600 10.5px var(--font-mono); color: var(--fg-2); border: 1px solid var(--line);
                   border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  #wxr .wxr-chip.warn { color: var(--warm); border-color: color-mix(in srgb, var(--warm) 40%, transparent); }
  #wxr .wxr-chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  #wxr canvas { width: 100%; height: 214px; display: block; cursor: crosshair; touch-action: pan-y; }
  #wxr .wxr-readout { font: 500 11px var(--font-mono); color: var(--dim); min-height: 15px; padding-top: 2px;
                      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #wxr .wxr-readout b { color: var(--fg); font-weight: 700; }
  #wxr .wxr-readout .f { color: var(--bad); }
  #wxr .wxr-hint { font: 500 11.5px var(--font-body); color: var(--dim); padding: 20px 4px; text-align: center; }
  #wxr .wxr-x { position: absolute; top: 5px; right: 7px; width: 24px; height: 24px; font-size: 13px; }
  #wxr button.wxr-mini { font: 600 11px var(--font-body); color: var(--fg-2); background: transparent; border: 1px solid var(--line);
                         border-radius: 9px; padding: 3px 8px; cursor: pointer; }
  #wxr button.wxr-mini:hover { color: var(--fg); border-color: var(--line-strong); }
  .wxr-vertex { width: 15px; height: 15px; border-radius: 50%; background: var(--accent); border: 2.5px solid var(--panel-solid);
                box-shadow: 0 2px 8px rgba(0,0,0,.5); cursor: grab; }
  .wxr-vertex.end { background: var(--fg); }
  .wxr-ghost { width: 11px; height: 11px; border-radius: 50%; background: transparent; border: 2px dashed var(--accent);
               opacity: .55; cursor: cell; }
  .wxr-ghost:hover { opacity: 1; }
  @media (max-width: 820px) {
    #wxr { left: 6px; right: 6px; padding: 6px 8px 4px; }
    #wxr canvas { height: 132px; }
    #wxr .wxr-sub, #wxr .wxr-chips .opt { display: none; }
    #wxr .wxr-head { gap: 5px 6px; padding-right: 24px; }
    #wxr .wxr-ctl { padding: 1px 6px; font-size: 10.5px; }
    #wxr .wxr-ctl input, #wxr .wxr-ctl select { font-size: 10.5px; }
    /* The native datetime field wants a whole row to itself; it does not get one. */
    #wxr .wxr-ctl input[type=datetime-local] { width: 8.8em; }
    #wxr .wxr-ctl input[type=number] { width: 2.8em; }
    #wxr .wxr-chip { font-size: 10px; padding: 1px 7px; }
    #wxr .wxr-readout { font-size: 10px; }
    #wxr .wxr-hint { padding: 12px 4px; font-size: 11px; }
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
        <span class="wxr-title">Route</span>
        <span class="wxr-sub"></span>
        <label class="wxr-ctl" title="Departure (local time)">leave<input type="datetime-local" class="wxr-depart"></label>
        <label class="wxr-ctl" title="Travel speed"><select class="wxr-mode"><option value="">Speed</option>${MODES.map((m) => `<option value="${m.key}">${m.label}</option>`).join("")}</select><input type="number" class="wxr-speed" min="1" step="1"><b class="wxr-unit"></b></label>
        <button class="wxr-mini wxr-clear" title="Remove all points">clear</button>
        <span class="wxr-chips"></span>
      </div>
      <button class="icon wxr-x" title="Close">×</button>
      <canvas></canvas>
      <div class="wxr-readout"></div>`;
    document.body.appendChild(el);
    el.querySelector(".wxr-x").onclick = stop;
    el.querySelector(".wxr-clear").onclick = () => { clear(); WX.fn.toast("Route cleared", 3000); };
    const dep = el.querySelector(".wxr-depart");
    dep.value = localISO(new Date(Math.ceil(Date.now() / 9e5) * 9e5));
    dep.onchange = () => { departISO = dep.value ? new Date(dep.value).toISOString() : null; load(); };
    const sp = el.querySelector(".wxr-speed");
    sp.value = Math.round(fromKmh(speedKmh));
    sp.onchange = () => {
      const v = Math.max(0.5, Number(sp.value) || 1);
      speedKmh = toKmh(v);
      localStorage.setItem("wxgrid.routeSpeed", String(speedKmh));
      syncMode(); load();
    };
    const mode = el.querySelector(".wxr-mode");
    mode.onchange = () => {
      const m = MODES.find((x) => x.key === mode.value);
      if (!m) return;
      speedKmh = m.kmh; sp.value = Math.round(fromKmh(speedKmh));
      localStorage.setItem("wxgrid.routeSpeed", String(speedKmh));
      load();
    };
    const c = el.querySelector("canvas");
    c.addEventListener("mousemove", (e) => setHover(pick(c, e.clientX)));
    c.addEventListener("mouseleave", () => setHover(null));
    c.addEventListener("click", (e) => { const i = pick(c, e.clientX); if (i != null) flyTo(i); });
    c.addEventListener("touchstart", (e) => setHover(pick(c, e.touches[0].clientX)), { passive: true });
    c.addEventListener("touchmove", (e) => setHover(pick(c, e.touches[0].clientX)), { passive: true });
    return el;
  }

  const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  function syncMode() {
    const el = $("#wxr"); if (!el) return;
    const m = MODES.find((x) => Math.abs(x.kmh - speedKmh) < 0.6);
    el.querySelector(".wxr-mode").value = m ? m.key : "";
  }
  function pick(c, clientX) {
    if (!data || !data.samples.length) return null;
    const r = c.getBoundingClientRect();
    const g = geom(c.clientWidth, c.clientHeight);
    const f = (clientX - r.left - g.padL) / g.gw;
    return Math.max(0, Math.min(data.samples.length - 1, Math.round(f * (data.samples.length - 1))));
  }
  function setHover(i) { if (i === hoverI) return; hoverI = i; draw(); paintCursor(); readout(); }
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
    if (window.WXStatic) { data = null; render("The static demo has no route API — run wxgrid locally for route forecasts."); return; }
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
      render(navigator.onLine ? "Route forecast unavailable for this model." : "Offline — route forecasts need the server.");
    }
  }

  // ── render (chips, canvas, readout) ────────────────────────────────────
  function render(msg) {
    const el = box(); el.hidden = !active;
    const sub = el.querySelector(".wxr-sub"), chips = el.querySelector(".wxr-chips");
    el.querySelector(".wxr-unit").textContent = spdUnit();
    if (!data) {
      sub.textContent = loading ? "loading…" : "";
      chips.innerHTML = "";
      const c = el.querySelector("canvas");
      c.getContext("2d").clearRect(0, 0, c.width, c.height);
      note(msg || (pts.length < 2 ? "Tap the map to drop points. Drag a dot to move it, drag a dashed handle to bend the leg." : ""));
      readout();
      return;
    }
    note("");
    const km = uDist(data.length_km), h = data.duration_h;
    sub.textContent = `${n1(km.v)} ${km.unit} · ${fmtDur(h)} · ${data.model.toUpperCase()} ${data.run.slice(5).replace("T", " ")}Z`;
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
    draw(); readout();
  }
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  function fmtDur(h) { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; }
  function note(msg) {
    const el = box();
    let n = el.querySelector(".wxr-hint");
    if (!msg) { if (n) n.remove(); el.querySelector("canvas").style.display = ""; return; }
    if (!n) { n = document.createElement("div"); n.className = "wxr-hint"; el.querySelector("canvas").after(n); }
    n.textContent = msg;
    el.querySelector("canvas").style.display = "none";
  }

  const css = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  function geom(w, h) {
    const compact = w < 620 || h < 170;
    const padL = compact ? 32 : 42, padR = compact ? 36 : 44, padT = 5, padB = compact ? 13 : 17;
    const gw = w - padL - padR, avail = h - padT - padB;
    const ribbon = 7, cloud = compact ? 7 : 9, gap = 3;
    const rest = avail - ribbon - cloud - gap * 2;
    const hMain = Math.round(rest * (compact ? 0.60 : 0.46));
    const hRain = Math.round(rest * (compact ? 0.40 : 0.24));
    const hTerr = compact ? 0 : rest - hMain - hRain;
    const yRib = padT, yCloud = yRib + ribbon + 1;
    const yMain = yCloud + cloud + gap, yRain = yMain + hMain + gap, yTerr = yRain + hRain + gap;
    return { compact, padL, padR, padT, padB, gw, ribbon, cloud, hMain, hRain, hTerr, yRib, yCloud, yMain, yRain, yTerr };
  }

  function draw() {
    const el = box(), c = el.querySelector("canvas");
    if (!data || !data.samples.length) return;
    const dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const g = geom(w, h), ss = data.samples, n = ss.length;
    const xOf = (i) => g.padL + (n === 1 ? g.gw / 2 : g.gw * i / (n - 1));
    const step = n > 1 ? g.gw / (n - 1) : g.gw;
    const dim = css("--dim", "#7c8492"), line = css("--line", "rgba(255,255,255,.1)");
    const accent = css("--accent", "#ff8a3d"), fg = css("--fg", "#eef1f5");
    const bad = css("--bad", "#ef786f"), warm = css("--warm", "#ffb454"), rain = css("--rain", "#6cb6ff");
    x.font = `500 9.5px ${css("--font-mono", "monospace")}`;

    // hazard segments: a ribbon on top, a wash down the whole chart
    (data.summary.segments || []).forEach((seg) => {
      const x0 = xOf(seg.from_i) - step / 2, x1 = xOf(seg.to_i) + step / 2;
      x.fillStyle = seg.level >= 2 ? bad : warm;
      x.globalAlpha = 0.85; x.fillRect(x0, g.yRib, x1 - x0, g.ribbon);
      x.globalAlpha = 0.10; x.fillRect(x0, g.yCloud, x1 - x0, h - g.padB - g.yCloud);
      x.globalAlpha = 1;
    });
    // samples outside the run get hatched out — the run cannot answer for them
    ss.forEach((s, i) => {
      if (!s.outside_run) return;
      x.fillStyle = dim; x.globalAlpha = 0.16;
      x.fillRect(xOf(i) - step / 2, g.yCloud, step, h - g.padB - g.yCloud);
      x.globalAlpha = 1;
    });
    // cloud strip
    ss.forEach((s, i) => {
      if (s.cloud == null) return;
      x.fillStyle = fg; x.globalAlpha = 0.10 + 0.6 * s.cloud;
      x.fillRect(xOf(i) - step / 2, g.yCloud, step + 0.6, g.cloud);
      x.globalAlpha = 1;
    });

    // ── main band: temperature line (left axis) + gust area (right axis)
    const temps = ss.map((s) => (s.t2m == null ? null : uTemp(s.t2m).v));
    const tUnit = (uTemp(273.15) || {}).unit || "°C";
    const have = temps.filter((t) => t != null);
    if (have.length) {
      let lo = Math.min(...have), hi = Math.max(...have);
      if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
      const yT = (t) => g.yMain + g.hMain * (1 - (t - lo) / (hi - lo));
      // gust area behind, on its own 0..max scale
      const gusts = ss.map((s) => (s.gust != null ? s.gust : s.wind));
      const gmax = Math.max(1, ...gusts.filter((v) => v != null));
      x.beginPath(); x.moveTo(xOf(0), g.yMain + g.hMain);
      ss.forEach((s, i) => { const v = gusts[i]; x.lineTo(xOf(i), v == null ? g.yMain + g.hMain : g.yMain + g.hMain * (1 - v / gmax)); });
      x.lineTo(xOf(n - 1), g.yMain + g.hMain); x.closePath();
      x.fillStyle = accent; x.globalAlpha = 0.13; x.fill(); x.globalAlpha = 1;
      x.strokeStyle = accent; x.globalAlpha = 0.5; x.lineWidth = 1; x.setLineDash([3, 2.5]);
      x.beginPath(); ss.forEach((s, i) => { const v = gusts[i]; if (v == null) return; const yy = g.yMain + g.hMain * (1 - v / gmax); i ? x.lineTo(xOf(i), yy) : x.moveTo(xOf(i), yy); });
      x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
      // temperature
      x.strokeStyle = fg; x.lineWidth = 1.9; x.beginPath();
      let started = false;
      temps.forEach((t, i) => { if (t == null) { started = false; return; } const yy = yT(t); if (!started) { x.moveTo(xOf(i), yy); started = true; } else x.lineTo(xOf(i), yy); });
      x.stroke();
      // 0 °C reference, when it is in view
      const zero = uTemp(273.15).v;
      if (zero > lo && zero < hi) {
        x.strokeStyle = rain; x.globalAlpha = 0.55; x.lineWidth = 1; x.setLineDash([4, 4]);
        x.beginPath(); x.moveTo(g.padL, yT(zero)); x.lineTo(w - g.padR, yT(zero)); x.stroke();
        x.setLineDash([]); x.globalAlpha = 1;
      }
      x.fillStyle = dim; x.textAlign = "right"; x.textBaseline = "middle";
      x.fillText(`${Math.round(hi)}${tUnit}`, g.padL - 4, g.yMain + 5);
      x.fillText(`${Math.round(lo)}`, g.padL - 4, g.yMain + g.hMain - 4);
      x.textAlign = "left";
      x.fillStyle = accent;
      x.fillText(`${Math.round(spd(gmax))}`, w - g.padR + 4, g.yMain + 5);
      x.fillText(spdUnit(), w - g.padR + 4, g.yMain + 16);
      // wind direction chevrons along the top of the band
      const every = Math.max(1, Math.round(n / (g.compact ? 6 : 12)));
      x.fillStyle = dim;
      for (let i = 0; i < n; i += every) {
        const d = ss[i].wdir; if (d == null) continue;
        arrowAt(x, xOf(i), g.yMain + 8, d);
      }
    }

    // ── precip band: bars, coloured by type
    const rates = ss.map((s) => s.precip_mm_h || 0);
    const rmax = Math.max(0.6, ...rates);
    ss.forEach((s, i) => {
      const r = rates[i]; if (r <= 0.005) return;
      const hh = g.hRain * Math.min(1, Math.log10(1 + 9 * r / rmax));
      x.fillStyle = s.ptype === "snow" ? "#dbe8ff" : s.ptype === "mixed" ? "#a8c9f0" : rain;
      x.globalAlpha = 0.9;
      x.fillRect(xOf(i) - step * 0.36, g.yRain + g.hRain - hh, Math.max(1.5, step * 0.72), hh);
      x.globalAlpha = 1;
    });
    x.strokeStyle = line; x.lineWidth = 1;
    x.beginPath(); x.moveTo(g.padL, g.yRain + g.hRain + 0.5); x.lineTo(w - g.padR, g.yRain + g.hRain + 0.5); x.stroke();
    if (rmax > 0.6) {
      const p = uPrecip(rmax);
      // Right-aligned to the canvas edge, not left-aligned off the plot: the
      // gutter is 36-44 px and "2.2 mm/h" is wider than that.
      x.fillStyle = rain; x.textAlign = "right"; x.textBaseline = "top";
      x.fillText(g.compact ? `${n1(p.v)}` : `${n1(p.v)} ${p.unit}/h`, w - 2, g.yRain);
    }

    // ── terrain band: the ground you drive over, and the freezing level over it
    if (g.hTerr > 6) {
      const elevs = ss.map((s) => s.elev_m), frz = ss.map((s) => s.freezing_level_m);
      const all = elevs.concat(frz).filter((v) => v != null);
      if (all.length) {
        const hiZ = Math.max(300, ...all) * 1.05, loZ = Math.min(0, ...all);
        const yZ = (z) => g.yTerr + g.hTerr * (1 - (z - loZ) / (hiZ - loZ));
        if (elevs.some((v) => v != null)) {
          x.beginPath(); x.moveTo(g.padL, g.yTerr + g.hTerr);
          ss.forEach((s, i) => x.lineTo(xOf(i), s.elev_m == null ? g.yTerr + g.hTerr : yZ(s.elev_m)));
          x.lineTo(w - g.padR, g.yTerr + g.hTerr); x.closePath();
          x.fillStyle = dim; x.globalAlpha = 0.45; x.fill(); x.globalAlpha = 1;
        }
        if (frz.some((v) => v != null)) {
          x.strokeStyle = rain; x.lineWidth = 1.5; x.setLineDash([5, 3]); x.beginPath();
          let st = false;
          frz.forEach((z, i) => { if (z == null) { st = false; return; } const yy = yZ(z); if (!st) { x.moveTo(xOf(i), yy); st = true; } else x.lineTo(xOf(i), yy); });
          x.stroke(); x.setLineDash([]);
          x.fillStyle = rain; x.textAlign = "left"; x.textBaseline = "top";
          x.fillText("0°", w - g.padR + 4, g.yTerr);
        }
        const top = uAlt(hiZ);
        x.fillStyle = dim; x.textAlign = "right"; x.textBaseline = "top";
        x.fillText(`${Math.round(top.v)}${g.compact ? "" : " " + top.unit}`, g.padL - 4, g.yTerr);
      }
    }

    // ── x axis: distance and clock
    x.fillStyle = dim; x.textAlign = "center"; x.textBaseline = "top";
    const ticks = g.compact ? 3 : 5;
    for (let k = 0; k <= ticks; k++) {
      const i = Math.round((n - 1) * k / ticks), s = ss[i];
      const lab = uTime(s.eta);
      const d = uDist(s.dist_km);
      x.fillText(g.compact ? lab : `${lab}  ${n1(d.v)}${d.unit}`, Math.min(w - g.padR, Math.max(g.padL, xOf(i))), h - g.padB + 2);
    }

    // ── cursor
    const ci = hoverI != null ? hoverI : selI;
    if (ci != null && ss[ci]) {
      x.strokeStyle = accent; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(xOf(ci), g.yCloud); x.lineTo(xOf(ci), h - g.padB); x.stroke();
      x.fillStyle = accent; x.beginPath(); x.arc(xOf(ci), g.yCloud - 3, 2.6, 0, Math.PI * 2); x.fill();
    }
  }

  function arrowAt(x, cx, cy, dirFrom) {
    // Chevron points where the wind is GOING, like the rest of the app.
    const a = (dirFrom + 180) * Math.PI / 180, r = 4;
    const dx = Math.sin(a), dy = -Math.cos(a);
    x.save(); x.translate(cx, cy);
    x.beginPath(); x.moveTo(dx * r, dy * r);
    x.lineTo(-dy * r * 0.7 - dx * r * 0.5, dx * r * 0.7 - dy * r * 0.5);
    x.lineTo(dy * r * 0.7 - dx * r * 0.5, -dx * r * 0.7 - dy * r * 0.5);
    x.closePath(); x.globalAlpha = 0.75; x.fill(); x.globalAlpha = 1; x.restore();
  }

  function readout() {
    const el = box(), out = el.querySelector(".wxr-readout");
    const i = hoverI != null ? hoverI : selI;
    if (!data || i == null || !data.samples[i]) {
      out.innerHTML = data ? `<span>${data.samples.length} samples · hover the chart, tap to fly there</span>` : "";
      return;
    }
    const s = data.samples[i];
    if (s.outside_run) { out.innerHTML = `<b>${esc(uWhen(s.eta))}</b> · past the end of this run`; return; }
    const t = uTemp(s.t2m), d = uDist(s.dist_km), bits = [];
    bits.push(`<b>${esc(uWhen(s.eta))}</b>`);
    bits.push(`${n1(d.v)} ${d.unit}`);
    if (t) bits.push(`<b>${n1(t.v)}${t.unit}</b>`);
    if (s.wind != null) bits.push(`${WX.arrow(s.wdir)} ${Math.round(spd(s.wind))}${s.gust != null ? `/${Math.round(spd(s.gust))}` : ""} ${spdUnit()}`);
    if (s.precip_mm_h) { const p = uPrecip(s.precip_mm_h); bits.push(`${s.ptype || "precip"} ${n1(p.v)} ${p.unit}/h`); }
    if (s.cloud != null) bits.push(`cloud ${Math.round(s.cloud * 100)}%`);
    if (s.vis_km != null) { const v = uDist(s.vis_km); bits.push(`vis ${n1(v.v)} ${v.unit}`); }
    if (s.freezing_level_m != null) { const z = uAlt(s.freezing_level_m); bits.push(`0° ${Math.round(z.v)} ${z.unit}`); }
    if (s.elev_m != null) { const z = uAlt(s.elev_m); bits.push(`ground ${Math.round(z.v)} ${z.unit}`); }
    if (s.msl != null) { const p = uPress(s.msl); bits.push(`${n1(p.v)} ${p.unit}`); }
    if (s.flags.length) bits.push(`<span class="f">${s.flags.map((f) => HAZ_LABEL[f] || f).join(" · ")}</span>`);
    out.innerHTML = bits.join(" · ");
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

  window.addEventListener("resize", () => { if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02) return; if (active && data) draw(); });
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
