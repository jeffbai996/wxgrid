// Place + resort search box with a results dropdown. Loaded after app.js;
// exposes WX.search.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── search: places + resorts ──────────────────────────────────────────
  let searchTimer = null, searchSel = -1, searchHits = [];
  // ── favourites: starred places, in localStorage, listed when the box is empty
  const favs = () => JSON.parse(localStorage.getItem("wxgrid.favs") || "[]");
  const isFav = (lat, lon) => favs().some((f) => Math.abs(f.lat - lat) < 1e-3 && Math.abs(f.lon - lon) < 1e-3);
  function toggleFav(lat, lon, name) {
    let list = favs();
    if (isFav(lat, lon)) list = list.filter((f) => !(Math.abs(f.lat - lat) < 1e-3 && Math.abs(f.lon - lon) < 1e-3));
    else list.unshift({ name: name || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon });
    localStorage.setItem("wxgrid.favs", JSON.stringify(list.slice(0, 30)));
    return isFav(lat, lon);
  }
  const recents = () => JSON.parse(localStorage.getItem("wxgrid.recent") || "[]");
  function pushRecent(h) {
    if (h.kind === "fav" || h.kind === "recent") return;
    const list = recents().filter((r) => !(Math.abs(r.lat - h.lat) < 1e-3 && Math.abs(r.lon - h.lon) < 1e-3));
    list.unshift({ name: h.name, lat: h.lat, lon: h.lon, id: h.id, kind: h.kind });
    localStorage.setItem("wxgrid.recent", JSON.stringify(list.slice(0, 8)));
  }
  function showFavs() {
    const list = favs(), rec = recents().filter((r) => !isFav(r.lat, r.lon)).slice(0, 5);
    if (!list.length && !rec.length) { hideResults(); return; }
    searchHits = [...list.map((f) => ({ kind: "fav", name: f.name, sub: `${f.lat.toFixed(2)}°, ${f.lon.toFixed(2)}°`, lat: f.lat, lon: f.lon })),
                  ...rec.map((r) => ({ kind: "recent", name: r.name, sub: r.kind === "resort" ? "resort" : `${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}°`, lat: r.lat, lon: r.lon, id: r.id, srcKind: r.kind }))];
    searchSel = 0; paintResults();
  }
  function wireSearch() {
    const q = $("#q");
    q.oninput = () => { clearTimeout(searchTimer); if (!q.value.trim()) { showFavs(); return; } searchTimer = setTimeout(() => runSearch(q.value.trim()), 350); };
    q.onfocus = () => { if (!q.value.trim()) showFavs(); };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); searchSel = Math.min(searchHits.length - 1, searchSel + 1); paintResults(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); searchSel = Math.max(0, searchSel - 1); paintResults(); }
      else if (e.key === "Escape") hideResults();
    };
    $("#search").onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); if (searchHits.length) pickResult(searchHits[Math.max(0, searchSel)]); else runSearch(q.value.trim(), true); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#search") && !e.target.closest("#search-results")) hideResults(); });
  }
  // "49.28, -123.12" · "49°17'N 123°07'W" · "CYVR" · "YVR" — answered locally
  // or from the station list, before anyone bothers a geocoder with it.
  function parseCoords(t) {
    const dec = t.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (dec) { const la = +dec[1], lo = +dec[2]; if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) return { lat: la, lon: lo }; }
    const dms = t.match(/^\s*(\d{1,2})[°: ]\s*(\d{1,2}(?:\.\d+)?)?['′: ]?\s*(\d{1,2}(?:\.\d+)?)?["″]?\s*([NS])[ ,]+(\d{1,3})[°: ]\s*(\d{1,2}(?:\.\d+)?)?['′: ]?\s*(\d{1,2}(?:\.\d+)?)?["″]?\s*([EW])\s*$/i);
    if (dms) {
      const v = (d, m, s) => (+d) + (+(m || 0)) / 60 + (+(s || 0)) / 3600;
      const lat = v(dms[1], dms[2], dms[3]) * (/s/i.test(dms[4]) ? -1 : 1);
      const lon = v(dms[5], dms[6], dms[7]) * (/w/i.test(dms[8]) ? -1 : 1);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
    return null;
  }

  async function runSearch(text, go = false) {
    if (text.length < 2) { hideResults(); return; }
    const c = parseCoords(text);
    if (c) {
      // no name: let the reverse geocode put a place to it
      searchHits = [{ kind: "point", name: `${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}°`, sub: "coordinates", lat: c.lat, lon: c.lon, unnamed: true }];
      searchSel = 0;
      if (go) { pickResult(searchHits[0]); return; }
      paintResults(); return;
    }
    try {
      const code = /^[A-Za-z]{3,4}$/.test(text.trim()) ? text.trim().toUpperCase() : null;
      const [geo, res, sta] = await Promise.all([
        WX.api(`${API}/geo?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ hits: [] })),
        WX.api(`${API}/resorts?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ resorts: [] })),
        code ? WX.api(`${API}/station?ids=${code}`).catch(() => ({ stations: [] })) : Promise.resolve({ stations: [] }),
      ]);
      searchHits = [...(sta.stations || []).map((s) => ({ kind: "airport", name: `${s.icao || s.iata} · ${s.name || ""}`.trim(), sub: `${s.region || ""} ${s.country || ""}`.trim(), lat: s.lat, lon: s.lon })),
                    ...res.resorts.map((r) => ({ kind: "resort", name: r.name, sub: `${r.region || ""} ${r.country || ""}`.trim(), lat: r.lat, lon: r.lon, id: r.id })),
                    ...geo.hits.map((h) => ({ kind: "place", name: h.name, sub: h.display.split(",").slice(1, 3).join(",").trim(), lat: h.lat, lon: h.lon }))];
      searchSel = searchHits.length ? 0 : -1;
      if (go && searchHits.length) { pickResult(searchHits[0]); return; }
      paintResults();
    } catch (e) { WX.fn.toast("Search unavailable", 4000, "error"); }
  }
  function paintResults() {
    const box = $("#search-results");
    if (!searchHits.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = searchHits.map((h, i) => `<button class="${i === searchSel ? "sel" : ""}" data-i="${i}"><span class="kind ${h.kind}">${h.kind === "fav" ? "★" : h.kind === "recent" ? "↺" : h.kind}</span><span>${h.name}</span><span class="sub">${h.sub}</span>${h.kind === "fav" ? `<span class="unfav" data-i="${i}" title="Remove">×</span>` : ""}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = (e) => { if (e.target.classList.contains("unfav")) { const h = searchHits[Number(b.dataset.i)]; toggleFav(h.lat, h.lon); showFavs(); return; } pickResult(searchHits[Number(b.dataset.i)]); });
  }
  function hideResults() { $("#search-results").hidden = true; }
  function pickResult(h) {
    hideResults(); $("#q").blur();
    pushRecent(h);
    if (h.kind === "resort" || (h.kind === "recent" && h.srcKind === "resort")) { WX.ov.selectResort(h.id); return; }
    M().flyTo({ center: [h.lon, h.lat], zoom: Math.max(M().getZoom(), 7), duration: 900 });
    WX.fn.openPoint(h.lat, h.lon, h.unnamed ? undefined : h.name);
  }

  WX.search = { wireSearch, hideResults, runSearch, paintResults, pickResult, favs, isFav, toggleFav, showFavs };
})();
