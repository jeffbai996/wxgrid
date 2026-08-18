// Plume (fan) chart for forecast uncertainty: how much the ensemble
// disagrees with itself as lead time grows. Shaded p10–p90 and p25–p75 bands,
// a median line, thin member lines when the server actually has members, and
// a footer that says which of the two it drew — a Gaussian band synthesised
// from a stored standard deviation is not the same claim as fifty real
// members, and a chart that hides the difference is lying politely.
//
//   WXEns.drawPlume(canvas, data, opts)   data = GET /api/ens/plume
//   WXEns.spreadBandFor(series)           {lo, hi} from a bare {mean, sd}
//
// Everything is drawn in the user's units through WX.units / WX.speed, and
// every colour comes from a CSS custom property so the two themes and any
// private overlay stay in charge.
(function () {
  "use strict";
  const WX = window.WX || {};

  const css = (n, fb) => ((getComputedStyle(document.documentElement).getPropertyValue(n) || "").trim() || fb);

  // rgb()/#hex → "r,g,b" so a band can be painted at partial alpha without
  // hard-coding a colour. Anything unparseable falls back to the caller's.
  function rgbTriplet(colour, fallback) {
    const s = String(colour || "").trim();
    let m = /^#?([0-9a-f]{3})$/i.exec(s);
    if (m) { const h = m[1]; return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)).join(","); }
    m = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m) { const n = parseInt(m[1], 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; }
    m = /^rgba?\(([^)]+)\)/i.exec(s);
    if (m) return m[1].split(",").slice(0, 3).map((x) => Math.round(parseFloat(x))).join(",");
    return fallback;
  }

  // ── units ───────────────────────────────────────────────────────────────
  // The parent app owns WX.units; this file must still draw something sane in
  // a page that has not loaded it (the static build, a bare embed), so every
  // conversion has a metric fallback rather than a crash.
  const FALLBACK = {
    temp: (k) => ({ v: k == null ? null : k - 273.15, unit: "°C" }),
    press: (pa) => ({ v: pa == null ? null : pa / 100, unit: "hPa" }),
    precip: (mm) => ({ v: mm, unit: "mm" }),
    dist: (km) => ({ v: km, unit: "km" }),
    speed: (ms) => ({ v: ms, unit: "m/s" }),
  };

  function converter(kind) {
    const U = WX.units;
    if (kind === "temp") return U && U.temp ? (v) => U.temp(v, 1) : FALLBACK.temp;
    if (kind === "press") return U && U.press ? (v) => U.press(v, 0) : FALLBACK.press;
    if (kind === "precip") return U && U.precip ? (v) => U.precip(v) : FALLBACK.precip;
    if (kind === "dist") return U && U.dist ? (v) => U.dist(v) : FALLBACK.dist;
    if (kind === "speed") {
      return WX.speed && WX.speedUnit
        ? (v) => ({ v: v == null ? null : WX.speed(v), unit: WX.speedUnit() })
        : FALLBACK.speed;
    }
    return (v) => ({ v: v, unit: "" });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  // {lo, hi} one standard deviation either side — for a caller that has a mean
  // and a spread but does not want a whole plume (a tape row, a hover chip).
  function spreadBandFor(series) {
    if (!series || !series.mean || !series.sd) return null;
    const lo = [], hi = [];
    for (let i = 0; i < series.mean.length; i++) {
      const m = series.mean[i], s = series.sd[i];
      if (m == null || s == null) { lo.push(null); hi.push(null); continue; }
      lo.push(series.floor != null ? Math.max(series.floor, m - s) : m - s);
      hi.push(m + s);
    }
    return { lo, hi };
  }

  // Round the y axis to a human interval that yields 4–6 gridlines.
  function ticks(lo, hi) {
    if (!(hi > lo)) return { lo: lo - 1, hi: lo + 1, step: 1 };
    const raw = (hi - lo) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }

  function extent(arrays) {
    let lo = Infinity, hi = -Infinity;
    for (const a of arrays) for (const v of (a || [])) {
      if (v == null || !isFinite(v)) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return isFinite(lo) ? [lo, hi] : null;
  }

  // A polyline that breaks at nulls instead of drawing a straight line across
  // the gap — a missing step is missing, not interpolated.
  function strokeSeries(x, vals, xOf, yOf) {
    let open = false;
    x.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null || !isFinite(v)) { open = false; continue; }
      if (!open) { x.moveTo(xOf(i), yOf(v)); open = true; } else x.lineTo(xOf(i), yOf(v));
    }
    x.stroke();
  }

  // Fill between two series, one contiguous run at a time.
  function fillBand(x, low, high, xOf, yOf) {
    let i = 0;
    while (i < low.length) {
      if (low[i] == null || high[i] == null || !isFinite(low[i]) || !isFinite(high[i])) { i++; continue; }
      let j = i;
      while (j + 1 < low.length && low[j + 1] != null && high[j + 1] != null
             && isFinite(low[j + 1]) && isFinite(high[j + 1])) j++;
      x.beginPath();
      for (let k = i; k <= j; k++) x.lineTo(xOf(k), yOf(high[k]));
      for (let k = j; k >= i; k--) x.lineTo(xOf(k), yOf(low[k]));
      x.closePath();
      x.fill();
      i = j + 1;
    }
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const U = WX.units;
    const opts = { weekday: "short", hour: "numeric" };
    return U && U.timeOpts ? d.toLocaleString(undefined, U.timeOpts(opts)) : d.toLocaleString(undefined, opts);
  }

  // ── the chart ───────────────────────────────────────────────────────────

  function drawPlume(canvas, data, opts) {
    opts = opts || {};
    if (!canvas || !data || !data.steps || !data.steps.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || canvas.width || 320;
    const h = canvas.clientHeight || canvas.height || 180;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const x = canvas.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);

    const conv = converter(data.kind);
    const cv = (v) => { const r = conv(v); return r && r.v != null && isFinite(r.v) ? r.v : null; };
    const unit = (conv(data.mean && data.mean.find((v) => v != null)) || {}).unit || data.unit || "";

    // Convert once: the axis, the bands and the readout all work in display
    // units, so nothing downstream has to remember which space it is in.
    const S = {};
    ["p10", "p25", "p50", "p75", "p90", "mean"].forEach((k) => { S[k] = (data[k] || []).map(cv); });
    const members = (opts.members !== false && Array.isArray(data.members))
      ? data.members.map((m) => m.map(cv)) : null;

    const n = data.steps.length;
    const span = extent([S.p10, S.p90, S.mean].concat(members || []));
    if (!span) return;
    const pad = (span[1] - span[0]) * 0.12 || 1;
    const t = ticks(span[0] - pad, span[1] + pad);

    const padL = opts.padL != null ? opts.padL : 46;
    const padR = 10, padT = 10, padB = 22;
    const gw = Math.max(10, w - padL - padR), gh = Math.max(10, h - padT - padB);
    const xOf = (i) => padL + (n > 1 ? gw * i / (n - 1) : gw / 2);
    const yOf = (v) => padT + gh * (1 - (v - t.lo) / (t.hi - t.lo || 1));

    const accent = css("--accent", "#ff8a3d");
    const accentRGB = rgbTriplet(accent, "255,138,61");
    const fg = css("--fg", "#eef1f5");
    const dim = css("--dim", "#7c8492");
    const line = css("--line", "rgba(255,255,255,.09)");
    const mono = css("--font-mono", "ui-monospace, monospace");

    // gridlines first, so every band sits on top of them
    x.strokeStyle = line; x.lineWidth = 1;
    x.fillStyle = dim; x.font = `500 10px ${mono}`;
    x.textAlign = "right"; x.textBaseline = "middle";
    const decimals = t.step < 1 ? (t.step < 0.2 ? 2 : 1) : 0;
    for (let v = t.lo; v <= t.hi + 1e-9; v += t.step) {
      const y = Math.round(yOf(v)) + 0.5;
      x.beginPath(); x.moveTo(padL, y); x.lineTo(padL + gw, y); x.stroke();
      x.fillText(v.toFixed(decimals), padL - 6, y);
    }

    // p10–p90 then p25–p75: two washes of the same hue, so the darker core is
    // read as "more likely" without needing a second colour in the legend.
    x.fillStyle = `rgba(${accentRGB},0.16)`;
    fillBand(x, S.p10, S.p90, xOf, yOf);
    x.fillStyle = `rgba(${accentRGB},0.26)`;
    fillBand(x, S.p25, S.p75, xOf, yOf);

    // individual members, thin and faint — texture, not data you read off
    if (members) {
      x.strokeStyle = `rgba(${accentRGB},0.20)`; x.lineWidth = 0.8;
      for (const m of members) strokeSeries(x, m, xOf, yOf);
    }

    // median, then the deterministic mean dashed on top when they differ
    x.strokeStyle = accent; x.lineWidth = 2; x.lineJoin = "round";
    strokeSeries(x, S.p50, xOf, yOf);
    const meanDiffers = S.mean.some((v, i) => v != null && S.p50[i] != null && Math.abs(v - S.p50[i]) > 1e-6);
    if (meanDiffers) {
      x.strokeStyle = fg; x.lineWidth = 1.2; x.setLineDash([4, 3]);
      strokeSeries(x, S.mean, xOf, yOf);
      x.setLineDash([]);
    }

    // x axis: a handful of valid times, never so many that they collide
    x.fillStyle = dim; x.textAlign = "center"; x.textBaseline = "top";
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(gw / 74))));
    for (let i = 0; i < n; i += every) {
      x.fillText(dayLabel(data.valid[i]), Math.min(w - 24, Math.max(24, xOf(i))), padT + gh + 5);
    }

    x.strokeStyle = line; x.lineWidth = 1;
    x.strokeRect(padL + 0.5, padT + 0.5, gw - 1, gh - 1);

    // The honesty line. `basis` is never absent from a server response, but a
    // caller hand-rolling `data` should still get told what it drew.
    if (opts.caption !== false) {
      const basis = data.basis === "members"
        ? `${(data.members || []).length} members`
        : "band from ensemble spread (Gaussian)";
      x.fillStyle = dim; x.font = `500 9.5px ${mono}`;
      x.textAlign = "left"; x.textBaseline = "top";
      x.fillText(basis, padL + 3, padT + 3);
      x.textAlign = "right";
      x.fillText(unit, padL + gw - 3, padT + 3);
    }

    // hover crosshair + readout, driven by opts.hoverX in 0..1 of the canvas
    if (opts.hoverX != null) {
      const i = Math.max(0, Math.min(n - 1, Math.round((opts.hoverX * w - padL) / gw * (n - 1))));
      x.strokeStyle = accent; x.lineWidth = 1;
      x.beginPath(); x.moveTo(Math.round(xOf(i)) + 0.5, padT); x.lineTo(Math.round(xOf(i)) + 0.5, padT + gh); x.stroke();
      const lo = S.p10[i], hi = S.p90[i], mid = S.p50[i];
      if (mid != null) {
        const txt = `${mid.toFixed(decimals)}${unit ? " " + unit : ""}`
          + (lo != null && hi != null ? `  (${lo.toFixed(decimals)}–${hi.toFixed(decimals)})` : "");
        x.font = `600 11px ${mono}`;
        const tw = x.measureText(txt).width + 10;
        const bx = Math.min(padL + gw - tw, Math.max(padL, xOf(i) - tw / 2));
        x.fillStyle = css("--panel-solid", "#0a0b0d"); x.globalAlpha = 0.92;
        x.fillRect(bx, padT + 2, tw, 17); x.globalAlpha = 1;
        x.fillStyle = fg; x.textAlign = "left"; x.textBaseline = "middle";
        x.fillText(txt, bx + 5, padT + 11);
      }
    }
    return { xOf, yOf, ticks: t, unit, n };
  }

  window.WXEns = { drawPlume, spreadBandFor };
})();
