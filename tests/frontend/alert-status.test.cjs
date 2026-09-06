const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Expose just the private HTML helper in the test VM, not in the shipped API.
const source = fs.readFileSync('front/panes.js', 'utf8');
const exportLine = 'window.WXPanes = { render, sunTimes, canSnow };';
assert.ok(source.includes(exportLine));
const ctx = { localStorage: { getItem() { return null; } }, window: { WX: { units: { timeOpts: o => o } } } };
vm.runInNewContext(source.replace(exportLine, 'window.WXPanes = { alertsHtml };'), ctx);
const html = ctx.window.WXPanes.alertsHtml;

test('an empty failed lookup visibly says incomplete, never all-clear', () => {
  const result = html({ alerts: [], alertStatus: { complete: false, unavailable: ['Environment Canada'] } });
  assert.match(result, /Alerts incomplete/);
  assert.match(result, /Environment Canada unavailable/);
  assert.match(result, /role="status"/);
});

test('partial lookup preserves actual warnings alongside its availability note', () => {
  const result = html({ alerts: [{ event: 'Wind warning', source: 'NWS', sev: 3, color: '#f00' }],
    alertStatus: { complete: false, unavailable: ['Environment Canada'] } });
  assert.match(result, /Wind warning/);
  assert.match(result, /Alerts incomplete/);
});

test('unsupported coverage is distinct from a successful empty lookup', () => {
  assert.match(html({ alerts: [], alertStatus: { complete: false, sources: [], unavailable: [] } }), /not available here/);
  assert.equal(html({ alerts: [], alertStatus: { complete: true, sources: ['NWS'], unavailable: [] } }), '');
});

test('provider labels are escaped', () => {
  const result = html({ alerts: [], alertStatus: { unavailable: ['<script>'] } });
  assert.ok(!result.includes('<script>'));
  assert.match(result, /&lt;script&gt;/);
});
