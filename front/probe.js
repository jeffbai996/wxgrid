// Value under the cursor for the layer on screen: a picker that follows the
// mouse.
// No extra request either way. On the GPU path the number comes out of the
// same decoded field the shader coloured the pixel from (WX.field.sample), so
// the chip, the pin and the marker flag say what the map is showing to the
// resolution the field was encoded at. Without that path the layer PNG is
// decoded into an offscreen canvas and read back through the legend's colour
// ramp, which is a nearest-colour guess and all the picture can offer. Wind
// and waves come straight from the particle field. Hover only — touch devices
// have the tap-to-open card.
(function () {
  "use strict";
  const WX = window.WX;
  let img = null, data = null, forUrl = "", lut = null, lutLayer = "", chip = null, raf = 0, last = null;

  const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + Math.max(-89.99, Math.min(89.99, lat)) * Math.PI / 360));
  function imagePixel(lng, lat) {
    const model = WX.fn.modelEntry();
    let x, y;
    if (model.regional) {
      const [west, south, east, north] = model.domain;
      if (lng < west || lng > east || lat < south || lat > north) return null;
      x = (lng - west) / (east - west) * data.w;
      const yn = mercatorY(north), ys = mercatorY(south);
      y = (yn - mercatorY(lat)) / (yn - ys) * data.h;
    } else {
      x = (((lng + 180) / 360 % 1 + 1) % 1) * data.w;
      const yn = mercatorY(89.99), ys = mercatorY(-89.99);
      y = (yn - mercatorY(lat)) / (yn - ys) * data.h;
    }
    return { x: Math.max(0, Math.min(data.w - 1, Math.floor(x))),
      y: Math.max(0, Math.min(data.h - 1, Math.floor(y))) };
  }

  // Keyed by layer AND level: geopotential height uses a different ramp at
  // every pressure level, so a lookup cached by name alone read 850 hPa
  // heights off the 500 hPa scale.
  function ramp(layer, level) {
    const cat = WX.catalog && WX.catalog.layers.find((l) => l.layer === layer);
    if (!cat) return null;
    const lg = (level && cat.levels && cat.levels[level]) || cat;
    const key = `${layer}/${level || 0}`;
    if (lutLayer === key && lut) return lut;
    const cols = new Array(256);
    for (let i = 0; i < 256; i++) {
      const v = lg.lo + (lg.hi - lg.lo) * i / 255;
      let a = lg.stops[0], b = lg.stops[lg.stops.length - 1];
      for (let k = 0; k < lg.stops.length - 1; k++) if (v >= lg.stops[k].v && v <= lg.stops[k + 1].v) { a = lg.stops[k]; b = lg.stops[k + 1]; break; }
      const q = b.v === a.v ? 0 : Math.max(0, Math.min(1, (v - a.v) / (b.v - a.v)));
      cols[i] = { v, rgb: a.rgb.map((x, j) => x + (b.rgb[j] - x) * q) };
    }
    lut = { lg, cols }; lutLayer = key;
    return lut;
  }

  // Decode the layer PNG the map is showing (same URL → browser cache). The
  // GPU path has the field itself and never wants this image.
  function refresh() {
    if (WX.field && WX.field.live) { data = null; forUrl = ""; return; }
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
      if (WX.fn && WX.fn.updateMarkerFlag) WX.fn.updateMarkerFlag();
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
    const r = ramp(layer, WX.state.level); if (!r) return null;
    // Layers whose "nothing here" is a real zero rather than an absence.
    const ZERO = ["tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "cape", "uvi", "fog", "solar"];
    let v;
    if (WX.field && WX.field.live) {
      const got = WX.field.sample(lng, lat);
      if (!got) return null;                       // the field is still decoding
      if (!got.valid) return { text: ZERO.includes(layer) ? "0" : "—", sub: r.lg.units };
      v = got.v;
    } else {
      if (!data) return null;
      const pixel = imagePixel(lng, lat); if (!pixel) return null;
      const { x, y } = pixel;
      const i = (y * data.w + x) * 4;
      const R = data.px[i], G = data.px[i + 1], B = data.px[i + 2], A = data.px[i + 3];
      if (A === 0) return { text: ZERO.includes(layer) ? "0" : "—", sub: r.lg.units };
      let best = 0, bd = 1e9;
      for (let k = 0; k < 256; k++) { const c = r.cols[k].rgb; const d = (c[0] - R) ** 2 + (c[1] - G) ** 2 + (c[2] - B) ** 2; if (d < bd) { bd = d; best = k; } }
      v = r.cols[best].v;
    }
    if (["wind", "gust", "gfactor"].includes(layer)) return { text: `${Math.round(WX.speed(v))} ${WX.speedUnit()}`, sub: "" };
    const U = WX.units;
    // Same conversion table as the legend — a probe that says metres under a
    // legend that says feet is worse than either alone (Jeff 2026-08-20).
    const conv = { temp: () => U.tempC(v), d2m: () => U.tempC(v), feels: () => U.tempC(v),
                   wbt: () => U.tempC(v), sst: () => U.tempC(v),
                   dt24: () => ({ txt: U.tempUnit === "°F" ? `${Math.round(v * 1.8)} °F/24h` : `${Math.round(v)} °C/24h` }),
                   vis: () => ({ txt: U.altUnit === "ft" ? `${Math.round(v * 0.621371)} mi` : `${Math.round(v)} km` }),
                   msl: () => U.press(v * 100), frz: () => U.alt(v), cbase: () => U.alt(v), gh: () => U.alt(v),
                   tp6: () => U.precip(v), tp24: () => U.precip(v), tp72: () => U.precip(v),
                   sf6: () => U.snow(v), sf24: () => U.snow(v), sf72: () => U.snow(v), sd_cm: () => U.snow(v),
                   waves: () => U.alt(v, 1), swell: () => U.alt(v, 1), windsea: () => U.alt(v, 1) }[layer];
    if (conv) { const c = conv(); return { text: c.txt, sub: WX.state.level && ["temp", "gh"].includes(layer) ? `${WX.state.level} hPa` : "" }; }
    const nd = ["tcc", "cloudlow", "cloudmid", "cloudhigh", "fog", "solar", "wavepower", "cape", "rh", "wperiod", "pp1d", "uvi"].includes(layer) ? 0 : 1;
    return { text: `${v.toFixed(nd)} ${r.lg.units}`, sub: WX.state.level && ["temp", "gh"].includes(layer) ? `${WX.state.level} hPa` : "" };
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
  let pinRetry = 0;
  function pinUpdate() {
    if (!pinMarker) return;
    const ll = pinMarker.getLngLat();
    const v = valueAt(ll.lng, ll.lat);
    const el = pinMarker.getElement().querySelector(".val");
    el.innerHTML = v ? `<b>${v.text}</b>${v.sub ? `<span>${v.sub}</span>` : ""}` : "…";
    // the layer image may still be decoding on first placement
    clearTimeout(pinRetry);
    if (!v) pinRetry = setTimeout(() => { refresh(); pinUpdate(); }, 900);
  }
  function pin(ll) {
    if (!pinMarker) {
      const el = document.createElement("div");
      el.className = "wx-pin";
      el.innerHTML = `<div class="flag"><span class="val">…</span><button class="x" type="button" title="Remove" aria-label="Remove this pin">×</button></div><i class="stem"></i><i class="dot"></i>`;
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
          layout: { "text-field": ["get", "txt"], "text-size": 11, "text-font": ["Noto Sans Regular"],
                    "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false },
          paint: { "text-color": "#ffffff", "text-halo-color": "rgba(8,10,14,.75)", "text-halo-width": 1.2 } });
      }
      const src = m.getSource("cityvals");
      // Degree-style fields only. Wind values at towns looked like stray
      // markers ("1 kt" floating over Korea, Jeff 2026-08-19): the basemap
      // often collision-hides the town name while its point still answers a
      // query, leaving the value orphaned — and a wind NUMBER without its
      // direction is half a fact anyway. The particles already show the wind.
      // Town values are retired (Jeff 2026-08-21: "temperatures all over the
      // map"). The source stays so the layer plumbing is inert, not broken.
      const CITY_LAYERS = [];
      if (true || m.getZoom() < 4.2 || !CITY_LAYERS.includes(WX.state.layer)) { src.setData({ type: "FeatureCollection", features: [] }); return; }
      const ids = cityLayerIds();
      const seen = new Set(); const feats = [];
      for (const f of (ids.length ? m.queryRenderedFeatures({ layers: ids }) : [])) {
        const name = f.properties && (f.properties.name || f.properties["name:en"]);
        if (!name || seen.has(name) || f.geometry.type !== "Point") continue;
        seen.add(name);
        const [lng, lat] = f.geometry.coordinates;
        const v = valueAt(lng, lat);
        if (!v || v.text === "—") continue;
        // forty towns saying "°C" forty times is noise: degrees compact to 19°
        feats.push({ type: "Feature", properties: { txt: v.text.replace(/\s*°[CF]$/, "°") }, geometry: { type: "Point", coordinates: [lng, lat] } });
        if (feats.length >= 40) break;
      }
      src.setData({ type: "FeatureCollection", features: feats });
    });
  }
  function wireCityValues() {
    WX.map.on("idle", updateCityValues);
  }

  WX.probe = { refresh, hover, pin, pinUpdate, updateCityValues, wireCityValues, valueAt };
})();
