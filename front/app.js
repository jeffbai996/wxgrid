// wxgrid front end. State: model/run/layer/level/step + optional live radar.
// One MapLibre image source for the model layer, one raster-tile source for
// radar, a canvas particle layer, a bottom weather tape, and a point card with
// Now / Aloft / Outdoors panes. Everything comes from /api (and RainViewer
// for radar).
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const API = "api";
  const WORLD = [[-180, 85.05112878], [180, 85.05112878], [180, -85.05112878], [-180, -85.05112878]];
  const LAYERS = ["wind", "temp", "gust", "tp6", "tcc", "msl", "cape"];
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", msl: "Pressure", tp6: "Rain", tcc: "Clouds", cape: "CAPE" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, tcc: 0.9, cape: 0.85 };
  const LEVEL_LABEL = { 0: "Sfc", 925: "925", 850: "850", 700: "700", 500: "500", 300: "300", 250: "250" };
  const LEVEL_FT = { 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 500: "FL180", 300: "FL300", 250: "FL340" };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";

  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
  };
  let map, wind, catalog, playTimer = null;

  // ── units ─────────────────────────────────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s" }[state.units]);
  const arrowRot = (deg) => `transform: rotate(${(deg + 180 + 45) % 360}deg)`;   // chevron points TO where wind goes

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const saved = JSON.parse(localStorage.getItem("wxgrid.view") || "null");
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/dark",
      center: saved ? saved.center : [-123, 47], zoom: saved ? saved.zoom : 4,
      minZoom: 1.2, maxZoom: 10, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("moveend", () => {
      localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      if (!state.point) refreshTapePoint();
    });
    wind = new WindLayer(map, $("#particles"));
    // Panels sit on top of the time bar, whose height depends on the tape.
    new ResizeObserver(() => document.documentElement.style.setProperty("--tb-h", $("#timebar").offsetHeight + "px")).observe($("#timebar"));

    catalog = await (await fetch(`${API}/models`, { cache: "no-store" })).json();
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs in the store yet — ingest is still running.", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];

    map.on("load", () => {
      map.addSource("wx", { type: "image", url: layerUrl(), coordinates: WORLD });
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol");
      map.addLayer({ id: "wx", type: "raster", source: "wx",
                     paint: { "raster-opacity": LAYER_ALPHA[state.layer], "raster-fade-duration": 0, "raster-resampling": "linear" } },
                   firstSymbol ? firstSymbol.id : undefined);
      map.on("click", (e) => openPoint(e.lngLat.lat, e.lngLat.lng));
      renderControls();
      applyStep();
      loadWind();
      refreshTapePoint();
    });
  }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + stepHours() * 3600e3);
  const levelQ = () => (state.level && ["wind", "temp"].includes(state.layer)) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => `${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`;
  const windUrl = (h = stepHours()) => `${API}/wind/${state.model}/${state.run}/${h}.json${state.level ? `?level=${state.level}` : ""}`;

  // ── controls ──────────────────────────────────────────────────────────
  function renderControls() {
    const ms = $("#models");
    ms.innerHTML = catalog.models.map((m) => `<button data-model="${m.key}" class="${m.key === state.model ? "on" : ""}" ${m.runs.length ? "" : "disabled"} title="${m.label}">${m.short}</button>`).join("");
    ms.querySelectorAll("button").forEach((b) => b.onclick = () => switchModel(b.dataset.model));

    const rs = $("#run");
    rs.innerHTML = modelEntry().runs.map((r) => `<option value="${r.run}">${r.run.slice(5).replace("T", " ")}Z</option>`).join("");
    rs.value = state.run;
    rs.onchange = () => { state.run = rs.value; clampStep(); renderControls(); applyStep(); loadWind(); refreshPoint(); };

    const chips = $("#layers");
    chips.innerHTML = LAYERS.map((l) =>
      `<button class="chip ${l === state.layer ? "on" : ""}" data-layer="${l}" ${runEntry().layers.includes(l) ? "" : "disabled"}>${LAYER_LABEL[l]}</button>`).join("");
    chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => {
      state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer);
      if (!["wind", "temp"].includes(state.layer)) state.level = 0;
      renderControls(); applyStep(); loadWind(); });

    // altitude: only for wind/temp and only levels this run has
    const lv = $("#levels");
    const levels = runEntry().levels || [];
    const showLevels = ["wind", "temp"].includes(state.layer) && levels.length;
    lv.hidden = !showLevels;
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      lv.innerHTML = opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" title="${l ? `${l} hPa ≈ ${LEVEL_FT[l]}` : "surface (10 m wind / 2 m temp)"}">${LEVEL_LABEL[l]}</button>`).join("");
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => { state.level = Number(b.dataset.level); renderControls(); applyStep(); loadWind(); });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    slider.value = String(state.stepIdx);
    slider.oninput = () => { state.stepIdx = Number(slider.value); applyStep(false); };
    slider.onchange = () => { applyStep(true); loadWind(); };

    renderLegend();
    $("#play").onclick = togglePlay;
    $("#particles-toggle").onclick = () => {
      state.particles = !state.particles;
      $("#particles-toggle").classList.toggle("on", state.particles);
      wind.setEnabled(state.particles);
    };
    $("#units-toggle").textContent = speedUnit();
    $("#units-toggle").onclick = () => {
      state.units = { kmh: "kt", kt: "ms", ms: "kmh" }[state.units];
      localStorage.setItem("wxgrid.units", state.units);
      $("#units-toggle").textContent = speedUnit();
      renderLegend(); renderPoint(); renderTape();
    };
    $("#radar-toggle").onclick = toggleRadar;
    $("#locate").onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(
      (p) => { map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 7) }); openPoint(p.coords.latitude, p.coords.longitude); },
      () => toast("Location unavailable"));
    $("#point-close").onclick = closePoint;
    $$(".point-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderPoint(); });
    document.addEventListener("keydown", (e) => {
      if (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "Escape") closePoint();
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
    renderControls(); applyStep(); loadWind(); refreshPoint(); refreshTapePoint();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; applyRadarFrame(); return; }
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind();
  }

  function applyStep(prefetch = true) {
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
      const f = await (await fetch(windUrl())).json();
      if (my !== windReq) return;
      wind.setField(f);
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
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lg.lo + (lg.hi - lg.lo) * f);
    const name = LAYER_LABEL[state.layer] + (state.level && ["wind", "temp"].includes(state.layer) ? ` ${state.level}` : "");
    $(".legend-ticks").innerHTML = ticks.map((t, i) => `<span>${i === 2 ? `<b>${name}</b> ` : ""}${conv(t)}${i === 4 ? " " + unit : ""}</span>`).join("");
  }

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
      state.radarFrames = [...j.radar.past.map((f) => ({ ...f, kind: "past" })), ...j.radar.nowcast.map((f) => ({ ...f, kind: "nowcast" }))];
      state.radarIdx = j.radar.past.length - 1;                 // latest observed frame
      applyRadarFrame();
      renderTape();
      toast("Radar: RainViewer composite, last 2 h + 30 min nowcast. Coverage where radars exist.", 5000);
    } catch (e) { toast("Radar unavailable right now"); state.radar = false; $("#radar-toggle").classList.remove("on"); }
  }

  function radarTiles(f) { return [`${state.radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`]; }

  function applyRadarFrame() {
    const f = state.radarFrames[state.radarIdx];
    if (!f) return;
    if (map.getSource("radar")) {
      map.getSource("radar").setTiles(radarTiles(f));
    } else {
      map.addSource("radar", { type: "raster", tiles: radarTiles(f), tileSize: 256, attribution: "Radar © RainViewer" });
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol");
      map.addLayer({ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, firstSymbol ? firstSymbol.id : undefined);
    }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", Math.min(0.45, LAYER_ALPHA[state.layer]));
    const t = new Date(f.time * 1000);
    $("#valid-local").textContent = t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) + (f.kind === "nowcast" ? " · nowcast" : " · radar");
    $("#valid-utc").textContent = t.toISOString().slice(11, 16) + "Z";
    const ageMin = Math.round((Date.now() / 1000 - f.time) / 60);
    $("#lead").textContent = ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`;
    renderTapeSelection();
  }

  // ── weather tape ──────────────────────────────────────────────────────
  let tapeReq = 0;
  async function refreshTapePoint() {
    // With no picked point the tape describes the map centre.
    const c = map.getCenter();
    const my = ++tapeReq;
    try {
      const d = await (await fetch(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${c.lng.toFixed(2)}&model=${state.model}&run=${state.run}`)).json();
      if (my !== tapeReq) return;
      state.tapePoint = d;
      renderTape();
    } catch (e) { /* keep last */ }
  }

  function tapeData() { return (state.point && state.point.data) || state.tapePoint; }

  function renderTape() {
    const tape = $("#tape");
    tape.classList.toggle("radar", state.radar && state.radarFrames.length > 0);
    if (state.radar && state.radarFrames.length) {
      let html = "", lastDay = null;
      state.radarFrames.forEach((f, i) => {
        const t = new Date(f.time * 1000), day = t.toDateString();
        if (day !== lastDay) { if (lastDay !== null) html += "</div></div>"; html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short" })} · radar</div><div class="tape-cols">`; lastDay = day; }
        html += `<div class="tape-col ${f.kind}" data-radar="${i}"><span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span class="tape-glyph" style="color:${f.kind === "nowcast" ? "var(--warm)" : "var(--rain)"};text-align:center">${f.kind === "nowcast" ? "◌" : "●"}</span></div>`;
      });
      tape.innerHTML = html + "</div></div>";
      tape.querySelectorAll(".tape-col").forEach((c) => c.onclick = () => { state.radarIdx = Number(c.dataset.radar); applyRadarFrame(); });
      $("#tape-where").textContent = "";
      renderTapeSelection();
      return;
    }
    const d = tapeData();
    if (!d) { tape.innerHTML = ""; return; }
    const s = d.series;
    let html = "", lastDay = null;
    const rainMax = Math.max(4, ...(s.tp6 || []).filter((v) => v != null));
    d.valid.forEach((iso, i) => {
      const t = new Date(iso), day = t.toDateString();
      if (day !== lastDay) {
        if (lastDay !== null) html += "</div></div>";
        html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</div><div class="tape-cols">`;
        lastDay = day;
      }
      const hr = t.getHours(), night = hr < 6 || hr >= 21;
      const temp = s.t2m && s.t2m[i] != null ? `${Math.round(s.t2m[i] - 273.15)}°` : "—";
      const w = s.wind && s.wind[i] != null ? Math.round(speed(s.wind[i])) : "—";
      const dir = s.wdir && s.wdir[i] != null ? `<i style="${arrowRot(s.wdir[i])}"></i>` : "";
      const rain = s.tp6 && s.tp6[i] != null ? s.tp6[i] : 0;
      const cloud = s.tcc && s.tcc[i] != null ? s.tcc[i] : null;
      html += `<div class="tape-col ${night ? "night" : ""} ${i === state.stepIdx ? "on" : ""}" data-i="${i}" title="${new Date(iso).toLocaleString()}">
        <span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "numeric" }).replace(":00", "").replace(" ", "")}</span>
        ${glyph(cloud, rain, s.t2m ? s.t2m[i] : null, night)}
        <span class="tape-temp">${temp}</span>
        <span class="tape-wind">${dir}${w}</span>
        <span class="tape-rain"><b style="width:${Math.min(100, rain / rainMax * 100)}%"></b></span>
      </div>`;
    });
    tape.innerHTML = html + "</div></div>";
    tape.querySelectorAll(".tape-col").forEach((c) => c.onclick = () => { state.stepIdx = Number(c.dataset.i); $("#step").value = state.stepIdx; applyStep(); loadWind(); });
    $("#tape-where").textContent = state.point ? `at ${state.point.lat.toFixed(2)}, ${state.point.lon.toFixed(2)}` : "map centre";
    renderTapeSelection();
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const key = state.radar && state.radarFrames.length ? "radar" : "i";
    const idx = key === "radar" ? state.radarIdx : state.stepIdx;
    let on = null;
    tape.querySelectorAll(".tape-col").forEach((c) => { const isOn = Number(c.dataset[key]) === idx; c.classList.toggle("on", isOn); if (isOn) on = c; });
    if (on) { const r = on.getBoundingClientRect(), tr = tape.getBoundingClientRect(); if (r.left < tr.left + 40 || r.right > tr.right - 40) on.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }
  }

  // Tiny weather glyph: sun/moon, cloud amount, rain/snow. Inline SVG, no assets.
  function glyph(cloud, rain, tK, night) {
    const c = cloud == null ? 0 : cloud;
    const snow = tK != null && tK - 273.15 < 1 && rain > 0.2;
    const body = night ? `<circle cx="7" cy="7" r="4" fill="#cfd6e3"/>` : `<circle cx="7" cy="7" r="4" fill="#ffd166"/>`;
    const cl = c > 0.25 ? `<path d="M6 12h9a3 3 0 0 0 0-6 4 4 0 0 0-7.6-1A3.5 3.5 0 0 0 6 12z" fill="rgba(210,218,230,${0.35 + 0.65 * c})"/>` : "";
    const rn = rain > 0.2 ? (snow ? `<text x="9" y="15" font-size="6" fill="#dfe8ff">✱</text>` : `<path d="M8 12.5v2M12 12.5v2M16 12.5v2" stroke="#6cb6ff" stroke-width="1.4" stroke-linecap="round"/>`) : "";
    return `<svg class="tape-glyph" viewBox="0 0 20 16">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  }

  // ── point card ────────────────────────────────────────────────────────
  let pointReq = 0;
  async function openPoint(lat, lon) {
    const my = ++pointReq;
    state.point = { lat, lon, data: null };
    $("#point").hidden = false;
    $("#point-title").textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${modelEntry().label}`;
    $("#point-now").textContent = "…";
    try {
      const d = await (await fetch(`${API}/point?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&model=${state.model}&run=${state.run}`)).json();
      if (my !== pointReq) return;
      state.point.data = d;
      renderPoint(); renderTape();
      $("#point-foot").textContent = `${modelEntry().attribution} · run ${d.run}Z · nearest 0.25° gridpoint`;
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon); }
  function closePoint() { state.point = null; $("#point").hidden = true; renderTape(); refreshTapePoint(); }

  function renderPoint() {
    const d = state.point && state.point.data; if (!d) return;
    $$(".point-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$("#point-body section").forEach((s) => s.hidden = s.dataset.pane !== state.tab);
    const i = Math.min(state.stepIdx, d.steps.length - 1);
    if (state.tab === "now") renderNow(d, i);
    else if (state.tab === "aloft") renderAloft(d, i);
    else renderOutdoors(d, i);
  }

  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];

  function renderNow(d, i) {
    const s = d.series, parts = [];
    if (s.t2m) parts.push(`<span><b>${f(s.t2m[i], (v) => (v - 273.15).toFixed(0))}°</b> C</span>`);
    if (s.wind) parts.push(`<span><b>${f(s.wind[i], (v) => speed(v).toFixed(0))}</b> ${speedUnit()} ${f(s.wdir && s.wdir[i], arrow)}</span>`);
    if (s.gust) parts.push(`<span>gust <b>${f(s.gust[i], (v) => speed(v).toFixed(0))}</b></span>`);
    if (s.tp6) parts.push(`<span>rain <b>${f(s.tp6[i], (v) => v.toFixed(1))}</b> mm/6h</span>`);
    if (s.tcc) parts.push(`<span>cloud <b>${f(s.tcc[i], (v) => (v * 100).toFixed(0))}</b>%</span>`);
    if (s.msl) parts.push(`<span><b>${f(s.msl[i], (v) => (v / 100).toFixed(0))}</b> hPa</span>`);
    $("#point-now").innerHTML = parts.join("");
    drawMeteogram(d);
  }

  function renderAloft(d, i) {
    const rows = (d.levels || []).slice().sort((a, b) => b - a).map((lvl) => {
      const a = d.aloft[String(lvl)];
      const gh = a.gh && a.gh[i] != null ? a.gh[i] : null;
      return `<tr><td class="mono">${lvl} hPa</td><td>${gh != null ? `${Math.round(gh)} m · ${Math.round(gh * 3.281 / 100) * 100} ft` : LEVEL_FT[lvl]}</td>
        <td class="dir">${a.wdir[i] != null ? `<i style="${arrowRot(a.wdir[i])}"></i>${String(a.wdir[i]).padStart(3, "0")}°` : "—"}</td>
        <td>${f(a.wind[i], (v) => speed(v).toFixed(0))} ${speedUnit()}</td>
        <td>${f(a.temp[i], (v) => (v - 273.15).toFixed(0))}°C</td></tr>`;
    }).join("");
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const sfc = s.wind ? `<tr><td class="mono">sfc</td><td>10 m</td><td class="dir">${s.wdir[i] != null ? `<i style="${arrowRot(s.wdir[i])}"></i>${String(s.wdir[i]).padStart(3, "0")}°` : "—"}</td><td>${f(s.wind[i], (v) => speed(v).toFixed(0))} ${speedUnit()}${s.gust ? ` <span class="dim">G${f(s.gust[i], (v) => speed(v).toFixed(0))}</span>` : ""}</td><td>${f(s.t2m && s.t2m[i], (v) => (v - 273.15).toFixed(0))}°C</td></tr>` : "";
    $("#aloft").innerHTML = `<table class="aloft"><thead><tr><th>Level</th><th>Height</th><th>Dir</th><th>Speed</th><th>Temp</th></tr></thead><tbody>${rows}${sfc}</tbody></table>
      <dl class="kv">
        <dt>Freezing level</dt><dd>${fl != null ? `${fl} m · ${Math.round(fl * 3.281 / 100) * 100} ft` : (d.levels && d.levels.length ? "below 925 hPa or above 250" : "—")}</dd>
        <dt>Total cloud</dt><dd>${f(s.tcc && s.tcc[i], (v) => (v * 100).toFixed(0) + "%")}</dd>
        <dt>CAPE</dt><dd class="${capeClass(s.cape && s.cape[i])}">${f(s.cape && s.cape[i], (v) => v.toFixed(0) + " J/kg")}${s.cape ? "" : " <span class=dim>(model has none)</span>"}</dd>
        <dt>QNH (MSL)</dt><dd>${f(s.msl && s.msl[i], (v) => (v / 100).toFixed(1) + " hPa · " + (v / 100 * 0.02953).toFixed(2) + " inHg")}</dd>
      </dl>
      <div class="note">Model winds are 0.25° gridpoint values, not a TAF and not METAR. Directions are true, FROM. Heights are geopotential; freezing level is interpolated between stored levels.</div>`;
  }
  const capeClass = (v) => v == null ? "" : v < 300 ? "good" : v < 1000 ? "meh" : "bad";

  function renderOutdoors(d, i) {
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const t = s.t2m ? s.t2m[i] - 273.15 : null;
    const w = s.wind ? s.wind[i] : null, g = s.gust ? s.gust[i] : null, rain = s.tp6 ? s.tp6[i] : null, cloud = s.tcc ? s.tcc[i] : null;
    // Wind chill (Environment Canada formula, valid ≤10 °C and wind ≥ 4.8 km/h)
    let chill = null;
    if (t != null && w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); chill = 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; }
    const snowLevel = fl != null ? Math.max(0, fl - 300) : null;      // ~300 m below the 0 °C isotherm
    const ptype = rain != null && rain > 0.2 ? (t != null && t < 1 ? "snow" : t != null && t < 3 ? "rain/snow" : "rain") : "dry";
    const j0 = i, j1 = Math.min(d.steps.length - 1, i + 4);
    const rain24 = s.tp6 ? s.tp6.slice(j0 + 1, j1 + 1).reduce((a, b) => a + (b || 0), 0) : null;
    const gusts = s.gust ? s.gust.slice(j0, j1 + 1).filter((v) => v != null) : [];
    const gustMax24 = gusts.length ? Math.max(...gusts) : null;
    const calm = state.units === "kt" ? 12 : state.units === "ms" ? 6 : 22, gusty = state.units === "kt" ? 25 : state.units === "ms" ? 13 : 46;
    const rows = [
      ["Precip now", `${ptype}${rain != null && rain > 0 ? ` · ${rain.toFixed(1)} mm/6h` : ""}`, ptype === "dry" ? "good" : ptype === "snow" ? "meh" : ""],
      ["Next 24 h rain", rain24 != null ? `${rain24.toFixed(1)} mm` : "—", rain24 == null ? "" : rain24 < 1 ? "good" : rain24 < 10 ? "meh" : "bad"],
      ["Freezing level", fl != null ? `${fl} m` : "—", ""],
      ["Snow level (≈)", snowLevel != null ? `${Math.round(snowLevel / 50) * 50} m` : "—", ""],
      ["Wind / gust", w != null ? `${speed(w).toFixed(0)}${g != null ? ` G${speed(g).toFixed(0)}` : ""} ${speedUnit()}` : "—", w == null ? "" : speed(w) < calm ? "good" : "meh"],
      ["Max gust 24 h", gustMax24 != null ? `${speed(gustMax24).toFixed(0)} ${speedUnit()}` : "—", gustMax24 == null ? "" : speed(gustMax24) < gusty ? "good" : "bad"],
      ["Feels like", chill != null ? `${chill.toFixed(0)}° (wind chill)` : t != null ? `${t.toFixed(0)}°` : "—", chill != null && chill < -10 ? "bad" : ""],
      ["Cloud", cloud != null ? `${(cloud * 100).toFixed(0)}%` : "—", cloud == null ? "" : cloud < 0.3 ? "good" : ""],
      ["Thunder risk (CAPE)", s.cape && s.cape[i] != null ? `${s.cape[i].toFixed(0)} J/kg` : "n/a", capeClass(s.cape && s.cape[i])],
    ];
    $("#outdoors").innerHTML = `<dl class="kv">${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`).join("")}</dl>
      <div class="note">Hiking / skiing / paddling read: snow level ≈ freezing level − 300 m; gusts are the model's 10 m gust where it ships one (IFS, GFS); tap the tape to move the day. Terrain is unresolved at 0.25° — a valley or a ridge will differ.</div>`;
  }

  function drawMeteogram(d) {
    const c = $("#meteogram"), ctx = c.getContext("2d");
    const W = c.width, H = c.height, padL = 34, padR = 40, padT = 12, padB = 26;
    ctx.clearRect(0, 0, W, H);
    const n = d.steps.length, xs = d.steps.map((_, i) => padL + (W - padL - padR) * i / (n - 1));
    const t = (d.series.t2m || []).map((v) => v == null ? null : v - 273.15);
    const rain = d.series.tp6 || [];
    const windS = (d.series.wind || []).map((v) => v == null ? null : speed(v));
    const rMax = Math.max(5, ...rain.filter((v) => v != null));
    ctx.fillStyle = "rgba(108,182,255,0.55)";
    rain.forEach((v, i) => { if (v == null) return; const h = (H - padT - padB) * v / rMax; const bw = Math.max(2, (W - padL - padR) / n - 2); ctx.fillRect(xs[i] - bw / 2, H - padB - h, bw, h); });
    const tv = t.filter((v) => v != null);
    if (tv.length) {
      const lo = Math.floor(Math.min(...tv) / 5) * 5 - 2, hi = Math.ceil(Math.max(...tv) / 5) * 5 + 2;
      const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
      ctx.strokeStyle = "rgba(255,180,84,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      for (let g = lo; g <= hi; g += 5) { ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W - padR, y(g)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2; ctx.beginPath();
      t.forEach((v, i) => { if (v == null) return; i === 0 ? ctx.moveTo(xs[i], y(v)) : ctx.lineTo(xs[i], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "#ffb454"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "right";
      ctx.fillText(`${hi.toFixed(0)}°`, padL - 4, y(hi) + 4); ctx.fillText(`${lo.toFixed(0)}°`, padL - 4, y(lo) + 4);
    }
    const wv = windS.filter((v) => v != null);
    if (wv.length) {
      const hi = Math.max(state.units === "ms" ? 6 : 20, Math.ceil(Math.max(...wv) / 10) * 10);
      const y = (v) => padT + (H - padT - padB) * (1 - v / hi);
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.2; ctx.beginPath();
      windS.forEach((v, i) => { if (v == null) return; i === 0 ? ctx.moveTo(xs[i], y(v)) : ctx.lineTo(xs[i], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.textAlign = "left"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace";
      ctx.fillText(`${hi} ${speedUnit()}`, W - padR + 4, y(hi) + 4);
      ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillText(`${rMax.toFixed(0)} mm`, W - padR + 4, padT + 18);
    }
    ctx.fillStyle = "#7f8794"; ctx.font = "500 10.5px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "left";
    let lastDay = null;
    d.valid.forEach((iso, i) => {
      const dt = new Date(iso), day = dt.toDateString();
      if (day !== lastDay) { lastDay = day; ctx.fillRect(xs[i], padT, 1, H - padT - padB); ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), xs[i] + 3, H - 8); }
    });
    const i = Math.min(state.stepIdx, n - 1);
    ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillRect(xs[i] - 1, padT, 2, H - padT - padB);
  }

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  window.addEventListener("unhandledrejection", (e) => { if (e.reason && e.reason.name === "AbortError") e.preventDefault(); });
  boot().catch((e) => { console.error(e); toast("wxgrid failed to start: " + e.message, 10000); });
})();
