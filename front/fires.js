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
  const CSS = `
  .fire-pop .maplibregl-popup-content {
    background: var(--panel-solid, #0a0b0d); color: var(--fg, #eef1f5);
    border: 1px solid var(--line-strong, rgba(255,255,255,.18)); border-radius: var(--radius, 14px);
    padding: 12px 14px 11px; min-width: 208px; max-width: 268px;
    font-family: var(--font-body, system-ui, sans-serif); font-size: 12px; line-height: 1.45;
    box-shadow: 0 10px 30px rgba(0,0,0,.45);
  }
  .fire-pop .maplibregl-popup-tip { border-top-color: var(--line-strong, rgba(255,255,255,.18)); border-bottom-color: var(--line-strong, rgba(255,255,255,.18)); }
  .fire-pop .maplibregl-popup-close-button { color: var(--dim, #7c8492); font-size: 17px; padding: 2px 7px 4px; background: none; }
  .fire-pop .maplibregl-popup-close-button:hover { color: var(--fg, #eef1f5); background: none; }
  .fire-pop h4 {
    margin: 0 16px 2px 0; font-family: var(--font-display, system-ui, sans-serif);
    font-size: 15px; font-weight: 700; letter-spacing: .1px; line-height: 1.2;
  }
  .fire-pop .fp-agency { color: var(--dim, #7c8492); font-size: 11px; margin-bottom: 9px; }
  .fire-pop .fp-status { display: inline-block; margin-bottom: 9px; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: .35px; text-transform: uppercase; }
  .fire-pop dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; }
  .fire-pop dt { color: var(--dim, #7c8492); font-size: 11px; }
  .fire-pop dd { margin: 0; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; text-align: right; }
  .fire-pop a.fp-link {
    display: block; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line, rgba(255,255,255,.09));
    color: var(--accent, #ff8a3d); font-size: 11px; text-decoration: none; font-weight: 600;
  }
  .fire-pop a.fp-link:hover { text-decoration: underline; }
  .fire-pop .fp-src { color: var(--dim, #7c8492); font-size: 10px; margin-top: 7px; }
  `;
  let styled = false;
  function injectCss() {
    if (styled) return;
    const el = document.createElement("style");
    el.id = "fire-pop-css";
    el.textContent = CSS;
    document.head.appendChild(el);
    styled = true;
  }

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

  function card(p) {
    const rows = [];
    if (p.area_ha != null && p.area_ha !== "") {
      const ha = Number(p.area_ha);
      rows.push(["Size", `${num(ha)} ha<br><span style="opacity:.6">${num(ha * 2.4710538)} ac</span>`]);
    }
    if (p.contained_pct != null && p.contained_pct !== "") rows.push(["Contained", `${Math.round(Number(p.contained_pct))}%`]);
    const started = when(p.started);
    if (started) rows.push(["Discovered", started]);
    const updated = when(p.updated);
    if (updated) rows.push(["Updated", updated]);
    if (p.cause) rows.push(["Cause", esc(p.cause)]);
    if (p.state) rows.push(["State", esc(p.state)]);
    const colour = /out of control/i.test(p.status || "") ? "#ff3a1d" : /being held|active/i.test(p.status || "") ? "#ff8a3d" : "#ffc857";
    return `<h4>${esc(p.name || "Unnamed fire")}</h4>
      <div class="fp-agency">${esc(p.agency || "")}${p.id ? ` · ${esc(p.id)}` : ""}</div>
      ${p.status ? `<span class="fp-status" style="background:${colour}22;color:${colour};border:1px solid ${colour}55">${esc(p.status)}</span>` : ""}
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${p.url ? `<a class="fp-link" href="${esc(p.url)}" target="_blank" rel="noopener">Agency incident page ↗</a>` : ""}
      <div class="fp-src">${esc(p.source || "")}${p.kind === "perimeter" ? " · mapped perimeter" : ""}</div>`;
  }

  let popup = null;
  function openCard(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    injectCss();
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ className: "fire-pop", closeButton: true, maxWidth: "280px", offset: 12 })
      .setLngLat(f.geometry.type === "Point" ? f.geometry.coordinates.slice(0, 2) : e.lngLat)
      .setHTML(card(f.properties))
      .addTo(M());
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
    toast(`${fires} incidents, ${perims} perimeters. Tap for details.`, 6000);
  }

  function clear() {
    if (popup) { popup.remove(); popup = null; }
    LAYERS.slice().reverse().forEach((l) => M().getLayer(l) && M().removeLayer(l));
    if (M().getSource(SRC)) M().removeSource(SRC);
    if (WX.ov && WX.ov.clearFires) WX.ov.clearFires();
  }

  WX.fires = { load, clear };
})();
