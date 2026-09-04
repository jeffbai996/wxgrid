const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: { WX: {} } };
vm.runInNewContext(fs.readFileSync('front/compare.js', 'utf8'), ctx);
const C = ctx.window.WX.compare;
const hour = 3600000;
function series(cadence, end = 24) {
  const steps = Array.from({ length: end / cadence + 1 }, (_, k) => k * cadence);
  return { valid: steps.map(h => new Date(h * hour).toISOString()),
    series: { tp6: steps.map((h, k) => k ? cadence : 0), t2m: steps.map(h => 280 + h) } };
}
test('equal twelve-hour windows across hourly, three-hourly and six-hourly models', () => {
  for (const cadence of [1, 3, 6]) assert.equal(C.rain(series(cadence), 12 * hour, 24 * hour), 12);
});
test('missing buckets and incomplete horizons remain unknown, not dry', () => {
  const d = series(3); d.series.tp6[5] = null;
  assert.equal(C.rain(d, 12 * hour, 24 * hour), null);
  assert.equal(C.rain(series(6), 18 * hour, 30 * hour), null);
  assert.equal(C.rain(series(6), 3 * hour, 15 * hour), null);
});
test('instantaneous fields interpolate only inside available samples', () => {
  assert.equal(C.value(series(6), 't2m', 3 * hour), 283);
  assert.equal(C.value(series(6), 't2m', 25 * hour), null);
  const d = series(6); d.series.t2m[1] = null;
  assert.equal(C.value(d, 't2m', 3 * hour), null);
});
test('comparison starts on a shared six-hour boundary at or after selection', () => {
  assert.equal(C.columns(21 * hour)[0], 24 * hour);
  assert.equal(C.columns(24 * hour)[0], 24 * hour);
});
