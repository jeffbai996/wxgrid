// Things in the sky that are not weather: the aurora nowcast, and an honest
// note about lightning. Loaded after overlays.js; exposes WX.sky.
//
// Aurora comes from NOAA SWPC's OVATION model as a 1° JSON grid of "chance of
// seeing the aurora", which the API projects and colours into one Web-Mercator
// PNG — the same ImageSource trick the model layers use, so it drapes the
// whole world with no tile fetches and no local distortion. The badge carries
// the planetary Kp index, because that is the number people actually check.
//
// Lightning is deliberately absent. See wxgrid/radar.py for what was checked;
// the short version is that no keyless near-real-time strike feed exists that
// we are allowed to redistribute, and we would rather say so than scrape a
// volunteer network that gates its data.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, API, state, url: U } = WX;
  const M = () => WX.map;
  const WORLD = [[-180, 85.05112878], [180, 85.05112878], [180, -85.05112878], [-180, -85.05112878]];
  const SRC = "aurora", LAYER = "aurora";

  // The overlays module owns the badge stack; fall back to a toast if it is
  // somehow not loaded, so sky.js never hard-depends on load order.
  const badge = (k, html, color) => (WX.ov && WX.ov.badge ? WX.ov.badge(k, html, color) : null);
  const toast = (m, ms, kind) => WX.fn.toast(m, ms, kind);

  let auroraTimer = null, auroraReq = 0;

  // ── aurora ────────────────────────────────────────────────────────────
  async function loadAurora(quiet) {
    const my = ++auroraReq;
    let meta = null;
    try {
      meta = await WX.api(U(`${API}/radar/aurora.json`));
    } catch (e) {
      if (my !== auroraReq) return;
      toast("Aurora nowcast unavailable. SWPC did not answer.", 4500, "error");
      state.aurora = false;
      const b = $("#aurora-toggle"); if (b) b.classList.remove("on");
      return;
    }
    if (my !== auroraReq || state.aurora === false) return;
    state.auroraMeta = meta;
    // Cache-bust on the observation time, not the wall clock: re-adding the
    // same nowcast should reuse the browser's copy.
    const stamp = encodeURIComponent(meta.observation_time || String(Date.now()));
    const url = U(`${API}/radar/aurora.png?t=${stamp}`);
    if (M().getSource(SRC)) M().getSource(SRC).updateImage({ url, coordinates: WORLD });
    else {
      // No `attribution` here on purpose: MapLibre's source_image spec allows
      // only {type, url, coordinates} and has no wildcard, so an extra key
      // fails validation and the source is dropped *silently* — addSource does
      // not throw, it fires an error event and returns. The credit rides on the
      // badge and the toast instead, same as app.js's own "wx" image source.
      M().addSource(SRC, { type: "image", url, coordinates: WORLD });
      M().addLayer({ id: LAYER, type: "raster", source: SRC,
                     paint: { "raster-opacity": 0.85, "raster-fade-duration": 0, "raster-resampling": "linear" } }, WX.fn.firstSymbolId());
    }
    showAuroraBadge();
    // OVATION is recomputed every ~5 min; follow it while the layer is on.
    clearInterval(auroraTimer);
    auroraTimer = setInterval(() => { if (state.aurora) loadAurora(true); else clearInterval(auroraTimer); }, 5 * 60 * 1000);
    if (!quiet) {
      const kp = meta.kp ? ` Kp ${fmtKp(meta.kp)}.` : "";
      toast(`OVATION nowcast for ${hhmm(meta.forecast_time)}Z. Peak ${meta.max_pct}% chance.${kp}`
            + ` Below ${meta.min_pct}% is drawn as nothing.`, 6000);
    }
  }

  function fmtKp(kp) { return (Math.round(kp.kp * 10) / 10).toFixed(1); }
  function hhmm(iso) { return iso ? String(iso).slice(11, 16) : "—"; }

  function showAuroraBadge() {
    const m = state.auroraMeta; if (!m) return;
    // Kp is the storm scale everyone quotes: under 4 is quiet, 5+ is a storm.
    const kp = m.kp ? fmtKp(m.kp) : null;
    const hot = m.kp && m.kp.kp >= 5;
    badge("aurora", `Aurora <b>${m.max_pct}%</b> <small>${hhmm(m.forecast_time)}Z${kp ? ` · Kp ${kp}` : ""}</small>`,
          hot ? "var(--warm, #ffb454)" : "#5ee08a");
  }

  function clearAurora() {
    auroraReq++;
    clearInterval(auroraTimer); auroraTimer = null;
    if (M().getLayer(LAYER)) M().removeLayer(LAYER);
    if (M().getSource(SRC)) M().removeSource(SRC);
    state.auroraMeta = null;
    badge("aurora", null);
  }

  // ── lightning ─────────────────────────────────────────────────────────
  // No layer to draw. load() explains why once, rather than pretending the
  // toggle does something. The API answers with the same text so the reason
  // lives in one place (wxgrid/radar.py) and can be read from /api/docs.
  const LIGHTNING_FALLBACK = "No keyless real-time lightning observation feed exists — NASA GIBS carries only "
    + "climatologies, NWS retired nowCOAST's GLM service, and Blitzortung gates its data behind station membership. "
    + "The Thunder overlay shows model CAPE + precipitation instead: a forecast, not observed strikes.";

  async function loadLightning() {
    let why = LIGHTNING_FALLBACK;
    try { const j = await WX.api(U(`${API}/radar/lightning`)); if (j && j.reason) why = `${j.reason} ${j.alternative || ""}`.trim(); } catch (e) { /* use the built-in text */ }
    toast(why, 11000, "error");
    state.lightning = false;
    const b = $("#lightning-toggle"); if (b) b.classList.remove("on");
  }
  function clearLightning() { /* nothing was ever drawn */ }

  WX.sky = {
    aurora: { load: loadAurora, clear: clearAurora },
    lightning: { load: loadLightning, clear: clearLightning },
  };
})();
