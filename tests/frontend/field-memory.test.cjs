const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(r => setImmediate(r));

function harness({ delay = false } = {}) {
  const pending = [], textures = new Set(), listeners = {};
  const model = { regional: false, grid_spec: { nx: 3001, ny: 1401, lon0: -180, lat0: 90, dlon: 0.1, dlat: -0.1 } };
  const bytes = model.grid_spec.nx * model.grid_spec.ny * 4;
  let peakGpu = 0;
  const gl = new Proxy({
    createTexture() { const t = {}; textures.add(t); return t; },
    deleteTexture(t) { textures.delete(t); },
    bindTexture(type, t) { this.bound = t; },
    texImage2D(...args) {
      const img = args.at(-1);
      if (this.bound) this.bound.bytes = img.data?.byteLength || 1024;
      peakGpu = Math.max(peakGpu, [...textures].reduce((n, t) => n + (t.bytes || 0), 0));
    },
    createShader() { return {}; }, createProgram() { return {}; }, createBuffer() { return {}; },
    getShaderParameter() { return true; }, getProgramParameter(p, name) { return name === 'ACTIVE_UNIFORMS' ? 0 : true; },
    getUniformLocation() { return {}; }, getAttribLocation() { return 0; },
  }, { get(t, p) { return p in t ? t[p] : /^[A-Z_0-9]+$/.test(p) ? p : () => {}; } });
  const canvas = { addEventListener(k, fn) { listeners[k] = fn; }, removeEventListener(k) { delete listeners[k]; } };
  const map = { triggerRepaint() {}, getCanvas: () => canvas, getPaintProperty: () => 1, getZoom: () => 3,
    getBounds: () => ({ getWest: () => -180, getEast: () => 180 }) };
  const context = { window: { WX: { map } }, console: { info() {} },
    AbortController, DOMException, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '' }, localStorage: { getItem: () => null }, WebGLRenderingContext: class {},
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    createImageBitmap: async () => {
      if (delay) await new Promise(resolve => pending.push(resolve));
      return { width: model.grid_spec.nx, height: model.grid_spec.ny, close() {} };
    },
    OffscreenCanvas: class {
      getContext() { return { drawImage() {}, getImageData() {
        const data = new Proxy({ byteLength: bytes }, { get(t, p) { return p in t ? t[p] : Number(p) % 4 === 1 ? 1 : Number(p) % 4 === 2 ? 255 : 0; } });
        return { width: model.grid_spec.nx, height: model.grid_spec.ny, data };
      } }; }
    },
  };
  vm.createContext(context);
  for (const file of ['field-requests.js', 'field.js']) vm.runInContext(fs.readFileSync(`front/${file}`, 'utf8'), context);
  const field = context.window.WX.field;
  field.enable({ field: { v: 1 }, layers: [{ layer: 'temp', enc: { lo: 0, hi: 65535 }, lo: 0, hi: 1,
    stops: [{ v: 0, rgb: [0, 0, 0] }, { v: 1, rgb: [255, 255, 255] }] }] });
  field.layer.onAdd(map, gl);
  function show(a, b = null) { field.show({ a, b, t: b ? 0.5 : 0, layer: 'temp', model }); }
  function render() { field.layer.render(gl, { shaderData: { variantName: 'test', vertexShaderPrelude: '', define: '' },
    defaultProjectionData: { mainMatrix: [], fallbackMatrix: [], tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 0], projectionTransition: 0 } }); }
  function bounded() {
    const m = field.memory;
    assert.ok(m.cpuBytes + m.reservedBytes <= m.cpuLimit, JSON.stringify(m));
    assert.ok(m.gpuBytes <= m.gpuLimit, JSON.stringify(m));
  }
  return { field, show, render, bounded, pending, bytes, listeners, map, gl, peak: () => peakGpu };
}

test('100-step scrubbing bounds CPU, decode reservations and displayed textures', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    h.show(`a${i}`, `b${i}`); await tick(); h.bounded(); h.render(); h.bounded();
    h.field.prefetch(`p${i}`); await tick(); h.bounded();
    assert.equal(h.field.sample(-100, 30).v, 1);
  }
  assert.equal(h.field.memory.gpuBytes, h.bytes * 2);
  assert.ok(h.peak() <= h.field.memory.gpuLimit + 1024); // separate tiny LUT
  h.field.layer.onRemove(h.map, h.gl);
  assert.equal(h.field.memory.gpuBytes, 0);
  assert.ok(h.field.memory.cpuBytes <= h.bytes * 2);
});

test('late aborted decodes release reservations and cannot re-enter cache', async () => {
  const h = harness({ delay: true });
  h.show('old-a', 'old-b'); await tick(); h.bounded();
  h.show('new-a', 'new-b'); await tick(); h.bounded();
  for (let i = 0; i < 8; i++) {
    for (const resolve of h.pending.splice(0)) resolve();
    await tick(); h.bounded();
  }
  assert.equal(h.field.shown.a.url, 'new-a');
  assert.equal(h.field.memory.reservedBytes, 0);
  assert.equal(h.field.memory.entries, 2);
});

test('context loss resets accounting and restores only shown textures', async () => {
  const h = harness(); h.show('a', 'b'); await tick(); h.render();
  h.listeners.webglcontextlost();
  assert.equal(h.field.memory.gpuBytes, 0);
  h.listeners.webglcontextrestored(); h.render(); h.bounded();
  assert.equal(h.field.memory.gpuBytes, h.bytes * 2);
});

test('texture allocation failure releases both cache budgets through fallback', async () => {
  const h = harness(); h.show('a', 'b'); await tick();
  h.gl.createTexture = () => null;
  h.render();
  assert.equal(h.field.live, false);
  assert.equal(h.field.memory.gpuBytes, 0);
  assert.equal(h.field.memory.cpuBytes, 0);
});
