const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('front/panes.js', 'utf8').replace(
  'window.WXPanes = { render, sunTimes, canSnow };',
  'window.WXPanes = { windRows, windPeriod, windCard };');
const ctx = { localStorage: { getItem: () => null }, document: { querySelectorAll: () => [] }, window: { WX: { speed: x => x * 3.6, speedUnit: () => 'km/h', arrow: () => '↑',
  state: {}, units: { timeOpts: x => ({ ...x, timeZone: 'UTC' }), dateTime: x => String(x) },
  validDate: new Date('2030-01-01T00:00:00Z') } } };
vm.runInNewContext(source, ctx);
const P = ctx.window.WXPanes;
const hour = 3600000;
function forecast(cadence = 6, end = 240) {
  const steps = Array.from({ length: Math.floor(end / cadence) + 1 }, (_, i) => i * cadence);
  return { steps, valid: steps.map(h => new Date(Date.UTC(2030, 0, 1) + h * hour).toISOString()),
    series: { wind: steps.map((_, k) => k + 1), gust: steps.map((_, k) => k + 3), wdir: steps.map(() => 180) } };
}

test('six-hour wind forecasts expose a full week of real samples from the selected time', () => {
  const f = forecast(), rows = P.windRows(f, 2);
  assert.equal(rows.length, 29);
  assert.equal(rows[0][0], Date.parse(f.valid[2]));
  assert.equal(rows.at(-1)[0] - rows[0][0], 168 * hour);
  assert.equal(rows[0][1], f.series.wind[2]);
  assert.equal(P.windPeriod(rows), 'next 7 days');
});

test('hourly forecasts retain every hourly sample without resampling', () => {
  assert.equal(P.windRows(forecast(1), 0).length, 169);
});

test('short model horizons stop at available data and report their actual period', () => {
  const rows = P.windRows(forecast(6, 36), 0);
  assert.equal(rows.length, 7);
  assert.equal(P.windPeriod(rows), 'next 36 h');
  assert.equal(P.windPeriod(P.windRows(forecast(6, 36), 6)), 'forecast end');
});

test('missing wind samples retain real time gaps and missing gusts remain unknown', () => {
  const f = forecast(); f.series.wind[1] = null; f.series.gust[2] = null;
  const rows = P.windRows(f, 0);
  assert.equal(rows[1][0] - rows[0][0], 12 * hour);
  assert.equal(rows[1][2], null);
});

test('the expanded wind chart uses all week samples and daily ticks without noon clutter', () => {
  const html = P.windCard(forecast(), 0, 168);
  const rows = JSON.parse(html.match(/data-rows="([^"]+)"/)[1].replace(/&quot;/g, '"'));
  assert.equal(rows.length, 29);
  assert.doesNotMatch(html, />noon</);
  assert.match(html, /class="day"/);
});
