const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(api = async () => ({ observation_time: '2030-01-01T00:00:00Z' })) {
  const layers = [{ id: 'weather' }, { id: 'labels', type: 'symbol' }], sources = new Map(), classes = new Set();
  const map = { getLayer: id => layers.find(l => l.id === id), getSource: id => sources.get(id),
    addSource: (id, source) => sources.set(id, { ...source, updateImage() {} }),
    addLayer: (layer, before) => layers.splice(layers.findIndex(l => l.id === before), 0, layer),
    removeLayer: id => layers.splice(layers.findIndex(l => l.id === id), 1),
    removeSource: id => sources.delete(id) };
  const WX = { state: { aurora: true }, map, $: () => ({ classList: { remove() {} } }),
    API: '/api', url: s => s, api, fn: { firstSymbolId: () => 'labels', toast() {} } };
  vm.runInNewContext(fs.readFileSync('front/sky.js', 'utf8'), { window: { WX },
    document: { body: { classList: { add: s => classes.add(s), remove: s => classes.delete(s) } } },
    setInterval: () => 1, clearInterval() {} });
  return { WX, layers, classes, sky: WX.sky };
}

test('aurora dims the map beneath its overlay and leaves labels above it', async () => {
  const f = fixture(); await f.sky.aurora.load(true);
  const ids = f.layers.map(l => l.id);
  assert.ok(ids.indexOf('weather') < ids.indexOf('aurora-dim'));
  assert.ok(ids.indexOf('aurora-dim') < ids.indexOf('aurora'));
  assert.ok(ids.indexOf('aurora') < ids.indexOf('labels'));
  assert.ok(f.classes.has('aurora-active'));
});

test('turning aurora off removes the dimmer and restores the wind canvas', async () => {
  const f = fixture(); await f.sky.aurora.load(true); f.sky.aurora.clear();
  assert.equal(f.layers.some(l => l.id === 'aurora-dim' || l.id === 'aurora'), false);
  assert.equal(f.classes.has('aurora-active'), false);
});

test('refreshing aurora keeps a single dimmer', async () => {
  const f = fixture(); await f.sky.aurora.load(true); await f.sky.aurora.load(true);
  assert.equal(f.layers.filter(l => l.id === 'aurora-dim').length, 1);
});

test('a failed aurora refresh clears the previous overlay and dimming', async () => {
  const f = fixture(); await f.sky.aurora.load(true);
  f.WX.api = async () => { throw new Error('unavailable'); };
  await f.sky.aurora.load(true);
  assert.equal(f.WX.state.aurora, false);
  assert.equal(f.classes.has('aurora-active'), false);
  assert.equal(f.layers.some(l => l.id === 'aurora-dim' || l.id === 'aurora'), false);
});

test('a late aurora response cannot dim the map after the overlay was turned off', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.sky.aurora.load(true);
  f.WX.state.aurora = false; f.sky.aurora.clear(); resolve({}); await pending;
  assert.equal(f.classes.has('aurora-active'), false);
  assert.equal(f.layers.some(l => l.id === 'aurora-dim'), false);
});
