// SIGMET / AIRMET / G-AIRMET hazard areas from the NOAA Aviation Weather
// Center, via /api/sigmet/layer. Hazard-coloured translucent fills with a
// label at the centre; tap one for the altitude band, the validity window and
// the raw bulletin. Loaded after overlays.js; exposes itself as WX.sigmet.
(function () {
  "use strict";
  const WX = window.WX;
  const { API, toast } = WX;
  const M = () => WX.map;
  const SRC = "sigmet-data";
  // Bottom-to-top: fills, outlines, the dashed freezing-level contours, labels.
  // Removed in reverse.
  const LAYERS = ["sigmet-fill", "sigmet-line", "sigmet-fzl", "sigmet-lbl"];

  // ── styling ───────────────────────────────────────────────────────────
  // Injected rather than added to styles.css so the module carries its own
  // presentation; the values are the app's tokens, so it follows the theme.
  // Presentation is the shared map card in styles.css (`.mapcard`).
  function injectCss() {}

  // Same colours the server sends on every feature; kept here as the fallback
  // and for the labels, which are drawn from the hazard word, not the feature.
  const COLOR = { CONVECTIVE: "#ff3a1d", TS: "#ff6b35", TURB: "#c77dff", ICE: "#5bc8ff",
                  IFR: "#9aa7b4", MTW: "#ffd166", ASH: "#b07d4a", TC: "#ff4fa3", OTHER: "#8a8f98" };
  const TITLE = { CONVECTIVE: "Convective SIGMET", TS: "Thunderstorms", TURB: "Turbulence", ICE: "Icing",
                  IFR: "IFR / low visibility", MTW: "Mountain wave", ASH: "Volcanic ash",
                  TC: "Tropical cyclone", OTHER: "Hazard" };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Aviation reads 18 000 ft and above as a flight level.
  const alt = (ft) => ft == null ? null : ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : ft <= 0 ? "SFC" : `${Math.round(ft).toLocaleString()} ft`;
  function band(base, top) {
    if (base == null && top == null) return null;
    return `${alt(base) || "SFC"} – ${alt(top) || "unspecified"}`;
  }
  function when(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  }

  // ── popup ─────────────────────────────────────────────────────────────
  const HAZ_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>`;
  function cardSpec(p) {
    const colour = p.color || COLOR[p.hazard] || COLOR.OTHER;
    const from = when(p.valid_from), to = when(p.valid_to);
    return {
      icon: HAZ_SVG, color: colour, title: TITLE[p.hazard] || p.hazard || "Hazard", pill: p.severity || "",
      sub: `${p.kind || ""}${p.hazard_raw && p.hazard_raw !== p.hazard ? ` · ${p.hazard_raw}` : ""}`, ago: to ? `until ${to}` : "",
      hero: [(p.base_ft != null || p.top_ft != null) && { k: "Base", v: alt(p.base_ft) || "SFC" },
             (p.base_ft != null || p.top_ft != null) && { k: "Top", v: alt(p.top_ft) || "unspecified" }],
      rows: [["Valid", from || to ? `${from || "—"} → ${to || "—"}` : ""], ["Moving", p.movement], ["Area", p.area ? String(p.area).slice(0, 60) : ""]],
      raw: p.raw || "", src: p.source || "", maxWidth: "320px" };
  }

  // One line for the toast fallback, so a tap still says something useful on a
  // phone where the popup would cover the map.
  const line = (p) => `${TITLE[p.hazard] || p.hazard}${p.severity ? ` · ${p.severity}` : ""}${band(p.base_ft, p.top_ft) ? ` · ${band(p.base_ft, p.top_ft)}` : ""}${p.valid_to ? ` · until ${when(p.valid_to)}` : ""}`;

  let popup = null;
  function openCard(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    injectCss();
    if (window.matchMedia && window.matchMedia("(max-width: 560px)").matches) {
      WX.fn.toast(line(f.properties), 6000);
      return;
    }
    if (popup) popup.remove();
    popup = WX.mapCard(e.lngLat, "sig-pop", cardSpec(f.properties));
  }

  // ── layer ─────────────────────────────────────────────────────────────
  let bound = false;
  function bind() {
    if (bound) return;
    M().on("click", "sigmet-fill", openCard);
    // A freezing-level line has no interior, so it only answers when nothing
    // is filled under the tap.
    M().on("click", "sigmet-fzl", (e) => {
      if (M().queryRenderedFeatures(e.point, { layers: ["sigmet-fill"] }).length) return;
      openCard(e);
    });
    ["sigmet-fill", "sigmet-fzl"].forEach((l) => {
      M().on("mouseenter", l, () => { M().getCanvas().style.cursor = "pointer"; });
      M().on("mouseleave", l, () => { M().getCanvas().style.cursor = ""; });
    });
    bound = true;
  }

  // Severe hazards read harder: opacity and outline weight ride the 1-4 sev
  // the server derived from the qualifier word.
  const FILL_OPACITY = ["interpolate", ["linear"], ["coalesce", ["get", "sev"], 2], 1, 0.10, 4, 0.26];
  const LINE_WIDTH = ["interpolate", ["linear"], ["coalesce", ["get", "sev"], 2], 1, 0.9, 4, 2.0];

  async function load() {
    injectCss();
    let gj;
    try {
      gj = await WX.api(`${API}/sigmet/layer`);
    } catch (err) {
      WX.fn.toast("SIGMET data unavailable", 4000, "error");
      return;
    }
    if (WX.state.sigmet === false) return;                // toggled off while we fetched
    if (M().getSource(SRC)) { M().getSource(SRC).setData(gj); bind(); return; }

    M().addSource(SRC, { type: "geojson", data: gj, attribution: "SIGMET/AIRMET: NOAA Aviation Weather Center" });
    const under = WX.fn.firstSymbolId();
    M().addLayer({ id: "sigmet-fill", type: "fill", source: SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": ["coalesce", ["get", "color"], "#8a8f98"], "fill-opacity": FILL_OPACITY } }, under);
    M().addLayer({ id: "sigmet-line", type: "line", source: SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": ["coalesce", ["get", "color"], "#8a8f98"], "line-width": LINE_WIDTH, "line-opacity": 0.9 } }, under);
    // G-AIRMET freezing levels are contours, not areas — dashed, and their own
    // layer because line-dasharray takes no data-driven expression.
    M().addLayer({ id: "sigmet-fzl", type: "line", source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ["coalesce", ["get", "color"], "#8a8f98"], "line-width": 1.4,
               "line-opacity": 0.85, "line-dasharray": [3, 2] } }, under);
    M().addLayer({ id: "sigmet-lbl", type: "symbol", source: SRC, minzoom: 3,
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: { "text-field": ["get", "hazard"],
                "text-size": 10.5, "text-font": ["Noto Sans Bold"], "text-anchor": "center",
                "text-optional": true, "text-allow-overlap": false,
                "symbol-sort-key": ["-", 0, ["coalesce", ["get", "sev"], 2]] },
      paint: { "text-color": ["coalesce", ["get", "color"], "#8a8f98"],
               "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.3 } });
    bind();

    const c = gj.counts || {};
    const total = (gj.features || []).length;
    // Top two hazard kinds only: the full census overflows the pill and the
    // map already shows every area anyway.
    const parts = ["CONVECTIVE", "TS", "TURB", "ICE", "IFR", "MTW", "ASH", "TC"].filter((h) => c[h])
      .sort((a, b) => c[b] - c[a]).slice(0, 2).map((h) => `${c[h]} ${h}`);
    toast(total ? `${total} SIGMET/AIRMET areas · mostly ${parts.join(", ")} · tap one for detail`
                : "No SIGMETs or AIRMETs in force right now.", 6500);
  }

  function clear() {
    if (popup) { popup.remove(); popup = null; }
    LAYERS.slice().reverse().forEach((l) => M().getLayer(l) && M().removeLayer(l));
    if (M().getSource(SRC)) M().removeSource(SRC);
  }

  WX.sigmet = { load, clear };
})();
