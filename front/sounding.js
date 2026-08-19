// Skew-T log-P sounding for the point card, drawn from the model's pressure
// levels (1000 … 200 hPa) plus the surface. Real thermodynamic background —
// isotherms skewed 45°, dry adiabats, pseudoadiabats, saturation mixing-ratio
// lines — so the profile can be read the way a sounding is read, not as a
// line chart with pressure on the y axis.
//
// What the model gives us is temperature and wind at ten levels and T/Td at
// the surface. There is no humidity aloft in the runs wxgrid ingests, so there
// is no honest dew-point profile: we draw the surface dew point, lift a parcel
// from it, and say in the caption that the moisture profile is missing. The
// derived numbers follow the same rule — a surface-parcel CAPE from ten levels
// is an estimate and is labelled as one, next to the model's own CAPE.
//
//   WXSounding.draw(canvas, pointData, stepIndex[, opts]) → summary object
//
// opts: { elevation_m } — the site elevation, used for the surface pressure.
// Falls back to WX.state.point.local.elevation_m, then to sea level.
(function () {
  "use strict";

  // ── thermodynamics ────────────────────────────────────────────────────
  const K = 273.15, RD = 287.05, CP = 1005.7, LV = 2.501e6, EPS = 0.622, KAPPA = RD / CP;
  const esat = (Tc) => 6.112 * Math.exp(17.67 * Tc / (Tc + 243.5));            // hPa over water
  const dewFromE = (e) => { const l = Math.log(Math.max(e, 1e-6) / 6.112); return 243.5 * l / (17.67 - l); };
  const mixing = (Tc, p) => { const e = esat(Tc); return EPS * e / Math.max(p - e, 1e-3); };   // kg/kg
  const dewFromW = (w, p) => dewFromE(w * p / (EPS + w));
  // Potential temperature and its inverse — the dry adiabats.
  const theta = (Tc, p) => (Tc + K) * Math.pow(1000 / p, KAPPA) - K;
  const dryT = (thC, p) => (thC + K) * Math.pow(p / 1000, KAPPA) - K;
  // One step along a pseudoadiabat: dT/dlnp for a saturated parcel.
  function moistStep(Tk, p, dlnp) {
    const ws = mixing(Tk - K, p);
    const num = RD * Tk + LV * ws;
    const den = CP + (LV * LV * ws * EPS) / (RD * Tk * Tk);
    return Tk + (num / den) * dlnp;
  }
  // Bolton (1980) LCL temperature, then the dry adiabat gives its pressure.
  function lcl(Tc, Tdc, p) {
    const T = Tc + K, Td = Math.min(Tdc, Tc) + K;
    const Tl = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56;
    return { t: Tl - K, p: p * Math.pow(Tl / T, 1 / KAPPA) };
  }
  // Barometric height between two pressures for a mean temperature — used only
  // to turn LCL and freezing pressures into something a pilot can read.
  const hypso = (p0, p1, Tmean) => (RD * (Tmean + K) / 9.80665) * Math.log(p0 / p1);

  // ── palette from the document, so the diagram follows the theme ───────
  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => ((cs.getPropertyValue(name) || "").trim() || fb);
    return {
      fg: v("--fg", "#eef1f5"), fg2: v("--fg-2", "#b4bbc6"), dim: v("--dim", "#7c8492"),
      accent: v("--accent", "#ff8a3d"), warm: v("--warm", "#ffb454"), rain: v("--rain", "#6cb6ff"),
      bad: v("--bad", "#ef786f"), good: v("--good", "#78d39a"), panel: v("--panel-solid", "#0a0b0d"),
      mono: v("--font-mono", "ui-monospace, monospace"),
    };
  }

  // ── frame ─────────────────────────────────────────────────────────────
  const PBOT = 1050, PTOP = 150;                 // pressure range of the diagram
  const TMIN = -45, TMAX = 45;                   // temperature range along the bottom axis
  const SKEW = 0.92;                             // px right per px up → isotherms at ~45°
  const ISOBARS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];

  function frame(c) {
    const padL = 36, padR = 62, padT = 12, padB = 46;
    const w = c.width, h = c.height;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const lnTop = Math.log(PTOP), lnBot = Math.log(PBOT);
    const Y = (p) => padT + plotH * (lnTop - Math.log(p)) / (lnTop - lnBot);
    const xT = (t) => padL + plotW * (t - TMIN) / (TMAX - TMIN);
    const X = (t, p) => xT(t) + SKEW * (padT + plotH - Y(p));
    // Inverse, for reading a temperature off a pixel column (unused by the
    // drawing but kept because every skew-T tool eventually needs it).
    const T = (x, p) => TMIN + (x - SKEW * (padT + plotH - Y(p)) - padL) * (TMAX - TMIN) / plotW;
    return { padL, padR, padT, padB, w, h, plotW, plotH, X, Y, xT, T,
             left: padL, right: padL + plotW, top: padT, bottom: padT + plotH };
  }

  function polyline(ctx, pts) {
    let started = false;
    ctx.beginPath();
    for (const [x, y] of pts) {
      if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }

  // ── background: isobars, isotherms, adiabats, mixing ratios ───────────
  function background(ctx, F, P) {
    ctx.save();
    ctx.beginPath(); ctx.rect(F.left, F.top, F.plotW, F.bottom - F.top); ctx.clip();

    // dry adiabats (constant potential temperature)
    ctx.strokeStyle = P.warm; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.22;
    for (let th = -30; th <= 200; th += 10) {
      const pts = [];
      for (let p = PBOT; p >= PTOP; p -= 12) pts.push([F.X(dryT(th, p), p), F.Y(p)]);
      polyline(ctx, pts);
    }
    // pseudoadiabats (saturated parcel paths)
    ctx.strokeStyle = P.good; ctx.globalAlpha = 0.28; ctx.setLineDash([]);
    for (let t0 = -20; t0 <= 40; t0 += 5) {
      let Tk = t0 + K, p = 1000;
      const pts = [];
      // down to the surface first so the curve spans the whole diagram
      let Tdn = Tk, pd = 1000;
      const down = [];
      while (pd < PBOT) { const np = pd * Math.exp(0.01); Tdn = moistStep(Tdn, pd, 0.01); pd = np; down.push([F.X(Tdn - K, pd), F.Y(pd)]); }
      down.reverse();
      pts.push(...down);
      while (p > PTOP) { const np = p * Math.exp(-0.02); Tk = moistStep(Tk, p, -0.02); p = np; pts.push([F.X(Tk - K, p), F.Y(p)]); }
      polyline(ctx, pts);
    }
    // saturation mixing ratio (g/kg), dashed — the moisture ruler
    ctx.strokeStyle = P.rain; ctx.globalAlpha = 0.3; ctx.setLineDash([3, 4]); ctx.lineWidth = 0.9;
    const WLINES = [0.4, 1, 2, 3, 5, 8, 12, 20, 30];
    ctx.font = `600 8.5px ${P.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const g of WLINES) {
      const w = g / 1000;
      const pts = [];
      for (let p = PBOT; p >= 400; p -= 20) pts.push([F.X(dewFromW(w, p), p), F.Y(p)]);
      polyline(ctx, pts);
      const x = F.X(dewFromW(w, 700), 700), y = F.Y(700);
      if (x > F.left + 6 && x < F.right - 6) { ctx.globalAlpha = 0.55; ctx.fillStyle = P.rain; ctx.fillText(String(g), x, y); ctx.globalAlpha = 0.3; }
    }
    ctx.setLineDash([]);

    // isotherms every 10 °C; 0 °C picked out
    for (let t = -110; t <= 50; t += 10) {
      const zero = t === 0;
      ctx.strokeStyle = zero ? P.rain : P.fg;
      ctx.globalAlpha = zero ? 0.45 : 0.14;
      ctx.lineWidth = zero ? 1.3 : 0.8;
      polyline(ctx, [[F.X(t, PBOT), F.Y(PBOT)], [F.X(t, PTOP), F.Y(PTOP)]]);
    }
    ctx.restore();

    // isobars + labels
    ctx.strokeStyle = P.fg; ctx.globalAlpha = 0.16; ctx.lineWidth = 0.8;
    for (const p of ISOBARS) polyline(ctx, [[F.left, F.Y(p)], [F.right, F.Y(p)]]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = P.dim; ctx.font = `600 9.5px ${P.mono}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const p of ISOBARS) ctx.fillText(String(p), F.left - 5, F.Y(p));
    ctx.save(); ctx.translate(11, (F.top + F.bottom) / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillText("hPa", 0, 0); ctx.restore();

    // temperature axis along the bottom
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let t = TMIN + 5; t <= TMAX; t += 10) {
      const x = F.X(t, PBOT);
      if (x < F.left || x > F.right) continue;
      ctx.strokeStyle = P.fg; ctx.globalAlpha = 0.25;
      polyline(ctx, [[x, F.bottom], [x, F.bottom + 4]]);
      ctx.globalAlpha = 1; ctx.fillStyle = P.dim;
      ctx.fillText(`${t}`, x, F.bottom + 6);
    }
    ctx.strokeStyle = P.fg; ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
    ctx.strokeRect(F.left + 0.5, F.top + 0.5, F.plotW - 1, F.bottom - F.top - 1);
    ctx.globalAlpha = 1;
  }

  // ── wind barbs ────────────────────────────────────────────────────────
  function barb(ctx, x, y, kt, dirFrom, colour) {
    ctx.save();
    ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.2; ctx.lineCap = "round";
    if (kt == null || dirFrom == null) { ctx.restore(); return; }
    if (kt < 2.5) {                                   // calm: the open circle
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); return;
    }
    const L = 26, ang = dirFrom * Math.PI / 180;
    const ux = Math.sin(ang), uy = -Math.cos(ang);    // shaft points into the wind
    const px = -uy, py = ux;                          // perpendicular, barbs hang off this side
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ux * L, y + uy * L); ctx.stroke();
    let n = Math.round(kt / 5) * 5, pos = L;
    const tick = (len, at) => { ctx.beginPath(); ctx.moveTo(x + ux * at, y + uy * at); ctx.lineTo(x + ux * (at - 3) + px * len, y + uy * (at - 3) + py * len); ctx.stroke(); };
    while (n >= 50) {                                  // pennant
      ctx.beginPath();
      ctx.moveTo(x + ux * pos, y + uy * pos);
      ctx.lineTo(x + ux * (pos - 6), y + uy * (pos - 6));
      ctx.lineTo(x + ux * pos + px * 9, y + uy * pos + py * 9);
      ctx.closePath(); ctx.fill();
      n -= 50; pos -= 7.5;
    }
    while (n >= 10) { tick(9, pos); n -= 10; pos -= 4.2; }
    if (n >= 5) tick(5, pos === L ? pos - 4.2 : pos);
    ctx.restore();
  }

  // ── profile assembly ──────────────────────────────────────────────────
  // The aloft dew point: only drawn if a run actually carries humidity aloft.
  // None of the models wxgrid ingests do today, so this is the hook, not a
  // guess — no fabricated moisture profile.
  function aloftDew(a, i) {
    const rh = a.rh || a.r || a.relhum;
    const td = a.td || a.dewp || a.dpt || a.d;
    if (td && td[i] != null) return td[i] > 120 ? td[i] - K : td[i];        // K or °C
    if (rh && rh[i] != null && a.temp && a.temp[i] != null) {
      const Tc = a.temp[i] - K, e = esat(Tc) * Math.max(1, Math.min(100, rh[i])) / 100;
      return dewFromE(e);
    }
    return null;
  }

  function build(d, i, opts) {
    const s = d.series || {};
    const msl = s.msl && s.msl[i] != null ? s.msl[i] / 100 : 1013.25;       // Pa → hPa
    let elev = opts && opts.elevation_m != null ? opts.elevation_m : null;
    if (elev == null) {
      const st = window.WX && window.WX.state && window.WX.state.point;
      elev = st && st.local && st.local.elevation_m != null ? st.local.elevation_m : 0;
    }
    // Surface pressure from MSL by the standard atmosphere — the model does not
    // ship one, and using MSL at a 1500 m site would lift the parcel from the
    // wrong place.
    const psfc = Math.min(PBOT, msl * Math.pow(1 - 0.0065 * elev / 288.15, 5.2559));
    const sfc = { p: psfc,
                  t: s.t2m && s.t2m[i] != null ? s.t2m[i] - K : null,
                  td: s.d2m && s.d2m[i] != null ? s.d2m[i] - K : null,
                  wind: s.wind ? s.wind[i] : null, wdir: s.wdir ? s.wdir[i] : null };
    const env = [], dew = [], winds = [];
    if (sfc.t != null) env.push({ p: psfc, t: sfc.t });
    if (sfc.td != null) dew.push({ p: psfc, t: Math.min(sfc.td, sfc.t == null ? sfc.td : sfc.t) });
    if (sfc.wind != null && sfc.wdir != null) winds.push({ p: psfc, kt: sfc.wind * 1.943844, dir: sfc.wdir, label: "sfc" });
    const levels = (d.levels || []).slice().sort((a, b) => b - a);
    let dewAloft = 0;
    for (const lvl of levels) {
      const a = (d.aloft || {})[String(lvl)];
      if (!a) continue;
      if (lvl > psfc) continue;                        // level is underground here
      if (a.temp && a.temp[i] != null) env.push({ p: lvl, t: a.temp[i] - K, gh: a.gh && a.gh[i] != null ? a.gh[i] : null });
      const td = aloftDew(a, i);
      if (td != null) { dew.push({ p: lvl, t: td }); dewAloft++; }
      if (a.wind && a.wind[i] != null && a.wdir && a.wdir[i] != null) winds.push({ p: lvl, kt: a.wind[i] * 1.943844, dir: a.wdir[i], label: String(lvl) });
    }
    env.sort((x, y) => y.p - x.p);
    dew.sort((x, y) => y.p - x.p);
    return { sfc, env, dew, winds, hasDewAloft: dewAloft >= 2, elev, msl, psfc };
  }

  // Environment temperature at any pressure, linear in ln(p) between the
  // levels we actually have. Returns null outside the profile.
  function envAt(env, p) {
    if (env.length < 2) return null;
    if (p > env[0].p || p < env[env.length - 1].p) return null;
    for (let k = 0; k < env.length - 1; k++) {
      const a = env[k], b = env[k + 1];
      if (p <= a.p && p >= b.p) {
        const f = (Math.log(a.p) - Math.log(p)) / (Math.log(a.p) - Math.log(b.p) || 1e-9);
        return a.t + (b.t - a.t) * f;
      }
    }
    return null;
  }

  // Surface-based parcel: dry to the LCL, pseudoadiabatic above, integrated on
  // a 5 hPa grid against the interpolated environment. Ten levels is coarse —
  // an inversion between 925 and 850 is invisible — so this is reported as an
  // estimate, never as "the" CAPE.
  function parcel(prof) {
    const { sfc, env } = prof;
    if (sfc.t == null || sfc.td == null || env.length < 3) return null;
    const L = lcl(sfc.t, sfc.td, sfc.p);
    const path = [];
    let cape = 0, cin = 0, lfc = null, el = null;
    let Tk = sfc.t + K, p = sfc.p;
    const STEP = 5;
    while (p > PTOP) {
      const np = Math.max(PTOP, p - STEP);
      // Dry below the LCL, pseudoadiabatic above. Both legs are anchored — the
      // dry one on the surface, the first moist one on the LCL — so rounding
      // never walks the parcel off its own adiabat.
      if (np >= L.p) Tk = (sfc.t + K) * Math.pow(np / sfc.p, KAPPA);
      else if (p >= L.p) Tk = moistStep(L.t + K, L.p, Math.log(np / L.p));
      else Tk = moistStep(Tk, p, Math.log(np / p));
      const Tp = Tk - K, Te = envAt(env, np);
      path.push({ p: np, t: Tp });
      if (Te != null) {
        const dlnp = Math.log(p / np);
        const buoy = RD * (Tp - Te) * dlnp;                         // J/kg over the layer
        if (Tp > Te) { if (lfc == null && np < sfc.p) lfc = np; if (lfc != null) cape += buoy; }
        else if (lfc == null) cin += buoy;
        else if (el == null && cape > 0) el = np;
      }
      p = np;
    }
    // No LFC means the parcel never becomes buoyant anywhere we can see, and
    // the running negative area is then not a CIN — it is the whole column.
    return { lcl: L, path, cape: Math.max(0, cape), cin: lfc == null ? null : Math.min(0, cin), lfc, el };
  }

  // Pressure and height where the environment crosses 0 °C, lowest crossing up.
  function freezing(env) {
    for (let k = 0; k < env.length - 1; k++) {
      const a = env[k], b = env[k + 1];
      if (a.t == null || b.t == null) continue;
      if ((a.t >= 0) !== (b.t >= 0)) {
        const f = (0 - a.t) / (b.t - a.t);
        const p = Math.exp(Math.log(a.p) + f * (Math.log(b.p) - Math.log(a.p)));
        const gh = a.gh != null && b.gh != null ? a.gh + f * (b.gh - a.gh) : null;
        return { p, gh };
      }
    }
    return null;
  }

  // ── the draw ──────────────────────────────────────────────────────────
  function draw(canvas, pointData, i, opts) {
    const d = pointData && pointData.series ? pointData : (pointData && pointData.data) || null;
    const ctx = canvas.getContext("2d");
    const P = palette(), F = frame(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineJoin = "round";
    if (!d || !d.series) {
      ctx.fillStyle = P.dim; ctx.font = `600 12px ${P.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No point data", canvas.width / 2, canvas.height / 2);
      return { ok: false, caption: "No point data." };
    }
    background(ctx, F, P);
    const prof = build(d, i, opts);
    const par = parcel(prof);
    const notes = [];

    ctx.save();
    ctx.beginPath(); ctx.rect(F.left, F.top, F.plotW, F.bottom - F.top); ctx.clip();

    // parcel path, drawn under the traces
    if (par) {
      ctx.strokeStyle = P.fg2; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.1; ctx.setLineDash([4, 3]);
      polyline(ctx, [[F.X(prof.sfc.t, prof.sfc.p), F.Y(prof.sfc.p)], ...par.path.map((q) => [F.X(q.t, q.p), F.Y(q.p)])]);
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // shade the positive area between LFC and EL: that is the CAPE
      if (par.lfc && par.cape > 10) {
        const top = par.el || PTOP;
        const up = par.path.filter((q) => q.p <= par.lfc && q.p >= top);
        const envPts = up.map((q) => { const Te = envAt(prof.env, q.p); return Te == null ? null : [F.X(Te, q.p), F.Y(q.p)]; }).filter(Boolean);
        if (up.length > 1 && envPts.length > 1) {
          ctx.beginPath();
          up.forEach((q, k) => { const x = F.X(q.t, q.p), y = F.Y(q.p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          for (let k = envPts.length - 1; k >= 0; k--) ctx.lineTo(envPts[k][0], envPts[k][1]);
          ctx.closePath();
          ctx.fillStyle = P.bad; ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 1;
        }
      }
    }

    // ── the observed ascent, when a radiosonde is in reach ──────────────
    // A balloon is the ground truth the model is trying to guess. Drawn thin
    // and cool-coloured so the model traces stay the loud ones.
    const obs = opts && opts.observed;
    if (obs && obs.levels && obs.levels.length > 4) {
      const ok = (l) => l && l.p != null && l.p >= PTOP && l.p <= 1050;
      const tPts = obs.levels.filter((l) => ok(l) && l.t != null).map((l) => [F.X(l.t, l.p), F.Y(l.p)]);
      const dPts = obs.levels.filter((l) => ok(l) && l.td != null).map((l) => [F.X(l.td, l.p), F.Y(l.p)]);
      ctx.save();
      ctx.lineWidth = 1.4; ctx.globalAlpha = 0.9;
      if (tPts.length > 1) { ctx.strokeStyle = P.fg; ctx.setLineDash([]); polyline(ctx, tPts); }
      if (dPts.length > 1) { ctx.strokeStyle = P.rain || "#6cb6ff"; ctx.setLineDash([3, 2]); polyline(ctx, dPts); ctx.setLineDash([]); }
      ctx.restore();
    }

    // dew-point trace: the surface point always, the profile only when the run
    // carries humidity aloft
    if (prof.dew.length) {
      ctx.strokeStyle = P.good; ctx.lineWidth = 2.2;
      if (prof.hasDewAloft) polyline(ctx, prof.dew.map((q) => [F.X(q.t, q.p), F.Y(q.p)]));
      const q0 = prof.dew[0];
      ctx.fillStyle = P.good;
      ctx.beginPath(); ctx.arc(F.X(q0.t, q0.p), F.Y(q0.p), 3.4, 0, Math.PI * 2); ctx.fill();
    }
    // temperature trace
    if (prof.env.length) {
      ctx.strokeStyle = P.accent; ctx.lineWidth = 2.4;
      polyline(ctx, prof.env.map((q) => [F.X(q.t, q.p), F.Y(q.p)]));
      ctx.fillStyle = P.accent;
      for (const q of prof.env) { ctx.beginPath(); ctx.arc(F.X(q.t, q.p), F.Y(q.p), 2.4, 0, Math.PI * 2); ctx.fill(); }
    }
    // LCL marker
    if (par && par.lcl.p < prof.psfc) {
      const y = F.Y(par.lcl.p), x = F.X(par.lcl.t, par.lcl.p);
      ctx.strokeStyle = P.good; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
      polyline(ctx, [[F.left, y], [F.right, y]]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = P.good; ctx.font = `700 9px ${P.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("LCL", F.left + 4, y - 2);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // wind barbs down the right edge
    const bx = F.right + 30;
    ctx.strokeStyle = P.dim; ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
    polyline(ctx, [[bx, F.top], [bx, F.bottom]]);
    ctx.globalAlpha = 1;
    for (const w of prof.winds) {
      const y = F.Y(w.p);
      if (y < F.top || y > F.bottom) continue;
      barb(ctx, bx, y, w.kt, w.dir, w.kt >= 50 ? P.bad : w.kt >= 25 ? P.warm : P.fg2);
    }
    ctx.fillStyle = P.dim; ctx.font = `600 8.5px ${P.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("kt", bx, F.top - 1);

    // ── indices box ─────────────────────────────────────────────────────
    const fz = freezing(prof.env);
    const s = d.series;
    const modelCape = s.cape && s.cape[i] != null ? s.cape[i] : null;
    const derivedFz = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const fzM = derivedFz != null ? derivedFz : (fz && fz.gh != null ? Math.round(fz.gh) : null);
    const rows = [];
    if (prof.sfc.t != null) rows.push(["T / Td", `${prof.sfc.t.toFixed(0)}° / ${prof.sfc.td != null ? prof.sfc.td.toFixed(0) + "°" : "—"}`]);
    rows.push(["Surface", `${Math.round(prof.psfc)} hPa · ${Math.round(prof.elev || 0)} m`]);
    rows.push(["Freezing", fzM != null ? `${fzM} m · ${(fzM * 3.281 / 1000).toFixed(1)}k ft` : (fz ? `${Math.round(fz.p)} hPa` : "not in profile")]);
    if (par) {
      const lclAgl = Math.round(hypso(prof.psfc, par.lcl.p, (prof.sfc.t + par.lcl.t) / 2));
      rows.push(["LCL", `${Math.round(par.lcl.p)} hPa · ${lclAgl} m`]);
      rows.push(["CAPE est.", `${Math.round(par.cape)} J/kg`]);
      rows.push(["CIN est.", par.cin == null ? "no LFC" : `${Math.round(par.cin)} J/kg`]);
      if (par.lfc) rows.push(["LFC / EL", `${Math.round(par.lfc)} / ${par.el ? Math.round(par.el) : "—"} hPa`]);
    }
    if (modelCape != null) rows.push(["CAPE (model)", `${Math.round(modelCape)} J/kg`]);
    const bw = 178, bh = 13 * rows.length + 10;
    const bxx = F.left + 6, byy = F.top + 6;
    ctx.globalAlpha = 0.82; ctx.fillStyle = P.panel;
    ctx.fillRect(bxx, byy, bw, bh);
    ctx.globalAlpha = 0.35; ctx.strokeStyle = P.fg; ctx.lineWidth = 1; ctx.strokeRect(bxx + 0.5, byy + 0.5, bw - 1, bh - 1);
    ctx.globalAlpha = 1; ctx.textBaseline = "middle"; ctx.font = `600 9px ${P.mono}`;
    rows.forEach(([k, v], n) => {
      const y = byy + 11 + n * 13;
      ctx.fillStyle = P.dim; ctx.textAlign = "left"; ctx.fillText(k, bxx + 6, y);
      ctx.fillStyle = k.startsWith("CAPE") && parseFloat(v) > 1000 ? P.bad : P.fg;
      ctx.textAlign = "right"; ctx.fillText(v, bxx + bw - 6, y);
    });

    // ── caption ─────────────────────────────────────────────────────────
    if (!prof.hasDewAloft) notes.push("No humidity aloft in this run. Green is the surface dew point only.");
    else notes.push("Dew point from the run's humidity aloft.");
    if (par) notes.push(`Surface parcel, dry to the LCL then pseudoadiabatic. CAPE and CIN across ${prof.env.length} levels, so an inversion between them is invisible.`);
    else notes.push("No surface dew point: no parcel, no LCL, no CAPE.");
    if (modelCape != null) notes.push("Model CAPE is the run's own field. Trust that one.");
    if (obs && obs.levels && obs.levels.length > 4) {
      const when = obs.time ? new Date(obs.time).toUTCString().replace(/^\w+, /, "").replace(":00 GMT", "Z") : "";
      const st = obs.station || {};
      notes.unshift(`Ascent from ${st.name || st.id || "the nearest station"}${st.distance_km != null ? `, ${Math.round(st.distance_km)} km` : ""}, ${when}. White is temperature, dashed blue is dew point. Orange and green are the model.`);
    }
    const caption = notes.join(" ");
    ctx.fillStyle = P.dim; ctx.font = `500 9px ${P.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    const short = prof.hasDewAloft ? "T (orange), Td (green), parcel (dashed), barbs in kt"
                                   : "T (orange), surface Td (green dot), parcel (dashed), barbs in kt — no dew-point profile aloft";
    ctx.fillText(short.slice(0, 116), F.left, F.h - 8);

    return { ok: true, caption, hasDewAloft: prof.hasDewAloft, levels: prof.env.length,
             surface: { p: prof.psfc, t: prof.sfc.t, td: prof.sfc.td, elevation_m: prof.elev },
             freezing_m: fzM, freezing_hpa: fz ? Math.round(fz.p) : null,
             lcl_hpa: par ? Math.round(par.lcl.p) : null, cape_est: par ? Math.round(par.cape) : null,
             cin_est: par && par.cin != null ? Math.round(par.cin) : null,
             cape_model: modelCape == null ? null : Math.round(modelCape) };
  }

  window.WXSounding = { draw };
})();
