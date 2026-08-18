// Static-mode shim (GitHub Pages demo). Loaded only by the snapshot build,
// before app.js. It maps the live API URLs onto the files static_demo.py
// wrote, answers point/profile queries from the point tiles, and calls the
// external services directly where their CORS allows. Anything it can't do
// fails soft, so the demo degrades instead of breaking.
(function () {
  "use strict";
  const K = 273.15;
  const tileCache = new Map();
  const cache = new Map();

  function url(u) {
    // strip our own query strings, encode ?level=X into the filename
    const [path, qs] = u.split("?");
    const q = new URLSearchParams(qs || "");
    if (path === "api/models") return "api/models.json";
    const lvl = q.get("level");
    if (/^api\/(layer|wind|isolines)\//.test(path)) {
      if (!lvl) return path;
      if (path.endsWith(".png")) return path.replace(/\.png$/, `-${lvl}.png`);
      if (path.endsWith(".json")) return path.replace(/\.json$/, `-${lvl}.json`);
    }
    return u;
  }

  async function getJson(u) {
    if (cache.has(u)) return cache.get(u);
    const r = await fetch(u);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    cache.set(u, j);
    return j;
  }

  let catalogP = null;
  const catalog = () => (catalogP ||= getJson("api/models.json"));

  async function tileFor(lat, lon) {
    const c = await catalog();
    const m = c.models[0], run = m.runs[0].run;
    const ty = Math.min(17, Math.max(0, Math.floor((90 - lat) / 10)));
    const tx = Math.min(35, Math.max(0, Math.floor((lon + 180) / 10)));
    const key = `${ty}_${tx}`;
    if (!tileCache.has(key)) tileCache.set(key, getJson(`api/pt/${m.key}/${run}/${key}.json`));
    return { tile: await tileCache.get(key), model: m, run };
  }

  function seriesAt(tile, lat, lon) {
    const iy = Math.min(tile.ny - 1, Math.max(0, Math.round((tile.lat0 - lat) / tile.d)));
    const ix = Math.min(tile.nx - 1, Math.max(0, Math.round((lon - tile.lon0) / tile.d)));
    const n = tile.steps.length, per = tile.ny * tile.nx;
    const out = {};
    for (const [v, arr] of Object.entries(tile.vars)) out[v] = Array.from({ length: n }, (_, k) => arr[k * per + iy * tile.nx + ix]);
    return out;
  }

  const windPair = (u, v) => [u.map((a, k) => (a == null || v[k] == null) ? null : Math.round(Math.hypot(a, v[k]) * 100) / 100),
                              u.map((a, k) => (a == null || v[k] == null) ? null : Math.round((270 - Math.atan2(v[k], a) * 180 / Math.PI + 360) % 360))];

  function freezing(series, levels, n) {
    const lv = levels.slice().sort((a, b) => b - a);
    return Array.from({ length: n }, (_, i) => {
      let prev = null;
      for (const l of lv) {
        const t = series[`t_${l}`] && series[`t_${l}`][i], gh = series[`gh_${l}`] && series[`gh_${l}`][i];
        if (t == null || gh == null) continue;
        if (prev && prev[0] - K >= 0 && t - K < 0) return Math.round(prev[1] + (gh - prev[1]) * (prev[0] - K) / (prev[0] - t));
        prev = [t, gh];
      }
      return null;
    });
  }

  async function point(q) {
    const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
    const { tile, model, run } = await tileFor(lat, lon);
    const series = seriesAt(tile, lat, lon);
    const n = tile.steps.length;
    if (series.u10 && series.v10) [series.wind, series.wdir] = windPair(series.u10, series.v10);
    const levels = [850, 700, 500].filter((l) => series[`t_${l}`]);
    const aloft = {};
    for (const l of levels) { const [w, d] = windPair(series[`u_${l}`], series[`v_${l}`]); aloft[String(l)] = { wind: w, wdir: d, temp: series[`t_${l}`], gh: series[`gh_${l}`] }; }
    const t0 = new Date(run.replace(/T(\d\d)$/, "T$1:00:00Z")).getTime();
    return { model: model.key, run, lat, lon, steps: tile.steps, valid: tile.steps.map((h) => new Date(t0 + h * 3600e3).toISOString()),
             series, aloft, derived: { freezing_level_m: levels.length ? freezing(series, levels, n) : null }, levels, units: {} };
  }

  async function profile(q) {
    const p = await point(q);
    const zs = (q.get("elevs") || "0,1000,2000,3000").split(",").map(Number);
    const lv = p.levels.slice().sort((a, b) => b - a);
    const n = p.steps.length;
    const bands = zs.map((z) => {
      const temp = [], u = [], v = [];
      for (let i = 0; i < n; i++) {
        const col = lv.map((l) => [p.series[`gh_${l}`][i], p.series[`t_${l}`][i], p.series[`u_${l}`][i], p.series[`v_${l}`][i]]).filter((c) => c.every((x) => x != null)).sort((a, b) => a[0] - b[0]);
        if (!col.length) { temp.push(null); u.push(null); v.push(null); continue; }
        let t, uu, vv;
        if (z <= col[0][0]) { const [gh0, t0, u0, v0] = col[0]; const ts = p.series.t2m ? p.series.t2m[i] : null; const frac = gh0 > 0 ? z / gh0 : 1; if (ts != null) { t = ts + (t0 - ts) * frac; uu = (p.series.u10 ? p.series.u10[i] : u0) + (u0 - (p.series.u10 ? p.series.u10[i] : u0)) * frac; vv = (p.series.v10 ? p.series.v10[i] : v0) + (v0 - (p.series.v10 ? p.series.v10[i] : v0)) * frac; } else { t = t0 + 0.0065 * (gh0 - z); uu = u0; vv = v0; } }
        else if (z >= col[col.length - 1][0]) { const [gh1, t1, u1, v1] = col[col.length - 1]; t = t1 - 0.0065 * (z - gh1); uu = u1; vv = v1; }
        else { for (let k = 0; k < col.length - 1; k++) { const [g0, t0, u0, v0] = col[k], [g1, t1, u1, v1] = col[k + 1]; if (g0 <= z && z <= g1) { const f = g1 > g0 ? (z - g0) / (g1 - g0) : 0; t = t0 + (t1 - t0) * f; uu = u0 + (u1 - u0) * f; vv = v0 + (v1 - v0) * f; break; } } }
        temp.push(t); u.push(uu); v.push(vv);
      }
      const [wind, wdir] = windPair(u, v);
      const ptype = temp.map((t) => t == null || !p.series.tp6 ? null : (t - K < 1 ? "snow" : t - K > 2.5 ? "rain" : "mixed"));
      return { elev_m: z, temp, wind, wdir, ptype };
    });
    return { model: p.model, run: p.run, lat: p.lat, lon: p.lon, steps: p.steps, valid: p.valid, bands, tp6: p.series.tp6, sf6: p.series.sf6, freezing_level_m: p.derived.freezing_level_m, levels: p.levels };
  }

  async function geo(q) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${q.get("limit") || 5}&q=${encodeURIComponent(q.get("q") || "")}`);
    const hits = await r.json();
    return { hits: hits.map((h) => ({ name: h.name || h.display_name.split(",")[0], display: h.display_name, lat: parseFloat(h.lat), lon: parseFloat(h.lon), type: h.type })) };
  }
  async function reverse(q) {
    const lat = q.get("lat"), lon = q.get("lon");
    const [g, e] = await Promise.all([
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`).then((r) => r.json()).catch(() => ({})),
      fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`).then((r) => r.json()).catch(() => null)]);
    const a = g.address || {};
    return { place: { name: a.city || a.town || a.village || a.hamlet || a.municipality || a.county || g.name || "", region: a.state || a.province || "", country: (a.country_code || "").toUpperCase(), display: g.display_name || "" },
             elevation_m: e && e.elevation ? e.elevation[0] : null };
  }
  async function obs(q) {
    // aviationweather.gov sets CORS headers on /api/data; if it ever doesn't, this just yields null
    try {
      const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
      const r = await fetch(`https://aviationweather.gov/api/data/metar?bbox=${lat - 1.5},${lon - 2},${lat + 1.5},${lon + 2}&format=json&hours=3`);
      const list = await r.json();
      let best = null, bd = 120;
      for (const o of list) { if (o.lat == null) continue; const d = 111 * Math.hypot(o.lat - lat, (o.lon - lon) * Math.cos(lat * Math.PI / 180)); if (d < bd) { bd = d; best = o; } }
      if (!best) return { metar: null, taf: null };
      return { metar: { station: best.icaoId, name: best.name, distance_km: Math.round(bd * 10) / 10, time: best.reportTime, temp_c: best.temp, dewpoint_c: best.dewp, wdir: best.wdir, wspd_kt: best.wspd, wgst_kt: best.wgst, visib: best.visib, altim_hpa: best.altim, clouds: best.clouds || [], wx: best.wxString, flight_category: best.fltCat, raw: best.rawOb }, taf: null };
    } catch (e) { return { metar: null, taf: null }; }
  }
  async function avyLayer() {
    const us = await fetch("https://api.avalanche.org/v2/public/products/map-layer").then((r) => r.json());
    return { type: "FeatureCollection", features: us.features.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { source: "avalanche.org", id: String(f.id), name: f.properties.name, center: f.properties.center, danger: f.properties.danger, danger_level: f.properties.danger_level, color: f.properties.color, link: f.properties.link, off_season: !!f.properties.off_season } })) };
  }
  async function avyPoint(q) {
    const r = await fetch(`https://api.avalanche.ca/forecasts/en/products/point?lat=${q.get("lat")}&long=${q.get("lon")}`);
    if (!r.ok) throw new Error("no region");
    const p = await r.json(), rep = p.report || {};
    const rate = (x) => { const v = ((x || {}).rating || {}); const map = { low: 1, moderate: 2, considerable: 3, high: 4, extreme: 5 }; return { value: v.value || "", display: v.display || "", level: map[v.value] ?? (v.value ? 0 : -1) }; };
    const days = (rep.dangerRatings || []).map((d) => ({ date: d.date && d.date.value, label: d.date && d.date.display, alp: rate((d.ratings || {}).alp), tln: rate((d.ratings || {}).tln), btl: rate((d.ratings || {}).btl) }));
    const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { source: "avalanche.ca", region: rep.title || "Avalanche Canada region", url: p.url, issued: rep.dateIssued, valid_until: rep.validUntil, confidence: (((rep.confidence || {}).rating) || {}).display, highlights: strip(rep.highlights), days, problems: [], summaries: {}, off_season: days.some((d) => ["offseason", "spring"].includes(d.alp.value)) };
  }
  async function resorts(q, path) {
    const all = (await getJson("api/resorts/all.json")).resorts;
    if (path === "api/resorts/all") return { resorts: all };
    const m = path.match(/^api\/resorts\/(.+)$/);
    if (m) return getJson(`api/resorts/${m[1]}.json`);          // only prebuilt details exist
    if (q.get("q")) { const t = q.get("q").toLowerCase(); return { mode: "search", resorts: all.filter((r) => r.name.toLowerCase().includes(t)).slice(0, Number(q.get("limit") || 8)) }; }
    if (q.get("lat")) { const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon")); return { mode: "nearest", resorts: all.map((r) => ({ ...r, distance_km: 111 * Math.hypot(r.lat - lat, (r.lon - lon) * Math.cos(lat * Math.PI / 180)) })).filter((r) => r.distance_km < 60).sort((a, b) => a.distance_km - b.distance_km).slice(0, 5) }; }
    return { resorts: [] };
  }

  async function air(q) {
    const j = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${q.get("lat")}&longitude=${q.get("lon")}&current=us_aqi,pm2_5,pm10,ozone,uv_index&hourly=uv_index&forecast_days=1&timezone=UTC`).then((r) => r.json());
    const c = j.current || {};
    return { us_aqi: c.us_aqi, pm2_5: c.pm2_5, pm10: c.pm10, ozone: c.ozone, uv: c.uv_index, hourly: { uv: (j.hourly || {}).uv_index || [] } };
  }
  const SEVC = { Extreme: "#b30000", Severe: "#e8590c", Moderate: "#f0a020", Minor: "#f5d33c" };
  async function alertsPoint(q) {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${q.get("lat")},${q.get("lon")}`, { headers: { Accept: "application/geo+json" } });
    if (!r.ok) return { alerts: [] };
    const j = await r.json();
    return { alerts: (j.features || []).map((f) => ({ id: f.id, event: f.properties.event, severity: f.properties.severity, color: SEVC[f.properties.severity] || "#8a8f98", headline: f.properties.headline, area: f.properties.areaDesc, ends: f.properties.ends || f.properties.expires, url: f.id })) };
  }
  async function alertsLayer() {
    const j = await fetch("https://api.weather.gov/alerts/active?status=actual&message_type=alert", { headers: { Accept: "application/geo+json" } }).then((r) => r.json());
    return { type: "FeatureCollection", features: (j.features || []).filter((f) => f.geometry).map((f) => ({ type: "Feature", geometry: f.geometry, properties: { event: f.properties.event, area: f.properties.areaDesc, color: SEVC[f.properties.severity] || "#8a8f98" } })) };
  }

  async function api(u) {
    const [path, qs] = u.split("?");
    const q = new URLSearchParams(qs || "");
    if (path === "api/air") return air(q);
    if (path === "api/alerts/point") return alertsPoint(q);
    if (path === "api/alerts/layer") return alertsLayer();
    if (path === "api/models") return catalog();
    if (path === "api/point") return point(q);
    if (path === "api/profile") return profile(q);
    if (path === "api/geo") return geo(q);
    if (path === "api/geo/reverse") return reverse(q);
    if (path === "api/obs") return obs(q);
    if (path === "api/avy/layer") return avyLayer();
    if (path === "api/avy/point") return avyPoint(q);
    if (path.startsWith("api/resorts")) return resorts(q, path);
    return getJson(url(u));
  }

  window.WXStatic = { url, api };
})();
