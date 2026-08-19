// One unit system for the whole app. Everything that renders a number goes
// through here, so switching to °F/inches/mph changes the tape, the card, the
// legend, the probe and the cross-section together instead of one of them.
//
//   WX.units.temp(273.15) -> {v: 0, unit: "°C", txt: "0 °C"}
//
// Stored preferences (localStorage): wxgrid.u.temp | .wind | .precip | .snow
// | .dist | .press | .baro | .clock. Wind stays on the legacy wxgrid.units key so an
// existing visitor keeps their choice.
(function () {
  "use strict";
  const WX = window.WX;
  const LS = (k, d) => localStorage.getItem("wxgrid.u." + k) || d;

  const P = {
    temp: LS("temp", "c"),          // c | f
    precip: LS("precip", "mm"),     // mm | in
    snow: LS("snow", "cm"),         // cm | in
    dist: LS("dist", "km"),         // km | mi | nm
    press: LS("press", "hpa"),      // hpa | inhg | mmhg
    clock: LS("clock", "auto"),     // auto | 24 | 12
    tz: LS("tz", "local"),          // local | point | utc
    alt: LS("alt", "m"),            // m | ft
    baro: LS("baro", "metric"),     // metric | feet | flight
  };

  const round = (v, n) => Number(v.toFixed(n));
  const out = (v, unit, n) => v == null || !isFinite(v)
    ? { v: null, unit, txt: "—" }
    : { v: round(v, n), unit, txt: `${round(v, n)} ${unit}` };

  function write(key, value) {
    if (key === "wind") {
      WX.state.units = value;
      localStorage.setItem("wxgrid.units", value);
    } else {
      P[key] = value;
      localStorage.setItem("wxgrid.u." + key, value);
    }
  }

  const U = {
    get pref() { return { ...P, wind: (WX.state && WX.state.units) || "kmh" }; },
    set(key, value) {
      write(key, value);
      document.dispatchEvent(new CustomEvent("wx-units"));
    },
    setMany(values) {
      Object.entries(values).forEach(([key, value]) => write(key, value));
      document.dispatchEvent(new CustomEvent("wx-units"));
    },
    // temperature: store is kelvin
    temp(k, decimals) { if (k == null) return out(null, P.temp === "f" ? "°F" : "°C"); const c = k - 273.15; return P.temp === "f" ? out(c * 9 / 5 + 32, "°F", decimals ?? 0) : out(c, "°C", decimals ?? 0); },
    tempC(c, decimals) { return U.temp(c == null ? null : c + 273.15, decimals); },
    tempDelta(dc) { return P.temp === "f" ? dc * 9 / 5 : dc; },        // a difference, not a reading
    get tempUnit() { return P.temp === "f" ? "°F" : "°C"; },
    // precipitation: store is mm
    precip(mm, decimals) { if (mm == null) return out(null, P.precip === "in" ? "in" : "mm"); return P.precip === "in" ? out(mm / 25.4, "in", decimals ?? 2) : out(mm, "mm", decimals ?? (mm < 10 ? 1 : 0)); },
    get precipUnit() { return P.precip === "in" ? "in" : "mm"; },
    // snow: store is cm (already 10:1 from water equivalent)
    snow(cm, decimals) { if (cm == null) return out(null, P.snow === "in" ? "in" : "cm"); return P.snow === "in" ? out(cm / 2.54, "in", decimals ?? 1) : out(cm, "cm", decimals ?? 0); },
    get snowUnit() { return P.snow === "in" ? "in" : "cm"; },
    // distance: store is km
    dist(km, decimals) { if (km == null) return out(null, P.dist); return P.dist === "mi" ? out(km / 1.609344, "mi", decimals ?? 1) : P.dist === "nm" ? out(km / 1.852, "nm", decimals ?? 1) : out(km, "km", decimals ?? 1); },
    get distUnit() { return P.dist; },
    // altitude / height: store is metres
    alt(m, decimals) { if (m == null) return out(null, P.alt); return P.alt === "ft" ? out(m * 3.28084, "ft", decimals ?? 0) : out(m, "m", decimals ?? 0); },
    get altUnit() { return P.alt; },
    // pressure: store is Pa
    press(pa, decimals) { if (pa == null) return out(null, P.press === "inhg" ? "inHg" : P.press === "mmhg" ? "mmHg" : "hPa"); const hpa = pa / 100; return P.press === "inhg" ? out(hpa / 33.8639, "inHg", decimals ?? 2) : P.press === "mmhg" ? out(hpa * 0.750062, "mmHg", decimals ?? 0) : out(hpa, "hPa", decimals ?? 0); },
    get pressUnit() { return P.press === "inhg" ? "inHg" : P.press === "mmhg" ? "mmHg" : "hPa"; },
    // time: the clock the user asked for, in the zone they asked for
    // the zone of the place currently open in the card, set by app.js
    pointZone: null,
    timeOpts(extra) {
      const o = { ...(extra || {}) };
      if (P.clock === "24") o.hour12 = false; else if (P.clock === "12") o.hour12 = true;
      if (P.tz === "utc") o.timeZone = "UTC";
      else if (P.tz === "point" && U.pointZone) o.timeZone = U.pointZone;
      return o;
    },
    get zoneLabel() { return P.tz === "utc" ? "UTC" : P.tz === "point" && U.pointZone ? U.pointZone.split("/").pop().replace(/_/g, " ") : "local"; },
    time(d, extra) { return new Date(d).toLocaleTimeString(undefined, U.timeOpts({ hour: "numeric", minute: "2-digit", ...(extra || {}) })); },
    dateTime(d, extra) { return new Date(d).toLocaleString(undefined, U.timeOpts(extra)); },
    hour(d) { return new Date(d).toLocaleTimeString(undefined, U.timeOpts({ hour: "numeric" })).replace(":00", ""); },
    // the zone a Date should be read in for day/hour bucketing
    zoned(d) { return P.tz === "utc" ? new Date(new Date(d).getTime() + new Date(d).getTimezoneOffset() * 60000) : new Date(d); },
    get isUTC() { return P.tz === "utc"; },
    get followsPoint() { return P.tz === "point"; },
  };
  WX.units = U;
})();
