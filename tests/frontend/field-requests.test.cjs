const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: { WX: {} }, AbortController, DOMException, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync('front/field-requests.js', 'utf8'), ctx);
const Queue = ctx.window.WX.FieldRequests;
const tick = () => new Promise(r => setImmediate(r));
test('prefetch is bounded and a selected frame bypasses queued speculation', async () => {
  const starts = [], finish = {};
  const q = new Queue((url) => new Promise(r => { starts.push(url); finish[url] = r; }));
  const jobs = ['a', 'b', 'c'].map(url => q.request(url, false));
  await tick(); assert.deepEqual(starts, ['a']);
  const selected = q.request('d', true);
  await tick(); assert.deepEqual(starts, ['a', 'd']);
  finish.d('d'); finish.a('a'); await tick();
  finish.b('b'); await tick(); finish.c('c');
  await Promise.all([...jobs, selected]);
});
test('obsolete queued and active work aborts while the requested frame survives', async () => {
  const q = new Queue((url, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    if (url === 'keep') resolve(url);
  }));
  const old = q.request('old', true).catch(e => e.name);
  const queued = q.request('queued', false).catch(e => e.name);
  q.retain(new Set(['keep']));
  assert.equal(await q.request('keep', true), 'keep');
  assert.equal(await old, 'AbortError');
  assert.equal(await queued, 'AbortError');
});
test('transient failure retries once; permanent failure does not', async () => {
  let calls = 0;
  const q = new Queue(async () => { if (++calls === 1) throw Object.assign(new Error('503'), { status: 503 }); return 'ok'; }, 1);
  assert.equal(await q.request('a', true), 'ok'); assert.equal(calls, 2);
  let permanent = 0;
  const bad = new Queue(async () => { permanent++; throw Object.assign(new Error('404'), { status: 404 }); }, 1);
  await assert.rejects(bad.request('a', true)); assert.equal(permanent, 1);
});
