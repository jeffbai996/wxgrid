// The forecast tape under the map (and the radar frame strip).
// Loaded after app.js; exposes WX.tape.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── weather tape ──────────────────────────────────────────────────────
  let tapeReq = 0;
  async function refreshTapePoint() {
    const c = M().getCenter();
    const my = ++tapeReq;
    try {
      const d = await WX.api(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${WX.wlon(c.lng).toFixed(2)}&model=${state.model}&run=${state.run}`);
      if (my !== tapeReq) return;
      state.tapePoint = d;
      renderTape();
    } catch (e) { /* keep last */ }
  }
  function tapeData() { return (state.point && state.point.data) || state.tapePoint; }

  // The tape: a table whose columns are forecast steps grouped under
  // day headers and whose rows are variables (icon, temp, feels like, rain,
  // wind, gusts, direction). Click a column to jump.
  // How many hours between tape columns. The run's own spacing is the floor;
  // a coarser choice thins the columns rather than interpolating anything.
  let tapeRes = Number(localStorage.getItem("wxgrid.tapeRes") || 0);      // 0 = the model's own steps
  function renderRes(d) {
    const box = $("#tape-res"); if (!box) return;
    const native = d && d.steps && d.steps.length > 1 ? d.steps[1] - d.steps[0] : 3;
    const opts = [[0, `${native} h`], [6, "6 h"], [12, "12 h"], [24, "24 h"]].filter(([v]) => v === 0 || v > native);
    box.innerHTML = opts.map(([v, t]) => `<button data-v="${v}" class="${v === tapeRes ? "on" : ""}">${t}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { tapeRes = Number(b.dataset.v); localStorage.setItem("wxgrid.tapeRes", tapeRes); renderTape(); renderTapeSelection(); });
  }
  const thin = (d) => {
    if (!tapeRes || !d.steps) return null;
    const keep = d.steps.map((h, i) => [h, i]).filter(([h]) => h % tapeRes === 0).map(([, i]) => i);
    return keep.length > 2 ? keep : null;
  };

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
    if (!d0) { tape.innerHTML = ""; return; }
    renderRes(d0);
    // thinning maps every series through the kept indices, so the rest of the
    // renderer never has to know the tape is showing a subset
    const keep = thin(d0);
    const d = keep ? { ...d0, steps: keep.map((i) => d0.steps[i]), valid: keep.map((i) => d0.valid[i]),
                       series: Object.fromEntries(Object.entries(d0.series).map(([k, v]) => [k, Array.isArray(v) ? keep.map((i) => v[i]) : v])),
                       _keep: keep } : d0;
    const s = d.series, n = d.steps.length;
    const dates = d.valid.map((iso) => new Date(iso));
    // day header cells: colspan per day
    const days = [];
    dates.forEach((dt, i) => { const k = dt.toDateString(); if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, start: dt, span: 0 }); days[days.length - 1].span++; });
    const dayRow = days.map((dy) => `<th colspan="${dy.span}" class="day">${dy.start.toLocaleDateString(undefined, WX.units.timeOpts({ weekday: "long", day: "numeric" }))}</th>`).join("");
    // the column whose interval holds the current wall-clock time gets a mark
    const nowMs = Date.now();
    const nowIdx = dates.findIndex((dt, i) => nowMs >= dt.getTime() && (i + 1 >= n || nowMs < dates[i + 1].getTime()));
    const cell = (i, inner, cls = "") => `<td class="${cls} ${dates[i].getHours() < 6 || dates[i].getHours() >= 21 ? "night" : ""}${i === nowIdx ? " now" : ""}" data-i="${i}">${inner}</td>`;
    const hourTxt = (dt) => dt.toLocaleTimeString(undefined, WX.units.timeOpts({ hour: "numeric" }));
    const hourRow = dates.map((dt, i) => cell(i, `<span class="hr">${hourTxt(dt).replace(":00", "").replace(/\s/, "<small>") + (/[ap]m/i.test(hourTxt(dt)) ? "</small>" : "")}</span>`, "hour")).join("");
    const iconRow = dates.map((_, i) => cell(i, glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, dates[i].getHours() < 6 || dates[i].getHours() >= 21), "ico")).join("");
    const tempRow = dates.map((_, i) => cell(i, s.t2m && s.t2m[i] != null ? `${WX.units.temp(s.t2m[i]).v}°` : "—", "temp")).join("");
    const feels = (i) => { const t = s.t2m ? s.t2m[i] - 273.15 : null, w = s.wind ? s.wind[i] : null; if (t == null) return null; if (w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; } if (s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); return t + 0.5555 * (e - 10); } return t; };
    const feelsRow = dates.map((_, i) => { const v = feels(i); return cell(i, v == null ? "—" : `${WX.units.tempC(v).v}°`, "feels"); }).join("");
    const rainRow = dates.map((_, i) => { const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0; if (r == null) return cell(i, "", "rain"); if (sn >= 0.3) return cell(i, `<span class="snow">${WX.units.snow(sn).v}</span>`, "rain"); return cell(i, r >= 0.1 ? `<span>${WX.units.precip(r).v}</span>` : "", "rain"); }).join("");
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
    tape.innerHTML = `<table class="wtape"><thead><tr><th class="lab corner"></th>${dayRow}</tr></thead><tbody>
      <tr class="r-hour">${label("Hours")}${hourRow}</tr>
      <tr class="r-icon">${label("")}${iconRow}</tr>
      <tr class="r-temp">${label("Temp", WX.units.tempUnit)}${tempRow}</tr>
      <tr class="r-feels">${label("Feels like", WX.units.tempUnit)}${feelsRow}</tr>
      <tr class="r-rain">${label("Rain / snow", `${WX.units.precipUnit} · ${WX.units.snowUnit}`)}${rainRow}</tr>
      <tr class="r-wind">${label("Wind", speedUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${label("Gusts", speedUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${label("Wind dir.")}${dirRow}</tr>
    </tbody></table>`;
    tape.querySelectorAll("td[data-i]").forEach((c) => c.onclick = () => WX.fn.setStep(keep ? keep[Number(c.dataset.i)] : Number(c.dataset.i)));
    $("#tape-where").textContent = state.point ? (state.point.name || `${state.point.lat.toFixed(2)}, ${state.point.lon.toFixed(2)}`) : "map centre";
    renderTapeSelection();
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const radar = state.radar && state.radarFrames.length;
    const d0 = tapeData();
    const keep = d0 ? thin(d0) : null;
    // the shown column for a step: exact when the tape is at full resolution,
    // otherwise the nearest kept column
    const shown = !keep ? state.stepIdx
      : keep.reduce((best, idx, k) => Math.abs(idx - state.stepIdx) < Math.abs(keep[best] - state.stepIdx) ? k : best, 0);
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
    const c = cloud == null ? 0 : cloud;
    const snow = tK != null && tK - 273.15 < 1 && precip > 0.2;
    const body = night ? `<circle cx="7" cy="7" r="4" fill="#cfd6e3"/>` : `<circle cx="7" cy="7" r="4" fill="#ffd166"/>`;
    const cl = c > 0.25 ? `<path d="M6 12h9a3 3 0 0 0 0-6 4 4 0 0 0-7.6-1A3.5 3.5 0 0 0 6 12z" fill="rgba(210,218,230,${0.35 + 0.65 * c})"/>` : "";
    const rn = precip > 0.2 ? (snow ? `<text x="9" y="15" font-size="6" fill="#dfe8ff">✱</text>` : `<path d="M8 12.5v2M12 12.5v2M16 12.5v2" stroke="#6cb6ff" stroke-width="1.4" stroke-linecap="round"/>`) : "";
    return `<svg class="tape-glyph" viewBox="0 0 20 16">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  }

  WX.tape = { renderTape, renderTapeSelection, refreshTapePoint, tapeData, glyph };
})();
