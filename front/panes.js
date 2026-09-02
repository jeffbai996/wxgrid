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
    const c = cloud == null ? 0 : cloud, wet = precip > 0.2;
    const snow = tK != null && tK - K < 1 && wet, cloudy = c > 0.25 || wet;
    const cx = cloudy ? 15 : 23, cy = cloudy ? 15 : 23;
    const rays = [0,45,90,135,180,225,270,315].map((a) => `<line x1="${cx+11.5*Math.cos(a*Math.PI/180)}" y1="${cy+11.5*Math.sin(a*Math.PI/180)}" x2="${cx+14*Math.cos(a*Math.PI/180)}" y2="${cy+14*Math.sin(a*Math.PI/180)}"/>`).join("");
    const body = night
      ? `<path d="M${cx+5} ${cy-9}a10 10 0 1 0 4 17 9 9 0 0 1-4-17z" fill="#d9e2f0" stroke="#f2f6ff" stroke-width="1"/>`
      : `<circle cx="${cx}" cy="${cy}" r="8" fill="#ffd166"/><g stroke="#ffd166" stroke-width="2" stroke-linecap="round">${rays}</g>`;
    const cl = cloudy ? `<g><path d="M10 31h24.5a7 7 0 0 0 .4-14 10 10 0 0 0-18.7-2.5A8.5 8.5 0 0 0 10 31z" fill="rgba(224,231,241,${0.62 + 0.35 * Math.max(c, 0.35)})" stroke="rgba(255,255,255,.32)" stroke-width="1.2"/><path d="M13 29.5h20" stroke="rgba(167,181,200,.45)" stroke-width="1" stroke-linecap="round"/></g>` : "";
    const flakes = [16,24,32].map((x) => `<g transform="translate(${x} 39)" stroke="#dfe8ff" stroke-width="1.4" stroke-linecap="round"><path d="M-2.5 0h5M0-2.5v5M-1.8-1.8l3.6 3.6M1.8-1.8l-3.6 3.6"/></g>`).join("");
    const rn = wet ? (snow ? flakes : `<path d="M17 35l-2 4M25 35l-2 4M33 35l-2 4" stroke="#69b9ff" stroke-width="2.4" stroke-linecap="round"/>`) : "";
    return `<svg class="glyph" viewBox="0 0 46 46" aria-hidden="true">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  };
  W_ICONS = { rise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4-4-4 4M16 18a4 4 0 0 0-8 0"/></svg>',
              set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/></svg>',
              day: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>' };

  // A short written forecast built from the series. Rules only: every sentence
  // is read off the numbers, nothing is invented, and missing inputs simply
  // remove that sentence. This deliberately reads like a weather report, not
  // a row of database tags joined with middle dots.
  // The story of the next two days, one tagged sentence per thing — now, rain,
  // wind, temp, sky, fog, uv. The hero and the Outdoors verdict both read it
  // and pick their sentences, so the two never disagree.
  function story(d, sel) {
    // Anchored at now, not at the step being scrubbed. The numbers above it
    // follow the slider; this line is the standing answer to "what is coming",
    // and it rewriting itself every time you dragged the tape made it useless
    // as either.
    const s = d.series, U = W().units, at = (k) => new Date(d.valid[k]);
    const nowMs = Date.now();
    let i = d.valid.findIndex((v) => new Date(v).getTime() >= nowMs);
    if (i < 0) i = Math.min(sel, d.valid.length - 1);
    // The hour where the weather is, not where the browser is.
    const hourFmt = new Intl.DateTimeFormat("en-CA", U.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    const stamp = (dt) => { const o = {}; for (const x of hourFmt.formatToParts(dt)) o[x.type] = x.value;
      return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; };
    const clock = (dt) => U.time(dt).replace(":00", "");
    const partOf = (h) => (h < 6 ? "overnight" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night");
    // People say "tomorrow morning", not "Thu 08:00". Inside ten hours the
    // clock is more use than the word, so that is what it gives.
    const when = (k) => {
      const hrs = (at(k) - at(i)) / 3600e3;
      if (hrs <= 1.5) return "now";
      if (hrs <= 10) return `around ${clock(at(k))}`;
      const here = stamp(at(i)), there = stamp(at(k));
      const days = Math.round((new Date(there.day) - new Date(here.day)) / 86400e3);
      const part = partOf(there.hour);
      if (days <= 0) return part === "night" ? "tonight" : part === "overnight" ? "overnight" : `this ${part}`;
      if (days === 1) return part === "overnight" ? "overnight" : `tomorrow ${part}`;
      const wd = at(k).toLocaleDateString(undefined, U.timeOpts({ weekday: "long" }));
      return `${wd} ${part === "overnight" ? "night" : part}`;
    };

    const step = (d.steps[i + 1] || d.steps[i] + 3) - d.steps[i];
    const end = Math.min(d.steps.length - 1, i + Math.ceil(48 / step));
    const idx = Array.from({ length: end - i + 1 }, (_, k) => i + k);
    const val = (name, k) => (s[name] && s[name][k] != null ? s[name][k] : null);
    const rainAt = (k) => val("tp6", k) || 0, snowAt = (k) => val("sf6", k) || 0;
    const amountAt = (k) => rainAt(k) + snowAt(k);
    const wet = (k) => amountAt(k) > 0.2;
    const wetSteps = idx.filter(wet), damp = idx.filter((k) => amountAt(k) > 0.01);
    const parts = [];
    const say = (k, t) => parts.push({ k, t });

    // What it is doing right now: the sky, the temperature, and how it feels
    // if that differs enough to be worth a coat.
    const t0 = val("t2m", i), cc = val("tcc", i), w0 = val("wind", i), dp = val("d2m", i);
    const feelsAt = (k) => {
      const c = val("t2m", k) == null ? null : val("t2m", k) - 273.15, w = val("wind", k), dew = val("d2m", k);
      if (c == null) return null;
      if (w != null && c <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * c - 11.37 * v + 0.3965 * c * v; }
      if (dew != null && c >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / dew)); return c + 0.5555 * (e - 10); }
      return c;
    };
    if (t0 != null) {
      const sky = cc == null ? "" : cc > 0.85 ? "Overcast" : cc > 0.6 ? "Mostly cloudy" : cc > 0.3 ? "Partly cloudy" : "Clear";
      const feels = feelsAt(i), gap = Math.round(feels) - Math.round(t0 - 273.15);
      const felt = Math.abs(gap) >= 2 ? `, feels like ${U.tempC(feels).txt}` : "";
      // the character word a person would use before any number: muggy is the
      // dew point talking, crisp is a cold clear morning
      const tc = t0 - 273.15, dpc = dp != null ? dp - 273.15 : null;
      const character = dpc != null && dpc >= 18 && tc >= 22 ? "muggy"
        : tc <= 0 ? "cold" : tc <= 6 && (cc == null || cc < 0.4) ? "crisp"
        : tc >= 30 ? "hot" : "";
      say("now", sky ? `${sky}${character ? ` and ${character}` : ""} at ${U.temp(t0).txt}${felt}.` : `${U.temp(t0).txt} right now${felt}.`);
    }

    // Precipitation, and — when the wind belongs to the same weather — the
    // gusts in the same breath, because that is one event, not two.
    const gusts = (s.gust || s.wind || []).slice(i, end + 1).map((v, k) => [v, i + k]).filter(([v]) => v != null);
    const peak = gusts.length ? gusts.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
    const windy = peak && peak[0] * 3.6 >= 35;
    const fromDir = () => (peak && s.wdir && s.wdir[peak[1]] != null ? ` from the ${compass(s.wdir[peak[1]])}` : "");
    const gustPhrase = () => `${s.gust ? "gusting" : "winds"} to ${Math.round(W().speed(peak[0]))} ${W().speedUnit()}${fromDir()}`;
    let windSaid = false;
    if (s.tp6 || s.sf6) {
      const total = idx.reduce((a, k) => a + amountAt(k), 0);
      const much = total >= 1 ? `, ${U.precip(total).txt} of it` : "";
      if (wet(i)) {
        let k = i; while (k <= end && wet(k)) k++;
        const snow = snowAt(i) > rainAt(i), what = snow ? "Snow" : "Rain";
        const withWind = windy && peak[1] <= k ? `, ${gustPhrase()}` : "";
        if (withWind) windSaid = true;
        say("rain", k > end ? `${what} right through${much}${withWind}.` : `${what} easing ${when(k)}${much}${withWind}.`);
      } else if (wetSteps.length) {
        const first = wetSteps[0], snow = snowAt(first) > rainAt(first);
        const scattered = wetSteps.length <= Math.max(2, Math.ceil(idx.length * 0.35));
        say("rain", scattered ? `Mostly dry, ${snow ? "a little snow" : "a few showers"} ${when(first)}.`
                            : `Dry until ${when(first)}, then ${snow ? "snow moves in" : "rain moves in"}${much}.`);
      } else if (damp.length) {
        say("rain", `Dry, give or take ${snowAt(damp[0]) > rainAt(damp[0]) ? "a flurry" : "a stray shower"}.`);
      } else {
        say("rain", (at(end) - at(i)) / 3600e3 >= 36 ? "Nothing falling for the next couple of days." : "Nothing falling through tomorrow.");
      }
    }
    if (windy && !windSaid) {
      const kmh = peak[0] * 3.6;
      say("wind", `${kmh >= 75 ? "Very windy" : kmh >= 55 ? "Windy" : "Breezy"}, ${gustPhrase()}${peak[1] > i + 1 ? ` ${when(peak[1])}` : ""}.`);
    }

    // Where the temperature goes, said once, with the time it gets there.
    if (s.t2m && t0 != null) {
      const vals = idx.map((k) => [val("t2m", k), k]).filter(([v]) => v != null);
      if (vals.length > 2) {
        const hi = vals.reduce((a, b) => (b[0] > a[0] ? b : a)), lo = vals.reduce((a, b) => (b[0] < a[0] ? b : a));
        const freezes = lo[0] - 273.15 <= 0 && t0 - 273.15 > 0;
        if (freezes) say("temp", `Below freezing ${when(lo[1])}.`);
        else if (hi[0] - t0 > 3) {
          const hic = hi[0] - 273.15;
          say("temp", `${hic >= 30 ? "Hot" : hic >= 24 ? "Warming up" : "Milder"} ${when(hi[1])}, up to ${U.temp(hi[0]).txt}.`);
        } else if (t0 - lo[0] > 3) say("temp", `Cooling to ${U.temp(lo[0]).txt} ${when(lo[1])}.`);
      }
    }

    // Where the sky is going: the sentence people actually want from a
    // forecast — clearing, or clouding over, and when.
    if (s.tcc && cc != null) {
      const half = idx[Math.floor(idx.length / 2)];
      const later = idx.slice(idx.indexOf(half)).map((k) => val("tcc", k)).filter((v) => v != null);
      const cc2 = later.length ? later.reduce((a, b) => a + b, 0) / later.length : null;
      if (cc2 != null && cc2 - cc > 0.35) say("sky", `Clouding over ${when(half)}.`);
      else if (cc2 != null && cc - cc2 > 0.35) say("sky", `Clearing ${when(half)}.`);
    }
    // Two warnings nothing else carries.
    if (dp != null && t0 != null && t0 - dp < 1 && (w0 == null || w0 * 3.6 < 12)) say("fog", "Air is sitting at its dew point, so expect fog.");
    let uvK = null; for (const k of idx) if (val("uvi", k) != null && (uvK == null || val("uvi", k) > val("uvi", uvK))) uvK = k;
    if (uvK != null && val("uvi", uvK) >= 3) say("uv", `${val("uvi", uvK) >= 8 ? "Strong sun, " : ""}UV ${Math.round(val("uvi", uvK))} at its peak ${when(uvK)}.`);
    // the wind when it is not part of the rain: the Outdoors verdict wants
    // it even when it is only a breeze
    if (peak && !windy) say("breeze", peak[0] * 3.6 >= 15 ? `Breezy at times, ${gustPhrase()}${peak[1] > i + 1 ? ` ${when(peak[1])}` : ""}.` : "Light winds throughout.");
    return parts;
  }
  // The hero's line: what it is like now, then up to four of the story.
  function summarise(d, sel) {
    const parts = story(d, sel);
    const HERO = ["rain", "wind", "temp", "sky", "fog"];
    const lead = parts.filter((p) => p.k === "now").map((p) => p.t);
    const rest = parts.filter((p) => HERO.includes(p.k) || (p.k === "uv" && /Strong sun/.test(p.t))).map((p) => p.t);
    return [...lead, ...rest.slice(0, 4)].join(" ");
  }

  // Two readings that only mean anything at sea. Both are the scales a mariner
  // actually uses, not a restatement of the numbers already on the card.
  const BEAUFORT = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const BEAUFORT_NAME = ["calm", "light air", "light breeze", "gentle breeze", "moderate breeze",
    "fresh breeze", "strong breeze", "near gale", "gale", "strong gale", "storm", "violent storm", "hurricane"];
  const beaufort = (ms) => { let f = 0; while (f < BEAUFORT.length && ms >= BEAUFORT[f]) f++; return f; };
  const DOUGLAS = [0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14];
  const DOUGLAS_NAME = ["calm", "rippled", "smooth", "slight", "moderate", "rough", "very rough", "high", "phenomenal"];
  const douglas = (m) => { let d = 0; while (d < DOUGLAS.length && m >= DOUGLAS[d]) d++; return d; };

  // METAR shorthand, spelled out. FU is smoke, BR is mist, VV is a vertical
  // visibility because the sky is not visible at all — none of it guessable,
  // so every token carries its meaning in a tooltip.
  const METAR_WORDS = {
    "-": "light", "+": "heavy", VC: "in the vicinity",
    MI: "shallow", PR: "partial", BC: "patches of", DR: "low drifting", BL: "blowing",
    SH: "showers of", TS: "thunderstorm", FZ: "freezing",
    DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals",
    PL: "ice pellets", GR: "hail", GS: "small hail", UP: "unknown precipitation",
    BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "widespread dust",
    SA: "sand", HZ: "haze", PY: "spray",
    PO: "dust whirls", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm",
    SKC: "sky clear", CLR: "clear below 12 000 ft", NSC: "no significant cloud", NCD: "no cloud detected",
    FEW: "few, 1–2 eighths", SCT: "scattered, 3–4 eighths", BKN: "broken, 5–7 eighths", OVC: "overcast, 8 eighths",
    VV: "vertical visibility, sky obscured", CB: "cumulonimbus", TCU: "towering cumulus",
  };
  // A token is an optional intensity, then two-letter pairs: -SHRA is light
  // showers of rain. Cloud groups are three letters and a height.
  function metarGloss(token) {
    const t = String(token || "").toUpperCase();
    const cloud = t.match(/^(SKC|CLR|NSC|NCD|FEW|SCT|BKN|OVC|VV)(\d{2,3})?(CB|TCU)?/);
    if (cloud) {
      const parts = [METAR_WORDS[cloud[1]]];
      if (cloud[2]) parts.push(`at ${Number(cloud[2]) * 100} ft`);
      if (cloud[3]) parts.push(METAR_WORDS[cloud[3]]);
      return parts.filter(Boolean).join(" ");
    }
    const words = [];
    let rest = t;
    if (rest[0] === "-" || rest[0] === "+") { words.push(METAR_WORDS[rest[0]]); rest = rest.slice(1); }
    if (rest.startsWith("VC")) { words.push(METAR_WORDS.VC); rest = rest.slice(2); }
    while (rest.length >= 2) { const w = METAR_WORDS[rest.slice(0, 2)]; if (!w) break; words.push(w); rest = rest.slice(2); }
    return words.length ? words.join(" ") : "";
  }
  const metarAbbr = (str) => String(str || "").split(/\s+/).filter(Boolean).map((tok) => {
    const gloss = metarGloss(tok);
    return gloss ? `<abbr title="${esc(gloss)}">${esc(tok)}</abbr>` : esc(tok);
  }).join(" ");

  // ── The tide card (Outdoors) ───────────────────────────────────────────
  // The stations hand back turns only — high, low, high — so the water between
  // them is drawn as a half-cosine from one turn to the next, which is the
  // shape a semi-diurnal tide really has and the rule the pocket tables use.
  // The chart earns its axes: heights on the left in the user's unit against
  // the station datum, days and noons along the bottom, a bar at the card's
  // time. Turn heights sit in bands above and below the water so they can
  // never collide with it. Shown only inside the same 40 km the coast
  // readings use: a station 60 km up a strait is not this beach's tide.
  function tideCard(pt) {
    const t = pt && pt.tides;
    if (!t || !t.events || t.events.length < 2 || t.distance_km == null || t.distance_km > 40) return "";
    const U = W().units, unit = U.altUnit;
    const ev = t.events.map((e) => ({ x: new Date(e.time).getTime(), y: e.height_m, type: e.type })).sort((a, b) => a.x - b.x);
    const x0 = ev[0].x, x1 = ev[ev.length - 1].x, span = Math.max(x1 - x0, 1);
    const ys = ev.map((e) => e.y), lo = Math.min(...ys), hi = Math.max(...ys), rng = Math.max(hi - lo, 0.2);
    const X = (x) => (x - x0) / span * 100, Y = (y) => 100 - (y - lo) / rng * 100;
    const between = (a, b, x) => a.y + (b.y - a.y) * (1 - Math.cos(Math.PI * (x - a.x) / (b.x - a.x))) / 2;
    const pts = [];
    for (let k = 0; k + 1 < ev.length; k++)
      for (let q = 0; q < 16; q++) { const x = ev[k].x + (ev[k + 1].x - ev[k].x) * q / 16; pts.push(`${X(x).toFixed(2)},${Y(between(ev[k], ev[k + 1], x)).toFixed(2)}`); }
    pts.push(`100,${Y(ev[ev.length - 1].y).toFixed(2)}`);
    const now = W().validDate.getTime();
    let hNow = null, rising = null;
    for (let k = 0; k + 1 < ev.length; k++)
      if (now >= ev[k].x && now <= ev[k + 1].x) { hNow = between(ev[k], ev[k + 1], now); rising = ev[k + 1].y > ev[k].y; break; }
    const next = ev.find((e) => e.x > now);
    const edge = (x) => x < 6 ? " l" : x > 94 ? " r" : "";
    const labels = ev.map((e) => `<i class="tl ${e.type}${edge(X(e.x))}" style="left:${X(e.x).toFixed(1)}%">${U.alt(e.y, 1).v}</i>`).join("");
    // The card's time is a ring on the water, not a bar across it; a second
    // ring follows the pointer and says the time and height under it.
    const marker = hNow != null ? `<i class="tdot now" style="left:${X(now).toFixed(1)}%;top:${Y(hNow).toFixed(1)}%"></i>` : "";
    const probe = `<i class="tdot hov" hidden></i><s class="tlab" hidden></s>`;
    const evData = esc(JSON.stringify(ev.map((e) => [e.x, e.y])));
    // the datum line, when it is inside the range (a negative low sits under it)
    const datum = lo < 0 && hi > 0 ? `<i class="tzero" style="top:${Y(0).toFixed(1)}%"></i>` : "";
    // x axis: every local midnight is a day, every local noon a tick
    const hourOf = new Intl.DateTimeFormat("en-US", U.timeOpts({ hour: "2-digit", hour12: false }));
    const xt = [];
    for (let x = Math.ceil(x0 / 3600e3) * 3600e3; x <= x1; x += 3600e3) {
      const h = hourOf.format(new Date(x)).replace("24", "00");
      if (h === "00") xt.push(`<i class="day" style="left:${X(x).toFixed(1)}%">${new Date(x).toLocaleDateString(undefined, U.timeOpts({ weekday: "short" }))}</i>`);
      else if (h === "12") xt.push(`<i style="left:${X(x).toFixed(1)}%">noon</i>`);
    }
    const dt = next ? next.x - now : 0, inTxt = dt > 0 ? (dt < 3600e3 ? `${Math.round(dt / 60e3)} min` : `${Math.floor(dt / 3600e3)}h${String(Math.round(dt % 3600e3 / 60e3)).padStart(2, "0")}`) : "";
    const readout = hNow != null
      ? `<div class="tide-now">
          <span class="tnum"><b>${U.alt(hNow, 1).v}</b><i>${unit}</i></span>
          <span class="tdir ${rising ? "up" : "dn"}">${rising ? "↗ rising" : "↘ falling"}</span>
          ${next ? `<span class="tnext"><b class="${next.type}">${next.type === "H" ? "▲" : "▼"} ${U.alt(next.y, 1).v} ${unit}</b><em>${U.time(new Date(next.x))}${inTxt ? ` · ${inTxt}` : ""}</em></span>` : ""}
        </div>`
      : "";
    return `<div class="tide-card">${readout}
      <div class="tide-plot">
        <div class="tide-y"><i>${U.alt(hi, 1).v}</i><i>${U.alt(lo, 1).v}</i><u>${unit}</u></div>
        <div class="tide-area" data-ev="${evData}" data-lo="${lo}" data-rng="${rng}">${nightBands(x0, x1, X)}<div class="tide-water"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,100 ${pts.join(" ")} 100,100"/><polyline points="${pts.join(" ")}"/></svg>${datum}${marker}${probe}</div>${labels}</div>
      </div>
      <div class="tide-x">${xt.join("")}</div>
    </div>`;
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
    if (s.wind) {
      // The wind box carries the story, not just the number: a compass rose
      // with the arrow on it and the bearing in degrees, the Beaufort word,
      // the next 24 h of speed as a curve, and the gusts with how gusty they
      // are relative to the mean (Jeff 2026-09-02: "a bit sparse").
      const w = s.wind[i], dir = s.wdir ? s.wdir[i] : null, g = s.gust ? s.gust[i] : null;
      const bf = w != null ? beaufort(w) : null;
      const win = [], gwin = [];
      for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) { if (s.wind[k] != null) win.push(s.wind[k]); if (s.gust && s.gust[k] != null) gwin.push(s.gust[k]); }
      let spark = "";
      if (win.length >= 3) {
        const top = Math.max(1, ...win, ...gwin);
        const pts = (arr) => arr.map((v, k) => `${(k / (arr.length - 1) * 100).toFixed(1)},${(22 - v / top * 20).toFixed(1)}`).join(" ");
        spark = `<svg class="wspark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
          ${gwin.length === win.length ? `<polyline class="g" points="${pts(gwin)}"/>` : ""}
          <polygon class="a" points="0,24 ${pts(win)} 100,24"/><polyline class="w" points="${pts(win)}"/></svg>`;
      }
      const peakG = gwin.length ? Math.max(...gwin) : null;
      const rose = `<span class="wind-rose" style="--rot:${dir == null ? 0 : (dir + 180) % 360}deg" title="${dir == null ? "" : `from ${Math.round(dir)}°`}">
        <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/><path class="n" d="M20 3v4"/><path d="M37 20h-4M20 37v-4M3 20h4"/>
        <g class="ar"><path d="M20 9l5 12-5-3-5 3z"/><path d="M20 18v13"/></g></svg><i>N</i></span>`;
      chips.push(`<span class="wind-readout" style="--wind-color:${windColor(w || 0)}">
        ${rose}
        <span class="wind-main"><small>Wind ${compass(dir)}${dir != null ? ` <em>${Math.round(dir)}°</em>` : ""}</small><b>${f(w, (v) => speed(v).toFixed(0))} <i>${speedUnit()}</i></b>${bf != null ? `<em>F${bf} · ${BEAUFORT_NAME[bf]}</em>` : ""}</span>
        <span class="wind-trend">${spark}<small>next 24 h${peakG != null ? ` · gusts to ${speed(peakG).toFixed(0)}` : ""}</small></span>
        ${g != null ? `<span class="wind-gust"><small>Gusts</small><b>${speed(g).toFixed(0)} <i>${speedUnit()}</i></b>${w > 0.5 ? `<em>×${(g / w).toFixed(1)} gust factor</em>` : ""}</span>` : ""}
        <span class="wind-storm" id="storm-slot"></span>
      </span>`);
    }
    // Which readings are worth the space depends on where the pin landed. A
    // snow depth of zero in August tells you nothing; wave height does, if you
    // clicked the sea. So: a value that is only news when it is non-zero stays
    // hidden at zero, and the marine readings lead over water while the
    // land-only ones step aside.
    const sea = !!(pt.local && pt.local.place && pt.local.place.water);
    const marine = [], normal = [];
    // One shape for every reading, the wind box's shape: a small label over
    // the number, unit in the numeral face, the colour as a tint and a ring.
    // Pills read as tags; a grid of these reads as an instrument panel
    // (Jeff 2026-09-02: "think of something better to replace the pills").
    const stat = (k, v, unit, color, extra = "", title = "") =>
      `<div class="stat" style="--c:${color}"${title ? ` title="${title}"` : ""}><small>${k}</small><b>${v}${unit ? `<i>${unit}</i>` : ""}</b>${extra}</div>`;
    if (sea && s.wind && s.wind[i] != null) { const bf = beaufort(s.wind[i]);
      marine.push(stat("Beaufort", bf, BEAUFORT_NAME[bf], "#8ec5f0")); }
    if (sea && s.swh && s.swh[i] != null) { const ds = douglas(s.swh[i]);
      marine.push(stat("Sea state", ds, DOUGLAS_NAME[ds], "#7dd3fc")); }
    if (s.swh && s.swh[i] != null) marine.push(stat("Waves", W().units.alt(s.swh[i], 1).v, W().units.altUnit, "#7dd3fc",
      `<em>${s.mwp && s.mwp[i] != null ? `${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` ${arrow((s.mwd[i] + 180) % 360)}` : ""}</em>`));
    if (s.tp6 && s.tp6[i] > 0.05) normal.push(stat("Rain 6 h", W().units.precip(s.tp6[i]).v, W().units.precipUnit, "var(--rain)"));
    // Chance, from the GEFS members, whichever model the card is reading:
    // the max over the next 24 h from the selected time, only when it says
    // something (a 3 % chance is not a pill).
    const chance = probMax(pt, d, i, "prob_rain", 24);
    if (chance != null && chance >= 10) normal.push(stat("Rain chance", chance, "%", "#71b8ff", "", "Share of the 30 GEFS members giving rain in the next 24 h"));
    const gustChance = probMax(pt, d, i, "prob_gust", 24);
    if (gustChance != null && gustChance >= 20) normal.push(stat("Gale chance", gustChance, "%", "#ffb454", "", "Share of members with gusts over 50 km/h in the next 24 h"));
    if (s.sf6 && s.sf6[i] > 0.05) normal.push(stat("New snow", W().units.snow(s.sf6[i]).v, W().units.snowUnit, "#cfe8ff"));
    if (!sea && s.sd_cm && s.sd_cm[i] >= 0.5) normal.push(stat("Snow depth", W().units.snow(s.sd_cm[i]).v, W().units.snowUnit, "#9fd3ff"));
    // 24 h totals and changes, from the step after this one to +24 h
    const ahead = (arr) => { const out = []; for (let k = i + 1; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) if (arr[k] != null) out.push(arr[k]); return out; };
    if (s.tp6) { const r24 = ahead(s.tp6).reduce((a, b) => a + b, 0); if (r24 >= 0.5) normal.push(stat("Rain 24 h", W().units.precip(r24).v, W().units.precipUnit, "#5aa9ff")); }
    if (s.tcc && s.tcc[i] != null) normal.push(stat("Cloud", (s.tcc[i] * 100).toFixed(0), "%", "#9fb0c8"));
    if (s.t2m && s.d2m && s.t2m[i] != null && s.d2m[i] != null) {
      const rh = Math.round(100 * Math.exp(17.625 * (s.d2m[i] - K) / (243.04 + s.d2m[i] - K)) / Math.exp(17.625 * (s.t2m[i] - K) / (243.04 + s.t2m[i] - K)));
      normal.push(stat("Humidity", rh, "%", rh >= 90 ? "#7cc4ff" : rh <= 30 ? "#ffb454" : "#7fd8e8"));
    }
    { const uv = uvNow(d, i); if (uv && uv.uvi >= 1) normal.push(stat(uv.peak ? "UV peak" : "UV index", uv.uvi.toFixed(0), "", uv.uvi >= 8 ? "var(--bad)" : uv.uvi >= 6 ? "#ff8a3d" : uv.uvi >= 3 ? "#ffd166" : "#78d39a")); }
    if (s.vis && s.vis[i] != null) normal.push(stat("Visibility", W().units.dist(s.vis[i] / 1000, s.vis[i] < 5000 ? 1 : 0).v, W().units.dist(1).unit, s.vis[i] > 9000 ? "#78d39a" : s.vis[i] > 3000 ? "#ffd166" : "var(--bad)"));
    if (s.t2m && s.t2m[i] != null) { const k24 = d.steps.findIndex((h, k) => k > i && h >= d.steps[i] + 24); const t24 = k24 > 0 ? s.t2m[k24] : null;
      if (t24 != null && Math.abs(t24 - s.t2m[i]) >= 1.5) { const dT = W().units.tempDelta(t24 - s.t2m[i]); normal.push(stat("24 h change", `${dT > 0 ? "+" : "−"}${Math.abs(dT).toFixed(0)}°`, "", dT > 0 ? "#ff8a3d" : "#6cb6ff")); } }
    if (s.d2m) normal.push(stat("Dew point", `${f(s.d2m[i], (v) => W().units.temp(v).v)}°`, "", "#6cd7c4"));
    // Pressure with its direction: the number alone says nothing, the trend is
    // the whole reason a barometer is on the wall.
    if (s.msl) {
      const later = s.msl[Math.min(i + Math.max(1, Math.round(6 / stepHrs(d, i))), s.msl.length - 1)];
      const dP = later != null && s.msl[i] != null ? (later - s.msl[i]) / 100 : 0;
      const trend = Math.abs(dP) < 1 ? "" : dP > 0 ? " ↗" : " ↘";
      // the glass as a curve, not just an arrow: 24 h of pressure in a
      // 44px sparkline drawn inline, scaled to its own min-max
      const win = []; for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) if (s.msl[k] != null) win.push(s.msl[k]);
      let spark = "";
      if (win.length >= 4) {
        const mn = Math.min(...win), mx = Math.max(...win), span = Math.max(mx - mn, 60);
        const pts = win.map((v, k) => `${(k / (win.length - 1) * 44).toFixed(1)},${(11 - (v - mn) / span * 10).toFixed(1)}`).join(" ");
        spark = `<svg class="pspark" viewBox="0 0 44 12" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
      }
      normal.push(stat("Pressure", f(s.msl[i], (v) => W().units.press(v).v), W().units.pressUnit + trend, "#b7a6f0", spark));
    }
    // What it feels like, when that is not what the thermometer says.
    if (t != null) {
      const c = t - K, w = s.wind ? s.wind[i] : null, dpK = s.d2m ? s.d2m[i] : null;
      let feels = c;
      if (w != null && c <= 10 && w * 3.6 >= 4.8) { const q = Math.pow(w * 3.6, 0.16); feels = 13.12 + 0.6215 * c - 11.37 * q + 0.3965 * c * q; }
      else if (dpK != null && c >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / dpK)); feels = c + 0.5555 * (e - 10); }
      if (Math.abs(Math.round(feels) - Math.round(c)) >= 2)
        normal.push(stat("Feels like", `${W().units.tempC(feels).v}°`, "", tempColor(feels)));
    }
    // Cloud base from the temperature/dew-point spread: ~125 m per °C. Only
    // worth saying when there is cloud to have a base.
    if (!sea && s.tcc && s.tcc[i] > 0.2 && s.d2m && s.d2m[i] != null && t != null) {
      const spread = (t - s.d2m[i]);
      if (spread > 0.3 && spread < 25) normal.push(stat("Cloud base ≈", W().units.alt(Math.round(spread * 125 / 50) * 50).v, W().units.altUnit, "#a9c4d8"));
    }
    if (s.cape && s.cape[i] >= 100) normal.push(stat("CAPE", s.cape[i].toFixed(0), "J/kg", s.cape[i] > 1000 ? "var(--bad)" : "var(--warm)"));
    const freezing = d.derived && d.derived.freezing_level_m && d.derived.freezing_level_m[i];
    if (!sea && freezing != null) normal.push(stat("Freezing lvl", W().units.alt(freezing).v, W().units.altUnit, "#7fd8e8"));
    chips.push(...(sea ? [...marine, ...normal] : [...normal, ...marine]));
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    const moon = moonPhase(W().validDate);
    $("#point-now").innerHTML = `<div class="hero">
        ${bigGlyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), t, night)}
        <div class="big" style="color:${t != null ? tempColor(t - K) : "inherit"}">${t == null ? "—" : W().units.temp(t).v}<span class="deg">°</span></div>
        <div class="hl">
          ${hi != null ? `<div class="hilo"><span class="hi"><i>high</i>${W().units.tempC(hi).v}°</span><span class="rule"></span><span class="lo"><i>low</i>${W().units.tempC(lo).v}°</span></div>` : ""}
          ${sun ? `<div class="sun"><span>${W_ICONS.rise}${sun.rise}</span><span>${W_ICONS.set}${sun.set}</span><i class="brk" aria-hidden="true"></i>${sun.len ? `<span class="len" title="Daylight">${W_ICONS.day || ""}${sun.len}</span>` : ""}<span class="moon" title="${moon.name}, ${moon.pct}% lit">${moon.glyph} ${moon.pct}%</span></div>` : ""}
        </div>
      </div>
      ${(() => { const t = summarise(d, i); return t ? `<p class="summary"><i>next 48 h</i>${t}${window.WXStatic ? "" : `<button class="why-btn" id="why-btn">Discussion ›</button>`}</p><div id="why" class="why" hidden></div>` : ""; })()}
      <div class="meta">${chips.join("")}</div>
      ${contextCues(pt, d, i)}
      ${daysStrip(pt, d, i)}
      ${contextCards(pt, d, i)}
      ${window.WXStatic ? "" : `<div id="cams-slot" class="cams" hidden></div>`}
      ${alertsHtml(pt)}${airHtml(pt)}`;
    fetchNearStorm(pt);
    fetchCams(pt);
    // local context
    const loc = pt.local || {};
    const bits = [];
    // Join only the parts that exist. A country with no region above it used to
    // print a leading "· SE" — a separator dangling off nothing.
    const where = [];
    if (loc.place && loc.place.name && loc.place.name !== pt.name) where.push(`<b>${esc(loc.place.name)}</b>${loc.place.region ? ", " + esc(loc.place.region) : ""}`);
    else if (loc.place && loc.place.region) where.push(esc(loc.place.region));
    if (loc.place && loc.place.country) where.push(esc(loc.place.country));
    if (where.length) bits.push(`<span class="loc">${where.join(" · ")}</span>`);
    if (loc.elevation_m != null) bits.push(`<span>elev <b>${W().units.alt(loc.elevation_m).txt}</b></span>`);
    if (W().units.followsPoint && loc.timezone && loc.timezone.abbr) bits.push(`<span>${esc(loc.timezone.abbr)}</span>`);
    // the title already carries the coordinates when there is no place name —
    // don't print them twice
    const coords = W().fmtCoords(pt.lat, pt.lon);
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
      // Station first, because that is the subject; the pill sits on its line
      // instead of drifting to the end of a wrap; time and distance are the
      // caveat under it, not part of the title.
      obsHtml = `<div class="obs">
        <div class="obs-head"><span class="stn"><b>${esc(o.station)}</b>${o.name ? `<span class="nm">${esc(o.name)}</span>` : ""}</span>${o.flight_category ? `<span class="fc ${esc(o.flight_category)}">${esc(o.flight_category)}</span>` : ""}</div>
        <div class="obs-when">Observed <b>${tm ? W().units.time(tm) : "—"}</b>${obsDist ? `<span>${obsDist} away</span>` : ""}</div>
        <div class="obs-vals">${[
          o.temp_c != null ? `<b style="color:${tempColor(o.temp_c)}">${W().units.tempC(o.temp_c).v}°</b><u>${W().units.tempUnit.replace("°", "")}</u>` : "",
          o.dewpoint_c != null ? `<i>dew</i><b>${W().units.tempC(o.dewpoint_c).v}°</b>` : "",
          o.wspd_kt != null ? `<b>${speed(o.wspd_kt / 1.943844).toFixed(0)}</b><u>${speedUnit()}</u>${o.wdir != null && o.wdir !== 0 ? `<i>@</i><b>${String(o.wdir).padStart(3, "0")}°</b>` : `<i>calm</i>`}${o.wgst_kt ? `<i>gusts</i><b>${speed(o.wgst_kt / 1.943844).toFixed(0)}</b>` : ""}` : "",
          obsVis ? `<i>vis</i><b>${obsVis}</b>` : "",
          o.altim_hpa != null ? `<i>QNH</i><b>${W().units.press(o.altim_hpa * 100).v}</b><u>${W().units.pressUnit}</u>` : "",
          cl ? `<span class="codes">${metarAbbr(cl)}</span>` : "",
          o.wx ? `<span class="codes">${metarAbbr(o.wx)}</span>` : "",
        ].filter(Boolean).map((h) => `<span>${h}</span>`).join("")}</div>
        <div class="raw">${esc(o.raw || "")}</div></div>`;
    }
    let holder = $("#obs-holder");
    if (!holder) { holder = document.createElement("div"); holder.id = "obs-holder"; $("#point-now").after(holder); }
    holder.innerHTML = obsHtml;
    drawMeteogram(d, i);
  }

  // One cell per local calendar day. A short physics run hands only this strip
  // to AI-GFS after its last complete day; the primary series and every other
  // pane remain the model the user selected.
  // Max of a probability series over the `hours` after the card's selected
  // valid time. The probabilities live on the GEFS run's own clock, which is
  // not the viewed model's clock, so match by time and not by index.
  function probMax(pt, d, i, key, hours) {
    const p = pt && pt.prob; if (!p || !p.series[key] || !d.valid[i]) return null;
    const t0 = new Date(d.valid[i]).getTime(), t1 = t0 + hours * 3600e3;
    let best = null;
    p.valid.forEach((iso, k) => {
      const t = new Date(iso).getTime(), v = p.series[key][k];
      if (t > t0 && t <= t1 && v != null && (best === null || v > best)) best = v;
    });
    return best === null ? null : Math.round(best);
  }

  // Moon phase from the synodic month: age in days since a known new moon.
  // A tenth of a day of error is a sliver of shading nobody can see.
  function moonPhase(date) {
    const synodic = 29.530588853;
    const age = (((date - new Date(Date.UTC(2000, 0, 6, 18, 14))) / 86400e3) % synodic + synodic) % synodic;
    const pct = Math.round((1 - Math.cos(2 * Math.PI * age / synodic)) / 2 * 100);
    const k = Math.round(age / synodic * 8) % 8;
    return { pct,
      glyph: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"][k],
      name: ["new moon", "waxing crescent", "first quarter", "waxing gibbous",
             "full moon", "waning gibbous", "last quarter", "waning crescent"][k] };
  }

  // The discussion: which system is driving and why — fetched on the first
  // ask, cached on the point, plain sentences from the server's field brain.
  function wireWhy(pt) {
    const btn = $("#why-btn"), box = $("#why");
    if (!btn || !box) return;
    btn.onclick = async () => {
      if (!box.hidden) { box.hidden = true; btn.textContent = "Discussion ›"; return; }
      btn.textContent = "…";
      try {
        if (!pt.why) pt.why = await W().api(`${W().API}/discussion?lat=${pt.lat.toFixed(2)}&lon=${W().wlon(pt.lon).toFixed(2)}&model=${W().state.model}`);
        box.innerHTML = pt.why.paras.map((p) => `<p>${esc(p)}</p>`).join("") || "<p>Nothing notable driving the weather here right now.</p>";
        box.hidden = false; btn.textContent = "Discussion ˅";
      } catch (e) { btn.textContent = "Discussion ›"; W().fn.toast("Discussion unavailable", 3000, "error"); }
    };
  }

  function daysStrip(pt, d, i) {
    const s = d.series; if (!s.t2m) return "";
    const primaryModel = d.model || W().state.model;
    const days = new Map();
    const addDays = (src, model, ai, after = -Infinity, exclude = new Set()) => {
      if (!src || !src.series || !src.series.t2m) return;
      src.valid.forEach((v, k) => {
        const dt = new Date(v), key = dt.toDateString();
        if (dt.getTime() <= after || exclude.has(key)) return;
        if (!days.has(key)) days.set(key, { dt, ks: [], src, model, ai });
        days.get(key).ks.push(k);
      });
    };
    addDays(d, primaryModel, false);
    const primaryKeys = new Set(days.keys());
    const primaryEnd = Math.max(...d.valid.map((v) => new Date(v).getTime()));
    if (pt.ai && pt.ai.model === "aigfs") addDays(pt.ai, "aigfs", true, primaryEnd, primaryKeys);
    const cur = new Date(d.valid[i]).toDateString();
    const usable = [...days.values()].filter(({ src, ks }) => ks.filter((k) => src.series.t2m[k] != null).length >= 2).slice(0, 16);
    const cells = usable.map(({ dt, ks, src, model, ai }) => {
      const s = src.series;
      const ts = ks.map((k) => s.t2m[k]).filter((x) => x != null);
      const hi = Math.max(...ts) - K, lo = Math.min(...ts) - K;
      const rain = ks.reduce((a, k) => a + ((s.tp6 && s.tp6[k]) || 0), 0), snow = ks.reduce((a, k) => a + ((s.sf6 && s.sf6[k]) || 0), 0);
      const wmax = s.wind ? Math.max(...ks.map((k) => s.wind[k] || 0)) : null;
      const noon = ks.reduce((b, k) => Math.abs(new Date(src.valid[k]).getHours() - 13) < Math.abs(new Date(src.valid[b]).getHours() - 13) ? k : b, ks[0]);
      const cloud = ks.map((k) => s.tcc ? s.tcc[k] : null).filter((x) => x != null); const cl = cloud.length ? cloud.reduce((a, b) => a + b, 0) / cloud.length : null;
      const g = W().tape && W().tape.glyph ? W().tape.glyph(cl, (rain + snow) / Math.max(1, ks.length) * (24 / 6), s.t2m[noon], false) : "";
      const on = model === primaryModel && dt.toDateString() === cur;
      const wet = snow >= 1 ? `<span class="sn">${W().units.snow(snow).txt}</span>` : rain >= 0.5 ? W().units.precip(rain).txt : "";
      return `<button class="day${on ? " on" : ""}${ai ? " ai" : ""}" data-k="${noon}" data-model="${model}" data-valid="${src.valid[noon]}" title="${dt.toDateString()}${ai ? " · NOAA AI-GFS" : ""}">
        <span class="dn">${dt.toLocaleDateString(undefined, { weekday: "short" })}${ai ? `<i>AI</i>` : ""}</span>
        <span class="dg">${g}</span>
        <span class="hl"><b style="color:${tempColor(hi)}">${W().units.tempC(hi).v}°</b><i>${W().units.tempC(lo).v}°</i></span>
        <span class="pr">${wet || "&nbsp;"}</span>
        ${wmax != null ? `<span class="wd" style="background:${W().rampColor("wind", wmax, 0.55)}">${Math.round(W().speed(wmax))}<em>${W().speedUnit()}</em></span>` : ""}</button>`;
    }).join("");
    setTimeout(() => { wireWhy(pt); }, 0);
    setTimeout(() => document.querySelectorAll(".days .day").forEach((b) => b.onclick = () => {
      if (b.dataset.model !== W().state.model) W().fn.jumpModelTime(b.dataset.model, b.dataset.valid);
      else W().setStep(Number(b.dataset.k));
      // the tape follows the day: scroll its selected column into the middle
      setTimeout(() => { const on = document.querySelector("#tape td.on"); if (on) on.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }); }, 60);
    }), 0);
    const extended = usable.filter((x) => x.ai);
    let note = "";
    if (extended.length) {
      const first = extended[0].dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      note = `<div class="days-note"><b>AI-GFS</b> generated forecast from ${first}</div>`;
    }
    return `<i class="kicker">week ahead</i><div class="days${usable.length > 8 ? " extended" : ""}">${cells}</div>${note}`;
  }

  const AQI_BANDS = [[50, "Good", "#2f9e44"], [100, "Moderate", "#e6b800"], [150, "Unhealthy for sensitive", "#f08c00"], [200, "Unhealthy", "#e03131"], [300, "Very unhealthy", "#9c36b5"], [9999, "Hazardous", "#7f1d1d"]];
  const aqiBand = (v) => AQI_BANDS.find((b) => v <= b[0]) || AQI_BANDS[AQI_BANDS.length - 1];
  const uvBand = (v) => v < 3 ? ["Low", "#2f9e44"] : v < 6 ? ["Moderate", "#e6b800"] : v < 8 ? ["High", "#f08c00"] : v < 11 ? ["Very high", "#e03131"] : ["Extreme", "#9c36b5"];
  function airHtml(pt) {
    const a = pt.air;
    if (!a || [a.us_aqi, a.eu_aqi, a.pm2_5, a.pm10, a.ozone, a.no2, a.uv, a.uv_clear].every((v) => v == null)) return "";
    const b = a.us_aqi != null ? aqiBand(a.us_aqi) : null;
    const uvValues = a.hourly && a.hourly.uv ? a.hourly.uv.slice(0, 24).filter((x) => x != null) : [];
    const uvMax = uvValues.length ? Math.max(...uvValues) : null;
    const uvb = uvMax != null ? uvBand(uvMax) : null;
    return `<div class="air">${b ? `<span class="chipv" style="background:${b[2]}22;color:${b[2]}"><i class="sw" style="background:${b[2]}"></i>US AQI <b>${a.us_aqi}</b> ${b[1]}</span>` : ""}
      ${a.eu_aqi != null ? `<span class="chipv" style="color:#8fd6a8">EU AQI <b>${a.eu_aqi}</b></span>` : ""}
      ${a.pm2_5 != null ? `<span class="chipv" style="color:#e0b57a">PM2.5 <b>${a.pm2_5.toFixed(0)}</b> µg/m³</span>` : ""}${a.pm10 != null ? `<span class="chipv" style="color:#d8a06a">PM10 <b>${a.pm10.toFixed(0)}</b> µg/m³</span>` : ""}
      ${a.ozone != null ? `<span class="chipv" style="color:#8ec7f0">O₃ <b>${a.ozone.toFixed(0)}</b> µg/m³</span>` : ""}${a.no2 != null ? `<span class="chipv" style="color:#d79ac0">NO₂ <b>${a.no2.toFixed(0)}</b> µg/m³</span>` : ""}
      ${a.uv != null ? `<span class="chipv" style="color:#f0c46a">UV now <b>${a.uv.toFixed(1)}</b></span>` : ""}${a.uv_clear != null ? `<span class="chipv" style="color:#f0c46a">clear-sky UV <b>${a.uv_clear.toFixed(1)}</b></span>` : ""}
      ${uvb ? `<span class="chipv" style="color:${uvb[1]}">UV max <b>${uvMax.toFixed(0)}</b> ${uvb[0]}</span>` : ""}</div>`;
  }
  // An alert opens where its text is: in the card. Only the services that
  // publish a readable page get a link out; the ones that publish an API
  // document used to send the reader to raw CAP JSON.
  function alertsHtml(pt) {
    const al = pt.alerts; if (!al || !al.length) return "";
    // The CAP headline restates the event name, both timestamps and the
    // office in one breathless sentence — everything it says is already on
    // the card in structured form, so it stays out of the summary.
    const fmtT = (d) => d.toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }));
    const when = (a) => { const o = a.onset ? new Date(a.onset) : null, e = a.ends ? new Date(a.ends) : null;
      return o && e ? `${fmtT(o)} → ${fmtT(e)}` : e ? `until ${fmtT(e)}` : ""; };
    // who issued it, as a compact monogram (real marks are trademarks; the
    // private theme can dress this up the way it does the provider badge)
    const AGENCY = { NWS: ["NWS", "#1a5fb4"], EC: ["ECCC", "#c8102e"], ECCC: ["ECCC", "#c8102e"],
                     MeteoAlarm: ["EU", "#e8850c"], BoM: ["BOM", "#00205b"], BOM: ["BOM", "#00205b"] };
    const agency = (a) => AGENCY[a.source] || (a.source ? [a.source, "var(--dim)"] : null);
    const head = (a) => { const ag = agency(a);
      return `<span class="al-row"><i class="dot"></i><b>${esc(a.event)}</b>${a.severity ? `<em class="sev">${esc(a.severity)}</em>` : ""}</span>
      <span class="al-meta">${ag ? `<i class="al-ag" style="--ag:${ag[1]}">${esc(ag[0])}</i>` : ""}${[when(a), a.sender || (a.area || "").slice(0, 60)].filter(Boolean).map(esc).join(" · ")}</span>`; };
    const body = (a) => {
      const now = Date.now();
      const o = a.onset ? new Date(a.onset).getTime() : null, e = a.ends ? new Date(a.ends).getTime() : null;
      const left = e && e > now ? (e - now < 3600e3 ? `ends in ${Math.max(1, Math.round((e - now) / 60e3))} min` : `ends in ${Math.round((e - now) / 3600e3)} h`) : e ? "expired" : "";
      const frac = o && e && e > o ? Math.min(1, Math.max(0, (now - o) / (e - o))) : null;
      const pills = [a.severity, a.urgency, a.certainty].filter(Boolean)
        .map((x) => `<i class="al-pill">${esc(x)}</i>`).join("");
      const areas = (a.area || "").split(";").map((x) => x.trim()).filter(Boolean).slice(0, 8)
        .map((x) => `<i class="al-area">${esc(x)}</i>`).join("");
      const desc = (a.description || "").trim();
      const instr = (a.instruction || "").trim();
      return `<div class="alert-x">
        <div class="al-pills">${pills}${left ? `<i class="al-pill al-left">${left}</i>` : ""}</div>
        ${frac != null ? `<div class="al-line" title="how far through its window this alert is"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>` : ""}
        ${areas ? `<div class="al-areas">${areas}</div>` : ""}
        ${desc ? `<div class="alert-text selectable">${esc(desc)}</div>` : ""}
        ${instr ? `<div class="al-instr"><b>What to do</b><div class="alert-text selectable">${esc(instr)}</div></div>` : ""}
      </div>`;
    };
    return `<div class="alerts">${al.slice(0, 3).map((a) => (a.url
      ? `<a class="alert" href="${esc(a.url)}" target="_blank" rel="noopener" style="--al:${esc(a.color)}">${head(a)}</a>`
      : `<details class="alert" style="--al:${esc(a.color)}"><summary>${head(a)}</summary>${body(a)}</details>`)).join("")}${al.length > 3 ? `<div class="note">+${al.length - 3} more</div>` : ""}</div>`;
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
    return { rise: fmt(r), set: fmt(s), riseUtc: r, setUtc: s,
             len: `${Math.floor(len)}h${String(Math.round((len % 1) * 60)).padStart(2, "0")}` };
  }

  // ── context modules ───────────────────────────────────────────────────
  // The card used to show the same blocks in Reykjavík in February and on a
  // Queensland beach in January. These decide from geography, season and the
  // data actually present whether a block has anything to say; one that does
  // not apply renders nothing at all, which is the whole contract.
  //
  // The local winter half-year: November to March north of the equator, May to
  // September south of it. Blunt on purpose — it gates whole modules, and a
  // fortnight either way changes nothing.
  const isWinterHalf = (lat, date) => { const m = date.getMonth(); return lat >= 0 ? (m >= 10 || m <= 2) : (m >= 4 && m <= 8); };
  const HIGH_LAT = 55;
  const SKI_LAT = 33;                  // winter tab shown poleward of this, any season

  // Near the coast? Two cheap signals, both already on the card. Marine fields
  // are NaN over land, so a wave height or a sea-surface temperature at this
  // gridpoint puts the sea within a cell — about 28 km at 0.25°. A tide
  // station within 40 km says the same thing where the model's marine mask is
  // too coarse to reach the shore. Neither is a coastline: a beach the wave
  // grid misses and no gauge watches simply gets no module, which is the right
  // way to be wrong here.
  const marineHere = (s, i) => (!!(s.swh && s.swh[i] != null)) || (!!(s.sst && s.sst[i] != null));
  // The server's nearest-water probe (derived.coast) is the answer where the
  // gridpoint is not: it walks out over the model's own land/sea mask and
  // brings the sea state back, so a promenade three kilometres inland reads
  // as coastal instead of as farmland. 40 km is the same reach the tide
  // station uses, and about a cell and a half of the grid it came off.
  const COAST_KM = 40;
  const coastOf = (d) => (d && d.derived && d.derived.coast) || null;
  const coastNear = (d) => { const c = coastOf(d); return c && c.distance_km != null && c.distance_km <= COAST_KM ? c : null; };
  const nearCoast = (pt, d, i) => marineHere(d.series, i) || !!coastNear(d)
    || !!(pt.tides && pt.tides.distance_km != null && pt.tides.distance_km <= 40);
  const onLand = (pt) => !(pt.local && pt.local.place && pt.local.place.water);

  // A marine value at this step: the pin's own gridpoint first, the water the
  // probe found second. `here` says which, so the card can admit it.
  function seaVal(d, i, key) {
    const s = d.series;
    if (s[key] && s[key][i] != null) return { v: s[key][i], here: true };
    const c = coastNear(d);
    if (c && c[key] && c[key][i] != null) return { v: c[key][i], here: false, at: c };
    return null;
  }

  // Next turn of the tide after the time the card is showing.
  function nextTide(pt) {
    if (!pt || !pt.tides || !pt.tides.events) return null;
    const t = W().validDate.getTime();
    return pt.tides.events.find((e) => new Date(e.time).getTime() > t) || null;
  }

  // Can it snow here at all? The model's own snow answers first; failing that,
  // a run that reaches freezing does; failing that, latitude or altitude in
  // the winter half-year. Summer at sea level in Lisbon answers no.
  function canSnow(pt, d) {
    const s = (d && d.series) || {};
    if (s.sf6 && s.sf6.some((v) => v != null && v > 0.5)) return true;
    if (s.sd_cm && s.sd_cm.some((v) => v != null && v > 1)) return true;
    if (s.t2m && s.t2m.some((v) => v != null && v < K + 1)) return true;
    // Winter-sport country stays a winter place all year: the tab is where
    // the snow depth, freezing level and resort bands live even when this
    // week's forecast is dry (Jeff 2026-09-02, snow-forecast.com as the
    // model). Latitude 33° reaches the Andes, Japan and the Rockies' south;
    // 1000 m catches the lower resorts inside that.
    const elev = (pt.local && pt.local.elevation_m) || 0;
    return Math.abs(pt.lat) >= SKI_LAT || elev >= 1000;
  }

  // Minutes of unprotected sun before a fair skin burns. One UV index unit is
  // 25 mW/m² of erythemally weighted irradiance and a type-II minimal
  // erythemal dose is about 250 J/m², so the time is 250/(uvi · 0.025) seconds.
  const burnMinutes = (uvi) => Math.round(250 / (uvi * 0.025) / 60);

  // The UV worth quoting: what it is now, or — once the sun is down — the peak
  // the rest of this local day will reach, which is the number you plan around.
  function uvNow(d, i) {
    const s = d.series;
    if (!s.uvi) return null;
    const v = s.uvi[i];
    if (v != null && v >= 1) return { uvi: v, peak: false };
    const day = new Date(d.valid[i]).toDateString();
    const vals = d.valid.map((iso, k) => (new Date(iso).toDateString() === day && s.uvi[k] != null ? s.uvi[k] : null)).filter((x) => x != null);
    if (!vals.length) return null;
    const hi = Math.max(...vals);
    return hi >= 1 ? { uvi: hi, peak: true } : null;
  }

  // Beach: a coastal point, warm enough to be in the water, outside a
  // high-latitude winter. Sea temperature leads when the model carries one
  // (GFS does, the ECMWF open set does not); otherwise the air temperature
  // stands in, which is what you feel on the sand anyway.
  function beachModule(pt, d, i) {
    const s = d.series;
    if (!nearCoast(pt, d, i) || !onLand(pt)) return "";
    if (Math.abs(pt.lat) >= HIGH_LAT && isWinterHalf(pt.lat, W().validDate)) return "";
    const sea = seaVal(d, i, "sst");
    const sst = sea ? sea.v - K : null;
    const air = s.t2m && s.t2m[i] != null ? s.t2m[i] - K : null;
    if (sst != null ? sst < 16 : !(air != null && air >= 18)) return "";
    const U = W().units;
    const stats = [];
    if (sst != null) stats.push(`<div><small>Water</small><b>${U.tempC(sst).v}<i>${esc(U.tempUnit)}</i></b></div>`);
    const swh = seaVal(d, i, "swh"), mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd");
    if (swh) {
      const wv = U.alt(swh.v, 1);
      // mwd is the direction the swell comes FROM, the way wind is quoted
      const note = [mwd ? `from ${compass(mwd.v)}` : "", mwp ? `${mwp.v.toFixed(0)} s` : ""].filter(Boolean).join(" · ");
      stats.push(`<div><small>Waves</small><b>${wv.v}<i>${esc(U.altUnit)}</i></b>${note ? `<em>${esc(note)}</em>` : ""}</div>`);
    }
    const tide = nextTide(pt);
    if (tide) stats.push(`<div><small>Next ${tide.type === "H" ? "high" : "low"}</small><b>${esc(U.time(tide.time))}</b><em>${esc(U.alt(tide.height_m, 1).txt)}</em></div>`);
    const uv = uvNow(d, i);
    if (uv) stats.push(`<div><small>UV${uv.peak ? " peak" : ""}</small><b>${uv.uvi.toFixed(0)}</b><em>burn in ~${burnMinutes(uv.uvi)} min</em></div>`);
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    if (sun) stats.push(`<div><small>Sunset</small><b>${esc(sun.set)}</b></div>`);
    if (stats.length < 2) return "";
    // Where the sea state came from, when it did not come from here: the
    // numbers are the water's, not the sand's, and the card says so.
    const off = [sea, swh, mwp, mwd].find((x) => x && x.here === false);
    const note = off ? `sea ${esc(U.dist(off.at.distance_km).txt)} ${esc(off.at.compass || "")}`.trim()
      : sst == null ? "no sea temperature here" : "";
    return `<div class="modcard beach"><div class="mod-head"><span>Beach</span>${note ? `<span class="dim">${note}</span>` : ""}</div>
      <div class="mod-stats">${stats.join("")}</div></div>`;
  }

  // Stargazing: the coming night is clear and the moon is out of the way
  // enough to be worth saying. 21:00 to 05:00 in the clock the card is using.
  function stargazeCue(pt, d, i) {
    const s = d.series;
    if (!s.tcc) return "";
    const t0 = new Date(d.valid[i]).getTime();
    const night = [];
    d.valid.forEach((iso, k) => {
      const dt = new Date(iso), t = dt.getTime(), h = dt.getHours();
      if (t < t0 || t > t0 + 24 * 3600e3) return;
      if ((h >= 21 || h <= 4) && s.tcc[k] != null) night.push(s.tcc[k]);
    });
    if (night.length < 2 || Math.max(...night) > 0.2) return "";
    const moon = moonPhase(W().validDate);
    return `<span class="cue" style="--cue:#a9b8ff"><b>Good stargazing tonight</b><span>${moon.glyph} moon ${moon.pct}% ${esc(moon.name)}</span></span>`;
  }

  // Surf and kite: a swell worth riding under a wind steady enough to hold a
  // kite. 15–30 kt is the window; below it nothing pulls, above it nothing is
  // fun.
  function surfCue(pt, d, i) {
    const s = d.series;
    const swh = seaVal(d, i, "swh");
    if (!swh || swh.v < 1) return "";
    const w = s.wind ? s.wind[i] : null;
    if (w == null || w < 7.72 || w > 15.43) return "";
    const U = W().units, { speed, speedUnit } = W();
    const wv = U.alt(swh.v, 1);
    const mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd");
    const per = mwp ? ` @ ${mwp.v.toFixed(0)} s` : "";
    // swell direction is the direction it comes FROM: onshore or off is the
    // whole question, and a bare 290° does not answer it
    const from = mwd ? `${compass(mwd.v)} swell · ` : "";
    return `<span class="cue" style="--cue:#4fc3d9"><b>Surf and kite window</b><span>${from}${wv.v} ${esc(U.altUnit)}${per} · ${speed(w).toFixed(0)} ${esc(speedUnit())}</span></span>`;
  }

  // What the point card shows beyond the standard blocks: cue pills first,
  // then the cards. Both are empty strings when nothing applies.
  function contextCues(pt, d, i) {
    const cues = [stargazeCue(pt, d, i), surfCue(pt, d, i)].filter(Boolean);
    return cues.length ? `<div class="cues">${cues.join("")}</div>` : "";
  }
  function contextCards(pt, d, i) {
    return [beachModule(pt, d, i)].filter(Boolean).join("");
  }

  // ── Aloft ─────────────────────────────────────────────────────────────
  function renderAloft(d, i) {
    const { speed, speedUnit, f, arrowRot, LEVEL_FT, LEVEL_M } = W();
    const rows = (d.levels || []).slice().sort((a, b) => b - a).map((lvl) => {
      const a = d.aloft[String(lvl)];
      const gh = a.gh && a.gh[i] != null ? a.gh[i] : null;
      return `<tr><td class="lvl">${lvl} <i class="u">hPa</i></td><td>${gh != null ? W().units.alt(gh).txt : (W().units.altUnit === "ft" ? LEVEL_FT[lvl] : LEVEL_M[lvl])}</td>
        <td class="dir">${a.wdir[i] != null ? `<i style="${arrowRot(a.wdir[i])}"></i>${String(a.wdir[i]).padStart(3, "0")}°` : "—"}</td>
        <td><span class="wchip" style="background:${windColor(a.wind[i] || 0)}">${f(a.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}</td>
        <td class="tempc" style="color:${a.temp[i] != null ? tempColor(a.temp[i] - K) : "inherit"}">${f(a.temp[i], (v) => W().units.temp(v).v)}°</td></tr>`;
    }).join("");
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const sfc = s.wind ? `<tr><td class="mono">sfc</td><td>${W().units.alt(10).txt}</td><td class="dir">${s.wdir[i] != null ? `<i style="${arrowRot(s.wdir[i])}"></i>${String(s.wdir[i]).padStart(3, "0")}°` : "—"}</td><td><span class="wchip" style="background:${windColor(s.wind[i] || 0)}">${f(s.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}${s.gust ? ` <span class="dim">gusts ${f(s.gust[i], (v) => speed(v).toFixed(0))}</span>` : ""}</td><td class="tempc" style="color:${s.t2m && s.t2m[i] != null ? tempColor(s.t2m[i] - K) : "inherit"}">${f(s.t2m && s.t2m[i], (v) => W().units.temp(v).v)}°</td></tr>` : "";
    $("#aloft").innerHTML = `<table class="aloft"><thead><tr><th>Level</th><th>Height</th><th>Dir</th><th>Speed</th><th>Temp</th></tr></thead><tbody>${rows}${sfc}</tbody></table>
      ${statCards([
        ["Freezing level", fl != null ? W().units.alt(fl).txt : (d.levels && d.levels.length ? "below 925 hPa or above 250" : "—"), "", "flake"],
        ["Total cloud", f(s.tcc && s.tcc[i], (v) => (v * 100).toFixed(0) + "%"), "", "cloud", s.tcc && s.tcc[i] != null ? s.tcc[i] : null],
        ["CAPE", `${f(s.cape && s.cape[i], (v) => v.toFixed(0) + " J/kg")}${s.cape ? "" : " <span class=dim>(model has none)</span>"}`, capeClass(s.cape && s.cape[i]), "bolt"],
        ["QNH (MSL)", f(s.msl && s.msl[i], (v) => W().units.press(v, W().units.pressUnit === "hPa" ? 1 : undefined).txt), "", "baro"],
        ["Dew point spread", s.d2m && s.t2m && s.t2m[i] != null && s.d2m[i] != null ? W().units.tempDelta(s.t2m[i] - s.d2m[i]).toFixed(1) + " " + W().units.tempUnit : "—", "", "drop"],
      ], "aloft-kv")}
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
  // ── the elevation board ───────────────────────────────────────────────
  // Bands down, time across. A 0.25° gridpoint gives one number for a valley
  // and the ridge above it; /api/profile interpolates the column, so each band
  // can report what actually falls at ITS height. That difference — 20 cm on
  // top, a wet afternoon at the car park — is the entire reason this view
  // exists. Morning / afternoon / night, the way a mountain forecast reads.
  const BOARD_SLOTS = 18;                       // six days of morning/afternoon/night

  function bandBuckets(valid) {
    const fmt = new Intl.DateTimeFormat("en-CA", W().units.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    const part = (dt) => { const o = {}; for (const x of fmt.formatToParts(dt)) o[x.type] = x.value;
      return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; };
    const out = [];
    valid.forEach((iso, i) => {
      const dt = new Date(iso), hour = part(dt).hour;
      // The small hours belong to the night that started the evening before —
      // otherwise every day opens and closes with a "night" column and reads
      // like two nights.
      const day = part(new Date(dt.getTime() - 6 * 3600e3)).day;
      const slot = hour < 6 ? "night" : hour < 12 ? "AM" : hour < 18 ? "PM" : "night";
      const key = `${day}#${slot}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.idx.push(i);
      else out.push({ key, day, slot, date: dt, idx: [i] });
    });
    // Six days is a forecast; ten is a horoscope. Start at the column that
    // holds now and stop there.
    const now = Date.now();
    let from = out.findIndex((b) => new Date(valid[b.idx[b.idx.length - 1]]).getTime() >= now);
    if (from < 0) from = 0;
    return out.slice(from, from + BOARD_SLOTS);
  }

  function bandTable(prof, bands) {
    if (!prof || !prof.valid || !prof.bands || !prof.bands.length) return "";
    const U = W().units, speed = W().speed, unit = W().speedUnit();
    const buckets = bandBuckets(prof.valid);
    if (buckets.length < 3) return "";
    const days = [];
    buckets.forEach((b) => { const last = days[days.length - 1];
      if (last && last.day === b.day) last.span++; else days.push({ day: b.day, date: b.date, span: 1 }); });
    // A day that holds a single slot (the board's ragged edge) gets only its
    // weekday: "Wed 26" over one narrow column forces that column wide and
    // its cells lay out unlike every other column on the board.
    const dayRow = days.map((dy) => `<th colspan="${dy.span}" class="day">${dy.date.toLocaleDateString(undefined, U.timeOpts(dy.span === 1 ? { weekday: "short" } : { weekday: "short", day: "numeric" }))}</th>`).join("");
    const slotRow = buckets.map((b) => `<th class="slot ${b.slot === "night" ? "nite" : ""}">${b.slot}</th>`).join("");
    const total = (arr, ix) => ix.reduce((a, k) => a + ((arr && arr[k]) || 0), 0);
    const pick = (arr, ix, fn) => { const v = ix.map((k) => arr && arr[k]).filter((x) => x != null); return v.length ? fn(v) : null; };

    const rows = bands.map(([name, z]) => {
      // match by height, not by position: callers hand the bands over in the
      // order they want them drawn, which is not the order they were asked for
      const b = prof.bands.find((x) => Math.abs(x.elev_m - z) < 1);
      if (!b) return "";
      const cells = (cls, fn) => buckets.map((bu) => fn(bu)).map((c) => `<td class="${cls}">${c}</td>`).join("");
      // Below half a unit there is nothing to plan around; a rounded "0" in a
      // snow column is worse than an honest dot.
      const snowRow = cells("num", (bu) => { const v = total(b.snow_cm, bu.idx), u = U.snow(v, v < 5 ? 1 : 0);
        return Number(u.v) <= 0 ? '<span class="nil">·</span>' : `<span class="fall snow" style="--w:${Math.min(1, v / 20).toFixed(2)}">${u.v}</span>`; });
      const rainRow = cells("num", (bu) => { const v = total(b.rain_mm, bu.idx), u = U.precip(v, v < 5 ? 1 : 0);
        return Number(u.v) <= 0 ? '<span class="nil">·</span>' : `<span class="fall rain" style="--w:${Math.min(1, v / 12).toFixed(2)}">${u.v}</span>`; });
      const hiRow = cells("num", (bu) => { const v = pick(b.temp, bu.idx, (x) => Math.max(...x));
        return v == null ? "—" : `<b style="color:${tempColor(v - K)}">${U.temp(v).v}°</b>`; });
      const loRow = cells("num dimrow", (bu) => { const v = pick(b.temp, bu.idx, (x) => Math.min(...x));
        return v == null ? "—" : `${U.temp(v).v}°`; });
      const windRow = cells("num", (bu) => {
        const v = pick(b.wind, bu.idx, (x) => Math.max(...x));
        if (v == null) return "—";
        const k = bu.idx.reduce((best, q) => (b.wind[q] != null && (b.wind[best] == null || b.wind[q] > b.wind[best]) ? q : best), bu.idx[0]);
        const dir = b.wdir ? b.wdir[k] : null;
        return `<span class="wv" style="background:${W().rampColor("wind", v, 0.9)};color:${v * 3.6 > 45 ? "#160b03" : "var(--fg)"}">${Math.round(speed(v))}</span>${dir == null ? "" : `<i class="dirarrow" style="${W().arrowRot(dir)}"></i>`}`;
      });
      return `<tr class="bandrow"><th class="lab band" colspan="${buckets.length + 1}"><span>${esc(name)}</span><i>${U.alt(z).txt}</i></th></tr>
        <tr><th class="lab">Snow<small>${U.snowUnit}</small></th>${snowRow}</tr>
        <tr><th class="lab">Rain<small>${U.precipUnit}</small></th>${rainRow}</tr>
        <tr><th class="lab">High<small>${U.tempUnit}</small></th>${hiRow}</tr>
        <tr><th class="lab">Low<small>${U.tempUnit}</small></th>${loRow}</tr>
        <tr><th class="lab">Wind<small>${unit}</small></th>${windRow}</tr>`;
    }).join("");

    const flRow = prof.freezing_level_m ? `<tr class="frzrow"><th class="lab">Freezing lvl<small>${U.altUnit}</small></th>${buckets.map((bu) => {
      const v = pick(prof.freezing_level_m, bu.idx, (x) => x.reduce((a, c) => a + c, 0) / x.length);
      return `<td class="num">${v == null ? "—" : U.alt(Math.round(v / 50) * 50).v}</td>`; }).join("")}</tr>` : "";

    return `<div class="board"><table class="bandtape">
      <thead><tr><th class="lab corner"></th>${dayRow}</tr><tr><th class="lab corner"></th>${slotRow}</tr></thead>
      <tbody>${rows}${flRow}</tbody></table></div>`;
  }

  // A cyclone within reach of the pin earns a chip on the hero card: the
  // storm's name, its basin-correct category, range and bearing. Tapping it
  // turns the storms layer on and flies to the eye (Jeff 2026-08-21).
  // ── nearby webcams ─────────────────────────────────────────────────────
  // What the sky actually looks like from the nearest pass or shore road.
  // Public DOT cams today (DriveBC); more providers are a server-side list.
  // Fetched once per pin and slotted in, never re-rendered with the step:
  // the pictures do not change with the forecast hour.
  let camsFetch = 0;
  const camBust = () => Math.floor(Date.now() / 3e5);          // fresh still every 5 min, cached in between
  function fetchCams(pt) {
    if (window.WXStatic) return;
    const my = ++camsFetch;
    const paint = (cams) => {
      if (my !== camsFetch) return;
      const el = document.getElementById("cams-slot");
      if (!el) return;
      if (!cams || !cams.length) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = `<div class="cams-head"><small>Webcams nearby</small><span>${cams.length} · ${cams[0].provider}</span></div>
        <div class="cams-strip">${cams.map((c, k) => `<button class="cam${c.stale ? " stale" : ""}" data-cam="${k}" type="button" title="${esc(c.caption || c.name)}">
          <img src="${esc(c.image)}${c.image.includes("?") ? "&" : "?"}t=${camBust()}" alt="" loading="lazy">
          <span class="cam-name">${esc(c.name)}</span>
          <span class="cam-dist">${c.distance_km} km ${compass(c.bearing_deg)}${c.elevation_m != null ? ` · ${W().units.alt(c.elevation_m).v} ${W().units.altUnit}` : ""}</span>
        </button>`).join("")}</div>`;
      el.querySelectorAll(".cam").forEach((b) => b.onclick = () => openCam(cams[+b.dataset.cam]));
    };
    if (pt.cams) { paint(pt.cams); return; }
    W().api(`${W().API}/webcams?lat=${pt.lat.toFixed(3)}&lon=${pt.lon.toFixed(3)}&n=8`)
      .then((r) => { pt.cams = (r && r.cams) || []; paint(pt.cams); })
      .catch(() => { pt.cams = []; paint(pt.cams); });
  }
  function openCam(c) {
    let dlg = document.getElementById("cam-view");
    if (!dlg) {
      dlg = document.createElement("dialog"); dlg.id = "cam-view"; dlg.className = "cam-view";
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    }
    dlg.innerHTML = `<div class="cam-view-head"><b>${esc(c.name)}</b><span>${esc(c.caption || "")}</span><button class="icon" type="button" aria-label="Close">×</button></div>
      <img src="${esc(c.image)}${c.image.includes("?") ? "&" : "?"}t=${camBust()}" alt="${esc(c.name)}">
      <div class="cam-view-foot"><span>${c.updated ? `updated ${new Date(c.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ` : ""}${esc(c.credit)}</span><a href="${esc(c.page)}" target="_blank" rel="noopener">open at ${esc(c.provider)} ↗</a></div>`;
    dlg.querySelector("button.icon").onclick = () => dlg.close();
    dlg.showModal();
  }
  let stormFetch = 0;
  // The meteorological tropical-cyclone symbol, not an emoji: a core with
  // two trailing arms, drawn in whatever colour the category earned.
  // The NHC symbol proper: a solid ring and two tapered spiral arms, generated
  // as filled polygons (a stroked sketch read as a ring with stubs).
  // The NWS hurricane symbol: a disc with two sickle arms, hollow eye.
  // Same path as the map icon in overlays.js (CYCLONE_PATH); mirrored and
  // tilted so the arms trail anticlockwise like a northern-hemisphere storm
  // (Jeff 2026-08-22: "you drew it backwards").
  const CYCLONE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path transform="translate(12 12) rotate(55) scale(-1 1) translate(-12 -12)" d="M12.50 2.16A7.9 7.9 0 1 1 4.57 13.80A7.1 7.1 0 1 0 12.50 2.16ZM11.50 21.84A7.9 7.9 0 1 1 19.43 10.20A7.1 7.1 0 1 0 11.50 21.84ZM17.8 12A5.8 5.8 0 1 1 6.2 12A5.8 5.8 0 1 1 17.8 12ZM14.9 12A2.9 2.9 0 1 0 9.1 12A2.9 2.9 0 1 0 14.9 12Z"/></svg>`;
  W().CYCLONE_SVG = CYCLONE_SVG;
  // The storm list is the same for every render of the card; fetch it once
  // and keep it five minutes (seven identical requests per open, 2026-08-28).
  let stormMemo = { t: 0, p: null };
  const storms = () => { const now = Date.now(); if (!stormMemo.p || now - stormMemo.t > 300e3) stormMemo = { t: now, p: W().api(`${W().API}/storms`).catch((e) => { stormMemo.p = null; throw e; }) }; return stormMemo.p; };
  function fetchNearStorm(pt) {
    const my = ++stormFetch;
    storms().then((gj) => {
      if (my !== stormFetch) return;
      const el = document.getElementById("storm-slot");
      if (!el) return;
      const R = Math.PI / 180;
      let best = null;
      for (const f of gj.features || []) {
        if (f.properties.kind !== "current") continue;
        const [slon, slat] = f.geometry.coordinates;
        const km = 6371 * Math.acos(Math.min(1, Math.sin(pt.lat * R) * Math.sin(slat * R)
          + Math.cos(pt.lat * R) * Math.cos(slat * R) * Math.cos((pt.lon - slon) * R)));
        if (km <= 1200 && (!best || km < best.km)) best = { f, km, slon, slat };
      }
      if (!best) { el.innerHTML = ""; el.classList.remove("on"); return; }
      const p = best.f.properties;
      const brg = Math.round((Math.atan2(Math.sin((best.slon - pt.lon) * R) * Math.cos(best.slat * R),
        Math.cos(pt.lat * R) * Math.sin(best.slat * R) - Math.sin(pt.lat * R) * Math.cos(best.slat * R) * Math.cos((best.slon - pt.lon) * R)) / R + 360) % 360);
      const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(brg / 45) % 8];
      el.classList.add("on");
      el.style.color = p.category_color || "#ef786f";
      el.title = `${p.category_label || ""} — tap for the storm view`;
      // distance in the user's unit — aviation profile reads nm, not km
      const d = W().units.dist(Math.round(best.km / 10) * 10, 0);
      el.innerHTML = `<span class="ws-ico">${CYCLONE_SVG}${p.category ? `<span class="ws-cat" style="--cat:${p.category_color || "#ef786f"}">${esc(p.category)}</span>` : ""}</span><span class="ws-txt"><small>${esc((p.class || "").toUpperCase())}</small><b>${esc(p.name || "")}</b><em>${d.txt} ${dir}</em></span>`;
      el.onclick = () => {
        if (!W().state.storms) document.getElementById("storms-toggle").click();
        W().map.flyTo({ center: [best.slon, best.slat], zoom: Math.max(4.5, W().map.getZoom()), duration: 1400 });
        setTimeout(() => { if (W().openStormCard) W().openStormCard(best.f); }, 1500);
      };
    }).catch(() => {});
  }

  // The nearest ski area to this point, if one is close enough to be the same
  // weather. Asked once per point; `null` means there isn't one.
  function fetchNearestResort(pt) {
    pt.near = null;
    W().api(`${W().API}/resorts?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&limit=8`)
      .then((r) => {
        // Nearest is not best: a tube park sits 600 m from the mountain it is
        // parked on. Prefer a ski area the catalog knows the summit of.
        const list = (r.resorts || []).filter((x) => x.distance_km != null && x.distance_km <= 60);
        const near = list.find((x) => x.ele_summit_m) || list[0];
        pt.near = near || null;
        if (W().state.point === pt && W().state.tab === "winter") W().renderPoint();
      })
      .catch(() => {});
  }

  // The bands the board draws for a plain point: a nearby ski area's own
  // base/mid/summit when there is one, otherwise the point's elevation and two
  // steps above it. The offsets are stated on the card — a gridpoint has no
  // idea what the terrain around it does.
  function winterBands(pt) {
    const near = pt.near, base = near && near.ele_base_m, summit = near && near.ele_summit_m;
    if (near && base != null && summit != null && summit - base > 250) {
      return [["Summit", Math.round(summit)], ["Mid", Math.round((base + summit) / 2)], ["Base", Math.round(base)]];
    }
    const e = Math.round((pt.local && pt.local.elevation_m) || 0);
    return [["+900 m", e + 900], ["+450 m", e + 450], ["Here", e]];
  }

  function fetchWinterBands(pt) {
    const bands = winterBands(pt);
    pt.wbands = { loading: true, bands };
    W().api(`${W().API}/profile?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&model=${W().state.model}&elevs=${bands.map((b) => b[1]).join(",")}`)
      .then((r) => { pt.wbands.data = r; pt.wbands.loading = false; if (W().state.point === pt && W().state.tab === "winter") W().renderPoint(); })
      .catch(() => { pt.wbands.loading = false; pt.wbands.error = true; if (W().state.point === pt && W().state.tab === "winter") W().renderPoint(); });
  }

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
    // freezing level a day out: is the snow line coming down or going up
    const j24 = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const fl24 = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[j24] : null;
    const flTrend = fl != null && fl24 != null && Math.abs(fl24 - fl) > 150 ? (fl24 < fl ? " ↓" : " ↑") : "";
    const chance = probMax(pt, d, i, "prob_rain", 24);
    const sn24we = sumWindow(s.sf6, d.steps, i, 24);
    const powder = sn24we != null && sn24we * slr / 10 >= 15 && (w850 == null || speed(w850) < (W().state.units === "kt" ? 22 : W().state.units === "ms" ? 11 : 40));
    const rows = [
      ["New snow next 24 h", sn(24), ""],
      ["New snow next 48 h", sn(48), ""],
      ["New snow next 72 h", sn(72), ""],
      ["Snow depth (model)", s.sd_cm ? W().units.snow(s.sd_cm[i]).txt : "n/a", ""],
      ["Freezing level", fl != null ? `${W().units.alt(fl).txt}${flTrend}` : "—", flTrend === " ↓" ? "good" : ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ...(chance != null ? [["Precip chance 24 h", `${chance}% <span class="dim">of 30 members</span>`, ""]] : []),
      ["Ridge wind 850 / 700", `${f(w850, (v) => speed(v).toFixed(0))} / ${f(w700, (v) => speed(v).toFixed(0))} ${speedUnit()}`, w700 != null && speed(w700) > (W().state.units === "kt" ? 25 : W().state.units === "ms" ? 13 : 45) ? "bad" : w700 != null && speed(w700) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : 28) ? "meh" : "good"],
      ["Wind loading", w850 != null && speed(w850) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : W().state.units === "mph" ? 17 : 28) ? `${lee} aspects loading` : "light", w850 != null && speed(w850) > 15 ? "meh" : "good"],
      ["Rain on snow", rainOnSnow ? "yes, wet loading" : "no", rainOnSnow ? "bad" : "good"],
      ["Surface temp", t != null ? W().units.tempC(t).txt : "—", t != null && t > 0 && s.sd_cm && s.sd_cm[i] > 5 ? "meh" : ""],
    ];
    // The band-by-band read this pane cannot give — a 0.25° gridpoint is one
    // number for a valley and a ridge — already exists for ski areas. Put the
    // door to it here, where somebody looking at snow will find it.
    let resortHtml = "";
    if (pt.near === undefined) fetchNearestResort(pt);
    else if (pt.near) resortHtml = `<button class="resort-link" data-resort="${esc(pt.near.id)}">
      <span class="k">Elevation bands</span><span class="v">${esc(pt.near.name)}<i>${W().units.dist(pt.near.distance_km).txt} away</i></span></button>`;
    // The board: what falls at each height, morning by morning.
    if (pt.wbands === undefined && pt.near !== undefined && pt.local) fetchWinterBands(pt);
    const B = pt.wbands;
    const boardHtml = !B ? "" : B.error ? `<div class="note">Elevation bands unavailable.</div>`
      : B.data ? `<div class="board-head"><span>Elevation bands</span><span class="dim">${esc(B.bands[0][0])} → ${esc(B.bands[B.bands.length - 1][0])}</span></div>${bandTable(B.data, B.bands)}`
      : `<div class="note">Reading the column…</div>`;
    let avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span><span class="dim">loading…</span></div></div>`;
    if (pt.avy === false) avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span></div><div class="avy-note">No public forecast region covers this point (Avalanche Canada / avalanche.org).</div></div>`;
    else if (pt.avy) avyHtml = avyBlock(pt.avy, AVY_COLORS);
    else fetchAvy(pt);
    const powderHtml = powder ? `<div class="verdict good"><b>Powder morning shaping up</b><span class="dim">${W().units.snow(sn24we * slr / 10).txt} at ${slr}:1, ridge wind workable</span></div>` : "";
    // Touring: the four things a skinner checks before the car — new snow,
    // where the freezing level is going, which aspects the wind is loading,
    // and today's danger rating — on one card with one call.
    const touringHtml = (() => {
      const U = W().units;
      const newCm = sn24we == null ? null : sn24we * slr / 10;
      const avyDay = pt.avy && pt.avy.days && pt.avy.days[0];
      const lvl = avyDay ? Math.max(...["alp", "tln", "btl"].map((b) => (avyDay[b] && avyDay[b].level != null ? avyDay[b].level : -1))) : -1;
      const lvlName = ["Low", "Moderate", "Considerable", "High", "Extreme"][lvl] || null;
      const loading = w850 != null && speed(w850) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : W().state.units === "mph" ? 17 : 28);
      const worries = [];
      if (lvl >= 3) worries.push(`${lvlName.toLowerCase()} danger`);
      if (rainOnSnow) worries.push("rain on snow");
      if (loading) worries.push(`${lee} aspects loading`);
      if (flTrend === " ↑") worries.push("freezing level rising");
      const call = lvl >= 3 || rainOnSnow ? ["Stay low", "bad"] : lvl === 2 || loading ? ["Pick your aspects", "meh"] : ["Go touring", "good"];
      const stats = [
        `<div><small>New snow 24 h</small><b>${newCm == null ? "—" : U.snow(sn24we * slr / 10).v}<i>${esc(U.snowUnit)}</i></b><em>${newCm == null ? "" : `${slr}:1`}</em></div>`,
        `<div><small>Freezing level</small><b>${fl == null ? "—" : U.alt(Math.round(fl / 50) * 50).v}<i>${esc(U.altUnit)}</i></b><em>${flTrend === " ↓" ? "falling" : flTrend === " ↑" ? "rising" : "steady"}</em></div>`,
        `<div><small>Wind loading</small><b>${loading ? lee : "light"}</b><em>${w850 != null ? `<i class="lvl">850 hPa</i>${speed(w850).toFixed(0)} ${esc(speedUnit())}` : ""}</em></div>`,
        lvlName ? `<div><small>Danger</small><b class="avy-${lvl}">${lvlName}</b><em>${esc((avyDay.label || avyDay.date || "today").toString().slice(0, 9))}</em></div>` : "",
      ].filter(Boolean).join("");
      return `<div class="modcard touring ${call[1]}"><div class="mod-head"><span class="call">${call[0]}</span><span class="dim">${worries.length ? worries.join(" · ") : "nothing flagged"}</span></div><div class="mod-stats">${stats}</div></div>`;
    })();
    $("#winter").innerHTML = `${touringHtml}${powderHtml}${resortHtml}${boardHtml}<div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${avyHtml}
      <div class="note">Board: the model column interpolated to each height, so snow and rain are what falls THERE. Depth ratios come from the band temperature. Without a ski area nearby the bands are this point's elevation and 450/900 m above it — the gridpoint does not know what the terrain does. Snow depth is the model snowpack, not a station.</div>`;
    const link = $("#winter .resort-link");
    if (link) link.onclick = () => W().ov.selectResort(link.dataset.resort);
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
    const j24o = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const fl24o = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[j24o] : null;
    const flTrend = fl != null && fl24o != null && Math.abs(fl24o - fl) > 150 ? (fl24o < fl ? " ↓" : " ↑") : "";
    const chance = probMax(W().state.point, d, i, "prob_rain", 24);
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
      ["Freezing level", fl != null ? `${W().units.alt(fl).txt}${flTrend}` : "—", flTrend === " ↓" ? "good" : ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ...(chance != null ? [["Precip chance 24 h", `${chance}% <span class="dim">of 30 members</span>`, ""]] : []),
      ["Wind / gust", w != null ? `${speed(w).toFixed(0)}${g != null ? ` · gusts ${speed(g).toFixed(0)}` : ""} ${speedUnit()}` : "—", w == null ? "" : speed(w) < calm ? "good" : "meh"],
      ["Max gust 24 h", gustMax24 != null ? `${speed(gustMax24).toFixed(0)} ${speedUnit()}` : "—", gustMax24 == null ? "" : speed(gustMax24) < gusty ? "good" : "bad"],
      ["Feels like", chill != null ? `${W().units.tempC(chill).v}° (wind chill)` : humidex != null ? `${W().units.tempC(humidex).v}° (humidex)` : t != null ? `${W().units.tempC(t).v}°` : "—", (chill != null && chill < -10) || (humidex != null && humidex > 35) ? "bad" : ""],
      ["Cloud", cloud != null ? `${(cloud * 100).toFixed(0)}%` : "—", cloud == null ? "" : cloud < 0.3 ? "good" : ""],
      ["Thunder risk (CAPE)", s.cape && s.cape[i] != null ? `${s.cape[i].toFixed(0)} J/kg` : "n/a", capeClass(s.cape && s.cape[i])],
      ["UV index (model est.)", s.uvi && s.uvi[i] != null ? `${s.uvi[i].toFixed(0)} ${uvWord(s.uvi[i])}` : "—", s.uvi && s.uvi[i] != null ? (s.uvi[i] < 3 ? "good" : s.uvi[i] < 8 ? "meh" : "bad") : ""],
      ...(s.swh && s.swh[i] != null ? [["Sea state", `${W().units.alt(s.swh[i], 1).txt}${s.mwp && s.mwp[i] != null ? ` · ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` from ${Math.round(s.mwd[i])}°` : ""}`, s.swh[i] < 1 ? "good" : s.swh[i] < 2.5 ? "meh" : "bad"]] : []),
      ["Dry, calm hours (3 d)", dryH ? `${dryH} h of ${totH}` : "none", dryH > 36 ? "good" : dryH ? "meh" : "bad"],
      // cloud base from the dew-point spread: the number a pilot or a
      // view-hunter actually wants, ~125 m per °C of spread
      ["Cloud base (≈)", t != null && s.d2m && s.d2m[i] != null && cloud != null && cloud > 0.15
        ? W().units.alt(Math.round(125 * Math.max(0, t - (s.d2m[i] - K)) / 50) * 50).txt : "clear or n/a", ""],
      ...(s.vis && s.vis[i] != null ? [["Visibility", `${(s.vis[i] / 1000).toFixed(s.vis[i] < 5000 ? 1 : 0)} km`, s.vis[i] > 9000 ? "good" : s.vis[i] > 3000 ? "meh" : "bad"]] : []),
    ];
    // The verdict: the worst of the calls the rows already made, said once at
    // the top the way a partner would say it at the trailhead — and WHY, by
    // name. The old two-word verdict told nobody what to watch.
    const flagged = rows.filter((r) => r[2] === "bad" || r[2] === "meh");
    const worst = flagged.some((r) => r[2] === "bad") ? "bad" : flagged.length ? "meh" : "good";
    const nameOf = (r) => `${r[0].toLowerCase().replace(/ \(.*\)| 24 h| \/ gust|,.*/g, "")} ${r[1].replace(/<[^>]+>/g, "")}`;
    const why = flagged.filter((r) => r[2] === worst).slice(0, 3).map(nameOf).join(" · ");
    const verdict = worst === "bad" ? ["Rough out there", "bad"] : worst === "meh" ? ["Workable", "meh"] : ["Looks good", "good"];
    // The best window in the next 48 h: dry, calm and in daylight for 3 h+.
    // People do not plan around a table; they plan around "when".
    let winHtml = "";
    {
      const okAt = (k) => (s.tp6 ? (s.tp6[k] || 0) : 0) < 0.2 && (!s.wind || s.wind[k] == null || speed(s.wind[k]) < calm);
      let best = null, run = null;
      for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 48; k++) {
        const hr = new Date(d.valid[k]).getHours();
        if (okAt(k) && hr >= 7 && hr <= 20) { if (!run) run = { a: k, b: k }; else run.b = k; if (!best || (d.steps[run.b] - d.steps[run.a]) > (d.steps[best.b] - d.steps[best.a])) best = { ...run }; }
        else run = null;
      }
      if (best && d.steps[best.b] - d.steps[best.a] >= 3) {
        const fmt = (k) => new Date(d.valid[k]).toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }));
        winHtml = `<div class="verdict-win"><i>best window</i><b>${fmt(best.a)} → ${fmt(best.b)}</b><span class="dim">dry · calm · daylight</span></div>`;
      }
    }
    const pt = W().state.point;
    let tidesHtml = "";
    if (pt && pt.tides && pt.tides.events && pt.tides.events.length) {
      const t = pt.tides;
      const now = W().validDate.getTime();
      const turns = t.events.filter((e) => new Date(e.time).getTime() > now).slice(0, 8);
      const hs = turns.map((e) => e.height_m), range = hs.length > 1 ? Math.max(...hs) - Math.min(...hs) : null;
      tidesHtml = `<div class="obs tides-obs"><div class="obs-head"><span class="stn"><b>Tides</b><span class="nm">${esc(t.station)}<small>${W().units.dist(t.distance_km).txt}</small></span></span><span class="src"><b>${esc(t.datum)}</b>${esc(t.source)}</span></div>
        ${tideCard(pt)}
        <div class="tides">${turns.map((e) => `<span class="tide ${e.type}"><b>${e.type === "H" ? "▲" : "▼"} ${W().units.alt(e.height_m, 1).txt}</b><small>${W().units.dateTime(e.time, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small></span>`).join("")}</div>
        ${range != null ? `<div class="tide-foot"><span>range <b>${W().units.alt(range, 1).txt}</b></span><span>${turns.length} turns ahead</span></div>` : ""}</div>`;
    }
    // Each group of readings gets the graphic that explains it, drawn over
    // the same 48 h: the strips share one clock, so the eye lines them up.
    const H = 48;
    const uv = hourStrip(d, i, H, (k) => {
      const v = s.uvi ? s.uvi[k] : null;
      return { bg: v == null || v < 0.5 ? "rgba(127,127,127,.12)" : W().rampColor("uvi", v, 0.85), v, n: v };
    }, (k, c) => c != null && c >= 3 && isDayPeak(d, k, s.uvi) ? c.toFixed(0) : "");
    const sky = hourStrip(d, i, H, (k) => {
      const c = s.tcc ? s.tcc[k] : null, r = s.tp6 ? s.tp6[k] : 0;
      return { bg: c == null ? "transparent" : `rgba(127,140,160,${(0.1 + 0.55 * c).toFixed(2)})`, bar: r > 0.05 ? Math.min(1, r / 8) : 0,
        v: `${c == null ? "" : `cloud ${Math.round(c * 100)}%`}${r > 0.05 ? ` · ${W().units.precip(r).txt}` : ""}` };
    }, () => "");
    const gust = windCard(d, i, H);
    const take = (...keys) => rows.filter((r) => keys.some((k) => r[0].startsWith(k)));
    // The number leads, its unit and qualifier trail small, the label sits
    // under it in plain words: one glance says 28, the next says km/h, the
    // third says which. Green is not painted on — a fine reading is the
    // quiet default; only meh/bad earn a colour and a rule.
    const lead = (v) => { const m = String(v).match(/^(—|[-+]?\d[\d.,]*\s?(?:°[CF]?|%|h(?=\s|$))?)(.*)$/s); return m ? `<b>${m[1]}</b>${m[2].trim() ? `<small>${m[2].trim()}</small>` : ""}` : `<b class="word">${String(v).charAt(0).toUpperCase()}${String(v).slice(1)}</b>`; };
    // Each card carries its glyph in the corner and, where the reading is a
    // share of something, a gauge under the number: cloud is a share of the
    // sky, dry hours a share of three days, UV a share of the 11-point scale.
    const glyphFor = (k) => k.startsWith("Precip now") ? "drop" : k.startsWith("Next 24 h rain") ? "drop" : k.startsWith("Precip chance") ? "dice"
      : k.startsWith("Cloud base") ? "base" : k.startsWith("Cloud") ? "cloud" : k.startsWith("Thunder") ? "bolt" : k.startsWith("Visibility") ? "eye"
      : k.startsWith("UV") ? "sun" : k.startsWith("Wind") ? "wind" : k.startsWith("Max gust") ? "gust" : k.startsWith("Feels") ? "thermo"
      : k.startsWith("Dry, calm") ? "clock" : k.startsWith("Freezing") ? "flake" : k.startsWith("Snow level") ? "peak" : k.startsWith("Sea") ? "wave" : "";
    const gaugeFor = (k, v) => {
      const num = parseFloat(String(v).replace(/<[^>]+>/g, ""));
      if (!isFinite(num)) return null;
      if (k.startsWith("Cloud") && !k.startsWith("Cloud base")) return num / 100;
      if (k.startsWith("Precip chance")) return num / 100;
      if (k.startsWith("Dry, calm")) { const m = String(v).match(/of (\d+)/); return m ? num / +m[1] : null; }
      if (k.startsWith("UV")) return Math.min(1, num / 11);
      if (k.startsWith("Visibility")) return Math.min(1, num / 20);
      return null;
    };
    const kv = (rs) => rs.length ? `<div class="kv">${rs.map(([k, v, cls]) => { const gg = gaugeFor(k, v), gl = glyphFor(k);
      return `<div class="stat ${cls || ""}${gl ? ` g-${gl}` : ""}">${gl ? `<i class="glyph">${OD_GLYPHS[gl] || ""}</i>` : ""}<span class="v">${lead(v)}</span><span class="k">${k.replace(/ \(≈\)/, " ≈").replace("Precip", "Precip.")}</span>${gg != null ? `<i class="gauge"><b style="width:${(gg * 100).toFixed(0)}%"></b></i>` : ""}</div>`; }).join("")}</div>` : "";
    const section = (title, graphic, rs, note) => `<section class="od"><h4>${title}${note ? `<span>${note}</span>` : ""}</h4>${graphic || ""}${kv(rs)}</section>`;
    const cold = fl != null && (t == null || t < 12 || snowLevel < 3000);
    const brief = outdoorsBrief(d, i, { rain24, chance, gustMax24, fl, snowLevel, cold, calm, gusty });
    $("#outdoors").innerHTML = `<div class="verdict ${verdict[1]}"><b>${verdict[0]}</b>${why ? `<span class="why">${why}</span>` : ""}${winHtml}${brief ? `<p class="brief">${brief}</p>` : ""}</div>
      ${section("Sky &amp; rain", sky, take("Precip", "Next 24 h rain", "Cloud", "Visibility", "Thunder"), "cloud cover · rain bars, 48 h")}
      ${section("Sun", uv, take("UV"), "uv index, 48 h · daily peaks labelled")}
      ${section("Wind", gust, take("Wind", "Max gust", "Feels like", "Dry, calm"), "gusts, 48 h")}
      ${cold ? section("Snow &amp; cold", "", take("Freezing", "Snow level")) : ""}
      ${take("Sea state").length ? section("Sea", marineCard(pt, d, i), take("Sea state")) : ""}
      ${tidesHtml}${airHtml(pt || {})}
      <div class="note">Snow level ≈ freezing level − ${W().units.alt(300).txt}. Gusts come from models that ship one. Terrain is unresolved at 0.25°.</div>`;
    wireTideProbe();
    wireWindProbe();
    wireStripProbes();
  }

  // The trailhead briefing under the verdict: the two days ahead in the
  // order a person plans them — rain, wind, sun, snow, sea — each in one
  // sentence with a time attached, none of them a restatement of a card.
  function outdoorsBrief(d, i, c) {
    const s = d.series, U = W().units;
    const parts = story(d, i);
    const out = parts.filter((p) => ["rain", "sky", "wind", "breeze", "uv", "fog"].includes(p.k)).map((p) => p.t);
    // snow: only where the freezing level is part of the plan
    if (c.cold && c.fl != null) out.push(`Freezing level ${U.alt(Math.round(c.fl / 50) * 50).txt}, snow above about ${U.alt(Math.round(c.snowLevel / 50) * 50).txt}.`);
    // sea: the swell, from where
    if (s.swh && s.swh[i] != null) out.push(`Swell ${U.alt(s.swh[i], 1).txt}${s.mwp && s.mwp[i] != null ? ` at ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` from the ${compass(s.mwd[i])}` : ""}.`);
    return out.join(" ");
  }

  // Pointer over the tide chart: a ring rides the water under the cursor
  // and a tag says when and how high. Same cosine as the drawing, so the
  // ring sits on the line rather than near it.
  function wireTideProbe() {
    const area = $("#outdoors .tide-area[data-ev]");
    if (!area || area.dataset.wired) return;
    area.dataset.wired = "1";
    const ev = JSON.parse(area.dataset.ev), lo = +area.dataset.lo, rng = +area.dataset.rng;
    const x0 = ev[0][0], x1 = ev[ev.length - 1][0];
    const dot = area.querySelector(".tdot.hov"), lab = area.querySelector(".tlab");
    const show = (clientX) => {
      const r = area.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const x = x0 + f * (x1 - x0);
      let h = null;
      for (let k = 0; k + 1 < ev.length; k++)
        if (x >= ev[k][0] && x <= ev[k + 1][0]) { h = ev[k][1] + (ev[k + 1][1] - ev[k][1]) * (1 - Math.cos(Math.PI * (x - ev[k][0]) / (ev[k + 1][0] - ev[k][0]))) / 2; break; }
      if (h == null) return;
      const top = 100 - (h - lo) / rng * 100;
      dot.style.left = `${(f * 100).toFixed(1)}%`; dot.style.top = `${top.toFixed(1)}%`; dot.hidden = false;
      lab.textContent = `${W().units.dateTime(new Date(x), { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${W().units.alt(h, 1).txt}`;
      lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
    };
    const hide = () => { dot.hidden = true; lab.hidden = true; };
    area.addEventListener("pointermove", (e) => show(e.clientX));
    area.addEventListener("pointerdown", (e) => show(e.clientX));
    area.addEventListener("pointerleave", hide);
  }

  // Stat cards the way Outdoors draws them — number first, unit small, label
  // under, a glyph in the corner, a gauge when the value is a share — for the
  // other tabs that carry a handful of readings.
  function statCards(rows, cls) {
    const lead = (v) => { const m = String(v).match(/^(—|[-+]?\d[\d.,]*\s?(?:°[CF]?|%|h(?=\s|$))?)(.*)$/s); return m ? `<b>${m[1]}</b>${m[2].trim() ? `<small>${m[2].trim()}</small>` : ""}` : `<b class="word">${String(v).charAt(0).toUpperCase()}${String(v).slice(1)}</b>`; };
    return `<div class="kv ${cls || ""}">${rows.map(([k, v, c, g, share]) => `<div class="stat ${c || ""}${g ? ` g-${g}` : ""}">${g ? `<i class="glyph">${OD_GLYPHS[g] || ""}</i>` : ""}<span class="v">${lead(v)}</span><span class="k">${k}</span>${share != null ? `<i class="gauge"><b style="width:${(share * 100).toFixed(0)}%"></b></i>` : ""}</div>`).join("")}</div>`;
  }

  // The card glyphs: 24-unit strokes, one line weight, coloured by the card
  // through currentColor so a flagged card's glyph flags with it.
  const OD_GLYPHS = (() => {
    const w = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    return {
      drop: w('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
      dice: w('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>'),
      cloud: w('<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.4 1.6A3.5 3.5 0 0 1 17.5 18z"/>'),
      base: w('<path d="M7 14a4 4 0 0 1-.5-8 6 6 0 0 1 11.4 1.6A3.5 3.5 0 0 1 17.5 14z"/><path d="M4 20h16"/>'),
      bolt: w('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
      eye: w('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
      sun: w('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
      wind: w('<path d="M3 8h9a3 3 0 1 0-3-3M3 12h14a3 3 0 1 1-3 3M3 16h7a2 2 0 1 1-2 2"/>'),
      gust: w('<path d="M3 10h11a3 3 0 1 0-3-3M3 14h16a3 3 0 1 1-3 3"/><path d="M4 19l2-1 2 1 2-1"/>'),
      thermo: w('<path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v6"/>'),
      clock: w('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
      flake: w('<path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19"/>'),
      peak: w('<path d="M3 20 10 7l3 5 2-3 6 11z"/><path d="M8 11l2-1 2 1"/>'),
      wave: w('<path d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0M2 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>'),
      baro: w('<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/><path d="M12 5v2M5 13h2M17 13h2"/>'),
    };
  })();

  // The sea, for someone going in: swell, period, where it comes from, the
  // wind against it (offshore holds a wave up, onshore knocks it down), the
  // water, the tide's turn — and one verdict from all of it, with a 48 h
  // swell strip so the call for tomorrow is on the same card.
  function marineCard(pt, d, i) {
    const s = d.series, U = W().units, { speed, speedUnit, arrow } = W();
    const swh = seaVal(d, i, "swh"); if (!swh) return "";
    const mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd"), sst = seaVal(d, i, "sst");
    const w = s.wind ? s.wind[i] : null, wd = s.wdir ? s.wdir[i] : null;
    // onshore / offshore: the coast probe says which way the sea lies from
    // the pin; wind blowing TOWARD the sea is offshore. With no probe the
    // swell's own direction stands in for "where the sea is".
    const seaBearing = (() => { const c = coastNear(d); if (c && c.bearing_deg != null) return c.bearing_deg; return mwd ? mwd.v : null; })();
    let rel = null;
    if (w != null && wd != null && seaBearing != null) {
      const to = (wd + 180) % 360, diff = Math.abs(((to - seaBearing) + 540) % 360 - 180);
      rel = diff < 60 ? "offshore" : diff > 120 ? "onshore" : "cross-shore";
    }
    const kmh = w == null ? null : w * 3.6;
    const per = mwp ? mwp.v : null, h = swh.v;
    // the call: size, period and wind, in the order a surfer weighs them
    let call, cls, why;
    if (h > 3.5 || (kmh != null && kmh > 40 && rel !== "offshore")) { call = "Heavy"; cls = "bad"; why = h > 3.5 ? "big swell" : "strong onshore wind"; }
    else if (h < 0.5) { call = "Flat"; cls = "meh"; why = "no swell to speak of"; }
    else if ((per == null || per >= 9) && (kmh == null || kmh < 15 || rel === "offshore")) { call = "Clean"; cls = "good"; why = rel === "offshore" ? "offshore wind, groomed faces" : "light wind, long-period swell"; }
    else if (kmh != null && kmh >= 25 && rel === "onshore") { call = "Blown out"; cls = "bad"; why = "onshore wind on the faces"; }
    else { call = "Rideable"; cls = "meh"; why = per != null && per < 9 ? "short-period wind swell" : "some wind on it"; }
    const tide = nextTide(pt);
    const tideTxt = tide ? `${tide.type === "H" ? "high" : "low"} at ${U.time(tide.time)}` : "";
    const stats = [
      `<div><small>Swell</small><b>${U.alt(h, 1).v}<i>${esc(U.altUnit)}</i></b>${mwd ? `<em>${arrow(mwd.v)} from ${compass(mwd.v)}</em>` : ""}</div>`,
      per != null ? `<div><small>Period</small><b>${per.toFixed(0)}<i>s</i></b><em>${per >= 12 ? "ground swell" : per >= 9 ? "mid-period" : "wind swell"}</em></div>` : "",
      w != null ? `<div><small>Wind</small><b>${speed(w).toFixed(0)}<i>${esc(speedUnit())}</i></b><em>${wd != null ? `${arrow(wd)} ${compass(wd)}` : ""}${rel ? ` · ${rel}` : ""}</em></div>` : "",
      sst ? `<div><small>Water</small><b>${U.tempC(sst.v - K).v}<i>${esc(U.tempUnit)}</i></b><em>${sst.v - K < 12 ? "5/4 hooded" : sst.v - K < 16 ? "4/3 wetsuit" : sst.v - K < 20 ? "3/2 wetsuit" : "boardshorts"}</em></div>` : "",
      tide ? `<div><small>Tide</small><b>${esc(U.time(tide.time))}</b><em>next ${tide.type === "H" ? "high" : "low"} · ${esc(U.alt(tide.height_m, 1).txt)}</em></div>` : "",
    ].filter(Boolean).join("");
    // 48 h of swell as a strip: height in the cell, the ramp by size
    const strip = hourStrip(d, i, 48, (k) => {
      const v = s.swh ? s.swh[k] : null;
      return { bg: v == null ? "transparent" : `rgba(74,169,217,${Math.min(0.85, 0.12 + v / 4).toFixed(2)})`, v: v == null ? "" : `swell ${U.alt(v, 1).txt}${s.mwp && s.mwp[k] != null ? ` · ${s.mwp[k].toFixed(0)} s` : ""}`, n: v };
    }, (k, v) => (v != null && (k === i || isDayPeak(d, k, s.swh)) ? U.alt(v, 1).v : ""));
    return `<div class="modcard marine ${cls}"><div class="mod-head"><span class="call">${call}</span><span class="dim">${why}${tideTxt ? ` · ${tideTxt}` : ""}</span></div>
      <div class="mod-stats">${stats}</div>${strip}</div>`;
  }

  // A row of hour cells over the next `hours` from step i, each as wide as
  // the hours it covers, with the day named where it changes. `cell(k)`
  // gives {bg, bar?, v}; `label(k, v)` prints inside the cell or nothing.
  // Is it night at this point at this instant? Between sunset and sunrise
  // by the same arithmetic the hero's sun times use; polar day/night when
  // the sun never crosses the horizon.
  function isNight(lat, lon, when) {
    const st = sunTimes(lat, lon, when);
    const h = when.getUTCHours() + when.getUTCMinutes() / 60;
    if (!st) return Math.abs(lat) > 60 && (lat > 0) === (when.getUTCMonth() < 3 || when.getUTCMonth() > 8);
    const r = st.riseUtc, s = st.setUtc;
    return r < s ? (h < r || h >= s) : (h >= s && h < r);
  }
  function hourStrip(d, i, hours, cell, label) {
    const cells = [], days = [];
    const pt = W().state.point || {};
    let total = 0, lastDay = null;
    for (let k = i; k < d.steps.length && d.steps[k] < d.steps[i] + hours; k++) {
      const h = stepHrs(d, k), c = cell(k), when = new Date(d.valid[k]);
      const night = pt.lat != null && isNight(pt.lat, pt.lon, when);
      const day = when.toLocaleDateString(undefined, W().units.timeOpts({ weekday: "short" }));
      if (day !== lastDay) { days.push(`<i style="left:${(total / hours * 100).toFixed(1)}%">${day}</i>`); lastDay = day; }
      const said = c.v == null || c.v === "" ? "" : typeof c.v === "number" ? ` · UV ${c.v.toFixed(0)}` : ` · ${c.v}`;
      cells.push(`<i class="${night ? "n" : ""}" style="flex:${h} 0 0;background:${c.bg}" title="${when.toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }))}${said}">${c.bar ? `<b style="height:${(c.bar * 100).toFixed(0)}%"></b>` : ""}<s>${label(k, c.n != null ? c.n : c.v)}</s></i>`);
      total += h;
    }
    if (cells.length < 4) return "";
    return `<div class="hstrip"><div class="cells">${cells.join("")}</div><div class="hx">${days.join("")}</div></div>`;
  }
  function isDayPeak(d, k, arr) {
    if (!arr || arr[k] == null) return false;
    const day = new Date(d.valid[k]).toDateString();
    for (let q = 0; q < d.valid.length; q++)
      if (new Date(d.valid[q]).toDateString() === day && arr[q] != null && (arr[q] > arr[k] || (arr[q] === arr[k] && q < k))) return false;
    return true;
  }
  // The wind over the next `hours` as the tide is drawn: a readout on top
  // (wind now, from where, the gust with it, the peak gust ahead and when),
  // a chart with its y axis in the user's unit, wind as the line and gusts
  // as the lighter band above it, a ring at the card's time, and a pointer
  // probe that says the time, wind, gust and direction under the finger.
  function windCard(d, i, hours) {
    const { speed, speedUnit, arrow } = W(), s = d.series;
    if (!s.wind) return "";
    const unit = speedUnit();
    const rows = [];
    for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + hours; k++)
      if (s.wind[k] != null) rows.push([new Date(d.valid[k]).getTime(), speed(s.wind[k]), s.gust && s.gust[k] != null ? speed(s.gust[k]) : null, s.wdir ? s.wdir[k] : null]);
    if (rows.length < 4) return "";
    const x0 = rows[0][0], x1 = rows[rows.length - 1][0], span = Math.max(x1 - x0, 1);
    const mx = Math.max(1, ...rows.map((r) => Math.max(r[1], r[2] || 0)));
    const X = (x) => (x - x0) / span * 100, Y = (v) => 100 - v / mx * 92;
    const wpts = rows.map((r) => `${X(r[0]).toFixed(2)},${Y(r[1]).toFixed(2)}`);
    const gpts = rows.filter((r) => r[2] != null).map((r) => `${X(r[0]).toFixed(2)},${Y(r[2]).toFixed(2)}`);
    // the peak gust ahead (or the peak wind if the model ships no gust)
    let peak = rows[0]; for (const r of rows) if ((r[2] ?? r[1]) > (peak[2] ?? peak[1])) peak = r;
    const now = W().validDate.getTime();
    const dt = peak[0] - now, inTxt = dt > 3600e3 ? `${Math.floor(dt / 3600e3)}h${String(Math.round(dt % 3600e3 / 60e3)).padStart(2, "0")}` : dt > 0 ? `${Math.round(dt / 60e3)} min` : "";
    const cur = rows[0];
    const readout = `<div class="tide-now wind-now">
        <span class="tnum"><b>${cur[1].toFixed(0)}</b><i>${unit}</i></span>
        <span class="tdir">${cur[3] != null ? `${arrow(cur[3])} ${compass(cur[3])}` : ""}${cur[2] != null ? ` · gusts ${cur[2].toFixed(0)}` : ""}</span>
        ${peak !== cur ? `<span class="tnext"><b>peak ${(peak[2] ?? peak[1]).toFixed(0)} ${unit}</b><em>${W().units.dateTime(new Date(peak[0]), { weekday: "short", hour: "numeric" })}${inTxt ? ` · ${inTxt}` : ""}</em></span>` : ""}
      </div>`;
    // x axis: every local midnight is a day, every local noon a tick
    const hourOf = new Intl.DateTimeFormat("en-US", W().units.timeOpts({ hour: "2-digit", hour12: false }));
    const xt = [];
    for (let x = Math.ceil(x0 / 3600e3) * 3600e3; x <= x1; x += 3600e3) {
      const h = hourOf.format(new Date(x)).replace("24", "00");
      if (h === "00") xt.push(`<i class="day" style="left:${X(x).toFixed(1)}%">${new Date(x).toLocaleDateString(undefined, W().units.timeOpts({ weekday: "short" }))}</i>`);
      else if (h === "12") xt.push(`<i style="left:${X(x).toFixed(1)}%">noon</i>`);
    }
    const marker = `<i class="tdot now" style="left:0%;top:${Y(cur[1]).toFixed(1)}%"></i>`;
    const probe = `<i class="tdot hov" hidden></i><s class="tlab" hidden></s>`;
    const nights = nightBands(x0, x1, X);
    const data = esc(JSON.stringify(rows.map((r) => [r[0], +r[1].toFixed(1), r[2] == null ? null : +r[2].toFixed(1), r[3] == null ? null : Math.round(r[3])])));
    return `<div class="tide-card wind-card">${readout}
      <div class="tide-plot">
        <div class="tide-y"><i>${mx.toFixed(0)}</i><i>0</i><u>${unit}</u></div>
        <div class="tide-area wind-area" data-rows="${data}" data-mx="${mx}">${nights}<div class="tide-water wind-water"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${gpts.length > 3 ? `<polygon class="g" points="${gpts.join(" ")} ${wpts.slice().reverse().join(" ")}"/>` : ""}<polygon class="w" points="0,100 ${wpts.join(" ")} 100,100"/>${gpts.length > 3 ? `<polyline class="g" points="${gpts.join(" ")}"/>` : ""}<polyline class="w" points="${wpts.join(" ")}"/></svg>${marker}${probe}</div></div>
      </div>
      <div class="tide-x">${xt.join("")}</div>
    </div>`;
  }
  // Hover on any hour strip (sky, sun): a tag names the hour and the value
  // under the pointer. The cells already carry that text as a title for the
  // long-press crowd; the tag shows it without the wait.
  function wireStripProbes() {
    document.querySelectorAll("#outdoors .hstrip").forEach((strip) => {
      if (strip.dataset.wired) return;
      strip.dataset.wired = "1";
      const cells = strip.querySelector(".cells");
      const lab = document.createElement("s"); lab.className = "tlab"; lab.hidden = true; cells.appendChild(lab);
      const show = (clientX) => {
        const r = cells.getBoundingClientRect(), f = Math.max(0, Math.min(0.999, (clientX - r.left) / r.width));
        const el = document.elementFromPoint(r.left + f * r.width, r.top + r.height / 2);
        const cell = el && el.closest("i[title]");
        if (!cell) { lab.hidden = true; return; }
        lab.textContent = cell.title; lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
      };
      cells.addEventListener("pointermove", (e) => show(e.clientX));
      cells.addEventListener("pointerdown", (e) => show(e.clientX));
      cells.addEventListener("pointerleave", () => { lab.hidden = true; });
    });
  }
  // Night as bands across a chart between x0 and x1 (ms), hour by hour.
  function nightBands(x0, x1, X) {
    const pt = W().state.point; if (!pt || pt.lat == null) return "";
    const out = []; let start = null;
    for (let x = x0; x <= x1 + 3600e3; x += 3600e3) {
      const n = x <= x1 && isNight(pt.lat, pt.lon, new Date(x));
      if (n && start == null) start = x;
      if (!n && start != null) { out.push(`<i class="nb" style="left:${X(start).toFixed(1)}%;width:${(X(Math.min(x, x1)) - X(start)).toFixed(1)}%"></i>`); start = null; }
    }
    return out.join("");
  }
  function wireWindProbe() {
    const area = $("#outdoors .wind-area");
    if (!area || area.dataset.wired) return;
    area.dataset.wired = "1";
    const rows = JSON.parse(area.dataset.rows), mx = +area.dataset.mx;
    const x0 = rows[0][0], x1 = rows[rows.length - 1][0];
    const dot = area.querySelector(".tdot.hov"), lab = area.querySelector(".tlab");
    const show = (clientX) => {
      const r = area.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const x = x0 + f * (x1 - x0);
      let a = rows[0], b = rows[rows.length - 1];
      for (let k = 0; k + 1 < rows.length; k++) if (x >= rows[k][0] && x <= rows[k + 1][0]) { a = rows[k]; b = rows[k + 1]; break; }
      const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
      const w = a[1] + (b[1] - a[1]) * t, g = a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * t : null;
      const near = t < 0.5 ? a : b;
      dot.style.left = `${(f * 100).toFixed(1)}%`; dot.style.top = `${(100 - w / mx * 92).toFixed(1)}%`; dot.hidden = false;
      lab.textContent = `${W().units.dateTime(new Date(x), { weekday: "short", hour: "numeric" })} · ${w.toFixed(0)}${g != null ? ` / ${g.toFixed(0)}` : ""} ${W().speedUnit()}${near[3] != null ? ` ${W().arrow(near[3])} ${compass(near[3])}` : ""}`;
      lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
    };
    const hide = () => { dot.hidden = true; lab.hidden = true; };
    area.addEventListener("pointermove", (e) => show(e.clientX));
    area.addEventListener("pointerdown", (e) => show(e.clientX));
    area.addEventListener("pointerleave", hide);
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
      const models = catalog.models.filter((m) => m.runs.length);
      pt.cmp = { rows: {}, order: models.map((m) => m.key), pending: models.length };
      // Rows land one at a time. Regional models answer from the same store as
      // the globals and simply omit a point outside their advertised domain.
      const land = (m, r) => {
        if (r && r.available !== false) pt.cmp.rows[m.key] = { model: m, data: r };
        pt.cmp.pending -= 1;
        if (W().state.point === pt && W().state.tab === "cmp") W().renderPoint();
      };
      models.forEach((m) => api(`${API}/point?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&model=${m.key}`).then((r) => land(m, r)).catch(() => land(m, null)));
    }
    if (!Object.keys(pt.cmp.rows).length) { $("#compare").innerHTML = `<div class="note">${pt.cmp.pending ? "loading other models…" : "no other model has this point"}</div>`; return; }
    const t0 = new Date(d.valid[i]).getTime();
    const cols = Array.from({ length: 8 }, (_, k) => t0 + k * 12 * 3600e3);      // 4 days at 12 h
    const head = cols.map((t) => `<th>${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric" }).replace(" ", "<br>")}</th>`).join("");
    const rowFor = (label, pick) => pt.cmp.order.map((k) => pt.cmp.rows[k]).filter(Boolean).map(({ model, data }) => {
      const cells = cols.map((t) => { const k = data.valid.findIndex((v) => new Date(v).getTime() === t); return `<td>${k >= 0 ? pick(data.series, k) : "—"}</td>`; }).join("");
      // Each model's own resolution beside its name: the reason two rows differ
      // is usually that one of them resolves the terrain and the other does not.
      return `<tr><td class="mdl">${model.short}${model.grid ? `<i>${model.grid}</i>` : ""}</td>${cells}</tr>`;
    }).join("");
    $("#compare").innerHTML = `<table class="cmp"><thead><tr><th>Temp ${W().units.tempUnit}</th>${head}</tr></thead><tbody>${rowFor("t", (s, k) => s.t2m && s.t2m[k] != null ? W().units.temp(s.t2m[k]).v : "—")}</tbody>
      <thead><tr><th>Wind ${speedUnit()}</th>${head}</tr></thead><tbody>${rowFor("w", (s, k) => s.wind && s.wind[k] != null ? Math.round(speed(s.wind[k])) : "—")}</tbody>
      <thead><tr><th>Rain ${W().units.precipUnit}/12h</th>${head}</tr></thead><tbody>${rowFor("r", (s, k) => s.tp6 ? `<span class="r">${W().units.precip((s.tp6[k] || 0) + (s.tp6[k + 1] || 0)).v}</span>` : "—")}</tbody></table>
      <div class="note">${pt.cmp.pending ? "still loading… " : ""}Same valid times, each model's latest run. Disagreement is the error bar. Regional rows appear only where that model covers the point.</div>`;
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
        <table class="bands"><thead><tr><th>Band</th><th>Temp</th><th>Wind</th><th>Precip type</th><th>Next 24 h</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="board-head"><span>Morning / afternoon / night</span></div>${bandTable(p, P.bands.slice().reverse())}`;
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

  window.WXPanes = { render, sunTimes, canSnow };
})();
