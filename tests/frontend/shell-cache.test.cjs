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
