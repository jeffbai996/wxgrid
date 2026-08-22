// The forecast tape under the map (and the radar frame strip).
// Loaded after app.js; exposes WX.tape.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── weather tape ──────────────────────────────────────────────────────
  let tapeReq = 0, tapeKey = "";
  async function refreshTapePoint() {
    const c = M().getCenter();
    const key = `${c.lat.toFixed(2)},${WX.wlon(c.lng).toFixed(2)};${state.model};${state.run}`;
    // Initial map settlement emits moveend after boot has already requested
    // this exact column. Keep the in-flight/result instead of doing the same
    // point-cube read twice.
    if (key === tapeKey) return;
    tapeKey = key;
    const my = ++tapeReq;
    try {
      const d = await WX.api(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${WX.wlon(c.lng).toFixed(2)}&model=${state.model}&run=${state.run}`);
      if (my !== tapeReq) return;
      state.tapePoint = d.available === false ? null : d;
      renderTape();
    } catch (e) {
      if (my !== tapeReq) return;
      tapeKey = "";                       // allow the next moveend to try again
      if (!state.tapePoint) { renderTape(); setTimeout(() => { if (my === tapeReq) refreshTapePoint(); }, 4000); }
    }
  }
  function tapeData() { return state.point && state.point.outside ? null : (state.point && state.point.data) || state.tapePoint; }
  function renderTapePlace() {
    const el = $("#tape-where");
    el.replaceChildren();
    if (!state.point) { el.textContent = "map centre"; return; }
    const name = state.point.name || WX.fmtCoords(state.point.lat, state.point.lon);
    el.append(document.createTextNode(name));
    const region = state.point.local && state.point.local.place && state.point.local.place.region;
    if (region && region.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
      const suffix = document.createElement("span");
      suffix.className = "tape-region";
      suffix.textContent = `, ${region}`;
      el.append(suffix);
    }
  }

  // The tape: a table whose columns are forecast steps grouped under
  // day headers and whose rows are variables (icon, temp, feels like, rain,
  // wind, gusts, direction). Click a column to jump.
  // How many hours between tape columns. Below the run's own spacing the tape
  // interpolates; above it, the tape stops sampling one instant and reports
  // what the whole period did.
  let tapeRes = Number(localStorage.getItem("wxgrid.tapeRes") || 0);      // 0 = the model's own steps
  let fineSelectedValid = null;
  const nativeStep = (d) => (d && d.steps && d.steps.length > 1 ? d.steps[1] - d.steps[0] : 3);
  function renderRes(d) {
    const box = $("#tape-res"); if (!box) return;
    const native = nativeStep(d);
    const opts = [[1, "1 h"], [2, "2 h"], [0, `${native} h`], [6, "6 h"], [12, "12 h"], [24, "24 h"]]
      .filter(([v]) => v === 0 || (v < native ? v : v > native));
    box.innerHTML = opts.map(([v, t]) => `<button data-v="${v}" class="${v === tapeRes ? "on" : ""}">${t}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { tapeRes = Number(b.dataset.v); localStorage.setItem("wxgrid.tapeRes", tapeRes); renderTape(); renderTapeSelection(); });
  }

  // ── column resolution ────────────────────────────────────────────────
  // Series that accumulate over their own interval rather than sampling an
  // instant: they add up when columns merge and split pro rata when a column
  // is divided. Wind direction is an angle, so it wraps.
  const ACCUM = /^(tp|sf)\d+$/;
  const CIRCULAR = new Set(["wdir", "mwd"]);
  const lerpAng = (a, b, f) => { const d = ((b - a + 540) % 360) - 180; return (a + d * f + 360) % 360; };

  // Apparent temperature (wind chill below 10 °C, humidex above 20 °C) in °C.
  // Hoisted out of the renderer so an aggregated column can report the hottest
  // and coldest it actually FELT, not the feel of its own averages.
  function feelsAt(s, i) {
    const t = s.t2m && s.t2m[i] != null ? s.t2m[i] - 273.15 : null, w = s.wind ? s.wind[i] : null;
    if (t == null) return null;
    if (w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; }
    if (s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); return t + 0.5555 * (e - 10); }
    return t;
  }

  // Day and hour in whatever zone the user is reading times in, so "12 h" is
  // this morning and this afternoon where the weather is, not where the
  // browser happens to sit.
  function zoner() {
    const f = new Intl.DateTimeFormat("en-CA", WX.units.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    return (dt) => { const p = {}; for (const x of f.formatToParts(dt)) p[x.type] = x.value;
      return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; };
  }

  const stat = (xs, fn) => { const v = xs.filter((x) => x != null); return v.length ? fn(v) : null; };
  const mean = (xs) => stat(xs, (v) => v.reduce((a, b) => a + b, 0) / v.length);

  // Finer than the model: linear between steps, angles the short way round,
  // and an accumulation window shared out evenly across the columns it covers.
  function interpolate(d0, res) {
    const first = d0.steps[0], last = d0.steps[d0.steps.length - 1], native = nativeStep(d0);
    const steps = []; for (let h = first; h <= last; h += res) steps.push(h);
    if (steps.length < 3) return { d: d0, keep: null, agg: false };
    const t0 = new Date(d0.valid[0]).getTime();
    const seg = (h) => { let k = 0; while (k < d0.steps.length - 2 && d0.steps[k + 1] <= h) k++;
      const span = d0.steps[k + 1] - d0.steps[k]; return [k, span ? (h - d0.steps[k]) / span : 0]; };
    const win = (h) => { let j = 1; while (j < d0.steps.length - 1 && d0.steps[j] < h) j++; return j; };
    const series = {};
    for (const [name, arr] of Object.entries(d0.series)) {
      if (!Array.isArray(arr)) { series[name] = arr; continue; }
      if (ACCUM.test(name)) { const share = res / native; series[name] = steps.map((h) => { const v = arr[win(h)]; return v == null ? null : v * share; }); continue; }
      series[name] = steps.map((h) => {
        const [k, f] = seg(h), a = arr[k], b = arr[k + 1];
        if (a == null || b == null) return a == null ? (b == null ? null : b) : a;
        return CIRCULAR.has(name) ? lerpAng(a, b, f) : a + (b - a) * f;
      });
    }
    // Clicking an interpolated column jumps to the model step nearest it —
    // the map only has the frames the model actually produced.
    const keep = steps.map((h) => d0.steps.reduce((best, sh, i) => (Math.abs(sh - h) < Math.abs(d0.steps[best] - h) ? i : best), 0));
    return { d: { ...d0, steps, valid: steps.map((h) => new Date(t0 + (h - first) * 3600e3).toISOString()), series, _keep: keep }, keep, agg: false };
  }

  // Coarser than the model: buckets aligned to the local clock, each reporting
  // the period it covers — warmest and coldest, everything that fell, the
  // strongest wind — instead of whichever instant happened to land on it.
  function aggregate(d0, res) {
    const zk = zoner(), dates = d0.valid.map((v) => new Date(v));
    const buckets = [];
    dates.forEach((dt, i) => {
      const { day, hour } = zk(dt);
      const key = res >= 24 ? day : `${day}#${Math.floor(hour / res)}`;
      const last = buckets[buckets.length - 1];
      if (last && last.key === key) last.idx.push(i); else buckets.push({ key, idx: [i], hour });
    });
    if (buckets.length < 3) return { d: d0, keep: null, agg: false };
    const s0 = d0.series, pick = (b) => b.idx[Math.floor((b.idx.length - 1) / 2)];
    const series = {};
    for (const [name, arr] of Object.entries(s0)) {
      if (!Array.isArray(arr)) { series[name] = arr; continue; }
      series[name] = buckets.map((b) => {
        const v = b.idx.map((i) => arr[i]);
        if (ACCUM.test(name)) return stat(v, (x) => x.reduce((a, c) => a + c, 0));
        if (name === "t2m" || name === "wind" || name === "gust" || name === "cape") return stat(v, (x) => Math.max(...x));
        if (name === "wdir") { const w = s0.wind ? b.idx.reduce((a, i) => (s0.wind[i] > s0.wind[a] ? i : a), b.idx[0]) : pick(b); return arr[w]; }
        return mean(v);
      });
    }
    // The rows that need a second number: the cold end of the period, and how
    // it felt at both ends.
    series.t2m_lo = buckets.map((b) => stat(b.idx.map((i) => s0.t2m && s0.t2m[i]), (x) => Math.min(...x)));
    const fl = buckets.map((b) => b.idx.map((i) => feelsAt(s0, i)).filter((x) => x != null));
    series.feels_hi = fl.map((v) => (v.length ? Math.max(...v) : null));
    series.feels_lo = fl.map((v) => (v.length ? Math.min(...v) : null));
    const keep = buckets.map(pick);
    return { d: { ...d0, steps: keep.map((i) => d0.steps[i]), valid: keep.map((i) => d0.valid[i]), series, _keep: keep },
             keep, agg: true, res, buckets };
  }

  function resample(d0) {
    const native = nativeStep(d0);
    if (!tapeRes || tapeRes === native || !d0.steps) return { d: d0, keep: null, agg: false };
    return tapeRes < native ? interpolate(d0, tapeRes) : aggregate(d0, tapeRes);
  }

  function renderTape() {
    const tape = $("#tape");
    tape.classList.toggle("radar", state.radar && state.radarFrames.length > 0);
    if (state.radar && state.radarFrames.length) {
      let html = "", lastDay = null;
      state.radarFrames.forEach((fr, i) => {
        const t = new Date(fr.time * 1000), day = t.toDateString();
        if (day !== lastDay) { if (lastDay !== null) html += "</div></div>"; html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short" })} · radar</div><div class="tape-cols">`; lastDay = day; }
        html += `<div class="tape-col ${fr.kind}" data-radar="${i}"><span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span class="tape-glyph" style="color:${fr.kind === "nowcast" ? "var(--warm)" : "var(--rain)"};text-align:center">${fr.kind === "nowcast" ? "◌" : "●"}</span></div>`;
      });
      tape.innerHTML = html + "</div></div>";
      tape.querySelectorAll(".tape-col").forEach((c) => c.onclick = () => { state.radarIdx = Number(c.dataset.radar); WX.ov.applyRadarFrame(); });
      $("#tape-where").textContent = "";
      renderTapeSelection();
      return;
    }
    const d0 = tapeData();
    // An empty tape under a live scrubber reads as broken. Say what is happening.
    if (!d0) { tape.innerHTML = `<div class="tape-empty">${tapeKey ? "loading the forecast for the map centre…" : "forecast unavailable here"}</div>`; return; }
    renderRes(d0);
    // resampling maps every series onto the chosen columns, so the rest of the
    // renderer never has to know whether it is showing model steps, columns
    // between them, or whole periods
    const { d, keep, agg, res: aggRes } = resample(d0);
    const s = d.series, n = d.steps.length;
    const dates = d.valid.map((iso) => new Date(iso));
    const zk = zoner();
    // day header cells: colspan per day, grouped in the zone the times are
    // shown in so the header cannot disagree with the columns under it
    const days = [];
    dates.forEach((dt, i) => { const k = zk(dt).day; if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, start: dt, first: i, span: 0 }); days[days.length - 1].span++; });
    // a day header is a jump: sixteen days of tape is a long way to scrub
    const dayRow = days.map((dy) => { const wd = dy.start.getDay();
      return `<th colspan="${dy.span}" class="day${wd === 0 || wd === 6 ? " wknd" : ""}" data-first="${dy.first}" title="Jump to this day">${dy.start.toLocaleDateString(undefined, WX.units.timeOpts({ weekday: "long", day: "numeric" }))}</th>`; }).join("");
    // sunrise/sunset as thin amber notches on the hour row: compute each
    // day's events once, then find the column whose span holds them
    const sunCols = new Map();   // shown index -> "rise"|"set"
    if (WXPanes && WXPanes.sunTimes && state.point) {
      const seen = new Set();
      dates.forEach((dt, k) => {
        const dk = dt.toISOString().slice(0, 10);
        if (seen.has(dk)) return; seen.add(dk);
        const st = WXPanes.sunTimes(state.point.lat, state.point.lon, dt);
        if (!st) return;
        for (const [which, hUtc] of [["rise", st.riseUtc], ["set", st.setUtc]]) {
          const ev = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) + hUtc * 3600e3;
          let best = -1, bd = Infinity;
          dates.forEach((d2, k2) => { const diff = Math.abs(d2.getTime() - ev); if (diff < bd) { bd = diff; best = k2; } });
          if (best >= 0 && bd < 3600e3 * 2) sunCols.set(best, which);
        }
      });
    }
    // the column whose interval holds the current wall-clock time gets a mark
    const nowMs = Date.now();
    const nowIdx = dates.findIndex((dt, i) => nowMs >= dt.getTime() && (i + 1 >= n || nowMs < dates[i + 1].getTime()));
    const cell = (i, inner, cls = "") => `<td class="${cls} ${dates[i].getHours() < 6 || dates[i].getHours() >= 21 ? "night" : ""}${i === nowIdx ? " now" : ""}${sunCols.has(i) ? ` sun-${sunCols.get(i)}` : ""}" data-i="${i}">${inner}</td>`;
    // A column that covers half a day is named for that half, not for whichever
    // hour its sample landed on; a column that covers a whole day is named by
    // the date above it and needs no clock at all.
    const hourTxt = (dt) => dt.toLocaleTimeString(undefined, WX.units.timeOpts({ hour: "numeric" }));
    const halfTxt = (dt) => (zk(dt).hour < 12 ? "AM" : "PM");
    const showHours = !(agg && aggRes >= 24);
    const colTxt = (dt) => (agg && aggRes === 12 ? halfTxt(dt)
      : `${hourTxt(dt).replace(":00", "").replace(/\s/, "<small>")}${/[ap]m/i.test(hourTxt(dt)) ? "</small>" : ""}`);
    const hourRow = dates.map((dt, i) => cell(i, `<span class="hr">${colTxt(dt)}</span>`, "hour")).join("");
    const iconRow = dates.map((_, i) => cell(i, glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, dates[i].getHours() < 6 || dates[i].getHours() >= 21), "ico")).join("");
    const pair = (hi, lo, fmt) => (hi == null ? "—" : `${fmt(hi)}${lo == null ? "" : `<span class="lo">${fmt(lo)}</span>`}`);
    const degC = (v) => `${WX.units.tempC(v).v}°`, degK = (v) => `${WX.units.temp(v).v}°`;
    const tempRow = dates.map((_, i) => cell(i, agg ? pair(s.t2m && s.t2m[i], s.t2m_lo && s.t2m_lo[i], degK)
      : s.t2m && s.t2m[i] != null ? degK(s.t2m[i]) : "—", "temp")).join("");
    const feelsRow = dates.map((_, i) => { const v = agg ? null : feelsAt(s, i);
      return cell(i, agg ? pair(s.feels_hi && s.feels_hi[i], s.feels_lo && s.feels_lo[i], degC) : v == null ? "—" : degC(v), "feels"); }).join("");
    // No bars under the amounts: they read as a mystery meter in a row this
    // short (Jeff 2026-08-20, "remove them cus thers not enough space").
    const rainRow = dates.map((_, i) => { const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0; if (r == null) return cell(i, "", "rain"); if (sn >= 0.3) return cell(i, `<span class="snow">${WX.units.snow(sn).v}</span>`, "rain"); return cell(i, r >= 0.1 ? `<span>${WX.units.precip(r).v}</span>` : "", "rain"); }).join("");
    // Chance of rain, from the members, only where it says something —
    // a row of zeros is noise dressed as information
    const probRow = s.prob_rain && s.prob_rain.some((v) => v >= 10)
      ? dates.map((_, i) => { const v = s.prob_rain[i]; return cell(i, v == null || v < 5 ? "" : `<span style="opacity:${0.45 + 0.55 * v / 100}">${Math.round(v)}</span>`, "prob"); }).join("")
      : "";
    // the map's own wind ramp, so a colour in the tape means the colour on the
    // map — and light text on the dark end, dark text on the hot end
    const windCol = (v) => {
      const c = WX.rampColor("wind", v, 0.92);
      const light = v * 3.6 > 45;
      return `background: ${c}; color: ${light ? "#160b03" : "var(--fg)"}`;
    };
    const windRow = dates.map((_, i) => { const v = s.wind ? s.wind[i] : null; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("");
    const gustRow = s.gust ? dates.map((_, i) => { const v = s.gust[i]; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("") : "";
    const dirRow = dates.map((_, i) => cell(i, s.wdir && s.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(s.wdir[i])}"></i>` : "", "dir")).join("");
    const label = (t, u) => `<th class="lab">${t}${u ? `<small>${u}</small>` : ""}</th>`;
    tape.innerHTML = `<table class="wtape${agg ? " agg" : ""}"><thead><tr><th class="lab corner"></th>${dayRow}</tr></thead><tbody>
      ${showHours ? `<tr class="r-hour">${label("Time")}${hourRow}</tr>` : ""}
      <tr class="r-icon">${label("")}${iconRow}</tr>
      <tr class="r-temp">${label(agg ? "Temp high / low" : "Temp", WX.units.tempUnit)}${tempRow}</tr>
      <tr class="r-feels">${label(agg ? "Feels high / low" : "Feels like", WX.units.tempUnit)}${feelsRow}</tr>
      <tr class="r-rain">${label("Precip", `${WX.units.precipUnit} · ${WX.units.snowUnit}`)}${rainRow}</tr>
      ${probRow ? `<tr class="r-prob">${label("Chance", "%")}${probRow}</tr>` : ""}
      <tr class="r-wind">${label("Wind", speedUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${label("Gusts", speedUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${label("Direction")}${dirRow}</tr>
    </tbody></table>`;
    const pick = (shown) => {
      const native = keep ? keep[shown] : shown;
      WX.fn.setStep(native);
      fineSelectedValid = d.valid[shown];
      renderTapeSelection();
    };
    tape.querySelectorAll("td[data-i]").forEach((c) => c.onclick = () => pick(Number(c.dataset.i)));
    tape.querySelectorAll("th.day[data-first]").forEach((c) => c.onclick = () => pick(Number(c.dataset.first)));
    renderTapePlace();
    renderTapeSelection();
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const radar = state.radar && state.radarFrames.length;
    const d0 = tapeData();
    const keep = d0 ? resample(d0).keep : null;
    // the shown column for a step: exact when the tape is at full resolution,
    // otherwise the nearest kept column
    const sampled = d0 ? resample(d0).d : null;
    const shown = fineSelectedValid && sampled
      ? sampled.valid.reduce((best, iso, k, vals) => Math.abs(new Date(iso) - new Date(fineSelectedValid)) < Math.abs(new Date(vals[best]) - new Date(fineSelectedValid)) ? k : best, 0)
      : !keep ? state.stepIdx : keep.reduce((best, idx, k) => Math.abs(idx - state.stepIdx) < Math.abs(keep[best] - state.stepIdx) ? k : best, 0);
    let on = null;
    tape.querySelectorAll(radar ? ".tape-col" : "td[data-i]").forEach((c) => {
      const isOn = radar ? Number(c.dataset.radar) === state.radarIdx : Number(c.dataset.i) === shown;
      c.classList.toggle("on", isOn); if (isOn && !on) on = c;
    });
    // Scroll the tape itself, never scrollIntoView: that walks every scrollable
    // ancestor and drags the whole page sideways under an overflow:hidden body.
    if (on) { const r = on.getBoundingClientRect(), tr = tape.getBoundingClientRect(); if (r.left < tr.left + 60 || r.right > tr.right - 60) tape.scrollTo({ left: tape.scrollLeft + (r.left + r.width / 2) - (tr.left + tr.width / 2), behavior: "smooth" }); }
  }

  function glyph(cloud, precip, tK, night) {
    const c = cloud == null ? 0 : cloud, wet = precip > 0.2;
    const snow = tK != null && tK - 273.15 < 1 && wet, cloudy = c > 0.25 || wet;
    const cx = cloudy ? 8 : 12, cy = cloudy ? 7 : 9;
    const body = night
      ? `<path d="M${cx+2} ${cy-4}a4.5 4.5 0 1 0 2 7.5 4 4 0 0 1-2-7.5z" fill="#d9e2f0"/>`
      : `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#ffd166"/><g stroke="#ffd166" stroke-width="1.2" stroke-linecap="round"><path d="M${cx} ${cy-5.5}v-1.5M${cx} ${cy+5.5}v1.5M${cx-5.5} ${cy}h-1.5M${cx+5.5} ${cy}h1.5M${cx-3.9} ${cy-3.9}l-1-1M${cx+3.9} ${cy-3.9}l1-1M${cx-3.9} ${cy+3.9}l-1 1M${cx+3.9} ${cy+3.9}l1 1"/></g>`;
    const cl = cloudy ? `<path d="M6 13h12a3.5 3.5 0 0 0 .2-7 5 5 0 0 0-9.3-1.2A4.3 4.3 0 0 0 6 13z" fill="rgba(224,231,241,${0.62 + 0.35 * Math.max(c, 0.35)})" stroke="rgba(255,255,255,.28)" stroke-width=".7"/>` : "";
    const rn = wet ? (snow ? `<g transform="translate(12 16)" stroke="#dfe8ff" stroke-width="1" stroke-linecap="round"><path d="M-2 0h4M0-2v4M-1.4-1.4l2.8 2.8M1.4-1.4l-2.8 2.8"/></g>` : `<path d="M8 14.5l-1 2M13 14.5l-1 2M18 14.5l-1 2" stroke="#69b9ff" stroke-width="1.5" stroke-linecap="round"/>`) : "";
    return `<svg class="tape-glyph" viewBox="0 0 24 18" aria-hidden="true">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  }

  WX.tape = { renderTape, renderTapeSelection, refreshTapePoint, tapeData, glyph,
              clearFineSelection: () => { fineSelectedValid = null; } };
})();
