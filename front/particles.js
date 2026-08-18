// Wind particle overlay on a plain 2-D canvas above the map.
//
// Lineage: cambecc/earth → leaflet-velocity. Particles live in lon/lat, are
// advected by the coarse u/v grid (bilinear), and drawn as short segments in
// screen space through map.project(). The canvas is faded a little every
// frame instead of cleared, which is what gives the trails. Any map movement
// wipes the canvas — redrawing mid-pan smears — and particles are reseeded.
//
// Contract with app.js:  const wl = new WindLayer(map, canvas)
//                        wl.setField(json)   // /api/wind payload
//                        wl.setEnabled(bool)
(function () {
  "use strict";

  const TAU = Math.PI * 2;

  class WindLayer {
    constructor(map, canvas) {
      this.map = map;
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.field = null;
      this.enabled = true;
      this.particles = [];
      this.raf = 0;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.lastFrame = 0;
      this._resize = () => this.resize();
      this._wipe = () => this.wipe();
      window.addEventListener("resize", this._resize);
      map.on("move", this._wipe);
      map.on("resize", this._resize);
      map.on("moveend", () => this.reseed());
      this.resize();
    }

    resize() {
      const w = this.map.getContainer().clientWidth, h = this.map.getContainer().clientHeight;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.reseed();
    }

    setField(field) {
      this.field = field;
      this.reseed();
      this.start();
    }

    setEnabled(on) {
      this.enabled = on;
      if (on) this.start(); else { this.stop(); this.wipe(); }
    }

    wipe() {
      const c = this.canvas;
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, c.width, c.height);
      this.ctx.restore();
    }

    // Bilinear u/v at lon/lat from the coarse grid. Row 0 = lat0 (north pole),
    // rows go south by |dlat|; the last column duplicates the first for wrap.
    sample(lon, lat) {
      const f = this.field;
      if (!f) return null;
      let x = (lon - f.lon0) / f.dlon;
      x = ((x % (f.nx - 1)) + (f.nx - 1)) % (f.nx - 1);
      const y = (lat - f.lat0) / f.dlat;                 // dlat negative → y grows southward
      if (y < 0 || y > f.ny - 1) return null;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, f.nx - 1), y1 = Math.min(y0 + 1, f.ny - 1);
      const fx = x - x0, fy = y - y0;
      const i00 = y0 * f.nx + x0, i01 = y0 * f.nx + x1, i10 = y1 * f.nx + x0, i11 = y1 * f.nx + x1;
      const u = (f.u[i00] * (1 - fx) + f.u[i01] * fx) * (1 - fy) + (f.u[i10] * (1 - fx) + f.u[i11] * fx) * fy;
      const v = (f.v[i00] * (1 - fx) + f.v[i01] * fx) * (1 - fy) + (f.v[i10] * (1 - fx) + f.v[i11] * fx) * fy;
      return [u, v];
    }

    bounds() {
      const b = this.map.getBounds();
      return { w: b.getWest(), e: b.getEast(), s: Math.max(b.getSouth(), -85), n: Math.min(b.getNorth(), 85) };
    }

    reseed() {
      const b = this.bounds();
      const area = this.canvas.clientWidth * this.canvas.clientHeight;
      // Density tuned so a laptop screen gets ~4-6k particles, a phone ~1.5k.
      const n = Math.max(600, Math.min(7000, Math.round(area / 220)));
      this.particles = new Array(n);
      for (let i = 0; i < n; i++) this.particles[i] = this.spawn(b, true);
      this.wipe();
    }

    spawn(b, randomAge) {
      const lon = b.w + Math.random() * (b.e - b.w);
      // Uniform in Mercator y, not latitude, so density looks even on screen.
      const yN = Math.log(Math.tan(Math.PI / 4 + (b.n * Math.PI / 180) / 2));
      const yS = Math.log(Math.tan(Math.PI / 4 + (b.s * Math.PI / 180) / 2));
      const y = yS + Math.random() * (yN - yS);
      const lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
      const maxAge = 40 + Math.random() * 60;
      return { lon, lat, age: randomAge ? Math.random() * maxAge : 0, maxAge, px: null, py: null };
    }

    start() {
      if (this.raf || !this.enabled || !this.field) return;
      const loop = (t) => { this.raf = requestAnimationFrame(loop); this.frame(t); };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    frame(t) {
      if (this.map.isMoving()) { this.lastFrame = t; return; }
      const dt = Math.min(50, t - (this.lastFrame || t)) / 1000;   // s, capped for tab wake-ups
      this.lastFrame = t;
      const ctx = this.ctx, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      // Fade the previous frame: this is the trail.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.05;
      ctx.lineCap = "round";

      const b = this.bounds();
      const zoom = this.map.getZoom();
      const light = document.documentElement.dataset.theme === "light";
      // Screen-relative speed: a 10 m/s wind moves ~90 px/s at any zoom, so
      // the animation reads the same whether you look at a hemisphere or a
      // bay. px/deg at the equator = 512·2^z / 360 for MapLibre's 512 tiles.
      const pxPerDeg = 512 * Math.pow(2, zoom) / 360;
      const speed = 9.0 / pxPerDeg;              // deg/s per m/s (before the cos-lat correction)
      const buckets = new Map();     // colour → path, batched draw calls
      for (const p of this.particles) {
        p.age += 1;
        const uv = this.sample(p.lon, p.lat);
        if (!uv || p.age > p.maxAge || p.lat > 85 || p.lat < -85) { Object.assign(p, this.spawn(b, false)); continue; }
        const [u, v] = uv;
        const cosLat = Math.max(0.05, Math.cos(p.lat * Math.PI / 180));
        const nlon = p.lon + u * speed * dt / cosLat;
        const nlat = p.lat + v * speed * dt;
        const a = this.map.project([p.lon, p.lat]);
        const q = this.map.project([nlon, nlat]);
        p.lon = ((nlon + 180) % 360 + 360) % 360 - 180;
        p.lat = nlat;
        if (a.x < -20 || a.x > w + 20 || a.y < -20 || a.y > h + 20) { Object.assign(p, this.spawn(b, false)); continue; }
        if (Math.abs(q.x - a.x) > w / 2) continue;                        // wrapped across the antimeridian
        const spd = Math.hypot(u, v);
        const key = light ? (spd < 4 ? "rgba(20,30,50,0.35)" : spd < 10 ? "rgba(20,30,50,0.5)" : spd < 18 ? "rgba(120,60,10,0.6)" : "rgba(160,30,10,0.7)")
                          : (spd < 4 ? "rgba(255,255,255,0.38)" : spd < 10 ? "rgba(255,255,255,0.55)" : spd < 18 ? "rgba(255,230,160,0.7)" : "rgba(255,170,120,0.8)");
        let path = buckets.get(key);
        if (!path) { path = new Path2D(); buckets.set(key, path); }
        path.moveTo(a.x, a.y);
        path.lineTo(q.x, q.y);
      }
      for (const [color, path] of buckets) { ctx.strokeStyle = color; ctx.stroke(path); }
    }

    destroy() {
      this.stop();
      window.removeEventListener("resize", this._resize);
      this.map.off("move", this._wipe);
    }
  }

  window.WindLayer = WindLayer;
})();
