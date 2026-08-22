// ── particles.js ────────────────────────────────────────────────
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
  const MAX_STEP_PX = 1.8;       // the universal speed governor: ~1.2× a brisk mid-latitude flow, poles pinned to it

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
        // Looking straight down a pole is another density regime: longitude
        // collapses into a point. Re-deal when crossing into or out of it.
        const z = this.map.getZoom(), lat = Math.abs(this.map.getCenter().lat);
        if (this._seedZoom == null || Math.abs(z - this._seedZoom) > 0.4 || (lat > 65) !== (this._seedLat > 65)) this.reseed();
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
      // Ctrl+/− changes devicePixelRatio, and a canvas sized under the old
      // ratio draws soft or (booted at zero) not at all — "zoom in and out
      // to make it work" was the manual version of this listener
      // (Jeff 2026-08-20). matchMedia only fires once per resolution, so it
      // re-arms itself after every change.
      this._armDpr = () => {
        const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const once = () => { mq.removeEventListener("change", once); this.resize(); this._armDpr(); };
        mq.addEventListener("change", once);
      };
      this._armDpr();
      map.on("moveend", this._moveEnd);
      // A cold boot changes projection and canvas geometry after the wind JSON
      // can already have arrived. Zooming used to be the first lifecycle event
      // that dealt particles against the final globe. Listen to the actual
      // style/projection/layout transitions instead.
      this._settle = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        this._apply();
        if (this.field && this.mode !== "barbs") this.start();
      }));
      map.on("style.load", this._settle);
      map.on("projectiontransition", this._settle);
      map.on("load", this._settle);
      this._layoutObserver = new ResizeObserver(this._settle);
      this._layoutObserver.observe(map.getContainer());
      this.resize();
    }

    resize() {
      // Never SKIP a resize: a return here left the canvas at its old size
      // and the particles painting one corner of the map (2026-08-19). While
      // the page is actively pinch-zooming, defer — but "settled" means the
      // scale STOPPED MOVING, not "returned to exactly 1": iOS parks at 1.03
      // forever (documented at the card-height fix in app.js), and waiting
      // for 1.0 deferred this resize for the life of the page. That was the
      // invisible-particles boot: a parked pinch meant the canvas was never
      // sized at all, and every later cure re-entered the same wait
      // (Jeff 2026-08-20, three screenshots). The poll therefore calls
      // _apply() directly — going through resize() again would re-defer.
      if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02) {
        if (!this._pinchWait) {
          let last = window.visualViewport.scale, stable = 0;
          this._pinchWait = setInterval(() => {
            const sc = window.visualViewport.scale;
            if (Math.abs(sc - last) < 0.001) stable++; else stable = 0;
            last = sc;
            if (Math.abs(sc - 1) <= 0.02 || stable >= 2) {
              clearInterval(this._pinchWait); this._pinchWait = null; this._apply();
            }
          }, 300);
        }
        return;
      }
      this._apply();
    }

    _apply() {
      const w = this.map.getContainer().clientWidth, h = this.map.getContainer().clientHeight;
      if (!w || !h) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);   // page zoom moves it; never trust the boot value
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
          // Globe: a pixel in space beside the sphere still "unprojects" to
          // an edge coordinate. Only trust the cell if it projects back to
          // where we asked.
          const rt = this.map.project([ll.lng, ll.lat]);
          if (Math.abs(rt.x - x) > 3 || Math.abs(rt.y - y) > 3) continue;
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
      if (f.wrap !== false) x = ((x % (f.nx - 1)) + (f.nx - 1)) % (f.nx - 1);
      else if (x < 0 || x > f.nx - 1) return null;
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
      const out = { w: b.getWest(), e: b.getEast(), s: Math.max(b.getSouth(), -89.5), n: Math.min(b.getNorth(), 89.5) };
      const f = this.field;
      if (f && f.wrap === false) {
        out.w = Math.max(out.w, f.lon0);
        out.e = Math.min(out.e, f.lon0 + (f.nx - 1) * f.dlon);
        out.n = Math.min(out.n, f.lat0);
        out.s = Math.max(out.s, f.lat0 + (f.ny - 1) * f.dlat);
      }
      return out;
    }

    reseed() {
      this._seedZoom = this.map ? this.map.getZoom() : null;
      this._seedLat = this.map ? Math.abs(this.map.getCenter().lat) : 0;
      const b = this.bounds();
      const area = this.canvas.clientWidth * this.canvas.clientHeight;
      // 50% is the quieter default and equals about 70% of the old particle
      // count. The full control ranges from off to 1.4x the old density.
      const base = Math.max(600, Math.min(7000, Math.round(area / 220)));
      // At a pole the meridians and their trajectories converge into the same
      // few pixels. Fewer particles there preserves motion without turning
      // the cap into a black starburst.
      // No polar thinning: the 0.4 factor read as the wind dying at 65°N
      // (Jeff 2026-08-21). The px-per-frame governor handles the pole now.
      const n = Math.max(0, Math.min(9800, Math.round(base * this.density * 0.014)));
      this.particles = new Array(n);
      for (let i = 0; i < n; i++) this.particles[i] = this.spawn(b, true);
      this.wipe();
    }

    spawn(b, randomAge) {
      let lon, lat;
      const globe = this.map.getProjection && (this.map.getProjection() || {}).type === "globe" && this.map.getZoom() < 6;
      if (globe && this.canvas.clientWidth && this.canvas.clientHeight) {
        // Deal uniformly on the visible disc. Geographic bounds become
        // degenerate when the camera looks straight down a pole and used to
        // stack most cards into a bright, frantic ring.
        for (let k = 0; k < 16; k++) {
          const x = Math.random() * this.canvas.clientWidth, y = Math.random() * this.canvas.clientHeight;
          let ll, rt;
          try { ll = this.map.unproject([x, y]); rt = this.map.project(ll); }
          catch (e) { continue; }                  // outside the visible globe disc
          if (Math.abs(rt.x - x) > 2 || Math.abs(rt.y - y) > 2 || Math.abs(ll.lat) > 89.5) continue;
          if (this.field && !this.sample(ll.lng, ll.lat)) continue;
          lon = ll.lng; lat = ll.lat; break;
        }
      }
      if (lon == null) {
        if (!(b.e > b.w && b.n > b.s)) return { lon: 0, lat: 0, age: 1e9, maxAge: 0, px: null, py: null };
        lon = b.w + Math.random() * (b.e - b.w);
      // Uniform in Mercator y, not latitude, so density looks even on screen.
        const yN = Math.log(Math.tan(Math.PI / 4 + (b.n * Math.PI / 180) / 2));
        const yS = Math.log(Math.tan(Math.PI / 4 + (b.s * Math.PI / 180) / 2));
        const y = yS + Math.random() * (yN - yS);
        lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
      }
      // Zoomed out, a particle covers tens of degrees a second and the flow
      // packs them into its convergence zones within a few seconds — the dense
      // band. Short lives at low zoom keep the field evenly seeded.
      const wide = this.map.getZoom() < 3.5;
      const maxAge = wide ? 18 + Math.random() * 22 : 40 + Math.random() * 60;
      return { lon, lat, age: randomAge ? Math.random() * maxAge : 0, maxAge, px: null, py: null };
    }

    start() {
      if (this.raf || !this.enabled || !this.field || this.mode === "barbs") return;
      // The watchdog. Twice now a boot has produced a running loop that
      // paints nothing until the user zooms "a few times" (Jeff 2026-08-20,
      // both times unreproducible here). Whatever the degenerate state is,
      // its cure is always the same — re-measure, re-deal — so when the loop
      // draws zero segments for ~2 s straight, do exactly that, once a cycle.
      if (!this._watch) {
        this._starve = 0;
        this._watch = setInterval(() => {
          if (!this.raf || !this.field || this.mode === "barbs") { this._starve = 0; return; }
          if (this._drawn === 0 && this.particles.length) {
            if (++this._starve >= 3) { this._starve = 0; console.warn("wxgrid: particle loop starved, re-dealing"); this.resize(); }
          } else this._starve = 0;
        }, 700);
      }
      // A canvas measured before layout settled is 0×0 (or stale after a
      // page-zoom): every frame then paints nothing while the loop runs
      // happily. Re-measure at the moment the animation actually starts.
      const want = Math.round(this.map.getContainer().clientWidth * this.dpr);
      if (!this.canvas.width || Math.abs(this.canvas.width - want) > 2 * this.dpr) this.resize();
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
      // On the sphere a drag is a ROTATION: every screen point moves along a
      // different vector, so translating the old frame smears trails off the
      // limb into space. Wiping instead (first fix) strobed — every frame of
      // a drag restarted the trails. The right move is neither: keep the
      // particles animating in place and let the STALE pixels die fast, so
      // nothing lives long enough for the rotation to smear it.
      if (this.map.getProjection && (this.map.getProjection() || {}).type === "globe" && z < 6) { this._fastFade = true; return; }
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
      const dtMs = t - (this.lastFrame || t);
      const dt = Math.min(50, dtMs) / 1000;   // s, capped for tab wake-ups
      this.lastFrame = t;
      // Adaptive relief for weak compositors (iPad Safari, 2026-08-21): when
      // frames are already late while the map is being dragged, painting
      // particles every frame just makes the drag fight for the same budget.
      // Skip every other particle frame until the frame time recovers — the
      // map's own motion stays smooth, the trails just update at half rate.
      this._ema = (this._ema || 16) * 0.85 + Math.min(80, dtMs || 16) * 0.15;
      if (this._ema > 26 && this.map.isMoving && this.map.isMoving()) {
        this._skip = !this._skip;
        if (this._skip) return;
      }
      const ctx = this.ctx, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const zoom = this.map.getZoom();
      const polarView = zoom < 3.5 && Math.abs(this.map.getCenter().lat) > 65;
      this._drawn = 0;
      this.warpTrails();
      // Fade the previous frame: this is the trail. Pole-on projection puts
      // every meridian into one disc, so its trails need a shorter visual
      // half-life even after reducing the particle count.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${this._fastFade ? 0.3 : polarView ? 0.12 : 0.06})`;
      this._fastFade = false;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.05;
      ctx.lineCap = "round";

      const b = this.bounds();
      // On the globe the far hemisphere still projects INTO the canvas —
      // without this cull its particles draw mirrored on the visible disc.
      // A particle more than ~85° of arc from the view centre cannot be on
      // the near side; kill it by dot product, no trig per frame beyond four
      // terms. Central-angle culling is also safe when the projection eases
      // flat while zooming: anything 85° from centre is off-screen there too.
      const D = Math.PI / 180;
      let cull = null;
      if (this.map.getProjection && (this.map.getProjection() || {}).type === "globe") {
        const c = this.map.getCenter();
        const cv = [Math.cos(c.lat * D) * Math.cos(c.lng * D), Math.cos(c.lat * D) * Math.sin(c.lng * D), Math.sin(c.lat * D)];
        const lim = Math.cos(85 * D);
        cull = (lon, lat) => {
          const cl = Math.cos(lat * D);
          return cv[0] * cl * Math.cos(lon * D) + cv[1] * cl * Math.sin(lon * D) + cv[2] * Math.sin(lat * D) < lim;
        };
      }
      const respawn = () => {
        // With the cull active, a blind spawn lands on the far side half the
        // time and dies next frame — the visible disc thins out. Deal again,
        // a few tries, until the card is on the near side.
        let np = this.spawn(b, false);
        if (cull) for (let k = 0; k < 4 && cull(np.lon, np.lat); k++) np = this.spawn(b, false);
        return np;
      };
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
        if (!uv || p.age > p.maxAge || p.lat > 89.5 || p.lat < -89.5 || p.lon < b.w - 360 || p.lon > b.e + 360 || (cull && cull(p.lon, p.lat))) { Object.assign(p, respawn()); continue; }
        const [u, v] = uv;
        const cosLat = Math.max(0.08, Math.cos(p.lat * Math.PI / 180));
        // A single frame must not teleport a particle across a continent: at
        // world zoom the screen-relative speed works out to many degrees per
        // frame, which both smears the trail and empties the rest of the map.
        const dlon = Math.max(-MAX_STEP_DEG, Math.min(MAX_STEP_DEG, u * speed * dt / cosLat));
        const dlat = Math.max(-MAX_STEP_DEG, Math.min(MAX_STEP_DEG, v * speed * dt));
        const a = this.map.project([p.lon, p.lat]);
        let nlon = p.lon + dlon, nlat = p.lat + dlat;
        if (nlat > 89.99 || nlat < -89.99) { Object.assign(p, respawn()); continue; }
        let q = this.map.project([nlon, nlat]);
        const screenStep = Math.hypot(q.x - a.x, q.y - a.y);
        if (!isFinite(screenStep)) { Object.assign(p, respawn()); continue; }
        if (screenStep > MAX_STEP_PX) {
          const scale = MAX_STEP_PX / screenStep;
          nlon = p.lon + dlon * scale; nlat = p.lat + dlat * scale;
          q = this.map.project([nlon, nlat]);
        }
        // Keep longitude in the CONTINUOUS space of the current view instead
        // of wrapping it to [-180, 180). map.project() maps a wrapped lon into
        // the primary world copy, so when the viewport showed the copy east of
        // the antimeridian, half the screen had no particles at all
        // (Jeff 2026-08-18). sample() wraps on its own, so nothing else cares.
        p.lon = nlon;
        p.lat = nlat;
        if (a.x < -20 || a.x > w + 20 || a.y < -20 || a.y > h + 20) { Object.assign(p, respawn()); continue; }
        if (Math.abs(q.x - a.x) > w / 2) continue;                        // wrapped across the antimeridian
        const spd = Math.hypot(u, v);
        const key = light ? (spd < 4 ? "rgba(20,30,50,0.35)" : spd < 10 ? "rgba(20,30,50,0.5)" : spd < 18 ? "rgba(120,60,10,0.6)" : "rgba(160,30,10,0.7)")
                          : (spd < 4 ? "rgba(255,255,255,0.38)" : spd < 10 ? "rgba(255,255,255,0.55)" : spd < 18 ? "rgba(255,230,160,0.7)" : "rgba(255,170,120,0.8)");
        let path = buckets.get(key);
        if (!path) { path = new Path2D(); buckets.set(key, path); }
        path.moveTo(a.x, a.y);
        path.lineTo(q.x, q.y);
        this._drawn++;
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
      this.map.off("style.load", this._settle);
      this.map.off("projectiontransition", this._settle);
      this.map.off("load", this._settle);
      if (this._layoutObserver) this._layoutObserver.disconnect();
    }
  }

  window.WindLayer = WindLayer;
})();

;
// ── app.js ──────────────────────────────────────────────────────
// wxgrid front end — core: map, controls, layers/overlays, time bar + tape,
// place/resort search, tapped-point marker. The point card's panes live in
// panes.js and hang off window.WX. Everything comes from /api (plus
// RainViewer tiles for radar and OpenFreeMap for the basemap).
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const API = "api";
  const WORLD = [[-180, 89.99], [180, 89.99], [180, -89.99], [-180, -89.99]];
  // Every raster layer the API can draw. The rail shows FAMILIES; a family
  // with variants (rain 6h/24h/72h …) gets a variant picker in the time bar.
  const LAYERS = ["wind", "temp", "gust", "tp6", "tp24", "tp72", "sf6", "sf24", "sf72", "sd_cm", "tcc",
    "cloudlow", "cloudmid", "cloudhigh", "fog", "solar", "msl", "d2m", "rh", "frz", "cape", "waves", "wperiod", "wavepower"];
  const FAMILIES = [
    { key: "wind", label: "Wind", layers: ["wind"] },
    { key: "gust", label: "Gusts", layers: ["gust", "gfactor"], variants: { gust: "Peak", gfactor: "Factor" } },
    { key: "temp", label: "Temp", layers: ["temp", "feels", "wbt", "dt24"], variants: { temp: "Air", feels: "Feels", wbt: "Wet-bulb", dt24: "Δ" } },
    { key: "rain", label: "Rain", layers: ["tp6", "tp24", "tp72"], variants: { tp6: "6 h", tp24: "24 h", tp72: "72 h" }, section: "Precipitation" },
    { key: "ptype", label: "Precip type", layers: ["ptype"] },
    { key: "snow", label: "New snow", layers: ["sf6", "sf24", "sf72"], variants: { sf6: "6 h", sf24: "24 h", sf72: "72 h" } },
    { key: "sd", label: "Snow depth", layers: ["sd_cm"] },
    { key: "frz", label: "Freezing lvl", layers: ["frz"] },
    { key: "tcc", label: "Clouds", layers: ["tcc", "cloudlow", "cloudmid", "cloudhigh"],
      variants: { tcc: "Total", cloudlow: "Low", cloudmid: "Mid", cloudhigh: "High" }, section: "Air" },
    { key: "fog", label: "Fog potential", layers: ["fog"] },
    { key: "msl", label: "Pressure", layers: ["msl", "ptend"], variants: { msl: "MSL", ptend: "Change" } },
    { key: "hum", label: "Humidity", layers: ["rh", "d2m"], variants: { rh: "RH %", d2m: "Dew pt" } },
    { key: "cape", label: "CAPE", layers: ["cape"] },
    { key: "vis", label: "Visibility", layers: ["vis"] },
    { key: "cbase", label: "Cloud base", layers: ["cbase"] },
    { key: "vort", label: "Vorticity", layers: ["vort500"] },
    { key: "uvi", label: "UV index", layers: ["uvi"] },
    { key: "solar", label: "Solar power", layers: ["solar"] },
    { key: "waves", label: "Waves", layers: ["waves", "wperiod", "wavepower"], variants: { waves: "Height", wperiod: "Period", wavepower: "Power" }, section: "Sea" },
    { key: "sst", label: "Sea temp", layers: ["sst"] },
    // member counts, drawn from the GEFS run only — the one model that has them
    { key: "chance", label: "Chance", layers: ["prob_rain", "prob_gust"], variants: { prob_rain: "Rain", prob_gust: "Gale" }, section: "Ensemble" },
  ];
  const familyOf = (layer) => FAMILIES.find((f) => f.layers.includes(layer)) || FAMILIES[0];
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", feels: "Feels like", prob_rain: "Rain chance", prob_gust: "Gale chance", gfactor: "Gust factor", vis: "Visibility", sst: "Sea temp", ptype: "Precip type", vort500: "Vorticity 500", ptend: "Pressure change", cbase: "Cloud base", wbt: "Wet-bulb", dt24: "Temp Δ 24h", msl: "Pressure", tp6: "Rain 6h", tp24: "Rain 24h", tp72: "Rain 72h", sf6: "New snow 6h", sf24: "New snow 24h", sf72: "New snow 72h", sd_cm: "Snow depth", tcc: "Total cloud", cloudlow: "Low cloud", cloudmid: "Mid cloud", cloudhigh: "High cloud", fog: "Fog potential", solar: "Solar power", cape: "CAPE", d2m: "Dew point", rh: "Humidity", frz: "Freezing lvl", waves: "Waves", wperiod: "Wave period", wavepower: "Wave power", uvi: "UV index" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, tp24: 0.9, tp72: 0.9, sf6: 0.9, sf24: 0.9, sf72: 0.9, sd_cm: 0.85, tcc: 0.9, cloudlow: 0.85, cloudmid: 0.85, cloudhigh: 0.85, fog: 0.85, solar: 0.82, cape: 0.85, d2m: 0.75, rh: 0.75, frz: 0.7, waves: 0.8, wperiod: 0.8, wavepower: 0.82, uvi: 0.8, feels: 0.78, prob_rain: 0.82, prob_gust: 0.82, vis: 0.85, sst: 0.8, ptype: 0.85, gfactor: 0.78, vort500: 0.75, ptend: 0.8, cbase: 0.75, wbt: 0.78, dt24: 0.8 };
  const LAYER_ICON = {
    iso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c3-4 6-4 9 0s6 4 9 0"/><path d="M3 9c3-4 6-4 9 0s6 4 9 0"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>',
    gust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v8"/><path d="M12.8 21.6A2 2 0 1 0 14 18H2"/><path d="M17.5 10a2.5 2.5 0 1 1 2 4H2"/><path d="m6 6 4 4 4-4"/></svg>',
    tp6: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
    sf6: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
    sd_cm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/></svg>',
    tcc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    msl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
    d2m: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>',
    frz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h10"/><path d="M9 4v16"/><path d="m3 9 3 3-3 3"/><path d="M12 6 9 9"/><path d="M12 18l-3-3"/><path d="M14 4v10.54a4 4 0 1 1-4 0"/></svg>',
    cape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
    rh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/></svg>',
    uvi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    waves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>',
  };
  const FAMILY_ICON = { wind: "wind", gust: "gust", temp: "temp", rain: "tp6", snow: "sf6", sd: "sd_cm", frz: "frz", tcc: "tcc", fog: "tcc", solar: "uvi", msl: "msl", hum: "rh", cape: "cape", waves: "waves", uvi: "uvi", chance: "tp6", ptype: "sf6", vis: "tcc", vort: "msl", sst: "waves", cbase: "tcc" };
  const LEVEL_FT = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "FL180", 400: "FL240", 300: "FL300", 250: "FL340", 200: "FL390" };
  const LEVEL_FEET = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "18k ft", 400: "24k ft", 300: "30k ft", 250: "34k ft", 200: "39k ft" };
  const LEVEL_M = { 1000: "≈100 m", 925: "≈750 m", 850: "≈1.5 km", 700: "≈3 km", 600: "≈4.2 km", 500: "≈5.5 km", 400: "≈7.2 km", 300: "≈9 km", 250: "≈10.5 km", 200: "≈12 km" };
  const levelBadge = (level) => {
    const system = WX.units && WX.units.pref.baro || "metric";
    const labels = system === "flight" ? LEVEL_FT : system === "feet" ? LEVEL_FEET : LEVEL_M;
    return (labels[level] || "").replace(/^≈/, "");
  };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
    alerts: false, storms: false, sat: false, barbs: false, smoke: false, fires: false, quakes: false, aod: false, thunder: false,
    sigmet: false, aurora: false, lightning: false, aq: false, route: false,
    base: localStorage.getItem("wxgrid.base") || "", night: false,
    terrain: localStorage.getItem("wxgrid.terrain") === "1", aqVar: localStorage.getItem("wxgrid.aqVar") || "pm2_5",
    opacity: Number(localStorage.getItem("wxgrid.opacity") || 100),
    particleDensity: Number(localStorage.getItem("wxgrid.particleDensity") || 60), xsection: false,
    playMs: Number(localStorage.getItem("wxgrid.playMs") || 900),
  };
  let map, wind, catalog, playTimer = null, marker = null;
  let restorePointPanelSize = () => {};
  let restoreSheetHeight = () => {};
  let uiWired = false;
  let setTapeState = () => {};
  let tapeState = "full";

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : state.units === "mph" ? ms * 2.236936 : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s", mph: "mph" }[state.units]);
  const arrowRot = (deg) => `transform: rotate(${(deg + 180 + 45) % 360}deg)`;   // chevron points TO where wind goes
  const f = (v, fn) => (v == null ? "—" : fn(v));
  const arrow = (deg) => "↓↙←↖↑↗→↘"[Math.round(((deg % 360) / 45)) % 8];
  // The map renders world copies, so a click east of the antimeridian gives
  // lng 200 or -200. The marker keeps the raw value (it belongs in the copy
  // the user clicked); every API call gets the wrapped one, since the store
  // is one world wide.
  const wlon = (x) => ((x + 180) % 360 + 360) % 360 - 180;
  // "50.77° N, 120.99° W" reads as a place; a signed pair reads as debug
  // output. Longitude is wrapped first so a map copy east of the antimeridian
  // still names the hemisphere people expect.
  const fmtCoords = (lat, lon, nd = 2) => {
    const wl = wlon(lon);
    return `${Math.abs(lat).toFixed(nd)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(wl).toFixed(nd)}° ${wl >= 0 ? "E" : "W"}`;
  };
  const hasNonLatinScript = (s) => /[\u0370-\u052f\u0590-\u08ff\u0900-\u1cff\u2c00-\ud7ff\uf900-\ufaff]/u.test(s || "");
  // The map's ramps come from the server (`/api/models` → layers[].stops). Any
  // chip that colours a value uses THIS, so a colour means the same thing in
  // the tape, the card and the map instead of three private gradients.
  function rampColor(layer, v, alpha) {
    const lg = catalog && catalog.layers && catalog.layers.find((l) => l.layer === layer);
    if (!lg || v == null) return "transparent";
    const st = lg.stops;
    let a = st[0], b = st[st.length - 1];
    for (let k = 0; k < st.length - 1; k++) if (v >= st[k].v && v <= st[k + 1].v) { a = st[k]; b = st[k + 1]; break; }
    if (v <= st[0].v) { a = b = st[0]; } else if (v >= st[st.length - 1].v) { a = b = st[st.length - 1]; }
    const q = b.v === a.v ? 0 : Math.max(0, Math.min(1, (v - a.v) / (b.v - a.v)));
    const c = a.rgb.map((x, i) => Math.round(x + (b.rgb[i] - x) * q));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha == null ? 1 : alpha})`;
  }
  // Static (GitHub Pages) builds load static-api.js first; it rewrites URLs
  // and answers the JSON endpoints from files. Live builds pass straight through.
  const U = (u) => (window.WXStatic ? window.WXStatic.url(u) : u);
  const apiJson = (u) => window.WXStatic ? window.WXStatic.api(u) : fetch(u).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  window.WX = { state, speed, speedUnit, arrowRot, f, arrow, wlon, fmtCoords, rampColor, LEVEL_FT, LEVEL_M, AVY_COLORS, API, LAYER_ALPHA, $, $$,
                get map() { return map; }, get catalog() { return catalog; }, toast, modelEntry: () => modelEntry(), openPoint, closePoint,
                get validDate() { return validDate(); }, get stepHours() { return stepHours(); }, api: apiJson, url: U };
  // Functions the split-out modules (overlays.js, tape.js, search.js) call back into.
  window.WX.fn = { applyStep: (...a) => applyStep(...a), openPoint: (...a) => openPoint(...a), setStep: (...a) => setStep(...a), toast, firstSymbolId: () => firstSymbolId(),
                   renderPoint: () => renderPoint(), refreshPoint: () => refreshPoint(), closePoint: () => closePoint(), placeMarker: (...a) => placeMarker(...a),
                   stepHours: () => stepHours(), steps: () => steps(), layerUrl: () => layerUrl(),
                   applyTheme: (t) => applyTheme(t), setMotion: (m) => setMotion(m), restartPlay: () => restartPlay(), fitStrip: () => fitStrip(), runEntry: () => runEntry(), modelEntry: () => modelEntry(), validDate: () => validDate(), pushHash: () => pushHash(), nudge: (d) => nudge(d), clearOtherCover: (k) => clearOtherCover(k), updateMarkerFlag: () => updateMarkerFlag(),
                   setTapeState: (s, persist) => setTapeState(s, persist), getTapeState: () => tapeState,
                   jumpModelTime: (key, iso) => switchModel(key, new Date(iso).getTime()) };

  // ── boot ──────────────────────────────────────────────────────────────
  async function boot() {
    const saved = JSON.parse(localStorage.getItem("wxgrid.view") || "null");
    const currentMapScale = localStorage.getItem("wxgrid.mapScaleVersion") === "4";
    if (!currentMapScale) localStorage.setItem("wxgrid.mapScaleVersion", "4");
    // Opening on a hemisphere shows weather nobody asked about. A first view is
    // regional: close enough that the coastline under the field is a place.
    const defaultZoom = innerWidth > 820 ? 5 : 4;
    applyTheme(localStorage.getItem("wxgrid.theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"), false);
    const hash = readHash();
    map = new maplibregl.Map({
      container: "map", style: mapStyle(),
      center: hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], zoom: hash ? hash.zoom : saved && currentMapScale ? saved.zoom : defaultZoom,
      // Past z11 the field is one world-sized image being stretched, and what
      // you actually want is the ground: streets, lifts, runs. So the map keeps
      // zooming to where the basemap still has detail, and the field steps back.
      minZoom: 1.2, maxZoom: 15, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // The globe. MapLibre's "globe" projection IS the nullschool behaviour:
    // a sphere when zoomed out, easing itself flat around z6 so streets stay
    // streets. Set on every style.load — a basemap or theme swap replaces the
    // style wholesale and would silently flatten the planet again.
    map.on("style.load", () => {
      if (map.setProjection) map.setProjection({ type: "globe" });
      // No setSky here: the v5 atmosphere brings sun-position shading with
      // it, and on the real hardware the lit/dark gradient read as jank, not
      // physics (Jeff 2026-08-20). The bare globe on the page background is
      // the cleaner look.
    });
    // Subscribe before the catalog request. A cached style can emit
    // `style.load` while /api/models is still in flight.
    const styleReady = new Promise((resolve) => {
      map.once("style.load", resolve);
      if (map.isStyleLoaded()) resolve();
    });
    map.on("moveend", () => {
      localStorage.setItem("wxgrid.view", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      if (catalog) renderControls();
      if (!state.point) WX.tape.refreshTapePoint();
      if (WX.provider) WX.provider.refresh();
      if (state.radar && WX.ov.refreshRadarSource) WX.ov.refreshRadarSource();
      pushHash();
    });
    wind = new WindLayer(map, $("#particles"));
    if (WX.probe && WX.probe.wireCityValues) WX.probe.wireCityValues();
    WX.windLayer = wind;
    wind.setDensity(state.particleDensity);
    // A taller tape leaves less room for a hand-sized card, so re-clamp it —
    // but never mid-drag, where it would fight the pointer.
    new ResizeObserver(() => { document.documentElement.style.setProperty("--tb-h", $("#timebar").offsetHeight + "px");
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      if (!document.body.classList.contains("resizing-tape")) restorePointPanelSize(); }).observe($("#timebar"));
    new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $("#topbar").offsetHeight + "px")).observe($("#topbar"));
    wirePanelResizers();

    catalog = await WX.api(`${API}/models?ts=${Date.now()}`);
    if (catalog.static) toast(`Static demo, run ${catalog.static.built}Z. ${catalog.static.note}.`, 9000);
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs yet. Ingest is still running.", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];

    if (hash) { if (hash.model && catalog.models.some((m) => m.key === hash.model && m.runs.length)) state.model = hash.model; if (hash.layer && LAYERS.includes(hash.layer)) state.layer = hash.layer; state.level = hash.level || 0; state.run = modelEntry().runs[0].run; if (hash.step != null) state.stepIdx = Math.min(hash.step, steps().length - 1); }
    // The controls and forecast table only need the local catalog. Painting
    // them behind MapLibre's `load` event made a cold start wait for the
    // remote basemap's tiles, glyphs and sprites before showing local data.
    renderControls();
    if (WX.mapmenu) WX.mapmenu.wire();
    applyStep(false);
    const tapeReady = hash && hash.pt ? Promise.resolve() : WX.tape.refreshTapePoint();
    if (hash && hash.pt) openPoint(hash.pt[0], hash.pt[1]);
    const windReady = loadWind(false);
    const initialDataReady = Promise.allSettled([windReady, tapeReady]);
    WX.initialDataReady = initialDataReady;
    initialDataReady.then(() => document.dispatchEvent(new Event("wx-initial-data")));
    if (WX.tour) setTimeout(() => WX.tour.start(), 1200);

    map.on("click", (e) => {
      // isStyleLoaded() is about TILES, not the style: it goes false whenever a
      // source is streaming, which at street zoom is most of the time. Guarding
      // on it swallowed clicks — resort pins stopped opening. Ask instead
      // whether the layer we are about to query exists.
      const has = (l) => { try { return !!map.getLayer(l); } catch (_) { return false; } };
      if (state.measure) { WX.ov.measureClick(e.lngLat); return; }
      if (state.xsection) { WX.xs.click(e.lngLat); return; }
      if (state.route && WX.route && !WX.route.active) { WX.route.addPoint(e.lngLat); return; }
      // Something on the map that has its own popup owns the click. Without
      // this a fire report opened underneath a location card nobody asked for.
      const owned = ["fire-inc", "fire-perim-fill", "sigmet-fill", "quakes", "storm-pts"].filter(has);
      if (owned.length && map.queryRenderedFeatures(e.point, { layers: owned }).length) return;
      const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-pts", "avy-fill"].filter(has) });
      const resort = feats.find((x) => x.layer.id === "resort-pts");
      if (resort) { WX.ov.selectResort(resort.properties.id); return; }
      openPoint(e.lngLat.lat, e.lngLat.lng);
      const avy = feats.find((x) => x.layer.id === "avy-fill");
      if (avy) { state.tab = "winter"; }
    });
    map.on("mousemove", (e) => { if (WX.probe) WX.probe.hover(e.lngLat); });
    map.on("mouseout", () => { if (WX.probe) WX.probe.hover(null); });
    map.on("moveend", () => { if (WX.provider) WX.provider.refresh(); });
    map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");

    const loadInitialWeather = () => {
      // Add the selected image as soon as the style exists; `load` waits for
      // the basemap's initial tiles as well. Do not immediately update the
      // source to the same URL or prefetch the next 1 MB frame alongside it.
      const prefetchNext = (e) => {
        if (e.sourceId !== "wx" || !e.isSourceLoaded) return;
        map.off("sourcedata", prefetchNext);
        // The next frame is useful, but only after the current image, wind
        // field and tape have finished. It must not compete with first paint.
        initialDataReady.then(() => {
          const img = new Image();
          img.src = layerUrl(steps()[(state.stepIdx + 1) % steps().length]);
        });
      };
      map.on("sourcedata", prefetchNext);
      ensureWxLayer();
    };
    styleReady.then(loadInitialWeather).catch(() => ensureWxLayer());
  }
  // How solid the weather field is. Past z9 it steps back: at street zoom the
  // field is one world-sized image being stretched, and the ground underneath
  // it — streets, lifts, runs — is what you zoomed in for.
  function rasterOpacity() {
    const a = ((state.radar || state.sat) ? Math.min(0.45, LAYER_ALPHA[state.layer]) : LAYER_ALPHA[state.layer]) * state.opacity / 100;
    return ["interpolate", ["linear"], ["zoom"], 9, a, 13, Math.max(0.1, a * 0.22)];
  }
  const firstSymbolId = () => { const l = map.getStyle().layers.find((x) => x.type === "symbol"); return l ? l.id : undefined; };
  const mapStyle = () => document.documentElement.dataset.theme === "light" ? "https://tiles.openfreemap.org/styles/positron" : "https://tiles.openfreemap.org/styles/dark";
  function ensureWxLayer() {
    if (!map.getSource("wx")) {
      map.addSource("wx", { type: "image", url: layerUrl(), coordinates: modelCoords() });
      map.addLayer({ id: "wx", type: "raster", source: "wx", paint: { "raster-opacity": rasterOpacity(), "raster-fade-duration": 0, "raster-resampling": "linear" } }, firstSymbolId());
    }
    ensureCoastLayer();
  }
  // A weather field painted over the whole world hides the one thing you need
  // to read it: where the land stops. The basemap's own coastline is under the
  // field, so trace it again on top — thin, low contrast, wider as you zoom in.
  function ensureCoastLayer() {
    if (!map.getSource("openmaptiles") || map.getLayer("wx-coast")) return;
    const light = document.documentElement.dataset.theme === "light";
    map.addLayer({
      id: "wx-coast", type: "line", source: "openmaptiles", "source-layer": "water",
      paint: {
        "line-color": light ? "rgba(22,32,48,.62)" : "rgba(226,238,255,.66)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 4, 0.9, 7, 1.3, 11, 2],
        "line-blur": 0.3,
      },
    }, firstSymbolId());
  }
  // After a basemap swap every custom source is gone; put back whatever was on.
  function restoreLayers() {
    ensureWxLayer(); ensureCoastLayer(); applyStep();
    if (state.radar && state.radarFrames.length) WX.ov.applyRadarFrame();
    if (state.iso) WX.ov.loadIso();
    if (state.avy) WX.ov.loadAvy();
    if (state.resorts) WX.ov.loadResorts();
    if (state.resort) WX.ov.selectResort(state.resort.resort.id);
    if (state.alerts) WX.ov.loadAlerts();
    if (state.storms) WX.ov.loadStorms();
    if (state.sat) WX.ov.loadSat();
    if (state.base) WX.ov.setBase(state.base);
    if (state.terrain) WX.ov.loadTerrain();
    if (state.night) WX.ov.updateNight();
    if (state.smoke) WX.ov.loadSmoke();
    if (state.fires) WX.fires.load();
    if (state.quakes) WX.ov.loadQuakes();
    if (state.aod) WX.ov.loadAod();
    if (state.sigmet) WX.sigmet.load();
    if (state.aurora && WX.sky) WX.sky.aurora.load(true);
    if (state.aq) WX.cams.load(state.aqVar);
    if (state.thunder) WX.ov.loadThunder();
    if (marker) marker.addTo(map);
  }
  function applyTheme(theme, swapMap = true) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("wxgrid.theme", theme);
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#eef1f5" : "#000000";
    if (swapMap && map) {
      map.setStyle(mapStyle(), { diff: false });
      // style.load is what fires once the new style's sources exist; idle
      // is the belt for the braces on builds where it doesn't.
      map.once("style.load", restoreLayers);
      map.once("idle", () => { if (!map.getSource("wx")) restoreLayers(); });
    }
  }

  // ── permalink: #lat,lon,zoom · model · layer[/level] · step [· pt lat,lon]
  function readHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return null;
    const m = h.match(/^(-?[\d.]+),(-?[\d.]+),([\d.]+)(?:;([a-z]+))?(?:;([a-z_0-9]+)(?:\/(\d+))?)?(?:;s(\d+))?(?:;p(-?[\d.]+),(-?[\d.]+))?/);
    if (!m) return null;
    return { lat: +m[1], lon: +m[2], zoom: +m[3], model: m[4], layer: m[5], level: m[6] ? +m[6] : 0, step: m[7] != null ? +m[7] : null, pt: m[8] ? [+m[8], +m[9]] : null };
  }
  let hashTimer = null, ownHash = "";
  // Paste a permalink into an already-open tab and the view should move. The
  // browser treats a hash-only change as same-document, so nothing reloads —
  // we have to apply it ourselves, ignoring the hashes we write.
  function applyHash() {
    if (location.hash === ownHash) return;
    const h = readHash();
    if (!h) return;
    // A hash can change while boot is still waiting on the catalog — paste a
    // permalink into a cold tab and this ran with nothing to read. boot() reads
    // the hash itself, so there is nothing to do here until it has landed.
    if (!catalog) return;
    if (h.model && catalog.models.some((m) => m.key === h.model && m.runs.length)) { state.model = h.model; state.run = modelEntry().runs[0].run; }
    if (h.layer && LAYERS.includes(h.layer) && runEntry().layers.includes(h.layer)) state.layer = h.layer;
    state.level = h.level || 0;
    if (h.step != null) state.stepIdx = Math.min(h.step, steps().length - 1);
    map.jumpTo({ center: [h.lon, h.lat], zoom: h.zoom });
    renderControls(); applyStep(); loadWind();
    if (h.pt) openPoint(h.pt[0], h.pt[1]); else closePoint();
  }
  window.addEventListener("hashchange", applyHash);

  function pushHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      if (!map) return;
      const c = map.getCenter();
      let h = `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(2)};${state.model};${state.layer}${state.level ? "/" + state.level : ""};s${state.stepIdx}`;
      if (state.point) h += `;p${state.point.lat.toFixed(3)},${state.point.lon.toFixed(3)}`;
      ownHash = "#" + h;
      history.replaceState(null, "", ownHash);
    }, 250);
  }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + stepHours() * 3600e3);
  const hasLevel = () => ["wind", "temp"].includes(state.layer);
  const isWaves = () => ["waves", "wperiod", "wavepower"].includes(state.layer);
  const levelQ = () => (state.level && hasLevel()) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => U(`${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  const windUrl = (h = stepHours()) => U(`${API}/wind/${state.model}/${state.run}/${h}.json${isWaves() ? "?field=waves" : state.level ? `?level=${state.level}` : ""}`);
  const modelCoords = (m = modelEntry()) => {
    if (!m || !m.regional) return WORLD;
    const [w, s, e, n] = m.domain;
    return [[w, n], [e, n], [e, s], [w, s]];
  };
  const modelInView = (m) => {
    if (!m || !m.regional || !map) return true;
    const c = map.getCenter(), lon = wlon(c.lng), [w, s, e, n] = m.domain;
    return c.lat >= s && c.lat <= n && lon >= w && lon <= e;
  };

  // ── controls ──────────────────────────────────────────────────────────
  // Opacity has two entry points — the settings drawer and the rail — so it
  // gets one setter that leaves both showing the same number.
  function setOpacity(v) {
    state.opacity = v;
    localStorage.setItem("wxgrid.opacity", v);
    const drawer = $("#opacity"), rail = document.querySelector(".rail-opacity input");
    if (drawer) drawer.value = String(v);
    if (rail) { rail.value = String(v); rail.parentElement.querySelector("i").textContent = `${v}%`; }
    applyStep(false);
  }
  // Phone only: the model, run, level and layer rows fold into one chip that
  // names what the map is showing. The chip is the way back out.
  function renderTucked(showLevels) {
    const el = $("#tucked"); if (!el) return;
    const m = modelEntry();
    const fam = FAMILIES.find((f) => f.layers.includes(state.layer));
    const parts = [`${m.short}${m.grid ? `<i class="grid">${m.grid}</i>` : ""}`];
    if (showLevels) parts.push(state.level ? `${state.level}` : "sfc");
    parts.push(fam ? fam.label : LAYER_LABEL[state.layer] || state.layer);
    el.innerHTML = parts.join(`<i>·</i>`) + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  }
  const phoneMQ = matchMedia("(max-width: 820px)");
  let softTucked = false;
  function setTucked(on, persist = true) {
    const phone = phoneMQ.matches;
    document.body.classList.toggle("tucked", on && phone);
    $("#tuck").hidden = !phone || on;
    $("#tucked").hidden = !phone || !on;
    if (persist) localStorage.setItem("wxgrid.tucked", on ? "1" : "0");
  }
  function setParticleDensity(v) {
    state.particleDensity = Math.max(0, Math.min(100, v));
    localStorage.setItem("wxgrid.particleDensity", state.particleDensity);
    const rail = document.querySelector(".rail-density input");
    if (rail) {
      rail.value = String(state.particleDensity);
      rail.parentElement.querySelector("i").textContent = `${state.particleDensity}%`;
    }
    if (wind) wind.setDensity(state.particleDensity);
  }
  // The model and pressure pickers share one sliding selection plate. Keep the
  // old plate's geometry across a re-render so changing model metadata (the
  // selected grid badge) does not turn a smooth move into a flash.
  function renderSlidingSeg(el, buttons) {
    const old = el.querySelector(".seg-cursor");
    const prior = old ? old.getBoundingClientRect() : null;
    el.classList.add("sliding");
    el.innerHTML = `<i class="seg-cursor" aria-hidden="true"></i>${buttons}`;
    const cursor = el.querySelector(".seg-cursor");
    const place = () => {
      const active = el.querySelector("button.on");
      if (!active) { cursor.style.opacity = "0"; return; }
      // Rects, not offsetWidth/offsetLeft: those are rounded to integers,
      // and on a page-zoomed layout the real boxes are fractional — the
      // rounding drift put the plate half a button off (Jeff 2026-08-20).
      const br = active.getBoundingClientRect(), sr = el.getBoundingClientRect();
      // Measured while hidden (the tucked topbar folds #models away): every
      // rect is zero and placing now bakes a ghost. The observer below
      // replays the moment the seg has a size again.
      if (!sr.width) return;
      cursor.style.opacity = "1";
      cursor.style.width = `${br.width}px`;
      cursor.style.transform = `translateX(${br.left - sr.left + el.scrollLeft}px)`;
    };
    el._segPlace = place;
    if (!el._segRo && window.ResizeObserver) {
      el._segRo = new ResizeObserver(() => el._segPlace && el._segPlace());
      el._segRo.observe(el);
    }
    // The altitude badge grows and folds by animation, and the cursor plate
    // measured mid-peek kept the wide width forever — the "elongated pill"
    // (Jeff 2026-08-21, twice). Re-place at both ends of any child animation.
    if (!el._segAnim) {
      el._segAnim = true;
      el.addEventListener("animationstart", () => requestAnimationFrame(() => el._segPlace && el._segPlace()));
      el.addEventListener("animationend", () => el._segPlace && el._segPlace());
    }
    if (prior && prior.width) {
      const box = el.getBoundingClientRect();
      cursor.style.width = `${prior.width}px`;
      cursor.style.transform = `translateX(${prior.left - box.left + el.scrollLeft}px)`;
      cursor.getBoundingClientRect();
      cursor.classList.add("ready");
      requestAnimationFrame(place);
    } else {
      place();
      requestAnimationFrame(() => cursor.classList.add("ready"));
    }
    // The first placement can measure before the display font arrives, and a
    // plate sized to fallback-font text sits half a button off. Re-measure
    // when the fonts land (and belt-and-braces, once more a beat later).
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => requestAnimationFrame(place));
    setTimeout(place, 600);
  }
  // Overlays that paint the whole ground — radar, satellite, smoke, aerosol,
  // air quality — cannot be read two at a time; the top one just hides the one
  // under it. Turning one on turns the others off. Overlays that draw MARKS on
  // the map (fires, quakes, alerts, storms, SIGMET, aurora, lightning) stack
  // fine and are left alone.
  const GROUND_COVER = [["radar", "#radar-toggle"], ["sat", "#sat-toggle"], ["smoke", "#smoke-toggle"],
                        ["aod", "#aod-toggle"], ["aq", "#aq-toggle"]];
  function clearOtherCover(keep) {
    for (const [key, sel] of GROUND_COVER) {
      if (key === keep || !state[key]) continue;
      const btn = $(sel);
      if (btn) btn.click();                      // each toggle owns its own teardown
    }
  }

  function renderControls() {
    const ms = $("#models");
    // The selected model also says what it resolves. Only the selected one:
    // six grid figures across the top bar is noise, one is information.
    // Every model, always visible, flat — the AI-children fold was vetoed
    // (Jeff 2026-08-21: "go back to how it was"). A long row swipes/scrolls
    // sideways; it never hides members.
    renderSlidingSeg(ms, catalog.models.map((m) => {
      const on = m.key === state.model;
      const inView = modelInView(m);
      const enabled = m.runs.length && inView;
      const why = !m.runs.length ? "no ingested run" : !inView ? "map centre outside forecast domain" : "";
      return `<button data-model="${m.key}" class="${on ? "on" : ""}" ${enabled ? "" : "disabled"} title="${m.label}${m.grid ? ` · ${m.grid}` : ""}${why ? ` · ${why}` : ""}">${m.short}${on && m.grid ? `<i class="grid">${m.grid}</i>` : ""}</button>`;
    }).join(""));
    ms.querySelectorAll("button").forEach((b) => b.onclick = () => switchModel(b.dataset.model));

    // The run dropdown is retired (Jeff 2026-08-21: switching it "doesn't
    // seem to change anything" — the honest answer is that two runs six
    // hours apart usually LOOK identical, so the control read as broken).
    // The app always reads the newest run; the API still serves older ones.
    const rs = $("#run");
    rs.hidden = true;
    // Always the newest CONCRETE run id — never the string "latest": layer
    // URLs are cached immutable by the service worker, so a "latest" URL
    // would freeze the field at whatever it first showed.
    if (modelEntry().runs.length && !modelEntry().runs.some((r) => r.run === state.run)) { state.run = modelEntry().runs[0].run; clampStep(); }

    const rail = $("#layers");
    const avail = runEntry().layers;
    const fam = familyOf(state.layer);
    rail.innerHTML = FAMILIES.map((f) => {
      const ok = f.layers.some((l) => avail.includes(l));
      const on = f.key === fam.key;
      return `${f.section ? `<div class="rail-sec">${f.section}</div>` : ""}<button class="${on ? "on" : ""}" data-family="${f.key}" ${ok ? "" : "disabled"} title="${f.label}${ok ? "" : " (not in this model)"}">${LAYER_ICON[FAMILY_ICON[f.key]]}<span>${f.label}</span>${f.variants ? `<i class="var">${f.variants[on ? state.layer : f.layers.find((l) => avail.includes(l)) || f.layers[0]] || ""}</i>` : ""}</button>`;
    }).join("") + `<div class="rail-sec">Field</div>
      <div class="rail-seg" role="group" aria-label="Wind animation">
        <span>Motion</span>
        <div class="seg small">
          <button data-motion="particles" class="${state.particles ? "on" : ""}">Streams</button>
          <button data-motion="barbs" class="${state.barbs ? "on" : ""}">Barbs</button>
          <button data-motion="off" class="${!state.particles && !state.barbs ? "on" : ""}">Off</button>
        </div>
      </div>
      <button class="rail-flat ${state.iso ? "on" : ""}" data-rail="iso">${LAYER_ICON.iso || ""}<span>Isolines</span></button>
      <label class="rail-opacity" title="Layer opacity">
        <span>Opacity</span><input type="range" min="20" max="100" step="5" value="${state.opacity}"><i>${state.opacity}%</i></label>
      <label class="rail-opacity rail-density" title="Particle density">
        <span>Density</span><input type="range" min="0" max="100" step="5" value="${state.particleDensity}"><i>${state.particleDensity}%</i></label>`;
    const railOp = rail.querySelector(".rail-opacity input");
    railOp.oninput = () => { setOpacity(Number(railOp.value)); };
    const density = rail.querySelector(".rail-density input");
    density.oninput = () => { setParticleDensity(Number(density.value)); };
    // The rail proxies the buttons that already own this state, so there is
    // still one place a toggle actually lives.
    rail.querySelectorAll("[data-motion]").forEach((b) => b.onclick = () => {
      const want = b.dataset.motion;
      if (want === "particles" && !state.particles) $("#particles-toggle").click();
      else if (want === "barbs" && !state.barbs) $("#barbs-toggle").click();
      else if (want === "off") { if (state.particles) $("#particles-toggle").click(); if (state.barbs) $("#barbs-toggle").click(); }
      renderControls();
    });
    const railIso = rail.querySelector('[data-rail="iso"]');
    if (railIso) railIso.onclick = () => { $("#iso-toggle").click(); renderControls(); };
    // Only the layer buttons: the rail also holds motion, isolines and opacity,
    // and this handler used to claim their clicks as well.
    rail.querySelectorAll("button[data-family]").forEach((b) => b.onclick = () => {
      const f = FAMILIES.find((x) => x.key === b.dataset.family);
      // remember the last variant used per family
      const pref = localStorage.getItem("wxgrid.variant." + f.key);
      state.layer = (pref && f.layers.includes(pref) && avail.includes(pref)) ? pref : f.layers.find((l) => avail.includes(l)) || f.layers[0];
      localStorage.setItem("wxgrid.layer", state.layer);
      if (!hasLevel()) state.level = 0;
      renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    // variant picker (rain 6h/24h/72h …) sits in the time bar next to the legend
    const vp = $("#variant");
    if (fam.variants) {
      vp.hidden = false;
      vp.innerHTML = fam.layers.map((l) => `<button data-layer="${l}" class="${l === state.layer ? "on" : ""}" ${avail.includes(l) ? "" : "disabled"}>${fam.variants[l]}</button>`).join("");
      vp.querySelectorAll("button").forEach((b) => b.onclick = () => { state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer); localStorage.setItem("wxgrid.variant." + fam.key, state.layer); renderControls(); applyStep(); loadWind(); });
    } else { vp.hidden = true; vp.innerHTML = ""; }

    const lv = $("#levels");
    const levels = runEntry().levels || [];
    const showLevels = hasLevel() && levels.length;
    // Desktop keeps the row for every layer, greyed out: disappearing chrome
    // makes the bar jump and reads like a bug (Jeff 2026-08-18). A phone has
    // four rows of chrome and no room for one that cannot be pressed, so there
    // it goes away — see `body.no-levels` (Jeff 2026-08-19).
    lv.hidden = !levels.length;
    document.body.classList.toggle("no-levels", !showLevels);
    lv.classList.toggle("disabled", !showLevels);
    lv.title = showLevels ? "" : `${LAYER_LABEL[state.layer]} is a surface field`;
    renderTucked(showLevels);
    if (!showLevels && levels.length) {
      renderSlidingSeg(lv, [0, ...levels].map((l) => `<button data-level="${l}" class="${l === 0 ? "on" : ""}" disabled>${l || "sfc"}</button>`).join(""));
    }
    if (showLevels) {
      const opts = [0, ...levels];
      if (!opts.includes(state.level)) state.level = 0;
      // Native title tooltips show all three systems; the badge follows the
      // explicit pressure-level unit chosen in Settings.
      renderSlidingSeg(lv, opts.map((l) => `<button data-level="${l}" class="${l === state.level ? "on" : ""}" title="${l ? `${l} hPa · ${LEVEL_M[l]} · ${LEVEL_FEET[l]} · ${LEVEL_FT[l]}` : "surface · 10 m wind · 2 m temperature"}">${l ? `${l}${l === state.level ? `<i class="level-alt">${levelBadge(l)}</i>` : ""}` : "sfc"}</button>`).join(""));
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => { state.level = Number(b.dataset.level); renderControls(); applyStep(false); loadWind(false); if (state.iso) WX.ov.loadIso(); });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    slider.value = String(state.stepIdx);
    slider.oninput = () => { state.stepIdx = Number(slider.value); applyStep(false); };
    slider.onchange = () => { applyStep(true); loadWind(); };

    renderLegend();
    if (!uiWired) { uiWired = true; wireOnce(); }
  }

  // Everything here binds once. It used to live at the tail of
  // renderControls, which runs on every model, level and layer change, so
  // every document listener stacked one copy per change: arrow keys stepped
  // twice, then three times, and the menu buttons toggled themselves shut.
  function wireOnce() {
    $("#play").onclick = togglePlay;
    // Back to the present in one tap: scrubbing four days out and finding your
    // way home by dragging is the kind of thing a button fixes.
    $("#tape-now").onclick = () => { setStep(currentStepIdx()); WX.tape.renderTapeSelection(); };
    // The tape answers LEFT-RIGHT only. Mapping vertical wheel to time
    // steps lasted one day: an iPad trackpad's two-finger scroll fired it
    // continuously and the tape went haywire (Jeff 2026-08-20). Vertical
    // motion over the tape is now simply locked out, so the tape holds
    // still and horizontal swipes keep scrolling it natively.
    $("#timebar").addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.target.closest("input")) e.preventDefault();
    }, { passive: false });
    $("#tuck").onclick = () => setTucked(true);
    $("#tucked").onclick = () => setTucked(false);
    // A phone's search box is a third of the row; the long placeholder was
    // always cut mid-word.
    const fitPhone = () => {
      setTucked(localStorage.getItem("wxgrid.tucked") === "1", false);
    };
    fitPhone(); phoneMQ.addEventListener("change", fitPhone);
    // An upstream going dark used to announce itself only as a blank pane.
    // The wordmark wears a small amber dot instead; hover names the culprits.
    const health = async () => {
      try {
        const h = await WX.api(`${API}/health`);
        const brand = $(".brand");
        brand.classList.toggle("degraded", h.down.length > 0);
        brand.title = h.down.length ? `Not answering: ${h.down.join(", ")}` : "wxgrid";
      } catch (e) { /* the app itself being down needs no dot */ }
    };
    if (!window.WXStatic) { setTimeout(health, 15e3); setInterval(health, 300e3); }
    const tb = $("#timebar"), tmin = $("#tape-min");
    // Three states, because "collapsed" and "gone" are different wants: full
    // table, header only, or out of the way entirely with just its grip left.
    let tapeAnim = 0;
    setTapeState = (s, persist = true) => {
      const prev = tapeState;
      tapeState = s;
      const apply = () => {
        tb.classList.toggle("mini", s === "mini");
        tb.classList.toggle("tape-away", s === "away");
      };
      // The fold used to CUT between heights. Glide instead: measure both
      // ends, clip the box, and slide — the row swap happens at the short
      // end of the glide where the eye is on motion, not content.
      const animatable = prev !== s && !tb.classList.contains("user-sized") &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches && (prev === "mini" || prev === "full") && (s === "mini" || s === "full");
      if (animatable) {
        clearTimeout(tapeAnim);
        const from = tb.offsetHeight;
        apply();
        const to = tb.offsetHeight;
        // .mini pins height with !important, so the glide runs WITHOUT the
        // class and swaps it in at the end; going to full the class state is
        // already right and the box just opens onto the real rows.
        if (s === "mini") tb.classList.remove("mini");
        tb.classList.add("tape-anim");
        tb.style.height = from + "px";
        tb.getBoundingClientRect();
        tb.style.height = to + "px";
        tapeAnim = setTimeout(() => {
          tb.classList.remove("tape-anim");
          tb.style.height = "";
          if (s === "mini") tb.classList.add("mini");
          document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px");
        }, 240);
      } else apply();
      if (persist) localStorage.setItem("wxgrid.tapeState", s);
      tmin.title = s === "full" ? "Collapse the forecast table" : "Show the forecast table";
      requestAnimationFrame(() => document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px"));
    };
    const savedState = localStorage.getItem("wxgrid.tapeState")
      || (localStorage.getItem("wxgrid.tapeMini") === "1" ? "mini" : "full");
    setTapeState(["full", "mini", "away"].includes(savedState) ? savedState : "full", false);
    tmin.onclick = () => setTapeState(tapeState === "full" ? "mini" : "full");
    // the crosshair button map apps have: centre here and open the card
    const goToMe = () => {
      if (!navigator.geolocation) { toast("This browser has no location service", 4000, "error"); return; }
      $("#locate-btn").classList.add("on");
      navigator.geolocation.getCurrentPosition(
        (pos) => { $("#locate-btn").classList.remove("on"); map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 8), duration: 900 }); openPoint(pos.coords.latitude, pos.coords.longitude); },
        () => { $("#locate-btn").classList.remove("on"); toast("Location unavailable. Allow it for this site and try again.", 5000, "error"); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    };
    $("#locate-btn").onclick = goToMe;
    $("#particles-toggle").onclick = () => { state.particles = !state.particles; $("#particles-toggle").classList.toggle("on", state.particles); if (state.particles) { state.barbs = false; $("#barbs-toggle").classList.remove("on"); wind.setMode("particles"); } wind.setEnabled(state.particles || state.barbs); };
    $("#barbs-toggle").onclick = () => { state.barbs = !state.barbs; $("#barbs-toggle").classList.toggle("on", state.barbs); if (state.barbs) { state.particles = false; $("#particles-toggle").classList.remove("on"); wind.setEnabled(true); wind.setMode("barbs"); } else { wind.setMode("particles"); wind.setEnabled(state.particles); } };
    $("#units-toggle").querySelector(".val").textContent = speedUnit();
    $("#units-toggle").onclick = () => {
      state.units = { kmh: "kt", kt: "ms", ms: "mph", mph: "kmh" }[state.units];
      localStorage.setItem("wxgrid.units", state.units);
      $("#units-toggle").querySelector(".val").textContent = speedUnit();
      renderLegend(); renderPoint(); WX.tape.renderTape();
    };
    const op = $("#opacity"); op.value = String(state.opacity);
    op.oninput = () => setOpacity(Number(op.value));
    op.onclick = (e) => e.stopPropagation();
    buildStrip();
    $("#aurora-toggle").onclick = () => { if (!WX.sky) return; state.aurora = !state.aurora; $("#aurora-toggle").classList.toggle("on", state.aurora); if (state.aurora) WX.sky.aurora.load(); else WX.sky.aurora.clear(); };
    $("#lightning-toggle").onclick = () => WX.sky && WX.sky.lightning.load();
    $("#sigmet-toggle").onclick = () => { if (!WX.sigmet) return; state.sigmet = !state.sigmet; $("#sigmet-toggle").classList.toggle("on", state.sigmet); if (state.sigmet) WX.sigmet.load(); else WX.sigmet.clear(); };
    $("#aq-toggle").onclick = () => { if (!WX.cams) return; state.aq = !state.aq; $("#aq-toggle").classList.toggle("on", state.aq); if (state.aq) { clearOtherCover("aq"); WX.cams.load(state.aqVar); } else WX.cams.clear(); };
    $("#fires-toggle").onclick = () => { if (!WX.fires) { toast("Fire overlay is still loading", 2500); return; } state.fires = !state.fires; $("#fires-toggle").classList.toggle("on", state.fires); if (state.fires) WX.fires.load(); else WX.fires.clear(); };
    $("#share-btn").onclick = async () => { pushHash(); await new Promise((r) => setTimeout(r, 300)); try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch (e) { toast(location.href, 6000); } };
    $("#settings-btn").onclick = () => { $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(); };
    $("#keys-btn").onclick = () => { $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(); };
    // a unit change repaints every number on screen at once
    document.addEventListener("wx-units", () => { renderControls(); renderLegend(); renderPoint(); WX.tape.renderTape(); if (WX.probe) WX.probe.hover(null); if (state.xsection && WX.xs) WX.xs.refresh(); $("#units-toggle").querySelector(".val").textContent = speedUnit(); });
    $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    $("#radar-toggle").onclick = () => WX.ov.toggleRadar();
    $$(".base-row button").forEach((b) => b.onclick = () => {
      state.base = b.dataset.base; localStorage.setItem("wxgrid.base", state.base);
      $$(".base-row button").forEach((x) => x.classList.toggle("on", x === b));
      WX.ov.setBase(state.base);
    });
    $$(".base-row button").forEach((x) => x.classList.toggle("on", x.dataset.base === state.base));
    if (state.base) WX.ov.setBase(state.base);
    $("#terrain-toggle").onclick = () => { state.terrain = !state.terrain; localStorage.setItem("wxgrid.terrain", state.terrain ? "1" : "0"); $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain(); else WX.ov.clearTerrain(); };
    $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain();
    $("#night-toggle").onclick = () => { state.night = !state.night; $("#night-toggle").classList.toggle("on", state.night); if (state.night) WX.ov.updateNight(); else WX.ov.clearNight(); };
    $("#alerts-toggle").onclick = () => { state.alerts = !state.alerts; $("#alerts-toggle").classList.toggle("on", state.alerts); if (state.alerts) WX.ov.loadAlerts(); else WX.ov.clearAlerts(); };
    $("#storms-toggle").onclick = () => { state.storms = !state.storms; $("#storms-toggle").classList.toggle("on", state.storms); if (state.storms) WX.ov.loadStorms(); else WX.ov.clearStorms(); };
    $("#sat-toggle").onclick = () => { state.sat = !state.sat; $("#sat-toggle").classList.toggle("on", state.sat); if (state.sat) { clearOtherCover("sat"); WX.ov.loadSat(); } else WX.ov.clearSat(); };
    for (const [k, load, clear] of [["smoke", "loadSmoke", "clearSmoke"], ["quakes", "loadQuakes", "clearQuakes"], ["aod", "loadAod", "clearAod"], ["thunder", "loadThunder", "clearThunder"]]) {
      $(`#${k}-toggle`).onclick = () => { state[k] = !state[k]; $(`#${k}-toggle`).classList.toggle("on", state[k]);
        if (state[k]) { if (k === "smoke" || k === "aod") clearOtherCover(k); WX.ov[load](); } else WX.ov[clear](); };
    }
    $("#theme-toggle").onclick = () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme; };
    $("#route-toggle").onclick = () => {
      if (!WX.route) { toast("Route forecast is not in this build.", 4000, "error"); return; }
      const on = !state.route; state.route = on; $("#route-toggle").classList.toggle("on", on);
      if (on) WX.route.start(); else WX.route.stop();
    };
    $("#xsection-toggle").onclick = () => { if (!WX.xs) { toast("Cross section is still loading", 2500); return; } const on = !state.xsection; $("#xsection-toggle").classList.toggle("on", on); if (on) WX.xs.start(); else WX.xs.stop(); };
    $("#measure-toggle").onclick = () => { state.measure = !state.measure; $("#measure-toggle").classList.toggle("on", state.measure); $("#measure-toggle").querySelector(".val").textContent = state.measure ? "on" : "off"; if (!state.measure) WX.ov.clearMeasure(); else toast("Tap two points to measure."); };
    $("#iso-toggle").onclick = () => { state.iso = !state.iso; localStorage.setItem("wxgrid.iso", state.iso ? "1" : "0"); $("#iso-toggle").classList.toggle("on", state.iso); if (state.iso) WX.ov.loadIso(); else WX.ov.clearIso(); };
    // Isolines come back the way you left them (Jeff 2026-08-21). Deferred
    // to map load: loadIso adds a source, and the style may still be inbound.
    const restoreIso = () => { if (localStorage.getItem("wxgrid.iso") === "1" && !state.iso) $("#iso-toggle").click(); };
    if (map && map.isStyleLoaded && map.isStyleLoaded()) restoreIso(); else if (map) map.once("load", restoreIso);
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts(); };
    $("#locate").onclick = goToMe;
    $("#point-close").onclick = closePoint;
    wireSheet();
    $("#point-fav").onclick = () => { if (!state.point) return; const on = WX.search.toggleFav(state.point.lat, state.point.lon, state.point.name); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; toast(on ? "Saved. Find it in the search box." : "Removed", 2500); };
    WX.search.wireSearch();
    const toggleMenu = (b) => { const m = b.parentElement; const open = m.classList.contains("open"); $$(".menu.open").forEach((x) => x.classList.remove("open")); if (!open) m.classList.add("open"); };
    // iOS Safari was swallowing taps on these two buttons (the only top-bar
    // controls that are icon-only inside a pointer-events:none bar). Answer
    // the touch itself and cancel the click it would have synthesised.
    $$(".menu .menu-btn").forEach((b) => {
      let touched = 0;
      b.addEventListener("touchend", (e) => { touched = Date.now(); e.preventDefault(); toggleMenu(b); }, { passive: false });
      b.onclick = (e) => { e.stopPropagation(); if (Date.now() - touched < 700) return; toggleMenu(b); };
    });
    // menu buttons show a tick when any of their toggles is on
    new MutationObserver(() => $$(".menu").forEach((m) => m.querySelector(".menu-btn").classList.toggle("has-on", !!m.querySelector(".menu-pop .chip.on:not(#particles-toggle):not(#barbs-toggle)")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
    const closeMenusOutside = (e) => { if (!e.target.closest(".menu")) $$(".menu.open").forEach((x) => x.classList.remove("open")); };
    document.addEventListener("click", closeMenusOutside);
    document.addEventListener("touchend", closeMenusOutside, { passive: true });
    $$(".point-tabs button").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; renderPoint(); });
    document.addEventListener("keydown", (e) => {
      if (["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") nudge(1);
      else if (e.key === "ArrowLeft") nudge(-1);
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "Escape") { closePoint(); WX.search.hideResults(); $$(".menu.open").forEach((x) => x.classList.remove("open")); }
      else if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
      else if (e.key === "l" || e.key === "L") { $("#overlays-menu").classList.toggle("open"); }
      else if (e.key === "n" || e.key === "N") { setStep(currentStepIdx()); WX.tape.renderTapeSelection(); }
      else if (e.key === "?") { WX.settings.open(); }
      else if (e.key >= "1" && e.key <= "9") {                 // 1-9 pick a layer
        const btns = $$(".rail button[data-family]:not(:disabled)");
        const b = btns[Number(e.key) - 1]; if (b) b.click();
      } else if (e.key === "[" || e.key === "]") {             // walk the altitude
        const opts = $$("#levels button:not(:disabled)");
        const k = opts.findIndex((b) => b.classList.contains("on"));
        const next = opts[k + (e.key === "]" ? 1 : -1)]; if (k >= 0 && next) next.click();
      }
    });
  }

  // Desktop tool strip: icon proxies for the toggles that live in the topbar
  // menus. Clicking proxies the real button; the observer below mirrors state.
  const STRIP = [
    ["radar", "Radar"], ["sat", "Satellite"], ["aurora", "Aurora"], ["aod", "Aerosol"], ["iso", "Isolines"], null,
    ["alerts", "Alerts", "warn"], ["storms", "Storms", "warn"], ["thunder", "Thunder", "warn"], ["sigmet", "SIGMET", "warn"], ["fires", "Fires", "warn"], ["smoke", "Smoke"], ["aq", "Air quality"], ["quakes", "Quakes"], null,
    ["avy", "Avalanche"], ["resorts", "Ski resorts"], null,
    ["particles", "Particles"], ["barbs", "Barbs"], null,
    ["xsection", "Cross section"], ["route", "Route forecast"], ["measure", "Measure"],
  ];
  function buildStrip() {
    const st = $("#tstrip"); if (!st) return;
    // renderControls runs for every model, level and layer change. The strip is
    // structural, not model data: building it again appended another flyout
    // to body and duplicated the overflow controls on every selection.
    if (st.dataset.built === "1") { fitStrip(); return; }
    document.querySelectorAll("#strip-more-pop").forEach((el) => el.remove());
    st.dataset.built = "1";
    st.innerHTML = STRIP.map((it) => {
      if (!it) return '<div class="sep"></div>';
      const [k, tip, cls] = it; const src = $(`#${k}-toggle`); if (!src) return "";
      const svg = src.querySelector("svg") ? src.querySelector("svg").outerHTML : "";
      return `<button data-for="${k}-toggle" data-tip="${tip}" class="${cls || ""}${src.classList.contains("on") ? " on" : ""}" aria-label="${tip}">${svg}</button>`;
    }).join("");
    // settings is not a proxy for a menu toggle — it opens the drawer
    st.insertAdjacentHTML("beforeend", `<div class="sep"></div>
      <button data-tip="Units and settings" aria-label="Settings" id="strip-settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.5.66.86 1.2.98H21a2 2 0 1 1 0 4h-.09c-.54.02-1 .38-1.2.88z"/></svg></button>`);
    st.querySelectorAll("button[data-for]").forEach((b) => b.onclick = () => $("#" + b.dataset.for).click());
    // Keep one canonical settings action, just like every other strip proxy.
    // The strip is built before the menu handlers are wired, but the proxy
    // resolves the menu button at click time after wiring has completed.
    $("#strip-settings").onclick = () => $("#settings-btn").click();
    // the crosshair is part of the strip on desktop, so the two can never
    // collide the way a floating button did
    st.insertAdjacentHTML("beforeend", `<button class="strip-locate" data-tip="My location" aria-label="My location">${$("#locate-btn").innerHTML}</button>`);
    st.querySelector(".strip-locate").onclick = () => $("#locate-btn").click();
    // overflow flyout: the strip stays fixed, the extras animate out beside it
    st.insertAdjacentHTML("beforeend", `<button id="strip-more" data-tip="More layers and tools" aria-label="More" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>`);
    document.body.insertAdjacentHTML("beforeend", '<div id="strip-more-pop" class="tstrip strip-pop"></div>');
    $("#strip-more").onclick = (e) => { e.stopPropagation(); st.classList.toggle("more-open"); positionMorePop(); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#tstrip") && !e.target.closest("#strip-more-pop")) st.classList.remove("more-open"); });
    fitStrip();
    addEventListener("resize", () => { if (!pageIsPinchZoomed()) fitStrip(); });
    new MutationObserver(() => st.querySelectorAll("button[data-for]").forEach((b) => b.classList.toggle("on", $("#" + b.dataset.for).classList.contains("on")))).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  // Bottom-sheet drag on phones: pull the grip up to cover the tape, down to
  // put it back or close it. Pointer events so a mouse works too.
  // One write per animation frame, whatever the pointer does. Pointer events
  // fire faster than the screen refreshes and each of these handlers writes
  // layout; without the gate a drag stutters instead of following the finger.
  const perFrame = (fn) => {
    let id = 0, args = null;
    return (...a) => { args = a; if (id) return; id = requestAnimationFrame(() => { id = 0; fn(...args); }); };
  };
  // Safari emits resize events while page pinch-zooming. That is visual
  // magnification, not a new layout viewport; re-clamping the panels against
  // it makes the card and tape jump under the user's fingers.
  const pageIsPinchZoomed = () => window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02;
  // A guard that only SKIPS during a pinch leaves everything stale when the
  // pinch never quite returns to 1.0 (iOS parks at 1.03 happily) — that is
  // how the card grew past the screen top and lost its close button. Defer
  // instead: run now if unpinched, or the moment the pinch settles.
  let unpinchWait = 0;
  const whenUnpinched = (fn) => {
    if (!pageIsPinchZoomed()) { fn(); return; }
    clearInterval(unpinchWait);
    unpinchWait = setInterval(() => { if (!pageIsPinchZoomed()) { clearInterval(unpinchWait); fn(); } }, 400);
  };

  function wireSheet() {
    const grip = $(".sheet-grip"), card = $("#point");
    if (!grip) return;
    // The phone card is a sheet you size with your thumb: the drag sets its
    // height directly and keeps it, rather than snapping to two fixed stops.
    // Pulling it below the minimum still closes it.
    // visualViewport is what the reader can actually see; innerHeight on iOS
    // still counts the strip behind Safari's toolbars, and a card sized to that
    // hides its own header — and its close button — off the top.
    const viewH = () => {
      // While pinch-zoomed, visualViewport.height is the MAGNIFIED slice, not
      // the layout viewport — clamping to it sized cards to a fiction. Use
      // height×scale (≈ layout height) so the clamp stays honest mid-pinch.
      const vv = window.visualViewport;
      if (!vv) return innerHeight;
      return Math.round(Math.min(vv.height * (vv.scale || 1), innerHeight || 1e9));
    };
    const bounds = () => {
      const cs = getComputedStyle(document.documentElement);
      const top = parseFloat(cs.getPropertyValue("--top-h")) || 52;
      // The card lives ABOVE the tape (bottom: --tb-h + 10), so the tape's
      // height is part of the budget. Ignoring it let a maximised tape shove
      // the card's head — and its × — off the top of the screen.
      const tbH = parseFloat(cs.getPropertyValue("--tb-h")) || 120;
      // min is the PEEK: name, temperature and the sentence, map above it
      return { min: 128, max: Math.max(200, viewH() - top - tbH - 24) };
    };
    const stored = Number(localStorage.getItem("wxgrid.sheetHeight")) || 0;
    let y0 = 0, dy = 0, startH = 0, dragging = false, closing = false, height = stored;
    const setHeight = (h, persist) => {
      const b = bounds();
      height = Math.max(b.min, Math.min(b.max, Math.round(h)));
      card.style.height = `${height}px`;
      card.classList.add("sheet-sized");
      // below this the tabs and telemetry stop pretending: hero only
      card.classList.toggle("sheet-peek", height < 190);
      if (persist) localStorage.setItem("wxgrid.sheetHeight", String(height));
      return height;
    };
    restoreSheetHeight = () => {
      if (innerWidth > 820) { card.style.height = ""; card.classList.remove("sheet-sized", "sheet-peek"); return; }
      if (height) setHeight(height, false);
    };
    const track = perFrame((clientY) => {
      if (!dragging) return;
      dy = clientY - y0;
      const b = bounds();
      closing = startH - dy < b.min - 64;
      card.style.opacity = closing ? ".62" : "";
      setHeight(startH - dy, false);
    });
    grip.addEventListener("pointerdown", (e) => {
      if (innerWidth > 820) return;
      dragging = true; y0 = e.clientY; dy = 0; closing = false;
      startH = card.getBoundingClientRect().height;
      card.classList.add("sheet-drag"); grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => { if (dragging) track(e.clientY); });
    const end = (cancel) => {
      if (!dragging) return;
      dragging = false; card.classList.remove("sheet-drag"); card.style.opacity = "";
      if (!cancel && closing) { closePoint(); return; }
      if (!cancel && Math.abs(dy) < 6) {                    // a tap cycles peek → half → full
        const b = bounds();
        setHeight(height < 190 ? Math.round(b.max * 0.5) : height < b.max - 40 ? b.max : b.min, true);
        return;
      }
      localStorage.setItem("wxgrid.sheetHeight", String(height));
    };
    grip.addEventListener("pointerup", () => end(false));
    grip.addEventListener("pointercancel", () => end(true));
    addEventListener("resize", () => whenUnpinched(restoreSheetHeight));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", () => whenUnpinched(restoreSheetHeight));
  }

  // Persisted panel sizing. Pointer capture keeps each drag stable even when
  // the cursor outruns its handle; double-click or Home returns to the default.
  function wirePanelResizers() {
    const tb = $("#timebar"), tapeGrip = $("#tape-resize"), card = $("#point"), cardGrip = $("#point-resize");
    if (!tb || !tapeGrip || !card || !cardGrip || tb.dataset.resizeWired) return;
    tb.dataset.resizeWired = "1";
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const topHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 52;
    const tapeBounds = () => ({ min: 118, max: Math.max(118, Math.min(480, Math.round(innerHeight * 0.58), innerHeight - topHeight() - 180)) });
    let tapeHeight = Number(localStorage.getItem("wxgrid.tapeHeight")) || null;
    // The tallest height worth having: past the content there is only void —
    // the stranded day-row screenshots were an over-dragged tape with its
    // table stretched into the gap (Jeff 2026-08-20). Phones cap at content;
    // desktop keeps the stretchy over-drag it always had.
    const tapeContentMax = () => {
      const t = tb.querySelector(".tape");
      if (!t || !t.scrollHeight) return Infinity;
      return Math.ceil(tb.getBoundingClientRect().height - t.clientHeight + t.scrollHeight) + 1;
    };
    const setTapeHeight = (height, persist = false) => {
      const bounds = tapeBounds();
      const maxH = innerWidth <= 820 ? Math.min(bounds.max, tapeContentMax()) : bounds.max;
      tapeHeight = clamp(Math.round(height), bounds.min, Math.max(bounds.min, maxH));
      tb.style.height = `${tapeHeight}px`; tb.classList.add("user-sized");
      tapeGrip.setAttribute("aria-valuemin", bounds.min); tapeGrip.setAttribute("aria-valuemax", bounds.max); tapeGrip.setAttribute("aria-valuenow", tapeHeight);
      if (persist) localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
    };
    const resetTapeHeight = () => {
      tapeHeight = null; localStorage.removeItem("wxgrid.tapeHeight");
      tb.style.height = ""; tb.classList.remove("user-sized");
      requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    };
    if (tapeHeight) setTapeHeight(tapeHeight);
    else requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    let tapeDrag = null;
    // The grip drags through the three states: pull it down past the minimum
    // and the tape collapses to its header, further and it goes away. The
    // height itself is only written once per frame — see perFrame.
    const trackTape = perFrame((clientY) => {
      if (!tapeDrag) return;
      tapeDrag.want = tapeDrag.height + tapeDrag.y - clientY;
      const min = tapeBounds().min;
      if (tapeDrag.want >= min) { if (tapeState !== "full") setTapeState("full", false); setTapeHeight(tapeDrag.want); }
      else if (tapeState === "full" && tapeDrag.want < min - 40) setTapeState("mini", false);
      else if (tapeState === "mini" && tapeDrag.want < min - 110) setTapeState("away", false);
    });
    tapeGrip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const h0 = tb.getBoundingClientRect().height;
      // want starts AT the height: a pure tap moves nothing, and |want - h|
      // must then be zero — it was initialised to 0, so a tap measured as a
      // full-height "drag" and the grip could minimise but never maximise
      // (Jeff 2026-08-20).
      tapeDrag = { id: e.pointerId, y: e.clientY, height: h0, want: h0, from: tapeState };
      tapeGrip.setPointerCapture(e.pointerId); tb.classList.add("is-resizing"); document.body.classList.add("resizing-tape");
    });
    tapeGrip.addEventListener("pointermove", (e) => { if (tapeDrag && e.pointerId === tapeDrag.id) trackTape(e.clientY); });
    const finishTape = (e) => {
      if (!tapeDrag || (e && e.pointerId !== tapeDrag.id)) return;
      const tap = Math.abs(tapeDrag.want - tapeDrag.height) < 5;
      tapeDrag = null; tb.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
      restoreSheetHeight();                    // the card re-budgets around the new tape
      if (tap) setTapeState(tapeState === "full" ? "mini" : "full");     // a tap on the grip cycles
      else {
        // A release below the rows snaps to mini rather than parking on a
        // clipped table (vertical scroll is locked, so clipped rows — the
        // gust row — were simply gone; a floor on the height instead made
        // the grip feel dead, Jeff 2026-08-22). Above the rows it stretches.
        // Phones only. Wider screens cap the tape below its content (480 px
        // against a taller table on an iPad), so there every release was
        // "below the rows" and the tape could hold no height but the cap —
        // "stretches until it becomes this big, not draggable at all"
        // (Jeff 2026-08-22). Desktop and tablet keep whatever height was set.
        const content = tapeContentMax();
        if (innerWidth <= 820 && tapeState === "full" && isFinite(content) && tapeHeight && tapeHeight < content - 6) { resetTapeHeight(); setTapeState("mini"); }
        localStorage.setItem("wxgrid.tapeState", tapeState);
      }
      if (tapeHeight && tapeState === "full") localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
      restorePointPanelSize();
    };
    tapeGrip.addEventListener("pointerup", finishTape); tapeGrip.addEventListener("pointercancel", finishTape);
    tapeGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetTapeHeight(); restorePointPanelSize(); });
    tapeGrip.addEventListener("keydown", (e) => {
      if (e.key === "Home") { e.preventDefault(); resetTapeHeight(); restorePointPanelSize(); return; }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault(); setTapeHeight((tb.getBoundingClientRect().height || 180) + (e.key === "ArrowUp" ? 16 : -16), true); restorePointPanelSize();
    });

    let pointSize = null;
    try { pointSize = JSON.parse(localStorage.getItem("wxgrid.pointSize") || "null"); } catch (_) { pointSize = null; }
    const pointBounds = () => {
      const rect = card.getBoundingClientRect();
      const tbHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || tb.getBoundingClientRect().height || 150;
      return { minW: 340, maxW: Math.max(340, innerWidth - rect.left - 12), minH: 230, maxH: Math.max(230, innerHeight - rect.top - tbHeight - 20) };
    };
    const setPointSize = (width, height, persist = false) => {
      if (innerWidth <= 820) { card.style.width = ""; card.style.height = ""; card.classList.remove("user-sized"); return; }
      const bounds = pointBounds();
      pointSize = { width: clamp(Math.round(width), bounds.minW, bounds.maxW), height: clamp(Math.round(height), bounds.minH, bounds.maxH) };
      card.style.width = `${pointSize.width}px`; card.style.height = `${pointSize.height}px`; card.classList.add("user-sized");
      cardGrip.setAttribute("aria-valuetext", `${pointSize.width} by ${pointSize.height} pixels`);
      if (persist) localStorage.setItem("wxgrid.pointSize", JSON.stringify(pointSize));
    };
    restorePointPanelSize = () => {
      // On a phone the sheet owns the height; clearing it here was wiping the
      // user's sheet size every time the tape resized (the timebar observer
      // calls this). Clear only the desktop sizing and hand back to the sheet.
      if (innerWidth <= 820) { card.style.width = ""; card.classList.remove("user-sized"); restoreSheetHeight(); return; }
      if (!card.hidden && pointSize && pointSize.width && pointSize.height) setPointSize(pointSize.width, pointSize.height);
    };
    const resetPointSize = () => {
      pointSize = null; localStorage.removeItem("wxgrid.pointSize");
      card.style.width = ""; card.style.height = ""; card.classList.remove("user-sized"); cardGrip.removeAttribute("aria-valuetext");
      if (state.point) renderPoint();
    };
    let pointDrag = null;
    cardGrip.addEventListener("pointerdown", (e) => {
      if (innerWidth <= 820) return;
      e.preventDefault(); e.stopPropagation();
      const rect = card.getBoundingClientRect();
      pointDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
      cardGrip.setPointerCapture(e.pointerId); card.classList.add("is-resizing"); document.body.classList.add("resizing-point");
    });
    const trackPoint = perFrame((x, y) => {
      if (!pointDrag) return;
      setPointSize(pointDrag.width + x - pointDrag.x, pointDrag.height + y - pointDrag.y);
    });
    cardGrip.addEventListener("pointermove", (e) => { if (pointDrag && e.pointerId === pointDrag.id) trackPoint(e.clientX, e.clientY); });
    const finishPoint = (e) => {
      if (!pointDrag || (e && e.pointerId !== pointDrag.id)) return;
      pointDrag = null; card.classList.remove("is-resizing"); document.body.classList.remove("resizing-point");
      if (pointSize) localStorage.setItem("wxgrid.pointSize", JSON.stringify(pointSize));
      if (state.point) renderPoint();
    };
    cardGrip.addEventListener("pointerup", finishPoint); cardGrip.addEventListener("pointercancel", finishPoint);
    cardGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetPointSize(); });
    cardGrip.addEventListener("keydown", (e) => {
      if (e.key === "Home") { e.preventDefault(); resetPointSize(); return; }
      if (!e.key.startsWith("Arrow") || innerWidth <= 820) return;
      e.preventDefault(); const rect = card.getBoundingClientRect(), step = e.shiftKey ? 32 : 16;
      setPointSize(rect.width + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0), rect.height + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0), true);
      if (state.point) renderPoint();
    });
    // The layer rail: one axis, because its width is set by the longest label
    // and dragging it sideways would only ever cut a word in half.
    const rail = $("#layers"), side = $("#side"), sideGrip = $("#side-resize");
    if (rail && sideGrip) {
      const railMax = () => Math.max(140, side.getBoundingClientRect().height ? innerHeight - side.getBoundingClientRect().top - 40 : 400);
      let railH = Number(localStorage.getItem("wxgrid.railHeight")) || null;
      const setRailHeight = (h) => { railH = clamp(Math.round(h), 140, railMax()); rail.style.maxHeight = `${railH}px`;
        sideGrip.setAttribute("aria-valuenow", railH); };
      const resetRail = () => { railH = null; localStorage.removeItem("wxgrid.railHeight"); rail.style.maxHeight = ""; };
      if (railH) setRailHeight(railH);
      let railDrag = null;
      const trackRail = perFrame((y) => { if (railDrag) setRailHeight(railDrag.height + y - railDrag.y); });
      sideGrip.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        railDrag = { id: e.pointerId, y: e.clientY, height: rail.getBoundingClientRect().height };
        sideGrip.setPointerCapture(e.pointerId); side.classList.add("is-resizing"); document.body.classList.add("resizing-tape");
      });
      sideGrip.addEventListener("pointermove", (e) => { if (railDrag && e.pointerId === railDrag.id) trackRail(e.clientY); });
      const finishRail = (e) => { if (!railDrag || (e && e.pointerId !== railDrag.id)) return;
        railDrag = null; side.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
        if (railH) localStorage.setItem("wxgrid.railHeight", railH); };
      sideGrip.addEventListener("pointerup", finishRail); sideGrip.addEventListener("pointercancel", finishRail);
      sideGrip.addEventListener("dblclick", (e) => { e.preventDefault(); resetRail(); });
      sideGrip.addEventListener("keydown", (e) => {
        if (e.key === "Home") { e.preventDefault(); resetRail(); return; }
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault(); setRailHeight(rail.getBoundingClientRect().height + (e.key === "ArrowDown" ? 24 : -24));
        localStorage.setItem("wxgrid.railHeight", railH);
      });
    }
    addEventListener("resize", () => whenUnpinched(() => { if (tapeHeight) setTapeHeight(tapeHeight); restorePointPanelSize(); }));
  }

  // Size the strip's buttons so the whole set fits between the top bar and the
  // time bar. It never scrolls: a toolbar that scrolls hides its own controls.
  function fitStrip() {
    const st = $("#tstrip"); if (!st || getComputedStyle(st).display === "none") return;
    const items = Array.from(st.querySelectorAll("button, .sep"));
    const more = $("#strip-more"), pop = $("#strip-more-pop");
    if (!items.length || !more) return;
    // put everything back in the strip, then move the tail into the flyout
    Array.from(pop.children).forEach((el) => st.insertBefore(el, more));
    const all = Array.from(st.querySelectorAll("button, .sep")).filter((el) => el !== more);
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 52;
    const tb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || 150;
    const btns = all.filter((el) => el.tagName === "BUTTON").length;
    const seps = all.length - btns;
    const avail = window.innerHeight - top - tb - 46;
    st.style.setProperty("--strip-btn", Math.max(26, Math.min(34, Math.floor((avail - 14 - seps * 7 - (all.length - 1) * 3) / Math.max(1, btns)))) + "px");
    // Then MEASURE and trim: arithmetic on gaps, borders and margins gets this
    // wrong every time, and being wrong here means a toolbar under the tape.
    const limit = st.getBoundingClientRect().top + avail;
    more.hidden = false;
    let guard = all.length;
    while (guard-- > 0 && st.getBoundingClientRect().bottom > limit) {
      const last = Array.from(st.querySelectorAll("button, .sep")).filter((el) => el !== more).pop();
      if (!last) break;
      pop.insertBefore(last, pop.firstChild);
    }
    // a separator that lands at the top or bottom of a column just hides
    [st, pop].forEach((box) => {
      const kids = Array.from(box.children).filter((el) => el !== more);
      kids.forEach((el) => el.classList.remove("sep-hide"));
      if (kids.length && kids[0].classList.contains("sep")) kids[0].classList.add("sep-hide");
      if (kids.length && kids[kids.length - 1].classList.contains("sep")) kids[kids.length - 1].classList.add("sep-hide");
    });
    const overflowed = pop.children.length > 0;
    more.hidden = !overflowed;
    if (!overflowed) st.classList.remove("more-open");
  }

  function positionMorePop() {
    const st = $("#tstrip"), pop = $("#strip-more-pop"), more = $("#strip-more");
    if (!st || !pop || !more) return;
    const r = more.getBoundingClientRect(), sr = st.getBoundingClientRect();
    pop.style.left = (sr.right + 8) + "px";
    const tb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb-h")) || 150;
    const floor = window.innerHeight - tb - 30;                     // never over the tape
    pop.style.top = Math.max(sr.top, Math.min(floor - pop.offsetHeight, r.top - pop.offsetHeight + r.height)) + "px";
  }

  function switchModel(key, target = validDate().getTime()) {
    // Keep the VALID time, not the step index: comparing models means the same moment.
    if (WX.tape) WX.tape.clearFineSelection();
    state.model = key; localStorage.setItem("wxgrid.model", key);
    state.run = modelEntry().runs[0].run;
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  function currentStepIdx() {
    const ms = Date.now(), valid = steps().map((h) => runDate().getTime() + h * 3600e3);
    let best = 0;
    valid.forEach((t, k) => { if (Math.abs(t - ms) < Math.abs(valid[best] - ms)) best = k; });
    return best;
  }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; WX.ov.applyRadarFrame(); return; }
    if (WX.tape) WX.tape.clearFineSelection();
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso();
  }
  function setStep(i) { if (WX.tape) WX.tape.clearFineSelection(); state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); }

  function applyStep(prefetch = true) {
    pushHash();
    const src = map.getSource("wx");
    if (src) { try { src.updateImage({ url: layerUrl(), coordinates: modelCoords() }); } catch (e) { /* superseded */ } }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", rasterOpacity());
    if (state.thunder && WX.ov) WX.ov.loadThunder();
    if (state.xsection && WX.xs) WX.xs.refresh();
    if (state.aq && WX.cams) WX.cams.refresh();
    if (state.route && WX.route) WX.route.refresh();
    if (WX.probe) WX.probe.refresh();
    const v = validDate();
    // the phone row has room for the weekday and the hour; the date is the UTC line under it
    const narrow = matchMedia("(max-width: 820px)").matches;
    $("#valid-local").textContent = v.toLocaleString(undefined, WX.units.timeOpts(narrow ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    const atNow = state.stepIdx === currentStepIdx();
    $("#lead").textContent = atNow ? "current" : `+${stepHours()}h`;
    $("#tape-now").classList.toggle("on", atNow);
    $("#tape-now").setAttribute("aria-pressed", atNow ? "true" : "false");
    if (state.night && WX.ov) WX.ov.updateNight();
    if (WX.probe) { WX.probe.pinUpdate(); }
    updateMarkerFlag();
    if (prefetch) {
      // Warm the neighbours: a cold frame renders in ~1-2 s server-side, and
      // scrubbing waits for each one. Fetching +1/+2/-1 in the background
      // makes the scrub read from cache instead (Jeff 2026-08-21).
      const st = steps();
      for (const d of [1, 2, -1]) { const j = state.stepIdx + d; if (j >= 0 && j < st.length) { const im = new Image(); im.src = layerUrl(st[j]); } }
      if (state.resorts && WX.ov) WX.ov.loadResorts();
    }
    WX.tape.renderTapeSelection();
    if (state.point) renderPoint();
  }

  let windReq = 0;
  async function loadWind(prefetch = true) {
    if (!runEntry().layers.includes(isWaves() ? "waves" : "wind")) { wind.setField(null); return; }
    const my = ++windReq;
    try {
      const fld = await WX.api(windUrl());
      if (my !== windReq) return;
      wind.setField(fld);
      if (prefetch) fetch(windUrl(steps()[(state.stepIdx + 1) % steps().length])).catch(() => {});
    } catch (e) { /* keep the previous field */ }
  }

  function togglePlay() {
    state.playing = !state.playing;
    $("#play").textContent = state.playing ? "❚❚" : "▶";
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (state.playing) playTimer = setInterval(() => nudge(1), state.radar ? Math.min(500, state.playMs) : state.playMs);
  }

  // one switch for the wind animation, shared by the menu chips and settings
  function setMotion(mode) {
    state.particles = mode === "particles"; state.barbs = mode === "barbs";
    $("#particles-toggle").classList.toggle("on", state.particles);
    $("#barbs-toggle").classList.toggle("on", state.barbs);
    wind.setMode(state.barbs ? "barbs" : "particles");
    wind.setEnabled(state.particles || state.barbs);
  }
  function restartPlay() { if (state.playing) { togglePlay(); togglePlay(); } }

  function renderLegend() {
    const lg = catalog.layers.find((l) => l.layer === state.layer);
    if (!lg) { $("#legend").hidden = true; return; }
    $("#legend").hidden = false;
    const grad = lg.stops.map((s) => `rgb(${s.rgb.join(",")}) ${((s.v - lg.lo) / (lg.hi - lg.lo) * 100).toFixed(1)}%`).join(", ");
    $(".legend-bar").style.background = `linear-gradient(to right, ${grad})`;
    const isSpeed = ["wind", "gust", "gfactor"].includes(state.layer);
    const U_ = WX.units;
    // Every layer whose server unit is not the user's unit converts here —
    // cbase stayed in metres for aviation preset until 2026-08-20. dt24 is a
    // DELTA: °F deltas scale by 1.8 and never add 32. vis follows the
    // altitude preset: a pilot reads distance in miles, not km.
    const cv = { temp: (v) => U_.tempC(v), d2m: (v) => U_.tempC(v), feels: (v) => U_.tempC(v),
                 wbt: (v) => U_.tempC(v), sst: (v) => U_.tempC(v),
                 dt24: (v) => (U_.tempUnit === "°F" ? { v: Math.round(v * 1.8), unit: "°F/24h" } : { v: Math.round(v), unit: "°C/24h" }),
                 vis: (v) => (U_.altUnit === "ft" ? { v: Math.round(v * 0.621371), unit: "mi" } : { v: Math.round(v), unit: "km" }),
                 msl: (v) => U_.press(v * 100), frz: (v) => U_.alt(v), cbase: (v) => U_.alt(v),
                 tp6: (v) => U_.precip(v), tp24: (v) => U_.precip(v), tp72: (v) => U_.precip(v),
                 sf6: (v) => U_.snow(v), sf24: (v) => U_.snow(v), sf72: (v) => U_.snow(v),
                 sd_cm: (v) => U_.snow(v), waves: (v) => U_.alt(v, 1) }[state.layer];
    const conv = (v) => isSpeed ? Math.round(speed(v)) : cv ? cv(v).v : Math.round(v);
    const unit = isSpeed ? speedUnit() : cv ? cv(0).unit : lg.units;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => lg.lo + (lg.hi - lg.lo) * q);
    // The layer's name belongs over the bar, not wedged into the middle tick
    // where it collided with the value under it. Ticks are numbers only.
    const name = LAYER_LABEL[state.layer] + (state.level && hasLevel() ? ` ${state.level}` : "");
    $("#legend .legend-head b").textContent = name;
    // "mm/6h": the window rides smaller and faded, set apart from the unit
    const um = /^([^/]+)(\/.+)$/.exec(unit || "");
    $("#legend .legend-head i").innerHTML = um ? `${um[1]}<span class="per">${um[2]}</span>` : (unit || "");
    if (state.layer === "ptype") {                 // categorical: names, not numbers
      $(".legend-bar").style.background = "linear-gradient(to right, rgb(60,130,220) 33%, rgb(190,110,220) 33% 66%, rgb(235,240,255) 66%)";
      $(".legend-ticks").innerHTML = "<span>rain</span><span>mixed</span><span>snow</span>";
      $("#legend .legend-head i").textContent = "";
      return;
    }
    $(".legend-ticks").innerHTML = ticks.map((t) => `<span>${conv(t)}</span>`).join("");
  }

  // ── point card ────────────────────────────────────────────────────────
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    state.point = { lat, lon, data: null, ai: null, prob: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    restorePointPanelSize(); restoreSheetHeight();
    document.body.classList.add("has-point");
    // A phone's card sits over the layer row anyway, so the controls fold
    // while it is open and come back when it closes. A fold the user chose
    // themselves stays.
    if (phoneMQ.matches && !document.body.classList.contains("tucked")) { softTucked = true; setTucked(true, false); }
    $("#point-title").textContent = name || "Locating…";
    // if the geocoder never answers, the coordinates are the name
    if (!name) setTimeout(() => { if (my === pointReq && !state.point.name) $("#point-title").textContent = fmtCoords(lat, lon); }, 8000);
    $("#point-local").textContent = `${fmtCoords(lat, lon)} · ${modelEntry().short}`;
    $("#point-now").textContent = "…";
    $$(".point-tabs button[data-tab=resort]").forEach((b) => b.hidden = !state.resort);
    { const on = WX.search.isFav(lat, lon); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; }
    placeMarker(lat, lon);
    if (WX.provider) WX.provider.refresh();
    pushHash();
    const gotPoint = (d) => {
      if (d && d.available === false) {
        state.point.data = null;
        state.point.outside = d;
        $("#point-now").innerHTML = `<div class="note">${d.reason || "This point is outside the selected model's forecast domain."}</div>`;
        $("#point-foot").textContent = `${modelEntry().short} · ${modelEntry().grid} regional domain`;
        WX.tape.renderTape();
        return;
      }
      state.point.data = d;
      state.point.outside = null;
      renderPoint(); WX.tape.renderTape();
      const rd = new Date(d.run + ":00Z");
      $("#point-foot").textContent = `${modelEntry().short} run ${rd.toLocaleString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })} ${String(rd.getUTCHours()).padStart(2, "0")}Z · ${modelEntry().grid} gridpoint · ${modelEntry().attribution.replace("ECMWF open data", "ECMWF").replace(" (AIFS)", "").replace("NOAA NCEP GFS via NOMADS", "National Weather Service").replace("NOAA NCEP AI-GFS (GraphCast lineage) via AWS Open Data", "National Weather Service").replace("NOAA NCEP GEFS ensemble mean via NOMADS", "National Weather Service")}`;
      // A shorter model can hand the daily outlook to AI-GFS after its own
      // final valid time. Keep the primary series untouched: only the day
      // strip uses this continuation, and labels the change of model plainly.
      const aiModel = catalog.models.find((m) => m.key === "aigfs" && m.runs.length);
      if (state.model !== "aigfs" && aiModel) {
        const aiRun = aiModel.runs[0];
        const aiEnd = new Date(aiRun.valid_from).getTime() + Math.max(...aiRun.steps) * 3600e3;
        const primaryEnd = new Date(d.valid[d.valid.length - 1]).getTime();
        if (aiEnd > primaryEnd + 3600e3) {
          WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=aigfs&run=${aiRun.run}`)
            .then((r) => { if (my === pointReq && r.available !== false) { state.point.ai = r; renderPoint(); } })
            .catch(() => {});
        }
      }
    };
    const gotLocal = (r) => { state.point.local = r; if (r.timezone && r.timezone.tz) { WX.units.pointZone = r.timezone.tz; if (WX.units.followsPoint) { WX.tape.renderTape(); applyStep(false); } } if ((!state.point.name || hasNonLatinScript(state.point.name)) && r.place && r.place.name) { state.point.name = r.place.name; $("#point-title").textContent = r.place.name; } else if (!state.point.name) { $("#point-title").textContent = fmtCoords(state.point.lat, state.point.lon); } WX.tape.renderTape(); renderPoint(); };
    // The stream lands six answers inside ~100 ms; six full card renders in a
    // row is most of the "slow pin" feel on a tablet. One render per frame.
    const renderSoon = perFrame(() => { if (my === pointReq) renderPoint(); });
    const got = {
      point: gotPoint, local: gotLocal,
      obs: (r) => { state.point.obs = r; renderSoon(); },
      alerts: (r) => { state.point.alerts = r.alerts || []; renderSoon(); },
      air: (r) => { state.point.air = r; renderSoon(); },
      tides: (r) => { state.point.tides = r || false; renderSoon(); },
      prob: (r) => { if (r) { state.point.prob = r; renderSoon(); } },
    };
    // One streamed response instead of six requests: the six were queueing
    // behind map tiles on the browser's per-origin connection cap, so the
    // card sat on "…" while the server had answered in milliseconds. The
    // static demo has no such endpoint and keeps the fan-out.
    if (!window.WXStatic) {
      try {
        const res = await fetch(`${U(API + "/card")}?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=${state.model}&run=${state.run}`, { priority: "high" });
        if (!res.ok || !res.body) throw new Error(res.status);
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = "", gotAny = false;
        const seen = new Set();
        for (;;) {
          const { done, value } = await reader.read();
          if (my !== pointReq) { reader.cancel().catch(() => {}); return; }
          buf += dec.decode(value || new Uint8Array(), { stream: !done });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const row = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!row.trim()) continue;
            const msg = JSON.parse(row);
            if (msg.kind === "point" && msg.error) $("#point-now").textContent = "point forecast unavailable";
            if (msg.error || msg.pending) continue;         // fetched alone below
            if (got[msg.kind]) { seen.add(msg.kind); gotAny = true; got[msg.kind](msg.data); }
          }
          if (done) break;
        }
        if (gotAny) {
          // Anything the stream gave up on (a slow geocoder, a dead upstream)
          // arrives on its own request whenever it is ready — the card's
          // connection is already free.
          const single = {
            local: `${API}/geo/reverse`, obs: `${API}/obs`, alerts: `${API}/alerts/point`,
            air: `${API}/air`, tides: `${API}/tides`, prob: `${API}/prob`,
          };
          for (const [kind, base] of Object.entries(single)) {
            if (seen.has(kind)) continue;
            WX.api(`${base}?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`)
              .then((r) => { if (my === pointReq) got[kind](r); })
              .catch(() => { if (my === pointReq && kind === "tides") got.tides(false); });
          }
          return;
        }
      } catch (e) { if (my !== pointReq) return; /* fall through to the fan-out */ }
    }
    try {
      const d = await WX.api(`${API}/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}&model=${state.model}&run=${state.run}`);
      if (my !== pointReq) return;
      gotPoint(d);
    } catch (e) { $("#point-now").textContent = "point forecast unavailable"; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) gotLocal(r); }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.obs(r); }).catch(() => {});
    WX.api(`${API}/alerts/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.alerts(r); }).catch(() => {});
    WX.api(`${API}/air?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.air(r); }).catch(() => {});
    WX.api(`${API}/tides?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.tides(r); }).catch(() => { if (my === pointReq) got.tides(false); });
    WX.api(`${API}/prob?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.prob(r); }).catch(() => {});
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { state.point = null; state.resort = null; $("#point").hidden = true; document.body.classList.remove("has-point");
    if (softTucked) { softTucked = false; setTucked(false, false); } if (WX.provider) WX.provider.refresh(); if (marker) { marker.remove(); marker = null; } WX.tape.renderTape(); WX.tape.refreshTapePoint(); }
  function placeMarker(lat, lon) {
    if (!marker) {
      const el = document.createElement("div"); el.className = "wx-marker";
      el.innerHTML = `<span class="mflag" hidden></span>`;
      marker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    marker.setLngLat([lon, lat]).addTo(map);
    updateMarkerFlag();
  }
  // The tapped point reads the map it sits on: a small flag with the current
  // layer's value there, following the layer and the scrub (the Windy pin,
  // in this house's dress).
  function updateMarkerFlag() {
    if (!marker) return;
    const el = marker.getElement().querySelector(".mflag");
    const ll = marker.getLngLat();
    const v = WX.probe && WX.probe.valueAt ? WX.probe.valueAt(ll.lng, ll.lat) : null;
    if (!v || v.text === "—") { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<b>${v.text}</b>${v.sub ? `<span>${v.sub}</span>` : ""}`;
  }
  function renderPoint() {
    const d = state.point && state.point.data; if (!d || !window.WXPanes) return;
    $$(".point-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$("#point-body section").forEach((s) => s.hidden = s.dataset.pane !== state.tab);
    window.WXPanes.render(state.tab, state.point, Math.min(state.stepIdx, d.steps.length - 1));
  }
  WX.renderPoint = renderPoint;
  WX.setStep = setStep;

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000, kind = "", onTap = null) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false; t.className = kind + (onTap ? " tappable" : "");
    t.onclick = onTap ? () => { t.hidden = true; onTap(); } : null;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  // Boot failure: a proper panel, not a toast. Says what is wrong in words
  // and offers a retry; the raw error stays available underneath.
  function fatal(err) {
    const msg = String(err && err.message || err);
    const offline = /Load failed|Failed to fetch|NetworkError|network/i.test(msg);
    const why = offline ? "The wxgrid server did not answer. It may be restarting, or this device is off the network it lives on."
      : /^(5\d\d)$/.test(msg) ? "The server answered with an error while loading the model catalog." : "Something broke while starting.";
    let box = $("#fatal");
    if (!box) { box = document.createElement("div"); box.id = "fatal"; document.body.appendChild(box); }
    box.innerHTML = `<div class="fatal-card" role="alert"><div class="fatal-head"><span class="fatal-dot"></span><b>wxgrid can't start</b></div><p>${why}</p><div class="fatal-actions"><button id="fatal-retry" class="chip">Try again</button><span class="dim mono">${msg.replace(/[<>&]/g, "")}</span></div></div>`;
    $("#fatal-retry").onclick = () => location.reload();
  }

  window.addEventListener("unhandledrejection", (e) => { if (e.reason && e.reason.name === "AbortError") e.preventDefault(); });
  boot().catch((e) => { console.error(e); fatal(e); });
})();

;
// ── units.js ────────────────────────────────────────────────────
// One unit system for the whole app. Everything that renders a number goes
// through here, so switching to °F/inches/mph changes the tape, the card, the
// legend, the probe and the cross-section together instead of one of them.
//
//   WX.units.temp(273.15) -> {v: 0, unit: "°C", txt: "0 °C"}
//
// Stored preferences (localStorage): wxgrid.u.temp | .wind | .precip | .snow
// | .dist | .press | .baro | .clock. Wind stays on the legacy wxgrid.units key so an
// existing visitor keeps their choice.
(function () {
  "use strict";
  const WX = window.WX;
  const LS = (k, d) => localStorage.getItem("wxgrid.u." + k) || d;

  const P = {
    temp: LS("temp", "c"),          // c | f
    precip: LS("precip", "mm"),     // mm | in
    snow: LS("snow", "cm"),         // cm | in
    dist: LS("dist", "km"),         // km | mi | nm
    press: LS("press", "hpa"),      // hpa | inhg | mmhg
    clock: LS("clock", "auto"),     // auto | 24 | 12
    tz: LS("tz", "local"),          // local | point | utc
    alt: LS("alt", "m"),            // m | ft
    baro: LS("baro", "metric"),     // metric | feet | flight
  };

  const round = (v, n) => Number(v.toFixed(n));
  const out = (v, unit, n) => v == null || !isFinite(v)
    ? { v: null, unit, txt: "—" }
    : { v: round(v, n), unit, txt: `${round(v, n)} ${unit}` };

  function write(key, value) {
    if (key === "wind") {
      WX.state.units = value;
      localStorage.setItem("wxgrid.units", value);
    } else {
      P[key] = value;
      localStorage.setItem("wxgrid.u." + key, value);
    }
  }

  const U = {
    get pref() { return { ...P, wind: (WX.state && WX.state.units) || "kmh" }; },
    set(key, value) {
      write(key, value);
      document.dispatchEvent(new CustomEvent("wx-units"));
    },
    setMany(values) {
      Object.entries(values).forEach(([key, value]) => write(key, value));
      document.dispatchEvent(new CustomEvent("wx-units"));
    },
    // temperature: store is kelvin
    temp(k, decimals) { if (k == null) return out(null, P.temp === "f" ? "°F" : "°C"); const c = k - 273.15; return P.temp === "f" ? out(c * 9 / 5 + 32, "°F", decimals ?? 0) : out(c, "°C", decimals ?? 0); },
    tempC(c, decimals) { return U.temp(c == null ? null : c + 273.15, decimals); },
    tempDelta(dc) { return P.temp === "f" ? dc * 9 / 5 : dc; },        // a difference, not a reading
    get tempUnit() { return P.temp === "f" ? "°F" : "°C"; },
    // precipitation: store is mm
    precip(mm, decimals) { if (mm == null) return out(null, P.precip === "in" ? "in" : "mm"); return P.precip === "in" ? out(mm / 25.4, "in", decimals ?? 2) : out(mm, "mm", decimals ?? (mm < 10 ? 1 : 0)); },
    get precipUnit() { return P.precip === "in" ? "in" : "mm"; },
    // snow: store is cm (already 10:1 from water equivalent)
    snow(cm, decimals) { if (cm == null) return out(null, P.snow === "in" ? "in" : "cm"); return P.snow === "in" ? out(cm / 2.54, "in", decimals ?? 1) : out(cm, "cm", decimals ?? 0); },
    get snowUnit() { return P.snow === "in" ? "in" : "cm"; },
    // distance: store is km
    dist(km, decimals) { if (km == null) return out(null, P.dist); return P.dist === "mi" ? out(km / 1.609344, "mi", decimals ?? 1) : P.dist === "nm" ? out(km / 1.852, "nm", decimals ?? 1) : out(km, "km", decimals ?? 1); },
    get distUnit() { return P.dist; },
    // altitude / height: store is metres
    alt(m, decimals) { if (m == null) return out(null, P.alt); return P.alt === "ft" ? out(m * 3.28084, "ft", decimals ?? 0) : out(m, "m", decimals ?? 0); },
    get altUnit() { return P.alt; },
    // pressure: store is Pa
    press(pa, decimals) { if (pa == null) return out(null, P.press === "inhg" ? "inHg" : P.press === "mmhg" ? "mmHg" : "hPa"); const hpa = pa / 100; return P.press === "inhg" ? out(hpa / 33.8639, "inHg", decimals ?? 2) : P.press === "mmhg" ? out(hpa * 0.750062, "mmHg", decimals ?? 0) : out(hpa, "hPa", decimals ?? 0); },
    get pressUnit() { return P.press === "inhg" ? "inHg" : P.press === "mmhg" ? "mmHg" : "hPa"; },
    // time: the clock the user asked for, in the zone they asked for
    // the zone of the place currently open in the card, set by app.js
    pointZone: null,
    timeOpts(extra) {
      const o = { ...(extra || {}) };
      if (P.clock === "24") o.hour12 = false; else if (P.clock === "12") o.hour12 = true;
      if (P.tz === "utc") o.timeZone = "UTC";
      else if (P.tz === "point" && U.pointZone) o.timeZone = U.pointZone;
      return o;
    },
    get zoneLabel() { return P.tz === "utc" ? "UTC" : P.tz === "point" && U.pointZone ? U.pointZone.split("/").pop().replace(/_/g, " ") : "local"; },
    time(d, extra) { return new Date(d).toLocaleTimeString(undefined, U.timeOpts({ hour: "numeric", minute: "2-digit", ...(extra || {}) })); },
    dateTime(d, extra) { return new Date(d).toLocaleString(undefined, U.timeOpts(extra)); },
    hour(d) { return new Date(d).toLocaleTimeString(undefined, U.timeOpts({ hour: "numeric" })).replace(":00", ""); },
    // the zone a Date should be read in for day/hour bucketing
    zoned(d) { return P.tz === "utc" ? new Date(new Date(d).getTime() + new Date(d).getTimezoneOffset() * 60000) : new Date(d); },
    get isUTC() { return P.tz === "utc"; },
    get followsPoint() { return P.tz === "point"; },
  };
  WX.units = U;
})();

;
// ── settings.js ─────────────────────────────────────────────────
// Settings drawer: units, clock, map and motion. Everything here writes
// through WX.units (or state) and fires `wx-units`, which app.js listens for
// to repaint the legend, card, tape, probe and cross-section together.
(function () {
  "use strict";
  const WX = window.WX;
  const $ = (s) => document.querySelector(s);

  const PRESETS = {
    metric: { label: "Metric", note: "°C·km/h·mm", values: { temp: "c", wind: "kmh", precip: "mm", snow: "cm", dist: "km", alt: "m", baro: "metric", press: "hpa" } },
    us: { label: "US", note: "°F·mph·in", values: { temp: "f", wind: "mph", precip: "in", snow: "in", dist: "mi", alt: "ft", baro: "feet", press: "inhg" } },
    aviation: { label: "Aviation", note: "°C·kt·NM·FL", values: { temp: "c", wind: "kt", precip: "mm", snow: "cm", dist: "nm", alt: "ft", baro: "flight", press: "hpa" } },
  };

  const GROUPS = [
    { title: "Units", rows: [
      { key: "temp", label: "Temperature", opts: [["c", "°C"], ["f", "°F"]] },
      { key: "wind", label: "Wind", opts: [["kmh", "km/h"], ["mph", "mph"], ["kt", "kt"], ["ms", "m/s"]] },
      { key: "precip", label: "Rain", opts: [["mm", "mm"], ["in", "in"]] },
      { key: "snow", label: "Snow", opts: [["cm", "cm"], ["in", "in"]] },
      { key: "dist", label: "Distance", opts: [["km", "km"], ["mi", "mi"], ["nm", "nm"]] },
      { key: "alt", label: "Altitude", opts: [["m", "m"], ["ft", "ft"]] },
      { key: "baro", label: "Pressure levels", opts: [["metric", "m / km"], ["feet", "ft"], ["flight", "FL"]] },
      { key: "press", label: "Pressure", opts: [["hpa", "hPa"], ["inhg", "inHg"], ["mmhg", "mmHg"]] },
    ] },
    { title: "Time", rows: [
      { key: "clock", label: "Clock", opts: [["auto", "auto"], ["24", "24 h"], ["12", "12 h"]] },
      { key: "tz", label: "Zone", opts: [["local", "system"], ["point", "pin"], ["utc", "UTC"]] },
    ] },
  ];

  const style = document.createElement("style");
  style.textContent = `
  #settings-scrim{position:absolute;inset:0;z-index:15;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);opacity:0;transition:opacity .18s}
  #settings-scrim.on{opacity:1}
  #settings{position:absolute;top:0;right:0;bottom:0;width:min(360px,100%);z-index:16;display:flex;flex-direction:column;
    background:var(--panel-solid);border-left:1px solid var(--line-strong);box-shadow:-20px 0 60px rgba(0,0,0,.5);
    transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);
    padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  #settings.on{transform:translateX(0)}
  #settings[hidden],#settings-scrim[hidden]{display:none}
  #settings .sh{display:flex;align-items:center;gap:10px;padding:16px 16px 13px;border-bottom:1px solid var(--line)}
  #settings .sh>div{display:flex;flex-direction:column;gap:2px}
  #settings .sh b{font:800 17px var(--font-display);letter-spacing:-.02em}
  #settings .sh small{font:500 11px var(--font-body);color:var(--dim)}
  #settings .sh .icon{margin-left:auto}
  #settings .sbody{flex:1;overflow-y:auto;padding:6px 16px 24px;overscroll-behavior:contain}
  #settings .grp{margin-top:16px}
  #settings .grp>h4{font:700 10px var(--font-display);letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin:0 0 8px 2px}
  #settings .presets{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
  #settings .preset{position:relative;display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:2px;padding:11px 10px 10px;
    border:1px solid var(--line);border-radius:12px;background:rgba(127,127,127,.045);color:var(--fg);cursor:pointer;text-align:left}
  #settings .preset:hover{background:rgba(127,127,127,.09);border-color:var(--line-strong)}
  #settings .preset b{font:700 12.5px var(--font-display)}
  #settings .preset{overflow:hidden}
  #settings .preset small{font:600 9.5px/1.25 var(--font-display);color:var(--dim);white-space:nowrap;letter-spacing:0}
  #settings .preset.on{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-glow)}
  #settings .preset.on::after{content:"✓";position:absolute;right:8px;top:7px;color:var(--accent);font:800 11px var(--font-display)}
  #settings details.advanced{margin-top:10px;border:1px solid var(--line);border-radius:12px;background:rgba(127,127,127,.025);overflow:hidden}
  #settings details.advanced summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none;
    font:650 12px var(--font-display);color:var(--fg-2)}
  #settings details.advanced summary::-webkit-details-marker{display:none}
  #settings details.advanced summary::after{content:"";margin-left:auto;width:7px;height:7px;flex:0 0 7px;
    border-right:1.7px solid var(--dim);border-bottom:1.7px solid var(--dim);border-radius:0.5px;
    transform:rotate(45deg) translate(-1px,-1px);transition:transform .16s}
  #settings details.advanced summary:hover::after{border-color:var(--fg-2)}
  #settings details.advanced[open] summary::after{transform:rotate(225deg) translate(-2px,-2px)}
  #settings details.advanced .advanced-body{padding:2px 10px 8px;border-top:1px solid var(--line)}
  #settings .row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  #settings .row>span{font:600 12.5px var(--font-display);color:var(--fg-2);flex:0 0 84px}
  #settings .seg{flex:1;display:flex;padding:2px;gap:2px}
  #settings .seg button{flex:1;border:0;background:transparent;color:var(--fg-2);padding:5px 4px;border-radius:7px;
    font:600 11.5px var(--font-display);cursor:pointer;white-space:nowrap}
  #settings .seg button.on{background:var(--accent);color:var(--accent-ink)}
  #settings .krow{display:flex;justify-content:space-between;gap:12px;font:500 12px var(--font-body);color:var(--fg-2);padding:4px 2px}
  #settings kbd{font:600 10.5px var(--font-mono);background:var(--bg-3,rgba(255,255,255,.08));border:1px solid var(--line);
    border-radius:5px;padding:1px 6px;color:var(--fg)}
  #settings .note{margin:14px 2px 0}
  @media (max-width:820px){#settings{width:100%}}
  @media (max-width:380px){#settings .preset{padding:10px 8px}#settings .preset small{font-size:8.5px}}
  `;
  document.head.appendChild(style);

  function build() {
    if ($("#settings")) return;
    const scrim = document.createElement("div"); scrim.id = "settings-scrim"; scrim.hidden = true;
    const el = document.createElement("aside"); el.id = "settings"; el.hidden = true;
    el.innerHTML = `<div class="sh"><div><b>Settings</b></div><button class="icon" id="settings-close" title="Close">×</button></div>
      <div class="sbody">
        <div class="grp"><h4>Measurement system</h4><div class="presets">
          ${Object.entries(PRESETS).map(([key, p]) => `<button class="preset" data-preset="${key}"><b>${p.label}</b><small>${p.note}</small></button>`).join("")}
        </div>
        <details class="advanced"><summary>Customize each unit</summary><div class="advanced-body">
          ${GROUPS[0].rows.map((r) => `
          <div class="row"><span>${r.label}</span><div class="seg" data-key="${r.key}">
            ${r.opts.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("")}
          </div></div>`).join("")}
        </div></details></div>
        <div class="grp"><h4>${GROUPS[1].title}</h4>${GROUPS[1].rows.map((r) => `
          <div class="row"><span>${r.label}</span><div class="seg" data-key="${r.key}">
            ${r.opts.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("")}
          </div></div>`).join("")}</div>
        <div class="grp"><h4>Map</h4>
          <div class="row"><span>Theme</span><div class="seg" data-key="theme">
            <button data-v="dark">dark</button><button data-v="light">light</button></div></div>
          <div class="row"><span>Motion</span><div class="seg" data-key="motion">
            <button data-v="particles">particles</button><button data-v="barbs">barbs</button><button data-v="off">off</button></div></div>
          <div class="row"><span>Play speed</span><div class="seg" data-key="playms">
            <button data-v="1400">slow</button><button data-v="900">normal</button><button data-v="450">fast</button></div></div>
        </div>
        <div class="grp"><h4>Keyboard</h4>
          <div class="krow"><span>Step forward / back</span><span><kbd>←</kbd> <kbd>→</kbd></span></div>
          <div class="krow"><span>Play / pause</span><span><kbd>space</kbd></span></div>
          <div class="krow"><span>Search</span><span><kbd>/</kbd></span></div>
          <div class="krow"><span>Layer menu</span><span><kbd>L</kbd></span></div>
          <div class="krow"><span>Close card or menu</span><span><kbd>esc</kbd></span></div>
        </div>
        <p class="note">Units apply everywhere: the tape, the card, the legend, the cursor readout and the cross-section.</p>
      </div>`;
    document.body.appendChild(scrim); document.body.appendChild(el);
    scrim.onclick = close;
    $("#settings-close").onclick = close;
    el.querySelectorAll(".preset").forEach((button) => button.onclick = () => {
      WX.units.setMany(PRESETS[button.dataset.preset].values);
      paint();
    });
    el.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.onclick = () => pick(seg.dataset.key, b.dataset.v)));
    paint();
  }

  function pick(key, v) {
    if (key === "theme") WX.fn.applyTheme(v);
    else if (key === "motion") WX.fn.setMotion(v);
    else if (key === "playms") { WX.state.playMs = Number(v); localStorage.setItem("wxgrid.playMs", v); WX.fn.restartPlay(); }
    else WX.units.set(key, v);
    paint();
  }

  function paint() {
    const el = $("#settings"); if (!el) return;
    const pref = WX.units.pref;
    const cur = {
      ...pref,
      theme: document.documentElement.dataset.theme || "dark",
      motion: WX.state.barbs ? "barbs" : WX.state.particles ? "particles" : "off",
      playms: String(WX.state.playMs || 900),
    };
    el.querySelectorAll(".seg").forEach((seg) => {
      const k = seg.dataset.key;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(cur[k]) === b.dataset.v));
    });
    let active = null;
    for (const [key, preset] of Object.entries(PRESETS))
      if (Object.entries(preset.values).every(([unit, value]) => pref[unit] === value)) active = key;
    el.querySelectorAll(".preset").forEach((button) => button.classList.toggle("on", button.dataset.preset === active));
    if (!active) el.querySelector("details.advanced").open = true;
  }

  function open() { build(); const el = $("#settings"), s = $("#settings-scrim"); el.hidden = false; s.hidden = false; paint(); requestAnimationFrame(() => { el.classList.add("on"); s.classList.add("on"); }); }
  function close() { const el = $("#settings"), s = $("#settings-scrim"); if (!el) return; el.classList.remove("on"); s.classList.remove("on"); setTimeout(() => { el.hidden = true; s.hidden = true; }, 220); }
  // The desktop strip is rebuilt by app.js as controls change. Delegate its
  // settings action here, where the drawer lifecycle lives, so render order
  // cannot leave a visible gear disconnected from the hidden menu copy.
  document.addEventListener("click", (e) => { if (e.target.closest("#strip-settings")) open(); });
  document.addEventListener("wx-units", paint);
  WX.settings = { open, close, toggle: () => ($("#settings") && !$("#settings").hidden ? close() : open()) };
  // Build once while the module loads. It stays hidden, but every settings
  // entry point now targets a stable drawer instead of creating UI mid-click.
  build();
})();

;
// ── menu.js ─────────────────────────────────────────────────────
// Right-click (or long-press) anywhere on the map: the fastest way to do the
// thing you actually wanted with a spot you just found.
(function () {
  "use strict";
  const WX = window.WX;
  const M = () => WX.map;
  let el = null, at = null, pressTimer = null, moved = false;

  const style = document.createElement("style");
  style.textContent = `
  #mapmenu{position:absolute;z-index:9;min-width:206px;padding:5px;border-radius:12px;
    background:var(--panel-solid);border:1px solid var(--line-strong);box-shadow:0 18px 50px rgba(0,0,0,.5);
    transform-origin:top left;animation:mm-in .12s ease-out}
  @keyframes mm-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
  #mapmenu[hidden]{display:none}
  #mapmenu .mm-head{font:600 10.5px var(--font-mono);color:var(--dim);padding:5px 9px 6px;border-bottom:1px solid var(--line);margin-bottom:4px}
  #mapmenu button{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;color:var(--fg-2);
    padding:8px 9px;border-radius:8px;font:600 12.5px var(--font-display);cursor:pointer;text-align:left}
  #mapmenu button:hover{background:rgba(255,255,255,.06);color:var(--fg)}
  :root[data-theme="light"] #mapmenu button:hover{background:rgba(0,0,0,.05)}
  #mapmenu svg{width:15px;height:15px;flex:0 0 15px;opacity:.8}
  `;
  document.head.appendChild(style);

  const I = {
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7 2 2H6l2-2 1-7z"/></svg>',
    point: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    xs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M3 16c4-6 8 2 12-3 2-2.5 4-3 6-3"/></svg>',
    ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.6 2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.88l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85L12 3.6z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    centre: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  };

  function close() { if (el) { el.hidden = true; } }

  function open(lngLat, px) {
    if (!el) {
      el = document.createElement("div"); el.id = "mapmenu"; el.hidden = true;
      document.body.appendChild(el);
      document.addEventListener("click", (e) => { if (el && !el.contains(e.target)) close(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      M().on("movestart", close);
    }
    at = lngLat;
    const lon = WX.wlon(lngLat.lng);
    const rows = [
      ["Forecast for this point", I.point, () => WX.fn.openPoint(lngLat.lat, lngLat.lng)],
      ["Pin this value", I.pin || I.point, () => WX.probe && WX.probe.pin(lngLat)],
      ["Cross-section from here", I.xs, () => { if (!WX.state.xsection) $("#xsection-toggle").click(); WX.xs.click(lngLat); }],
      ["Measure from here", I.ruler, () => { if (!WX.state.measure) $("#measure-toggle").click(); WX.ov.measureClick(lngLat); }],
      ["Save this place", I.star, () => { WX.search.toggleFav(lngLat.lat, lon, WX.fmtCoords(lngLat.lat, lngLat.lng)); WX.fn.toast("Saved. Find it in the search box.", 3000); }],
      ["Copy coordinates", I.copy, async () => { const t = `${lngLat.lat.toFixed(4)}, ${lon.toFixed(4)}`; try { await navigator.clipboard.writeText(t); WX.fn.toast("Copied " + t, 2500); } catch (e) { WX.fn.toast(t, 5000); } }],
      ["Centre the map here", I.centre, () => M().easeTo({ center: [lngLat.lng, lngLat.lat], duration: 500 })],
    ];
    el.innerHTML = `<div class="mm-head">${WX.fmtCoords(lngLat.lat, lngLat.lng, 3)}</div>` +
      rows.map((r, i) => `<button data-i="${i}">${r[1]}<span>${r[0]}</span></button>`).join("");
    el.querySelectorAll("button").forEach((b) => b.onclick = () => { close(); rows[Number(b.dataset.i)][2](); });
    el.hidden = false;
    // keep it on screen
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(px.x, innerWidth - w - 8) + "px";
    el.style.top = Math.min(px.y, innerHeight - h - 8) + "px";
  }
  const $ = (s) => document.querySelector(s);

  function wire() {
    const map = M();
    map.on("contextmenu", (e) => { e.preventDefault && e.preventDefault(); open(e.lngLat, e.point); });
    // long-press on touch, cancelled by any drag
    const c = map.getCanvasContainer();
    c.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 1) return;
      moved = false;
      const t = ev.touches[0];
      const rect = map.getContainer().getBoundingClientRect();
      const px = { x: t.clientX - rect.left, y: t.clientY - rect.top };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { if (!moved) { if (navigator.vibrate) navigator.vibrate(12); open(map.unproject([px.x, px.y]), { x: t.clientX, y: t.clientY }); } }, 480);
    }, { passive: true });
    c.addEventListener("touchmove", () => { moved = true; clearTimeout(pressTimer); }, { passive: true });
    c.addEventListener("touchend", () => clearTimeout(pressTimer), { passive: true });
  }
  WX.mapmenu = { wire, open, close };
})();

;
// ── tour.js ─────────────────────────────────────────────────────
// First run only: four spotlights, then never again. Skippable at any point,
// and it never runs on a permalink (someone arriving at a shared view wants
// the view, not a lesson).
(function () {
  "use strict";
  const WX = window.WX;
  const KEY = "wxgrid.tour.v1";
  // capture at parse time: the app writes its own permalink hash a moment
  // after boot, so checking later would suppress the tour for everyone
  const ARRIVED_WITH_VIEW = location.hash.length > 3;
  const STEPS = [
    { sel: "#search", title: "Anywhere on Earth", text: "Search a place, or just tap the map — the card that opens has nine panes, from the hourly tape to soundings and a resort board." },
    { sel: "#layers", title: "Layers", text: "Wind, temperature, rain, snow, waves, air quality. Some have variants — rain over 6, 24 or 72 hours — and the picker for those sits next to the legend." },
    { sel: "#tstrip, #overlays-menu .menu-btn", title: "Overlays and tools", text: "Radar, satellite, warnings, wildfires, avalanche, cross-sections. Hover any icon for its name." },
    { sel: "#timebar", title: "The forecast tape", text: "Scrub with ← and →, space to animate, click any column to jump. The chevron folds it away." },
    { sel: "#strip-settings, #strip-more, #tools-menu .menu-btn", title: "Make it yours", text: "Units, clock, theme and motion. Set °F and inches once and every number on screen follows." },
  ];
  let i = 0, box = null, ring = null;

  const style = document.createElement("style");
  style.textContent = `
  #tour-ring{position:absolute;z-index:30;border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,.55),0 0 0 2px var(--accent);
    pointer-events:none;transition:all .25s cubic-bezier(.4,0,.2,1)}
  #tour-box{position:absolute;z-index:31;width:min(300px,calc(100vw - 24px));padding:13px 15px 12px;border-radius:13px;
    background:var(--panel-solid);border:1px solid var(--line-strong);box-shadow:0 20px 60px rgba(0,0,0,.55);
    transition:all .25s cubic-bezier(.4,0,.2,1)}
  #tour-box h5{margin:0 0 5px;font:800 13.5px var(--font-display);letter-spacing:-.01em}
  #tour-box p{margin:0 0 11px;font:500 12.5px/1.5 var(--font-body);color:var(--fg-2)}
  #tour-box .row{display:flex;align-items:center;gap:8px}
  #tour-box .dots{display:flex;gap:4px;margin-right:auto}
  #tour-box .dots i{width:5px;height:5px;border-radius:50%;background:var(--line-strong)}
  #tour-box .dots i.on{background:var(--accent)}
  #tour-box button{border:0;border-radius:8px;padding:6px 12px;font:700 12px var(--font-display);cursor:pointer}
  #tour-box .skip{background:transparent;color:var(--dim)}
  #tour-box .next{background:var(--accent);color:var(--accent-ink)}
  `;
  document.head.appendChild(style);

  function place() {
    const s = STEPS[i];
    // A selector can name several homes for the same control (the settings
    // gear lives on the strip on desktop and in the tools menu on a phone).
    // Ring the first one that is actually on screen; a hidden target has a
    // zero rect and put the tip in the wrong corner (Jeff 2026-08-20).
    // checkVisibility sees what offsetParent cannot: the strip's overflow
    // flyout keeps layout at opacity 0, so a control that overflowed into it
    // passed the old test and the ring landed on an invisible corner of the
    // screen (Jeff 2026-08-21, "make it yours highlights a random part").
    const vis = (el) => (el.checkVisibility
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : el.offsetParent !== null);
    const t = [...document.querySelectorAll(s.sel)]
      .find((el) => vis(el) && el.getBoundingClientRect().width > 0);
    if (!t) return next();
    const r = t.getBoundingClientRect();
    const pad = 6;
    ring.style.left = (r.left - pad) + "px"; ring.style.top = (r.top - pad) + "px";
    ring.style.width = (r.width + pad * 2) + "px"; ring.style.height = (r.height + pad * 2) + "px";
    box.querySelector("h5").textContent = s.title;
    box.querySelector("p").textContent = s.text;
    box.querySelectorAll(".dots i").forEach((d, k) => d.classList.toggle("on", k === i));
    box.querySelector(".next").textContent = i === STEPS.length - 1 ? "Got it" : "Next";
    // place it wherever it actually fits: below, above, or beside the target,
    // then clamp hard to the viewport so it can never land off-screen
    const bw = box.offsetWidth, bh = box.offsetHeight, gap = 14;
    let x = r.left + r.width / 2 - bw / 2, y = r.bottom + gap;
    if (y + bh > innerHeight - 10) {
      if (r.top - bh - gap >= 10) y = r.top - bh - gap;                    // above
      else if (r.right + gap + bw <= innerWidth - 10) { x = r.right + gap; y = Math.min(innerHeight - bh - 10, Math.max(10, r.top)); }
      else if (r.left - gap - bw >= 10) { x = r.left - gap - bw; y = Math.min(innerHeight - bh - 10, Math.max(10, r.top)); }
      else y = Math.max(10, innerHeight - bh - 10);
    }
    box.style.left = Math.round(Math.max(10, Math.min(innerWidth - bw - 10, x))) + "px";
    box.style.top = Math.round(Math.max(10, Math.min(innerHeight - bh - 10, y))) + "px";
  }
  function next() { i++; if (i >= STEPS.length) return done(); place(); }
  function done() { localStorage.setItem(KEY, "1"); if (ring) ring.remove(); if (box) box.remove(); ring = box = null; }

  function start(force) {
    if (!force && (localStorage.getItem(KEY) || ARRIVED_WITH_VIEW)) return;
    ring = document.createElement("div"); ring.id = "tour-ring";
    box = document.createElement("div"); box.id = "tour-box";
    box.innerHTML = `<h5></h5><p></p><div class="row"><div class="dots">${STEPS.map(() => "<i></i>").join("")}</div>
      <button class="skip">Skip</button><button class="next">Next</button></div>`;
    document.body.append(ring, box);
    box.querySelector(".skip").onclick = done;
    box.querySelector(".next").onclick = next;
    document.addEventListener("keydown", (e) => { if (!box) return; if (e.key === "Escape") done(); if (e.key === "Enter") next(); });
  addEventListener("resize", () => { if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.02) return; if (box) place(); });
    i = 0; place();
  }
  WX.tour = { start, done };
})();

;
// ── overlays.js ─────────────────────────────────────────────────
// Map overlays: radar, isolines, avalanche regions, resorts + lifts, alerts,
// tropical systems, satellite, measure tool. Loaded after app.js; talks to it
// through window.WX (map/state/helpers) and exposes itself as WX.ov.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // app.js has its own `const RAINVIEWER` but it lives inside app.js's IIFE, so
  // it was never visible here — the direct-fetch fallback used to throw a
  // ReferenceError and land in the catch as "radar unavailable".
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  // ── isolines overlay ──────────────────────────────────────────────────
  let isoReq = 0;
  let quakePopup = null;

  // ── polar caps ──────────────────────────────────────────────────────────
  // The basemap's tiles end at 85.05° (mercator's edge), and on the globe
  // the sphere above that renders the style's background — near-black, which
  // read as a hole drilled through the pole. Tint the
  // background to sit with the ocean instead. Re-applied on every
  // style.load: a theme or basemap swap replaces the style wholesale.
  function tintPoles() {
    const m = M(); if (!m || !m.getStyle) return;
    const light = document.documentElement.dataset.theme === "light";
    const color = light ? "#d3dde6" : "#101922";
    const layers = (m.getStyle().layers || []);
    const bg = layers.find((l) => l.type === "background");
    if (bg) m.setPaintProperty(bg.id, "background-color", color);
    else if (layers.length) m.addLayer({ id: "polar-bg", type: "background", paint: { "background-color": color } }, layers[0].id);
  }
  (function wirePoles() {
    const t = setInterval(() => {
      if (!WX.map) return;
      clearInterval(t);
      WX.map.on("style.load", tintPoles);
      if (WX.map.isStyleLoaded && WX.map.isStyleLoaded()) tintPoles(); else WX.map.once("load", tintPoles);
    }, 250);
  })();
  function isoVar() {
    if (state.layer === "temp") return state.level ? `temp?level=${state.level}` : "temp";
    if (state.layer === "frz") return "frz";
    if (state.layer === "wind" && state.level === 500) return "gh_500";
    return "msl";
  }
  async function loadIso() {
    const my = ++isoReq;
    const v = isoVar();
    const url = U(`${API}/isolines/${state.model}/${state.run}/${WX.fn.stepHours()}/${v.includes("?") ? v.replace("?", ".json?") : v + ".json"}`);
    try {
      const gj = await WX.api(url);
      if (my !== isoReq || !state.iso) return;
      // the rail's Isolines row says what the numbers are (12° needs no help;
      // a bare 4514 does)
      const flat = document.querySelector('.rail-flat[data-rail="iso"] span');
      if (flat) flat.textContent = gj.unit ? `Isolines · ${gj.unit}` : "Isolines";
      if (M().getSource("iso")) M().getSource("iso").setData(gj);
      else {
        M().addSource("iso", { type: "geojson", data: gj });
        M().addLayer({ id: "iso-line", type: "line", source: "iso", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": ["case", ["==", ["%", ["get", "value"], ["*", 4, gj.interval || 4]], 0], 1.4, 0.7] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "iso-label", type: "symbol", source: "iso", filter: ["==", ["geometry-type"], "LineString"], layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 10, "text-font": ["Noto Sans Regular"], "symbol-spacing": 320 }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.7)", "text-halo-width": 1.2 } });
        // pressure centres: H blue, L red, the way every surface chart draws them
        M().addLayer({ id: "iso-hl", type: "symbol", source: "iso", filter: ["==", ["geometry-type"], "Point"],
          layout: { "text-field": ["get", "label"], "text-size": 21, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true },
          paint: { "text-color": ["match", ["get", "kind"], "H", "#6ea8ff", "#ff6a5e"], "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.6 } });
      }
    } catch (e) { WX.fn.toast("No isolines for this layer.", 4000, "error"); }
  }
  // ── satellite imagery base ────────────────────────────────────────────
  // Not a weather overlay: a ground truth to put UNDER the field. Vector
  // labels stay on top; the weather layer keeps painting above it.
  const BASES = {
    sat: { attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
           tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" },
    topo: { attribution: "Topo © Esri and contributors",
            tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}" },
  };
  function setBase(kind) {
    // restored from localStorage at boot, which can run before the style —
    // an addLayer then is a fatal, not a layer (2026-08-19, landscape probe)
    if (!M().getSource("openmaptiles")) { M().once("load", () => setBase(kind)); return; }
    if (M().getLayer("sat-base")) M().removeLayer("sat-base");
    if (M().getSource("sat-base")) M().removeSource("sat-base");
    const spec = BASES[kind];
    if (!spec) return;                               // "": the vector map itself
    M().addSource("sat-base", { type: "raster", tileSize: 256, maxzoom: 18,
      attribution: spec.attribution, tiles: [spec.tiles] });
    const before = M().getLayer("wx") ? "wx" : WX.fn.firstSymbolId();
    M().addLayer({ id: "sat-base", type: "raster", source: "sat-base", paint: { "raster-opacity": 1 } }, before);
  }
  const loadImagery = () => setBase(WX.state.base || "sat");   // legacy callers
  const clearImagery = () => setBase("");

  // ── terrain hillshade ─────────────────────────────────────────────────
  // Relief under the weather: AWS's public terrarium DEM tiles through
  // MapLibre's own hillshade renderer. No key, no quota drama, and it sits
  // under the field so ridgelines explain the precip shadows.
  function loadTerrain() {
    if (!M().getSource("openmaptiles")) { M().once("load", loadTerrain); return; }
    if (M().getSource("dem")) return;
    M().addSource("dem", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 13,
      attribution: "Terrain: Mapzen/AWS Terrain Tiles",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] });
    const before = M().getLayer("wx") ? "wx" : WX.fn.firstSymbolId();
    M().addLayer({ id: "hillshade", type: "hillshade", source: "dem",
      paint: { "hillshade-exaggeration": 0.45,
               "hillshade-shadow-color": "rgba(0,0,0,.55)",
               "hillshade-highlight-color": "rgba(255,255,255,.22)",
               "hillshade-accent-color": "rgba(0,0,0,.25)" } }, before);
  }
  function clearTerrain() { if (M().getLayer("hillshade")) M().removeLayer("hillshade"); if (M().getSource("dem")) M().removeSource("dem"); }

  // ── day/night terminator ──────────────────────────────────────────────
  // Follows the SELECTED time, not the wall clock: scrub the tape and watch
  // the night slide. Subsolar point from a low-precision solar ephemeris —
  // a degree of error is invisible at this scale.
  function nightPolygon(date) {
    const rad = Math.PI / 180, d = (date - new Date(Date.UTC(2000, 0, 1, 12))) / 86400e3;
    const L = (280.460 + 0.9856474 * d) % 360, g = ((357.528 + 0.9856003 * d) % 360) * rad;
    const ec = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const decl = Math.asin(Math.sin(23.439 * rad) * Math.sin(ec));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const ra = Math.atan2(Math.cos(23.439 * rad) * Math.sin(ec), Math.cos(ec));
    const subLon = ((ra / rad) - gmst * 15 + 540) % 360 - 180;
    const subLat = decl / rad;
    // the terminator: every point 90° of arc from the subsolar point.
    // sin(lat2) = cos(lat1)·cos(az); lon2 = lon1 + atan2(sin(az)·cos(lat1), −sin(lat1)·sin(lat2))
    const ring = [];
    const lat1 = subLat * rad, lon1 = subLon * rad;
    for (let a = 0; a < 360; a += 3) {
      const az = a * rad;
      const lat2 = Math.asin(Math.cos(lat1) * Math.cos(az));
      const lon2 = lon1 + Math.atan2(Math.sin(az) * Math.cos(lat1), -Math.sin(lat1) * Math.sin(lat2));
      ring.push([((lon2 / rad + 540) % 360) - 180, lat2 / rad]);
    }
    // close over the dark pole: the pole opposite the sun's hemisphere
    const poleLat = subLat > 0 ? -90 : 90;
    ring.sort((p, q) => p[0] - q[0]);
    const coords = [[-180, poleLat], ...ring.map(([x, y]) => [x, y]), [180, poleLat], [-180, poleLat]];
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
  }
  function updateNight() {
    if (!state.night || !M().getSource) return;
    const gj = nightPolygon(WX.fn.validDate());
    if (M().getSource("night")) M().getSource("night").setData(gj);
    else {
      M().addSource("night", { type: "geojson", data: gj });
      M().addLayer({ id: "night", type: "fill", source: "night",
        paint: { "fill-color": "#03060f", "fill-opacity": 0.32 } }, WX.fn.firstSymbolId());
    }
  }
  function clearNight() { if (M().getLayer("night")) M().removeLayer("night"); if (M().getSource("night")) M().removeSource("night"); }

  function clearIso() { ["iso-hl", "iso-label", "iso-line"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("iso")) M().removeSource("iso"); }

  // ── avalanche regions overlay ─────────────────────────────────────────
  async function loadAvy() {
    try {
      const gj = await WX.api(`${API}/avy/layer`);
      if (!state.avy) return;
      if (M().getSource("avy")) M().getSource("avy").setData(gj);
      else {
        M().addSource("avy", { type: "geojson", data: gj });
        M().addLayer({ id: "avy-fill", type: "fill", source: "avy", paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", [">", ["get", "danger_level"], 0], 0.32, 0.12] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "avy-line", type: "line", source: "avy", paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.8 } }, WX.fn.firstSymbolId());
      }
      const rated = gj.features.filter((x) => x.properties.danger_level > 0).length;
      WX.fn.toast(rated ? `Avalanche regions: ${rated} with a current rating` : "Avalanche regions loaded — off season, no current ratings (forecasts resume ~November)", 5000);
    } catch (e) { WX.fn.toast("Avalanche layer unavailable", 4000, "error"); state.avy = false; $("#avy-toggle").classList.remove("on"); }
  }
  function clearAvy() { ["avy-line", "avy-fill"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("avy")) M().removeSource("avy"); }

  // ── ski resorts overlay ───────────────────────────────────────────────
  // Pins for every resort; when a snow layer is showing, each pin is sized
  // and coloured by the forecast snowfall in the next 72 h from the selected
  // time (the OpenSnow map), with the amount as its label.
  let resortsCatalog = null, resortSnow = null, resortSnowKey = "", pendingSnow = null;
  const SNOW_STOPS = [0, "#8a8f98", 5, "#9dd3ff", 15, "#6cb6ff", 30, "#8b7cff", 60, "#e05bd0", 100, "#ff5c8a"];
  async function loadResorts() {
    try {
      if (!resortsCatalog) resortsCatalog = (await WX.api(`${API}/resorts/all`)).resorts;
      if (!state.resorts) return;
      const snowMode = ["sf6", "sf24", "sf72", "sd_cm"].includes(state.layer);
      const key = `${state.model}/${state.run}/${WX.stepHours}`;
      if (snowMode && resortSnowKey !== key && !pendingSnow) {
        // draw the pins now, recolour when the amounts land
        pendingSnow = WX.api(`${API}/resorts/snow?model=${state.model}&run=${state.run}&step=${WX.stepHours}&hours=72`)
          .then((r) => { resortSnow = r.snow_cm; resortSnowKey = key; }).catch(() => { resortSnow = null; })
          .finally(() => { pendingSnow = null; if (state.resorts) loadResorts(); });
      }
      const gj = { type: "FeatureCollection", features: resortsCatalog.map((r) => { const sn = snowMode && resortSnow && resortSnowKey === key ? resortSnow[r.id] : null; return { type: "Feature", properties: { id: r.id, name: r.name, snow: sn == null ? -1 : sn, label: sn == null ? r.name : (sn >= 1 ? `${Math.round(sn)} cm` : "") }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } }; }) };
      if (M().getSource("resorts")) M().getSource("resorts").setData(gj);
      else {
        M().addSource("resorts", { type: "geojson", data: gj });
        M().addLayer({ id: "resort-pts", type: "circle", source: "resorts", paint: {} });
        M().addLayer({ id: "resort-lbl", type: "symbol", source: "resorts", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.2 } });
      }
      // paint by mode
      const snowColor = ["case", ["<", ["get", "snow"], 0], "#ffb454", ["interpolate", ["linear"], ["get", "snow"], ...SNOW_STOPS]];
      M().setPaintProperty("resort-pts", "circle-color", snowMode ? snowColor : "#ffb454");
      M().setPaintProperty("resort-pts", "circle-radius", snowMode
        ? ["interpolate", ["linear"], ["zoom"], 3, ["+", 2, ["*", 0.05, ["max", 0, ["get", "snow"]]]], 8, ["+", 4, ["*", 0.12, ["max", 0, ["get", "snow"]]]]]
        : ["interpolate", ["linear"], ["zoom"], 3, 2.5, 8, 6]);
      M().setPaintProperty("resort-pts", "circle-stroke-color", "#0b0d10");
      M().setPaintProperty("resort-pts", "circle-stroke-width", 1.2);
      M().setPaintProperty("resort-pts", "circle-opacity", 0.92);
      M().setLayerZoomRange("resort-lbl", snowMode ? 4 : 7, 24);
      M().setPaintProperty("resort-lbl", "text-color", snowMode ? "#dfe8ff" : "#ffd39a");
    } catch (e) { WX.fn.toast("Resort catalog unavailable", 4000, "error"); }
  }
  function clearResorts() { ["resort-lbl", "resort-pts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("resorts")) M().removeSource("resorts"); }

  async function selectResort(id) {
    try {
      const d = await WX.api(`${API}/resorts/${id}`);
      state.resort = d;
      const r = d.resort;
      // lifts + boundary on the M()
      const lifts = d.lifts || { type: "FeatureCollection", features: [] };
      if (M().getSource("lifts")) M().getSource("lifts").setData(lifts);
      else {
        M().addSource("lifts", { type: "geojson", data: lifts });
        M().addLayer({ id: "lifts-line", type: "line", source: "lifts", paint: { "line-color": "#ffb454", "line-width": 2, "line-opacity": 0.9 } });
        M().addLayer({ id: "lifts-lbl", type: "symbol", source: "lifts", minzoom: 11, layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 10, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1 } });
      }
      // The runs, coloured the way a trail map colours them. Black diamonds are
      // drawn near-white here: this basemap is dark, and a black line on it is
      // an absent line. Every run gets a dark casing so it reads over snow,
      // forest and the weather field alike.
      const pistes = d.pistes || { type: "FeatureCollection", features: [] };
      const gradeColour = ["match", ["get", "grade"],
        "novice", "#5ad469", "easy", "#3d8bff", "intermediate", "#ff4d4d",
        "advanced", "#f2f2f2", "expert", "#c56bff", "freeride", "#ffb454", "extreme", "#ff7a2f",
        "#9aa5b4"];
      if (M().getSource("pistes")) M().getSource("pistes").setData(pistes);
      else {
        M().addSource("pistes", { type: "geojson", data: pistes });
        M().addLayer({ id: "pistes-case", type: "line", source: "pistes", minzoom: 9,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "rgba(0,0,0,.65)", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.6, 13, 6.5], "line-opacity": 0.9 } });
        // line-dasharray takes no data expression, so ungroomed runs get their
        // own layer rather than a condition MapLibre would reject silently.
        const pisteWidth = ["interpolate", ["linear"], ["zoom"], 9, 1.3, 13, 4];
        M().addLayer({ id: "pistes-line", type: "line", source: "pistes", minzoom: 9,
          filter: ["!=", ["get", "grade"], "freeride"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": gradeColour, "line-width": pisteWidth, "line-opacity": 0.95 } });
        M().addLayer({ id: "pistes-free", type: "line", source: "pistes", minzoom: 9,
          filter: ["==", ["get", "grade"], "freeride"],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: { "line-color": "#ffb454", "line-width": pisteWidth, "line-opacity": 0.95, "line-dasharray": [2, 1.4] } });
        M().addLayer({ id: "pistes-lbl", type: "symbol", source: "pistes", minzoom: 12.5,
          layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name"], ["get", "ref"]], "text-size": 10, "text-font": ["Noto Sans Regular"] },
          paint: { "text-color": "#eef1f5", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.2 } });
      }
      const bnd = d.boundary ? { type: "FeatureCollection", features: [d.boundary] } : { type: "FeatureCollection", features: [] };
      if (M().getSource("bnd")) M().getSource("bnd").setData(bnd);
      else { M().addSource("bnd", { type: "geojson", data: bnd }); M().addLayer({ id: "bnd-line", type: "line", source: "bnd", paint: { "line-color": "#ffb454", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, WX.fn.firstSymbolId()); }
      M().flyTo({ center: [r.lon, r.lat], zoom: Math.max(M().getZoom(), 10.5), duration: 900 });
      state.tab = "resort";
      WX.fn.openPoint(r.lat, r.lon, r.name);
    } catch (e) { WX.fn.toast("Resort detail unavailable", 4000, "error"); }
  }
  WX.selectResort = selectResort;

  // ── alerts: NWS polygons (GeoJSON) + Environment Canada (GeoMet WMS) ─
  async function loadAlerts() {
    try {
      const gj = await WX.api(`${API}/alerts/layer`);
      if (!state.alerts) return;
      if (M().getSource("alerts")) M().getSource("alerts").setData(gj);
      else {
        M().addSource("alerts", { type: "geojson", data: gj });
        M().addLayer({ id: "alerts-fill", type: "fill", source: "alerts", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.28 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-line", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": 1.6 } }, WX.fn.firstSymbolId());
        M().on("click", "alerts-fill", (e) => { const p = e.features[0].properties; WX.fn.toast(`${p.event} · ${p.area}`.slice(0, 160), 6000); });
      }
      if (!M().getSource("ec-alerts")) {
        M().addSource("ec-alerts", { type: "raster", tileSize: 256, attribution: "Alerts © Environment Canada",
          tiles: ["https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ALERTS&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES="] });
        M().addLayer({ id: "ec-alerts", type: "raster", source: "ec-alerts", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
      WX.fn.toast(`${gj.features.length} NWS alerts, plus the Environment Canada layer.`, 4000);
    } catch (e) { WX.fn.toast("Alerts unavailable", 4000, "error"); state.alerts = false; $("#alerts-toggle").classList.remove("on"); }
  }
  function clearAlerts() { ["alerts-line", "alerts-fill", "ec-alerts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); ["alerts", "ec-alerts"].forEach((sname) => M().getSource(sname) && M().removeSource(sname)); }

  // ── tropical systems (NHC): cone, track, current position ─────────────
  async function loadStorms() {
    try {
      const gj = await WX.api(`${API}/storms`);
      if (!state.storms) return;
      if (M().getSource("storms")) M().getSource("storms").setData(gj);
      else {
        M().addSource("storms", { type: "geojson", data: gj });
        // The cone is a whisper, not a warning sign: soft fill, hairline
        // dashed edge. The track reads as forecast (dashed) with waypoints.
        M().addLayer({ id: "storm-cone", type: "fill", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "fill-color": "#ffb454", "fill-opacity": 0.10 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "storm-cone-line", type: "line", source: "storms", filter: ["==", ["get", "layer"], "cone"], paint: { "line-color": "rgba(255,180,84,.55)", "line-width": 1, "line-dasharray": [3, 2.5] } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "storm-track", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "rgba(255,255,255,.72)", "line-width": 1.6, "line-dasharray": [1.6, 1.8] } });
        M().addLayer({ id: "storm-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 2.8, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
        // The eye wears its category colour — red deepens with the scale.
        M().addLayer({ id: "storm-now", type: "circle", source: "storms", filter: ["==", ["get", "kind"], "current"],
          paint: { "circle-radius": 9.5, "circle-color": ["coalesce", ["get", "category_color"], "#ef786f"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        // the category lives INSIDE the eye — "2" in the yellow disc, "TD"
        // in the blue one — and the sub-label carries the motion instead
        M().addLayer({ id: "storm-eye", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "text-field": ["coalesce", ["get", "eye"], ""], "text-size": 9, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
          paint: { "text-color": "#10131a" } });
        M().addLayer({ id: "storm-lbl", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "text-field": ["concat", ["get", "class"], " ", ["get", "name"], "\n", ["coalesce", ["get", "moving_short"], ""]], "text-size": 11.5, "text-offset": [0, 1.4], "text-anchor": "top", "text-font": ["Noto Sans Bold"] },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.4 } });
        M().on("click", "storm-now", (e) => openStormCard(e.features[0]));
        M().on("click", "storm-eye", (e) => openStormCard(e.features[0]));
        M().on("mouseenter", "storm-now", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "storm-now", () => { M().getCanvas().style.cursor = ""; });
      }
      const names = (gj.storms || []).map((x) => `${x.class} ${x.name}`).join(", ");
      WX.fn.toast(names ? `Tropical systems: ${names}` : "No tropical systems in the NHC and CPHC feeds.", 5000);
      if (gj.storms && gj.storms.length && !state.point) { const st = gj.storms[0]; const f = gj.features.find((x) => x.properties.kind === "current" && x.properties.id === st.id); if (f) M().flyTo({ center: f.geometry.coordinates, zoom: Math.max(3.5, Math.min(M().getZoom(), 5)), duration: 1200 }); }
    } catch (e) { WX.fn.toast("Storm feed unavailable", 4000, "error"); state.storms = false; $("#storms-toggle").classList.remove("on"); }
  }
  let stormPopup = null;
  function openStormCard(f) {
    const p = f.properties;
    const ago = p.updated ? (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`)(Date.now() - new Date(p.updated)) : "";
    const kmh = p.intensity_kt ? Math.round(p.intensity_kt * 1.852) : null;
    const [slon, slat] = f.geometry.coordinates;
    // Which desk is tracking it. The NHC feed carries Atlantic (al), East
    // Pacific (ep) and Central Pacific (cp) ids; other agencies join when
    // their feeds do.
    const agency = /^cp/i.test(p.id || "") ? "CPHC · Honolulu" : "NHC · Miami";
    const esc_ = (x) => String(x == null ? "" : x).replace(/</g, "&lt;");
    if (stormPopup) stormPopup.remove();
    stormPopup = new maplibregl.Popup({ className: "quake-pop storm-pop", closeButton: true, maxWidth: "300px", offset: 12 })
      .setLngLat([slon, slat])
      .setHTML(`<div class="qp-head"><i class="sp-ico" style="color:${p.category_color || "#ef786f"}">${WX.CYCLONE_SVG || ""}</i><b>${esc_(p.class)} ${esc_(p.name)}</b><span>${ago}</span></div>
        <dl>
        ${p.category_label ? `<dt>Type</dt><dd><span class="sp-cat" style="--cat:${p.category_color}">${esc_(p.category)}</span> ${esc_(p.category_label)}</dd>` : ""}
        ${p.intensity_kt ? `<dt>Winds</dt><dd>${esc_(p.intensity_kt)} kt · ${kmh} km/h</dd>` : ""}
        ${p.gusts ? `<dt>Gusts</dt><dd>${esc_(p.gusts)} kt · ${Math.round(p.gusts * 1.852)} km/h</dd>` : ""}
        ${p.pressure_mb ? `<dt>Pressure</dt><dd>${esc_(p.pressure_mb)} mb</dd>` : ""}
        ${p.movement && !/null/.test(p.movement) ? `<dt>Moving</dt><dd>${esc_(p.movement)}</dd>` : ""}
        <dt>Position</dt><dd>${WX.fmtCoords ? WX.fmtCoords(slat, slon, 1) : `${slat.toFixed(1)}, ${slon.toFixed(1)}`}</dd>
        <dt>Agency</dt><dd>${agency}</dd>
        ${p.advisory ? `<dt>Advisory</dt><dd>#${esc_(p.advisory)}</dd>` : ""}</dl>
        ${p.url ? `<a class="qp-link" href="${p.url}" target="_blank" rel="noopener">Public advisory ↗</a>` : ""}`)
      .addTo(M());
  }
  WX.openStormCard = openStormCard;
  function clearStorms() {
    if (stormPopup) { stormPopup.remove(); stormPopup = null; } ["storm-lbl", "storm-eye", "storm-now", "storm-pts", "storm-track", "storm-cone-line", "storm-cone"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("storms")) M().removeSource("storms"); }

  // ── satellite: GOES GeoColor via NASA GIBS (timeless URL = latest) ────
  function loadSat() {
    for (const [id, name] of [["sat-east", "GOES-East_ABI_GeoColor"], ["sat-west", "GOES-West_ABI_GeoColor"]]) {
      if (M().getSource(id)) continue;
      M().addSource(id, { type: "raster", tileSize: 256, maxzoom: 7, attribution: "Satellite: NASA GIBS / NOAA GOES",
        tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${name}/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png?t=${Math.floor(Date.now() / 6e5)}`] });
      M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, "wx");
    }
    // The imagery is the point here: the field steps well back, and a badge
    // says what the pixels are and where they end, so a hard disc edge over
    // Asia reads as coverage, not a bug.
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.3, LAYER_ALPHA[state.layer]));
    badge("sat", `Satellite <b>GOES GeoColor</b> <small>~1 h old · Americas + Pacific only</small>`, "#9fb0c8");
  }
  function clearSat() { ["sat-east", "sat-west"].forEach((l) => { if (M().getLayer(l)) M().removeLayer(l); if (M().getSource(l)) M().removeSource(l); }); badge("sat", null); WX.fn.applyStep(); }

  // ── corner badges ─────────────────────────────────────────────────────
  // A keyed stack of small chips bottom-left, above the met-service badge:
  // "which radar am I looking at", "which aurora nowcast". Injected rather
  // than added to styles.css so each module carries its own presentation;
  // the values are the app's own tokens, so it follows the theme.
  const BADGE_CSS = `
  #wx-badges { position: absolute; z-index: 5; left: 62px; bottom: calc(var(--tb-h, 150px) + 58px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; align-items: flex-start; gap: 5px; pointer-events: none; }
  .wx-badge { display: inline-flex; align-items: baseline; gap: 7px; max-width: min(46vw, 420px);
    padding: 5px 11px; border-radius: 999px; background: var(--panel, rgba(12,14,18,.72)); border: 1px solid var(--line, rgba(255,255,255,.09));
    backdrop-filter: blur(8px); font: 700 11.5px var(--font-display, system-ui, sans-serif); color: var(--fg-2, #c3cad6); letter-spacing: .01em; }
  .wx-badge i { font-style: normal; width: 8px; height: 8px; border-radius: 50%; align-self: center; flex: 0 0 8px; box-shadow: 0 0 10px currentColor; }
  .wx-badge small { font: 600 10px var(--font-mono, ui-monospace, monospace); color: var(--dim, #7c8492); }
  .wx-badge b { color: var(--fg, #eef1f5); font-weight: 700; }
  @media (max-width: 820px) { #wx-badges { left: 12px; bottom: calc(var(--tb-h, 150px) + 22px + env(safe-area-inset-bottom)); } }
  `;
  function badgeBox() {
    let box = $("#wx-badges");
    if (!box) {
      const st = document.createElement("style"); st.id = "wx-badges-css"; st.textContent = BADGE_CSS;
      document.head.appendChild(st);
      box = document.createElement("div"); box.id = "wx-badges";
      (document.querySelector("#map") || document.body).appendChild(box);
    }
    return box;
  }
  // badge(key, html, color) — html null removes it. Keys keep the stack stable
  // so the radar chip doesn't jump when the aurora chip appears.
  function badge(key, html, color) {
    const box = badgeBox();
    let el = box.querySelector(`[data-badge="${key}"]`);
    if (html == null) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.className = "wx-badge"; el.dataset.badge = key; box.appendChild(el); }
    el.innerHTML = `<i style="color:${color || "var(--accent, #ff8a3d)"};background:currentColor"></i>${html}`;
  }

  // ── radar ─────────────────────────────────────────────────────────────
  // Agency composites where they exist, RainViewer everywhere else. The API
  // hands us every source with its frame timestamps and tile-URL templates
  // plus the id this map centre should prefer; we walk its fallback chain
  // until one has frames, so a dead upstream degrades instead of breaking the
  // toggle. Frames keep RainViewer's shape ({time, kind}) because tape.js
  // renders the strip straight off state.radarFrames.
  const RADAR_MAX_SUBLAYERS = 4;          // ECCC needs two (rain + snow)
  let radarReq = 0, radarMoveTimer = null;

  async function toggleRadar() {
    state.radar = !state.radar;
    if (state.radar && WX.fn.clearOtherCover) WX.fn.clearOtherCover("radar");
    $("#radar-toggle").classList.toggle("on", state.radar);
    if (!state.radar) { clearRadar(); WX.tape.renderTape(); WX.fn.applyStep(); return; }
    if (WX.fn.setTapeState) WX.fn.setTapeState("mini", false);
    await loadRadar();
  }

  // Only the outermost sources call: RainViewer straight from the browser, for
  // when our own API is the thing that is down.
  async function rainviewerDirect() {
    const j = await (await fetch(RAINVIEWER, { cache: "no-store" })).json();
    const frames = [...(j.radar.past || []).map((x) => ({ time: x.time, token: x.path, kind: "past" })),
                    ...(j.radar.nowcast || []).map((x) => ({ time: x.time, token: x.path, kind: "nowcast" }))];
    return { id: "rainviewer", label: "RainViewer", detail: "Global composite · last 2 h plus nowcast",
             attribution: "Radar © RainViewer", frames, templates: [`${j.host}{token}/256/{z}/{x}/{y}/2/1_1.png`] };
  }

  async function loadRadar(quiet) {
    const my = ++radarReq;
    const c = M().getCenter();
    let picked = null, catalog = null;
    try {
      catalog = await WX.api(U(`${API}/radar/sources?lat=${c.lat.toFixed(3)}&lon=${WX.wlon(c.lng).toFixed(3)}`));
      const byId = Object.fromEntries((catalog.sources || []).map((s) => [s.id, s]));
      for (const id of catalog.order || []) { const s = byId[id]; if (s && s.frames && s.frames.length) { picked = s; break; } }
      if (!picked) picked = (catalog.sources || []).find((s) => s.frames && s.frames.length) || null;
    } catch (e) { /* our API is down; go straight to the source below */ }
    if (!picked) { try { picked = await rainviewerDirect(); } catch (e) { /* nothing left */ } }
    if (my !== radarReq || !state.radar) return;
    if (!picked) {
      WX.fn.toast("No radar source answered.", 4500, "error");
      state.radar = false; $("#radar-toggle").classList.remove("on"); clearRadar();
      return;
    }
    // Keep the same valid time across a source swap where we can, so panning
    // over the border doesn't jump the loop back to the start.
    const wasAt = state.radarFrames.length ? state.radarFrames[state.radarIdx] : null;
    const changed = !state.radarSource || state.radarSource.id !== picked.id;
    state.radarSource = picked;
    state.radarFrames = picked.frames.map((f) => ({ ...f, kind: f.kind || "past" }));
    const lastPast = state.radarFrames.map((f) => f.kind).lastIndexOf("past");
    state.radarIdx = lastPast >= 0 ? lastPast : state.radarFrames.length - 1;
    if (wasAt) {
      let best = state.radarIdx, err = Infinity;
      state.radarFrames.forEach((f, i) => { const d = Math.abs(f.time - wasAt.time); if (d < err) { err = d; best = i; } });
      if (err < 1800) state.radarIdx = best;
    }
    if (changed) clearRadarLayers();      // colour tables differ; don't cross-fade them
    applyRadarFrame();
    WX.tape.renderTape();
    const failed = (catalog && (catalog.sources || []).filter((s) => s.error).map((s) => s.id)) || [];
    if (!quiet) {
      const span = state.radarFrames.length ? Math.round((state.radarFrames[state.radarFrames.length - 1].time - state.radarFrames[0].time) / 60) : 0;
      WX.fn.toast(`${picked.label}, ${picked.detail}. ${state.radarFrames.length} frames over ${span} min.`
        + (failed.length ? ` (${failed.join(", ")} unavailable, fell back)` : ""), 5500);
    }
  }

  // Re-pick when the map moves far enough to change country. Debounced, and
  // the API caches frame lists for two minutes, so panning is cheap.
  function refreshRadarSource() {
    if (!state.radar) return;
    clearTimeout(radarMoveTimer);
    radarMoveTimer = setTimeout(() => loadRadar(true), 600);
  }

  // Only {token} is ours; {z}/{x}/{y} and {bbox-epsg-3857} belong to MapLibre.
  function radarTiles(fr) {
    const src = state.radarSource;
    if (!src || !fr) return [];
    return (src.templates || []).map((t) => t.split("{token}").join(fr.token == null ? "" : fr.token));
  }

  function applyRadarFrame() {
    const src = state.radarSource, fr = state.radarFrames[state.radarIdx];
    if (!src || !fr) return;
    const urls = radarTiles(fr);
    urls.slice(0, RADAR_MAX_SUBLAYERS).forEach((u, i) => {
      const id = `radar-${i}`;
      if (M().getSource(id)) M().getSource(id).setTiles([u]);
      else {
        M().addSource(id, { type: "raster", tiles: [u], tileSize: 256, attribution: src.attribution });
        M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
    });
    for (let i = urls.length; i < RADAR_MAX_SUBLAYERS; i++) dropLayer(`radar-${i}`);
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.45, LAYER_ALPHA[state.layer]));
    const t = new Date(fr.time * 1000);
    $("#valid-local").textContent = t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) + (fr.kind === "nowcast" ? " · nowcast" : " · radar");
    $("#valid-utc").textContent = t.toISOString().slice(11, 16) + "Z";
    const ageMin = Math.round((Date.now() / 1000 - fr.time) / 60);
    $("#lead").textContent = ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`;
    badge("radar", `Radar <b>${src.label}</b> <small>${t.toISOString().slice(11, 16)}Z${fr.kind === "nowcast" ? " nowcast" : ""}</small>`, "var(--rain, #6cb6ff)");
    WX.tape.renderTapeSelection();
  }

  function dropLayer(id) { if (M().getLayer(id)) M().removeLayer(id); if (M().getSource(id)) M().removeSource(id); }
  function clearRadarLayers() { dropLayer("radar"); for (let i = 0; i < RADAR_MAX_SUBLAYERS; i++) dropLayer(`radar-${i}`); }
  function clearRadar() {
    clearTimeout(radarMoveTimer); radarReq++;
    clearRadarLayers();
    state.radarFrames = []; state.radarSource = null;
    badge("radar", null);
  }

  // ── measure tool: two taps → distance (km / nm) and true bearing ──────
  let measurePts = [];
  function measureClick(ll) {
    measurePts.push([ll.lng, ll.lat]);
    if (measurePts.length > 2) measurePts = [[ll.lng, ll.lat]];
    const gj = { type: "FeatureCollection", features: measurePts.length === 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: measurePts } }] : [] };
    if (M().getSource("measure")) M().getSource("measure").setData(gj);
    else { M().addSource("measure", { type: "geojson", data: gj }); M().addLayer({ id: "measure-line", type: "line", source: "measure", paint: { "line-color": "#ffb454", "line-width": 2, "line-dasharray": [1.5, 1.5] } }); }
    const box = $("#measure"); box.hidden = false;
    if (measurePts.length < 2) { box.textContent = "tap the second point"; return; }
    const [a, b] = measurePts;
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(h));
    const y = Math.sin(dLon) * Math.cos(b[1] * toR), x = Math.cos(a[1] * toR) * Math.sin(b[1] * toR) - Math.sin(a[1] * toR) * Math.cos(b[1] * toR) * Math.cos(dLon);
    const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    box.innerHTML = `<b>${km.toFixed(km < 100 ? 1 : 0)} km</b> · ${(km / 1.852).toFixed(km < 100 ? 1 : 0)} nm · ${(km * 0.621371).toFixed(0)} mi · true bearing <b>${brg.toFixed(0).padStart(3, "0")}°</b>`;
  }
  function clearMeasure() { measurePts = []; $("#measure").hidden = true; if (M().getLayer("measure-line")) M().removeLayer("measure-line"); if (M().getSource("measure")) M().removeSource("measure"); }

  // ── smoke / fires / quakes ────────────────────────────────────────────
  const WMS = (layer, base) => `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES=`;
  function loadSmoke() {
    if (M().getSource("smoke")) return;
    M().addSource("smoke", { type: "raster", tileSize: 256, attribution: "Smoke/PM2.5: ECCC RAQDPS", tiles: [WMS("RAQDPS.SFC_PM2.5", "https://geo.weather.gc.ca/geomet")] });
    M().addLayer({ id: "smoke", type: "raster", source: "smoke", paint: { "raster-opacity": 0.6, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    toast("Smoke: surface PM2.5 forecast (ECCC RAQDPS), North America, latest model hour", 4500);
  }
  function clearSmoke() { if (M().getLayer("smoke")) M().removeLayer("smoke"); if (M().getSource("smoke")) M().removeSource("smoke"); }
  function loadFires() {
    if (M().getSource("fires")) return;
    M().addSource("fires", { type: "raster", tileSize: 256, attribution: "Hotspots: NRCan CWFIS", tiles: [WMS("public:hotspots_last24hrs", "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms")] });
    M().addLayer({ id: "fires", type: "raster", source: "fires", paint: { "raster-opacity": 0.95, "raster-fade-duration": 0 } });
    toast("Satellite hotspots, last 24 h. NRCan CWFIS, Canada and border states.", 4500);
  }
  function clearFires() { if (M().getLayer("fires")) M().removeLayer("fires"); if (M().getSource("fires")) M().removeSource("fires"); }
  async function loadQuakes() {
    try {
      const gj = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson").then((r) => r.json());
      if (!state.quakes) return;
      if (M().getSource("quakes")) M().getSource("quakes").setData(gj);
      else {
        M().addSource("quakes", { type: "geojson", data: gj });
        M().addLayer({ id: "quakes", type: "circle", source: "quakes", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 4, 5, 9, 7, 18], "circle-color": ["interpolate", ["linear"], ["get", "mag"], 2.5, "#f5d33c", 5, "#e8590c", 7, "#b30000"], "circle-opacity": 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
        M().on("click", "quakes", (e) => {
          const f = e.features[0], p = f.properties;
          const mag = Number(p.mag);
          const col = mag >= 7 ? "#ff6a5e" : mag >= 5 ? "#e8590c" : "#e3c53c";
          const ago = (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 86400e3)} d ago`)(Date.now() - p.time);
          const depth = f.geometry.coordinates[2];
          if (quakePopup) quakePopup.remove();
          quakePopup = new maplibregl.Popup({ className: "quake-pop", closeButton: true, maxWidth: "270px", offset: 10 })
            .setLngLat(f.geometry.coordinates.slice(0, 2))
            .setHTML(`<div class="qp-head"><b style="color:${col}">M${mag.toFixed(1)}</b><span>${ago}</span></div>
              <div class="qp-place">${String(p.place || "").replace(/</g, "&lt;")}</div>
              <dl><dt>Time</dt><dd>${new Date(p.time).toLocaleString()}</dd>
              ${depth != null ? `<dt>Depth</dt><dd>${Math.round(depth)} km</dd>` : ""}
              ${Number(p.felt) > 0 ? `<dt>Felt reports</dt><dd>${p.felt}</dd>` : ""}
              ${Number(p.tsunami) === 1 ? `<dt>Tsunami</dt><dd>advisory issued</dd>` : ""}</dl>
              ${p.url ? `<a class="qp-link" href="${p.url}" target="_blank" rel="noopener">USGS event page ↗</a>` : ""}`)
            .addTo(M());
        });
        M().on("mouseenter", "quakes", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "quakes", () => { M().getCanvas().style.cursor = ""; });
      }
      toast(`${gj.features.length} quakes M2.5 and up in the past day. USGS.`, 4000);
    } catch (e) { toast("USGS feed unavailable", 4000, "error"); }
  }
  // ── aerosol optical depth: MODIS Terra+Aqua combined, yesterday (NASA GIBS)
  function loadAod() {
    if (M().getSource("aod")) return;
    const d = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    M().addSource("aod", { type: "raster", tileSize: 256, maxzoom: 6, attribution: "Aerosol: NASA GIBS MODIS",
      tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/${d}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`] });
    M().addLayer({ id: "aod", type: "raster", source: "aod", paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    toast(`Aerosol optical depth, MODIS, ${d}. Gaps are cloud, or no pass.`, 5000);
  }
  function clearAod() { if (M().getLayer("aod")) M().removeLayer("aod"); if (M().getSource("aod")) M().removeSource("aod"); }

  // ── thunder marks: model CAPE + rain at the shown step ─────────────────
  let thunderReq = 0;
  async function loadThunder() {
    const my = ++thunderReq;
    try {
      const gj = await WX.api(`${API}/thunder/${state.model}/${state.run}/${WX.stepHours}.json`);
      if (my !== thunderReq || !state.thunder) return;
      if (M().getSource("thunder")) M().getSource("thunder").setData(gj);
      else {
        M().addSource("thunder", { type: "geojson", data: gj });
        if (!M().hasImage("bolt")) M().addImage("bolt", boltIcon(), { pixelRatio: 2 });
        M().addLayer({ id: "thunder", type: "symbol", source: "thunder", layout: { "icon-image": "bolt", "icon-size": ["interpolate", ["linear"], ["get", "cape"], 800, 0.55, 3000, 1.0], "icon-allow-overlap": true, "icon-ignore-placement": true },
                       paint: { "icon-opacity": 0.95 } });
      }
    } catch (e) { if (my === thunderReq) toast("No thunder marks for this model.", 4000, "error"); }
  }
  // A yellow lightning bolt with a dark outline, drawn once into a canvas.
  function boltIcon() {
    const c = document.createElement("canvas"); c.width = 44; c.height = 44; const x = c.getContext("2d");
    const P = new Path2D("M25 3 L9 25 L21 25 L17 41 L35 17 L23 17 Z");
    x.lineJoin = "round"; x.lineWidth = 5; x.strokeStyle = "rgba(0,0,0,.65)"; x.stroke(P);
    x.fillStyle = "#ffd54a"; x.fill(P);
    return x.getImageData(0, 0, 44, 44);
  }
  function clearThunder() { if (M().getLayer("thunder")) M().removeLayer("thunder"); if (M().getSource("thunder")) M().removeSource("thunder"); }

  function clearQuakes() { if (M().getLayer("quakes")) M().removeLayer("quakes"); if (M().getSource("quakes")) M().removeSource("quakes"); }

  WX.ov = { loadImagery, clearImagery, setBase, loadTerrain, clearTerrain, updateNight, clearNight, loadSmoke, clearSmoke, loadFires, clearFires, loadQuakes, clearQuakes, loadAod, clearAod, loadThunder, clearThunder, toggleRadar, loadIso, clearIso, isoVar, loadAvy, clearAvy, loadResorts, clearResorts, selectResort, loadAlerts, clearAlerts, loadStorms, clearStorms, loadSat, clearSat, applyRadarFrame, measureClick, clearMeasure, radarTiles,
             loadRadar, clearRadar, refreshRadarSource, badge };
})();

;
// ── tape.js ─────────────────────────────────────────────────────
// The forecast tape under the map (and the radar frame strip).
// Loaded after app.js; exposes WX.tape.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── weather tape ──────────────────────────────────────────────────────
  let tapeReq = 0, tapeKey = "";
  async function refreshTapePoint() {
    const c = M().getCenter();
    const key = `${c.lat.toFixed(2)},${WX.wlon(c.lng).toFixed(2)};${state.model};${state.run}`;
    // Initial map settlement emits moveend after boot has already requested
    // this exact column. Keep the in-flight/result instead of doing the same
    // point-cube read twice.
    if (key === tapeKey) return;
    tapeKey = key;
    const my = ++tapeReq;
    try {
      const d = await WX.api(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${WX.wlon(c.lng).toFixed(2)}&model=${state.model}&run=${state.run}`);
      if (my !== tapeReq) return;
      state.tapePoint = d.available === false ? null : d;
      renderTape();
    } catch (e) {
      if (my !== tapeReq) return;
      tapeKey = "";                       // allow the next moveend to try again
      if (!state.tapePoint) { renderTape(); setTimeout(() => { if (my === tapeReq) refreshTapePoint(); }, 4000); }
    }
  }
  function tapeData() { return state.point && state.point.outside ? null : (state.point && state.point.data) || state.tapePoint; }
  function renderTapePlace() {
    const el = $("#tape-where");
    el.replaceChildren();
    if (!state.point) { el.textContent = "map centre"; return; }
    const name = state.point.name || WX.fmtCoords(state.point.lat, state.point.lon);
    el.append(document.createTextNode(name));
    const region = state.point.local && state.point.local.place && state.point.local.place.region;
    if (region && region.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
      const suffix = document.createElement("span");
      suffix.className = "tape-region";
      suffix.textContent = `, ${region}`;
      el.append(suffix);
    }
  }

  // The tape: a table whose columns are forecast steps grouped under
  // day headers and whose rows are variables (icon, temp, feels like, rain,
  // wind, gusts, direction). Click a column to jump.
  // How many hours between tape columns. Below the run's own spacing the tape
  // interpolates; above it, the tape stops sampling one instant and reports
  // what the whole period did.
  let tapeRes = Number(localStorage.getItem("wxgrid.tapeRes") || 0);      // 0 = the model's own steps
  let fineSelectedValid = null;
  const nativeStep = (d) => (d && d.steps && d.steps.length > 1 ? d.steps[1] - d.steps[0] : 3);
  function renderRes(d) {
    const box = $("#tape-res"); if (!box) return;
    const native = nativeStep(d);
    const opts = [[1, "1 h"], [2, "2 h"], [0, `${native} h`], [6, "6 h"], [12, "12 h"], [24, "24 h"]]
      .filter(([v]) => v === 0 || (v < native ? v : v > native));
    box.innerHTML = opts.map(([v, t]) => `<button data-v="${v}" class="${v === tapeRes ? "on" : ""}">${t}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { tapeRes = Number(b.dataset.v); localStorage.setItem("wxgrid.tapeRes", tapeRes); renderTape(); renderTapeSelection(); });
  }

  // ── column resolution ────────────────────────────────────────────────
  // Series that accumulate over their own interval rather than sampling an
  // instant: they add up when columns merge and split pro rata when a column
  // is divided. Wind direction is an angle, so it wraps.
  const ACCUM = /^(tp|sf)\d+$/;
  const CIRCULAR = new Set(["wdir", "mwd"]);
  const lerpAng = (a, b, f) => { const d = ((b - a + 540) % 360) - 180; return (a + d * f + 360) % 360; };

  // Apparent temperature (wind chill below 10 °C, humidex above 20 °C) in °C.
  // Hoisted out of the renderer so an aggregated column can report the hottest
  // and coldest it actually FELT, not the feel of its own averages.
  function feelsAt(s, i) {
    const t = s.t2m && s.t2m[i] != null ? s.t2m[i] - 273.15 : null, w = s.wind ? s.wind[i] : null;
    if (t == null) return null;
    if (w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; }
    if (s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); return t + 0.5555 * (e - 10); }
    return t;
  }

  // Day and hour in whatever zone the user is reading times in, so "12 h" is
  // this morning and this afternoon where the weather is, not where the
  // browser happens to sit.
  function zoner() {
    const f = new Intl.DateTimeFormat("en-CA", WX.units.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    return (dt) => { const p = {}; for (const x of f.formatToParts(dt)) p[x.type] = x.value;
      return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; };
  }

  const stat = (xs, fn) => { const v = xs.filter((x) => x != null); return v.length ? fn(v) : null; };
  const mean = (xs) => stat(xs, (v) => v.reduce((a, b) => a + b, 0) / v.length);

  // Finer than the model: linear between steps, angles the short way round,
  // and an accumulation window shared out evenly across the columns it covers.
  function interpolate(d0, res) {
    const first = d0.steps[0], last = d0.steps[d0.steps.length - 1], native = nativeStep(d0);
    const steps = []; for (let h = first; h <= last; h += res) steps.push(h);
    if (steps.length < 3) return { d: d0, keep: null, agg: false };
    const t0 = new Date(d0.valid[0]).getTime();
    const seg = (h) => { let k = 0; while (k < d0.steps.length - 2 && d0.steps[k + 1] <= h) k++;
      const span = d0.steps[k + 1] - d0.steps[k]; return [k, span ? (h - d0.steps[k]) / span : 0]; };
    const win = (h) => { let j = 1; while (j < d0.steps.length - 1 && d0.steps[j] < h) j++; return j; };
    const series = {};
    for (const [name, arr] of Object.entries(d0.series)) {
      if (!Array.isArray(arr)) { series[name] = arr; continue; }
      if (ACCUM.test(name)) { const share = res / native; series[name] = steps.map((h) => { const v = arr[win(h)]; return v == null ? null : v * share; }); continue; }
      series[name] = steps.map((h) => {
        const [k, f] = seg(h), a = arr[k], b = arr[k + 1];
        if (a == null || b == null) return a == null ? (b == null ? null : b) : a;
        return CIRCULAR.has(name) ? lerpAng(a, b, f) : a + (b - a) * f;
      });
    }
    // Clicking an interpolated column jumps to the model step nearest it —
    // the map only has the frames the model actually produced.
    const keep = steps.map((h) => d0.steps.reduce((best, sh, i) => (Math.abs(sh - h) < Math.abs(d0.steps[best] - h) ? i : best), 0));
    return { d: { ...d0, steps, valid: steps.map((h) => new Date(t0 + (h - first) * 3600e3).toISOString()), series, _keep: keep }, keep, agg: false };
  }

  // Coarser than the model: buckets aligned to the local clock, each reporting
  // the period it covers — warmest and coldest, everything that fell, the
  // strongest wind — instead of whichever instant happened to land on it.
  function aggregate(d0, res) {
    const zk = zoner(), dates = d0.valid.map((v) => new Date(v));
    const buckets = [];
    dates.forEach((dt, i) => {
      const { day, hour } = zk(dt);
      const key = res >= 24 ? day : `${day}#${Math.floor(hour / res)}`;
      const last = buckets[buckets.length - 1];
      if (last && last.key === key) last.idx.push(i); else buckets.push({ key, idx: [i], hour });
    });
    if (buckets.length < 3) return { d: d0, keep: null, agg: false };
    const s0 = d0.series, pick = (b) => b.idx[Math.floor((b.idx.length - 1) / 2)];
    const series = {};
    for (const [name, arr] of Object.entries(s0)) {
      if (!Array.isArray(arr)) { series[name] = arr; continue; }
      series[name] = buckets.map((b) => {
        const v = b.idx.map((i) => arr[i]);
        if (ACCUM.test(name)) return stat(v, (x) => x.reduce((a, c) => a + c, 0));
        if (name === "t2m" || name === "wind" || name === "gust" || name === "cape") return stat(v, (x) => Math.max(...x));
        if (name === "wdir") { const w = s0.wind ? b.idx.reduce((a, i) => (s0.wind[i] > s0.wind[a] ? i : a), b.idx[0]) : pick(b); return arr[w]; }
        return mean(v);
      });
    }
    // The rows that need a second number: the cold end of the period, and how
    // it felt at both ends.
    series.t2m_lo = buckets.map((b) => stat(b.idx.map((i) => s0.t2m && s0.t2m[i]), (x) => Math.min(...x)));
    const fl = buckets.map((b) => b.idx.map((i) => feelsAt(s0, i)).filter((x) => x != null));
    series.feels_hi = fl.map((v) => (v.length ? Math.max(...v) : null));
    series.feels_lo = fl.map((v) => (v.length ? Math.min(...v) : null));
    const keep = buckets.map(pick);
    return { d: { ...d0, steps: keep.map((i) => d0.steps[i]), valid: keep.map((i) => d0.valid[i]), series, _keep: keep },
             keep, agg: true, res, buckets };
  }

  function resample(d0) {
    const native = nativeStep(d0);
    if (!tapeRes || tapeRes === native || !d0.steps) return { d: d0, keep: null, agg: false };
    return tapeRes < native ? interpolate(d0, tapeRes) : aggregate(d0, tapeRes);
  }

  function renderTape() {
    const tape = $("#tape");
    tape.classList.toggle("radar", state.radar && state.radarFrames.length > 0);
    if (state.radar && state.radarFrames.length) {
      let html = "", lastDay = null;
      state.radarFrames.forEach((fr, i) => {
        const t = new Date(fr.time * 1000), day = t.toDateString();
        if (day !== lastDay) { if (lastDay !== null) html += "</div></div>"; html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short" })} · radar</div><div class="tape-cols">`; lastDay = day; }
        html += `<div class="tape-col ${fr.kind}" data-radar="${i}"><span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span class="tape-glyph" style="color:${fr.kind === "nowcast" ? "var(--warm)" : "var(--rain)"};text-align:center">${fr.kind === "nowcast" ? "◌" : "●"}</span></div>`;
      });
      tape.innerHTML = html + "</div></div>";
      tape.querySelectorAll(".tape-col").forEach((c) => c.onclick = () => { state.radarIdx = Number(c.dataset.radar); WX.ov.applyRadarFrame(); });
      $("#tape-where").textContent = "";
      renderTapeSelection();
      return;
    }
    const d0 = tapeData();
    // An empty tape under a live scrubber reads as broken. Say what is happening.
    if (!d0) { tape.innerHTML = `<div class="tape-empty">${tapeKey ? "loading the forecast for the map centre…" : "forecast unavailable here"}</div>`; return; }
    renderRes(d0);
    // resampling maps every series onto the chosen columns, so the rest of the
    // renderer never has to know whether it is showing model steps, columns
    // between them, or whole periods
    const { d, keep, agg, res: aggRes } = resample(d0);
    const s = d.series, n = d.steps.length;
    const dates = d.valid.map((iso) => new Date(iso));
    const zk = zoner();
    // day header cells: colspan per day, grouped in the zone the times are
    // shown in so the header cannot disagree with the columns under it
    const days = [];
    dates.forEach((dt, i) => { const k = zk(dt).day; if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, start: dt, first: i, span: 0 }); days[days.length - 1].span++; });
    // a day header is a jump: sixteen days of tape is a long way to scrub
    const dayRow = days.map((dy) => { const wd = dy.start.getDay();
      return `<th colspan="${dy.span}" class="day${wd === 0 || wd === 6 ? " wknd" : ""}" data-first="${dy.first}" title="Jump to this day">${dy.start.toLocaleDateString(undefined, WX.units.timeOpts({ weekday: "long", day: "numeric" }))}</th>`; }).join("");
    // sunrise/sunset as thin amber notches on the hour row: compute each
    // day's events once, then find the column whose span holds them
    const sunCols = new Map();   // shown index -> "rise"|"set"
    if (WXPanes && WXPanes.sunTimes && state.point) {
      const seen = new Set();
      dates.forEach((dt, k) => {
        const dk = dt.toISOString().slice(0, 10);
        if (seen.has(dk)) return; seen.add(dk);
        const st = WXPanes.sunTimes(state.point.lat, state.point.lon, dt);
        if (!st) return;
        for (const [which, hUtc] of [["rise", st.riseUtc], ["set", st.setUtc]]) {
          const ev = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) + hUtc * 3600e3;
          let best = -1, bd = Infinity;
          dates.forEach((d2, k2) => { const diff = Math.abs(d2.getTime() - ev); if (diff < bd) { bd = diff; best = k2; } });
          if (best >= 0 && bd < 3600e3 * 2) sunCols.set(best, which);
        }
      });
    }
    // the column whose interval holds the current wall-clock time gets a mark
    const nowMs = Date.now();
    const nowIdx = dates.findIndex((dt, i) => nowMs >= dt.getTime() && (i + 1 >= n || nowMs < dates[i + 1].getTime()));
    const cell = (i, inner, cls = "") => `<td class="${cls} ${dates[i].getHours() < 6 || dates[i].getHours() >= 21 ? "night" : ""}${i === nowIdx ? " now" : ""}${sunCols.has(i) ? ` sun-${sunCols.get(i)}` : ""}" data-i="${i}">${inner}</td>`;
    // A column that covers half a day is named for that half, not for whichever
    // hour its sample landed on; a column that covers a whole day is named by
    // the date above it and needs no clock at all.
    const hourTxt = (dt) => dt.toLocaleTimeString(undefined, WX.units.timeOpts({ hour: "numeric" }));
    const halfTxt = (dt) => (zk(dt).hour < 12 ? "AM" : "PM");
    const showHours = !(agg && aggRes >= 24);
    const colTxt = (dt) => (agg && aggRes === 12 ? halfTxt(dt)
      : `${hourTxt(dt).replace(":00", "").replace(/\s/, "<small>")}${/[ap]m/i.test(hourTxt(dt)) ? "</small>" : ""}`);
    const hourRow = dates.map((dt, i) => cell(i, `<span class="hr">${colTxt(dt)}</span>`, "hour")).join("");
    const iconRow = dates.map((_, i) => cell(i, glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, dates[i].getHours() < 6 || dates[i].getHours() >= 21), "ico")).join("");
    const pair = (hi, lo, fmt) => (hi == null ? "—" : `${fmt(hi)}${lo == null ? "" : `<span class="lo">${fmt(lo)}</span>`}`);
    const degC = (v) => `${WX.units.tempC(v).v}°`, degK = (v) => `${WX.units.temp(v).v}°`;
    const tempRow = dates.map((_, i) => cell(i, agg ? pair(s.t2m && s.t2m[i], s.t2m_lo && s.t2m_lo[i], degK)
      : s.t2m && s.t2m[i] != null ? degK(s.t2m[i]) : "—", "temp")).join("");
    const feelsRow = dates.map((_, i) => { const v = agg ? null : feelsAt(s, i);
      return cell(i, agg ? pair(s.feels_hi && s.feels_hi[i], s.feels_lo && s.feels_lo[i], degC) : v == null ? "—" : degC(v), "feels"); }).join("");
    // No bars under the amounts: they read as a mystery meter in a row this
    // short (Jeff 2026-08-20, "remove them cus thers not enough space").
    const rainRow = dates.map((_, i) => { const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0; if (r == null) return cell(i, "", "rain"); if (sn >= 0.3) return cell(i, `<span class="snow">${WX.units.snow(sn).v}</span>`, "rain"); return cell(i, r >= 0.1 ? `<span>${WX.units.precip(r).v}</span>` : "", "rain"); }).join("");
    // Chance of rain, from the members, only where it says something —
    // a row of zeros is noise dressed as information
    const probRow = s.prob_rain && s.prob_rain.some((v) => v >= 10)
      ? dates.map((_, i) => { const v = s.prob_rain[i]; return cell(i, v == null || v < 5 ? "" : `<span style="opacity:${0.45 + 0.55 * v / 100}">${Math.round(v)}</span>`, "prob"); }).join("")
      : "";
    // the map's own wind ramp, so a colour in the tape means the colour on the
    // map — and light text on the dark end, dark text on the hot end
    const windCol = (v) => {
      const c = WX.rampColor("wind", v, 0.92);
      const light = v * 3.6 > 45;
      return `background: ${c}; color: ${light ? "#160b03" : "var(--fg)"}`;
    };
    const windRow = dates.map((_, i) => { const v = s.wind ? s.wind[i] : null; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("");
    const gustRow = s.gust ? dates.map((_, i) => { const v = s.gust[i]; return cell(i, v == null ? "—" : `<span style="${windCol(v)}">${Math.round(speed(v))}</span>`, "wind"); }).join("") : "";
    const dirRow = dates.map((_, i) => cell(i, s.wdir && s.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(s.wdir[i])}"></i>` : "", "dir")).join("");
    const label = (t, u) => `<th class="lab">${t}${u ? `<small>${u}</small>` : ""}</th>`;
    tape.innerHTML = `<table class="wtape"><thead><tr><th class="lab corner"></th>${dayRow}</tr></thead><tbody>
      ${showHours ? `<tr class="r-hour">${label("Time")}${hourRow}</tr>` : ""}
      <tr class="r-icon">${label("")}${iconRow}</tr>
      <tr class="r-temp">${label(agg ? "Temp high / low" : "Temp", WX.units.tempUnit)}${tempRow}</tr>
      <tr class="r-feels">${label(agg ? "Feels high / low" : "Feels like", WX.units.tempUnit)}${feelsRow}</tr>
      <tr class="r-rain">${label("Precip", `${WX.units.precipUnit} · ${WX.units.snowUnit}`)}${rainRow}</tr>
      ${probRow ? `<tr class="r-prob">${label("Chance", "%")}${probRow}</tr>` : ""}
      <tr class="r-wind">${label("Wind", speedUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${label("Gusts", speedUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${label("Direction")}${dirRow}</tr>
    </tbody></table>`;
    const pick = (shown) => {
      const native = keep ? keep[shown] : shown;
      WX.fn.setStep(native);
      fineSelectedValid = d.valid[shown];
      renderTapeSelection();
    };
    tape.querySelectorAll("td[data-i]").forEach((c) => c.onclick = () => pick(Number(c.dataset.i)));
    tape.querySelectorAll("th.day[data-first]").forEach((c) => c.onclick = () => pick(Number(c.dataset.first)));
    renderTapePlace();
    renderTapeSelection();
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const radar = state.radar && state.radarFrames.length;
    const d0 = tapeData();
    const keep = d0 ? resample(d0).keep : null;
    // the shown column for a step: exact when the tape is at full resolution,
    // otherwise the nearest kept column
    const sampled = d0 ? resample(d0).d : null;
    const shown = fineSelectedValid && sampled
      ? sampled.valid.reduce((best, iso, k, vals) => Math.abs(new Date(iso) - new Date(fineSelectedValid)) < Math.abs(new Date(vals[best]) - new Date(fineSelectedValid)) ? k : best, 0)
      : !keep ? state.stepIdx : keep.reduce((best, idx, k) => Math.abs(idx - state.stepIdx) < Math.abs(keep[best] - state.stepIdx) ? k : best, 0);
    let on = null;
    tape.querySelectorAll(radar ? ".tape-col" : "td[data-i]").forEach((c) => {
      const isOn = radar ? Number(c.dataset.radar) === state.radarIdx : Number(c.dataset.i) === shown;
      c.classList.toggle("on", isOn); if (isOn && !on) on = c;
    });
    // Scroll the tape itself, never scrollIntoView: that walks every scrollable
    // ancestor and drags the whole page sideways under an overflow:hidden body.
    if (on) { const r = on.getBoundingClientRect(), tr = tape.getBoundingClientRect(); if (r.left < tr.left + 60 || r.right > tr.right - 60) tape.scrollTo({ left: tape.scrollLeft + (r.left + r.width / 2) - (tr.left + tr.width / 2), behavior: "smooth" }); }
  }

  function glyph(cloud, precip, tK, night) {
    const c = cloud == null ? 0 : cloud, wet = precip > 0.2;
    const snow = tK != null && tK - 273.15 < 1 && wet, cloudy = c > 0.25 || wet;
    const cx = cloudy ? 8 : 12, cy = cloudy ? 7 : 9;
    const body = night
      ? `<path d="M${cx+2} ${cy-4}a4.5 4.5 0 1 0 2 7.5 4 4 0 0 1-2-7.5z" fill="#d9e2f0"/>`
      : `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#ffd166"/><g stroke="#ffd166" stroke-width="1.2" stroke-linecap="round"><path d="M${cx} ${cy-5.5}v-1.5M${cx} ${cy+5.5}v1.5M${cx-5.5} ${cy}h-1.5M${cx+5.5} ${cy}h1.5M${cx-3.9} ${cy-3.9}l-1-1M${cx+3.9} ${cy-3.9}l1-1M${cx-3.9} ${cy+3.9}l-1 1M${cx+3.9} ${cy+3.9}l1 1"/></g>`;
    const cl = cloudy ? `<path d="M6 13h12a3.5 3.5 0 0 0 .2-7 5 5 0 0 0-9.3-1.2A4.3 4.3 0 0 0 6 13z" fill="rgba(224,231,241,${0.62 + 0.35 * Math.max(c, 0.35)})" stroke="rgba(255,255,255,.28)" stroke-width=".7"/>` : "";
    const rn = wet ? (snow ? `<g transform="translate(12 16)" stroke="#dfe8ff" stroke-width="1" stroke-linecap="round"><path d="M-2 0h4M0-2v4M-1.4-1.4l2.8 2.8M1.4-1.4l-2.8 2.8"/></g>` : `<path d="M8 14.5l-1 2M13 14.5l-1 2M18 14.5l-1 2" stroke="#69b9ff" stroke-width="1.5" stroke-linecap="round"/>`) : "";
    return `<svg class="tape-glyph" viewBox="0 0 24 18" aria-hidden="true">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  }

  WX.tape = { renderTape, renderTapeSelection, refreshTapePoint, tapeData, glyph,
              clearFineSelection: () => { fineSelectedValid = null; } };
})();

;
// ── search.js ───────────────────────────────────────────────────
// Place + resort search box with a results dropdown. Loaded after app.js;
// exposes WX.search.
(function () {
  "use strict";
  const WX = window.WX;
  const { $, $$, API, LAYER_ALPHA, state, speed, speedUnit, arrowRot, toast, url: U } = WX;
  const M = () => WX.map;
  // ── search: places + resorts ──────────────────────────────────────────
  let searchTimer = null, searchSel = -1, searchHits = [];
  // ── favourites: starred places, in localStorage, listed when the box is empty
  const favs = () => JSON.parse(localStorage.getItem("wxgrid.favs") || "[]");
  const isFav = (lat, lon) => favs().some((f) => Math.abs(f.lat - lat) < 1e-3 && Math.abs(f.lon - lon) < 1e-3);
  function toggleFav(lat, lon, name) {
    let list = favs();
    if (isFav(lat, lon)) list = list.filter((f) => !(Math.abs(f.lat - lat) < 1e-3 && Math.abs(f.lon - lon) < 1e-3));
    else list.unshift({ name: name || WX.fmtCoords(lat, lon), lat, lon });
    localStorage.setItem("wxgrid.favs", JSON.stringify(list.slice(0, 30)));
    return isFav(lat, lon);
  }
  const recents = () => JSON.parse(localStorage.getItem("wxgrid.recent") || "[]");
  function pushRecent(h) {
    if (h.kind === "fav" || h.kind === "recent") return;
    const list = recents().filter((r) => !(Math.abs(r.lat - h.lat) < 1e-3 && Math.abs(r.lon - h.lon) < 1e-3));
    list.unshift({ name: h.name, lat: h.lat, lon: h.lon, id: h.id, kind: h.kind });
    localStorage.setItem("wxgrid.recent", JSON.stringify(list.slice(0, 8)));
  }
  function showFavs() {
    const list = favs(), rec = recents().filter((r) => !isFav(r.lat, r.lon)).slice(0, 5);
    if (!list.length && !rec.length) { hideResults(); return; }
    searchHits = [...list.map((f) => ({ kind: "fav", name: f.name, sub: WX.fmtCoords(f.lat, f.lon), lat: f.lat, lon: f.lon })),
                  ...rec.map((r) => ({ kind: "recent", name: r.name, sub: r.kind === "resort" ? "resort" : WX.fmtCoords(r.lat, r.lon), lat: r.lat, lon: r.lon, id: r.id, srcKind: r.kind }))];
    searchSel = 0; paintResults();
  }
  function wireSearch() {
    const q = $("#q");
    q.oninput = () => { clearTimeout(searchTimer); if (!q.value.trim()) { showFavs(); return; } searchTimer = setTimeout(() => runSearch(q.value.trim()), 350); };
    q.onfocus = () => { if (!q.value.trim()) showFavs(); };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); searchSel = Math.min(searchHits.length - 1, searchSel + 1); paintResults(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); searchSel = Math.max(0, searchSel - 1); paintResults(); }
      else if (e.key === "Escape") hideResults();
    };
    $("#search").onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); if (searchHits.length) pickResult(searchHits[Math.max(0, searchSel)]); else runSearch(q.value.trim(), true); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#search") && !e.target.closest("#search-results")) hideResults(); });
  }
  // "49.28, -123.12" · "49°17'N 123°07'W" · "CYVR" · "YVR" — answered locally
  // or from the station list, before anyone bothers a geocoder with it.
  function parseCoords(t) {
    const dec = t.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (dec) { const la = +dec[1], lo = +dec[2]; if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) return { lat: la, lon: lo }; }
    const dms = t.match(/^\s*(\d{1,2})[°: ]\s*(\d{1,2}(?:\.\d+)?)?['′: ]?\s*(\d{1,2}(?:\.\d+)?)?["″]?\s*([NS])[ ,]+(\d{1,3})[°: ]\s*(\d{1,2}(?:\.\d+)?)?['′: ]?\s*(\d{1,2}(?:\.\d+)?)?["″]?\s*([EW])\s*$/i);
    if (dms) {
      const v = (d, m, s) => (+d) + (+(m || 0)) / 60 + (+(s || 0)) / 3600;
      const lat = v(dms[1], dms[2], dms[3]) * (/s/i.test(dms[4]) ? -1 : 1);
      const lon = v(dms[5], dms[6], dms[7]) * (/w/i.test(dms[8]) ? -1 : 1);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
    return null;
  }

  async function runSearch(text, go = false) {
    if (text.length < 2) { hideResults(); return; }
    const c = parseCoords(text);
    if (c) {
      // no name: let the reverse geocode put a place to it
      searchHits = [{ kind: "point", name: WX.fmtCoords(c.lat, c.lon, 3), sub: "coordinates", lat: c.lat, lon: c.lon, unnamed: true }];
      searchSel = 0;
      if (go) { pickResult(searchHits[0]); return; }
      paintResults(); return;
    }
    try {
      const code = /^[A-Za-z]{3,4}$/.test(text.trim()) ? text.trim().toUpperCase() : null;
      const [geo, res, sta] = await Promise.all([
        WX.api(`${API}/geo?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ hits: [] })),
        WX.api(`${API}/resorts?q=${encodeURIComponent(text)}&limit=5`).catch(() => ({ resorts: [] })),
        code ? WX.api(`${API}/station?ids=${code}`).catch(() => ({ stations: [] })) : Promise.resolve({ stations: [] }),
      ]);
      searchHits = [...(sta.stations || []).map((s) => ({ kind: "airport", name: `${s.icao || s.iata} · ${s.name || ""}`.trim(), sub: `${s.region || ""} ${s.country || ""}`.trim(), lat: s.lat, lon: s.lon })),
                    ...res.resorts.map((r) => ({ kind: "resort", name: r.name, sub: `${r.region || ""} ${r.country || ""}`.trim(), lat: r.lat, lon: r.lon, id: r.id })),
                    ...geo.hits.map((h) => ({ kind: "place", name: h.name, sub: h.display.split(",").slice(1, 3).join(",").trim(), lat: h.lat, lon: h.lon }))];
      searchSel = searchHits.length ? 0 : -1;
      if (go && searchHits.length) { pickResult(searchHits[0]); return; }
      paintResults();
    } catch (e) { WX.fn.toast("Search unavailable", 4000, "error"); }
  }
  function paintResults() {
    const box = $("#search-results");
    if (!searchHits.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = searchHits.map((h, i) => `<button class="${i === searchSel ? "sel" : ""}" data-i="${i}"><span class="kind ${h.kind}">${h.kind === "fav" ? "★" : h.kind === "recent" ? "↺" : h.kind}</span><span>${h.name}</span><span class="sub">${h.sub}</span>${h.kind === "fav" ? `<span class="unfav" data-i="${i}" title="Remove">×</span>` : ""}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = (e) => { if (e.target.classList.contains("unfav")) { const h = searchHits[Number(b.dataset.i)]; toggleFav(h.lat, h.lon); showFavs(); return; } pickResult(searchHits[Number(b.dataset.i)]); });
  }
  function hideResults() { $("#search-results").hidden = true; }
  function pickResult(h) {
    hideResults(); $("#q").blur();
    pushRecent(h);
    if (h.kind === "resort" || (h.kind === "recent" && h.srcKind === "resort")) { WX.ov.selectResort(h.id); return; }
    M().flyTo({ center: [h.lon, h.lat], zoom: Math.max(M().getZoom(), 7), duration: 900 });
    WX.fn.openPoint(h.lat, h.lon, h.unnamed ? undefined : h.name);
  }

  WX.search = { wireSearch, hideResults, runSearch, paintResults, pickResult, favs, isFav, toggleFav, showFavs };
})();

;
// ── panes.js ────────────────────────────────────────────────────
// Point-card panes. app.js owns state and calls WXPanes.render(tab, point, i);
// everything here is presentation over the JSON the API already returned,
// plus the lazy fetches a pane needs (avalanche forecast, elevation-band
// profile, other models for Compare).
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const W = () => window.WX;
  const K = 273.15;
  // Sum of the per-step buckets in (steps[i], steps[i]+hours] — the tape can be
  // 3 h or 6 h per column, so "next 24 h" is by hours, not by column count.
  const sumWindow = (arr, steps, i, hours) => { if (!arr) return null; let t = 0, n = 0; for (let k = i + 1; k < steps.length; k++) { if (steps[k] > steps[i] + hours) break; t += arr[k] || 0; n++; } return n ? t : null; };
  const stepHrs = (d, i) => (d.steps[i + 1] != null ? d.steps[i + 1] - d.steps[i] : d.steps[i] - (d.steps[i - 1] || 0)) || 6;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let W_ICONS = {};

  function render(tab, pt, i) {
    const d = pt.data;
    if (tab === "now") renderNow(pt, d, i);
    else if (tab === "aloft") renderAloft(d, i);
    else if (tab === "air") renderAirgram(d, i);
    else if (tab === "skewt") renderSkewT(pt, d, i);
    else if (tab === "winter") renderWinter(pt, d, i);
    else if (tab === "out") renderOutdoors(d, i);
    else if (tab === "cmp") renderCompare(pt, d, i);
    else if (tab === "spread") renderSpread(pt, d, i);
    else if (tab === "resort") renderResort(pt, d, i);
  }

  // ── colour helpers ────────────────────────────────────────────────────
  const TEMP_STOPS = [[-30, [75, 42, 180]], [-15, [40, 150, 220]], [0, [100, 200, 200]], [10, [110, 210, 110]], [20, [240, 220, 80]], [28, [240, 130, 40]], [36, [200, 30, 30]]];
  function lerpStops(stops, v) {
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) if (v >= stops[k][0] && v <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    const q = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0] || 1)));
    return `rgb(${a[1].map((x, k) => Math.round(x + (b[1][k] - x) * q)).join(",")})`;
  }
  const tempColor = (c) => lerpStops(TEMP_STOPS, c);
  const windColor = (ms) => W().rampColor("wind", ms, 0.9);
  const compass = (deg) => deg == null ? "variable" :
    ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  const bigGlyph = (cloud, precip, tK, night) => {
    const c = cloud == null ? 0 : cloud, wet = precip > 0.2;
    const snow = tK != null && tK - K < 1 && wet, cloudy = c > 0.25 || wet;
    const cx = cloudy ? 15 : 23, cy = cloudy ? 15 : 23;
    const rays = [0,45,90,135,180,225,270,315].map((a) => `<line x1="${cx+11.5*Math.cos(a*Math.PI/180)}" y1="${cy+11.5*Math.sin(a*Math.PI/180)}" x2="${cx+14*Math.cos(a*Math.PI/180)}" y2="${cy+14*Math.sin(a*Math.PI/180)}"/>`).join("");
    const body = night
      ? `<path d="M${cx+5} ${cy-9}a10 10 0 1 0 4 17 9 9 0 0 1-4-17z" fill="#d9e2f0" stroke="#f2f6ff" stroke-width="1"/>`
      : `<circle cx="${cx}" cy="${cy}" r="8" fill="#ffd166"/><g stroke="#ffd166" stroke-width="2" stroke-linecap="round">${rays}</g>`;
    const cl = cloudy ? `<g><path d="M10 31h24.5a7 7 0 0 0 .4-14 10 10 0 0 0-18.7-2.5A8.5 8.5 0 0 0 10 31z" fill="rgba(224,231,241,${0.62 + 0.35 * Math.max(c, 0.35)})" stroke="rgba(255,255,255,.32)" stroke-width="1.2"/><path d="M13 29.5h20" stroke="rgba(167,181,200,.45)" stroke-width="1" stroke-linecap="round"/></g>` : "";
    const flakes = [16,24,32].map((x) => `<g transform="translate(${x} 39)" stroke="#dfe8ff" stroke-width="1.4" stroke-linecap="round"><path d="M-2.5 0h5M0-2.5v5M-1.8-1.8l3.6 3.6M1.8-1.8l-3.6 3.6"/></g>`).join("");
    const rn = wet ? (snow ? flakes : `<path d="M17 35l-2 4M25 35l-2 4M33 35l-2 4" stroke="#69b9ff" stroke-width="2.4" stroke-linecap="round"/>`) : "";
    return `<svg class="glyph" viewBox="0 0 46 46" aria-hidden="true">${c < 0.9 ? body : ""}${cl}${rn}</svg>`;
  };
  W_ICONS = { rise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v8M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4-4-4 4M16 18a4 4 0 0 0-8 0"/></svg>',
              set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/></svg>' };

  // A short written forecast built from the series. Rules only: every sentence
  // is read off the numbers, nothing is invented, and missing inputs simply
  // remove that sentence. This deliberately reads like a weather report, not
  // a row of database tags joined with middle dots.
  function summarise(d, sel) {
    // Anchored at now, not at the step being scrubbed. The numbers above it
    // follow the slider; this line is the standing answer to "what is coming",
    // and it rewriting itself every time you dragged the tape made it useless
    // as either.
    const s = d.series, U = W().units, at = (k) => new Date(d.valid[k]);
    const nowMs = Date.now();
    let i = d.valid.findIndex((v) => new Date(v).getTime() >= nowMs);
    if (i < 0) i = Math.min(sel, d.valid.length - 1);
    // The hour where the weather is, not where the browser is.
    const hourFmt = new Intl.DateTimeFormat("en-CA", U.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    const stamp = (dt) => { const o = {}; for (const x of hourFmt.formatToParts(dt)) o[x.type] = x.value;
      return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; };
    const clock = (dt) => U.time(dt).replace(":00", "");
    const partOf = (h) => (h < 6 ? "overnight" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night");
    // People say "tomorrow morning", not "Thu 08:00". Inside ten hours the
    // clock is more use than the word, so that is what it gives.
    const when = (k) => {
      const hrs = (at(k) - at(i)) / 3600e3;
      if (hrs <= 1.5) return "now";
      if (hrs <= 10) return `around ${clock(at(k))}`;
      const here = stamp(at(i)), there = stamp(at(k));
      const days = Math.round((new Date(there.day) - new Date(here.day)) / 86400e3);
      const part = partOf(there.hour);
      if (days <= 0) return part === "night" ? "tonight" : part === "overnight" ? "overnight" : `this ${part}`;
      if (days === 1) return part === "overnight" ? "overnight" : `tomorrow ${part}`;
      const wd = at(k).toLocaleDateString(undefined, U.timeOpts({ weekday: "long" }));
      return `${wd} ${part === "overnight" ? "night" : part}`;
    };

    const step = (d.steps[i + 1] || d.steps[i] + 3) - d.steps[i];
    const end = Math.min(d.steps.length - 1, i + Math.ceil(48 / step));
    const idx = Array.from({ length: end - i + 1 }, (_, k) => i + k);
    const val = (name, k) => (s[name] && s[name][k] != null ? s[name][k] : null);
    const rainAt = (k) => val("tp6", k) || 0, snowAt = (k) => val("sf6", k) || 0;
    const amountAt = (k) => rainAt(k) + snowAt(k);
    const wet = (k) => amountAt(k) > 0.2;
    const wetSteps = idx.filter(wet), damp = idx.filter((k) => amountAt(k) > 0.01);
    const lead = [], rest = [];

    // What it is doing right now: the sky, the temperature, and how it feels
    // if that differs enough to be worth a coat.
    const t0 = val("t2m", i), cc = val("tcc", i), w0 = val("wind", i), dp = val("d2m", i);
    const feelsAt = (k) => {
      const c = val("t2m", k) == null ? null : val("t2m", k) - 273.15, w = val("wind", k), dew = val("d2m", k);
      if (c == null) return null;
      if (w != null && c <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); return 13.12 + 0.6215 * c - 11.37 * v + 0.3965 * c * v; }
      if (dew != null && c >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / dew)); return c + 0.5555 * (e - 10); }
      return c;
    };
    if (t0 != null) {
      const sky = cc == null ? "" : cc > 0.85 ? "Overcast" : cc > 0.6 ? "Mostly cloudy" : cc > 0.3 ? "Partly cloudy" : "Clear";
      const feels = feelsAt(i), gap = Math.round(feels) - Math.round(t0 - 273.15);
      const felt = Math.abs(gap) >= 2 ? `, feels like ${U.tempC(feels).txt}` : "";
      // the character word a person would use before any number: muggy is the
      // dew point talking, crisp is a cold clear morning
      const tc = t0 - 273.15, dpc = dp != null ? dp - 273.15 : null;
      const character = dpc != null && dpc >= 18 && tc >= 22 ? "muggy"
        : tc <= 0 ? "cold" : tc <= 6 && (cc == null || cc < 0.4) ? "crisp"
        : tc >= 30 ? "hot" : "";
      lead.push(sky ? `${sky}${character ? ` and ${character}` : ""} at ${U.temp(t0).txt}${felt}.` : `${U.temp(t0).txt} right now${felt}.`);
    }

    // Precipitation, and — when the wind belongs to the same weather — the
    // gusts in the same breath, because that is one event, not two.
    const gusts = (s.gust || s.wind || []).slice(i, end + 1).map((v, k) => [v, i + k]).filter(([v]) => v != null);
    const peak = gusts.length ? gusts.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
    const windy = peak && peak[0] * 3.6 >= 35;
    const gustPhrase = () => `${s.gust ? "gusting" : "winds"} to ${Math.round(W().speed(peak[0]))} ${W().speedUnit()}`;
    let windSaid = false;
    if (s.tp6 || s.sf6) {
      const total = idx.reduce((a, k) => a + amountAt(k), 0);
      const much = total >= 1 ? `, ${U.precip(total).txt} of it` : "";
      if (wet(i)) {
        let k = i; while (k <= end && wet(k)) k++;
        const snow = snowAt(i) > rainAt(i), what = snow ? "Snow" : "Rain";
        const withWind = windy && peak[1] <= k ? `, ${gustPhrase()}` : "";
        if (withWind) windSaid = true;
        rest.push(k > end ? `${what} right through${much}${withWind}.` : `${what} easing ${when(k)}${much}${withWind}.`);
      } else if (wetSteps.length) {
        const first = wetSteps[0], snow = snowAt(first) > rainAt(first);
        const scattered = wetSteps.length <= Math.max(2, Math.ceil(idx.length * 0.35));
        rest.push(scattered ? `Mostly dry, ${snow ? "a little snow" : "a few showers"} ${when(first)}.`
                            : `Dry until ${when(first)}, then ${snow ? "snow moves in" : "rain moves in"}${much}.`);
      } else if (damp.length) {
        rest.push(`Dry, give or take ${snowAt(damp[0]) > rainAt(damp[0]) ? "a flurry" : "a stray shower"}.`);
      } else {
        rest.push((at(end) - at(i)) / 3600e3 >= 36 ? "Nothing falling for the next couple of days." : "Nothing falling through tomorrow.");
      }
    }
    if (windy && !windSaid) {
      const kmh = peak[0] * 3.6;
      rest.push(`${kmh >= 75 ? "Very windy" : kmh >= 55 ? "Windy" : "Breezy"}, ${gustPhrase()}${peak[1] > i + 1 ? ` ${when(peak[1])}` : ""}.`);
    }

    // Where the temperature goes, said once, with the time it gets there.
    if (s.t2m && t0 != null) {
      const vals = idx.map((k) => [val("t2m", k), k]).filter(([v]) => v != null);
      if (vals.length > 2) {
        const hi = vals.reduce((a, b) => (b[0] > a[0] ? b : a)), lo = vals.reduce((a, b) => (b[0] < a[0] ? b : a));
        const freezes = lo[0] - 273.15 <= 0 && t0 - 273.15 > 0;
        if (freezes) rest.push(`Below freezing ${when(lo[1])}.`);
        else if (hi[0] - t0 > 3) {
          const hic = hi[0] - 273.15;
          rest.push(`${hic >= 30 ? "Hot" : hic >= 24 ? "Warming up" : "Milder"} ${when(hi[1])}, up to ${U.temp(hi[0]).txt}.`);
        } else if (t0 - lo[0] > 3) rest.push(`Cooling to ${U.temp(lo[0]).txt} ${when(lo[1])}.`);
      }
    }

    // Two warnings nothing else carries.
    if (dp != null && t0 != null && t0 - dp < 1 && (w0 == null || w0 * 3.6 < 12)) rest.push("Air is sitting at its dew point, so expect fog.");
    const uvMax = Math.max(...idx.map((k) => val("uvi", k) ?? -1));
    if (uvMax >= 8) rest.push(`Strong sun, UV ${Math.round(uvMax)} by midday.`);

    return [...lead, ...rest.slice(0, 3)].join(" ");
  }

  // Two readings that only mean anything at sea. Both are the scales a mariner
  // actually uses, not a restatement of the numbers already on the card.
  const BEAUFORT = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const BEAUFORT_NAME = ["calm", "light air", "light breeze", "gentle breeze", "moderate breeze",
    "fresh breeze", "strong breeze", "near gale", "gale", "strong gale", "storm", "violent storm", "hurricane"];
  const beaufort = (ms) => { let f = 0; while (f < BEAUFORT.length && ms >= BEAUFORT[f]) f++; return f; };
  const DOUGLAS = [0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14];
  const DOUGLAS_NAME = ["calm", "rippled", "smooth", "slight", "moderate", "rough", "very rough", "high", "phenomenal"];
  const douglas = (m) => { let d = 0; while (d < DOUGLAS.length && m >= DOUGLAS[d]) d++; return d; };

  // METAR shorthand, spelled out. FU is smoke, BR is mist, VV is a vertical
  // visibility because the sky is not visible at all — none of it guessable,
  // so every token carries its meaning in a tooltip.
  const METAR_WORDS = {
    "-": "light", "+": "heavy", VC: "in the vicinity",
    MI: "shallow", PR: "partial", BC: "patches of", DR: "low drifting", BL: "blowing",
    SH: "showers of", TS: "thunderstorm", FZ: "freezing",
    DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals",
    PL: "ice pellets", GR: "hail", GS: "small hail", UP: "unknown precipitation",
    BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "widespread dust",
    SA: "sand", HZ: "haze", PY: "spray",
    PO: "dust whirls", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm",
    SKC: "sky clear", CLR: "clear below 12 000 ft", NSC: "no significant cloud", NCD: "no cloud detected",
    FEW: "few, 1–2 eighths", SCT: "scattered, 3–4 eighths", BKN: "broken, 5–7 eighths", OVC: "overcast, 8 eighths",
    VV: "vertical visibility, sky obscured", CB: "cumulonimbus", TCU: "towering cumulus",
  };
  // A token is an optional intensity, then two-letter pairs: -SHRA is light
  // showers of rain. Cloud groups are three letters and a height.
  function metarGloss(token) {
    const t = String(token || "").toUpperCase();
    const cloud = t.match(/^(SKC|CLR|NSC|NCD|FEW|SCT|BKN|OVC|VV)(\d{2,3})?(CB|TCU)?/);
    if (cloud) {
      const parts = [METAR_WORDS[cloud[1]]];
      if (cloud[2]) parts.push(`at ${Number(cloud[2]) * 100} ft`);
      if (cloud[3]) parts.push(METAR_WORDS[cloud[3]]);
      return parts.filter(Boolean).join(" ");
    }
    const words = [];
    let rest = t;
    if (rest[0] === "-" || rest[0] === "+") { words.push(METAR_WORDS[rest[0]]); rest = rest.slice(1); }
    if (rest.startsWith("VC")) { words.push(METAR_WORDS.VC); rest = rest.slice(2); }
    while (rest.length >= 2) { const w = METAR_WORDS[rest.slice(0, 2)]; if (!w) break; words.push(w); rest = rest.slice(2); }
    return words.length ? words.join(" ") : "";
  }
  const metarAbbr = (str) => String(str || "").split(/\s+/).filter(Boolean).map((tok) => {
    const gloss = metarGloss(tok);
    return gloss ? `<abbr title="${esc(gloss)}">${esc(tok)}</abbr>` : esc(tok);
  }).join(" ");

  // ── Now: hero, local context, station obs, meteogram ─────────────────
  function renderNow(pt, d, i) {
    const { speed, speedUnit, f, arrow } = W();
    const s = d.series;
    const t = s.t2m ? s.t2m[i] : null, night = (() => { const h = new Date(d.valid[i]).getHours(); return h < 6 || h >= 21; })();
    // today's hi/lo (same local calendar day as the shown step)
    const day = new Date(d.valid[i]).toDateString();
    const todays = d.valid.map((v, k) => k).filter((k) => new Date(d.valid[k]).toDateString() === day && s.t2m && s.t2m[k] != null);
    const hi = todays.length ? Math.max(...todays.map((k) => s.t2m[k])) - K : null, lo = todays.length ? Math.min(...todays.map((k) => s.t2m[k])) - K : null;
    const chips = [];
    if (s.wind) chips.push(`<span class="wind-readout" style="--wind-color:${windColor(s.wind[i] || 0)}">
      <span class="wind-arrow">${f(s.wdir && s.wdir[i], arrow)}</span>
      <span class="wind-main"><small>Wind ${compass(s.wdir && s.wdir[i])}</small><b>${f(s.wind[i], (v) => speed(v).toFixed(0))} <i>${speedUnit()}</i></b></span>
      ${s.gust && s.gust[i] != null ? `<span class="wind-gust"><small>Gusts</small><b>${speed(s.gust[i]).toFixed(0)} <i>${speedUnit()}</i></b></span>` : ""}
      <span class="wind-storm" id="storm-slot"></span>
    </span>`);
    // Which readings are worth the space depends on where the pin landed. A
    // snow depth of zero in August tells you nothing; wave height does, if you
    // clicked the sea. So: a value that is only news when it is non-zero stays
    // hidden at zero, and the marine readings lead over water while the
    // land-only ones step aside.
    const sea = !!(pt.local && pt.local.place && pt.local.place.water);
    const marine = [], normal = [];
    if (sea && s.wind && s.wind[i] != null) { const bf = beaufort(s.wind[i]);
      marine.push(`<span class="chipv" style="color:#8ec5f0">force <b>${bf}</b> ${BEAUFORT_NAME[bf]}</span>`); }
    if (sea && s.swh && s.swh[i] != null) { const ds = douglas(s.swh[i]);
      marine.push(`<span class="chipv" style="color:#7dd3fc">sea <b>${ds}</b> ${DOUGLAS_NAME[ds]}</span>`); }
    if (s.swh && s.swh[i] != null) marine.push(`<span class="chipv" style="color:#7dd3fc">〜 <b>${W().units.alt(s.swh[i], 1).v}</b> ${W().units.altUnit}${s.mwp && s.mwp[i] != null ? ` · ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` · ${arrow((s.mwd[i] + 180) % 360)}` : ""}</span>`);
    if (s.tp6 && s.tp6[i] > 0.05) normal.push(`<span class="chipv" style="color:var(--rain)"><b>${W().units.precip(s.tp6[i]).v}</b> ${W().units.precipUnit}/6h</span>`);
    // Chance, from the GEFS members, whichever model the card is reading:
    // the max over the next 24 h from the selected time, only when it says
    // something (a 3 % chance is not a pill).
    const chance = probMax(pt, d, i, "prob_rain", 24);
    if (chance != null && chance >= 10) normal.push(`<span class="chipv" style="color:#71b8ff" title="Share of the 30 GEFS members giving rain in the next 24 h">rain chance <b>${chance}%</b></span>`);
    const gustChance = probMax(pt, d, i, "prob_gust", 24);
    if (gustChance != null && gustChance >= 20) normal.push(`<span class="chipv" style="color:#ffb454" title="Share of members with gusts over 50 km/h in the next 24 h">gale chance <b>${gustChance}%</b></span>`);
    if (s.sf6 && s.sf6[i] > 0.05) normal.push(`<span class="chipv" style="color:#cfe8ff"><b>${W().units.snow(s.sf6[i]).v}</b> ${W().units.snowUnit} snow</span>`);
    if (!sea && s.sd_cm && s.sd_cm[i] >= 0.5) normal.push(`<span class="chipv" style="color:#9fd3ff">depth <b>${W().units.snow(s.sd_cm[i]).v}</b> ${W().units.snowUnit}</span>`);
    if (s.tcc && s.tcc[i] != null) normal.push(`<span class="chipv" style="color:#9fb0c8">☁ <b>${(s.tcc[i] * 100).toFixed(0)}</b>%</span>`);
    if (s.d2m) normal.push(`<span class="chipv" style="color:#6cd7c4">dew <b>${f(s.d2m[i], (v) => W().units.temp(v).v)}°</b>${s.t2m && s.t2m[i] != null && s.d2m[i] != null ? ` · RH ${Math.round(100 * Math.exp(17.625 * (s.d2m[i] - K) / (243.04 + s.d2m[i] - K)) / Math.exp(17.625 * (s.t2m[i] - K) / (243.04 + s.t2m[i] - K)))}%` : ""}</span>`);
    // Pressure with its direction: the number alone says nothing, the trend is
    // the whole reason a barometer is on the wall.
    if (s.msl) {
      const later = s.msl[Math.min(i + Math.max(1, Math.round(6 / stepHrs(d, i))), s.msl.length - 1)];
      const dP = later != null && s.msl[i] != null ? (later - s.msl[i]) / 100 : 0;
      const trend = Math.abs(dP) < 1 ? "" : dP > 0 ? " ↗" : " ↘";
      // the glass as a curve, not just an arrow: 24 h of pressure in a
      // 44px sparkline drawn inline, scaled to its own min-max
      const win = []; for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) if (s.msl[k] != null) win.push(s.msl[k]);
      let spark = "";
      if (win.length >= 4) {
        const mn = Math.min(...win), mx = Math.max(...win), span = Math.max(mx - mn, 60);
        const pts = win.map((v, k) => `${(k / (win.length - 1) * 44).toFixed(1)},${(11 - (v - mn) / span * 10).toFixed(1)}`).join(" ");
        spark = `<svg class="pspark" viewBox="0 0 44 12" aria-hidden="true"><polyline points="${pts}"/></svg>`;
      }
      normal.push(`<span class="chipv" style="color:#b7a6f0"><b>${f(s.msl[i], (v) => W().units.press(v).v)}</b> ${W().units.pressUnit}${trend}${spark}</span>`);
    }
    // What it feels like, when that is not what the thermometer says.
    if (t != null) {
      const c = t - K, w = s.wind ? s.wind[i] : null, dpK = s.d2m ? s.d2m[i] : null;
      let feels = c;
      if (w != null && c <= 10 && w * 3.6 >= 4.8) { const q = Math.pow(w * 3.6, 0.16); feels = 13.12 + 0.6215 * c - 11.37 * q + 0.3965 * c * q; }
      else if (dpK != null && c >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / dpK)); feels = c + 0.5555 * (e - 10); }
      if (Math.abs(Math.round(feels) - Math.round(c)) >= 2)
        normal.push(`<span class="chipv" style="color:${tempColor(feels)}">feels <b>${W().units.tempC(feels).v}°</b></span>`);
    }
    // Cloud base from the temperature/dew-point spread: ~125 m per °C. Only
    // worth saying when there is cloud to have a base.
    if (!sea && s.tcc && s.tcc[i] > 0.2 && s.d2m && s.d2m[i] != null && t != null) {
      const spread = (t - s.d2m[i]);
      if (spread > 0.3 && spread < 25) normal.push(`<span class="chipv" style="color:#a9c4d8">base ≈ <b>${W().units.alt(Math.round(spread * 125 / 50) * 50).v}</b> ${W().units.altUnit}</span>`);
    }
    if (s.cape && s.cape[i] >= 100) normal.push(`<span class="chipv" style="color:${s.cape[i] > 1000 ? "var(--bad)" : "var(--warm)"}">CAPE <b>${s.cape[i].toFixed(0)}</b> J/kg</span>`);
    const freezing = d.derived && d.derived.freezing_level_m && d.derived.freezing_level_m[i];
    if (!sea && freezing != null) normal.push(`<span class="chipv" style="color:#7fd8e8">freezing <b>${W().units.alt(freezing).v}</b> ${W().units.altUnit}</span>`);
    chips.push(...(sea ? [...marine, ...normal] : [...normal, ...marine]));
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    const moon = moonPhase(W().validDate);
    $("#point-now").innerHTML = `<div class="hero">
        ${bigGlyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), t, night)}
        <div class="big" style="color:${t != null ? tempColor(t - K) : "inherit"}">${t == null ? "—" : W().units.temp(t).v}<span class="deg">°</span></div>
        <div class="hl">
          ${hi != null ? `<div class="hilo"><span class="hi"><i>high</i>${W().units.tempC(hi).v}°</span><span class="rule"></span><span class="lo"><i>low</i>${W().units.tempC(lo).v}°</span></div>` : ""}
          ${sun ? `<div class="sun"><span>${W_ICONS.rise}${sun.rise}</span><span>${W_ICONS.set}${sun.set}</span><i class="brk" aria-hidden="true"></i>${sun.len ? `<span class="len">${sun.len} of daylight</span>` : ""}<span class="moon" title="${moon.name}, ${moon.pct}% lit">${moon.glyph} ${moon.pct}%</span></div>` : ""}
        </div>
      </div>
      ${(() => { const t = summarise(d, i); return t ? `<p class="summary"><i>next 48 h</i>${t}${window.WXStatic ? "" : `<button class="why-btn" id="why-btn">Discussion ›</button>`}</p><div id="why" class="why" hidden></div>` : ""; })()}
      <div class="meta">${chips.join("")}</div>
      ${daysStrip(pt, d, i)}
      ${alertsHtml(pt)}${airHtml(pt)}`;
    fetchNearStorm(pt);
    // local context
    const loc = pt.local || {};
    const bits = [];
    // Join only the parts that exist. A country with no region above it used to
    // print a leading "· SE" — a separator dangling off nothing.
    const where = [];
    if (loc.place && loc.place.name && loc.place.name !== pt.name) where.push(`<b>${esc(loc.place.name)}</b>${loc.place.region ? ", " + esc(loc.place.region) : ""}`);
    else if (loc.place && loc.place.region) where.push(esc(loc.place.region));
    if (loc.place && loc.place.country) where.push(esc(loc.place.country));
    if (where.length) bits.push(`<span>${where.join(" · ")}</span>`);
    if (loc.elevation_m != null) bits.push(`<span>elev <b>${W().units.alt(loc.elevation_m).txt}</b></span>`);
    if (W().units.followsPoint && loc.timezone && loc.timezone.abbr) bits.push(`<span>${esc(loc.timezone.abbr)}</span>`);
    // the title already carries the coordinates when there is no place name —
    // don't print them twice
    const coords = W().fmtCoords(pt.lat, pt.lon);
    const titled = ($("#point-title").textContent || "").trim();
    $("#point-local").innerHTML = bits.length ? bits.join('<span class="sep">·</span>') : (titled === coords ? "" : coords);
    // station observation
    let obsHtml = "";
    const o = pt.obs && pt.obs.metar;
    if (o) {
      const tm = o.time ? new Date(o.time) : null;
      const cl = (o.clouds || []).map((c) => `${c.cover}${c.base != null ? "@" + W().units.alt(c.base / 3.28084).txt : ""}`).join(" ");
      const obsDist = o.distance_km != null ? W().units.dist(o.distance_km).txt : "";
      const obsVis = o.visib != null ? W().units.dist(o.visib * 1.609344).txt : "";
      // Station first, because that is the subject; the pill sits on its line
      // instead of drifting to the end of a wrap; time and distance are the
      // caveat under it, not part of the title.
      obsHtml = `<div class="obs">
        <div class="obs-head"><span class="stn"><b>${esc(o.station)}</b>${o.name ? `<span class="nm">${esc(o.name)}</span>` : ""}</span>${o.flight_category ? `<span class="fc ${esc(o.flight_category)}">${esc(o.flight_category)}</span>` : ""}</div>
        <div class="obs-when">Observed <b>${tm ? W().units.time(tm) : "—"}</b>${obsDist ? `<span>${obsDist} away</span>` : ""}</div>
        <div class="obs-vals">${[
          o.temp_c != null ? `<b style="color:${tempColor(o.temp_c)}">${W().units.tempC(o.temp_c).v}°</b><u>${W().units.tempUnit.replace("°", "")}</u>` : "",
          o.dewpoint_c != null ? `<i>dew</i><b>${W().units.tempC(o.dewpoint_c).v}°</b>` : "",
          o.wspd_kt != null ? `<b>${speed(o.wspd_kt / 1.943844).toFixed(0)}</b><u>${speedUnit()}</u>${o.wdir != null && o.wdir !== 0 ? `<i>@</i><b>${String(o.wdir).padStart(3, "0")}°</b>` : `<i>calm</i>`}${o.wgst_kt ? `<i>gusts</i><b>${speed(o.wgst_kt / 1.943844).toFixed(0)}</b>` : ""}` : "",
          obsVis ? `<i>vis</i><b>${obsVis}</b>` : "",
          o.altim_hpa != null ? `<i>QNH</i><b>${W().units.press(o.altim_hpa * 100).v}</b><u>${W().units.pressUnit}</u>` : "",
          cl ? `<span class="codes">${metarAbbr(cl)}</span>` : "",
          o.wx ? `<span class="codes">${metarAbbr(o.wx)}</span>` : "",
        ].filter(Boolean).map((h) => `<span>${h}</span>`).join("")}</div>
        <div class="raw">${esc(o.raw || "")}</div></div>`;
    }
    let holder = $("#obs-holder");
    if (!holder) { holder = document.createElement("div"); holder.id = "obs-holder"; $("#point-now").after(holder); }
    holder.innerHTML = obsHtml;
    drawMeteogram(d, i);
  }

  // One cell per local calendar day. A short physics run hands only this strip
  // to AI-GFS after its last complete day; the primary series and every other
  // pane remain the model the user selected.
  // Max of a probability series over the `hours` after the card's selected
  // valid time. The probabilities live on the GEFS run's own clock, which is
  // not the viewed model's clock, so match by time and not by index.
  function probMax(pt, d, i, key, hours) {
    const p = pt && pt.prob; if (!p || !p.series[key] || !d.valid[i]) return null;
    const t0 = new Date(d.valid[i]).getTime(), t1 = t0 + hours * 3600e3;
    let best = null;
    p.valid.forEach((iso, k) => {
      const t = new Date(iso).getTime(), v = p.series[key][k];
      if (t > t0 && t <= t1 && v != null && (best === null || v > best)) best = v;
    });
    return best === null ? null : Math.round(best);
  }

  // Moon phase from the synodic month: age in days since a known new moon.
  // A tenth of a day of error is a sliver of shading nobody can see.
  function moonPhase(date) {
    const synodic = 29.530588853;
    const age = (((date - new Date(Date.UTC(2000, 0, 6, 18, 14))) / 86400e3) % synodic + synodic) % synodic;
    const pct = Math.round((1 - Math.cos(2 * Math.PI * age / synodic)) / 2 * 100);
    const k = Math.round(age / synodic * 8) % 8;
    return { pct,
      glyph: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"][k],
      name: ["new moon", "waxing crescent", "first quarter", "waxing gibbous",
             "full moon", "waning gibbous", "last quarter", "waning crescent"][k] };
  }

  // The discussion: which system is driving and why — fetched on the first
  // ask, cached on the point, plain sentences from the server's field brain.
  function wireWhy(pt) {
    const btn = $("#why-btn"), box = $("#why");
    if (!btn || !box) return;
    btn.onclick = async () => {
      if (!box.hidden) { box.hidden = true; btn.textContent = "Discussion ›"; return; }
      btn.textContent = "…";
      try {
        if (!pt.why) pt.why = await W().api(`${W().API}/discussion?lat=${pt.lat.toFixed(2)}&lon=${W().wlon(pt.lon).toFixed(2)}&model=${W().state.model}`);
        box.innerHTML = pt.why.paras.map((p) => `<p>${esc(p)}</p>`).join("") || "<p>Nothing notable driving the weather here right now.</p>";
        box.hidden = false; btn.textContent = "Discussion ˅";
      } catch (e) { btn.textContent = "Discussion ›"; W().fn.toast("Discussion unavailable", 3000, "error"); }
    };
  }

  function daysStrip(pt, d, i) {
    const s = d.series; if (!s.t2m) return "";
    const primaryModel = d.model || W().state.model;
    const days = new Map();
    const addDays = (src, model, ai, after = -Infinity, exclude = new Set()) => {
      if (!src || !src.series || !src.series.t2m) return;
      src.valid.forEach((v, k) => {
        const dt = new Date(v), key = dt.toDateString();
        if (dt.getTime() <= after || exclude.has(key)) return;
        if (!days.has(key)) days.set(key, { dt, ks: [], src, model, ai });
        days.get(key).ks.push(k);
      });
    };
    addDays(d, primaryModel, false);
    const primaryKeys = new Set(days.keys());
    const primaryEnd = Math.max(...d.valid.map((v) => new Date(v).getTime()));
    if (pt.ai && pt.ai.model === "aigfs") addDays(pt.ai, "aigfs", true, primaryEnd, primaryKeys);
    const cur = new Date(d.valid[i]).toDateString();
    const usable = [...days.values()].filter(({ src, ks }) => ks.filter((k) => src.series.t2m[k] != null).length >= 2).slice(0, 16);
    const cells = usable.map(({ dt, ks, src, model, ai }) => {
      const s = src.series;
      const ts = ks.map((k) => s.t2m[k]).filter((x) => x != null);
      const hi = Math.max(...ts) - K, lo = Math.min(...ts) - K;
      const rain = ks.reduce((a, k) => a + ((s.tp6 && s.tp6[k]) || 0), 0), snow = ks.reduce((a, k) => a + ((s.sf6 && s.sf6[k]) || 0), 0);
      const wmax = s.wind ? Math.max(...ks.map((k) => s.wind[k] || 0)) : null;
      const noon = ks.reduce((b, k) => Math.abs(new Date(src.valid[k]).getHours() - 13) < Math.abs(new Date(src.valid[b]).getHours() - 13) ? k : b, ks[0]);
      const cloud = ks.map((k) => s.tcc ? s.tcc[k] : null).filter((x) => x != null); const cl = cloud.length ? cloud.reduce((a, b) => a + b, 0) / cloud.length : null;
      const g = W().tape && W().tape.glyph ? W().tape.glyph(cl, (rain + snow) / Math.max(1, ks.length) * (24 / 6), s.t2m[noon], false) : "";
      const on = model === primaryModel && dt.toDateString() === cur;
      const wet = snow >= 1 ? `<span class="sn">${W().units.snow(snow).txt}</span>` : rain >= 0.5 ? W().units.precip(rain).txt : "";
      return `<button class="day${on ? " on" : ""}${ai ? " ai" : ""}" data-k="${noon}" data-model="${model}" data-valid="${src.valid[noon]}" title="${dt.toDateString()}${ai ? " · NOAA AI-GFS" : ""}">
        <span class="dn">${dt.toLocaleDateString(undefined, { weekday: "short" })}${ai ? `<i>AI</i>` : ""}</span>
        <span class="dg">${g}</span>
        <span class="hl"><b style="color:${tempColor(hi)}">${W().units.tempC(hi).v}°</b><i>${W().units.tempC(lo).v}°</i></span>
        <span class="pr">${wet || "&nbsp;"}</span>
        ${wmax != null ? `<span class="wd" style="background:${W().rampColor("wind", wmax, 0.55)}">${Math.round(W().speed(wmax))}<em>${W().speedUnit()}</em></span>` : ""}</button>`;
    }).join("");
    setTimeout(() => { wireWhy(pt); }, 0);
    setTimeout(() => document.querySelectorAll(".days .day").forEach((b) => b.onclick = () => {
      if (b.dataset.model !== W().state.model) W().fn.jumpModelTime(b.dataset.model, b.dataset.valid);
      else W().setStep(Number(b.dataset.k));
      // the tape follows the day: scroll its selected column into the middle
      setTimeout(() => { const on = document.querySelector("#tape td.on"); if (on) on.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }); }, 60);
    }), 0);
    const extended = usable.filter((x) => x.ai);
    let note = "";
    if (extended.length) {
      const first = extended[0].dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      note = `<div class="days-note"><b>AI-GFS</b> generated forecast from ${first}</div>`;
    }
    return `<i class="kicker">week ahead</i><div class="days${usable.length > 8 ? " extended" : ""}">${cells}</div>${note}`;
  }

  const AQI_BANDS = [[50, "Good", "#2f9e44"], [100, "Moderate", "#e6b800"], [150, "Unhealthy for sensitive", "#f08c00"], [200, "Unhealthy", "#e03131"], [300, "Very unhealthy", "#9c36b5"], [9999, "Hazardous", "#7f1d1d"]];
  const aqiBand = (v) => AQI_BANDS.find((b) => v <= b[0]) || AQI_BANDS[AQI_BANDS.length - 1];
  const uvBand = (v) => v < 3 ? ["Low", "#2f9e44"] : v < 6 ? ["Moderate", "#e6b800"] : v < 8 ? ["High", "#f08c00"] : v < 11 ? ["Very high", "#e03131"] : ["Extreme", "#9c36b5"];
  function airHtml(pt) {
    const a = pt.air;
    if (!a || [a.us_aqi, a.eu_aqi, a.pm2_5, a.pm10, a.ozone, a.no2, a.uv, a.uv_clear].every((v) => v == null)) return "";
    const b = a.us_aqi != null ? aqiBand(a.us_aqi) : null;
    const uvValues = a.hourly && a.hourly.uv ? a.hourly.uv.slice(0, 24).filter((x) => x != null) : [];
    const uvMax = uvValues.length ? Math.max(...uvValues) : null;
    const uvb = uvMax != null ? uvBand(uvMax) : null;
    return `<div class="air">${b ? `<span class="chipv" style="background:${b[2]}22;color:${b[2]}"><i class="sw" style="background:${b[2]}"></i>US AQI <b>${a.us_aqi}</b> ${b[1]}</span>` : ""}
      ${a.eu_aqi != null ? `<span class="chipv" style="color:#8fd6a8">EU AQI <b>${a.eu_aqi}</b></span>` : ""}
      ${a.pm2_5 != null ? `<span class="chipv" style="color:#e0b57a">PM2.5 <b>${a.pm2_5.toFixed(0)}</b> µg/m³</span>` : ""}${a.pm10 != null ? `<span class="chipv" style="color:#d8a06a">PM10 <b>${a.pm10.toFixed(0)}</b> µg/m³</span>` : ""}
      ${a.ozone != null ? `<span class="chipv" style="color:#8ec7f0">O₃ <b>${a.ozone.toFixed(0)}</b> µg/m³</span>` : ""}${a.no2 != null ? `<span class="chipv" style="color:#d79ac0">NO₂ <b>${a.no2.toFixed(0)}</b> µg/m³</span>` : ""}
      ${a.uv != null ? `<span class="chipv" style="color:#f0c46a">UV now <b>${a.uv.toFixed(1)}</b></span>` : ""}${a.uv_clear != null ? `<span class="chipv" style="color:#f0c46a">clear-sky UV <b>${a.uv_clear.toFixed(1)}</b></span>` : ""}
      ${uvb ? `<span class="chipv" style="color:${uvb[1]}">UV max <b>${uvMax.toFixed(0)}</b> ${uvb[0]}</span>` : ""}</div>`;
  }
  // An alert opens where its text is: in the card. Only the services that
  // publish a readable page get a link out; the ones that publish an API
  // document used to send the reader to raw CAP JSON.
  function alertsHtml(pt) {
    const al = pt.alerts; if (!al || !al.length) return "";
    // The CAP headline restates the event name, both timestamps and the
    // office in one breathless sentence — everything it says is already on
    // the card in structured form, so it stays out of the summary.
    const fmtT = (d) => d.toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }));
    const when = (a) => { const o = a.onset ? new Date(a.onset) : null, e = a.ends ? new Date(a.ends) : null;
      return o && e ? `${fmtT(o)} → ${fmtT(e)}` : e ? `until ${fmtT(e)}` : ""; };
    // who issued it, as a compact monogram (real marks are trademarks; the
    // private theme can dress this up the way it does the provider badge)
    const AGENCY = { NWS: ["NWS", "#1a5fb4"], EC: ["ECCC", "#c8102e"], ECCC: ["ECCC", "#c8102e"],
                     MeteoAlarm: ["EU", "#e8850c"], BoM: ["BOM", "#00205b"], BOM: ["BOM", "#00205b"] };
    const agency = (a) => AGENCY[a.source] || (a.source ? [a.source, "var(--dim)"] : null);
    const head = (a) => { const ag = agency(a);
      return `<span class="al-row"><i class="dot"></i><b>${esc(a.event)}</b>${a.severity ? `<em class="sev">${esc(a.severity)}</em>` : ""}</span>
      <span class="al-meta">${ag ? `<i class="al-ag" style="--ag:${ag[1]}">${esc(ag[0])}</i>` : ""}${[when(a), a.sender || (a.area || "").slice(0, 60)].filter(Boolean).map(esc).join(" · ")}</span>`; };
    const body = (a) => {
      const now = Date.now();
      const o = a.onset ? new Date(a.onset).getTime() : null, e = a.ends ? new Date(a.ends).getTime() : null;
      const left = e && e > now ? (e - now < 3600e3 ? `ends in ${Math.max(1, Math.round((e - now) / 60e3))} min` : `ends in ${Math.round((e - now) / 3600e3)} h`) : e ? "expired" : "";
      const frac = o && e && e > o ? Math.min(1, Math.max(0, (now - o) / (e - o))) : null;
      const pills = [a.severity, a.urgency, a.certainty].filter(Boolean)
        .map((x) => `<i class="al-pill">${esc(x)}</i>`).join("");
      const areas = (a.area || "").split(";").map((x) => x.trim()).filter(Boolean).slice(0, 8)
        .map((x) => `<i class="al-area">${esc(x)}</i>`).join("");
      const desc = (a.description || "").trim();
      const instr = (a.instruction || "").trim();
      return `<div class="alert-x">
        <div class="al-pills">${pills}${left ? `<i class="al-pill al-left">${left}</i>` : ""}</div>
        ${frac != null ? `<div class="al-line" title="how far through its window this alert is"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>` : ""}
        ${areas ? `<div class="al-areas">${areas}</div>` : ""}
        ${desc ? `<div class="alert-text selectable">${esc(desc)}</div>` : ""}
        ${instr ? `<div class="al-instr"><b>What to do</b><div class="alert-text selectable">${esc(instr)}</div></div>` : ""}
      </div>`;
    };
    return `<div class="alerts">${al.slice(0, 3).map((a) => (a.url
      ? `<a class="alert" href="${esc(a.url)}" target="_blank" rel="noopener" style="--al:${esc(a.color)}">${head(a)}</a>`
      : `<details class="alert" style="--al:${esc(a.color)}"><summary>${head(a)}</summary>${body(a)}</details>`)).join("")}${al.length > 3 ? `<div class="note">+${al.length - 3} more</div>` : ""}</div>`;
  }

  // NOAA sunrise/sunset (good to a minute or two), shown in the viewer's clock.
  function sunTimes(lat, lon, date) {
    const rad = Math.PI / 180;
    const day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
    const calc = (rising) => {
      const lngHour = lon / 15;
      const t = day + ((rising ? 6 : 18) - lngHour) / 24;
      const M = 0.9856 * t - 3.289;
      let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634; L = (L + 360) % 360;
      let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = (RA + 360) % 360;
      RA += (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90); RA /= 15;
      const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
      const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
      if (cosH > 1 || cosH < -1) return null;
      let H = rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad; H /= 15;
      const T = H + RA - 0.06571 * t - 6.622;
      return ((T - lngHour) % 24 + 24) % 24;   // UTC hours
    };
    const r = calc(true), s = calc(false);
    if (r == null || s == null) return null;
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const fmt = (h) => new Date(base + h * 3600e3).toLocaleTimeString(undefined, W().units.timeOpts({ hour: "numeric", minute: "2-digit" }));
    const len = ((s - r + 24) % 24);
    return { rise: fmt(r), set: fmt(s), riseUtc: r, setUtc: s,
             len: `${Math.floor(len)}h${String(Math.round((len % 1) * 60)).padStart(2, "0")}` };
  }

  // ── Aloft ─────────────────────────────────────────────────────────────
  function renderAloft(d, i) {
    const { speed, speedUnit, f, arrowRot, LEVEL_FT, LEVEL_M } = W();
    const rows = (d.levels || []).slice().sort((a, b) => b - a).map((lvl) => {
      const a = d.aloft[String(lvl)];
      const gh = a.gh && a.gh[i] != null ? a.gh[i] : null;
      return `<tr><td class="lvl">${lvl} <i class="u">hPa</i></td><td>${gh != null ? W().units.alt(gh).txt : (W().units.altUnit === "ft" ? LEVEL_FT[lvl] : LEVEL_M[lvl])}</td>
        <td class="dir">${a.wdir[i] != null ? `<i style="${arrowRot(a.wdir[i])}"></i>${String(a.wdir[i]).padStart(3, "0")}°` : "—"}</td>
        <td><span class="wchip" style="background:${windColor(a.wind[i] || 0)}">${f(a.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}</td>
        <td class="tempc" style="color:${a.temp[i] != null ? tempColor(a.temp[i] - K) : "inherit"}">${f(a.temp[i], (v) => W().units.temp(v).v)}°</td></tr>`;
    }).join("");
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const sfc = s.wind ? `<tr><td class="mono">sfc</td><td>${W().units.alt(10).txt}</td><td class="dir">${s.wdir[i] != null ? `<i style="${arrowRot(s.wdir[i])}"></i>${String(s.wdir[i]).padStart(3, "0")}°` : "—"}</td><td><span class="wchip" style="background:${windColor(s.wind[i] || 0)}">${f(s.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}${s.gust ? ` <span class="dim">gusts ${f(s.gust[i], (v) => speed(v).toFixed(0))}</span>` : ""}</td><td class="tempc" style="color:${s.t2m && s.t2m[i] != null ? tempColor(s.t2m[i] - K) : "inherit"}">${f(s.t2m && s.t2m[i], (v) => W().units.temp(v).v)}°</td></tr>` : "";
    $("#aloft").innerHTML = `<table class="aloft"><thead><tr><th>Level</th><th>Height</th><th>Dir</th><th>Speed</th><th>Temp</th></tr></thead><tbody>${rows}${sfc}</tbody></table>
      <dl class="kv">
        <dt>Freezing level</dt><dd>${fl != null ? W().units.alt(fl).txt : (d.levels && d.levels.length ? "below 925 hPa or above 250" : "—")}</dd>
        <dt>Total cloud</dt><dd>${f(s.tcc && s.tcc[i], (v) => (v * 100).toFixed(0) + "%")}</dd>
        <dt>CAPE</dt><dd class="${capeClass(s.cape && s.cape[i])}">${f(s.cape && s.cape[i], (v) => v.toFixed(0) + " J/kg")}${s.cape ? "" : " <span class=dim>(model has none)</span>"}</dd>
        <dt>QNH (MSL)</dt><dd>${f(s.msl && s.msl[i], (v) => W().units.press(v, W().units.pressUnit === "hPa" ? 1 : undefined).txt)}</dd>
        <dt>Dew point spread</dt><dd>${s.d2m && s.t2m && s.t2m[i] != null && s.d2m[i] != null ? W().units.tempDelta(s.t2m[i] - s.d2m[i]).toFixed(1) + " " + W().units.tempUnit : "—"}</dd>
      </dl>
      ${tafHtml()}
      <div class="note">Gridpoint winds, true direction, FROM. Heights are geopotential.</div>`;
  }
  const capeClass = (v) => v == null ? "" : v < 300 ? "good" : v < 1000 ? "meh" : "bad";
  function tafHtml() {
    const pt = W().state.point; const t = pt && pt.obs && pt.obs.taf;
    if (!t) return "";
    return `<div class="obs"><div class="obs-head"><span>TAF · ${esc(t.station)}</span><span>${t.issue ? new Date(t.issue).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}</span></div><div class="raw">${esc(t.raw || "")}</div></div>`;
  }

  // ── Airgram: time × level, cells coloured by temperature, arrows for wind
  function renderAirgram(d, i) {
    const c = $("#airgram"), ctx = c.getContext("2d");
    const { speed, speedUnit } = W();
    const W_ = c.width, H = c.height, padL = 44, padR = 8, padT = 8, padB = 22;
    ctx.clearRect(0, 0, W_, H);
    const levels = (d.levels || []).slice().sort((a, b) => b - a);   // 925 bottom → 250 top
    const rows = [...levels.map((l) => ({ key: String(l), label: `${l}` })), ];
    if (d.series.wind) rows.unshift({ key: "sfc", label: "sfc" });
    const n = Math.min(d.steps.length, 28);                           // 7 days is enough on a phone
    if (!rows.length) { $("#airgram-note").textContent = "No pressure-level data in this run."; return; }
    const cw = (W_ - padL - padR) / n, rh = (H - padT - padB) / rows.length;
    const tcol = (tK) => { const t = tK - K; const stops = [[-50, [70, 30, 120]], [-30, [50, 80, 200]], [-15, [40, 150, 220]], [0, [100, 200, 200]], [10, [110, 210, 110]], [20, [240, 220, 80]], [30, [240, 130, 40]], [40, [200, 30, 30]]]; let a = stops[0], b = stops[stops.length - 1]; for (let k = 0; k < stops.length - 1; k++) if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; } const q = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0] || 1))); return `rgb(${a[1].map((x, k) => Math.round(x + (b[1][k] - x) * q)).join(",")})`; };
    ctx.font = "600 10px 'Geist Mono', ui-monospace, monospace"; ctx.textBaseline = "middle";
    rows.forEach((r, ri) => {
      const y = padT + (rows.length - 1 - ri) * rh;
      ctx.fillStyle = "#8b93a1"; ctx.textAlign = "right"; ctx.fillText(r.label, padL - 6, y + rh / 2);
      for (let k = 0; k < n; k++) {
        const x = padL + k * cw;
        const t = r.key === "sfc" ? (d.series.t2m ? d.series.t2m[k] : null) : d.aloft[r.key].temp[k];
        const spd = r.key === "sfc" ? d.series.wind[k] : d.aloft[r.key].wind[k];
        const dir = r.key === "sfc" ? d.series.wdir[k] : d.aloft[r.key].wdir[k];
        if (t != null) { ctx.fillStyle = tcol(t); ctx.globalAlpha = 0.85; ctx.fillRect(x + 0.5, y + 0.5, cw - 1, rh - 1); ctx.globalAlpha = 1; }
        if (spd != null && dir != null) {
          const len = Math.min(rh, cw) * 0.36 * Math.min(1, 0.4 + spd / 25);
          const ang = (dir + 180) * Math.PI / 180;               // TO direction, screen y down: north = up
          const cx = x + cw / 2, cy = y + rh / 2;
          const dx = Math.sin(ang) * len, dy = -Math.cos(ang) * len;
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + dx, cy + dy); ctx.lineTo(cx + dx - Math.sin(ang - 0.5) * 4, cy + dy + Math.cos(ang - 0.5) * 4); ctx.moveTo(cx + dx, cy + dy); ctx.lineTo(cx + dx - Math.sin(ang + 0.5) * 4, cy + dy + Math.cos(ang + 0.5) * 4); ctx.stroke();
          if (cw > 20) { ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.textAlign = "center"; ctx.font = "700 9px 'Geist Mono', ui-monospace, monospace"; ctx.fillText(String(Math.round(speed(spd))), cx, y + rh - 6); ctx.font = "600 10px 'Geist Mono', ui-monospace, monospace"; }
        }
      }
    });
    // day ticks + selected step
    ctx.fillStyle = "#8b93a1"; ctx.textAlign = "left"; let lastDay = null;
    d.valid.slice(0, n).forEach((iso, k) => { const dt = new Date(iso), day = dt.toDateString(); if (day !== lastDay) { lastDay = day; ctx.fillRect(padL + k * cw, padT, 1, H - padT - padB); ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), padL + k * cw + 3, H - 8); } });
    if (i < n) { ctx.strokeStyle = "#6cb6ff"; ctx.lineWidth = 2; ctx.strokeRect(padL + i * cw + 1, padT + 1, cw - 2, H - padT - padB - 2); }
    $("#airgram-note").textContent = `Rows are pressure levels, colour is temperature, arrows are wind in ${speedUnit()}.`;
  }

  // ── Winter: new snow, snow depth, levels, wind loading, avalanche forecast
  // ── the elevation board ───────────────────────────────────────────────
  // Bands down, time across. A 0.25° gridpoint gives one number for a valley
  // and the ridge above it; /api/profile interpolates the column, so each band
  // can report what actually falls at ITS height. That difference — 20 cm on
  // top, a wet afternoon at the car park — is the entire reason this view
  // exists. Morning / afternoon / night, the way a mountain forecast reads.
  const BOARD_SLOTS = 18;                       // six days of morning/afternoon/night

  function bandBuckets(valid) {
    const fmt = new Intl.DateTimeFormat("en-CA", W().units.timeOpts({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }));
    const part = (dt) => { const o = {}; for (const x of fmt.formatToParts(dt)) o[x.type] = x.value;
      return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; };
    const out = [];
    valid.forEach((iso, i) => {
      const dt = new Date(iso), hour = part(dt).hour;
      // The small hours belong to the night that started the evening before —
      // otherwise every day opens and closes with a "night" column and reads
      // like two nights.
      const day = part(new Date(dt.getTime() - 6 * 3600e3)).day;
      const slot = hour < 6 ? "night" : hour < 12 ? "AM" : hour < 18 ? "PM" : "night";
      const key = `${day}#${slot}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.idx.push(i);
      else out.push({ key, day, slot, date: dt, idx: [i] });
    });
    // Six days is a forecast; ten is a horoscope. Start at the column that
    // holds now and stop there.
    const now = Date.now();
    let from = out.findIndex((b) => new Date(valid[b.idx[b.idx.length - 1]]).getTime() >= now);
    if (from < 0) from = 0;
    return out.slice(from, from + BOARD_SLOTS);
  }

  function bandTable(prof, bands) {
    if (!prof || !prof.valid || !prof.bands || !prof.bands.length) return "";
    const U = W().units, speed = W().speed, unit = W().speedUnit();
    const buckets = bandBuckets(prof.valid);
    if (buckets.length < 3) return "";
    const days = [];
    buckets.forEach((b) => { const last = days[days.length - 1];
      if (last && last.day === b.day) last.span++; else days.push({ day: b.day, date: b.date, span: 1 }); });
    // A day that holds a single slot (the board's ragged edge) gets only its
    // weekday: "Wed 26" over one narrow column forces that column wide and
    // its cells lay out unlike every other column on the board.
    const dayRow = days.map((dy) => `<th colspan="${dy.span}" class="day">${dy.date.toLocaleDateString(undefined, U.timeOpts(dy.span === 1 ? { weekday: "short" } : { weekday: "short", day: "numeric" }))}</th>`).join("");
    const slotRow = buckets.map((b) => `<th class="slot ${b.slot === "night" ? "nite" : ""}">${b.slot}</th>`).join("");
    const total = (arr, ix) => ix.reduce((a, k) => a + ((arr && arr[k]) || 0), 0);
    const pick = (arr, ix, fn) => { const v = ix.map((k) => arr && arr[k]).filter((x) => x != null); return v.length ? fn(v) : null; };

    const rows = bands.map(([name, z]) => {
      // match by height, not by position: callers hand the bands over in the
      // order they want them drawn, which is not the order they were asked for
      const b = prof.bands.find((x) => Math.abs(x.elev_m - z) < 1);
      if (!b) return "";
      const cells = (cls, fn) => buckets.map((bu) => fn(bu)).map((c) => `<td class="${cls}">${c}</td>`).join("");
      // Below half a unit there is nothing to plan around; a rounded "0" in a
      // snow column is worse than an honest dot.
      const snowRow = cells("num", (bu) => { const v = total(b.snow_cm, bu.idx), u = U.snow(v, v < 5 ? 1 : 0);
        return Number(u.v) <= 0 ? '<span class="nil">·</span>' : `<span class="fall snow" style="--w:${Math.min(1, v / 20).toFixed(2)}">${u.v}</span>`; });
      const rainRow = cells("num", (bu) => { const v = total(b.rain_mm, bu.idx), u = U.precip(v, v < 5 ? 1 : 0);
        return Number(u.v) <= 0 ? '<span class="nil">·</span>' : `<span class="fall rain" style="--w:${Math.min(1, v / 12).toFixed(2)}">${u.v}</span>`; });
      const hiRow = cells("num", (bu) => { const v = pick(b.temp, bu.idx, (x) => Math.max(...x));
        return v == null ? "—" : `<b style="color:${tempColor(v - K)}">${U.temp(v).v}°</b>`; });
      const loRow = cells("num dimrow", (bu) => { const v = pick(b.temp, bu.idx, (x) => Math.min(...x));
        return v == null ? "—" : `${U.temp(v).v}°`; });
      const windRow = cells("num", (bu) => {
        const v = pick(b.wind, bu.idx, (x) => Math.max(...x));
        if (v == null) return "—";
        const k = bu.idx.reduce((best, q) => (b.wind[q] != null && (b.wind[best] == null || b.wind[q] > b.wind[best]) ? q : best), bu.idx[0]);
        const dir = b.wdir ? b.wdir[k] : null;
        return `<span class="wv" style="background:${W().rampColor("wind", v, 0.9)};color:${v * 3.6 > 45 ? "#160b03" : "var(--fg)"}">${Math.round(speed(v))}</span>${dir == null ? "" : `<i class="dirarrow" style="${W().arrowRot(dir)}"></i>`}`;
      });
      return `<tr class="bandrow"><th class="lab band" colspan="${buckets.length + 1}"><span>${esc(name)}</span><i>${U.alt(z).txt}</i></th></tr>
        <tr><th class="lab">Snow<small>${U.snowUnit}</small></th>${snowRow}</tr>
        <tr><th class="lab">Rain<small>${U.precipUnit}</small></th>${rainRow}</tr>
        <tr><th class="lab">High<small>${U.tempUnit}</small></th>${hiRow}</tr>
        <tr><th class="lab">Low<small>${U.tempUnit}</small></th>${loRow}</tr>
        <tr><th class="lab">Wind<small>${unit}</small></th>${windRow}</tr>`;
    }).join("");

    const flRow = prof.freezing_level_m ? `<tr class="frzrow"><th class="lab">Freezing lvl<small>${U.altUnit}</small></th>${buckets.map((bu) => {
      const v = pick(prof.freezing_level_m, bu.idx, (x) => x.reduce((a, c) => a + c, 0) / x.length);
      return `<td class="num">${v == null ? "—" : U.alt(Math.round(v / 50) * 50).v}</td>`; }).join("")}</tr>` : "";

    return `<div class="board"><table class="bandtape">
      <thead><tr><th class="lab corner"></th>${dayRow}</tr><tr><th class="lab corner"></th>${slotRow}</tr></thead>
      <tbody>${rows}${flRow}</tbody></table></div>`;
  }

  // A cyclone within reach of the pin earns a chip on the hero card: the
  // storm's name, its basin-correct category, range and bearing. Tapping it
  // turns the storms layer on and flies to the eye (Jeff 2026-08-21).
  let stormFetch = 0;
  // The meteorological tropical-cyclone symbol, not an emoji: a core with
  // two trailing arms, drawn in whatever colour the category earned.
  // The NHC symbol proper: a solid ring and two tapered spiral arms, generated
  // as filled polygons (a stroked sketch read as a ring with stubs).
  const CYCLONE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path fill-rule="evenodd" d="M12 7.3a4.7 4.7 0 1 0 0 9.4a4.7 4.7 0 1 0 0-9.4zM12 9.7a2.3 2.3 0 1 1 0 4.6a2.3 2.3 0 1 1 0-4.6z"/><path d="M18.93 12.97 L19.14 12.11 L19.21 11.20 L19.15 10.29 L18.96 9.38 L18.66 8.50 L18.23 7.65 L17.69 6.86 L17.06 6.14 L16.32 5.50 L15.51 4.95 L14.62 4.52 L13.68 4.19 L12.70 3.99 L11.70 3.91 L10.68 3.96 L9.68 4.14 L8.70 4.45 L7.76 4.88 L6.88 5.43 L6.07 6.09 L5.35 6.85 L4.72 7.69 L4.21 8.62 L3.81 9.60 L3.54 10.64 L3.41 11.70 L3.80 11.71 L4.09 10.73 L4.49 9.80 L4.99 8.96 L5.59 8.21 L6.26 7.55 L6.99 7.00 L7.76 6.56 L8.57 6.24 L9.39 6.02 L10.20 5.92 L11.00 5.93 L11.78 6.03 L12.50 6.23 L13.18 6.52 L13.79 6.88 L14.33 7.31 L14.80 7.79 L15.18 8.31 L15.48 8.86 L15.70 9.42 L15.83 9.98 L15.88 10.54 L15.86 11.08 L15.76 11.58 L15.60 12.05 L15.37 12.47 Z"/><path d="M5.07 11.03 L4.86 11.89 L4.79 12.80 L4.85 13.71 L5.04 14.62 L5.34 15.50 L5.77 16.35 L6.31 17.14 L6.94 17.86 L7.68 18.50 L8.49 19.05 L9.38 19.48 L10.32 19.81 L11.30 20.01 L12.30 20.09 L13.32 20.04 L14.32 19.86 L15.30 19.55 L16.24 19.12 L17.12 18.57 L17.93 17.91 L18.65 17.15 L19.28 16.31 L19.79 15.38 L20.19 14.40 L20.46 13.36 L20.59 12.30 L20.20 12.29 L19.91 13.27 L19.51 14.20 L19.01 15.04 L18.41 15.79 L17.74 16.45 L17.01 17.00 L16.24 17.44 L15.43 17.76 L14.61 17.98 L13.80 18.08 L13.00 18.07 L12.22 17.97 L11.50 17.77 L10.82 17.48 L10.21 17.12 L9.67 16.69 L9.20 16.21 L8.82 15.69 L8.52 15.14 L8.30 14.58 L8.17 14.02 L8.12 13.46 L8.14 12.92 L8.24 12.42 L8.40 11.95 L8.63 11.53 Z"/></svg>`;
  W().CYCLONE_SVG = CYCLONE_SVG;
  function fetchNearStorm(pt) {
    const my = ++stormFetch;
    W().api(`${W().API}/storms`).then((gj) => {
      if (my !== stormFetch) return;
      const el = document.getElementById("storm-slot");
      if (!el) return;
      const R = Math.PI / 180;
      let best = null;
      for (const f of gj.features || []) {
        if (f.properties.kind !== "current") continue;
        const [slon, slat] = f.geometry.coordinates;
        const km = 6371 * Math.acos(Math.min(1, Math.sin(pt.lat * R) * Math.sin(slat * R)
          + Math.cos(pt.lat * R) * Math.cos(slat * R) * Math.cos((pt.lon - slon) * R)));
        if (km <= 1200 && (!best || km < best.km)) best = { f, km, slon, slat };
      }
      if (!best) { el.innerHTML = ""; el.classList.remove("on"); return; }
      const p = best.f.properties;
      const brg = Math.round((Math.atan2(Math.sin((best.slon - pt.lon) * R) * Math.cos(best.slat * R),
        Math.cos(pt.lat * R) * Math.sin(best.slat * R) - Math.sin(pt.lat * R) * Math.cos(best.slat * R) * Math.cos((best.slon - pt.lon) * R)) / R + 360) % 360);
      const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(brg / 45) % 8];
      el.classList.add("on");
      el.style.color = p.category_color || "#ef786f";
      el.title = `${p.category_label || ""} — tap for the storm view`;
      el.innerHTML = `${CYCLONE_SVG}<span class="ws-txt"><small>${esc((p.class || "").toUpperCase())}${p.category ? ` · ${esc(p.category)}` : ""}</small><b>${esc(p.name || "")}</b><em>${Math.round(best.km / 10) * 10} km ${dir}</em></span>`;
      el.onclick = () => {
        if (!W().state.storms) document.getElementById("storms-toggle").click();
        W().map.flyTo({ center: [best.slon, best.slat], zoom: Math.max(4.5, W().map.getZoom()), duration: 1400 });
        setTimeout(() => { if (W().openStormCard) W().openStormCard(best.f); }, 1500);
      };
    }).catch(() => {});
  }

  // The nearest ski area to this point, if one is close enough to be the same
  // weather. Asked once per point; `null` means there isn't one.
  function fetchNearestResort(pt) {
    pt.near = null;
    W().api(`${W().API}/resorts?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&limit=8`)
      .then((r) => {
        // Nearest is not best: a tube park sits 600 m from the mountain it is
        // parked on. Prefer a ski area the catalog knows the summit of.
        const list = (r.resorts || []).filter((x) => x.distance_km != null && x.distance_km <= 60);
        const near = list.find((x) => x.ele_summit_m) || list[0];
        pt.near = near || null;
        if (W().state.point === pt && W().state.tab === "winter") W().renderPoint();
      })
      .catch(() => {});
  }

  // The bands the board draws for a plain point: a nearby ski area's own
  // base/mid/summit when there is one, otherwise the point's elevation and two
  // steps above it. The offsets are stated on the card — a gridpoint has no
  // idea what the terrain around it does.
  function winterBands(pt) {
    const near = pt.near, base = near && near.ele_base_m, summit = near && near.ele_summit_m;
    if (near && base != null && summit != null && summit - base > 250) {
      return [["Summit", Math.round(summit)], ["Mid", Math.round((base + summit) / 2)], ["Base", Math.round(base)]];
    }
    const e = Math.round((pt.local && pt.local.elevation_m) || 0);
    return [["+900 m", e + 900], ["+450 m", e + 450], ["Here", e]];
  }

  function fetchWinterBands(pt) {
    const bands = winterBands(pt);
    pt.wbands = { loading: true, bands };
    W().api(`${W().API}/profile?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&model=${W().state.model}&elevs=${bands.map((b) => b[1]).join(",")}`)
      .then((r) => { pt.wbands.data = r; pt.wbands.loading = false; if (W().state.point === pt && W().state.tab === "winter") W().renderPoint(); })
      .catch(() => { pt.wbands.loading = false; pt.wbands.error = true; if (W().state.point === pt && W().state.tab === "winter") W().renderPoint(); });
  }

  function renderWinter(pt, d, i) {
    const { speed, speedUnit, f, AVY_COLORS } = W();
    const s = d.series;
    const sum = (arr, a, b) => arr ? arr.slice(a, b).reduce((x, y) => x + (y || 0), 0) : null;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const snowLevel = fl != null ? Math.max(0, fl - 300) : null;
    const t = s.t2m ? s.t2m[i] - K : null;
    const rainOnSnow = s.sd_cm && s.sd_cm[i] > 5 && s.tp6 && s.tp6[i] > 1 && (s.sf6 ? s.sf6[i] < 0.3 : t != null && t > 1.5);
    const w850 = d.aloft && d.aloft["850"] ? d.aloft["850"].wind[i] : null, w700 = d.aloft && d.aloft["700"] ? d.aloft["700"].wind[i] : null;
    // snow-to-liquid ratio from the surface temperature: cold storms stack higher
    const slr = t == null ? 10 : t < -12 ? 15 : t < -6 ? 12 : t < 0 ? 10 : t < 1.5 ? 7 : 5;
    const sn = (h) => { const v = sumWindow(s.sf6, d.steps, i, h); return v == null ? "n/a" : `${W().units.snow(v).txt} <span class="dim">(${W().units.snow(v * slr / 10).v} @ ${slr}:1)</span>`; };
    const w850d = d.aloft && d.aloft["850"] ? d.aloft["850"].wdir[i] : null;
    const lee = w850d == null ? null : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((w850d + 180) % 360) / 45)) % 8];
    // freezing level a day out: is the snow line coming down or going up
    const j24 = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const fl24 = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[j24] : null;
    const flTrend = fl != null && fl24 != null && Math.abs(fl24 - fl) > 150 ? (fl24 < fl ? " ↓" : " ↑") : "";
    const chance = probMax(pt, d, i, "prob_rain", 24);
    const sn24we = sumWindow(s.sf6, d.steps, i, 24);
    const powder = sn24we != null && sn24we * slr / 10 >= 15 && (w850 == null || speed(w850) < (W().state.units === "kt" ? 22 : W().state.units === "ms" ? 11 : 40));
    const rows = [
      ["New snow next 24 h", sn(24), ""],
      ["New snow next 48 h", sn(48), ""],
      ["New snow next 72 h", sn(72), ""],
      ["Snow depth (model)", s.sd_cm ? W().units.snow(s.sd_cm[i]).txt : "n/a", ""],
      ["Freezing level", fl != null ? `${W().units.alt(fl).txt}${flTrend}` : "—", flTrend === " ↓" ? "good" : ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ...(chance != null ? [["Precip chance 24 h", `${chance}% <span class="dim">of 30 members</span>`, ""]] : []),
      ["Ridge wind 850 / 700", `${f(w850, (v) => speed(v).toFixed(0))} / ${f(w700, (v) => speed(v).toFixed(0))} ${speedUnit()}`, w700 != null && speed(w700) > (W().state.units === "kt" ? 25 : W().state.units === "ms" ? 13 : 45) ? "bad" : w700 != null && speed(w700) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : 28) ? "meh" : "good"],
      ["Wind loading", w850 != null && speed(w850) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : W().state.units === "mph" ? 17 : 28) ? `${lee} aspects loading` : "light", w850 != null && speed(w850) > 15 ? "meh" : "good"],
      ["Rain on snow", rainOnSnow ? "yes, wet loading" : "no", rainOnSnow ? "bad" : "good"],
      ["Surface temp", t != null ? W().units.tempC(t).txt : "—", t != null && t > 0 && s.sd_cm && s.sd_cm[i] > 5 ? "meh" : ""],
    ];
    // The band-by-band read this pane cannot give — a 0.25° gridpoint is one
    // number for a valley and a ridge — already exists for ski areas. Put the
    // door to it here, where somebody looking at snow will find it.
    let resortHtml = "";
    if (pt.near === undefined) fetchNearestResort(pt);
    else if (pt.near) resortHtml = `<button class="resort-link" data-resort="${esc(pt.near.id)}">
      <span class="k">Elevation bands</span><span class="v">${esc(pt.near.name)}<i>${W().units.dist(pt.near.distance_km).txt} away</i></span></button>`;
    // The board: what falls at each height, morning by morning.
    if (pt.wbands === undefined && pt.near !== undefined && pt.local) fetchWinterBands(pt);
    const B = pt.wbands;
    const boardHtml = !B ? "" : B.error ? `<div class="note">Elevation bands unavailable.</div>`
      : B.data ? `<div class="board-head"><span>Elevation bands</span><span class="dim">${esc(B.bands[0][0])} → ${esc(B.bands[B.bands.length - 1][0])}</span></div>${bandTable(B.data, B.bands)}`
      : `<div class="note">Reading the column…</div>`;
    let avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span><span class="dim">loading…</span></div></div>`;
    if (pt.avy === false) avyHtml = `<div class="avy"><div class="avy-head"><span>Avalanche forecast</span></div><div class="avy-note">No public forecast region covers this point (Avalanche Canada / avalanche.org).</div></div>`;
    else if (pt.avy) avyHtml = avyBlock(pt.avy, AVY_COLORS);
    else fetchAvy(pt);
    const powderHtml = powder ? `<div class="verdict good"><b>Powder morning shaping up</b><span class="dim">${W().units.snow(sn24we * slr / 10).txt} at ${slr}:1, ridge wind workable</span></div>` : "";
    $("#winter").innerHTML = `${powderHtml}${resortHtml}${boardHtml}<div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${avyHtml}
      <div class="note">Board: the model column interpolated to each height, so snow and rain are what falls THERE. Depth ratios come from the band temperature. Without a ski area nearby the bands are this point's elevation and 450/900 m above it — the gridpoint does not know what the terrain does. Snow depth is the model snowpack, not a station.</div>`;
    const link = $("#winter .resort-link");
    if (link) link.onclick = () => W().ov.selectResort(link.dataset.resort);
  }
  async function fetchAvy(pt) {
    const my = pt;
    try { my.avy = await W().api(`${W().API}/avy/point?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}`); }
    catch (e) { my.avy = false; }
    if (W().state.point === my && W().state.tab === "winter") W().renderPoint();
  }
  function avyBlock(a, colors) {
    const days = (a.days || []).slice(0, 3);
    const cell = (b) => { const lvl = b && (b.level != null ? b.level : -1); const col = colors[lvl] || "#8a8f98"; const txt = b && (b.display || b.value || "—"); const light = lvl === 2 || lvl === 0 || lvl === -1; return `<span class="band" style="background:${col};color:${light ? "#111" : "#fff"}">${esc(txt).replace("Summer Conditions", "summer")}</span>`; };
    const region = (a.region || "").length > 60 ? "Avalanche Canada (off season)" : a.region;
    return `<div class="avy"><div class="avy-head"><span>${esc(region)}${a.center && a.center !== "Avalanche Canada" ? ` <span class="dim">· ${esc(a.center)}</span>` : ""}</span>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">forecast ↗</a>` : ""}</div>
      ${days.length ? `<div class="avy-days"><span class="lab"></span><span class="lab">Alpine</span><span class="lab">Treeline</span><span class="lab">Below TL</span>${days.map((dd) => `<span class="lab">${esc((dd.label || dd.date || "").toString().slice(0, 9))}</span>${cell(dd.alp)}${cell(dd.tln)}${cell(dd.btl)}`).join("")}</div>` : `<div class="avy-note">${a.off_season ? "Off season — no danger ratings issued. Forecasts resume when the snowpack does (typically November)." : "No ratings in this product."}</div>`}
      ${a.highlights ? `<div class="avy-note">${esc(a.highlights).slice(0, 420)}</div>` : ""}
      ${(a.problems || []).length ? `<div class="avy-prob">${a.problems.slice(0, 3).map((p) => `<div><b>${esc(p.type)}</b>${p.likelihood ? ` · ${esc(p.likelihood)}` : ""}${p.size ? ` · size ${esc(p.size)}` : ""}${p.elevations && p.elevations.length ? ` · ${p.elevations.map(esc).join("/")}` : ""}${p.aspects && p.aspects.length ? ` · ${p.aspects.map(esc).join(" ")}` : ""}</div>`).join("")}</div>` : ""}
      ${a.issued ? `<div class="avy-note dim">issued ${new Date(a.issued).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })}${a.valid_until ? ` · valid to ${new Date(a.valid_until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}${a.confidence ? ` · confidence ${esc(a.confidence)}` : ""} · ${esc(a.source)}</div>` : ""}
    </div>`;
  }

  const uvWord = (u) => u < 3 ? "low" : u < 6 ? "moderate" : u < 8 ? "high" : u < 11 ? "very high" : "extreme";
  function renderSkewT(pt, d, i) {
    if (!window.WXSounding) return;
    // the observed ascent arrives late and re-renders; `false` means we asked
    // and there is nothing in reach, so we do not ask again for this point
    if (pt && pt.sonde === undefined) {
      pt.sonde = null;
      W().api(`${W().API}/sonde/nearest?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}`)
        .then((r) => { pt.sonde = (r && r.sounding) ? r.sounding : false; if (W().state.point === pt && W().state.tab === "skewt") W().renderPoint(); })
        .catch(() => { pt.sonde = false; });
    }
    // the diagram draws in the canvas's own pixel space, so size the element
    // to the card before every draw instead of letting a 640 px chart get
    // squeezed by CSS
    const c = $("#skewt"), host = c.parentElement;
    const w = Math.max(300, Math.round(host.clientWidth));
    // on a phone the card is a sheet: keep the diagram inside it so the
    // caption underneath stays reachable
    const cap = window.innerWidth <= 820 ? Math.round(window.innerHeight * 0.46) : 520;
    const h = Math.round(Math.min(cap, Math.max(280, w * 1.05)));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; c.style.width = w + "px"; c.style.height = h + "px"; }
    const r = window.WXSounding.draw(c, d, i, { elevation_m: ((pt && pt.local) || {}).elevation_m,
                                                observed: pt && pt.sonde ? pt.sonde : null });
    $("#skewt-note").textContent = (r && r.caption) || "";
  }

  // ── Outdoors ──────────────────────────────────────────────────────────
  function renderOutdoors(d, i) {
    const { speed, speedUnit, state } = W();
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const t = s.t2m ? s.t2m[i] - K : null;
    const w = s.wind ? s.wind[i] : null, g = s.gust ? s.gust[i] : null, rain = s.tp6 ? s.tp6[i] : null, cloud = s.tcc ? s.tcc[i] : null;
    let chill = null;
    if (t != null && w != null && t <= 10 && w * 3.6 >= 4.8) { const v = Math.pow(w * 3.6, 0.16); chill = 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v; }
    let humidex = null;
    if (t != null && s.d2m && s.d2m[i] != null && t >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / s.d2m[i])); humidex = t + 0.5555 * (e - 10); }
    const snowLevel = fl != null ? Math.max(0, fl - 300) : null;
    const j24o = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const fl24o = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[j24o] : null;
    const flTrend = fl != null && fl24o != null && Math.abs(fl24o - fl) > 150 ? (fl24o < fl ? " ↓" : " ↑") : "";
    const chance = probMax(W().state.point, d, i, "prob_rain", 24);
    const ptype = rain != null && rain > 0.2 ? (t != null && t < 1 ? "snow" : t != null && t < 3 ? "rain/snow" : "rain") : "dry";
    const j1 = (() => { let k = i; while (k + 1 < d.steps.length && d.steps[k + 1] <= d.steps[i] + 24) k++; return k; })();
    const rain24 = sumWindow(s.tp6, d.steps, i, 24);
    const gusts = s.gust ? s.gust.slice(i, j1 + 1).filter((v) => v != null) : [];
    const gustMax24 = gusts.length ? Math.max(...gusts) : null;
    const calm = state.units === "kt" ? 12 : state.units === "ms" ? 6 : 22, gusty = state.units === "kt" ? 25 : state.units === "ms" ? 13 : 46;
    let dryH = 0, totH = 0;  // dry, calm hours in the next 72 h (hikers, paddlers)
    for (let k = i; k < d.steps.length && d.steps[k] < d.steps[i] + 72; k++) { const h = stepHrs(d, k); totH += h; if (s.tp6 && (s.tp6[k] || 0) < 0.2 && (!s.wind || s.wind[k] == null || speed(s.wind[k]) < gusty)) dryH += h; }
    const dry = { length: dryH / 6 };
    const rows = [
      ["Precip now", `${ptype}${rain != null && rain > 0 ? ` · ${W().units.precip(rain).txt}/6h` : ""}`, ptype === "dry" ? "good" : ptype === "snow" ? "meh" : ""],
      ["Next 24 h rain", rain24 != null ? W().units.precip(rain24).txt : "—", rain24 == null ? "" : rain24 < 1 ? "good" : rain24 < 10 ? "meh" : "bad"],
      ["Freezing level", fl != null ? `${W().units.alt(fl).txt}${flTrend}` : "—", flTrend === " ↓" ? "good" : ""],
      ["Snow level (≈)", snowLevel != null ? W().units.alt(Math.round(snowLevel / 50) * 50).txt : "—", ""],
      ...(chance != null ? [["Precip chance 24 h", `${chance}% <span class="dim">of 30 members</span>`, ""]] : []),
      ["Wind / gust", w != null ? `${speed(w).toFixed(0)}${g != null ? ` · gusts ${speed(g).toFixed(0)}` : ""} ${speedUnit()}` : "—", w == null ? "" : speed(w) < calm ? "good" : "meh"],
      ["Max gust 24 h", gustMax24 != null ? `${speed(gustMax24).toFixed(0)} ${speedUnit()}` : "—", gustMax24 == null ? "" : speed(gustMax24) < gusty ? "good" : "bad"],
      ["Feels like", chill != null ? `${W().units.tempC(chill).v}° (wind chill)` : humidex != null ? `${W().units.tempC(humidex).v}° (humidex)` : t != null ? `${W().units.tempC(t).v}°` : "—", (chill != null && chill < -10) || (humidex != null && humidex > 35) ? "bad" : ""],
      ["Cloud", cloud != null ? `${(cloud * 100).toFixed(0)}%` : "—", cloud == null ? "" : cloud < 0.3 ? "good" : ""],
      ["Thunder risk (CAPE)", s.cape && s.cape[i] != null ? `${s.cape[i].toFixed(0)} J/kg` : "n/a", capeClass(s.cape && s.cape[i])],
      ["UV index (model est.)", s.uvi && s.uvi[i] != null ? `${s.uvi[i].toFixed(0)} ${uvWord(s.uvi[i])}` : "—", s.uvi && s.uvi[i] != null ? (s.uvi[i] < 3 ? "good" : s.uvi[i] < 8 ? "meh" : "bad") : ""],
      ...(s.swh && s.swh[i] != null ? [["Sea state", `${W().units.alt(s.swh[i], 1).txt}${s.mwp && s.mwp[i] != null ? ` · ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` from ${Math.round(s.mwd[i])}°` : ""}`, s.swh[i] < 1 ? "good" : s.swh[i] < 2.5 ? "meh" : "bad"]] : []),
      ["Dry, calm hours (3 d)", dryH ? `${dryH} h of ${totH}` : "none", dryH > 36 ? "good" : dryH ? "meh" : "bad"],
      // cloud base from the dew-point spread: the number a pilot or a
      // view-hunter actually wants, ~125 m per °C of spread
      ["Cloud base (≈)", t != null && s.d2m && s.d2m[i] != null && cloud != null && cloud > 0.15
        ? W().units.alt(Math.round(125 * Math.max(0, t - (s.d2m[i] - K)) / 50) * 50).txt : "clear or n/a", ""],
      ...(s.vis && s.vis[i] != null ? [["Visibility", `${(s.vis[i] / 1000).toFixed(s.vis[i] < 5000 ? 1 : 0)} km`, s.vis[i] > 9000 ? "good" : s.vis[i] > 3000 ? "meh" : "bad"]] : []),
    ];
    const sun2 = sunTimes(W().state.point.lat, W().state.point.lon, W().validDate);
    if (sun2 && sun2.rise) rows.push(["Sun", `${sun2.rise} → ${sun2.set}`, ""]);
    // The verdict: the worst of the calls the rows already made, said once
    // at the top the way a partner would say it at the trailhead.
    const calls = rows.map((r) => r[2]).filter(Boolean);
    const verdict = calls.includes("bad") ? ["Rough out there", "bad"]
      : calls.includes("meh") ? ["Workable, watch it", "meh"] : ["Looks good", "good"];
    // The best window in the next 48 h: dry, calm and in daylight for 3 h+.
    // People do not plan around a table; they plan around "when".
    let winHtml = "";
    {
      const okAt = (k) => (s.tp6 ? (s.tp6[k] || 0) : 0) < 0.2 && (!s.wind || s.wind[k] == null || speed(s.wind[k]) < calm);
      let best = null, run = null;
      for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 48; k++) {
        const hr = new Date(d.valid[k]).getHours();
        if (okAt(k) && hr >= 7 && hr <= 20) { if (!run) run = { a: k, b: k }; else run.b = k; if (!best || (d.steps[run.b] - d.steps[run.a]) > (d.steps[best.b] - d.steps[best.a])) best = { ...run }; }
        else run = null;
      }
      if (best && d.steps[best.b] - d.steps[best.a] >= 3) {
        const fmt = (k) => new Date(d.valid[k]).toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }));
        winHtml = `<div class="verdict-win"><i>best window</i><b>${fmt(best.a)} → ${fmt(best.b)}</b><span class="dim">dry · calm · daylight</span></div>`;
      }
    }
    const pt = W().state.point;
    let tidesHtml = "";
    if (pt && pt.tides && pt.tides.events && pt.tides.events.length) {
      const t = pt.tides;
      tidesHtml = `<div class="obs"><div class="obs-head"><span>Tides · ${esc(t.station)} · ${W().units.dist(t.distance_km).txt}</span><span class="dim">${esc(t.source)} · ${esc(t.datum)}</span></div>
        <div class="tides">${t.events.slice(0, 6).map((e) => `<span class="tide ${e.type}"><b>${e.type === "H" ? "▲" : "▼"} ${W().units.alt(e.height_m, 1).txt}</b><small>${W().units.dateTime(e.time, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small></span>`).join("")}</div></div>`;
    }
    // the sun's day at a glance: 24 hourly UV cells in the map's own ramp
    let uvStrip = "";
    if (s.uvi) {
      const cells = [];
      for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) {
        const v = s.uvi[k];
        cells.push(`<i title="UV ${v == null ? "?" : v.toFixed(0)} at ${new Date(d.valid[k]).toLocaleTimeString(undefined, W().units.timeOpts({ hour: "numeric" }))}" style="background:${v == null || v < 0.5 ? "rgba(127,127,127,.12)" : W().rampColor("uvi", v, 0.85)}"></i>`);
      }
      if (cells.length > 3) uvStrip = `<i class="kicker">uv through the day</i><div class="uvstrip">${cells.join("")}</div>`;
    }
    $("#outdoors").innerHTML = `<div class="verdict ${verdict[1]}"><b>${verdict[0]}</b>${winHtml}</div>
      <div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${uvStrip}${tidesHtml}${airHtml(pt || {})}
      <div class="note">Snow level ≈ freezing level − ${W().units.alt(300).txt}. Gusts come from models that ship one. Terrain is unresolved at 0.25°.</div>`;
  }

  // ── Spread: how much the ensemble disagrees with itself ───────────────
  const SPREAD_VARS = [["t2m", "Temp"], ["wind", "Wind"], ["tp6", "Rain"], ["msl", "Pressure"]];
  let spreadVar = localStorage.getItem("wxgrid.spreadVar") || "t2m";
  function renderSpread(pt, d, i) {
    const box = $("#spread-vars");
    box.innerHTML = SPREAD_VARS.map(([v, t]) => `<button data-v="${v}" class="${v === spreadVar ? "on" : ""}">${t}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { spreadVar = b.dataset.v; localStorage.setItem("wxgrid.spreadVar", spreadVar); pt.plume = undefined; renderSpread(pt, d, i); });
    const c = $("#plume"), note = $("#plume-note");
    const host = c.parentElement, w = Math.max(300, Math.round(host.clientWidth));
    c.style.width = w + "px"; c.style.height = "220px";
    if (pt.plume === undefined) {
      pt.plume = null; note.textContent = "loading the ensemble…";
      W().api(`${W().API}/ens/plume?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&var=${spreadVar}`)
        .then((r) => { pt.plume = r || false; if (W().state.point === pt && W().state.tab === "spread") W().renderPoint(); })
        .catch(() => { pt.plume = false; if (W().state.point === pt && W().state.tab === "spread") W().renderPoint(); });
      return;
    }
    if (!pt.plume) {
      c.getContext("2d").clearRect(0, 0, c.width, c.height);
      note.textContent = "No ensemble in the store yet. Ingest a GEFS run and the spread appears here.";
      return;
    }
    window.WXEns && window.WXEns.drawPlume(c, pt.plume, {});
    const basis = pt.plume.basis === "members" ? "51 members" : "mean ± spread, assumed Gaussian";
    note.textContent = `${pt.plume.label || spreadVar} · ${basis} · ${pt.plume.source || "GEFS"}. The band is where the ensemble puts the forecast; a wide band means the models are arguing with each other.`;
  }

  // ── Compare: every model at the same valid times ──────────────────────
  function renderCompare(pt, d, i) {
    const { speed, speedUnit, catalog, API, api } = W();
    if (!pt.cmp) {
      const models = catalog.models.filter((m) => m.runs.length);
      pt.cmp = { rows: {}, order: models.map((m) => m.key), pending: models.length };
      // Rows land one at a time. Regional models answer from the same store as
      // the globals and simply omit a point outside their advertised domain.
      const land = (m, r) => {
        if (r && r.available !== false) pt.cmp.rows[m.key] = { model: m, data: r };
        pt.cmp.pending -= 1;
        if (W().state.point === pt && W().state.tab === "cmp") W().renderPoint();
      };
      models.forEach((m) => api(`${API}/point?lat=${pt.lat.toFixed(3)}&lon=${W().wlon(pt.lon).toFixed(3)}&model=${m.key}`).then((r) => land(m, r)).catch(() => land(m, null)));
    }
    if (!Object.keys(pt.cmp.rows).length) { $("#compare").innerHTML = `<div class="note">${pt.cmp.pending ? "loading other models…" : "no other model has this point"}</div>`; return; }
    const t0 = new Date(d.valid[i]).getTime();
    const cols = Array.from({ length: 8 }, (_, k) => t0 + k * 12 * 3600e3);      // 4 days at 12 h
    const head = cols.map((t) => `<th>${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric" }).replace(" ", "<br>")}</th>`).join("");
    const rowFor = (label, pick) => pt.cmp.order.map((k) => pt.cmp.rows[k]).filter(Boolean).map(({ model, data }) => {
      const cells = cols.map((t) => { const k = data.valid.findIndex((v) => new Date(v).getTime() === t); return `<td>${k >= 0 ? pick(data.series, k) : "—"}</td>`; }).join("");
      // Each model's own resolution beside its name: the reason two rows differ
      // is usually that one of them resolves the terrain and the other does not.
      return `<tr><td class="mdl">${model.short}${model.grid ? `<i>${model.grid}</i>` : ""}</td>${cells}</tr>`;
    }).join("");
    $("#compare").innerHTML = `<table class="cmp"><thead><tr><th>Temp ${W().units.tempUnit}</th>${head}</tr></thead><tbody>${rowFor("t", (s, k) => s.t2m && s.t2m[k] != null ? W().units.temp(s.t2m[k]).v : "—")}</tbody>
      <thead><tr><th>Wind ${speedUnit()}</th>${head}</tr></thead><tbody>${rowFor("w", (s, k) => s.wind && s.wind[k] != null ? Math.round(speed(s.wind[k])) : "—")}</tbody>
      <thead><tr><th>Rain ${W().units.precipUnit}/12h</th>${head}</tr></thead><tbody>${rowFor("r", (s, k) => s.tp6 ? `<span class="r">${W().units.precip((s.tp6[k] || 0) + (s.tp6[k + 1] || 0)).v}</span>` : "—")}</tbody></table>
      <div class="note">${pt.cmp.pending ? "still loading… " : ""}Same valid times, each model's latest run. Disagreement is the error bar. Regional rows appear only where that model covers the point.</div>`;
  }

  // ── Resort: elevation-band forecast, whistlerpeak-style ───────────────
  function renderResort(pt, d, i) {
    const { speed, speedUnit, state, API, api } = W();
    const R = state.resort; if (!R) { $("#resort").innerHTML = ""; return; }
    const r = R.resort, base = R.elevation.base_m, summit = R.elevation.summit_m;
    if (!pt.profile) {
      const bands = [];
      if (base != null && summit != null && summit > base) {
        const mid = Math.round((base + summit) / 2);
        bands.push(["Village", base], ["Mid-mountain", mid], ["Alpine", Math.round(base + (summit - base) * 0.8)], ["Peak", summit]);
      } else { bands.push(["Village", 700], ["Mid", 1400], ["Alpine", 1900], ["Peak", 2300]); }
      pt.profile = { loading: true, bands };
      api(`${API}/profile?lat=${r.lat.toFixed(3)}&lon=${r.lon.toFixed(3)}&model=${state.model}&elevs=${bands.map((b) => b[1]).join(",")}`).then((p) => { pt.profile.data = p; pt.profile.loading = false; if (state.point === pt) W().renderPoint(); }).catch(() => { pt.profile.loading = false; pt.profile.error = true; if (state.point === pt) W().renderPoint(); });
    }
    const P = pt.profile;
    const lifts = (R.lifts && R.lifts.features || []).length;
    let bandsHtml = `<div class="note">loading elevation bands…</div>`;
    if (P.error) bandsHtml = `<div class="note">profile unavailable</div>`;
    else if (P.data) {
      const p = P.data;
      const k = Math.min(i, p.steps.length - 1);
      const sum = (arr, a, b) => arr ? arr.slice(a, b).reduce((x, y) => x + (y || 0), 0) : 0;
      const rows = P.bands.slice().reverse().map(([name, z], bi) => {
        const b = p.bands[P.bands.length - 1 - bi];
        const t = b.temp[k], w = b.wind[k], dir = b.wdir[k], pty = b.ptype[k];
        // snow at this band over next 24 h: precip that falls as snow at the band's temperature
        let snow24 = 0, rain24 = 0;
        for (let q = k + 1; q < p.steps.length && p.steps[q] <= p.steps[k] + 24; q++) { const amt = (p.tp6 && p.tp6[q]) || 0; if (b.ptype[q] === "snow") snow24 += amt; else if (b.ptype[q] === "mixed") { snow24 += amt / 2; rain24 += amt / 2; } else rain24 += amt; }
        return `<tr><td class="name">${name}<small>${W().units.alt(z).txt}</small></td><td><b>${t == null ? "—" : W().units.temp(t).v + "°"}</b></td><td>${w == null ? "—" : `<i style="display:inline-block;width:8px;height:8px;border-left:1.5px solid currentColor;border-top:1.5px solid currentColor;${W().arrowRot(dir)};margin-right:4px"></i>${Math.round(speed(w))} ${speedUnit()}`}</td><td>${pty ? `<span class="pill ${pty}">${pty}</span>` : "<span class=dim>—</span>"}</td><td>${snow24 >= 0.5 ? `<span class="pill snow">${W().units.snow(snow24).txt}</span>` : rain24 >= 0.5 ? `<span class="pill rain">${W().units.precip(rain24).txt}</span>` : "<span class=dim>·</span>"}</td></tr>`;
      }).join("");
      const fl = p.freezing_level_m ? p.freezing_level_m[k] : null;
      const snow72 = (() => { let s3 = 0; const b = p.bands[p.bands.length - 1]; for (let q = k + 1; q < p.steps.length && p.steps[q] <= p.steps[k] + 72; q++) if (b.ptype[q] === "snow") s3 += (p.tp6 && p.tp6[q]) || 0; return s3; })();
      bandsHtml = `<div class="snowline"><span>freezing level <b>${fl != null ? W().units.alt(fl).txt : "—"}</b></span><span>peak snow 72 h <b>${W().units.snow(snow72).txt}</b></span><span>lifts mapped <b>${lifts}</b></span></div>
        <table class="bands"><thead><tr><th>Band</th><th>Temp</th><th>Wind</th><th>Precip type</th><th>Next 24 h</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="board-head"><span>Morning / afternoon / night</span></div>${bandTable(p, P.bands.slice().reverse())}`;
    }
    $("#resort").innerHTML = `<div class="avy-head" style="margin-top:6px"><span>${esc(r.name)} <span class="dim">· ${esc(r.region || "")} ${esc(r.country || "")}</span></span>${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener">site ↗</a>` : ""}</div>
      ${bandsHtml}
      <div class="note">Whistler-Peak-style read for any resort: temperature and wind at each elevation band come from the model's pressure levels interpolated to that height; precip type per band from the band temperature; snowfall uses a 10:1 ratio. Base/summit from OSM tags, our seed list, or a DEM at the lift ends. Lifts drawn from OpenStreetMap; live lift status and webcams are per-resort feeds we don't have.</div>`;
  }

  // ── meteogram (Now pane) ─────────────────────────────────────────────
  function drawMeteogram(d, i) {
    const { speed, speedUnit, state } = W();
    const U = W().units;
    const c = $("#meteogram"), ctx = c.getContext("2d");
    const W_ = c.width, H = c.height, padL = 34, padR = 40, padT = 12, padB = 26;
    ctx.clearRect(0, 0, W_, H);
    const n = d.steps.length, xs = d.steps.map((_, k) => padL + (W_ - padL - padR) * k / (n - 1));
    const t = (d.series.t2m || []).map((v) => v == null ? null : U.temp(v).v);
    const rawRain = d.series.tp6 || [], snow = d.series.sf6 || [];
    const rain = rawRain.map((v) => v == null ? null : U.precip(v).v);
    const windS = (d.series.wind || []).map((v) => v == null ? null : speed(v));
    const rMax = Math.max(U.precipUnit === "in" ? 0.2 : 5, ...rain.filter((v) => v != null));
    rain.forEach((v, k) => { if (v == null) return; const h = (H - padT - padB) * v / rMax; const bw = Math.max(2, (W_ - padL - padR) / n - 2); ctx.fillStyle = (snow[k] || 0) > ((rawRain[k] || 0) * 0.5) ? "rgba(200,220,255,0.7)" : "rgba(108,182,255,0.55)"; ctx.fillRect(xs[k] - bw / 2, H - padB - h, bw, h); });
    const tv = t.filter((v) => v != null);
    if (tv.length) {
      const tempStep = U.tempUnit === "°F" ? 10 : 5;
      const lo = Math.floor(Math.min(...tv) / tempStep) * tempStep - 2, hi = Math.ceil(Math.max(...tv) / tempStep) * tempStep + 2;
      const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
      ctx.strokeStyle = "rgba(255,180,84,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      for (let g = lo; g <= hi; g += tempStep) { ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W_ - padR, y(g)); ctx.stroke(); }
      const freeze = U.tempC(0).v;
      if (lo < freeze && hi > freeze) { ctx.setLineDash([]); ctx.strokeStyle = "rgba(200,220,255,0.5)"; ctx.beginPath(); ctx.moveTo(padL, y(freeze)); ctx.lineTo(W_ - padR, y(freeze)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2; ctx.beginPath();
      t.forEach((v, k) => { if (v == null) return; k === 0 ? ctx.moveTo(xs[k], y(v)) : ctx.lineTo(xs[k], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "#ffb454"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "right";
      ctx.fillText(`${hi.toFixed(0)}°`, padL - 4, y(hi) + 4); ctx.fillText(`${lo.toFixed(0)}°`, padL - 4, y(lo) + 4);
    }
    const wv = windS.filter((v) => v != null);
    if (wv.length) {
      const hi = Math.max(state.units === "ms" ? 6 : 20, Math.ceil(Math.max(...wv) / 10) * 10);
      const y = (v) => padT + (H - padT - padB) * (1 - v / hi);
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.2; ctx.beginPath();
      windS.forEach((v, k) => { if (v == null) return; k === 0 ? ctx.moveTo(xs[k], y(v)) : ctx.lineTo(xs[k], y(v)); });
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.textAlign = "left"; ctx.font = "600 11px 'Geist Mono', ui-monospace, monospace";
      ctx.fillText(`${hi} ${speedUnit()}`, W_ - padR + 4, y(hi) + 4);
      ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillText(`${rMax.toFixed(U.precipUnit === "in" ? 1 : 0)} ${U.precipUnit}`, W_ - padR + 4, padT + 18);
    }
    ctx.fillStyle = "#7f8794"; ctx.font = "500 10.5px 'Geist Mono', ui-monospace, monospace"; ctx.textAlign = "left";
    let lastDay = null;
    d.valid.forEach((iso, k) => { const dt = new Date(iso), day = dt.toDateString(); if (day !== lastDay) { lastDay = day; ctx.fillRect(xs[k], padT, 1, H - padT - padB); ctx.fillText(dt.toLocaleDateString(undefined, { weekday: "short" }), xs[k] + 3, H - 8); } });
    ctx.fillStyle = "rgba(108,182,255,0.9)"; ctx.fillRect(xs[i] - 1, padT, 2, H - padT - padB);
    c.onclick = (ev) => { const rect = c.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W_; let best = 0; xs.forEach((xx, k) => { if (Math.abs(xx - x) < Math.abs(xs[best] - x)) best = k; }); W().setStep(best); };
  }

  window.WXPanes = { render, sunTimes };
})();
