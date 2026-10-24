// Compare like periods, even when the models store different step lengths.
(function () {
  "use strict";
  const HOUR = 3600e3;
  const times = (d) => d.valid.map((v) => new Date(v).getTime());

  function value(d, variable, at) {
    const ts = times(d), values = d.series[variable];
    if (!values) return null;
    const b = ts.findIndex((t) => t >= at);
    if (b < 0 || values[b] == null) return null;
    if (ts[b] === at) return values[b];
    if (!b || values[b - 1] == null || ts[b] - ts[b - 1] > 6 * HOUR) return null;
    const f = (at - ts[b - 1]) / (ts[b] - ts[b - 1]);
    return values[b - 1] + f * (values[b] - values[b - 1]);
  }

  function rain(d, start, end) {
    const ts = times(d), values = d.series.tp6;
    const a = ts.indexOf(start), b = ts.indexOf(end);
    // A bucket ends at its valid time. Never scale a partial bucket or
    // substitute zero for an absent hour; those would invent dry weather.
    if (!values || a < 0 || b <= a) return null;
    let total = 0;
    for (let k = a + 1; k <= b; k++) {
      if (values[k] == null) return null;
      total += values[k];
    }
    return total;
  }

  function columns(at) {
    const start = Math.ceil(at / (6 * HOUR)) * 6 * HOUR;
    return Array.from({ length: 8 }, (_, k) => start + k * 12 * HOUR);
  }
  window.WX.compare = { value, rain, columns };
})();
