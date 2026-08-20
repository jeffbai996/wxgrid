// Wind particle overlay on a plain 2-D canvas above the map.
//
// Lineage: cambecc/earth → leaflet-velocity. Particles live in lon/lat, are
// advected by the coarse u/v grid (bilinear), and drawn as short segments in
// screen space through map.project(). The canvas is faded a little every
// frame instead of cleared, which is what gives the trails. Particles stay in
// geographic space and are reprojected every frame, including while the map
// is moving, so dragging never pauses or resets the flow.
//
// Contract with app.js:  const wl = new WindLayer(map, canvas)
//                        wl.setField(json)   // /api/wind payload
//                        wl.setEnabled(bool)
(function () {
  "use strict";

  const TAU = Math.PI * 2;
  const MAX_STEP_DEG = 1.5;      // per frame, per axis

  class WindLayer {
    constructor(map, canvas) {
      this.map = map;
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.field = null;
      this.enabled = true;
      this.mode = "particles";
      this.density = 50;
      this.particles = [];
      this.raf = 0;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.lastFrame = 0;
      this._resize = () => this.resize();
      this._moveEnd = () => {
        if (this.mode === "barbs") { this.drawBarbs(); return; }
        // A rapid zoom-out leaves every particle inside the OLD viewport — a
        // dense clump in the middle of the new one, dying off over a minute.
        // If the view changed scale meaningfully, deal fresh cards.
        const z = this.map.getZoom();
        if (this._seedZoom == null || Math.abs(z - this._seedZoom) > 0.4) this.reseed();
      };
      // Barbs are drawn in screen space from the field underneath. Drawing them
      // only at the end of a movement left them pinned to the glass while the
      // map slid beneath — the same complaint the particle trails had.
      this._moving = false;
      this._onMove = () => {
        if (this.mode !== "barbs" || this._moving) return;
        this._moving = true;
        requestAnimationFrame(() => { this._moving = false; if (this.mode === "barbs") this.drawBarbs(); });
      };
      map.on("move", this._onMove);
      map.on("zoom", this._onMove);
      window.addEventListener("resize", this._resize);
      map.on("resize", this._resize);
      map.on("moveend", this._moveEnd);
      this.resize();
    }

    resize() {
      // Never SKIP a resize: a return here left the canvas at its old size
      // and the particles painting one corner of the map (2026-08-19). While
      // the page is pinch-zoomed, defer — and catch up the moment it ends.
      if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02) {
        if (!this._pinchWait) {
          this._pinchWait = setInterval(() => {
            if (Math.abs(window.visualViewport.scale - 1) <= 0.02) {
              clearInterval(this._pinchWait); this._pinchWait = null; this.resize();
            }
          }, 300);
        }
        return;
      }
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
      if (this.mode === "barbs") this.drawBarbs(); else this.start();
    }

    setEnabled(on) {
      this.enabled = on;
      if (on) this.start(); else { this.stop(); this.wipe(); }
    }

    setDensity(value) {
      this.density = Math.max(0, Math.min(100, Number(value) || 0));
      this.reseed();
      if (this.mode === "barbs") this.drawBarbs();
    }

    // "particles" (animated) or "barbs" (static station-model barbs on a grid).
    setMode(mode) {
      this.mode = mode;
      this.wipe();
      if (mode === "barbs") { this.stop(); this.drawBarbs(); }
      else this.start();
    }

    // Wind barbs in knots on a screen grid: half barb 5, full 10, pennant 50.
    // Staff points INTO the wind (toward where it comes from), like a chart.
    drawBarbs() {
      if (!this.field || this.mode !== "barbs") return;
      const ctx = this.ctx, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.wipe();
      const light = document.documentElement.dataset.theme === "light";
      ctx.strokeStyle = light ? "rgba(20,30,50,0.85)" : "rgba(255,255,255,0.9)";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const gap = 64, len = 22;
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const ll = this.map.unproject([x, y]);
          if (ll.lat > 85 || ll.lat < -85) continue;
          const uv = this.sample(ll.lng, ll.lat);
          if (!uv) continue;
          const [u, v] = uv;
          const kt = Math.hypot(u, v) * 1.943844;
          if (kt < 2) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke(); continue; }
          const dirFrom = Math.atan2(-u, -v);           // radians, 0 = north, clockwise; wind FROM
          const dx = Math.sin(dirFrom), dy = -Math.cos(dirFrom);
          const ex = x + dx * len, ey = y + dy * len;   // staff end (upwind)
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
          // barbs go on the right side of the staff (looking downwind) in the northern hemisphere
          const side = ll.lat >= 0 ? 1 : -1;
          const px = -dy * side, py = dx * side;        // perpendicular
          let remaining = Math.round(kt / 5) * 5, pos = 0;
          const step = 4.2, bl = 8;
          const at = (t) => [ex - dx * t, ey - dy * t];
          while (remaining >= 50) { const [ax, ay] = at(pos), [bx, by] = at(pos + step); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * bl, ay + py * bl); ctx.lineTo(bx, by); ctx.closePath(); ctx.fill(); pos += step + 1.5; remaining -= 50; }
          while (remaining >= 10) { const [ax, ay] = at(pos); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * bl + dx * 2, ay + py * bl + dy * 2); ctx.stroke(); pos += step; remaining -= 10; }
          if (remaining >= 5) { const [ax, ay] = at(pos === 0 ? step : pos); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + px * bl / 2 + dx, ay + py * bl / 2 + dy); ctx.stroke(); }
        }
      }
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
      if (f.mask) {
        const valid = (f.mask[i00] * (1 - fx) + f.mask[i01] * fx) * (1 - fy)
          + (f.mask[i10] * (1 - fx) + f.mask[i11] * fx) * fy;
        if (valid < 0.9) return null;
      }
      const u = (f.u[i00] * (1 - fx) + f.u[i01] * fx) * (1 - fy) + (f.u[i10] * (1 - fx) + f.u[i11] * fx) * fy;
      const v = (f.v[i00] * (1 - fx) + f.v[i01] * fx) * (1 - fy) + (f.v[i10] * (1 - fx) + f.v[i11] * fx) * fy;
      return [u, v];
    }

    bounds() {
      const b = this.map.getBounds();
      return { w: b.getWest(), e: b.getEast(), s: Math.max(b.getSouth(), -85), n: Math.min(b.getNorth(), 85) };
    }

    reseed() {
      this._seedZoom = this.map ? this.map.getZoom() : null;
      const b = this.bounds();
      const area = this.canvas.clientWidth * this.canvas.clientHeight;
      // 50% is the quieter default and equals about 70% of the old particle
      // count. The full control ranges from off to 1.4x the old density.
      const base = Math.max(600, Math.min(7000, Math.round(area / 220)));
      const n = Math.max(0, Math.min(9800, Math.round(base * this.density * 0.014)));
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
      // Zoomed out, a particle covers tens of degrees a second and the flow
      // packs them into its convergence zones within a few seconds — the dense
      // band. Short lives at low zoom keep the field evenly seeded.
      const wide = this.map.getZoom() < 3.5;
      const maxAge = wide ? 18 + Math.random() * 22 : 40 + Math.random() * 60;
      return { lon, lat, age: randomAge ? Math.random() * maxAge : 0, maxAge, px: null, py: null };
    }

    start() {
      if (this.raf || !this.enabled || !this.field || this.mode === "barbs") return;
      const loop = (t) => { this.raf = requestAnimationFrame(loop); this.frame(t); };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    // The trail buffer is a picture of where the wind has just been, painted in
    // screen space. When the map moves, that picture has to move with it — or
    // the trails smear across the display and the field reads as animating the
    // user's drag instead of the weather. Pan and zoom of a north-up map are a
    // similarity transform, so a single drawImage relocates the whole buffer
    // exactly: scale by the zoom ratio, then put the old centre back where the
    // new view says that place now is.
    warpTrails() {
      const m = this.map, z = m.getZoom(), c = m.getCenter();
      const prev = this._view;
      this._view = { z, lng: c.lng, lat: c.lat };
      if (!prev || (prev.z === z && prev.lng === c.lng && prev.lat === c.lat)) return;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const s = Math.pow(2, z - prev.z);
      const p = m.project([prev.lng, prev.lat]);
      const tx = p.x - s * w / 2, ty = p.y - s * h / 2;
      // A jump across the antimeridian projects into another world copy; there
      // is nothing sensible to warp then, so start the trails over.
      if (!isFinite(tx) || !isFinite(ty) || Math.abs(tx) > 2 * w || Math.abs(ty) > 2 * h) { this.wipe(); return; }
      const buf = this._buf || (this._buf = document.createElement("canvas"));
      if (buf.width !== this.canvas.width || buf.height !== this.canvas.height) { buf.width = this.canvas.width; buf.height = this.canvas.height; }
      const bx = buf.getContext("2d");
      bx.setTransform(1, 0, 0, 1, 0, 0);
      bx.clearRect(0, 0, buf.width, buf.height);
      bx.drawImage(this.canvas, 0, 0);
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(buf, tx, ty, w * s, h * s);
    }

    frame(t) {
      const dt = Math.min(50, t - (this.lastFrame || t)) / 1000;   // s, capped for tab wake-ups
      this.lastFrame = t;
      const ctx = this.ctx, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.warpTrails();
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
        // out of the view by more than a world? it can never come back — respawn
        if (!uv || p.age > p.maxAge || p.lat > 85 || p.lat < -85 || p.lon < b.w - 360 || p.lon > b.e + 360) { Object.assign(p, this.spawn(b, false)); continue; }
        const [u, v] = uv;
        const cosLat = Math.max(0.05, Math.cos(p.lat * Math.PI / 180));
        // A single frame must not teleport a particle across a continent: at
        // world zoom the screen-relative speed works out to many degrees per
        // frame, which both smears the trail and empties the rest of the map.
        const dlon = Math.max(-MAX_STEP_DEG, Math.min(MAX_STEP_DEG, u * speed * dt / cosLat));
        const dlat = Math.max(-MAX_STEP_DEG, Math.min(MAX_STEP_DEG, v * speed * dt));
        const nlon = p.lon + dlon;
        const nlat = p.lat + dlat;
        const a = this.map.project([p.lon, p.lat]);
        const q = this.map.project([nlon, nlat]);
        // Keep longitude in the CONTINUOUS space of the current view instead
        // of wrapping it to [-180, 180). map.project() maps a wrapped lon into
        // the primary world copy, so when the viewport showed the copy east of
        // the antimeridian, half the screen had no particles at all
        // (Jeff 2026-08-18). sample() wraps on its own, so nothing else cares.
        p.lon = nlon;
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
      this.map.off("resize", this._resize);
      this.map.off("moveend", this._moveEnd);
      this.map.off("move", this._onMove);
      this.map.off("zoom", this._onMove);
    }
  }

  window.WindLayer = WindLayer;
})();
