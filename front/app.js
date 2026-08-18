// wxgrid front end: model/run/layer/step state → one MapLibre image layer +
// the wind particle canvas + a point-forecast card. All data from /api.
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const API = "api";
  const WORLD = [[-180, 85.05112878], [180, 85.05112878], [180, -85.05112878], [-180, -85.05112878]];
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", t2m: "Temp", msl: "Pressure", tp6: "Rain" };

  const state = {
    catalog: null, model: null, run: null, layer: "wind", stepIdx: 0,
    playing: false, particles: true, point: null,
  };
  let map, wind, catalog, playTimer = null;

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const saved = JSON.parse(localStorage.getItem("wxgrid.view") || "null");
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/dark",
      center: saved ? saved.center : [-123, 45], zoom: saved ? saved.zoom : 3.2,
      minZoom: 1.2, maxZoom: 9, attributionControl: false, renderWorldCopies: true,
      fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "" }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("moveend", () => localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() })));
    wind = new WindLayer(map, $("#particles"));

    catalog = await (await fetch(`${API}/models`, { cache: "no-store" })).json();
    state.catalog = catalog;
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs in the store yet — ingest is still running.", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];

    map.on("load", () => {
      map.addSource("wx", { type: "image", url: layerUrl(), coordinates: WORLD });
      // Under the label layers so place names stay legible over the colour field.
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol");
      map.addLayer({ id: "wx", type: "raster", source: "wx",
                     paint: { "raster-opacity": 0.82, "raster-fade-duration": 0, "raster-resampling": "linear" } },
                   firstSymbol ? firstSymbol.id : undefined);
      // Move the particle canvas out of the way when the user drags — it's
      // pointer-events:none already; nothing to do. Clicks go to the map:
      map.on("click", (e) => openPoint(e.lngLat.lat, e.lngLat.lng));
      renderControls();
      applyStep();
      loadWind();
    });
  }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + stepHours() * 3600e3);
  const layerUrl = () => `${API}/layer/${state.model}/${state.run}/${stepHours()}/${state.layer}.png`;
  const windUrl = () => `${API}/wind/${state.model}/${state.run}/${stepHours()}.json`;

  // ── controls ──────────────────────────────────────────────────────────
  function renderControls() {
    const ms = $("#model");
    ms.innerHTML = catalog.models.map((m) => `<option value="${m.key}" ${m.runs.length ? "" : "disabled"}>${m.label}${m.runs.length ? "" : " (no run yet)"}</option>`).join("");
    ms.value = state.model;
    ms.onchange = () => switchModel(ms.value);

    const rs = $("#run");
    rs.innerHTML = modelEntry().runs.map((r) => `<option value="${r.run}">${r.run.replace("T", " ")}Z</option>`).join("");
    rs.value = state.run;
    rs.onchange = () => { state.run = rs.value; clampStep(); renderControls(); applyStep(); loadWind(); };

    const chips = $("#layers");
    chips.innerHTML = ["wind", "gust", "t2m", "msl", "tp6"].map((l) =>
      `<button class="chip ${l === state.layer ? "on" : ""}" data-layer="${l}" ${runEntry().layers.includes(l) ? "" : "disabled"}>${LAYER_LABEL[l]}</button>`).join("");
    chips.querySelectorAll(".chip").forEach((b) => b.onclick = () => {
      state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer);
      renderControls(); applyStep(); });

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
    $("#locate").onclick = () => navigator.geolocation && navigator.geolocation.getCurrentPosition(
      (p) => { map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(map.getZoom(), 6) }); openPoint(p.coords.latitude, p.coords.longitude); },
      () => toast("Location unavailable"));
    $("#point-close").onclick = closePoint;
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight") { nudge(1); }
      else if (e.key === "ArrowLeft") { nudge(-1); }
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    });
  }

  function switchModel(key) {
    // Keep the VALID time when switching models, not the step index — the
    // whole point of a model picker is comparing the same moment.
    const target = validDate().getTime();
    state.model = key; localStorage.setItem("wxgrid.model", key);
    state.run = modelEntry().runs[0].run;
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind();
    if (state.point) openPoint(state.point.lat, state.point.lon);
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  function nudge(d) { state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); }

  function applyStep(prefetch = true) {
    const src = map.getSource("wx");
    // MapLibre aborts the in-flight image when a newer one is requested and
    // logs it as an error; that's the scrubber working as intended.
    if (src) { try { src.updateImage({ url: layerUrl(), coordinates: WORLD }); } catch (e) { /* superseded */ } }
    const v = validDate();
    $("#valid-local").textContent = v.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    $("#lead").textContent = `+${stepHours()}h`;
    if (prefetch) {
      const nxt = steps()[(state.stepIdx + 1) % steps().length];
      const img = new Image(); img.src = `${API}/layer/${state.model}/${state.run}/${nxt}/${state.layer}.png`;
    }
    if (state.point) renderPointNow();
  }

  let windReq = 0;
  async function loadWind() {
    if (!runEntry().layers.includes("wind")) { wind.setField(null); return; }
    const my = ++windReq;
    try {
      const f = await (await fetch(windUrl())).json();
      if (my !== windReq) return;
      wind.setField(f);
      // Prefetch the next step's vectors while the eye is on this one.
      const nxt = steps()[(state.stepIdx + 1) % steps().length];
      fetch(`${API}/wind/${state.model}/${state.run}/${nxt}.json`).catch(() => {});
    } catch (e) { /* keep the previous field */ }
  }

  function togglePlay() {
    state.playing = !state.playing;
    $("#play").textContent = state.playing ? "❚❚" : "▶";
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (state.playing) playTimer = setInterval(() => nudge(1), 900);
  }

  function renderLegend() {
    const lg = catalog.layers.find((l) => l.layer === state.layer);
    if (!lg) { $("#legend").hidden = true; return; }
    $("#legend").hidden = false;
    const grad = lg.stops.map((s) => `rgb(${s.rgb.join(",")}) ${((s.v - lg.lo) / (lg.hi - lg.lo) * 100).toFixed(1)}%`).join(", ");
    $(".legend-bar").style.background = `linear-gradient(to right, ${grad})`;
    const ticks = [lg.lo, lg.lo + (lg.hi - lg.lo) * 0.25, lg.lo + (lg.hi - lg.lo) * 0.5, lg.lo + (lg.hi - lg.lo) * 0.75, lg.hi];
    $(".legend-ticks").innerHTML = ticks.map((t, i) => `<span>${i === 2 ? `<b>${LAYER_LABEL[state.layer]}</b> ` : ""}${Math.round(t)}${i === 4 ? " " + lg.units : ""}</span>`).join("");
  }

  // ── point forecast ────────────────────────────────────────────────────
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
      renderPointNow();
      drawMeteogram(d);
      $("#point-foot").textContent = `${modelEntry().attribution} · run ${d.run}Z`;
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
  }
  function closePoint() { state.point = null; $("#point").hidden = true; }

  function renderPointNow() {
    const d = state.point && state.point.data; if (!d) return;
    const i = Math.min(state.stepIdx, d.steps.length - 1);
    const s = d.series, f = (v, fn) => (v == null ? "—" : fn(v));
    const parts = [];
    if (s.t2m) parts.push(`<span><b>${f(s.t2m[i], (v) => (v - 273.15).toFixed(0))}°</b> C</span>`);
    if (s.wind) parts.push(`<span><b>${f(s.wind[i], (v) => (v * 3.6).toFixed(0))}</b> km/h ${f(s.wdir && s.wdir[i], (v) => arrow(v))}</span>`);
    if (s.gust) parts.push(`<span>gust <b>${f(s.gust[i], (v) => (v * 3.6).toFixed(0))}</b></span>`);
    if (s.tp6) parts.push(`<span>rain <b>${f(s.tp6[i], (v) => v.toFixed(1))}</b> mm/6h</span>`);
    if (s.msl) parts.push(`<span><b>${f(s.msl[i], (v) => (v / 100).toFixed(0))}</b> hPa</span>`);
    $("#point-now").innerHTML = parts.join("");
    drawMeteogram(d);
  }
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];

  function drawMeteogram(d) {
    const c = $("#meteogram"), ctx = c.getContext("2d");
    const W = c.width, H = c.height, padL = 34, padR = 34, padT = 12, padB = 26;
    ctx.clearRect(0, 0, W, H);
    const n = d.steps.length, xs = d.steps.map((_, i) => padL + (W - padL - padR) * i / (n - 1));
    const t = (d.series.t2m || []).map((v) => v == null ? null : v - 273.15);
    const rain = d.series.tp6 || [];
    const windS = (d.series.wind || []).map((v) => v == null ? null : v * 3.6);
    // rain bars (right axis, mm/6h)
    const rMax = Math.max(5, ...rain.filter((v) => v != null));
    ctx.fillStyle = "rgba(99,179,255,0.55)";
    rain.forEach((v, i) => { if (v == null) return; const h = (H - padT - padB) * v / rMax; const bw = Math.max(2, (W - padL - padR) / n - 2); ctx.fillRect(xs[i] - bw / 2, H - padB - h, bw, h); });
    // temp line (left axis)
    const tv = t.filter((v) => v != null);
    if (tv.length) {
      const lo = Math.floor(Math.min(...tv) / 5) * 5 - 2, hi = Math.ceil(Math.max(...tv) / 5) * 5 + 2;
      const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
      ctx.strokeStyle = "rgba(255,180,84,0.35)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      for (let g = lo; g <= hi; g += 5) { ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W - padR, y(g)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2; ctx.beginPath();
      t.forEach((v, i) => { if (v == null) return; i === 0 ? ctx.moveTo(xs[i], y(v)) : ctx.lineTo(xs[i], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "#ffb454"; ctx.font = "600 11px ui-monospace, monospace"; ctx.textAlign = "right";
      ctx.fillText(`${hi.toFixed(0)}°`, padL - 4, y(hi) + 4); ctx.fillText(`${lo.toFixed(0)}°`, padL - 4, y(lo) + 4);
    }
    // wind line (secondary, thin white)
    const wv = windS.filter((v) => v != null);
    if (wv.length) {
      const hi = Math.max(20, Math.ceil(Math.max(...wv) / 10) * 10);
      const y = (v) => padT + (H - padT - padB) * (1 - v / hi);
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.2; ctx.beginPath();
      windS.forEach((v, i) => { if (v == null) return; i === 0 ? ctx.moveTo(xs[i], y(v)) : ctx.lineTo(xs[i], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.textAlign = "left"; ctx.font = "600 11px ui-monospace, monospace";
      ctx.fillText(`${hi} km/h`, W - padR + 4, y(hi) + 4);
      ctx.fillStyle = "rgba(99,179,255,0.9)"; ctx.fillText(`${rMax.toFixed(0)} mm`, W - padR + 4, H - padB - (H - padT - padB) + 4 + 14);
    }
    // day ticks: one per local calendar day, at its first forecast step
    ctx.fillStyle = "#8b93a1"; ctx.font = "500 10.5px ui-monospace, monospace"; ctx.textAlign = "left";
    let lastDay = null;
    d.valid.forEach((iso, i) => {
      const dt = new Date(iso), day = dt.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        ctx.fillRect(xs[i], padT, 1, H - padT - padB);
        ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), xs[i] + 3, H - 8);
      }
    });
    // current-step marker
    const i = Math.min(state.stepIdx, n - 1);
    ctx.fillStyle = "rgba(99,179,255,0.9)"; ctx.fillRect(xs[i] - 1, padT, 2, H - padT - padB);
  }

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // MapLibre rejects the superseded image request with AbortError when the
  // scrubber moves faster than the network; that's expected, not a fault.
  window.addEventListener("unhandledrejection", (e) => { if (e.reason && e.reason.name === "AbortError") e.preventDefault(); });
  boot().catch((e) => { console.error(e); toast("wxgrid failed to start: " + e.message, 10000); });
})();
