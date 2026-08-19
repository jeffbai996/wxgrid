// Point-card panes. app.js owns state and calls WXPanes.render(tab, point, i);
// everything here is presentation over the JSON the API already returned,
// plus the lazy fetches a pane needs (avalanche forecast, elevation-band
// profile, other models for Compare).
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const W = () => window.WX;
  const K = 273.15;
  // Sum of the per-step buckets in (steps[i], steps[i]+hours] — the tape can be
  // 3 h or 6 h per column, so "next 24 h" is by hours, not by column count.
  const sumWindow = (arr, steps, i, hours) => { if (!arr) return null; let t = 0, n = 0; for (let k = i + 1; k < steps.length; k++) { if (steps[k] > steps[i] + hours) break; t += arr[k] || 0; n++; } return n ? t : null; };
  const stepHrs = (d, i) => (d.steps[i + 1] != null ? d.steps[i + 1] - d.steps[i] : d.steps[i] - (d.steps[i - 1] || 0)) || 6;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let W_ICONS = {};

  function render(tab, pt, i) {
    const d = pt.data;
    if (tab === "now") renderNow(pt, d, i);
    else if (tab === "aloft") renderAloft(d, i);
    else if (tab === "air") renderAirgram(d, i);
    else if (tab === "skewt") renderSkewT(pt, d, i);
    else if (tab === "winter") renderWinter(pt, d, i);
    else if (tab === "out") renderOutdoors(d, i);
    else if (tab === "cmp") renderCompare(pt, d, i);
    else if (tab === "spread") renderSpread(pt, d, i);
    else if (tab === "resort") renderResort(pt, d, i);
  }

  // ── colour helpers ────────────────────────────────────────────────────
  const TEMP_STOPS = [[-30, [75, 42, 180]], [-15, [40, 150, 220]], [0, [100, 200, 200]], [10, [110, 210, 110]], [20, [240, 220, 80]], [28, [240, 130, 40]], [36, [200, 30, 30]]];
  function lerpStops(stops, v) {
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) if (v >= stops[k][0] && v <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    const q = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0] || 1)));
    return `rgb(${a[1].map((x, k) => Math.round(x + (b[1][k] - x) * q)).join(",")})`;
  }
  const tempColor = (c) => lerpStops(TEMP_STOPS, c);
  const windColor = (ms) => W().rampColor("wind", ms, 0.9);
  const compass = (deg) => deg == null ? "variable" :
    ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  const bigGlyph = (cloud, precip, tK, night) => {
    const c = cloud == null ? 0 : cloud, snow = tK != null && tK - K < 1 && precip > 0.2;
    const body = night ? `<circle cx="16" cy="16" r="9" fill="#cfd6e3"/>` : `<circle cx="16" cy="16" r="9" fill="#ffd166"/><g stroke="#ffd166" stroke-width="2" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map((a)=>`<line x1="${16+12*Math.cos(a*Math.PI/180)}" y1="${16+12*Math.sin(a*Math.PI/180)}" x2="${16+14.5*Math.cos(a*Math.PI/180)}" y2="${16+14.5*Math.sin(a*Math.PI/180)}"/>`).join("")}</g>`;
    const cl = c > 0.25 ? `<path d="M13 30h19a7 7 0 0 0 0-14 9 9 0 0 0-17-2 8 8 0 0 0-2 16z" fill="rgba(210,218,230,${0.4 + 0.6 * c})"/>` : "";
    const rn = precip > 0.2 ? (snow ? `<text x="17" y="42" font-size="12" fill="#dfe8ff">✱ ✱</text>` : `<path d="M16 33v5M22 33v5M28 33v5" stroke="#6cb6ff" stroke-width="2.5" stroke-linecap="round"/>`) : "";
    return `<svg class="glyph" viewBox="0 0 46 46">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  };
  W_ICONS = { rise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4-4-4 4M16 18a4 4 0 0 0-8 0"/></svg>',
              set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/></svg>' };

  // A short written forecast built from the series. Rules only: every sentence
  // is read off the numbers, nothing is invented, and missing inputs simply
  // remove that sentence. This deliberately reads like a weather report, not
  // a row of database tags joined with middle dots.
  function summarise(d, i) {
    const s = d.series, U = W().units, sentences = [];
    const at = (k) => new Date(d.valid[k]);
    const when = (k) => {
      const h = (at(k) - at(i)) / 3600e3;
      if (h <= 1.5) return "now";
      if (h <= 12) return U.time(at(k)).replace(":00", "");
      const day = at(k).toLocaleDateString(undefined, U.timeOpts({ weekday: "short" }));
      return `${day} ${U.time(at(k)).replace(":00", "")}`;
    };
    const end = Math.min(d.steps.length - 1, i + Math.ceil(48 / ((d.steps[i + 1] || d.steps[i] + 3) - d.steps[i])));
    const indexes = Array.from({ length: end - i + 1 }, (_, k) => i + k);
    const rainAt = (k) => (s.tp6 && s.tp6[k]) || 0;
    const snowAt = (k) => (s.sf6 && s.sf6[k]) || 0;
    const amountAt = (k) => rainAt(k) + snowAt(k);
    const wet = (k) => amountAt(k) > 0.2;
    const damp = indexes.filter((k) => amountAt(k) > 0.01);
    const wetSteps = indexes.filter(wet);
    if (s.tp6 || s.sf6) {
      if (wet(i)) {
        let k = i; while (k <= end && wet(k)) k++;
        const snow = snowAt(i) > rainAt(i);
        sentences.push(k > end
          ? `${snow ? "Snow" : "Rain"} continues through the forecast period.`
          : `${snow ? "Snow" : "Showers"} ease around ${when(k)}.`);
      } else if (wetSteps.length) {
        const first = wetSteps[0];
        const snow = snowAt(first) > rainAt(first);
        const intermittent = wetSteps.length <= Math.max(2, Math.ceil(indexes.length * 0.35));
        sentences.push(intermittent
          ? `Mostly dry, with ${snow ? "a little snow" : "a few showers"} possible around ${when(first)}.`
          : `Mostly dry at first, then ${snow ? "snow" : "showers"} developing around ${when(first)}.`);
      } else if (damp.length) {
        sentences.push(`Mostly dry, though ${snowAt(damp[0]) > rainAt(damp[0]) ? "a flurry" : "a stray shower"} is possible.`);
      } else {
        const horizon = (at(end) - at(i)) / 3600e3;
        sentences.push(horizon >= 36 ? "Mostly dry for the next couple of days."
          : horizon >= 18 ? "Mostly dry through tomorrow."
          : `Mostly dry through ${when(end)}.`);
      }
    }
    // Wind: say what a person needs to know, with the gust separated from the
    // sustained wind instead of compressed into an unlabeled G-number.
    const gs = (s.gust || s.wind || []).slice(i, end + 1).map((v, k) => [v, i + k]).filter(([v]) => v != null);
    if (gs.length) {
      const [gv, gk] = gs.reduce((a, b) => (b[0] > a[0] ? b : a));
      const kmh = gv * 3.6;
      if (kmh >= 35) {
        const lead = kmh >= 60 ? "Windy" : "Breezy at times";
        sentences.push(`${lead}, with ${s.gust ? "gusts" : "winds"} reaching ${Math.round(W().speed(gv))} ${W().speedUnit()}${gk > i + 1 ? ` around ${when(gk)}` : ""}.`);
      }
    }
    // Temperature: describe the direction rather than appending another raw
    // number fragment to the end of the precipitation sentence.
    if (s.t2m && s.t2m[i] != null) {
      const day = s.t2m.slice(i, end + 1).filter((v) => v != null);
      if (day.length > 2) {
        const dmax = Math.max(...day), dmin = Math.min(...day), now = s.t2m[i];
        if (dmax - now > 3) sentences.push(`Temperatures climb to around ${U.temp(dmax).txt}.`);
        else if (now - dmin > 3) sentences.push(`Temperatures fall to around ${U.temp(dmin).txt}.`);
      }
    }
    return sentences.join(" ");
  }

  // ── Now: hero, local context, station obs, meteogram ─────────────────
  function renderNow(pt, d, i) {
    const { speed, speedUnit, f, arrow } = W();
    const s = d.series;
    const t = s.t2m ? s.t2m[i] : null, night = (() => { const h = new Date(d.valid[i]).getHours(); return h < 6 || h >= 21; })();
    // today's hi/lo (same local calendar day as the shown step)
    const day = new Date(d.valid[i]).toDateString();
    const todays = d.valid.map((v, k) => k).filter((k) => new Date(d.valid[k]).toDateString() === day && s.t2m && s.t2m[k] != null);
    const hi = todays.length ? Math.max(...todays.map((k) => s.t2m[k])) - K : null, lo = todays.length ? Math.min(...todays.map((k) => s.t2m[k])) - K : null;
    const chips = [];
    if (s.wind) chips.push(`<span class="wind-readout" style="--wind-color:${windColor(s.wind[i] || 0)}">
      <span class="wind-arrow">${f(s.wdir && s.wdir[i], arrow)}</span>
      <span class="wind-main"><small>Wind ${compass(s.wdir && s.wdir[i])}</small><b>${f(s.wind[i], (v) => speed(v).toFixed(0))} <i>${speedUnit()}</i></b></span>
      ${s.gust && s.gust[i] != null ? `<span class="wind-gust"><small>Gusts</small><b>${speed(s.gust[i]).toFixed(0)} <i>${speedUnit()}</i></b></span>` : ""}
    </span>`);
    if (s.tp6 && s.tp6[i] > 0.05) chips.push(`<span class="chipv" style="color:var(--rain)"><b>${W().units.precip(s.tp6[i]).v}</b> ${W().units.precipUnit}/6h</span>`);
    if (s.sf6 && s.sf6[i] > 0.05) chips.push(`<span class="chipv" style="color:#cfe8ff"><b>${W().units.snow(s.sf6[i]).v}</b> ${W().units.snowUnit} snow</span>`);
    if (s.tcc) chips.push(`<span class="chipv">☁ <b>${f(s.tcc[i], (v) => (v * 100).toFixed(0))}</b>%</span>`);
    if (s.d2m) chips.push(`<span class="chipv">dew <b>${f(s.d2m[i], (v) => W().units.temp(v).v)}°</b>${s.t2m && s.t2m[i] != null && s.d2m[i] != null ? ` · RH ${Math.round(100 * Math.exp(17.625 * (s.d2m[i] - K) / (243.04 + s.d2m[i] - K)) / Math.exp(17.625 * (s.t2m[i] - K) / (243.04 + s.t2m[i] - K)))}%` : ""}</span>`);
    if (s.msl) chips.push(`<span class="chipv"><b>${f(s.msl[i], (v) => W().units.press(v).v)}</b> ${W().units.pressUnit}</span>`);
    if (s.swh && s.swh[i] != null) chips.push(`<span class="chipv" style="color:#7dd3fc">〜 <b>${W().units.alt(s.swh[i], 1).v}</b> ${W().units.altUnit}${s.mwp && s.mwp[i] != null ? ` · ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` · ${arrow((s.mwd[i] + 180) % 360)}` : ""}</span>`);
    if (s.cape && s.cape[i] > 100) chips.push(`<span class="chipv" style="color:${s.cape[i] > 1000 ? "var(--bad)" : "var(--warm)"}">⚡ <b>${s.cape[i].toFixed(0)}</b> J/kg</span>`);
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    $("#point-now").innerHTML = `<div class="hero">
        ${bigGlyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), t, night)}
        <div class="big" style="color:${t != null ? tempColor(t - K) : "inherit"}">${t == null ? "—" : W().units.temp(t).v}<span class="deg">°</span></div>
        <div class="hl">
          ${hi != null ? `<div class="hilo"><span class="hi"><i>high</i>${W().units.tempC(hi).v}°</span><span class="rule"></span><span class="lo"><i>low</i>${W().units.tempC(lo).v}°</span></div>` : ""}
          ${sun ? `<div class="sun"><span>${W_ICONS.rise}${sun.rise}</span><span>${W_ICONS.set}${sun.set}</span>${sun.len ? `<span class="len">${sun.len} of daylight</span>` : ""}</div>` : ""}
        </div>
      </div>
      ${(() => { const t = summarise(d, i); return t ? `<p class="summary">${t}</p>` : ""; })()}
      <div class="meta">${chips.join("")}</div>
      ${daysStrip(d, i)}
      ${alertsHtml(pt)}${airHtml(pt)}`;
    // local context
    const loc = pt.local || {};
    const bits = [];
    if (loc.place && loc.place.name && loc.place.name !== pt.name) bits.push(`<span><b>${esc(loc.place.name)}</b>${loc.place.region ? ", " + esc(loc.place.region) : ""}${loc.place.country ? " · " + esc(loc.place.country) : ""}</span>`);
    else if (loc.place && (loc.place.region || loc.place.country)) bits.push(`<span>${esc(loc.place.region || "")}${loc.place.country ? " · " + esc(loc.place.country) : ""}</span>`);
    if (loc.elevation_m != null) bits.push(`<span>elev <b>${W().units.alt(loc.elevation_m).txt}</b></span>`);
    if (W().units.followsPoint && loc.timezone && loc.timezone.abbr) bits.push(`<span>${esc(loc.timezone.abbr)}</span>`);
    // the title already carries the coordinates when there is no place name —
    // don't print them twice
    const coords = `${pt.lat.toFixed(2)}°, ${W().wlon(pt.lon).toFixed(2)}°`;
    const titled = ($("#point-title").textContent || "").trim();
    $("#point-local").innerHTML = bits.length ? bits.join('<span class="sep">·</span>') : (titled === coords ? "" : coords);
    // station observation
    let obsHtml = "";
    const o = pt.obs && pt.obs.metar;
    if (o) {
      const tm = o.time ? new Date(o.time) : null;
      const cl = (o.clouds || []).map((c) => `${c.cover}${c.base != null ? "@" + W().units.alt(c.base / 3.28084).txt : ""}`).join(" ");
      const obsDist = o.distance_km != null ? W().units.dist(o.distance_km).txt : "";
      const obsVis = o.visib != null ? W().units.dist(o.visib * 1.609344).txt : "";
      obsHtml = `<div class="obs"><div class="obs-head"><span>Observed · ${esc(o.station)} ${esc(o.name || "")}${obsDist ? ` · ${obsDist}` : ""}</span><span>${tm ? W().units.time(tm) : ""} ${o.flight_category ? `<span class="fc ${esc(o.flight_category)}">${esc(o.flight_category)}</span>` : ""}</span></div>
        <div class="obs-vals">${o.temp_c != null ? `<span><b style="color:${tempColor(o.temp_c)}">${W().units.tempC(o.temp_c).v}°</b> ${W().units.tempUnit.replace("°", "")}</span>` : ""}${o.dewpoint_c != null ? `<span>dew <b>${W().units.tempC(o.dewpoint_c).v}°</b></span>` : ""}${o.wspd_kt != null ? `<span><b>${speed(o.wspd_kt / 1.943844).toFixed(0)}</b> ${speedUnit()} ${o.wdir != null && o.wdir !== 0 ? String(o.wdir).padStart(3, "0") + "°" : "calm"}${o.wgst_kt ? ` · gusts ${speed(o.wgst_kt / 1.943844).toFixed(0)}` : ""}</span>` : ""}${obsVis ? `<span>vis <b>${obsVis}</b></span>` : ""}${o.altim_hpa != null ? `<span>QNH <b>${W().units.press(o.altim_hpa * 100).txt}</b></span>` : ""}${cl ? `<span>${esc(cl)}</span>` : ""}${o.wx ? `<span>${esc(o.wx)}</span>` : ""}</div>
        <div class="raw">${esc(o.raw || "")}</div></div>`;
    }
    let holder = $("#obs-holder");
    if (!holder) { holder = document.createElement("div"); holder.id = "obs-holder"; $("#point-now").after(holder); }
    holder.innerHTML = obsHtml;
    drawMeteogram(d, i);
  }

  // Seven-day strip: one cell per local calendar day (icon, hi/lo, precip,
  // max wind); tapping a day jumps the timeline to its midday step.
  function daysStrip(d, i) {
    const s = d.series; if (!s.t2m) return "";
    const days = new Map();
    d.valid.forEach((v, k) => { const dt = new Date(v); const key = dt.toDateString(); if (!days.has(key)) days.set(key, { dt, ks: [] }); days.get(key).ks.push(k); });
    const cur = new Date(d.valid[i]).toDateString();
    const cells = [...days.values()].slice(0, 8).map(({ dt, ks }) => {
      const ts = ks.map((k) => s.t2m[k]).filter((x) => x != null);
      if (ts.length < 2) return "";
      const hi = Math.max(...ts) - K, lo = Math.min(...ts) - K;
      const rain = ks.reduce((a, k) => a + ((s.tp6 && s.tp6[k]) || 0), 0), snow = ks.reduce((a, k) => a + ((s.sf6 && s.sf6[k]) || 0), 0);
      const wmax = s.wind ? Math.max(...ks.map((k) => s.wind[k] || 0)) : null;
      const noon = ks.reduce((b, k) => Math.abs(new Date(d.valid[k]).getHours() - 13) < Math.abs(new Date(d.valid[b]).getHours() - 13) ? k : b, ks[0]);
      const cloud = ks.map((k) => s.tcc ? s.tcc[k] : null).filter((x) => x != null); const cl = cloud.length ? cloud.reduce((a, b) => a + b, 0) / cloud.length : null;
      const g = W().tape && W().tape.glyph ? W().tape.glyph(cl, (rain + snow) / Math.max(1, ks.length) * (24 / 6), s.t2m[noon], false) : "";
      const on = dt.toDateString() === cur;
      const wet = snow >= 1 ? `<span class="sn">${W().units.snow(snow).txt}</span>` : rain >= 0.5 ? W().units.precip(rain).txt : "";
      return `<button class="day${on ? " on" : ""}" data-k="${noon}" title="${dt.toDateString()}">
        <span class="dn">${dt.toLocaleDateString(undefined, { weekday: "short" })}</span>
        <span class="dg">${g}</span>
        <span class="hl"><b style="color:${tempColor(hi)}">${W().units.tempC(hi).v}°</b><i>${W().units.tempC(lo).v}°</i></span>
        <span class="pr">${wet || "&nbsp;"}</span>
        ${wmax != null ? `<span class="wd" style="background:${W().rampColor("wind", wmax, 0.55)}">${Math.round(W().speed(wmax))}<em>${W().speedUnit()}</em></span>` : ""}</button>`;
    }).join("");
    setTimeout(() => document.querySelectorAll(".days .day").forEach((b) => b.onclick = () => W().setStep(Number(b.dataset.k))), 0);
    return `<div class="days">${cells}</div>`;
  }

  const AQI_BANDS = [[50, "Good", "#2f9e44"], [100, "Moderate", "#e6b800"], [150, "Unhealthy for sensitive", "#f08c00"], [200, "Unhealthy", "#e03131"], [300, "Very unhealthy", "#9c36b5"], [9999, "Hazardous", "#7f1d1d"]];
  const aqiBand = (v) => AQI_BANDS.find((b) => v <= b[0]) || AQI_BANDS[AQI_BANDS.length - 1];
  const uvBand = (v) => v < 3 ? ["Low", "#2f9e44"] : v < 6 ? ["Moderate", "#e6b800"] : v < 8 ? ["High", "#f08c00"] : v < 11 ? ["Very high", "#e03131"] : ["Extreme", "#9c36b5"];
  function airHtml(pt) {
    const a = pt.air; if (!a || a.us_aqi == null) return "";
    const b = aqiBand(a.us_aqi);
    const uvMax = a.hourly && a.hourly.uv ? Math.max(...a.hourly.uv.slice(0, 24).filter((x) => x != null)) : null;
    const uvb = uvMax != null ? uvBand(uvMax) : null;
    return `<div class="air"><span class="chipv" style="background:${b[2]}22;color:${b[2]}"><i class="sw" style="background:${b[2]}"></i>AQI <b>${a.us_aqi}</b> ${b[1]}</span>
      ${a.pm2_5 != null ? `<span class="chipv">PM2.5 <b>${a.pm2_5.toFixed(0)}</b> µg/m³</span>` : ""}${a.ozone != null ? `<span class="chipv">O₃ <b>${a.ozone.toFixed(0)}</b></span>` : ""}
      ${uvb ? `<span class="chipv" style="color:${uvb[1]}">UV max <b>${uvMax.toFixed(0)}</b> ${uvb[0]}</span>` : ""}</div>`;
  }
  function alertsHtml(pt) {
    const al = pt.alerts; if (!al || !al.length) return "";
    return `<div class="alerts">${al.slice(0, 3).map((a) => `<a class="alert" href="${esc(a.url || "#")}" target="_blank" rel="noopener" style="border-color:${esc(a.color)}"><i class="sw" style="background:${esc(a.color)}"></i><b>${esc(a.event)}</b>${a.ends ? `<span class="dim"> until ${new Date(a.ends).toLocaleString(undefined, { weekday: "short", hour: "numeric" })}</span>` : ""}<span class="hl">${esc((a.headline || a.area || "").slice(0, 120))}</span></a>`).join("")}${al.length > 3 ? `<div class="note">+${al.length - 3} more</div>` : ""}</div>`;
  }

  // NOAA sunrise/sunset (good to a minute or two), shown in the viewer's clock.
  function sunTimes(lat, lon, date) {
    const rad = Math.PI / 180;
    const day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
    const calc = (rising) => {
      const lngHour = lon / 15;
      const t = day + ((rising ? 6 : 18) - lngHour) / 24;
      const M = 0.9856 * t - 3.289;
      let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634; L = (L + 360) % 360;
      let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = (RA + 360) % 360;
      RA += (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90); RA /= 15;
      const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
      const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
      if (cosH > 1 || cosH < -1) return null;
      let H = rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad; H /= 15;
      const T = H + RA - 0.06571 * t - 6.622;
      return ((T - lngHour) % 24 + 24) % 24;   // UTC hours
    };
    const r = calc(true), s = calc(false);
    if (r == null || s == null) return null;
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const fmt = (h) => new Date(base + h * 3600e3).toLocaleTimeString(undefined, W().units.timeOpts({ hour: "numeric", minute: "2-digit" }));
    const len = ((s - r + 24) % 24);
    return { rise: fmt(r), set: fmt(s), len: `${Math.floor(len)}h${String(Math.round((len % 1) * 60)).padStart(2, "0")}` };
  }

  // ── Aloft ─────────────────────────────────────────────────────────────
  function renderAloft(d, i) {
    const { speed, speedUnit, f, arrowRot, LEVEL_FT, LEVEL_M } = W();
    const rows = (d.levels || []).slice().sort((a, b) => b - a).map((lvl) => {
      const a = d.aloft[String(lvl)];
      const gh = a.gh && a.gh[i] != null ? a.gh[i] : null;
      return `<tr><td class="mono">${lvl} hPa</td><td>${gh != null ? W().units.alt(gh).txt : (W().units.altUnit === "ft" ? LEVEL_FT[lvl] : LEVEL_M[lvl])}</td>
        <td class="dir">${a.wdir[i] != null ? `<i style="${arrowRot(a.wdir[i])}"></i>${String(a.wdir[i]).padStart(3, "0")}°` : "—"}</td>
        <td><span class="wchip" style="background:${windColor(a.wind[i] || 0)}">${f(a.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}</td>
        <td class="tempc" style="color:${a.temp[i] != null ? tempColor(a.temp[i] - K) : "inherit"}">${f(a.temp[i], (v) => W().units.temp(v).v)}°</td></tr>`;
    }).join("");
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const sfc = s.wind ? `<tr><td class="mono">sfc</td><td>${W().units.alt(10).txt}</td><td class="dir">${s.wdir[i] != null ? `<i style="${arrowRot(s.wdir[i])}"></i>${String(s.wdir[i]).padStart(3, "0")}°` : "—"}</td><td><span class="wchip" style="background:${windColor(s.wind[i] || 0)}">${f(s.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}${s.gust ? ` <span class="dim">gusts ${f(s.gust[i], (v) => speed(v).toFixed(0))}</span>` : ""}</td><td class="tempc" style="color:${s.t2m && s.t2m[i] != null ? tempColor(s.t2m[i] - K) : "inherit"}">${f(s.t2m && s.t2m[i], (v) => W().units.temp(v).v)}°</td></tr>` : "";
    $("#aloft").innerHTML = `<table class="aloft"><thead><tr><th>Level</th><th>Height</th><th>Dir</th><th>Speed</th><th>Temp</th></tr></thead><tbody>${rows}${sfc}</tbody></table>
      <dl class="kv">
        <dt>Freezing level</dt><dd>${fl != null ? W().units.alt(fl).txt : (d.levels && d.levels.length ? "below 925 hPa or above 250" : "—")}</dd>
        <dt>Total cloud</dt><dd>${f(s.tcc && s.tcc[i], (v) => (v * 100).toFixed(0) + "%")}</dd>
        <dt>CAPE</dt><dd class="${capeClass(s.cape && s.cape[i])}">${f(s.cape && s.cape[i], (v) => v.toFixed(0) + " J/kg")}${s.cape ? "" : " <span class=dim>(model has none)</span>"}</dd>
        <dt>QNH (MSL)</dt><dd>${f(s.msl && s.msl[i], (v) => W().units.press(v, W().units.pressUnit === "hPa" ? 1 : undefined).txt)}</dd>
        <dt>Dew point spread</dt><dd>${s.d2m && s.t2m && s.t2m[i] != null && s.d2m[i] != null ? W().units.tempDelta(s.t2m[i] - s.d2m[i]).toFixed(1) + " " + W().units.tempUnit : "—"}</dd>
      </dl>
      ${tafHtml()}
      <div class="note">Gridpoint winds, true direction, FROM. Heights are geopotential.</div>`;
  }
  const capeClass = (v) => v == null ? "" : v < 300 ? "good" : v < 1000 ? "meh" : "bad";
  function tafHtml() {
    const pt = W().state.point; const t = pt && pt.obs && pt.obs.taf;
    if (!t) return "";
    return `<div class="obs"><div class="obs-head"><span>TAF · ${esc(t.station)}</span><span>${t.issue ? new Date(t.issue).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}</span></div><div class="raw">${esc(t.raw || "")}</div></div>`;
  }

  // ── Airgram: time × level, cells coloured by temperature, arrows for wind
  function renderAirgram(d, i) {
    const c = $("#airgram"), ctx = c.getContext("2d");
    const { speed, speedUnit } = W();
    const W_ = c.width, H = c.height, padL = 44, padR = 8, padT = 8, padB = 22;
    ctx.clearRect(0, 0, W_, H);
    const levels = (d.levels || []).slice().sort((a, b) => b - a);   // 925 bottom → 250 top
    const rows = [...levels.map((l) => ({ key: String(l), label: `${l}` })), ];
    if (d.series.wind) rows.unshift({ key: "sfc", label: "sfc" });
    const n = Math.min(d.steps.length, 28);                           // 7 days is enough on a phone
    if (!rows.length) { $("#airgram-note").textContent = "No pressure-level data in this run."; return; }
    const cw = (W_ - padL - padR) / n, rh = (H - padT - padB) / rows.length;
    const tcol = (tK) => { const t = tK - K; const stops = [[-50, [70, 30, 120]], [-30, [50, 80, 200]], [-15, [40, 150, 220]], [0, [100, 200, 200]], [10, [110, 210, 110]], [20, [240, 220, 80]], [30, [240, 130, 40]], [40, [200, 30, 30]]]; let a = stops[0], b = stops[stops.length - 1]; for (let k = 0; k < stops.length - 1; k++) if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; } const q = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0] || 1))); return `rgb(${a[1].map((x, k) => Math.round(x + (b[1][k] - x) * q)).join(",")})`; };
    ctx.font = "600 10px 'Geist Mono', ui-monospace, monospace"; ctx.textBaseline = "middle";
    rows.forEach((r, ri) => {
      const y = padT + (rows.length - 1 - ri) * rh;
      ctx.fillStyle = "#8b93a1"; ctx.textAlign = "right"; ctx.fillText(r.label, padL - 6, y + rh / 2);
      for (let k = 0; k < n; k++) {
        const x = padL + k * cw;
        const t = r.key === "sfc" ? (d.series.t2m ? d.series.t2m[k] : null) : d.aloft[r.key].temp[k];
        const spd = r.key === "sfc" ? d.series.wind[k] : d.aloft[r.key].wind[k];
        const dir = r.key === "sfc" ? d.series.wdir[k] : d.aloft[r.key].wdir[k];
        if (t != null) { ctx.fillStyle = tcol(t); ctx.globalAlpha = 0.85; ctx.fillRect(x + 0.5, y + 0.5, cw - 1, rh - 1); ctx.globalAlpha = 1; }
        if (spd != null && dir != null) {
          const len = Math.min(rh, cw) * 0.36 * Math.min(1, 0.4 + spd / 25);
          const ang = (dir + 180) * Math.PI / 180;               // TO direction, screen y down: north = up
          const cx = x + cw / 2, cy = y + rh / 2;
          const dx = Math.sin(ang) * len, dy = -Math.cos(ang) * len;
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx, cy + dy); ctx.lineTo(cx + dx - Math.sin(ang - 0.5) * 4, cy + dy + Math.cos(ang - 0.5) * 4); ctx.moveTo(cx + dx, cy + dy); ctx.lineTo(cx + dx - Math.sin(ang + 0.5) * 4, cy + dy + Math.cos(ang + 0.5) * 4); ctx.stroke();
          if (cw > 20) { ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.textAlign = "center"; ctx.font = "700 9px 'Geist Mono', ui-monospace, monospace"; ctx.fillText(String(Math.round(speed(spd))), cx, y + rh - 6); ctx.font = "600 10px 'Geist Mono', ui-monospace, monospace"; }
        }
      }
    });
    // day ticks + selected step
    ctx.fillStyle = "#8b93a1"; ctx.textAlign = "left"; let lastDay = null;
    d.valid.slice(0, n).forEach((iso, k) => { const dt = new Date(iso), day = dt.toDateString(); if (day !== lastDay) { lastDay = day; ctx.fillRect(padL + k * cw, padT, 1, H - padT - padB); ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), padL + k * cw + 3, H - 8); } });
    if (i < n) { ctx.strokeStyle = "#6cb6ff"; ctx.lineWidth = 2; ctx.strokeRect(padL + i * cw + 1, padT + 1, cw - 2, H - padT - padB - 2); }
    $("#airgram-note").textContent = `Rows are pressure levels, colour is temperature, arrows are wind in ${speedUnit()}.`;
  }

  // ── Winter: new snow, snow depth, levels, wind loading, avalanche forecast
  function renderWinter(pt, d, i) {
    const { speed, speedUnit, f, AVY_COLORS } = W();
    const s = d.series;
    const sum = (arr, a, b) => arr ? arr.slice(a, b).reduce((x, y) => x + (y || 0), 0) : null;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const snowLevel = fl != null ? Math.max(0, fl - 300) : null;
    const t = s.t2m ? s.t2m[i] - K : null;
    const rainOnSnow = s.sd_cm && s.sd_cm[i] > 5 && s.tp6 && s.tp6[i] > 1 && (s.sf6 ? s.sf6[i] < 0.3 : t != null && t > 1.5);
    const w850 = d.aloft && d.aloft["850"] ? d.aloft["850"].wind[i] : null, w700 = d.aloft && d.aloft["700"] ? d.aloft["700"].wind[i] : null;
    // snow-to-liquid ratio from the surface temperature: cold storms stack higher
    const slr = t == null ? 10 : t < -12 ? 15 : t < -6 ? 12 : t < 0 ? 10 : t < 1.5 ? 7 : 5;
    const sn = (h) => { const v = sumWindow(s.sf6, d.steps, i, h); return v == null ? "n/a" : `${W().units.snow(v).txt} <span class="dim">(${W().units.snow(v * slr / 10).v} @ ${slr}:1)</span>`; };
    const w850d = d.aloft && d.aloft["850"] ? d.aloft["850"].wdir[i] : null;
    const lee = w850d == null ? null : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((w850d + 180) % 360) / 45)) % 8];
    const rows = [
      ["New snow next 24 h", sn(24), ""],
      ["New snow next 48 h", sn(48), ""],
      ["New snow next 72 h", sn(72), ""],
      ["Snow depth (model)", s.sd_cm ? W().units.snow(s.sd_cm[i]).txt : "n/a", ""],
      ["Freezing level", fl != null ? W().units.alt(fl).txt : "—", ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ["Ridge wind 850 / 700", `${f(w850, (v) => speed(v).toFixed(0))} / ${f(w700, (v) => speed(v).toFixed(0))} ${speedUnit()}`, w700 != null && speed(w700) > (W().state.units === "kt" ? 25 : W().state.units === "ms" ? 13 : 45) ? "bad" : w700 != null && speed(w700) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : 28) ? "meh" : "good"],
      ["Wind loading", w850 != null && speed(w850) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : W().state.units === "mph" ? 17 : 28) ? `${lee} aspects loading` : "light", w850 != null && speed(w850) > 15 ? "meh" : "good"],
      ["Rain on snow", rainOnSnow ? "yes, wet loading" : "no", rainOnSnow ? "bad" : "good"],
      ["Surface temp", t != null ? W().units.tempC(t).txt : "—", t != null && t > 0 && s.sd_cm && s.sd_cm[i] > 5 ? "meh" : ""],
    ];
    let avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span><span class="dim">loading…</span></div></div>`;
    if (pt.avy === false) avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span></div><div class="avy-note">No public forecast region covers this point (Avalanche Canada / avalanche.org).</div></div>`;
    else if (pt.avy) avyHtml = avyBlock(pt.avy, AVY_COLORS);
    else fetchAvy(pt);
    $("#winter").innerHTML = `<div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${avyHtml}
      <div class="note">Snow is model water-equivalent; the bracket applies a temperature-based ratio. Depth is the model snowpack, not a station. 0.25° grid: a valley and a ridge share one value.</div>`;
  }
  async function fetchAvy(pt) {
    const my = pt;
    try { my.avy = await W().api(`${W().API}/avy/point?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}`); }
    catch (e) { my.avy = false; }
    if (W().state.point === my && W().state.tab === "winter") W().renderPoint();
  }
  function avyBlock(a, colors) {
    const days = (a.days || []).slice(0, 3);
    const cell = (b) => { const lvl = b && (b.level != null ? b.level : -1); const col = colors[lvl] || "#8a8f98"; const txt = b && (b.display || b.value || "—"); const light = lvl === 2 || lvl === 0 || lvl === -1; return `<span class="band" style="background:${col};color:${light ? "#111" : "#fff"}">${esc(txt).replace("Summer Conditions", "summer")}</span>`; };
    const region = (a.region || "").length > 60 ? "Avalanche Canada (off season)" : a.region;
    return `<div class="avy"><div class="avy-head"><span>${esc(region)}${a.center && a.center !== "Avalanche Canada" ? ` <span class="dim">· ${esc(a.center)}</span>` : ""}</span>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">forecast ↗</a>` : ""}</div>
      ${days.length ? `<div class="avy-days"><span class="lab"></span><span class="lab">Alpine</span><span class="lab">Treeline</span><span class="lab">Below TL</span>${days.map((dd) => `<span class="lab">${esc((dd.label || dd.date || "").toString().slice(0, 9))}</span>${cell(dd.alp)}${cell(dd.tln)}${cell(dd.btl)}`).join("")}</div>` : `<div class="avy-note">${a.off_season ? "Off season — no danger ratings issued. Forecasts resume when the snowpack does (typically November)." : "No ratings in this product."}</div>`}
      ${a.highlights ? `<div class="avy-note">${esc(a.highlights).slice(0, 420)}</div>` : ""}
      ${(a.problems || []).length ? `<div class="avy-prob">${a.problems.slice(0, 3).map((p) => `<div><b>${esc(p.type)}</b>${p.likelihood ? ` · ${esc(p.likelihood)}` : ""}${p.size ? ` · size ${esc(p.size)}` : ""}${p.elevations && p.elevations.length ? ` · ${p.elevations.map(esc).join("/")}` : ""}${p.aspects && p.aspects.length ? ` · ${p.aspects.map(esc).join(" ")}` : ""}</div>`).join("")}</div>` : ""}
      ${a.issued ? `<div class="avy-note dim">issued ${new Date(a.issued).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })}${a.valid_until ? ` · valid to ${new Date(a.valid_until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}${a.confidence ? ` · confidence ${esc(a.confidence)}` : ""} · ${esc(a.source)}</div>` : ""}
    </div>`;
  }

  const uvWord = (u) => u < 3 ? "low" : u < 6 ? "moderate" : u < 8 ? "high" : u < 11 ? "very high" : "extreme";
  function renderSkewT(pt, d, i) {
    if (!window.WXSounding) return;
    // the observed ascent arrives late and re-renders; `false` means we asked
    // and there is nothing in reach, so we do not ask again for this point
    if (pt && pt.sonde === undefined) {
      pt.sonde = null;
      W().api(`${W().API}/sonde/nearest?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}`)
        .then((r) => { pt.sonde = (r && r.sounding) ? r.sounding : false; if (W().state.point === pt && W().state.tab === "skewt") W().renderPoint(); })
        .catch(() => { pt.sonde = false; });
    }
    // the diagram draws in the canvas's own pixel space, so size the element
    // to the card before every draw instead of letting a 640 px chart get
    // squeezed by CSS
    const c = $("#skewt"), host = c.parentElement;
    const w = Math.max(300, Math.round(host.clientWidth));
    // on a phone the card is a sheet: keep the diagram inside it so the
    // caption underneath stays reachable
    const cap = window.innerWidth <= 820 ? Math.round(window.innerHeight * 0.46) : 520;
    const h = Math.round(Math.min(cap, Math.max(280, w * 1.05)));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; c.style.width = w + "px"; c.style.height = h + "px"; }
    const r = window.WXSounding.draw(c, d, i, { elevation_m: ((pt && pt.local) || {}).elevation_m,
                                                observed: pt && pt.sonde ? pt.sonde : null });
    $("#skewt-note").textContent = (r && r.caption) || "";
  }

  // ── Outdoors ──────────────────────────────────────────────────────────
  function renderOutdoors(d, i) {
    const { speed, speedUnit, state } = W();
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const t = s.t2m ? s.t2m[i] - K : null;
    const w = s.wind ? s.wind[i] : null, g = s.gust ? s.gust[i] : null, rain = s.tp6 ? s.tp6[i] : null, cloud = s.tcc ? s.tcc[i] : null;
    let chill = null;
    if (t != null && w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); chill = 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; }
    let humidex = null;
    if (t != null && s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); humidex = t + 0.5555 * (e - 10); }
    const snowLevel = fl != null ? Math.max(0, fl - 300) : null;
    const ptype = rain != null && rain > 0.2 ? (t != null && t < 1 ? "snow" : t != null && t < 3 ? "rain/snow" : "rain") : "dry";
    const j1 = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const rain24 = sumWindow(s.tp6, d.steps, i, 24);
    const gusts = s.gust ? s.gust.slice(i, j1 + 1).filter((v) => v != null) : [];
    const gustMax24 = gusts.length ? Math.max(...gusts) : null;
    const calm = state.units === "kt" ? 12 : state.units === "ms" ? 6 : 22, gusty = state.units === "kt" ? 25 : state.units === "ms" ? 13 : 46;
    let dryH = 0, totH = 0;  // dry, calm hours in the next 72 h (hikers, paddlers)
    for (let k = i; k < d.steps.length && d.steps[k] < d.steps[i] + 72; k++) { const h = stepHrs(d, k); totH += h; if (s.tp6 && (s.tp6[k] || 0) < 0.2 && (!s.wind || s.wind[k] == null || speed(s.wind[k]) < gusty)) dryH += h; }
    const dry = { length: dryH / 6 };
    const rows = [
      ["Precip now", `${ptype}${rain != null && rain > 0 ? ` · ${W().units.precip(rain).txt}/6h` : ""}`, ptype === "dry" ? "good" : ptype === "snow" ? "meh" : ""],
      ["Next 24 h rain", rain24 != null ? W().units.precip(rain24).txt : "—", rain24 == null ? "" : rain24 < 1 ? "good" : rain24 < 10 ? "meh" : "bad"],
      ["Freezing level", fl != null ? W().units.alt(fl).txt : "—", ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ["Wind / gust", w != null ? `${speed(w).toFixed(0)}${g != null ? ` · gusts ${speed(g).toFixed(0)}` : ""} ${speedUnit()}` : "—", w == null ? "" : speed(w) < calm ? "good" : "meh"],
      ["Max gust 24 h", gustMax24 != null ? `${speed(gustMax24).toFixed(0)} ${speedUnit()}` : "—", gustMax24 == null ? "" : speed(gustMax24) < gusty ? "good" : "bad"],
      ["Feels like", chill != null ? `${W().units.tempC(chill).v}° (wind chill)` : humidex != null ? `${W().units.tempC(humidex).v}° (humidex)` : t != null ? `${W().units.tempC(t).v}°` : "—", (chill != null && chill < -10) || (humidex != null && humidex > 35) ? "bad" : ""],
      ["Cloud", cloud != null ? `${(cloud * 100).toFixed(0)}%` : "—", cloud == null ? "" : cloud < 0.3 ? "good" : ""],
      ["Thunder risk (CAPE)", s.cape && s.cape[i] != null ? `${s.cape[i].toFixed(0)} J/kg` : "n/a", capeClass(s.cape && s.cape[i])],
      ["UV index (model est.)", s.uvi && s.uvi[i] != null ? `${s.uvi[i].toFixed(0)} ${uvWord(s.uvi[i])}` : "—", s.uvi && s.uvi[i] != null ? (s.uvi[i] < 3 ? "good" : s.uvi[i] < 8 ? "meh" : "bad") : ""],
      ...(s.swh && s.swh[i] != null ? [["Sea state", `${W().units.alt(s.swh[i], 1).txt}${s.mwp && s.mwp[i] != null ? ` · ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` from ${Math.round(s.mwd[i])}°` : ""}`, s.swh[i] < 1 ? "good" : s.swh[i] < 2.5 ? "meh" : "bad"]] : []),
      ["Dry, calm hours (3 d)", dryH ? `${dryH} h of ${totH}` : "none", dryH > 36 ? "good" : dryH ? "meh" : "bad"],
    ];
    const pt = W().state.point;
    let tidesHtml = "";
    if (pt && pt.tides && pt.tides.events && pt.tides.events.length) {
      const t = pt.tides;
      tidesHtml = `<div class="obs"><div class="obs-head"><span>Tides · ${esc(t.station)} · ${W().units.dist(t.distance_km).txt}</span><span class="dim">${esc(t.source)} · ${esc(t.datum)}</span></div>
        <div class="tides">${t.events.slice(0, 6).map((e) => `<span class="tide ${e.type}"><b>${e.type === "H" ? "▲" : "▼"} ${W().units.alt(e.height_m, 1).txt}</b><small>${W().units.dateTime(e.time, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small></span>`).join("")}</div></div>`;
    }
    $("#outdoors").innerHTML = `<div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${tidesHtml}${airHtml(pt || {})}
      <div class="note">Snow level ≈ freezing level − ${W().units.alt(300).txt}. Gusts come from models that ship one. Terrain is unresolved at 0.25°.</div>`;
  }

  // ── Spread: how much the ensemble disagrees with itself ───────────────
  const SPREAD_VARS = [["t2m", "Temp"], ["wind", "Wind"], ["tp6", "Rain"], ["msl", "Pressure"]];
  let spreadVar = localStorage.getItem("wxgrid.spreadVar") || "t2m";
  function renderSpread(pt, d, i) {
    const box = $("#spread-vars");
    box.innerHTML = SPREAD_VARS.map(([v, t]) => `<button data-v="${v}" class="${v === spreadVar ? "on" : ""}">${t}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { spreadVar = b.dataset.v; localStorage.setItem("wxgrid.spreadVar", spreadVar); pt.plume = undefined; renderSpread(pt, d, i); });
    const c = $("#plume"), note = $("#plume-note");
    const host = c.parentElement, w = Math.max(300, Math.round(host.clientWidth));
    c.style.width = w + "px"; c.style.height = "220px";
    if (pt.plume === undefined) {
      pt.plume = null; note.textContent = "loading the ensemble…";
      W().api(`${W().API}/ens/plume?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&var=${spreadVar}`)
        .then((r) => { pt.plume = r || false; if (W().state.point === pt && W().state.tab === "spread") W().renderPoint(); })
        .catch(() => { pt.plume = false; if (W().state.point === pt && W().state.tab === "spread") W().renderPoint(); });
      return;
    }
    if (!pt.plume) {
      c.getContext("2d").clearRect(0, 0, c.width, c.height);
      note.textContent = "No ensemble in the store yet. Ingest a GEFS run and the spread appears here.";
      return;
    }
    window.WXEns && window.WXEns.drawPlume(c, pt.plume, {});
    const basis = pt.plume.basis === "members" ? "51 members" : "mean ± spread, assumed Gaussian";
    note.textContent = `${pt.plume.label || spreadVar} · ${basis} · ${pt.plume.source || "GEFS"}. The band is where the ensemble puts the forecast; a wide band means the models are arguing with each other.`;
  }

  // ── Compare: every model at the same valid times ──────────────────────
  function renderCompare(pt, d, i) {
    const { speed, speedUnit, catalog, API, api } = W();
    if (!pt.cmp) {
      pt.cmp = { loading: true, rows: {} };
      const models = catalog.models.filter((m) => m.runs.length);
      Promise.all(models.map((m) => api(`${API}/point?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&model=${m.key}`).then((r) => [m, r]).catch(() => null))).then((rs) => {
        rs.filter(Boolean).forEach(([m, r]) => { pt.cmp.rows[m.key] = { model: m, data: r }; });
        pt.cmp.loading = false;
        if (W().state.point === pt && W().state.tab === "cmp") W().renderPoint();
      });
      $("#compare").innerHTML = `<div class="note">loading other models…</div>`;
      return;
    }
    if (pt.cmp.loading) return;
    const t0 = new Date(d.valid[i]).getTime();
    const cols = Array.from({ length: 8 }, (_, k) => t0 + k * 12 * 3600e3);      // 4 days at 12 h
    const head = cols.map((t) => `<th>${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric" }).replace(" ", "<br>")}</th>`).join("");
    const rowFor = (label, pick) => Object.values(pt.cmp.rows).map(({ model, data }) => {
      const cells = cols.map((t) => { const k = data.valid.findIndex((v) => new Date(v).getTime() === t); return `<td>${k >= 0 ? pick(data.series, k) : "—"}</td>`; }).join("");
      return `<tr><td>${model.short}</td>${cells}</tr>`;
    }).join("");
    $("#compare").innerHTML = `<table class="cmp"><thead><tr><th>Temp ${W().units.tempUnit}</th>${head}</tr></thead><tbody>${rowFor("t", (s, k) => s.t2m && s.t2m[k] != null ? W().units.temp(s.t2m[k]).v : "—")}</tbody>
      <thead><tr><th>Wind ${speedUnit()}</th>${head}</tr></thead><tbody>${rowFor("w", (s, k) => s.wind && s.wind[k] != null ? Math.round(speed(s.wind[k])) : "—")}</tbody>
      <thead><tr><th>Rain ${W().units.precipUnit}/12h</th>${head}</tr></thead><tbody>${rowFor("r", (s, k) => s.tp6 ? `<span class="r">${W().units.precip((s.tp6[k] || 0) + (s.tp6[k + 1] || 0)).v}</span>` : "—")}</tbody></table>
      <div class="note">Same valid times, each model's latest run. Disagreement is the error bar.</div>`;
  }

  // ── Resort: elevation-band forecast, whistlerpeak-style ───────────────
  function renderResort(pt, d, i) {
    const { speed, speedUnit, state, API, api } = W();
    const R = state.resort; if (!R) { $("#resort").innerHTML = ""; return; }
    const r = R.resort, base = R.elevation.base_m, summit = R.elevation.summit_m;
    if (!pt.profile) {
      const bands = [];
      if (base != null && summit != null && summit > base) {
        const mid = Math.round((base + summit) / 2);
        bands.push(["Village", base], ["Mid-mountain", mid], ["Alpine", Math.round(base + (summit - base) * 0.8)], ["Peak", summit]);
      } else { bands.push(["Village", 700], ["Mid", 1400], ["Alpine", 1900], ["Peak", 2300]); }
      pt.profile = { loading: true, bands };
      api(`${API}/profile?lat=${r.lat.toFixed(3)}&lon=${r.lon.toFixed(3)}&model=${state.model}&elevs=${bands.map((b) => b[1]).join(",")}`).then((p) => { pt.profile.data = p; pt.profile.loading = false; if (state.point === pt) W().renderPoint(); }).catch(() => { pt.profile.loading = false; pt.profile.error = true; if (state.point === pt) W().renderPoint(); });
    }
    const P = pt.profile;
    const lifts = (R.lifts && R.lifts.features || []).length;
    let bandsHtml = `<div class="note">loading elevation bands…</div>`;
    if (P.error) bandsHtml = `<div class="note">profile unavailable</div>`;
    else if (P.data) {
      const p = P.data;
      const k = Math.min(i, p.steps.length - 1);
      const sum = (arr, a, b) => arr ? arr.slice(a, b).reduce((x, y) => x + (y || 0), 0) : 0;
      const rows = P.bands.slice().reverse().map(([name, z], bi) => {
        const b = p.bands[P.bands.length - 1 - bi];
        const t = b.temp[k], w = b.wind[k], dir = b.wdir[k], pty = b.ptype[k];
        // snow at this band over next 24 h: precip that falls as snow at the band's temperature
        let snow24 = 0, rain24 = 0;
        for (let q = k + 1; q < p.steps.length && p.steps[q] <= p.steps[k] + 24; q++) { const amt = (p.tp6 && p.tp6[q]) || 0; if (b.ptype[q] === "snow") snow24 += amt; else if (b.ptype[q] === "mixed") { snow24 += amt / 2; rain24 += amt / 2; } else rain24 += amt; }
        return `<tr><td class="name">${name}<small>${W().units.alt(z).txt}</small></td><td><b>${t == null ? "—" : W().units.temp(t).v + "°"}</b></td><td>${w == null ? "—" : `<i style="display:inline-block;width:8px;height:8px;border-left:1.5px solid currentColor;border-top:1.5px solid currentColor;${W().arrowRot(dir)};margin-right:4px"></i>${Math.round(speed(w))} ${speedUnit()}`}</td><td>${pty ? `<span class="pill ${pty}">${pty}</span>` : "<span class=dim>—</span>"}</td><td>${snow24 >= 0.5 ? `<span class="pill snow">${W().units.snow(snow24).txt}</span>` : rain24 >= 0.5 ? `<span class="pill rain">${W().units.precip(rain24).txt}</span>` : "<span class=dim>·</span>"}</td></tr>`;
      }).join("");
      const fl = p.freezing_level_m ? p.freezing_level_m[k] : null;
      const snow72 = (() => { let s3 = 0; const b = p.bands[p.bands.length - 1]; for (let q = k + 1; q < p.steps.length && p.steps[q] <= p.steps[k] + 72; q++) if (b.ptype[q] === "snow") s3 += (p.tp6 && p.tp6[q]) || 0; return s3; })();
      bandsHtml = `<div class="snowline"><span>freezing level <b>${fl != null ? W().units.alt(fl).txt : "—"}</b></span><span>peak snow 72 h <b>${W().units.snow(snow72).txt}</b></span><span>lifts mapped <b>${lifts}</b></span></div>
        <table class="bands"><thead><tr><th>Band</th><th>Temp</th><th>Wind</th><th>Precip type</th><th>Next 24 h</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    $("#resort").innerHTML = `<div class="avy-head" style="margin-top:6px"><span>${esc(r.name)} <span class="dim">· ${esc(r.region || "")} ${esc(r.country || "")}</span></span>${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener">site ↗</a>` : ""}</div>
      ${bandsHtml}
      <div class="note">Whistler-Peak-style read for any resort: temperature and wind at each elevation band come from the model's pressure levels interpolated to that height; precip type per band from the band temperature; snowfall uses a 10:1 ratio. Base/summit from OSM tags, our seed list, or a DEM at the lift ends. Lifts drawn from OpenStreetMap; live lift status and webcams are per-resort feeds we don't have.</div>`;
  }

  // ── meteogram (Now pane) ─────────────────────────────────────────────
  function drawMeteogram(d, i) {
    const { speed, speedUnit, state } = W();
    const U = W().units;
    const c = $("#meteogram"), ctx = c.getContext("2d");
    const W_ = c.width, H = c.height, padL = 34, padR = 40, padT = 12, padB = 26;
    ctx.clearRect(0, 0, W_, H);
    const n = d.steps.length, xs = d.steps.map((_, k) => padL + (W_ - padL - padR) * k / (n - 1));
    const t = (d.series.t2m || []).map((v) => v == null ? null : U.temp(v).v);
    const rawRain = d.series.tp6 || [], snow = d.series.sf6 || [];
    const rain = rawRain.map((v) => v == null ? null : U.precip(v).v);
    const windS = (d.series.wind || []).map((v) => v == null ? null : speed(v));
    const rMax = Math.max(U.precipUnit === "in" ? 0.2 : 5, ...rain.filter((v) => v != null));
    rain.forEach((v, k) => { if (v == null) return; const h = (H - padT - padB) * v / rMax; const bw = Math.max(2, (W_ - padL - padR) / n - 2); ctx.fillStyle = (snow[k] || 0) > ((rawRain[k] || 0) * 0.5) ? "rgba(200,220,255,0.7)" : "rgba(108,182,255,0.55)"; ctx.fillRect(xs[k] - bw / 2, H - padB - h, bw, h); });
    const tv = t.filter((v) => v != null);
    if (tv.length) {
      const tempStep = U.tempUnit === "°F" ? 10 : 5;
      const lo = Math.floor(Math.min(...tv) / tempStep) * tempStep - 2, hi = Math.ceil(Math.max(...tv) / tempStep) * tempStep + 2;
      const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
      ctx.strokeStyle = "rgba(255,180,84,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      for (let g = lo; g <= hi; g += tempStep) { ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W_ - padR, y(g)); ctx.stroke(); }
      const freeze = U.tempC(0).v;
      if (lo < freeze && hi > freeze) { ctx.setLineDash([]); ctx.strokeStyle = "rgba(200,220,255,0.5)"; ctx.beginPath(); ctx.moveTo(padL, y(freeze)); ctx.lineTo(W_ - padR, y(freeze)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2; ctx.beginPath();
      t.forEach((v, k) => { if (v == null) return; k === 0 ? ctx.moveTo(xs[k], y(v)) : ctx.lineTo(xs[k], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "#ffb454"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "right";
      ctx.fillText(`${hi.toFixed(0)}°`, padL - 4, y(hi) + 4); ctx.fillText(`${lo.toFixed(0)}°`, padL - 4, y(lo) + 4);
    }
    const wv = windS.filter((v) => v != null);
    if (wv.length) {
      const hi = Math.max(state.units === "ms" ? 6 : 20, Math.ceil(Math.max(...wv) / 10) * 10);
      const y = (v) => padT + (H - padT - padB) * (1 - v / hi);
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.2; ctx.beginPath();
      windS.forEach((v, k) => { if (v == null) return; k === 0 ? ctx.moveTo(xs[k], y(v)) : ctx.lineTo(xs[k], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.textAlign = "left"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace";
      ctx.fillText(`${hi} ${speedUnit()}`, W_ - padR + 4, y(hi) + 4);
      ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillText(`${rMax.toFixed(U.precipUnit === "in" ? 1 : 0)} ${U.precipUnit}`, W_ - padR + 4, padT + 18);
    }
    ctx.fillStyle = "#7f8794"; ctx.font = "500 10.5px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "left";
    let lastDay = null;
    d.valid.forEach((iso, k) => { const dt = new Date(iso), day = dt.toDateString(); if (day !== lastDay) { lastDay = day; ctx.fillRect(xs[k], padT, 1, H - padT - padB); ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), xs[k] + 3, H - 8); } });
    ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillRect(xs[i] - 1, padT, 2, H - padT - padB);
    c.onclick = (ev) => { const rect = c.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W_; let best = 0; xs.forEach((xx, k) => { if (Math.abs(xx - x) < Math.abs(xs[best] - x)) best = k; }); W().setStep(best); };
  }

  window.WXPanes = { render };
})();
