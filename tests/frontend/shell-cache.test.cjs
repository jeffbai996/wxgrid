const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function shell(fetch) {
  const ctx = { URL, fetch, self: { registration: { scope: 'https://example.test/wxgrid/' }, addEventListener() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('front/sw.js', 'utf8'), ctx);
  return vm.runInContext('shellUrls()', ctx);
}
test('successful precache includes the bundle and lazy modules without eager source duplication', async () => {
  const html = fs.readFileSync('front/index.html', 'utf8');
  const urls = await shell(async () => ({ ok: true, text: async () => html }));
  const paths = Array.from(urls, u => new URL(u).pathname);
  assert.ok(paths.includes('/wxgrid/bundle.js'));
  assert.ok(paths.includes('/wxgrid/sounding.js'));
  assert.ok(paths.includes('/wxgrid/vendor/maplibre-gl.js'));
  assert.ok(!paths.includes('/wxgrid/app.js'));
  assert.ok(!paths.includes('/wxgrid/tape.js'));
});
test('HTTP and network failures both include a working fallback shell', async () => {
  for (const fetch of [async () => ({ ok: false }), async () => { throw Error('offline'); }]) {
    const urls = await shell(fetch);
    assert.ok(Array.from(urls).some(u => u.endsWith('/styles.css')));
    assert.ok(Array.from(urls).some(u => u.endsWith('/bundle.js')));
  }
});

function worker(fetch = async () => new Response('{}')) {
  const stores = new Map(), handlers = {};
  const key = req => typeof req === 'string' ? req : req.url;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async keys() { return [...entries.keys()].map(u => new Request(u)); },
        async put(req, res) { entries.set(key(req), res.clone()); },
        async match(req) { const res = entries.get(key(req)); return res && res.clone(); },
        async delete(req) { return entries.delete(key(req)); },
      };
    },
    async match(req, { cacheName }) { return (await this.open(cacheName)).match(req); },
  };
  const self = { registration: { scope: 'https://example.test/wxgrid/' },
    location: { origin: 'https://example.test' }, clients: { async claim() {}, async matchAll() { return []; } },
    addEventListener(type, fn) { handlers[type] = fn; } };
  const ctx = { URL, Request, Response, fetch, caches, self, setTimeout };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('front/sw.js', 'utf8'), ctx);
  return { ctx, stores, handlers, caches, run: code => vm.runInContext(code, ctx) };
}

test('shell activation migrates bounded legacy weather/basemap and preserves independent caches', async () => {
  const w = worker();
  const old = await w.caches.open('wxgrid-v94-runtime');
  for (let i=0; i<225; i++) await old.put(`https://example.test/wxgrid/api/field/gfs/run/${i}`, new Response('pixels'));
  await (await w.caches.open('wxgrid-v94-basemap')).put('https://tiles.openfreemap.org/styles/liberty', new Response('style'));
  await w.caches.open('wxgrid-v94-shell');
  await w.caches.open('wxgrid-v94-data');
  await w.caches.open('unrelated-app');
  await new Promise((resolve, reject) => w.handlers.activate({ waitUntil: p => p.then(resolve, reject) }));
  const runtime = await w.caches.open(w.run('RUNTIME'));
  assert.equal((await runtime.keys()).length, 220);
  assert.equal(await runtime.match('https://example.test/wxgrid/api/field/gfs/run/0'), undefined);
  assert.equal(await (await runtime.match('https://example.test/wxgrid/api/field/gfs/run/224')).text(), 'pixels');
  assert.ok(w.stores.has('unrelated-app'));
  assert.ok(!w.stores.has('wxgrid-v94-shell'));
  assert.ok(!w.stores.has('wxgrid-v94-data'));
  // A subsequent shell update has no reason to touch these stable names.
  await new Promise((resolve, reject) => w.handlers.activate({ waitUntil: p => p.then(resolve, reject) }));
  assert.equal((await runtime.keys()).length, 220);
  assert.ok(!w.run('[RUNTIME, DATA, BASEMAP].some(k => k.includes(VERSION))'));
});

test('API fallback data is bounded and catalog cache-busting uses one key', async () => {
  const w = worker();
  for (let i=0; i<140; i++) await w.run(`networkFirst(new Request('https://example.test/wxgrid/api/point?lat=${i}'), DATA)`);
  const data = await w.caches.open(w.run('DATA'));
  assert.equal((await data.keys()).length, 128);
  for (let i=0; i<4; i++) {
    await w.run(`networkFirst(new Request('https://example.test/wxgrid/api/models?ts=${i}'), DATA, new Request('https://example.test/wxgrid/api/models'))`);
  }
  assert.equal((await data.keys()).filter(r => r.url.includes('/models')).length, 1);
});

test('no-store and streamed responses are never kept; ordinary offline fallback still works', async () => {
  const w = worker();
  const req = new Request('https://example.test/wxgrid/api/point?lat=49');
  w.ctx.req = req;
  await w.run('networkFirst(req, DATA)');
  w.ctx.fetch = async () => { throw Error('offline'); };
  assert.equal(await (await w.run('networkFirst(req, DATA)')).text(), '{}');
  for (const headers of [{ 'cache-control': 'no-store' }, { 'content-type': 'application/x-ndjson' }]) {
    w.ctx.fetch = async () => new Response('live', { headers });
    assert.equal(await (await w.run('networkFirst(req, DATA)')).text(), 'live');
    assert.equal((await (await w.caches.open(w.run('DATA'))).keys()).length, 0);
  }
});

test('current alerts, health and card streams bypass offline fallback', async () => {
  const seen = [], w = worker(async req => { seen.push(req.url); return new Response('live'); });
  for (const path of ['card', 'health', 'health/sources', 'alerts/point', 'alerts/ec']) {
    await new Promise((resolve, reject) => w.handlers.fetch({ request: new Request(`https://example.test/wxgrid/api/${path}`),
      respondWith: p => p.then(resolve, reject), waitUntil() { assert.fail('must not cache'); } }));
  }
  assert.equal(seen.length, 5);
  assert.equal(w.stores.size, 0);
});

test('retired model runs are still pruned from the independent weather cache', async () => {
  const w = worker(), cache = await w.caches.open(w.run('RUNTIME'));
  for (const run of ['old', 'new']) await cache.put(`https://example.test/wxgrid/api/field/gfs/${run}/0/temp.png`, new Response('pixels'));
  await w.run('pruneRuns({models: [{key: "gfs", runs: [{run: "new"}]}]})');
  assert.equal((await cache.keys()).length, 1);
  assert.match((await cache.keys())[0].url, /\/new\//);
});
