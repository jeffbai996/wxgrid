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
  function showFavs() {
    const list = favs();
    if (!list.length) { hideResults(); return; }
    searchHits = list.map((f) => ({ kind: "fav", name: f.name, sub: `${f.lat.toFixed(2)}°, ${f.lon.toFixed(2)}°`, lat: f.lat, lon: f.lon }));
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
  async function runSearch(text, go = false) {
    if (text.length < 2) { hideResults(); return; }
    try {
      const [geo, res] = await Promise.all([WX.api(`${API}/geo?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ hits: [] })), WX.api(`${API}/resorts?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ resorts: [] }))]);
      searchHits = [...res.resorts.map((r) => ({ kind: "resort", name: r.name, sub: `${r.region || ""} ${r.country || ""}`.trim(), lat: r.lat, lon: r.lon, id: r.id })),
                    ...geo.hits.map((h) => ({ kind: "place", name: h.name, sub: h.display.split(",").slice(1, 3).join(",").trim(), lat: h.lat, lon: h.lon }))];
      searchSel = searchHits.length ? 0 : -1;
      if (go && searchHits.length) { pickResult(searchHits[0]); return; }
      paintResults();
    } catch (e) { WX.fn.toast("Search unavailable"); }
  }
  function paintResults() {
    const box = $("#search-results");
    if (!searchHits.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = searchHits.map((h, i) => `<button class="${i === searchSel ? "sel" : ""}" data-i="${i}"><span class="kind ${h.kind}">${h.kind === "fav" ? "★" : h.kind}</span><span>${h.name}</span><span class="sub">${h.sub}</span>${h.kind === "fav" ? `<span class="unfav" data-i="${i}" title="Remove">×</span>` : ""}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = (e) => { if (e.target.classList.contains("unfav")) { const h = searchHits[Number(b.dataset.i)]; toggleFav(h.lat, h.lon); showFavs(); return; } pickResult(searchHits[Number(b.dataset.i)]); });
  }
  function hideResults() { $("#search-results").hidden = true; }
  function pickResult(h) {
    hideResults(); $("#q").blur();
    if (h.kind === "resort") { WX.ov.selectResort(h.id); return; }
    M().flyTo({ center: [h.lon, h.lat], zoom: Math.max(M().getZoom(), 7), duration: 900 });
    WX.fn.openPoint(h.lat, h.lon, h.name);
  }

  WX.search = { wireSearch, hideResults, runSearch, paintResults, pickResult, favs, isFav, toggleFav, showFavs };
})();
