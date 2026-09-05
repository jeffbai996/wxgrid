// Wildfire incidents + perimeters with the agency record behind them: CIFFC
// (Canada), NIFC WFIGS (USA), NRCan CWFIS M3 (Canadian perimeters). Draws on
// top of the satellite-hotspot WMS raster that WX.ov.loadFires() already adds,
// so you see the heat and the paperwork at once. Loaded after overlays.js;
// exposes itself as WX.fires.
(function () {
  "use strict";
  const WX = window.WX;
  const { API, toast } = WX;
  const M = () => WX.map;
  const SRC = "fire-data";
  // Bottom-to-top: fills, outlines, dots, labels. Removed in reverse.
  const LAYERS = ["fire-perim-fill", "fire-perim-line", "fire-inc", "fire-lbl"];

  // ── styling ───────────────────────────────────────────────────────────
  // Injected rather than added to styles.css so the module carries its own
  // presentation; the values are the app's tokens, so it follows the theme.
  // Presentation is the shared map card in styles.css (`.mapcard`).
  function injectCss() {}

  // Out of control → being held → under control, and the US containment
  // percentage folded onto the same three-step ramp.
  const HEAT = ["case",
    ["==", ["get", "status"], "Out of control"], "#ff3a1d",
    ["==", ["get", "status"], "Being held"], "#ff8a3d",
    ["==", ["get", "status"], "Under control"], "#ffc857",
    ["==", ["get", "status"], "Contained"], "#ffc857",
    [">=", ["coalesce", ["get", "contained_pct"], -1], 60], "#ffc857",
    [">", ["coalesce", ["get", "contained_pct"], -1], 0], "#ff8a3d",
    "#ff3a1d"];
  // Radius on log10(hectares): a 0.1 ha spot and a 300 000 ha campaign fire
  // have to share one legend, and linear scaling makes every fire in Canada
  // one pixel or the whole province.
  const RADIUS = ["interpolate", ["linear"], ["log10", ["max", ["coalesce", ["get", "area_ha"], 0.1], 0.1]],
    -1, 4, 0, 4.5, 1, 6, 2, 8.5, 3, 12, 4, 17, 5.7, 26];

  // ── popup ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 10 ? n.toFixed(0) : n.toFixed(1));

  function when(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const days = Math.floor((Date.now() - d) / 864e5);
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}${days >= 1 ? ` · ${days} d` : ""}`;
  }

  const FLAME = (colour) => `<svg viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;
  function cardSpec(p) {
    const colour = /out of control/i.test(p.status || "") ? "#ff3a1d" : /being held|active/i.test(p.status || "") ? "#ff8a3d" : "#ffc857";
    const ha = p.area_ha != null && p.area_ha !== "" ? Number(p.area_ha) : null;
    const started = when(p.started), updated = when(p.updated);
    return {
      icon: FLAME(colour), color: colour, title: p.name || "Unnamed fire", pill: p.status || "",
      sub: [p.agency, p.id].filter(Boolean).join(" · "), ago: updated ? updated.split(" · ").pop() : "",
      hero: [ha != null && { k: "Size", v: num(ha), unit: "ha", note: `${num(ha * 2.4710538)} ac` },
             p.contained_pct != null && p.contained_pct !== "" && { k: "Contained", v: Math.round(Number(p.contained_pct)), unit: "%" },
             started && { k: "Discovered", v: started.split(" · ")[0], note: started.includes(" · ") ? started.split(" · ")[1] : "" }],
      rows: [["Updated", updated], ["Cause", p.cause], ["State", p.state]],
      src: `${p.source || ""}${p.kind === "perimeter" ? " · mapped perimeter" : ""}`,
      link: p.url ? { href: p.url, text: "Agency incident page" } : null, maxWidth: "300px" };
  }

  let popup = null;
  function openCard(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    injectCss();
    if (popup) popup.remove();
    popup = WX.mapCard(f.geometry.type === "Point" ? f.geometry.coordinates.slice(0, 2) : e.lngLat, "fire-pop", cardSpec(f.properties));
  }

  // ── layer ─────────────────────────────────────────────────────────────
  let bound = false;
  function bind() {
    if (bound) return;
    // Points first: a dot inside a perimeter should answer with the incident.
    M().on("click", "fire-inc", openCard);
    M().on("click", "fire-perim-fill", (e) => {
      if (M().queryRenderedFeatures(e.point, { layers: ["fire-inc"] }).length) return;
      openCard(e);
    });
    ["fire-inc", "fire-perim-fill"].forEach((l) => {
      M().on("mouseenter", l, () => { M().getCanvas().style.cursor = "pointer"; });
      M().on("mouseleave", l, () => { M().getCanvas().style.cursor = ""; });
    });
    bound = true;
  }

  async function load() {
    injectCss();
    if (WX.ov && WX.ov.loadFires) WX.ov.loadFires();     // hotspot raster underneath
    let gj;
    try {
      gj = await WX.api(`${API}/fires/layer`);
    } catch (err) {
      WX.fn.toast("Wildfire incident data unavailable", 4000, "error");
      return;
    }
    if (WX.state.fires === false) return;                 // toggled off while we fetched
    if (M().getSource(SRC)) { M().getSource(SRC).setData(gj); bind(); return; }

    M().addSource(SRC, { type: "geojson", data: gj, attribution: "Fires: CIFFC, NRCan CWFIS, NIFC WFIGS" });
    const perim = ["==", ["get", "kind"], "perimeter"];
    const inc = ["==", ["get", "kind"], "incident"];
    const under = WX.fn.firstSymbolId();
    M().addLayer({ id: "fire-perim-fill", type: "fill", source: SRC, filter: perim,
      paint: { "fill-color": HEAT, "fill-opacity": 0.3 } }, under);
    M().addLayer({ id: "fire-perim-line", type: "line", source: SRC, filter: perim,
      paint: { "line-color": HEAT, "line-width": 1.3, "line-opacity": 0.9 } }, under);
    M().addLayer({ id: "fire-inc", type: "circle", source: SRC, filter: inc,
      paint: { "circle-radius": RADIUS, "circle-color": HEAT, "circle-opacity": 0.72,
               "circle-stroke-color": "#2a0d02", "circle-stroke-width": 1.1, "circle-stroke-opacity": 0.85 } });
    M().addLayer({ id: "fire-lbl", type: "symbol", source: SRC, filter: inc, minzoom: 6,
      layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top",
                "text-font": ["Noto Sans Bold"], "text-optional": true, "text-allow-overlap": false,
                "symbol-sort-key": ["-", 0, ["coalesce", ["get", "area_ha"], 0]] },
      paint: { "text-color": "#ffd9b0", "text-halo-color": "rgba(0,0,0,.85)", "text-halo-width": 1.3 } });
    bind();

    const c = gj.counts || {};
    const fires = (c["CA:incident"] || 0) + (c["US:incident"] || 0);
    const perims = (c["CA:perimeter"] || 0) + (c["US:perimeter"] || 0);
    toast(`${fires} incidents, ${perims} perimeters · tap for details`, 6000);
  }

  function clear() {
    if (popup) { popup.remove(); popup = null; }
    LAYERS.slice().reverse().forEach((l) => M().getLayer(l) && M().removeLayer(l));
    if (M().getSource(SRC)) M().removeSource(SRC);
    if (WX.ov && WX.ov.clearFires) WX.ov.clearFires();
  }

  WX.fires = { load, clear };
})();
