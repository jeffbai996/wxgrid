// The field layer: the model grid as data, coloured on the GPU.
//
// /api/field ships each (model, run, step, layer, level) as a 16-bit PNG of
// the store grid itself (R high byte, G low byte, B = 1 where the model has
// a value). This module fetches and decodes those, keeps the last few as
// textures, and draws them through a MapLibre custom layer: every screen
// pixel is projected back onto the grid, sampled cubically IN VALUE SPACE,
// mixed with the next step by `t`, faded by the same alpha rule the server
// publishes for the layer, and looked up in a 256-entry LUT built from the
// catalog ramp. A layer, level or unit change is therefore a uniform and a
// LUT, not a new image; a scrub between two steps is a `t`.
//
// The same decoded bytes answer the probe (WX.field.sample), so the value
// under the cursor is the value the pixel was coloured from.
//
// Contract with app.js:
//   WX.field.enable(catalog)          decide once whether this path is live
//   WX.field.live                     true when the GPU path is drawing
//   WX.field.layer                    the CustomLayerInterface to add as "wx-field"
//   WX.field.show(spec)               what to draw: {a, b, t, layer, level, model}
//   WX.field.prefetch(url)            warm the cache for a neighbouring step
//   WX.field.sample(lng, lat)         {v, valid} at a point, as drawn
//   WX.field.ready()                  true once there are pixels on screen
//   WX.field.shown                    what is on screen, for the console
//   WX.field.onFallback = (why) => {} called once if the path has to give up
(function () {
  "use strict";
  const WX = window.WX;

  const CACHE_BYTES = 96 * 1024 * 1024;     // decoded fields kept for instant scrubbing
  const RULE_KIND = { const: 0, ramp: 1, abs: 2, fall: 3, step: 4, mask: 5 };
  // Categorical and accumulated fields hold their step: a 6-hour bucket half
  // mixed with the next is not a quantity anyone measured.
  const SNAP_LAYERS = new Set(["ptype", "tp6", "tp24", "tp72", "sf6", "sf24", "sf72"]);
  // Drawn as cells, not as a surface. Precipitation type is a code, so a pixel
  // between a rain cell and a snow cell is one or the other, never the mixed
  // colour halfway along the ramp. Everything else, accumulations included,
  // is a continuous field in space and interpolates.
  const CELL_LAYERS = new Set(["ptype"]);

  const mercY = (lat) => 0.5 - Math.log(Math.tan(Math.PI / 4 + Math.max(-89.99, Math.min(89.99, lat)) * Math.PI / 360)) / (2 * Math.PI);
  const mercX = (lng) => (lng + 180) / 360;

  // ── decoded fields ─────────────────────────────────────────────────────
  const cache = new Map();          // url → entry
  let cacheBytes = 0;
  let serial = 0;

  function evict(gl) {
    const entries = [...cache.values()].filter((e) => e.img).sort((a, b) => a.used - b.used);
    while (cacheBytes > CACHE_BYTES && entries.length > 2) {
      const e = entries.shift();
      if (e === shown.a || e === shown.b) continue;
      if (pending && (e === pending.a || e === pending.b)) continue;
      cache.delete(e.url);
      cacheBytes -= e.bytes;
      if (e.tex && gl) gl.deleteTexture(e.tex);
      e.tex = null; e.img = null;
    }
  }

  async function decodeBlob(blob) {
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch (e) {
      // Older Safari: no options bag, or no createImageBitmap at all
      bmp = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = rej;
        im.src = URL.createObjectURL(blob);
      });
    }
    const w = bmp.width, h = bmp.height;
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    // The mask channel is only ever 0 or 255. Anything else means the
    // browser colour-managed the bytes on the way through the canvas, and
    // the values would be quietly wrong; the PNG path is the safe answer.
    const px = img.data;
    for (let k = 0; k < 64; k++) {
      const i = Math.floor(k / 64 * (w * h)) * 4 + 2;
      if (px[i] !== 0 && px[i] !== 255) throw new Error("field bytes altered by the canvas");
    }
    return img;
  }

  function entryFor(url) {
    let e = cache.get(url);
    if (e) { e.used = ++serial; return e; }
    e = { url, img: null, tex: null, bytes: 0, used: ++serial, failed: false, promise: null };
    e.promise = (async () => {
      // fetch() sends Accept */*, which says nothing; ask for WebP outright
      // (~30 % fewer bytes, same lossless values) and let the server fall
      // back to PNG.
      const res = await fetch(url, { headers: { Accept: "image/webp,image/png;q=0.9,*/*;q=0.5" } });
      if (!res.ok) { const err = new Error(String(res.status)); err.status = res.status; throw err; }
      const img = await decodeBlob(await res.blob());
      e.img = img; e.bytes = img.data.byteLength;
      cacheBytes += e.bytes;
      return e;
    })().catch((err) => { e.failed = true; e.error = err; throw err; });
    cache.set(url, e);
    return e;
  }

  // ── what is on screen ──────────────────────────────────────────────────
  const shown = { a: null, b: null, t: 0, layer: "", level: 0, model: null, snap: false, cells: false, ramp: null, rule: null, enc: null };
  let catalog = null;
  let live = false;
  let gaveUp = false;

  function fallback(why) {
    if (gaveUp) return;
    gaveUp = true; live = false;
    console.info(`wxgrid field path: raster png (${why})`);
    if (WX.field.onFallback) WX.field.onFallback(why);
  }

  function rampFor(layer, level) {
    const cat = catalog && catalog.layers.find((l) => l.layer === layer);
    if (!cat) return null;
    return (level && cat.levels && cat.levels[level]) || cat;
  }

  // Same 256 bins as the server's _lut: v = lo + (hi - lo) * i / 255,
  // colours linearly between stops, clamped at the ends, truncated to bytes.
  function buildLut(lg) {
    const out = new Uint8Array(256 * 4);
    const st = lg.stops;
    for (let i = 0; i < 256; i++) {
      const v = lg.lo + (lg.hi - lg.lo) * i / 255;
      let a = st[0], b = st[st.length - 1];
      if (v <= st[0].v) b = a;
      else if (v >= b.v) a = b;
      else for (let k = 0; k < st.length - 1; k++) if (v >= st[k].v && v <= st[k + 1].v) { a = st[k]; b = st[k + 1]; break; }
      const q = b.v === a.v ? 0 : (v - a.v) / (b.v - a.v);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.floor(Math.max(0, Math.min(255, a.rgb[c] + (b.rgb[c] - a.rgb[c]) * q)));
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  // ── sampling on the CPU ────────────────────────────────────────────────
  // Value at a texel, or null where the model has none.
  function texel(img, col, row) {
    const i = (row * img.width + col) * 4, px = img.data;
    if (px[i + 2] === 0) return null;
    return (px[i] * 256 + px[i + 1]) / 65535;
  }
  // Catmull-Rom weights for one axis, the shader's crw() on the CPU.
  function crw(t) {
    const t2 = t * t, t3 = t2 * t;
    return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
  }
  // The same arithmetic as sampleField in the shader, so the number the probe
  // reports is the number the pixel under it was coloured from.
  function sampleEntry(e, lng, lat, spec) {
    if (!e || !e.img) return null;
    const g = spec.model.grid_spec, img = e.img;
    const wrap = !spec.model.regional;
    let col = (lng - g.lon0) / g.dlon, row = (lat - g.lat0) / g.dlat;
    if (wrap) col = ((col % g.nx) + g.nx) % g.nx;
    else if (col < -0.5 || col > g.nx - 0.5 || row < -0.5 || row > g.ny - 0.5) return null;
    row = Math.max(0, Math.min(g.ny - 1, row));
    col = Math.max(0, Math.min(wrap ? g.nx : g.nx - 1, col));
    const c0 = Math.floor(col), r0 = Math.floor(row), fx = col - c0, fy = row - r0;
    const wc = (c) => wrap ? ((c % g.nx) + g.nx) % g.nx : Math.max(0, Math.min(g.nx - 1, c));
    const cx = [wc(c0 - 1), wc(c0), wc(c0 + 1), wc(c0 + 2)];
    const ry = [0, 1, 2, 3].map((k) => Math.max(0, Math.min(g.ny - 1, r0 + k - 1)));
    const ni = fx < 0.5 ? 1 : 2, nj = fy < 0.5 ? 1 : 2;
    if (spec.cells) {
      const v = texel(img, cx[ni], ry[nj]);
      return v == null ? { valid: false } : { valid: true, q: v };
    }
    const p = [];
    let whole = true;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const v = texel(img, cx[i], ry[j]);
      p[j * 4 + i] = v;
      if (v == null) whole = false;
    }
    if (p[nj * 4 + ni] == null) return { valid: false };
    if (whole) {
      const wx = crw(fx), wy = crw(fy);
      let q = 0;
      for (let j = 0; j < 4; j++) {
        let rowsum = 0;
        for (let i = 0; i < 4; i++) rowsum += wx[i] * p[j * 4 + i];
        q += wy[j] * rowsum;
      }
      return { valid: true, q: Math.max(0, Math.min(1, q)) };
    }
    const b = [[p[5], (1 - fx) * (1 - fy)], [p[6], fx * (1 - fy)], [p[9], (1 - fx) * fy], [p[10], fx * fy]];
    let ws = 0, vs = 0;
    for (const [v, w] of b) if (v != null) { ws += w; vs += w * v; }
    return { valid: true, q: vs / ws };
  }
  // The display-unit value at a point, mixed between the two steps exactly
  // as the shader mixes them; null off the grid or where there is no data.
  function sample(lng, lat) {
    if (!live || !shown.a || !shown.enc) return null;
    const A = sampleEntry(shown.a, lng, lat, shown);
    if (!A) return null;
    const B = shown.b && shown.t > 0 && !shown.snap ? sampleEntry(shown.b, lng, lat, shown) : null;
    const dec = (q) => shown.enc.lo + q * (shown.enc.hi - shown.enc.lo);
    if (!A.valid && !(B && B.valid)) return { v: null, valid: false };
    let q;
    if (B && B.valid && A.valid) q = A.q + (B.q - A.q) * shown.t;
    else q = A.valid ? A.q : B.q;
    return { v: dec(q), valid: true };
  }

  // ── the custom layer ───────────────────────────────────────────────────
  const VERT = (prelude, define, gl2) => `${gl2 ? "#version 300 es\n" : ""}
${prelude}
${define}
${gl2 ? "in" : "attribute"} vec2 a_pos;
uniform float u_offset;
${gl2 ? "out" : "varying"} vec2 v_merc;
void main() {
  gl_Position = projectTile(vec2(a_pos.x + u_offset, a_pos.y));
  v_merc = a_pos;
}`;

  const FRAG = (gl2) => `${gl2 ? "#version 300 es\n" : ""}
precision highp float;
precision highp int;
${gl2 ? "in" : "varying"} vec2 v_merc;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_lut;
uniform float u_t;
uniform vec4 u_grid;      // lon0, dlon, lat0, dlat
uniform vec2 u_size;      // nx, ny
uniform float u_wrap;     // 1: columns wrap around the globe
uniform float u_cells;    // 1: nearest texel, the grid drawn as cells
uniform vec2 u_enc;       // lo, hi of the encoding
uniform vec2 u_ramp;      // lo, hi of the ramp
uniform vec4 u_rule;      // kind, k, x0, p
uniform float u_alpha;
${gl2 ? "out vec4 fragColor;" : ""}
const float PI2 = 3.141592653589793;
${gl2 ? "#define TEX(s, ij) texelFetch(s, ivec2(ij), 0)" : "#define TEX(s, ij) texture2D(s, (vec2(ij) + 0.5) / u_size)"}
${gl2 ? "#define LUT(u) texture(u_lut, vec2(u, 0.5))" : "#define LUT(u) texture2D(u_lut, vec2(u, 0.5))"}

// value (0..1 over the encoding) and validity of one texel
vec2 fetch(sampler2D s, vec2 ij) {
  vec4 c = TEX(s, ij);
  return vec2((c.r * 65280.0 + c.g * 255.0) / 65535.0, c.b);
}
float wrapc(float c) { return u_wrap > 0.5 ? mod(c, u_size.x) : clamp(c, 0.0, u_size.x - 1.0); }

// Catmull-Rom weights: the cubic the server used when it upsampled the
// values 2x before colouring. Sampling the grid straight in the shader with
// the same kernel is what keeps the two pictures the same picture.
vec4 crw(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t,
               1.5 * t3 - 2.5 * t2 + 1.0,
              -1.5 * t3 + 2.0 * t2 + 0.5 * t,
               0.5 * t3 - 0.5 * t2);
}

// Value in the model's own grid, in value space. Cubic over the 4x4
// neighbourhood where the model has all sixteen; masked bilinear at the edge
// of its coverage, which is what the server did after nearest-filling the
// gaps and masking them back; the nearest texel decides whether there is a
// value at all.
vec2 sampleField(sampler2D s, vec2 cr) {
  vec2 i0 = floor(cr);
  vec2 f = cr - i0;
  float cx[4], ry[4];
  for (int k = 0; k < 4; k++) {
    cx[k] = wrapc(i0.x + float(k) - 1.0);
    ry[k] = clamp(i0.y + float(k) - 1.0, 0.0, u_size.y - 1.0);
  }
  int ni = f.x < 0.5 ? 1 : 2, nj = f.y < 0.5 ? 1 : 2;
  if (u_cells > 0.5) return fetch(s, vec2(cx[ni], ry[nj]));
  vec2 p[16];
  float whole = 1.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 q = fetch(s, vec2(cx[i], ry[j]));
      p[j * 4 + i] = q;
      whole *= q.y;
    }
  }
  float valid = p[nj * 4 + ni].y;
  if (whole > 0.5) {
    vec4 wx = crw(f.x), wy = crw(f.y);
    float v = 0.0;
    for (int j = 0; j < 4; j++) {
      float row = 0.0;
      for (int i = 0; i < 4; i++) row += wx[i] * p[j * 4 + i].x;
      v += wy[j] * row;
    }
    return vec2(clamp(v, 0.0, 1.0), valid);
  }
  vec2 p00 = p[5], p10 = p[6], p01 = p[9], p11 = p[10];
  float w00 = (1.0 - f.x) * (1.0 - f.y) * p00.y, w10 = f.x * (1.0 - f.y) * p10.y;
  float w01 = (1.0 - f.x) * f.y * p01.y, w11 = f.x * f.y * p11.y;
  float ws = w00 + w10 + w01 + w11;
  float v = ws > 0.0 ? (w00 * p00.x + w10 * p10.x + w01 * p01.x + w11 * p11.x) / ws : 0.0;
  return vec2(v, valid);
}

float rule(float x) {
  int kind = int(u_rule.x + 0.5);
  if (kind == 1) { float a = clamp((x - u_rule.z) / u_rule.y, 0.0, 1.0); return u_rule.w == 1.0 ? a : pow(a, u_rule.w); }
  if (kind == 2) return clamp(abs(x) / u_rule.y, 0.0, 1.0);
  if (kind == 3) return clamp((u_rule.z - x) / u_rule.y, 0.0, 1.0);
  if (kind == 4) return x >= u_rule.z ? 1.0 : 0.0;
  return 1.0;
}

void main() {
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp(PI2 - v_merc.y * 2.0 * PI2)) - PI2 * 0.5);
  float col = (lon - u_grid.x) / u_grid.y;
  float row = (lat - u_grid.z) / u_grid.w;
  if (u_wrap < 0.5 && (col < -0.5 || col > u_size.x - 0.5 || row < -0.5 || row > u_size.y - 0.5)) discard;
  vec2 cr = vec2(col, clamp(row, 0.0, u_size.y - 1.0));
  vec2 a = sampleField(u_a, cr);
  vec2 b = u_t > 0.0 ? sampleField(u_b, cr) : a;
  float valid = mix(a.y, b.y, u_t);
  if (valid <= 0.0) discard;
  float q = (a.y > 0.0 && b.y > 0.0) ? mix(a.x, b.x, u_t) : (a.y > 0.0 ? a.x : b.x);
  float x = u_enc.x + q * (u_enc.y - u_enc.x);
  float alpha = rule(x) * valid * u_alpha;
  float idx = floor(clamp((x - u_ramp.x) / (u_ramp.y - u_ramp.x), 0.0, 1.0) * 255.0);
  vec3 rgb = LUT((min(idx, 255.0) + 0.5) / 256.0).rgb;
  ${gl2 ? "fragColor" : "gl_FragColor"} = vec4(rgb * alpha, alpha);
}`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { program: p, u, a_pos: gl.getAttribLocation(p, "a_pos") };
  }

  // A grid of triangles over the field's footprint in Mercator, dense
  // enough that the globe's vertex projection bends it onto the sphere
  // (a single quad would cut straight through the planet).
  function buildMesh(gl, model) {
    const NX = 128, NY = 192;
    let x0 = 0, x1 = 1, y0 = mercY(89.99), y1 = mercY(-89.99);
    if (model.regional) { const [w, s, e, n] = model.domain; x0 = mercX(w); x1 = mercX(e); y0 = mercY(n); y1 = mercY(s); }
    const pos = new Float32Array((NX + 1) * (NY + 1) * 2);
    let k = 0;
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { pos[k++] = x0 + (x1 - x0) * i / NX; pos[k++] = y0 + (y1 - y0) * j / NY; }
    const idx = new Uint16Array(NX * NY * 6);
    k = 0;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    return { vb, ib, n: idx.length, key: model.regional ? model.domain.join(",") : "world" };
  }

  function upload(gl, e) {
    if (e.tex || !e.img) return;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, e.img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    e.tex = tex;
  }

  // The zoom fade and the overlay dimming live on the hidden raster layer's
  // raster-opacity, so overlays.js keeps one layer id to dim. Read it back.
  function opacityNow(map) {
    let v;
    try { v = map.getPaintProperty("wx", "raster-opacity"); } catch (e) { v = 1; }
    if (typeof v === "number") return v;
    if (Array.isArray(v) && v[0] === "interpolate") {
      const z = map.getZoom(), stops = v.slice(3);
      if (z <= stops[0]) return stops[1];
      for (let i = 0; i < stops.length - 2; i += 2) if (z <= stops[i + 2]) return stops[i + 1] + (stops[i + 3] - stops[i + 1]) * (z - stops[i]) / (stops[i + 2] - stops[i]);
      return stops[stops.length - 1];
    }
    return 1;
  }

  // How many world copies to draw: the wraps the viewport can see, the way
  // MapLibre's own mercator transform counts them. The globe draws one.
  function wrapsFor(map, transition) {
    if (transition > 0) return [0];
    let lo = 0, hi = 0;
    try {
      const b = map.getBounds();
      lo = Math.floor(mercX(b.getWest())); hi = Math.floor(mercX(b.getEast()));
    } catch (e) { /* no bounds yet */ }
    const out = [];
    for (let w = Math.max(-3, lo - 1); w <= Math.min(3, hi + 1); w++) out.push(w);
    return out;
  }

  const layer = {
    id: "wx-field", type: "custom", renderingMode: "2d",
    onAdd(map, gl) {
      this.map = map; this.gl = gl; this.programs = {}; this.mesh = null; this.lut = null; this.lutKey = "";
      this.gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    },
    onRemove(map, gl) {
      for (const p of Object.values(this.programs || {})) gl.deleteProgram(p.program);
      if (this.mesh) { gl.deleteBuffer(this.mesh.vb); gl.deleteBuffer(this.mesh.ib); }
      if (this.lut) gl.deleteTexture(this.lut);
      for (const e of cache.values()) if (e.tex) { gl.deleteTexture(e.tex); e.tex = null; }
      this.programs = {}; this.mesh = null; this.lut = null; this.lutKey = "";
    },
    render(gl, args) {
      if (!live || !shown.a || !shown.a.img || !shown.model || !shown.ramp) return;
      const sd = args.shaderData, pd = args.defaultProjectionData;
      let prog = this.programs[sd.variantName];
      if (!prog) {
        try { prog = this.programs[sd.variantName] = compile(gl, VERT(sd.vertexShaderPrelude, sd.define, this.gl2), FRAG(this.gl2)); }
        catch (err) { fallback("shader: " + err.message); return; }
      }
      if (!this.mesh || this.mesh.key !== (shown.model.regional ? shown.model.domain.join(",") : "world")) {
        if (this.mesh) { gl.deleteBuffer(this.mesh.vb); gl.deleteBuffer(this.mesh.ib); }
        this.mesh = buildMesh(gl, shown.model);
      }
      const lutKey = `${shown.layer}/${shown.level || 0}`;
      if (!this.lut || this.lutKey !== lutKey) {
        if (!this.lut) this.lut = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.lut);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(shown.ramp));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.lutKey = lutKey;
      }
      upload(gl, shown.a);
      const haveB = shown.b && shown.b.img && shown.t > 0 && !shown.snap;
      if (haveB) upload(gl, shown.b);
      evict(gl);

      gl.useProgram(prog.program);
      const u = prog.u;
      gl.uniformMatrix4fv(u.u_projection_matrix, false, pd.mainMatrix);
      if (u.u_projection_fallback_matrix) gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, pd.fallbackMatrix);
      if (u.u_projection_tile_mercator_coords) gl.uniform4f(u.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
      if (u.u_projection_clipping_plane) gl.uniform4f(u.u_projection_clipping_plane, ...pd.clippingPlane);
      if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, pd.projectionTransition);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shown.a.tex); gl.uniform1i(u.u_a, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, haveB ? shown.b.tex : shown.a.tex); gl.uniform1i(u.u_b, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.lut); gl.uniform1i(u.u_lut, 2);
      const g = shown.model.grid_spec, r = shown.rule || {};
      gl.uniform1f(u.u_t, haveB ? shown.t : 0);
      gl.uniform4f(u.u_grid, g.lon0, g.dlon, g.lat0, g.dlat);
      gl.uniform2f(u.u_size, g.nx, g.ny);
      gl.uniform1f(u.u_wrap, shown.model.regional ? 0 : 1);
      gl.uniform1f(u.u_cells, shown.cells ? 1 : 0);
      gl.uniform2f(u.u_enc, shown.enc.lo, shown.enc.hi);
      gl.uniform2f(u.u_ramp, shown.ramp.lo, shown.ramp.hi);
      gl.uniform4f(u.u_rule, RULE_KIND[r.kind] || 0, r.k || 1, r.x0 || 0, r.p || 1);
      gl.uniform1f(u.u_alpha, (shown.rule && shown.rule.base != null ? shown.rule.base : 0.78) * opacityNow(this.map));

      gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.vb);
      gl.enableVertexAttribArray(prog.a_pos);
      gl.vertexAttribPointer(prog.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.ib);
      for (const w of wrapsFor(this.map, pd.projectionTransition)) {
        gl.uniform1f(u.u_offset, w);
        gl.drawElements(gl.TRIANGLES, this.mesh.n, gl.UNSIGNED_SHORT, 0);
      }
      gl.disableVertexAttribArray(prog.a_pos);
    },
  };

  // ── driving it ─────────────────────────────────────────────────────────
  let showSerial = 0;
  function want(url, gen, repaint) {
    const e = entryFor(url);
    if (!e.img && !e.failed) e.promise.then(() => { if (gen === showSerial) { commit(); repaint(); } }).catch((err) => {
      // A missing field for a run the catalog names is the server saying
      // this path is not on offer; anything else is one bad step.
      if (gen === showSerial && err && (err.status === 404 || err.status === 501 || /altered/.test(err.message))) fallback(err.status ? `field ${err.status}` : err.message);
    });
    return e;
  }
  // What has been asked for but has no pixels yet. The map keeps drawing the
  // last complete frame until it does: an ImageSource holds its old image
  // across an updateImage, and a step change that blanked the map for the
  // length of a request would be a worse map than the one this replaces.
  let pending = null;

  function commit() {
    if (!pending || !pending.a || !pending.a.img) return;
    Object.assign(shown, pending);
    pending = null;
  }

  // spec: { a: url, b: url|null, t, layer, level, model }
  function show(spec) {
    if (!live) return;
    const gen = ++showSerial;
    const repaint = () => { if (WX.map) WX.map.triggerRepaint(); if (WX.probe) { WX.probe.pinUpdate(); } if (WX.fn && WX.fn.updateMarkerFlag) WX.fn.updateMarkerFlag(); if (WX.fn && WX.fn.renderTapePill) WX.fn.renderTapePill(); };
    const lg = rampFor(spec.layer, spec.level);
    const snap = SNAP_LAYERS.has(spec.layer);
    let t = spec.t || 0;
    // a held field shows whichever step is nearer, so the tape and the map agree
    if (snap && spec.b && t >= 0.5) { spec = { ...spec, a: spec.b, b: null }; t = 0; }
    pending = {
      layer: spec.layer, level: spec.level, model: spec.model,
      snap, cells: CELL_LAYERS.has(spec.layer),
      ramp: lg, enc: lg && lg.enc, rule: lg && lg.alpha,
      t: snap ? 0 : t,
      a: want(spec.a, gen, repaint),
      b: spec.b && t > 0 ? want(spec.b, gen, repaint) : null,
    };
    commit();
    repaint();
  }
  function prefetch(url) { if (live) entryFor(url).promise.catch(() => {}); }
  function ready() { return !!(shown.a && shown.a.img); }

  function enable(cat) {
    catalog = cat;
    const params = new URLSearchParams(location.search);
    const off = params.get("field") === "0" || localStorage.getItem("wxgrid.field") === "0";
    if (!cat || !cat.field) { fallback("no field endpoint in the catalog"); return false; }
    if (off) { fallback("switched off"); return false; }
    if (typeof WebGLRenderingContext === "undefined") { fallback("no webgl"); return false; }
    live = true;
    console.info(`wxgrid field path: gpu (${typeof WebGL2RenderingContext !== "undefined" ? "webgl2" : "webgl1"}, ${cat.field.v})`);
    return true;
  }

  WX.field = { enable, get live() { return live; }, layer, show, prefetch, sample, ready, onFallback: null,
               get shown() { return shown; } };
})();
