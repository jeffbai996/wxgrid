// Vertical cross-section along a drawn line: drag
// two points on the map, get a slice of the atmosphere between them —
// temperature shading, wind barbs, geopotential-height contours, freezing
// level and the surface trace underneath. Everything comes from /api/xsection
// for the step on screen.
(function () {
  "use strict";
  const WX = window.WX;
  const M = () => WX.map;
  const $ = (s) => document.querySelector(s);
  let pts = [], data = null, req = 0, hoverX = null;

  const style = document.createElement("style");
  style.textContent = `
  #xs { position: absolute; left: 12px; right: 12px; bottom: calc(var(--tb-h) + 22px + env(safe-area-inset-bottom)); z-index: 7;
        background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); backdrop-filter: blur(10px);
        padding: 8px 10px 6px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  #xs[hidden] { display: none; }
  #xs .xs-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  #xs .xs-title { font: 800 13px var(--font-display); letter-spacing: -.01em; }
  #xs .xs-sub { font: 500 11px var(--font-mono); color: var(--dim); }
  #xs .xs-legend { margin-left: auto; margin-right: 30px; display: flex; gap: 10px; align-items: center; font: 500 10.5px var(--font-mono); color: var(--dim); }
  #xs .xs-legend i { display: inline-block; width: 26px; height: 7px; border-radius: 4px; vertical-align: middle; margin-right: 4px;
      background: linear-gradient(to right, rgb(75,42,180), rgb(40,150,220), rgb(100,200,200), rgb(110,210,110), rgb(240,220,80), rgb(240,130,40)); }
  #xs canvas { width: 100%; height: 230px; display: block; cursor: crosshair; }
  #xs .xs-close { position: absolute; top: 6px; right: 8px; width: 24px; height: 24px; font-size: 13px; }
  #xs .xs-hint { font: 500 11px var(--font-body); color: var(--dim); padding: 18px 4px; }
  @media (max-width: 820px) { #xs canvas { height: 170px; } #xs .xs-legend { display: none; } }
  `;
  document.head.appendChild(style);

  function box() {
    let el = $("#xs");
    if (!el) {
      el = document.createElement("div"); el.id = "xs"; el.hidden = true;
      el.innerHTML = `<div class="xs-head"><span class="xs-title">Cross section</span><span class="xs-sub"></span>
        <span class="xs-legend"><span><i></i>temperature</span><span>— height</span></span></div>
        <button class="icon xs-close" title="Close">×</button><canvas></canvas>`;
      document.body.appendChild(el);
      el.querySelector(".xs-close").onclick = stop;
      const c = el.querySelector("canvas");
      c.addEventListener("mousemove", (e) => { const r = c.getBoundingClientRect(); hoverX = (e.clientX - r.left) / r.width; draw(); });
      c.addEventListener("mouseleave", () => { hoverX = null; draw(); });
    }
    return el;
  }

  function start() {
    pts = []; data = null;
    WX.state.xsection = true;
    WX.fn.toast("Tap the two ends of the section.", 4000);
    paintLine();
  }
  function stop() {
    WX.state.xsection = false; pts = []; data = null;
    box().hidden = true;
    const t = document.querySelector("#xsection-toggle"); if (t) t.classList.remove("on");
    ["xs-line", "xs-pts"].forEach((l) => M().getLayer(l) && M().removeLayer(l));
    ["xs-line", "xs-pts"].forEach((sname) => M().getSource(sname) && M().removeSource(sname));
  }
  function click(ll) {
    if (pts.length >= 2) pts = [];
    pts.push([ll.lng, ll.lat]);
    paintLine();
    if (pts.length === 2) load();
  }
  function paintLine() {
    const line = { type: "FeatureCollection", features: pts.length === 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: pts }, properties: {} }] : [] };
    const dots = { type: "FeatureCollection", features: pts.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} })) };
    if (M().getSource("xs-line")) { M().getSource("xs-line").setData(line); M().getSource("xs-pts").setData(dots); return; }
    M().addSource("xs-line", { type: "geojson", data: line });
    M().addSource("xs-pts", { type: "geojson", data: dots });
    M().addLayer({ id: "xs-line", type: "line", source: "xs-line", paint: { "line-color": "#ff8a3d", "line-width": 2.5, "line-dasharray": [2, 1.2] } });
    M().addLayer({ id: "xs-pts", type: "circle", source: "xs-pts", paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#ff8a3d", "circle-stroke-width": 2.5 } });
  }
  async function load() {
    const el = box(); el.hidden = false;
    el.querySelector(".xs-sub").textContent = "loading…";
    const my = ++req;
    try {
      const [a, b] = pts;
      const d = await WX.api(`${WX.API}/xsection?lat1=${a[1].toFixed(3)}&lon1=${WX.wlon(a[0]).toFixed(3)}&lat2=${b[1].toFixed(3)}&lon2=${WX.wlon(b[0]).toFixed(3)}&step=${WX.stepHours}&model=${WX.state.model}&run=${WX.state.run}&n=100`);
      if (my !== req) return;
      data = d; draw();
    } catch (e) { if (my === req) { data = null; el.querySelector(".xs-sub").textContent = ""; el.querySelector("canvas").getContext("2d").clearRect(0, 0, 3000, 600); WX.fn.toast("No cross section for this model.", 4000, "error"); } }
  }

  // ── drawing ────────────────────────────────────────────────────────────
  const TEMP_STOPS = [[-60, [60, 20, 120]], [-40, [75, 42, 180]], [-20, [40, 150, 220]], [0, [100, 200, 200]], [10, [110, 210, 110]], [20, [240, 220, 80]], [32, [240, 130, 40]]];
  function lerp(stops, v) {
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) if (v >= stops[k][0] && v <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    const q = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0] || 1)));
    return a[1].map((x, i) => Math.round(x + (b[1][i] - x) * q));
  }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function draw() {
    if (!data) return;
    const el = box(), c = el.querySelector("canvas"), dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const padL = 44, padR = 8, padT = 6, padB = 20;
    const gw = w - padL - padR, gh = h - padT - padB;
    const levels = data.levels, n = data.n;
    const pTop = Math.min(...levels), pBot = Math.max(...levels);
    const yOf = (p) => padT + gh * (Math.log(p) - Math.log(pTop)) / (Math.log(pBot) - Math.log(pTop));
    const xOf = (i) => padL + gw * i / (n - 1);

    // Temperature field: sampled into a small ImageData (one pixel per column
    // per log-pressure row, interpolated between the stored levels) and blown
    // up with smoothing — a continuous field rather than visible level bands.
    const rows = 140;
    const img = x.createImageData(n, rows);
    const pAt = (row) => Math.exp(Math.log(pTop) + (Math.log(pBot) - Math.log(pTop)) * row / (rows - 1));
    for (let row = 0; row < rows; row++) {
      const pr = pAt(row);
      let li = 0;
      while (li < levels.length - 2 && levels[li + 1] > pr) li++;   // levels descend in pressure: 1000 → 200
      const pA = levels[li], pB = levels[li + 1];
      const f = Math.max(0, Math.min(1, (Math.log(pr) - Math.log(pA)) / (Math.log(pB) - Math.log(pA))));
      for (let i = 0; i < n; i++) {
        const a = data.profile[li].temp[i], b = data.profile[li + 1].temp[i];
        let px = (row * n + i) * 4;
        if (a == null || b == null) { img.data[px + 3] = 0; continue; }
        const t = (a + (b - a) * f) - 273.15;
        const [r, g, bl] = lerp(TEMP_STOPS, t);
        img.data[px] = r; img.data[px + 1] = g; img.data[px + 2] = bl; img.data[px + 3] = 255;
      }
    }
    const off = document.createElement("canvas"); off.width = n; off.height = rows;
    off.getContext("2d").putImageData(img, 0, 0);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(off, padL, padT, gw, gh);

    // 0 °C line: walk each column from the ground up to the first crossing
    x.strokeStyle = "rgba(255,255,255,.92)"; x.lineWidth = 1.6; x.setLineDash([5, 3]); x.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      let y = null;
      for (let li = 0; li < levels.length - 1; li++) {
        const a = data.profile[li].temp[i], b = data.profile[li + 1].temp[i];
        if (a == null || b == null) continue;
        const ta = a - 273.15, tb = b - 273.15;
        if (ta >= 0 && tb < 0) { const f = ta / (ta - tb); y = yOf(levels[li]) + (yOf(levels[li + 1]) - yOf(levels[li])) * f; break; }
      }
      if (y == null) { started = false; continue; }
      if (!started) { x.moveTo(xOf(i), y); started = true; } else x.lineTo(xOf(i), y);
    }
    x.stroke(); x.setLineDash([]);

    // wind barbs on a sparse grid
    x.strokeStyle = "rgba(255,255,255,.85)"; x.fillStyle = x.strokeStyle; x.lineWidth = 1.1;
    const everyI = Math.max(1, Math.round(n / 14));
    for (let li = 0; li < levels.length; li++) {
      if (levels.length > 6 && li % 2 === 1) continue;
      for (let i = Math.floor(everyI / 2); i < n; i += everyI) {
        const spd = data.profile[li].wind[i], dir = data.profile[li].wdir[i];
        if (spd == null || dir == null) continue;
        barb(x, xOf(i), yOf(levels[li]), spd * 1.943844, dir);
      }
    }
    // surface trace: shaded band from the bottom, with precip ticks
    const sfc = data.surface || {};
    x.fillStyle = css("--panel-solid") || "#0a0b0d";
    x.globalAlpha = 0.92; x.fillRect(padL, padT + gh, gw, padB); x.globalAlpha = 1;
    if (sfc.tp6) {
      for (let i = 0; i < n; i++) {
        const mm = sfc.tp6[i]; if (!mm || mm < 0.1) continue;
        const hgt = Math.min(gh * 0.28, Math.log10(1 + mm) * 34);
        x.fillStyle = "rgba(108,182,255,.55)";
        x.fillRect(xOf(i) - gw / (n - 1) / 2, padT + gh - hgt, Math.max(1.5, gw / (n - 1)), hgt);
      }
    }
    // axes
    x.fillStyle = css("--dim") || "#7c8492"; x.font = `500 10px ${css("--font-mono") || "monospace"}`;
    x.textAlign = "right"; x.textBaseline = "middle";
    levels.forEach((p) => { if (levels.length > 6 && p % 100 !== 0 && p !== 925) return; x.fillText(String(p), padL - 6, yOf(p)); });
    x.save(); x.translate(12, padT + gh / 2); x.rotate(-Math.PI / 2); x.textAlign = "center"; x.fillText("hPa", 0, 0); x.restore();
    x.textAlign = "center"; x.textBaseline = "top";
    for (let k = 0; k <= 4; k++) { const i = Math.round((n - 1) * k / 4); x.fillText(WX.units.dist(data.dist_km[i], 0).txt, xOf(i), padT + gh + 5); }
    x.strokeStyle = css("--line") || "rgba(255,255,255,.1)"; x.lineWidth = 1;
    x.strokeRect(padL, padT, gw, gh);

    // hover readout
    if (hoverX != null) {
      const i = Math.max(0, Math.min(n - 1, Math.round((hoverX * w - padL) / gw * (n - 1))));
      x.strokeStyle = css("--accent") || "#ff8a3d"; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(xOf(i), padT); x.lineTo(xOf(i), padT + gh); x.stroke();
      const t2 = sfc.t2m && sfc.t2m[i] != null ? WX.units.temp(sfc.t2m[i]).txt : "—";
      const lab = `${data.lats[i].toFixed(2)}°, ${data.lons[i].toFixed(2)}° · sfc ${t2}`;
      x.font = `600 11px ${css("--font-display") || "sans-serif"}`;
      const tw = x.measureText(lab).width + 12;
      const bx = Math.min(w - padR - tw, Math.max(padL, xOf(i) - tw / 2));
      x.fillStyle = css("--panel-solid") || "#0a0b0d"; x.fillRect(bx, padT + 2, tw, 18);
      x.strokeStyle = css("--line-strong") || "rgba(255,255,255,.2)"; x.strokeRect(bx, padT + 2, tw, 18);
      x.fillStyle = css("--fg") || "#fff"; x.textAlign = "left"; x.textBaseline = "middle";
      x.fillText(lab, bx + 6, padT + 11);
    }

    const v = new Date(data.valid);
    el.querySelector(".xs-sub").textContent = `${WX.units.dist(data.length_km, 0).txt} · ${data.model.toUpperCase()} · ${v.toLocaleString(undefined, WX.units.timeOpts({ weekday: "short", hour: "numeric" }))}`;
  }

  // small barb, staff into the wind
  function barb(x, cx, cy, kt, dirFromDeg) {
    const len = 13, rad = (dirFromDeg) * Math.PI / 180;
    const dx = Math.sin(rad), dy = -Math.cos(rad);
    if (kt < 2.5) { x.beginPath(); x.arc(cx, cy, 2, 0, Math.PI * 2); x.stroke(); return; }
    const ex = cx + dx * len, ey = cy + dy * len;
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(ex, ey); x.stroke();
    const px = -dy, py = dx;
    let rem = Math.round(kt / 5) * 5, pos = 0; const stp = 3.2, bl = 6;
    const at = (t) => [ex - dx * t, ey - dy * t];
    while (rem >= 50) { const [ax, ay] = at(pos), [bx2, by2] = at(pos + stp); x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax + px * bl, ay + py * bl); x.lineTo(bx2, by2); x.closePath(); x.fill(); pos += stp + 1.2; rem -= 50; }
    while (rem >= 10) { const [ax, ay] = at(pos); x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax + px * bl, ay + py * bl); x.stroke(); pos += stp; rem -= 10; }
    if (rem >= 5) { const [ax, ay] = at(pos === 0 ? stp : pos); x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax + px * bl / 2, ay + py * bl / 2); x.stroke(); }
  }

  WX.xs = { start, stop, click, refresh: () => { if (pts.length === 2) load(); }, get active() { return !!WX.state.xsection; } };
})();
