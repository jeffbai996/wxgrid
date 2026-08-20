// Value under the cursor for the layer on screen: a picker that follows the
// mouse.
// No extra request: the layer PNG the map already shows is decoded once into
// an offscreen canvas and read back through the legend's colour ramp; wind
// and waves come straight from the particle field. Hover only — touch
// devices have the tap-to-open card.
(function () {
  "use strict";
  const WX = window.WX;
  const N = 1440;                                    // Mercator PNG is N×N
  let img = null, data = null, forUrl = "", lut = null, lutLayer = "", chip = null, raf = 0, last = null;

  function ramp(layer) {
    const lg = WX.catalog && WX.catalog.layers.find((l) => l.layer === layer);
    if (!lg) return null;
    if (lutLayer === layer && lut) return lut;
    const cols = new Array(256);
    for (let i = 0; i < 256; i++) {
      const v = lg.lo + (lg.hi - lg.lo) * i / 255;
      let a = lg.stops[0], b = lg.stops[lg.stops.length - 1];
      for (let k = 0; k < lg.stops.length - 1; k++) if (v >= lg.stops[k].v && v <= lg.stops[k + 1].v) { a = lg.stops[k]; b = lg.stops[k + 1]; break; }
      const q = b.v === a.v ? 0 : Math.max(0, Math.min(1, (v - a.v) / (b.v - a.v)));
      cols[i] = { v, rgb: a.rgb.map((x, j) => x + (b.rgb[j] - x) * q) };
    }
    lut = { lg, cols }; lutLayer = layer;
    return lut;
  }

  // Decode the layer PNG the map is showing (same URL → browser cache).
  function refresh() {
    const url = WX.fn.layerUrl && WX.fn.layerUrl();
    if (!url || url === forUrl) return;
    forUrl = url; data = null;
    const im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => {
      if (url !== forUrl) return;
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(im, 0, 0);
      try { data = { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }; } catch (e) { data = null; }
      if (last) show(last);
      pinUpdate(); updateCityValues();
    };
    im.src = url;
  }

  function valueAt(lng, lat) {
    const layer = WX.state.layer;
    if (["wind", "waves"].includes(layer) && WX.windLayer && WX.windLayer.field) {
      const uv = WX.windLayer.sample(lng, lat);
      if (!uv) return null;
      const spd = Math.hypot(uv[0], uv[1]);
      const dir = (270 - Math.atan2(uv[1], uv[0]) * 180 / Math.PI) % 360;      // FROM, wind convention
      if (layer === "waves") { const h = spd / 3; return { text: WX.units.alt(h, 1).txt, sub: `${WX.arrow((dir + 180) % 360)} ${Math.round((dir + 180) % 360)}°` }; }
      return { text: `${Math.round(WX.speed(spd))} ${WX.speedUnit()}`, sub: `${WX.arrow(dir)} ${Math.round(dir)}°` };
    }
    if (!data) return null;
    const r = ramp(layer); if (!r) return null;
    const x = Math.floor(((lng + 180) / 360 % 1 + 1) % 1 * data.w);
    const s = Math.sin(lat * Math.PI / 180);
    const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * data.h);
    if (y < 0 || y >= data.h) return null;
    const i = (y * data.w + x) * 4;
    const R = data.px[i], G = data.px[i + 1], B = data.px[i + 2], A = data.px[i + 3];
    if (A === 0) return { text: ["tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "cape", "uvi"].includes(layer) ? "0" : "—", sub: r.lg.units };
    let best = 0, bd = 1e9;
    for (let k = 0; k < 256; k++) { const c = r.cols[k].rgb; const d = (c[0] - R) ** 2 + (c[1] - G) ** 2 + (c[2] - B) ** 2; if (d < bd) { bd = d; best = k; } }
    let v = r.cols[best].v;
    if (["wind", "gust"].includes(layer)) return { text: `${Math.round(WX.speed(v))} ${WX.speedUnit()}`, sub: "" };
    const U = WX.units;
    const conv = { temp: () => U.tempC(v), d2m: () => U.tempC(v), msl: () => U.press(v * 100), frz: () => U.alt(v),
                   tp6: () => U.precip(v), tp24: () => U.precip(v), tp72: () => U.precip(v),
                   sf6: () => U.snow(v), sf24: () => U.snow(v), sf72: () => U.snow(v), sd_cm: () => U.snow(v),
                   waves: () => U.alt(v, 1) }[layer];
    if (conv) { const c = conv(); return { text: c.txt, sub: WX.state.level && layer === "temp" ? `${WX.state.level} hPa` : "" }; }
    const nd = ["tcc", "cape", "rh", "wperiod", "uvi"].includes(layer) ? 0 : 1;
    return { text: `${v.toFixed(nd)} ${r.lg.units}`, sub: WX.state.level && ["temp"].includes(layer) ? `${WX.state.level} hPa` : "" };
  }

  function show(ll) {
    last = ll;
    if (!chip) { chip = document.createElement("div"); chip.id = "probe"; chip.hidden = true; document.body.appendChild(chip); }
    if (!ll) { chip.hidden = true; return; }
    const v = valueAt(ll.lng, ll.lat);
    if (!v) { chip.hidden = true; return; }
    chip.innerHTML = `<b>${v.text}</b>${v.sub ? `<span>${v.sub}</span>` : ""}`;
    chip.hidden = false;
    const p = WX.map.project(ll);
    chip.style.transform = `translate(${Math.round(p.x + 14)}px, ${Math.round(p.y + 14)}px)`;
  }
  function hover(ll) {
    if (!matchMedia("(hover: hover)").matches) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => show(ll));
  }

  // ── the pinned picker ──────────────────────────────────────────────────
  // Windy's little flag: a value pill anchored to a draggable point. It reads
  // whatever layer is showing, follows the time scrub, and dragging it is the
  // cheapest way to compare two shores of a strait. One pin; a second request
  // moves it.
  let pinMarker = null;
  function pinUpdate() {
    if (!pinMarker) return;
    const ll = pinMarker.getLngLat();
    const v = valueAt(ll.lng, ll.lat);
    const el = pinMarker.getElement().querySelector(".val");
    el.innerHTML = v ? `<b>${v.text}</b>${v.sub ? `<span>${v.sub}</span>` : ""}` : "…";
  }
  function pin(ll) {
    if (!pinMarker) {
      const el = document.createElement("div");
      el.className = "wx-pin";
      el.innerHTML = `<div class="flag"><span class="val">…</span><button class="x" title="Remove">×</button></div><i class="stem"></i><i class="dot"></i>`;
      pinMarker = new maplibregl.Marker({ element: el, draggable: true, anchor: "bottom" });
      pinMarker.setLngLat(ll).addTo(WX.map);
      pinMarker.on("drag", pinUpdate);
      el.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); pinMarker.remove(); pinMarker = null; });
    } else pinMarker.setLngLat(ll);
    pinUpdate();
  }

  // ── layer values on the towns ──────────────────────────────────────────
  // The basemap already decides which places deserve a label at this zoom;
  // borrow those anchors and hang the field's value under each. No toggle:
  // it is on when a sampleable layer is, and stays out of the way at world
  // zooms where the labels would carpet the map.
  let cityRaf = 0;
  function cityLayerIds() {
    return WX.map.getStyle().layers.filter((l) => l.type === "symbol" && /place|city|town/i.test(l.id)).map((l) => l.id);
  }
  function updateCityValues() {
    cancelAnimationFrame(cityRaf);
    cityRaf = requestAnimationFrame(() => {
      const m = WX.map;
      if (!m.getSource("cityvals")) {
        m.addSource("cityvals", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({ id: "cityvals", type: "symbol", source: "cityvals",
          layout: { "text-field": ["get", "txt"], "text-size": 11, "text-font": ["Noto Sans Medium"],
                    "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false },
          paint: { "text-color": "#ffffff", "text-halo-color": "rgba(8,10,14,.75)", "text-halo-width": 1.2 } });
      }
      const src = m.getSource("cityvals");
      if (m.getZoom() < 4.2) { src.setData({ type: "FeatureCollection", features: [] }); return; }
      const ids = cityLayerIds();
      const seen = new Set(); const feats = [];
      for (const f of (ids.length ? m.queryRenderedFeatures({ layers: ids }) : [])) {
        const name = f.properties && (f.properties.name || f.properties["name:en"]);
        if (!name || seen.has(name) || f.geometry.type !== "Point") continue;
        seen.add(name);
        const [lng, lat] = f.geometry.coordinates;
        const v = valueAt(lng, lat);
        if (!v || v.text === "—") continue;
        feats.push({ type: "Feature", properties: { txt: v.text }, geometry: { type: "Point", coordinates: [lng, lat] } });
        if (feats.length >= 40) break;
      }
      src.setData({ type: "FeatureCollection", features: feats });
    });
  }
  function wireCityValues() {
    WX.map.on("idle", updateCityValues);
  }

  WX.probe = { refresh, hover, pin, pinUpdate, updateCityValues, wireCityValues };
})();
