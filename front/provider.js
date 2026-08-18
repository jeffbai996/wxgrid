// National met-service badge for the country under the cursor. Drawn as our
// own monogram rather than the agency's logo — those are trademarks and this
// repo is MIT. Country from a Natural Earth 110 m polygon set bundled
// in data/countries.json (public domain), point-in-polygon on a throttled
// mousemove; the map centre on touch devices. Nothing shown when there is
// no national service to credit for the spot (open ocean, Antarctica).
(function () {
  "use strict";
  const WX = window.WX;
  // [full name, brand colour, short code for the generated chip]
  const PROVIDERS = {
    US: ["NOAA · National Weather Service", "#1a5fb4", "NOAA"], CA: ["Environment and Climate Change Canada", "#c8102e", "ECCC"],
    MX: ["SMN · Servicio Meteorológico Nacional", "#006847", "SMN"], GB: ["Met Office", "#0d5f9c", "MET"], IE: ["Met Éireann", "#169b62", "MÉ"],
    DE: ["DWD · Deutscher Wetterdienst", "#0a4a8f", "DWD"], FR: ["Météo-France", "#1f4fa3", "MF"], ES: ["AEMET", "#c60b1e", "AEMET"], PT: ["IPMA", "#046a38", "IPMA"],
    IT: ["Aeronautica Militare / ItaliaMeteo", "#008c45", "AM"], NL: ["KNMI", "#ff6f00", "KNMI"], BE: ["RMI / KMI", "#ffd90f", "RMI"], CH: ["MeteoSwiss", "#d52b1e", "MCH"],
    AT: ["GeoSphere Austria", "#c8102e", "GSA"], NO: ["MET Norway", "#ba0c2f", "MET"], SE: ["SMHI", "#006aa7", "SMHI"], FI: ["FMI", "#0033a0", "FMI"], DK: ["DMI", "#c60c30", "DMI"],
    IS: ["Veðurstofa Íslands", "#02529c", "VÍ"], PL: ["IMGW", "#dc143c", "IMGW"], CZ: ["ČHMÚ", "#11457e", "ČHMÚ"], AU: ["Bureau of Meteorology", "#00205b", "BOM"],
    NZ: ["MetService", "#1d3f8c", "MS"], JP: ["JMA · 気象庁", "#bc002d", "JMA"], KR: ["KMA", "#0047a0", "KMA"], CN: ["CMA · 中国气象局", "#de2910", "CMA"],
    IN: ["IMD", "#ff9933", "IMD"], BR: ["INMET", "#009c3b", "INMET"], AR: ["SMN Argentina", "#74acdf", "SMN"], CL: ["Meteochile", "#d52b1e", "DMC"], ZA: ["SAWS", "#007749", "SAWS"],
    RU: ["Roshydromet", "#0039a6", "RHM"], TR: ["MGM", "#e30a17", "MGM"], GR: ["HNMS", "#0d5eaf", "HNMS"], SG: ["MSS", "#ef3340", "MSS"], HK: ["Hong Kong Observatory", "#de2910", "HKO"],
    TW: ["CWA", "#fe0000", "CWA"], PH: ["PAGASA", "#0038a8", "PAG"], ID: ["BMKG", "#ce1126", "BMKG"], TH: ["TMD", "#2d2a4a", "TMD"], VN: ["NCHMF", "#da251d", "NCH"],
    IL: ["IMS", "#0038b8", "IMS"], AE: ["NCM", "#00732f", "NCM"], SA: ["NCM", "#006c35", "NCM"], EG: ["EMA", "#ce1126", "EMA"], KE: ["KMD", "#006600", "KMD"], NG: ["NiMet", "#008751", "NiMet"],
    PE: ["SENAMHI", "#d91023", "SNM"], CO: ["IDEAM", "#fcd116", "IDEAM"], CU: ["INSMET", "#002a8f", "INS"],
  };
  let countries = null, loading = null, last = null, lastAt = 0, hideTimer = null;
  const el = () => document.getElementById("provider");

  function pip(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }
  function inGeom(lon, lat, g) {
    if (g.type === "Polygon") return pip(lon, lat, g.coordinates[0]) && !g.coordinates.slice(1).some((h) => pip(lon, lat, h));
    if (g.type === "MultiPolygon") return g.coordinates.some((poly) => pip(lon, lat, poly[0]));
    return false;
  }
  function countryAt(lon, lat) {
    if (!countries) return null;
    for (const f of countries.features) if (inGeom(lon, lat, f.geometry)) return f.properties.iso;
    return null;
  }
  // The public build never ships another organisation's logo — those are
  // trademarks. It draws a monogram chip in the service's brand colour
  // instead: clearly ours, still recognisable at a glance. An operator's
  // private overlay (private/theme.js) can supply the real marks.
  // Brand colours are chosen for print, not for a black map: navy on black is
  // invisible. Pull the colour toward the theme's opposite until it reads.
  function readable(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const light = document.documentElement.dataset.theme === "light";
    const mix = (c, t, k) => Math.round(c + (t - c) * k);
    if (!light && lum < 0.34) { const k = (0.34 - lum) * 1.5; r = mix(r, 255, k); g = mix(g, 255, k); b = mix(b, 255, k); }
    if (light && lum > 0.72) { const k = (lum - 0.72) * 1.6; r = mix(r, 0, k); g = mix(g, 0, k); b = mix(b, 0, k); }
    return `rgb(${r},${g},${b})`;
  }

  function monogram(abbr, colour) {
    colour = readable(colour);
    const w = Math.max(30, 9 + abbr.length * 8.2);
    return `<svg class="mono" viewBox="0 0 ${w} 26" width="${w}" height="26" role="img" aria-label="${abbr}">
      <rect x="0.6" y="0.6" width="${w - 1.2}" height="24.8" rx="7" fill="${colour}" fill-opacity="0.22" stroke="${colour}" stroke-opacity="0.65"/>
      <text x="${w / 2}" y="17.6" text-anchor="middle" fill="${colour}" style="font:700 11px var(--font-display);letter-spacing:.02em">${abbr}</text>
    </svg>`;
  }

  function show(iso) {
    const box = el(); if (!box) return;
    const p = iso && PROVIDERS[iso];
    if (!p) { box.classList.remove("show"); last = null; return; }
    if (last === iso && box.classList.contains("show")) return;
    // fade out → swap → fade in, so a border crossing reads as a change
    // A private overlay (private/theme.js) may supply real agency marks; the
    // public build shows the wordmark and a colour dot.
    const logo = window.WX_PRIVATE && window.WX_PRIVATE.logos && window.WX_PRIVATE.logos[iso];
    const swap = () => {
      const dot = box.querySelector(".dot");
      if (logo) { dot.innerHTML = `<img src="${logo.file}" alt="" class="${logo.dark_bg_ok === false ? "chip" : ""}">`; dot.classList.add("logo"); dot.style.background = "transparent"; }
      else if (p[2]) { dot.innerHTML = monogram(p[2], p[1]); dot.classList.add("logo"); dot.style.background = "transparent"; }
      else { dot.innerHTML = ""; dot.classList.remove("logo"); dot.style.background = p[1]; dot.style.color = p[1]; }
      box.querySelector(".txt").innerHTML = `${logo && logo.name ? logo.name : p[0]} <small>${iso}</small>`;
      box.classList.add("show"); last = iso; };
    if (box.classList.contains("show")) { box.classList.remove("show"); clearTimeout(hideTimer); hideTimer = setTimeout(swap, 180); } else swap();
  }
  function hover(ll) {
    const now = performance.now();
    if (!ll) { show(null); return; }
    if (now - lastAt < 120) return;
    lastAt = now;
    if (!countries) { if (!loading) loading = fetch("data/countries.json").then((r) => r.json()).then((j) => { countries = j; hover(ll); }).catch(() => {}); return; }
    show(countryAt(((ll.lng + 180) % 360 + 360) % 360 - 180, ll.lat));
  }
  WX.provider = { hover, PROVIDERS };
})();
