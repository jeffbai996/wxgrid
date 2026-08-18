// National met-service badge for the country under the cursor (Windy does
// this with logos; we do it with wordmarks — the logos are trademarks and
// this repo is MIT). Country from a Natural Earth 110 m polygon set bundled
// in data/countries.json (public domain), point-in-polygon on a throttled
// mousemove; the map centre on touch devices. Nothing shown when there is
// no national service to credit for the spot (open ocean, Antarctica).
(function () {
  "use strict";
  const WX = window.WX;
  const PROVIDERS = {
    US: ["NOAA · National Weather Service", "#1a5fb4"], CA: ["Environment and Climate Change Canada", "#c8102e"],
    MX: ["SMN · Servicio Meteorológico Nacional", "#006847"], GB: ["Met Office", "#0d5f9c"], IE: ["Met Éireann", "#169b62"],
    DE: ["DWD · Deutscher Wetterdienst", "#0a4a8f"], FR: ["Météo-France", "#1f4fa3"], ES: ["AEMET", "#c60b1e"], PT: ["IPMA", "#046a38"],
    IT: ["Aeronautica Militare / ItaliaMeteo", "#008c45"], NL: ["KNMI", "#ff6f00"], BE: ["RMI / KMI", "#ffd90f"], CH: ["MeteoSwiss", "#d52b1e"],
    AT: ["GeoSphere Austria", "#c8102e"], NO: ["MET Norway", "#ba0c2f"], SE: ["SMHI", "#006aa7"], FI: ["FMI", "#0033a0"], DK: ["DMI", "#c60c30"],
    IS: ["Veðurstofa Íslands", "#02529c"], PL: ["IMGW", "#dc143c"], CZ: ["ČHMÚ", "#11457e"], AU: ["Bureau of Meteorology", "#00205b"],
    NZ: ["MetService", "#1d3f8c"], JP: ["JMA · 気象庁", "#bc002d"], KR: ["KMA", "#0047a0"], CN: ["CMA · 中国气象局", "#de2910"],
    IN: ["IMD", "#ff9933"], BR: ["INMET", "#009c3b"], AR: ["SMN Argentina", "#74acdf"], CL: ["Meteochile", "#d52b1e"], ZA: ["SAWS", "#007749"],
    RU: ["Roshydromet", "#0039a6"], TR: ["MGM", "#e30a17"], GR: ["HNMS", "#0d5eaf"], SG: ["MSS", "#ef3340"], HK: ["Hong Kong Observatory", "#de2910"],
    TW: ["CWA", "#fe0000"], PH: ["PAGASA", "#0038a8"], ID: ["BMKG", "#ce1126"], TH: ["TMD", "#2d2a4a"], VN: ["NCHMF", "#da251d"],
    IL: ["IMS", "#0038b8"], AE: ["NCM", "#00732f"], SA: ["NCM", "#006c35"], EG: ["EMA", "#ce1126"], KE: ["KMD", "#006600"], NG: ["NiMet", "#008751"],
    PE: ["SENAMHI", "#d91023"], CO: ["IDEAM", "#fcd116"], CU: ["INSMET", "#002a8f"],
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
  function show(iso) {
    const box = el(); if (!box) return;
    const p = iso && PROVIDERS[iso];
    if (!p) { box.classList.remove("show"); last = null; return; }
    if (last === iso && box.classList.contains("show")) return;
    // fade out → swap → fade in, so a border crossing reads as a change
    const swap = () => { box.querySelector(".txt").innerHTML = `${p[0]} <small>${iso}</small>`; box.querySelector(".dot").style.background = p[1]; box.querySelector(".dot").style.color = p[1]; box.classList.add("show"); last = iso; };
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
