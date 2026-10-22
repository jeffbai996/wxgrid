const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(reduced = false) {
  const animations = [], overlays = [];
  const table = { cloneNode: () => ({ style: {} }), getBoundingClientRect: () => ({ width: 900 }) };
  const tape = {
    firstElementChild: table, scrollLeft: 120, scrollTop: 0, clientWidth: 600, clientHeight: 180,
    getBoundingClientRect: () => ({ left: 10, top: 200, width: 600, height: 180 }),
    animate: (frames, options) => {
      const a = { frames, options, cancel() { this.cancelled = true; } };
      animations.push(a); return a;
    },
    parentElement: {
      getBoundingClientRect: () => ({ left: 0, top: 100 }),
      append: el => overlays.push(el),
    },
  };
  const document = { createElement: () => ({ style: {}, append(el) { this.child = el; }, remove() { this.removed = true; } }) };
  const ctx = { window: { WX: { state: {} } }, localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: reduced }), document };
  const source = fs.readFileSync('front/tape.js', 'utf8').replace('WX.tape = {', 'WX.tape = { animateTapeChange,');
  vm.runInNewContext(source, ctx);
  return { animate: ctx.window.WX.tape.animateTapeChange, tape, animations, overlays };
}

test('slice change preserves the outgoing viewport until the incoming tape settles', () => {
  const f = fixture(); let renders = 0;
  f.animate(f.tape, () => { renders++; });
  assert.equal(renders, 1);
  assert.equal(f.overlays.length, 1);
  assert.equal(f.overlays[0].inert, true);
  assert.equal(f.overlays[0].scrollLeft, 120);
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].frames[0].opacity, 0);
  f.animations[0].onfinish();
  assert.equal(f.overlays[0].removed, true);
});

test('rapid slice changes cancel the prior animation and remove its snapshot', () => {
  const f = fixture();
  f.animate(f.tape, () => {});
  f.animate(f.tape, () => {});
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.overlays[0].removed, true);
  assert.equal(f.overlays[1].removed, undefined);
});

test('reduced motion changes slices immediately without snapshots or animation', () => {
  const f = fixture(true); let renders = 0;
  f.animate(f.tape, () => { renders++; });
  assert.equal(renders, 1);
  assert.equal(f.animations.length, 0);
  assert.equal(f.overlays.length, 0);
});
