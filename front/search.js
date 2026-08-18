// Place + resort search box with a results dropdown. Loaded after app.js;
// exposes WX.search.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── search: places + resorts ──────────────────────────────────────────
  let searchTimer = null, searchSel = -1, searchHits = [];
  function wireSearch() {
    const q = $("#q");
    q.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q.value.trim()), 350); };
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
    box.innerHTML = searchHits.map((h, i) => `<button class="${i === searchSel ? "sel" : ""}" data-i="${i}"><span class="kind ${h.kind}">${h.kind}</span><span>${h.name}</span><span class="sub">${h.sub}</span></button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => pickResult(searchHits[Number(b.dataset.i)]));
  }
  function hideResults() { $("#search-results").hidden = true; }
  function pickResult(h) {
    hideResults(); $("#q").blur();
    if (h.kind === "resort") { WX.ov.selectResort(h.id); return; }
    M().flyTo({ center: [h.lon, h.lat], zoom: Math.max(M().getZoom(), 7), duration: 900 });
    WX.fn.openPoint(h.lat, h.lon, h.name);
  }

  WX.search = { wireSearch, hideResults, runSearch, paintResults, pickResult };
})();
