const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function probe(degrees, layer = 'wind') {
  const angle = degrees * Math.PI / 180;
  const WX = { state: { layer }, speed: v => v * 3.6, speedUnit: () => 'km/h', arrow: () => '↖',
    units: { alt: v => ({ txt: `${v} m` }) },
    windLayer: { field: {}, sample: () => [-Math.sin(angle) * 6, -Math.cos(angle) * 6] } };
  vm.runInNewContext(fs.readFileSync('front/probe.js', 'utf8'), { window: { WX } });
  return WX.probe.valueAt(0, 0);
}

test('wind readouts add a sixteen-point direction using the wind-from bearing', () => {
  for (const [degrees, expected] of [[0, 'N'], [22.5, 'NNE'], [45, 'NE'], [141, 'SE'], [180, 'S'], [270, 'W'], [359, 'N']]) {
    const value = probe(degrees);
    assert.equal(value.compass, expected);
    assert.match(value.sub, /°$/);
    assert.equal(value.text, '22 km/h');
  }
});

test('compass sectors change halfway between neighboring directions', () => {
  assert.equal(probe(11.24).compass, 'N');
  assert.equal(probe(11.26).compass, 'NNE');
  assert.equal(probe(348.74).compass, 'NNW');
  assert.equal(probe(348.76).compass, 'N');
});

test('wave bearings retain their existing convention and do not get a wind label', () => {
  assert.equal(probe(141, 'waves').compass, undefined);
});
