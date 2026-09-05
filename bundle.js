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
      // World zooms pack the same particle count onto smaller features and
      // the field reads denser than it is — thin the deal below z5.
      const zc = this.map ? Math.max(0.7, Math.min(1, this.map.getZoom() / 5)) : 1;
      const n = Math.max(0, Math.min(9800, Math.round(base * zc * this.density * 0.014)));
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
      // A fast, chained scroll-zoom never reaches moveend while it runs, so
      // the moveend reseed can't fire and the old particles stay packed in
      // the OLD viewport — the bright rectangle mid-ocean. Re-deal mid-flight
      // whenever the view has left the seeded zoom behind; reseed() records
      // the new zoom, so this self-throttles to once per 0.7 levels.
      if (this._seedZoom != null && Math.abs(zoom - this._seedZoom) > 0.7) this.reseed();
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
      // Constant px/s reads frantic at world zoom: the features shrink but
      // the pixels per second don't, and half a hemisphere is jet stream, so
      // most particles ride the step cap. Ease the rate down below z5 and the
      // cap with it — a hemisphere breathes, a bay keeps its full speed.
      const zf = Math.max(0.35, Math.min(1, Math.pow(2, (zoom - 5) / 2)));
      const stepCap = MAX_STEP_PX * Math.max(0.5, zf);
      const speed = 9.0 * zf / pxPerDeg;         // deg/s per m/s (before the cos-lat correction)
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
        if (screenStep > stepCap) {
          const scale = stepCap / screenStep;
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
      if (this._pinchWait) { clearInterval(this._pinchWait); this._pinchWait = null; }
      if (this._watch) { clearInterval(this._watch); this._watch = null; }
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
    { key: "msl", label: "Pressure", layers: ["msl", "ptend", "gh"], variants: { msl: "MSL", ptend: "Change", gh: "Height" } },
    { key: "hum", label: "Humidity", layers: ["rh", "d2m"], variants: { rh: "RH %", d2m: "Dew pt" } },
    { key: "cape", label: "CAPE", layers: ["cape"] },
    { key: "vis", label: "Visibility", layers: ["vis"] },
    { key: "cbase", label: "Cloud base", layers: ["cbase"] },
    { key: "vort", label: "Vorticity", layers: ["vort500"] },
    { key: "uvi", label: "UV index", layers: ["uvi"] },
    { key: "solar", label: "Solar power", layers: ["solar"] },
    { key: "waves", label: "Waves", layers: ["waves", "swell", "windsea", "wperiod", "pp1d", "wavepower"], variants: { waves: "Height", swell: "Swell", windsea: "Wind sea", wperiod: "Period", pp1d: "Peak", wavepower: "Power" }, section: "Sea" },
    { key: "sst", label: "Sea temp", layers: ["sst"] },
    // member counts, drawn from the GEFS run only — the one model that has them
    { key: "chance", label: "Chance", layers: ["prob_rain", "prob_gust"], variants: { prob_rain: "Rain", prob_gust: "Gale" }, section: "Ensemble" },
  ];
  const familyOf = (layer) => FAMILIES.find((f) => f.layers.includes(layer)) || FAMILIES[0];
  // Winter mode is a focused workspace, not another meteorological field.
  // Keep the useful mountain layers in an intentional order and leave ocean,
  // convection and ensemble furniture one tap away by turning the mode off.
  const WINTER_FAMILY_ORDER = ["snow", "sd", "frz", "ptype", "rain", "temp", "wind", "gust", "tcc", "fog"];
  const WINTER_LAYER_PREFERENCE = ["sf72", "sf24", "sf6", "sd_cm", "ptype", "frz", "temp"];
  // Every layer the rail can reach. Derived from FAMILIES rather than kept as
  // a second list: the hand-written one had gone stale, so a permalink to
  // visibility, sea temp, precip type or vorticity quietly landed on wind.
  const LAYERS = FAMILIES.flatMap((f) => f.layers);
  const LAYER_LABEL = { wind: "Wind", gust: "Gusts", temp: "Temp", feels: "Feels like", prob_rain: "Rain chance", prob_gust: "Gale chance", gfactor: "Gust factor", vis: "Visibility", sst: "Sea temp", ptype: "Precip type", vort500: "Vorticity 500", ptend: "Pressure change", gh: "Height", cbase: "Cloud base", wbt: "Wet-bulb", dt24: "Temp Δ 24h", msl: "Pressure", tp6: "Rain 6h", tp24: "Rain 24h", tp72: "Rain 72h", sf6: "New snow 6h", sf24: "New snow 24h", sf72: "New snow 72h", sd_cm: "Snow depth", tcc: "Total cloud", cloudlow: "Low cloud", cloudmid: "Mid cloud", cloudhigh: "High cloud", fog: "Fog potential", solar: "Solar power", cape: "CAPE", d2m: "Dew point", rh: "Humidity", frz: "Freezing lvl", waves: "Waves", swell: "Swell", windsea: "Wind sea", wperiod: "Wave period", pp1d: "Peak period", wavepower: "Wave power", uvi: "UV index" };
  const LAYER_ALPHA = { wind: 0.62, gust: 0.62, temp: 0.78, msl: 0.72, tp6: 0.9, tp24: 0.9, tp72: 0.9, sf6: 0.9, sf24: 0.9, sf72: 0.9, sd_cm: 0.85, tcc: 0.9, cloudlow: 0.85, cloudmid: 0.85, cloudhigh: 0.85, fog: 0.85, solar: 0.82, cape: 0.85, d2m: 0.75, rh: 0.75, frz: 0.7, waves: 0.8, swell: 0.8, windsea: 0.8, wperiod: 0.8, pp1d: 0.8, wavepower: 0.82, uvi: 0.8, feels: 0.78, prob_rain: 0.82, prob_gust: 0.82, vis: 0.85, sst: 0.8, ptype: 0.85, gfactor: 0.78, vort500: 0.75, ptend: 0.8, gh: 0.72, cbase: 0.75, wbt: 0.78, dt24: 0.8 };
  const LAYER_ICON = {
    iso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c5.5 0 8.9 3.5 8.4 8.5-.5 5-3.9 8.5-8.9 8.5S3.1 17 3.6 12 6.5 3.5 12 3.5z"/><path d="M12 8c3 0 5 1.5 4.7 4-.3 2.5-2.2 4-4.7 4s-4.7-1.5-4.4-4C7.9 9.5 9.5 8 12 8z"/><path d="M12 11.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/></svg>',
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
  const LEVEL_FT = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "FL180", 400: "FL240", 300: "FL300", 250: "FL340", 200: "FL390", 150: "FL450", 100: "FL530" };
  const LEVEL_FEET = { 1000: "≈350 ft", 925: "2.5k ft", 850: "5k ft", 700: "10k ft", 600: "14k ft", 500: "18k ft", 400: "24k ft", 300: "30k ft", 250: "34k ft", 200: "39k ft", 150: "45k ft", 100: "53k ft" };
  const LEVEL_M = { 1000: "≈100 m", 925: "≈750 m", 850: "≈1.5 km", 700: "≈3 km", 600: "≈4.2 km", 500: "≈5.5 km", 400: "≈7.2 km", 300: "≈9 km", 250: "≈10.5 km", 200: "≈12 km", 150: "≈13.6 km", 100: "≈16 km" };
  const levelBadge = (level) => {
    const system = WX.units && WX.units.pref.baro || "metric";
    const labels = system === "flight" ? LEVEL_FT : system === "feet" ? LEVEL_FEET : LEVEL_M;
    return (labels[level] || "").replace(/^≈/, "");
  };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const AVY_COLORS = { 0: "#8a8f98", 1: "#50b848", 2: "#fff200", 3: "#f7941e", 4: "#ed1c24", 5: "#231f20" };

  // Embed mode (?embed=1): the map, the legend and the clock, nothing else.
  // For iframes on other pages; the brand link opens the full app on the
  // same view. Set before anything measures the chrome.
  const EMBED = new URLSearchParams(location.search).get("embed") === "1";
  if (EMBED) document.body.classList.add("embed");
  const state = {
    model: null, run: null, layer: "wind", level: 0, stepIdx: 0,
    // where the map sits BETWEEN stepIdx and the next step, 0..1. Only the
    // GPU field path can draw it; the raster path rounds it away.
    frac: 0,
    playing: false, particles: true, units: localStorage.getItem("wxgrid.units") || "kmh",
    point: null, tapePoint: null, tab: "now",
    radar: false, radarFrames: [], radarIdx: 0, radarHost: "",
    iso: false, avy: false, resorts: false, resort: null, measure: false,
    winterMode: localStorage.getItem("wxgrid.winterMode") === "1",
    alerts: false, storms: false, sat: false, barbs: false, smoke: false, fires: false, quakes: false, aod: false, thunder: false, obs: false,
    sigmet: false, aurora: false, lightning: false, aq: false, route: false,
    probeChip: localStorage.getItem("wxgrid.probe") === "1",
    base: localStorage.getItem("wxgrid.base") || "", night: false,
    terrain: localStorage.getItem("wxgrid.terrain") === "1", aqVar: localStorage.getItem("wxgrid.aqVar") || "pm2_5",
    opacity: Number(localStorage.getItem("wxgrid.opacity") || 100),
    particleDensity: Number(localStorage.getItem("wxgrid.particleDensity") || 60), xsection: false,
    playMs: Number(localStorage.getItem("wxgrid.playMs") || 900),
  };
  let map, wind, catalog, playTimer = null, playRaf = 0, playFrom = 0, marker = null;
  let restorePointPanelSize = () => {};
  let restoreSheetHeight = () => {};
  let focusMobileSheet = () => {};
  let pointTapeReturn = null;
  let uiWired = false;
  let setTapeState = () => {};
  let tapeState = "full";
  const nextTapeState = () => ({ full: "mini", mini: "away", away: "full" })[tapeState] || "full";

  // ── shared helpers (used by panes.js) ────────────────────────────────
  const speed = (ms) => ms == null ? null : state.units === "kt" ? ms * 1.943844 : state.units === "ms" ? ms : state.units === "mph" ? ms * 2.236936 : ms * 3.6;
  const speedUnit = () => ({ kmh: "km/h", kt: "kt", ms: "m/s", mph: "mph" }[state.units]);
  // Forecast direction is where the wind comes FROM; the needle points where
  // it is going.  Its SVG points north before rotation, so no mystery 45°
  // compensation belongs here.
  const arrowRot = (deg) => `transform: rotate(${(deg + 180) % 360}deg)`;
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
                   renderTapePill: () => renderTapePill(),
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
    // No WebGL — a locked-down laptop, a remote desktop, a headless browser —
    // used to kill the whole app before the card opened: MapLibre came up
    // with no painter and the first map call threw on null. The forecast does
    // not need the map. A shim answers every map call inertly, the map pane
    // says why it is blank, and the tape, card and search carry on.
    map = hasWebGL() ? new maplibregl.Map({
      container: "map", style: mapStyle(),
      center: hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], zoom: hash ? hash.zoom : saved && currentMapScale ? saved.zoom : defaultZoom,
      // Past z11 the field is one world-sized image being stretched, and what
      // you actually want is the ground: streets, lifts, runs. So the map keeps
      // zooming to where the basemap still has detail, and the field steps back.
      minZoom: 1.2, maxZoom: 15, attributionControl: false, renderWorldCopies: true, fadeDuration: 0,
    }) : noMap(hash ? [hash.lon, hash.lat] : saved ? saved.center : [-123, 47], hash ? hash.zoom : defaultZoom);
    if (map.noMap) { document.body.classList.add("no-map"); toast("No WebGL here: the map is off, the forecast still works", 9000); }
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
      renderTapePill();
      if (WX.provider) WX.provider.refresh();
      if (state.radar && WX.ov.refreshRadarSource) WX.ov.refreshRadarSource();
      if (state.obs && WX.ov.refreshObs) WX.ov.refreshObs();
      pushHash();
    });
    wind = map.noMap ? { setDensity() {}, setEnabled() {}, setField() {}, setMode() {} } : new WindLayer(map, $("#particles"));
    if (WX.probe && WX.probe.wireCityValues) WX.probe.wireCityValues();
    WX.windLayer = wind;
    wind.setDensity(state.particleDensity);
    // A taller tape leaves less room for a hand-sized card, so re-clamp it —
    // but never mid-drag, where it would fight the pointer.
    const liveTimebar = $("#timebar");
    new ResizeObserver(() => {
      const dragging = document.body.classList.contains("resizing-tape");
      const animating = liveTimebar.classList.contains("tape-anim");
      // Dragging writes the live height itself. During a state glide the
      // observer only moves dependent panels; fitting the strip and
      // reclamping the card on every animation frame was the remaining jank.
      if (!dragging) document.documentElement.style.setProperty("--tb-h", liveTimebar.offsetHeight + "px");
      if (dragging || animating) return;
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      restorePointPanelSize();
    }).observe(liveTimebar);
    new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $("#topbar").offsetHeight + "px")).observe($("#topbar"));
    wirePanelResizers();

    catalog = await WX.api(`${API}/models?ts=${Date.now()}`);
    if (catalog.static) toast(`Static demo · run ${catalog.static.built}Z`, 9000);
    const withRuns = catalog.models.filter((m) => m.runs.length);
    if (!withRuns.length) { toast("No model runs yet", 8000); return; }
    const pref = localStorage.getItem("wxgrid.model");
    state.model = (withRuns.find((m) => m.key === pref) || withRuns[0]).key;
    state.run = modelEntry().runs[0].run;
    state.layer = localStorage.getItem("wxgrid.layer") || "wind";
    if (!runEntry().layers.includes(state.layer)) state.layer = state.winterMode ? preferredWinterLayer(runEntry().layers) : runEntry().layers[0];

    if (hash) { if (hash.model && catalog.models.some((m) => m.key === hash.model && m.runs.length)) state.model = hash.model; if (hash.layer && LAYERS.includes(hash.layer)) state.layer = hash.layer; state.level = hash.level || 0; state.run = modelEntry().runs[0].run; if (hash.step != null) state.stepIdx = Math.min(hash.step, steps().length - 1); }
    if (state.winterMode) {
      const allowed = WINTER_FAMILY_ORDER.includes(familyOf(state.layer).key) && runEntry().layers.includes(state.layer);
      if (!allowed) state.layer = preferredWinterLayer(runEntry().layers);
      state.base = "topo";
      state.terrain = true;
      state.resorts = true;
      state.avy = true;
    }
    // A fresh load opens at the current hour, whatever the link said — the
    // map should show now, not the run's first frame (Jeff 2026-08-22).
    state.stepIdx = currentStepIdx();
    // One decision, before the first frame: colour on the GPU from the field
    // files, or take the server's coloured PNGs. Everything downstream reads
    // WX.field.live and nothing asks twice. It runs here, after the model and
    // run are settled, because giving up has to be able to draw the raster.
    if (WX.field) { WX.field.onFallback = fieldGaveUp; WX.field.enable(catalog); }
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
      const owned = ["fire-inc", "fire-perim-fill", "sigmet-fill", "quakes", "storm-pts", "storm-now", "storm-eye"].filter(has);
      if (owned.length && map.queryRenderedFeatures(e.point, { layers: owned }).length) return;
      const feats = map.queryRenderedFeatures(e.point, { layers: ["resort-icon", "resort-pts", "resort-all-pts", "avy-fill"].filter(has) });
      const resort = feats.find((x) => ["resort-icon", "resort-pts", "resort-all-pts"].includes(x.layer.id));
      if (resort) { WX.ov.selectResort(resort.properties.id); return; }
      openPoint(e.lngLat.lat, e.lngLat.lng);
      const avy = feats.find((x) => x.layer.id === "avy-fill");
      if (avy) { state.tab = "winter"; }
    });
    map.on("mousemove", (e) => {
      // iPadOS reports its primary input as touch even while a trackpad is
      // moving the MapLibre mouse cursor. Judge this event, not the device;
      // only the synthetic mouse event emitted by an actual touch is ignored.
      const oe = e.originalEvent;
      const fromTouch = !!(oe && ((oe.pointerType && oe.pointerType !== "mouse")
        || (oe.sourceCapabilities && oe.sourceCapabilities.firesTouchEvents)));
      if (WX.probe && state.probeChip) WX.probe.hover(fromTouch ? null : e.lngLat);
    });
    map.on("mouseout", () => { if (WX.probe) WX.probe.hover(null); });
    map.on("moveend", () => { if (WX.provider) WX.provider.refresh(); });
    map.on("mouseenter", "resort-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-pts", () => map.getCanvas().style.cursor = "");
    map.on("mouseenter", "resort-all-pts", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-all-pts", () => map.getCanvas().style.cursor = "");
    map.on("mouseenter", "resort-icon", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "resort-icon", () => map.getCanvas().style.cursor = "");

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
          const h = steps()[(state.stepIdx + 1) % steps().length];
          if (fieldLive()) WX.field.prefetch(fieldUrl(h));
          else { const img = new Image(); img.src = layerUrl(h); }
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
  // Streets is a whole style (OpenFreeMap Liberty: every road class, names,
  // shields), not a raster under the vector map like Topo/Satellite.
  const STREETS_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const mapStyle = () => state.base === "streets" ? STREETS_STYLE
    : document.documentElement.dataset.theme === "light" ? "https://tiles.openfreemap.org/styles/positron" : "https://tiles.openfreemap.org/styles/dark";
  // A 1x1 transparent PNG. On the GPU path the raster layer draws nothing, but
  // it stays in the style on purpose: it is the layer overlays.js dims for
  // radar and satellite, and the one the field shader reads its opacity back
  // from. Pointing its source here means no layer PNG is ever fetched.
  const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==";
  const fieldLive = () => !!(WX.field && WX.field.live);
  function ensureWxLayer() {
    if (!map.getSource("wx")) {
      const gpu = fieldLive();
      map.addSource("wx", { type: "image", url: gpu ? BLANK : layerUrl(), coordinates: modelCoords() });
      map.addLayer({ id: "wx", type: "raster", source: "wx",
                     layout: { visibility: gpu ? "none" : "visible" },
                     paint: { "raster-opacity": rasterOpacity(), "raster-fade-duration": 0, "raster-resampling": "linear" } }, firstSymbolId());
      // Directly above the raster, so the coastline trace and everything the
      // overlays put before the first symbol layer still land on top.
      if (gpu && !map.getLayer("wx-field")) map.addLayer(WX.field.layer, firstSymbolId());
    }
    ensureCoastLayer();
    // roads and borders back on top of the field, with halos (overlays.js)
    if (WX.ov && WX.ov.boostBasemap) WX.ov.boostBasemap();
  }
  // The GPU path can give up at any point: no WebGL, a shader that will not
  // compile, a field the server does not have. Put the raster layer back and
  // carry on where it left off.
  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); }
    catch (e) { return false; }
  }
  // The map that is not there. Same surface app.js and the overlays call,
  // answers that keep them quiet: no layers, no features, a centre and zoom
  // it remembers, a flat equirectangular project/unproject over the pane so
  // the probe and the marker land somewhere sane. `style.load` and `load`
  // fire once so the boot sequence that waits on them proceeds.
  function noMap(center, zoom) {
    const el = $("#map"); const handlers = {}; let c = { lng: center[0], lat: center[1] }, z = zoom;
    const emit = (ev) => (handlers[ev] || []).slice().forEach((h) => { try { h({ target: shim }); } catch (e) { console.warn(e); } });
    const size = () => ({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    const bounds = () => { const { w, h } = size(); const dpp = 360 / (256 * Math.pow(2, z)); return { west: c.lng - w / 2 * dpp, east: c.lng + w / 2 * dpp, south: c.lat - h / 2 * dpp, north: c.lat + h / 2 * dpp }; };
    const shim = {
      noMap: true,
      on(ev, a, b) { (handlers[ev] = handlers[ev] || []).push(typeof a === "function" ? a : b); return shim; },
      once(ev, a, b) { const h = typeof a === "function" ? a : b; const w = (e) => { shim.off(ev, w); h(e); }; return shim.on(ev, w); },
      off(ev, a, b) { const h = typeof a === "function" ? a : b; handlers[ev] = (handlers[ev] || []).filter((x) => x !== h); return shim; },
      getCenter: () => ({ lng: c.lng, lat: c.lat, toArray: () => [c.lng, c.lat] }),
      getZoom: () => z, isMoving: () => false, isStyleLoaded: () => true, loaded: () => true,
      getProjection: () => ({ type: "mercator" }), setProjection() {}, setStyle() { setTimeout(() => emit("style.load"), 0); },
      getStyle: () => ({ layers: [], sources: {} }), getLayer: () => undefined, getSource: () => undefined,
      addLayer() {}, removeLayer() {}, addSource() {}, removeSource() {}, addImage() {}, hasImage: () => false,
      setLayoutProperty() {}, setPaintProperty() {}, getPaintProperty: () => undefined, setFilter() {}, setLayerZoomRange() {},
      queryRenderedFeatures: () => [], triggerRepaint() {}, resize() {}, remove() {}, addControl() {}, removeControl() {},
      // what Marker and Popup ask their map for on addTo()
      _getUIString: (k) => k, _requestRenderFrame: () => 0, _cancelRenderFrame() {}, getPitch: () => 0, getBearing: () => 0,
      getMaxPitch: () => 0, getTerrain: () => null, transform: { width: 800, height: 600 },
      getContainer: () => el, getCanvasContainer: () => el, getCanvas: () => el.querySelector("canvas") || Object.assign(document.createElement("canvas"), { width: size().w, height: size().h }),
      getBounds() { const b = bounds(); return { getWest: () => b.west, getEast: () => b.east, getSouth: () => b.south, getNorth: () => b.north, toArray: () => [[b.west, b.south], [b.east, b.north]] }; },
      project(ll) { const b = bounds(), { w, h } = size(); const lng = Array.isArray(ll) ? ll[0] : ll.lng, lat = Array.isArray(ll) ? ll[1] : ll.lat; return { x: (lng - b.west) / (b.east - b.west) * w, y: (b.north - lat) / (b.north - b.south) * h }; },
      unproject(pt) { const b = bounds(), { w, h } = size(); const x = Array.isArray(pt) ? pt[0] : pt.x, y = Array.isArray(pt) ? pt[1] : pt.y; return { lng: b.west + x / w * (b.east - b.west), lat: b.north - y / h * (b.north - b.south) }; },
      jumpTo(o) { if (o.center) c = { lng: o.center[0] ?? o.center.lng, lat: o.center[1] ?? o.center.lat }; if (o.zoom != null) z = o.zoom; emit("move"); emit("moveend"); },
      flyTo(o) { shim.jumpTo(o); }, easeTo(o) { shim.jumpTo(o); }, fitBounds() { emit("moveend"); },
    };
    // Markers, popups and controls are MapLibre objects that reach into the
    // real map's transform on addTo(); with no map they become inert
    // stand-ins with the same chainable surface, so route pins, the probe
    // pin and quake popups neither draw nor throw.
    const inert = class { constructor(o) { this._el = (o && o.element) || document.createElement("div"); this._ll = { lng: 0, lat: 0 }; }
      setLngLat(ll) { this._ll = Array.isArray(ll) ? { lng: ll[0], lat: ll[1] } : ll; return this; } getLngLat() { return this._ll; }
      addTo() { return this; } remove() { return this; } getElement() { return this._el; } on() { return this; } off() { return this; }
      setDraggable() { return this; } setOffset() { return this; } setHTML() { return this; } setDOMContent() { return this; }
      setText() { return this; } isOpen() { return false; } setMaxWidth() { return this; } toggleClassName() { return this; }
      addClassName() { return this; } removeClassName() { return this; } getPopup() { return null; } setPopup() { return this; }
      togglePopup() { return this; } setRotation() { return this; } onAdd() { return document.createElement("div"); } onRemove() {} };
    maplibregl.Marker = inert; maplibregl.Popup = inert; maplibregl.AttributionControl = inert; maplibregl.NavigationControl = inert; maplibregl.ScaleControl = inert;
    el.innerHTML = `<div class="nomap"><b>Map unavailable</b><span>This browser has no WebGL, so the map is off. Search a place or use the tape and card — the forecast is all here.</span></div>`;
    setTimeout(() => { emit("style.load"); emit("load"); }, 0);
    return shim;
  }
  function fieldGaveUp() {
    if (!map || !catalog || !state.model) return;         // gave up before the first frame
    state.stepIdx = Math.min(steps().length - 1, state.stepIdx + Math.round(state.frac));
    state.frac = 0;
    if (map.getLayer("wx-field")) map.removeLayer("wx-field");
    if (map.getLayer("wx")) map.setLayoutProperty("wx", "visibility", "visible");
    if (catalog) { renderControls(); applyStep(); }
    if (WX.probe) WX.probe.refresh();
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
      const brand = $("#embed-brand");
      if (brand) brand.href = location.origin + location.pathname + ownHash;
      history.replaceState(null, "", ownHash);
    }, 250);
  }

  // One share action behind both entry points: the tools menu row and the
  // point card's icon. pushHash debounces by 250 ms, so the URL is given a
  // moment to become the view before it is read back and copied.
  async function shareLink() {
    pushHash();
    await new Promise((r) => setTimeout(r, 300));
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (e) {
      // No clipboard: an insecure origin, a permissions policy, or an old
      // browser. A prompt is the last place the user can still select the
      // link by hand — a toast this long only overflows the pill.
      try { window.prompt("Copy this link", url); } catch (e2) { toast("Copy failed", 4000, "error"); }
    }
  }

  // ── catalog helpers ───────────────────────────────────────────────────
  const modelEntry = () => catalog.models.find((m) => m.key === state.model);
  const runEntry = () => modelEntry().runs.find((r) => r.run === state.run) || modelEntry().runs[0];
  const steps = () => runEntry().steps;
  const stepHours = () => steps()[state.stepIdx];
  // The forecast hour the map is actually showing. Whole steps are the only
  // ones the model published, so they are the only ones a URL names; the
  // fraction is what the field layer is mixing towards.
  function shownHours() {
    const st = steps(), i = Math.min(state.stepIdx, st.length - 1);
    const next = i + 1 < st.length ? st[i + 1] : st[i];
    return st[i] + (next - st[i]) * state.frac;
  }
  const runDate = () => new Date(runEntry().valid_from);
  const validDate = () => new Date(runDate().getTime() + shownHours() * 3600e3);
  const hasLevel = () => ["wind", "temp", "gh"].includes(state.layer);
  const isWaves = () => ["waves", "swell", "windsea", "wperiod", "pp1d", "wavepower"].includes(state.layer);
  const levelQ = () => (state.level && hasLevel()) ? `?level=${state.level}` : "";
  const layerUrl = (h = stepHours()) => U(`${API}/layer/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  // The same frame as data. Same query, same run, different noun: the browser
  // colours this one itself (front/field.js).
  const fieldUrl = (h = stepHours()) => U(`${API}/field/${state.model}/${state.run}/${h}/${state.layer}.png${levelQ()}`);
  // What the field layer should be drawing right now: this step, the next one,
  // and how far between them the timeline is sitting.
  function fieldSpec() {
    const st = steps(), i = Math.min(state.stepIdx, st.length - 1);
    const next = i + 1 < st.length ? st[i + 1] : null;
    return { a: fieldUrl(st[i]), b: next == null ? null : fieldUrl(next),
             t: next == null ? 0 : state.frac, layer: state.layer,
             level: hasLevel() ? state.level : 0, model: modelEntry() };
  }
  const windUrl = (h = stepHours()) => U(`${API}/wind/${state.model}/${state.run}/${h}.json${isWaves() ? "?field=waves" : state.level ? `?level=${state.level}` : ""}`);

  const modelCoords = (m = modelEntry()) => {
    if (!m || !m.regional) return WORLD;
    const [w, s, e, n] = m.domain;
    return [[w, n], [e, n], [e, s], [w, s]];
  };
  // A regional model is offered when its grid covers a real part of what you
  // are looking at — not when the map CENTRE happens to sit inside it. The
  // centre test disabled HRRR the moment you panned a little south, with most
  // of the continental grid still on screen (Jeff 2026-08-25: "HRRR is not
  // loading"); one degree of pan flipped a model on and off. Rendering already
  // clips to the domain, so a partly-covered view draws the part it has.
  const modelInView = (m) => {
    if (!m || !m.regional || !map) return true;
    const [w, s, e, n] = m.domain;
    const c = map.getCenter();
    if (c.lat >= s && c.lat <= n) { const lo = wlon(c.lng); if (lo >= w && lo <= e) return true; }
    let b;
    try { b = map.getBounds(); } catch { return false; }
    if (!b) return false;
    const vs = b.getSouth(), vn = b.getNorth(), vw = b.getWest(), ve = b.getEast();
    const latOverlap = Math.min(vn, n) - Math.max(vs, s);
    if (latOverlap <= 0) return false;
    // A view wider than the world, or one wrapped past the antimeridian, has
    // no meaningful west/east span to intersect — fall back to latitude alone.
    const lonOverlap = (ve - vw >= 360 || ve < vw)
      ? e - w : Math.min(ve, e) - Math.max(vw, w);
    if (lonOverlap <= 0) return false;
    // Ignore a sliver at the edge of the screen: a model worth switching to
    // has to cover enough of the view to be worth looking at.
    const area = (latOverlap * lonOverlap) /
                 Math.max(1e-9, (vn - vs) * Math.min(360, ve - vw));
    return area >= 0.12;
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
  let levelApply = 0;
  const LEVEL_SLIDE_MS = 260;          // the plate's .24s slide, plus a frame
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

  const preferredWinterLayer = (avail) => WINTER_LAYER_PREFERENCE.find((l) => avail.includes(l)) || avail[0];
  function syncWinterUI() {
    document.body.classList.toggle("winter-mode", state.winterMode);
    const canonical = $("#winter-toggle");
    if (canonical) {
      canonical.classList.toggle("on", state.winterMode);
      canonical.setAttribute("aria-pressed", state.winterMode ? "true" : "false");
    }
    const railButton = document.querySelector('[data-rail="winter"]');
    if (railButton) {
      railButton.classList.toggle("on", state.winterMode);
      railButton.setAttribute("aria-pressed", state.winterMode ? "true" : "false");
    }
    $$(".base-row button").forEach((b) => b.classList.toggle("on", b.dataset.base === state.base));
    const terrain = $("#terrain-toggle"), resorts = $("#resorts-toggle"), avy = $("#avy-toggle");
    if (terrain) terrain.classList.toggle("on", state.terrain);
    if (resorts) resorts.classList.toggle("on", state.resorts);
    if (avy) avy.classList.toggle("on", state.avy);
  }
  function applyWinterMapState() {
    const apply = () => {
      WX.ov.setBase(state.base);
      if (state.terrain) WX.ov.loadTerrain(); else WX.ov.clearTerrain();
      if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts();
      if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy();
    };
    const styleExists = map && map.getStyle && (map.getStyle().layers || []).length;
    if (styleExists || (map && map.noMap)) apply();
    else if (map) map.once("style.load", apply);
  }
  function setWinterMode(on) {
    on = !!on;
    if (on === state.winterMode) return;
    if (on) {
      localStorage.setItem("wxgrid.winterReturn", JSON.stringify({
        layer: state.layer, base: state.base, terrain: state.terrain,
        resorts: state.resorts, avy: state.avy,
      }));
      state.winterMode = true;
      state.layer = preferredWinterLayer(runEntry().layers);
      state.base = "topo";
      state.terrain = true;
      state.resorts = true;
      state.avy = true;
    } else {
      let back = null;
      try { back = JSON.parse(localStorage.getItem("wxgrid.winterReturn") || "null"); } catch (_) { back = null; }
      state.winterMode = false;
      if (back) {
        state.layer = runEntry().layers.includes(back.layer) ? back.layer : runEntry().layers[0];
        state.base = ["", "topo", "sat", "streets"].includes(back.base) ? back.base : "";
        state.terrain = !!back.terrain;
        state.resorts = !!back.resorts;
        state.avy = !!back.avy;
      } else {
        // Be deterministic if storage was partially cleared while Winter mode
        // was active: returning to the normal map should actually return.
        state.layer = runEntry().layers.includes("wind") ? "wind" : runEntry().layers[0];
        state.base = "";
        state.terrain = false;
        state.resorts = false;
        state.avy = false;
      }
      localStorage.removeItem("wxgrid.winterReturn");
    }
    localStorage.setItem("wxgrid.winterMode", state.winterMode ? "1" : "0");
    localStorage.setItem("wxgrid.layer", state.layer);
    localStorage.setItem("wxgrid.base", state.base);
    localStorage.setItem("wxgrid.terrain", state.terrain ? "1" : "0");
    syncWinterUI();
    renderControls();
    applyStep();
    loadWind();
    applyWinterMapState();
    if (!state.resorts && state.resort) closePoint();
    toast(state.winterMode ? "Winter mode · snow, terrain, avalanche regions and resorts" : "Back to the full weather map", 3500);
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
    const shownFamilies = state.winterMode
      ? WINTER_FAMILY_ORDER.map((key) => FAMILIES.find((f) => f.key === key)).filter(Boolean)
      : FAMILIES;
    const winterSections = { snow: "Snow season", temp: "Mountain weather", tcc: "Cloud" };
    const railLabel = (full, phone = "") => phone
      ? `<span class="rail-label"><span class="rail-label-full">${full}</span><span class="rail-label-phone" aria-hidden="true">${phone}</span></span>`
      : `<span>${full}</span>`;
    const winterButton = `<button class="rail-flat rail-winter ${state.winterMode ? "on" : ""}" data-rail="winter" aria-label="Winter mode" aria-pressed="${state.winterMode ? "true" : "false"}" title="Show the snow-season map">${LAYER_ICON.sd_cm}${railLabel("Winter mode", "Winter")}</button>`;
    rail.innerHTML = shownFamilies.map((f) => {
      const ok = f.layers.some((l) => avail.includes(l));
      const on = f.key === fam.key;
      const section = state.winterMode ? winterSections[f.key] : f.section;
      return `${section ? `<div class="rail-sec">${section}</div>` : ""}<button class="${on ? "on" : ""}" data-family="${f.key}" aria-label="${f.label}" ${ok ? "" : "disabled"} title="${f.label}${ok ? "" : " (not in this model)"}">${LAYER_ICON[FAMILY_ICON[f.key]]}${railLabel(f.label, f.key === "ptype" ? "Precip" : "")}${f.variants ? `<i class="var">${f.variants[on ? state.layer : f.layers.find((l) => avail.includes(l)) || f.layers[0]] || ""}</i>` : ""}</button>${on && f.variants ? `<div class="rail-vars seg small" role="group" aria-label="${f.label} options">${f.layers.map((l) => `<button data-layer="${l}" class="${l === state.layer ? "on" : ""}" ${avail.includes(l) ? "" : "disabled"}>${f.variants[l]}</button>`).join("")}</div>` : ""}`;
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
        <span>Density</span><input type="range" min="0" max="100" step="5" value="${state.particleDensity}"><i>${state.particleDensity}%</i></label>
      <div class="rail-seg rail-run" title="Forecast run (UTC)">
        <span>Model run</span>
        <select id="rail-run">${modelEntry().runs.map((r) => `<option value="${r.run}"${r.run === state.run ? " selected" : ""}>${r.run.slice(5, 10)} · ${r.run.slice(11)}Z</option>`).join("")}</select>
      </div>
      <div class="rail-sec rail-winter-sec">Season</div>
      ${winterButton}`;
    const railRun = rail.querySelector("#rail-run");
    railRun.onchange = () => switchRun(railRun.value);
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
    const railWinter = rail.querySelector('[data-rail="winter"]');
    if (railWinter) railWinter.onclick = () => $("#winter-toggle").click();
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
    // The same options under the active family in the rail: Rain's 24 h and
    // 72 h windows were only in the time bar, where nobody looked for them
    // (Jeff 2026-08-23).
    rail.querySelectorAll(".rail-vars button").forEach((b) => b.onclick = () => { state.layer = b.dataset.layer; localStorage.setItem("wxgrid.layer", state.layer); localStorage.setItem("wxgrid.variant." + fam.key, state.layer); renderControls(); applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); });
    // On a phone the rail is a sideways strip and re-rendering it resets the
    // scroll: pick Waves, and the rail snaps back to Wind with the chip you
    // just chose — and its variants — a thousand pixels off screen. Scroll the
    // rail itself, never scrollIntoView: that walks every scrollable ancestor
    // and drags the page sideways under an overflow:hidden body.
    const railOn = rail.querySelector("button[data-family].on");
    if (railOn && rail.scrollWidth > rail.clientWidth + 1) {
      const r = railOn.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      if (r.left < rr.left + 8 || r.right > rr.right - 8) {
        rail.scrollLeft += (r.left + r.width / 2) - (rr.left + rr.width / 2);
      }
    }
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
      // The plate slides first, alone; the field swap (re-render, texture
      // upload, particle reseed) lands once it has stopped. Doing both in the
      // tap's frame made the slide stutter on a phone (Jeff 2026-09-05).
      lv.querySelectorAll("button").forEach((b) => b.onclick = () => {
        const level = Number(b.dataset.level);
        if (level === state.level) return;
        state.level = level;
        lv.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        if (lv._segPlace) lv._segPlace();
        clearTimeout(levelApply);
        levelApply = setTimeout(() => { renderControls(); applyStep(false); loadWind(false); if (state.iso) WX.ov.loadIso(); }, LEVEL_SLIDE_MS);
      });
    }

    const slider = $("#step");
    slider.max = String(steps().length - 1);
    // Dragging is continuous when the field layer can mix two steps, and the
    // release lands on a real one: the wind, the isobars and the tape all
    // belong to a step the model published, and a scrub that stopped between
    // them would leave the map ahead of everything else.
    slider.step = fieldLive() ? "0.02" : "1";
    slider.value = String(state.stepIdx + state.frac);
    slider.oninput = () => {
      const v = Number(slider.value), last = steps().length - 1;
      state.stepIdx = Math.min(last, Math.floor(v));
      state.frac = fieldLive() ? Math.min(0.999, v - state.stepIdx) : 0;
      applyStep(false);
    };
    slider.onchange = () => { settleStep(); applyStep(true); loadWind(); };

    renderLegend();
    if (!uiWired) { uiWired = true; wireOnce(); }
  }

  // Everything here binds once. It used to live at the tail of
  // renderControls, which runs on every model, level and layer change, so
  // every document listener stacked one copy per change: arrow keys stepped
  // twice, then three times, and the menu buttons toggled themselves shut.
  function wireOnce() {
    $("#play").onclick = togglePlay;
    // the minimized pill keeps a small play/pause of its own; it must not open the tape
    const pillPP = $("#tape-pill .pp"); if (pillPP) pillPP.onclick = (e) => { e.stopPropagation(); togglePlay(); };
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
    const TAPE_ANIM_MS = 380;
    setTapeState = (s, persist = true) => {
      if (phoneMQ.matches && state.point) {
        if (persist) pointTapeReturn = null;
        focusMobileSheet(s === "full");
      }
      const prev = tapeState;
      tapeState = s;
      const apply = () => {
        tb.classList.toggle("mini", s === "mini");
        tb.classList.toggle("tape-away", s === "away");
      };
      // The fold used to CUT between heights. Glide instead: measure both
      // ends, clip the box, and slide — the row swap happens at the short
      // end of the glide where the eye is on motion, not content.
      // Every change of state glides, away included (it used to cut for
      // anything but full<->mini, and cut again whenever the tape had been
      // hand-sized — the "major transitions" that still jumped, Jeff
      // 2026-09-02). Measure both ends, run the height, swap the pinned class
      // in at the end. A hand-set height is kept as an inline style and comes
      // back when the tape returns to full.
      const animatable = prev !== s && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      const pinned = s === "mini" || s === "away";
      if (animatable) {
        clearTimeout(tapeAnim);
        const from = tb.getBoundingClientRect().height;
        const sized = tb.style.height;           // a hand-set height, if any
        tb.style.height = "";
        apply();
        const to = tb.getBoundingClientRect().height;
        // .mini/.tape-away pin height with !important, so the glide runs
        // WITHOUT the class and swaps it in at the end; going to full the
        // class state is already right and the box just opens onto the rows.
        // The box glides on --tape-anim-h (which .tape-anim lets override the
        // pinned heights), so the content classes can stay honest during the
        // slide: leaving or entering mini keeps the compact rows on screen
        // instead of flashing the full table for 380 ms (Jeff 2026-09-04,
        // "small to fully minimized still not smooth"). Away swaps in at the
        // end, once the box is down to pill height.
        if (s === "away") { tb.classList.remove("tape-away"); if (prev === "mini") tb.classList.add("mini"); }
        // Commit the restored classes before the transition switches on.
        // Measuring `to` left a 38 px height in the last computed style, and
        // with the transition live the box would animate 38 → from and then
        // retarget to 38: a snap. A plain reflow here resets the start value.
        tb.getBoundingClientRect();
        tb.classList.add("tape-anim");
        tb.classList.toggle("tape-anim-away", s === "away");
        tb.style.setProperty("--tape-anim-h", from + "px");
        tb.getBoundingClientRect();
        tb.style.setProperty("--tape-anim-h", (s === "full" && sized ? parseFloat(sized) : to) + "px");
        // the pill fades in over the last third of the glide so box and pill
        // read as one motion rather than a slide, a stop, then a pop
        if (s === "away") setTimeout(() => { const pill = $("#tape-pill"); if (pill && tapeState === "away") pill.hidden = false; }, TAPE_ANIM_MS * 0.6);
        tapeAnim = setTimeout(() => {
          tb.classList.remove("tape-anim", "tape-anim-away");
          tb.style.removeProperty("--tape-anim-h");
          tb.style.height = s === "full" && sized ? sized : "";
          if (s === "away") { tb.classList.remove("mini"); tb.classList.add("tape-away"); }
          const pill = $("#tape-pill");
          if (pill) pill.hidden = s !== "away";
          document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px");
          if (WX.fn.fitStrip) WX.fn.fitStrip();
          restoreSheetHeight();
          restorePointPanelSize();
        }, TAPE_ANIM_MS);
      } else apply();
      // the pill appears when the glide lands (above); leaving away it goes at once
      const pill = $("#tape-pill");
      if (pill && (s !== "away" || !animatable)) pill.hidden = s !== "away";
      if (persist) localStorage.setItem("wxgrid.tapeState", s);
      const nextAction = s === "full" ? "Show compact forecast" : s === "mini" ? "Hide forecast timeline" : "Show full forecast";
      tmin.title = nextAction; tmin.setAttribute("aria-label", nextAction);
      requestAnimationFrame(() => document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px"));
    };
    const savedState = localStorage.getItem("wxgrid.tapeState")
      || (localStorage.getItem("wxgrid.tapeMini") === "1" ? "mini" : "full");
    setTapeState(["full", "mini", "away"].includes(savedState) ? savedState : "full", false);
    // One control walks the three states: full → header → away → full.
    // "Collapse completely" was only reachable by dragging the grip past a
    // hidden threshold, which read as broken (Jeff 2026-09-02).
    tmin.onclick = () => setTapeState(nextTapeState());
    const pillBtn = $("#tape-pill");
    if (pillBtn) pillBtn.onclick = () => setTapeState("full");
    // the crosshair button map apps have: centre here and open the card
    const goToMe = () => {
      if (!navigator.geolocation) { toast("This browser has no location service", 4000, "error"); return; }
      $("#locate-btn").classList.add("on");
      navigator.geolocation.getCurrentPosition(
        (pos) => { $("#locate-btn").classList.remove("on"); map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 8), duration: 900 }); openPoint(pos.coords.latitude, pos.coords.longitude); },
        () => { $("#locate-btn").classList.remove("on"); toast("Location blocked for this site", 5000, "error"); },
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
    $("#share-btn").onclick = shareLink;
    $("#point-share").onclick = shareLink;
    const openSettings = (e) => {
      const opener = e.currentTarget.closest(".menu")?.querySelector(".menu-btn") || e.currentTarget;
      $$(".menu.open").forEach((x) => x.classList.remove("open")); WX.settings.open(opener);
    };
    $("#settings-btn").onclick = openSettings;
    $("#keys-btn").onclick = openSettings;
    // a unit change repaints every number on screen at once
    document.addEventListener("wx-units", () => { renderControls(); renderLegend(); renderPoint(); WX.tape.renderTape(); if (WX.probe) WX.probe.hover(null); if (state.xsection && WX.xs) WX.xs.refresh(); $("#units-toggle").querySelector(".val").textContent = speedUnit(); });
    $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    $("#radar-toggle").onclick = () => WX.ov.toggleRadar();
    $$(".base-row button").forEach((b) => b.onclick = () => {
      const wasStreets = state.base === "streets";
      state.base = b.dataset.base; localStorage.setItem("wxgrid.base", state.base);
      $$(".base-row button").forEach((x) => x.classList.toggle("on", x === b));
      if (state.base === "streets" || wasStreets) {
        // a style swap, the way a theme change is one
        map.setStyle(mapStyle(), { diff: false });
        map.once("style.load", restoreLayers);
        map.once("idle", () => { if (!map.getSource("wx")) restoreLayers(); });
      }
      WX.ov.setBase(state.base);
    });
    $$(".base-row button").forEach((x) => x.classList.toggle("on", x.dataset.base === state.base));
    if (state.base) WX.ov.setBase(state.base);
    $("#terrain-toggle").onclick = () => { state.terrain = !state.terrain; localStorage.setItem("wxgrid.terrain", state.terrain ? "1" : "0"); $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain(); else WX.ov.clearTerrain(); };
    $("#terrain-toggle").classList.toggle("on", state.terrain); if (state.terrain) WX.ov.loadTerrain();
    $("#night-toggle").onclick = () => { state.night = !state.night; $("#night-toggle").classList.toggle("on", state.night); if (state.night) WX.ov.updateNight(); else WX.ov.clearNight(); };
    const pt = $("#probe-toggle");
    if (pt) {
      pt.classList.toggle("on", state.probeChip);
      pt.setAttribute("aria-pressed", state.probeChip ? "true" : "false");
      pt.onclick = () => { state.probeChip = !state.probeChip; localStorage.setItem("wxgrid.probe", state.probeChip ? "1" : "0"); pt.classList.toggle("on", state.probeChip); pt.setAttribute("aria-pressed", state.probeChip ? "true" : "false"); if (!state.probeChip && WX.probe) WX.probe.hover(null);
        // the strip carries the same switch; toggling either must light both
        const sp = document.querySelector(".strip-probe");
        if (sp) { sp.classList.toggle("on", state.probeChip); sp.setAttribute("aria-pressed", state.probeChip ? "true" : "false"); } };
    }
    $("#alerts-toggle").onclick = () => { state.alerts = !state.alerts; $("#alerts-toggle").classList.toggle("on", state.alerts); if (state.alerts) WX.ov.loadAlerts(); else WX.ov.clearAlerts(); };
    $("#storms-toggle").onclick = () => { state.storms = !state.storms; $("#storms-toggle").classList.toggle("on", state.storms);
      // storm positions are "now"; the particles must be too, or the wind
      // field and the eye disagree on where the storm is
      if (state.storms) { if (state.stepIdx !== currentStepIdx()) setStep(currentStepIdx()); WX.ov.loadStorms(); } else WX.ov.clearStorms(); };
    $("#sat-toggle").onclick = () => { state.sat = !state.sat; $("#sat-toggle").classList.toggle("on", state.sat); if (state.sat) { clearOtherCover("sat"); WX.ov.loadSat(); } else WX.ov.clearSat(); };
    for (const [k, load, clear] of [["smoke", "loadSmoke", "clearSmoke"], ["quakes", "loadQuakes", "clearQuakes"], ["aod", "loadAod", "clearAod"], ["thunder", "loadThunder", "clearThunder"], ["obs", "loadObs", "clearObs"]]) {
      $(`#${k}-toggle`).onclick = () => { state[k] = !state[k]; $(`#${k}-toggle`).classList.toggle("on", state[k]);
        if (state[k]) { if (k === "smoke" || k === "aod") clearOtherCover(k); WX.ov[load](true); } else WX.ov[clear](); };
    }
    $("#theme-toggle").onclick = () => { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); $("#theme-toggle").querySelector(".val").textContent = document.documentElement.dataset.theme; };
    $("#route-toggle").onclick = () => {
      if (!WX.route) { toast("Route forecast is not in this build", 4000, "error"); return; }
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
    $("#winter-toggle").onclick = () => setWinterMode(!state.winterMode);
    $("#avy-toggle").onclick = () => { state.avy = !state.avy; $("#avy-toggle").classList.toggle("on", state.avy); if (state.avy) WX.ov.loadAvy(); else WX.ov.clearAvy(); };
    $("#resorts-toggle").onclick = () => { state.resorts = !state.resorts; $("#resorts-toggle").classList.toggle("on", state.resorts); if (state.resorts) WX.ov.loadResorts(); else WX.ov.clearResorts(); };
    syncWinterUI();
    if (state.winterMode) applyWinterMapState();
    $("#locate").onclick = goToMe;
    $("#point-close").onclick = closePoint;
    wireSheet();
    $("#point-fav").onclick = () => { if (!state.point) return; const on = WX.search.toggleFav(state.point.lat, state.point.lon, state.point.name); $("#point-fav").classList.toggle("on", on); $("#point-fav").title = on ? "Saved place" : "Save place"; toast(on ? "Saved to search" : "Removed", 2500); };
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
      if (e.key === "Escape" && $("#tstrip").classList.contains("more-open")) {
        $("#tstrip").classList.remove("more-open"); fitStrip(); $("#strip-more").focus(); return;
      }
      if (e.target.closest("button, summary, #strip-more-pop") && [" ", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
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
    ["winter", "Winter mode"], null,
    ["radar", "Radar"], ["sat", "Satellite"], ["aurora", "Aurora"], ["aod", "Aerosol"], ["iso", "Isolines"], null,
    ["alerts", "Alerts", "warn"], ["storms", "Storms", "warn"], ["thunder", "Thunder", "warn"], ["sigmet", "SIGMET", "warn"], null,
    ["fires", "Fires", "warn"], ["smoke", "Smoke"], null,
    ["aq", "Air quality"], ["quakes", "Quakes"], ["obs", "Stations"], null,
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
    // collide the way a floating button did. It goes at the HEAD of the strip
    // and is exempt from fitStrip's trim: appended last it was the first thing
    // the overflow exiled, so "my location" lived in the ⋮ flyout on every
    // screen where the strip did not fit (Jeff 2026-08-25: "pin to my location
    // should be on the outside rather than hiding in the three-dot menu").
    // At the foot of the strip with settings, not the head: a locate button
    // above twenty overlay toggles read as one of them and went unfound
    // (Jeff 2026-09-02: "kinda hiding up there").
    st.insertAdjacentHTML("beforeend", `<div class="sep strip-locate-sep"></div><button class="strip-locate" data-tip="My location" aria-label="My location">${$("#locate-btn").innerHTML}</button>`);
    st.querySelector(".strip-locate").onclick = () => $("#locate-btn").click();
    // Reading a value off the map is the other thing people come to a weather
    // map to do, and its switch was buried in the same flyout — the feature
    // reads as missing when you cannot find the toggle (Jeff 2026-08-25: "the
    // feature where u can toggle data card on hover ... never implemented").
    // Same treatment: head of the strip, never trimmed, state mirrored so the
    // strip and the menu can never disagree about whether it is on.
    const pt0 = $("#probe-toggle");
    if (pt0) {
      st.insertAdjacentHTML("afterbegin", `<button class="strip-probe" data-tip="Show value under cursor" aria-label="Show value under cursor" aria-pressed="false">${pt0.querySelector("svg").outerHTML}</button>`);
      const sp = st.querySelector(".strip-probe");
      const syncProbe = () => {
        const on = !!state.probeChip;
        sp.classList.toggle("on", on);
        sp.setAttribute("aria-pressed", on ? "true" : "false");
      };
      sp.onclick = () => { pt0.click(); syncProbe(); };
      syncProbe();
    }
    // overflow flyout: the strip stays fixed, the extras animate out beside it
    st.insertAdjacentHTML("beforeend", `<button id="strip-more" data-tip="More layers and tools" aria-label="More" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>`);
    document.body.insertAdjacentHTML("beforeend", '<div id="strip-more-pop" class="tstrip strip-pop" inert></div>');
    $("#strip-more").onclick = (e) => { e.stopPropagation(); st.classList.toggle("more-open"); fitStrip(); positionMorePop(); };
    document.addEventListener("click", (e) => { if (!e.target.closest("#tstrip") && !e.target.closest("#strip-more-pop") && st.classList.contains("more-open")) { st.classList.remove("more-open"); fitStrip(); } });
    fitStrip();
    addEventListener("resize", () => { if (!pageIsPinchZoomed()) fitStrip(); });
    new MutationObserver(fitStrip).observe($("#topbar"), { subtree: true, attributes: true, attributeFilter: ["class"] });
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
    let peeking = false, expandedHeight = stored, expandedTab = null;
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
    focusMobileSheet = (peek) => {
      if (innerWidth > 820) return;
      if (peek && !peeking) { expandedHeight = height; expandedTab = state.tab; state.tab = "now"; }
      if (!peek && peeking && expandedTab) { state.tab = expandedTab; expandedTab = null; }
      peeking = peek;
      setHeight(peek ? 170 : expandedHeight || Math.round(viewH() * 0.52), false);
      if (state.point && state.point.data) renderPoint();
    };
    // While the thumb is down the card is laid out ONCE at its ceiling and
    // slid with a transform; the real height lands on release. Setting the
    // height per move re-laid-out the whole card each frame (Jeff 2026-09-05).
    let dragMax = 0, dragH = 0;
    const track = perFrame((clientY) => {
      if (!dragging) return;
      dy = clientY - y0;
      const b = bounds();
      closing = startH - dy < b.min - 64;
      card.style.opacity = closing ? ".62" : "";
      dragH = Math.max(b.min, Math.min(dragMax, Math.round(startH - dy)));
      card.style.transform = `translateY(${dragMax - dragH}px)`;
    });
    let openedFromPeek = false;
    grip.addEventListener("pointerdown", (e) => {
      if (innerWidth > 820) return;
      openedFromPeek = tapeState === "full";
      if (tapeState === "full") setTapeState("mini", false);
      dragging = true; y0 = e.clientY; dy = 0; closing = false;
      startH = card.getBoundingClientRect().height;
      dragMax = bounds().max; dragH = startH;
      card.classList.add("sheet-drag");
      card.style.height = `${dragMax}px`; card.classList.add("sheet-sized");
      card.style.transform = `translateY(${dragMax - startH}px)`;
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => { if (dragging) track(e.clientY); });
    const end = (cancel) => {
      if (!dragging) return;
      dragging = false; card.style.opacity = "";
      card.style.transform = "";
      setHeight(cancel ? startH : dragH, false);   // the one real layout of the drag
      card.classList.remove("sheet-drag");
      if (!cancel && closing) { closePoint(); return; }
      if (!cancel && Math.abs(dy) < 6) {                    // a tap cycles peek → half → full
        if (openedFromPeek) return;
        const b = bounds();
        setHeight(height < 190 ? Math.round(b.max * 0.5) : height < b.max - 40 ? b.max : b.min, true);
        expandedHeight = height;
        return;
      }
      localStorage.setItem("wxgrid.sheetHeight", String(height));
      expandedHeight = height;
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
    // Measure the full, unsized tape itself. scrollHeight cannot answer this
    // once flex has stretched the tape: it simply reports the already-wrong
    // tall box and lets every drag ratchet the maximum higher.
    const tapeContentMax = () => {
      const t = tb.querySelector(".tape");
      if (!t || !t.firstElementChild || t.querySelector(".tape-empty")) return Infinity;
      const classes = tb.className, style = tb.getAttribute("style");
      const pill = $("#tape-pill"), pillHidden = pill ? pill.hidden : true;
      tb.classList.remove("mini", "tape-away", "user-sized", "tape-dragging", "tape-anim", "tape-anim-away");
      tb.style.height = "auto"; tb.style.removeProperty("--tape-drag-height");
      if (pill) pill.hidden = true;
      const height = Math.ceil(tb.getBoundingClientRect().height) + 1;
      tb.className = classes;
      if (style == null) tb.removeAttribute("style"); else tb.setAttribute("style", style);
      if (pill) pill.hidden = pillHidden;
      return height;
    };
    const tapeMaxHeight = (bounds = tapeBounds()) => Math.max(bounds.min, Math.min(bounds.max, tapeContentMax()));
    const setTapeHeight = (height, persist = false, measuredMax = null) => {
      const bounds = tapeBounds();
      const maxH = measuredMax == null ? tapeMaxHeight(bounds) : measuredMax;
      tapeHeight = clamp(Math.round(height), bounds.min, maxH);
      tb.style.height = `${tapeHeight}px`; tb.classList.add("user-sized");
      tapeGrip.setAttribute("aria-valuemin", bounds.min); tapeGrip.setAttribute("aria-valuemax", Math.round(maxH)); tapeGrip.setAttribute("aria-valuenow", tapeHeight);
      if (persist) localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
    };
    const resetTapeHeight = () => {
      tapeHeight = null; localStorage.removeItem("wxgrid.tapeHeight");
      tb.style.height = ""; tb.classList.remove("user-sized");
      requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    };
    if (tapeHeight) setTapeHeight(tapeHeight);
    else requestAnimationFrame(() => tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height)));
    // The tape is populated after these controls are wired. Clamp an old
    // persisted over-height as soon as a forecast/radar render arrives.
    let contentClampFrame = 0;
    new MutationObserver(() => {
      if (contentClampFrame) return;
      contentClampFrame = requestAnimationFrame(() => {
        contentClampFrame = 0;
        if (tapeState !== "full" || document.body.classList.contains("resizing-tape") || tb.classList.contains("tape-anim")) return;
        const maxH = tapeMaxHeight();
        tapeGrip.setAttribute("aria-valuemax", Math.round(maxH));
        if (!tapeHeight) tapeGrip.setAttribute("aria-valuenow", Math.round(tb.getBoundingClientRect().height));
        else if (tapeHeight > maxH) setTapeHeight(tapeHeight, true, maxH);
      });
    }).observe(tb.querySelector(".tape"), { childList: true, subtree: true });
    let tapeDrag = null, suppressGripClickUntil = 0;
    const TAPE_AWAY_HEIGHT = 38, TAPE_TAP_SLOP = 14;
    const tapeTargetState = (height) => {
      const min = tapeBounds().min;
      return height <= Math.round((TAPE_AWAY_HEIGHT + min) / 2) ? "away" : height < min ? "mini" : "full";
    };
    // Follow the pointer continuously all the way to the 38 px away state.
    // Switching classes at two hidden thresholds made the last leg jump from
    // a compact table to a pill while the finger was still moving. During a
    // drag this is one clipped surface; the semantic state is chosen once,
    // on release, then the existing glide finishes the small remainder.
    // The drag never changes layout. The box is laid out ONCE at its ceiling
    // (--tape-drag-height = max) and the pointer moves it with a transform:
    // its top edge sits `want` px above the bottom, the rest slides under the
    // screen edge. The sheet and the locate button ride the same transform.
    // Writing the height per frame reflowed the forecast table and every
    // --tb-h dependant on each move — the "steppy" drag on a phone
    // (Jeff 2026-09-05, "it's dogged us forever").
    const riders = () => [$("#point"), $(".locate-btn")].filter(Boolean);
    const previewTapeDrag = (clientY) => {
      if (!tapeDrag) return;
      tapeDrag.lastY = clientY;
      tapeDrag.want = clamp(tapeDrag.height + tapeDrag.y - clientY, TAPE_AWAY_HEIGHT, tapeDrag.max);
      if (tapeDrag.from === "away" && tapeDrag.want > TAPE_AWAY_HEIGHT + 4) {
        tb.classList.remove("tape-away"); tb.classList.add("mini");
        const pill = $("#tape-pill"); if (pill) pill.hidden = true;
      }
      tb.style.transform = `translateY(${(tapeDrag.max - tapeDrag.want).toFixed(2)}px)`;
      const rise = tapeDrag.want - tapeDrag.height;
      for (const el of riders()) el.style.transform = `translateY(${(-rise).toFixed(2)}px)`;
      tapeGrip.setAttribute("aria-valuenow", Math.round(tapeDrag.want));
    };
    const clearTapeDragTransforms = () => {
      tb.style.transform = "";
      for (const el of riders()) { el.style.transform = ""; el.classList.remove("tape-riding"); }
    };
    const trackTape = perFrame(previewTapeDrag);
    const restoreTapeDragStart = (drag) => {
      clearTapeDragTransforms();
      tb.classList.remove("tape-dragging"); tb.style.removeProperty("--tape-drag-height");
      tb.classList.toggle("mini", drag.from === "mini");
      tb.classList.toggle("tape-away", drag.from === "away");
      tb.style.height = drag.inlineHeight;
      const pill = $("#tape-pill"); if (pill) pill.hidden = drag.from !== "away";
      document.documentElement.style.setProperty("--tb-h", tb.offsetHeight + "px");
    };
    tapeGrip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const h0 = tb.getBoundingClientRect().height;
      const maxH = tapeMaxHeight();
      tapeGrip.setAttribute("aria-valuemax", Math.round(maxH));
      tapeDrag = { id: e.pointerId, y: e.clientY, lastY: e.clientY, height: h0, want: h0,
        max: maxH, distance: 0, from: tapeState, inlineHeight: tb.style.height };
      tb.style.setProperty("--tape-drag-height", `${maxH.toFixed(2)}px`);
      tb.style.transform = `translateY(${(maxH - h0).toFixed(2)}px)`;
      for (const el of riders()) el.classList.add("tape-riding");
      tapeGrip.setPointerCapture(e.pointerId); tb.classList.add("is-resizing", "tape-dragging"); document.body.classList.add("resizing-tape");
    });
    tapeGrip.addEventListener("pointermove", (e) => {
      if (!tapeDrag || e.pointerId !== tapeDrag.id) return;
      const samples = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const sample = samples && samples.length ? samples[samples.length - 1] : e;
      tapeDrag.distance = Math.max(tapeDrag.distance, Math.abs(sample.clientY - tapeDrag.y));
      tapeDrag.lastY = sample.clientY; trackTape(sample.clientY);
    });
    const finishTape = (e, cancelled = false) => {
      if (!tapeDrag || (e && e.pointerId !== tapeDrag.id)) return;
      const drag = tapeDrag;
      if (e && Number.isFinite(e.clientY)) {
        drag.distance = Math.max(drag.distance, Math.abs(e.clientY - drag.y));
        drag.lastY = e.clientY;
      }
      const tap = !cancelled && drag.distance < TAPE_TAP_SLOP;
      if (!tap && !cancelled) previewTapeDrag(drag.lastY); // do not lose the last pre-RAF move
      tapeDrag = null; tb.classList.remove("is-resizing"); document.body.classList.remove("resizing-tape");
      suppressGripClickUntil = Date.now() + 500;
      if (cancelled) {
        restoreTapeDragStart(drag);
      } else if (tap) {
        restoreTapeDragStart(drag);
        setTapeState(nextTapeState());
      } else {
        const visualHeight = drag.want;          // the box is at its ceiling; `want` is what the eye saw
        const target = tapeTargetState(drag.want);
        // Land the real layout at exactly the release height (one reflow)
        // while setTapeState measures the other end. Removing the drag class
        // first without this explicit height was the remaining mini → away snap.
        clearTapeDragTransforms();
        tb.classList.remove("tape-dragging", "mini", "tape-away");
        tb.style.removeProperty("--tape-drag-height");
        tb.style.height = `${visualHeight}px`;
        document.documentElement.style.setProperty("--tb-h", `${visualHeight}px`);
        const pill = $("#tape-pill"); if (pill) pill.hidden = true;
        if (target === "full") {
          setTapeHeight(drag.want, true, drag.max);
          setTapeState("full");
        } else {
          const unchanged = target === tapeState;
          setTapeState(target);
          if (unchanged) tb.style.height = "";
        }
      }
      if (tapeHeight && tapeState === "full") localStorage.setItem("wxgrid.tapeHeight", tapeHeight);
      if (WX.fn.fitStrip) WX.fn.fitStrip();
      restoreSheetHeight();                    // the card re-budgets around the new tape
      restorePointPanelSize();
    };
    tapeGrip.addEventListener("pointerup", (e) => finishTape(e, false));
    tapeGrip.addEventListener("pointercancel", (e) => finishTape(e, true));
    tapeGrip.addEventListener("lostpointercapture", (e) => { if (tapeDrag) finishTape(e, false); });
    // Pointer-up handles real taps. This is the keyboard/synthetic-click
    // fallback; the short suppression window prevents one physical tap from
    // walking two states when the browser also synthesises click.
    tapeGrip.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (Date.now() < suppressGripClickUntil) return;
      setTapeState(nextTapeState());
    });
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

  // Keep the pinned rail in bounds; the complete named list can scroll.
  function fitStrip() {
    if (WX.toolstrip) WX.toolstrip.fit();
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
    state.frac = 0;
    // Keep the VALID time, not the step index: comparing models means the same moment.
    if (WX.tape) WX.tape.clearFineSelection();
    state.model = key; localStorage.setItem("wxgrid.model", key);
    state.run = modelEntry().runs[0].run;
    if (!runEntry().layers.includes(state.layer)) state.layer = state.winterMode ? preferredWinterLayer(runEntry().layers) : runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  // Same job as switchModel, one model: hold the valid time, swap the run.
  function switchRun(runId, target = validDate().getTime()) {
    state.frac = 0;
    if (!modelEntry().runs.some((r) => r.run === runId) || runId === state.run) return;
    if (WX.tape) WX.tape.clearFineSelection();
    state.run = runId;
    if (!runEntry().layers.includes(state.layer)) state.layer = runEntry().layers[0];
    const base = runDate().getTime();
    let best = 0, bestErr = Infinity;
    steps().forEach((h, i) => { const err = Math.abs(base + h * 3600e3 - target); if (err < bestErr) { bestErr = err; best = i; } });
    state.stepIdx = best;
    renderControls(); applyStep(); loadWind(); refreshPoint(); WX.tape.refreshTapePoint(); if (state.iso) WX.ov.loadIso();
  }

  function clampStep() { state.stepIdx = Math.min(state.stepIdx, steps().length - 1); }
  // Round the sub-step position away onto the nearer real step. Everything
  // except the field layer works in whole steps, so this is what a scrub, a
  // model change and the end of a playback loop all come back to.
  function settleStep() {
    if (!state.frac) return;
    state.stepIdx = Math.min(steps().length - 1, state.stepIdx + Math.round(state.frac));
    state.frac = 0;
    const slider = $("#step");
    if (slider) slider.value = String(state.stepIdx);
  }
  function currentStepIdx() {
    const ms = Date.now(), valid = steps().map((h) => runDate().getTime() + h * 3600e3);
    let best = 0;
    valid.forEach((t, k) => { if (Math.abs(t - ms) < Math.abs(valid[best] - ms)) best = k; });
    return best;
  }
  function nudge(d) {
    if (state.radar && state.radarFrames.length) { state.radarIdx = (state.radarIdx + d + state.radarFrames.length) % state.radarFrames.length; WX.ov.applyRadarFrame(); return; }
    if (WX.tape) WX.tape.clearFineSelection();
    state.frac = 0;
    state.stepIdx = (state.stepIdx + d + steps().length) % steps().length; $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso();
  }
  function setStep(i) { if (WX.tape) WX.tape.clearFineSelection(); state.frac = 0; state.stepIdx = Math.max(0, Math.min(steps().length - 1, i)); $("#step").value = state.stepIdx; applyStep(); loadWind(); if (state.iso) WX.ov.loadIso(); }

  // Valid time, lead time, and whether the map is sitting on the present.
  // Split out of applyStep because a glide between two steps redraws this
  // sixty times a second and nothing else.
  const selectedLayerName = () => (LAYER_LABEL[state.layer] || state.layer)
    + (state.level && hasLevel() ? ` ${state.level}${/^\d+$/.test(String(state.level)) ? " hPa" : ""}` : "");

  function renderTapePill() {
    const pill = $("#tape-pill"); if (!pill) return;
    const local = $("#valid-local");
    const time = local ? local.textContent.split(" · ")[0] : "";
    const off = $("#tape-now .off");
    const status = off ? off.textContent : "Now";
    const field = state.radar ? "Radar" : selectedLayerName();
    let reading = null;
    if (state.radar) {
      reading = state.radarSource && state.radarSource.label ? { text: state.radarSource.label, sub: "" } : null;
    } else if (WX.probe && WX.probe.valueAt && map) {
      try { const c = map.getCenter(); reading = WX.probe.valueAt(c.lng, c.lat); } catch (_) { reading = null; }
    }
    const put = (sel, value) => { const el = pill.querySelector(sel); if (el) el.textContent = value || ""; };
    put(".t", time); put(".status", status); put(".field", field);
    const st = pill.querySelector(".status"); if (st) st.classList.toggle("away", status !== "Now");   // red offset, same as the Now pill
    const value = pill.querySelector(".value"), sub = pill.querySelector(".sub");
    if (value) { value.textContent = reading && reading.text || ""; value.hidden = !(reading && reading.text); }
    if (sub) { sub.textContent = reading && reading.sub || ""; sub.hidden = !(reading && reading.sub); }
    pill.setAttribute("aria-label", ["Show forecast timeline", time, status, field,
      reading && reading.text, reading && reading.sub].filter(Boolean).join(", "));
  }

  function renderClock() {
    const v = validDate();
    // the phone row has room for the weekday and the hour; the date is the UTC line under it
    const narrow = matchMedia("(max-width: 820px)").matches;
    $("#valid-local").textContent = v.toLocaleString(undefined, WX.units.timeOpts(narrow ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
    $("#valid-utc").textContent = v.toISOString().slice(0, 16).replace("T", " ") + "Z";
    const atNow = state.stepIdx === currentStepIdx() && !state.frac;
    // one pill, two states: lit "Now" when live, a red "+36h" once stepped —
    // the offset is both the status and the way home (a "jump to live"), so
    // nothing else moves and no extra word is needed
    $("#tape-now").innerHTML = atNow ? "Now" : `<b class="off">+${Math.round(shownHours())}h</b>`;
    $("#tape-now").classList.toggle("on", atNow);
    $("#tape-now").classList.toggle("away", !atNow);
    $("#tape-now").setAttribute("aria-pressed", atNow ? "true" : "false");
    renderTapePill();
  }

  function applyStep(prefetch = true) {
    pushHash();
    if (fieldLive()) {
      WX.field.show(fieldSpec());
    } else {
      const src = map.getSource("wx");
      if (src) { try { src.updateImage({ url: layerUrl(), coordinates: modelCoords() }); } catch (e) { /* superseded */ } }
    }
    if (map.getLayer("wx")) map.setPaintProperty("wx", "raster-opacity", rasterOpacity());
    if (state.thunder && WX.ov) WX.ov.loadThunder();
    if (state.xsection && WX.xs) WX.xs.refresh();
    if (state.aq && WX.cams) WX.cams.refresh();
    if (state.route && WX.route) WX.route.refresh();
    if (WX.probe) WX.probe.refresh();
    renderClock();
    if (state.night && WX.ov) WX.ov.updateNight();
    if (WX.probe) { WX.probe.pinUpdate(); }
    updateMarkerFlag();
    if (prefetch) {
      // Warm the neighbours: a cold frame renders in ~1-2 s server-side, and
      // scrubbing waits for each one. Fetching +1/+2/-1 in the background
      // makes the scrub read from cache instead (Jeff 2026-08-21).
      const st = steps();
      for (const d of [1, 2, -1]) {
        const j = state.stepIdx + d;
        if (j < 0 || j >= st.length) continue;
        if (fieldLive()) WX.field.prefetch(fieldUrl(st[j]));
        else { const im = new Image(); im.src = layerUrl(st[j]); }
      }
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
    const pp = $("#tape-pill .pp"); if (pp) { pp.textContent = state.playing ? "❚❚" : "▶"; pp.setAttribute("aria-label", state.playing ? "Pause" : "Play"); }
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = 0; }
    if (!state.playing) { settleStep(); applyStep(); loadWind(); return; }
    // The field layer can draw the hours between two model steps, so playback
    // glides through them. Radar and the raster path swap whole frames.
    if (fieldLive() && !state.radar && steps().length > 1) {
      playFrom = performance.now();
      playRaf = requestAnimationFrame(playFrame);
      return;
    }
    playTimer = setInterval(() => nudge(1), state.radar ? Math.min(500, state.playMs) : state.playMs);
  }
  // One step per playMs, in real time. A backgrounded tab comes back with a
  // huge dt; cap it so the map resumes rather than jumping a day.
  function playFrame(now) {
    playRaf = 0;
    if (!state.playing) return;
    const last = steps().length - 1;
    const dt = Math.min(250, Math.max(0, now - playFrom));
    playFrom = now;
    let pos = state.stepIdx + state.frac + dt / Math.max(120, state.playMs);
    if (pos >= last) pos -= last;                        // round the tape and start again
    const i = Math.min(last, Math.floor(pos));
    const crossed = i !== state.stepIdx;
    state.stepIdx = i;
    state.frac = Math.min(0.999, pos - i);
    const slider = $("#step");
    if (slider) slider.value = String(pos);
    // Crossing into a new step is the moment everything else has to catch up:
    // the wind field, the isobars, the tape's highlight. Between them only the
    // mix and the clock move.
    if (crossed) { applyStep(true); loadWind(); if (state.iso) WX.ov.loadIso(); }
    else { WX.field.show(fieldSpec()); renderClock(); }
    playRaf = requestAnimationFrame(playFrame);
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
    renderTapePill();
    const cat = catalog.layers.find((l) => l.layer === state.layer);
    if (!cat) { $("#legend").hidden = true; return; }
    // Geopotential height sits in a different band at every pressure level, so
    // the catalog ships a ramp per level and the bar shows the one on the map.
    const lg = (state.level && cat.levels && cat.levels[state.level]) || cat;
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
                 msl: (v) => U_.press(v * 100), frz: (v) => U_.alt(v), cbase: (v) => U_.alt(v), gh: (v) => U_.alt(v),
                 tp6: (v) => U_.precip(v), tp24: (v) => U_.precip(v), tp72: (v) => U_.precip(v),
                 sf6: (v) => U_.snow(v), sf24: (v) => U_.snow(v), sf72: (v) => U_.snow(v),
                 sd_cm: (v) => U_.snow(v), waves: (v) => U_.alt(v, 1), swell: (v) => U_.alt(v, 1), windsea: (v) => U_.alt(v, 1) }[state.layer];
    const conv = (v) => isSpeed ? Math.round(speed(v)) : cv ? cv(v).v : Math.round(v);
    const unit = isSpeed ? speedUnit() : cv ? cv(0).unit : lg.units;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((q) => lg.lo + (lg.hi - lg.lo) * q);
    // The layer's name belongs over the bar, not wedged into the middle tick
    // where it collided with the value under it. Ticks are numbers only.
    const name = selectedLayerName();
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
  // The failure the card shows, in the same styled note the outside-domain
  // path uses. It was a bare text node in a flex row, which read as a layout
  // accident rather than an answer.
  const POINT_FAILED = "The forecast for this point did not load. The server may be restarting.";
  let pointReq = 0;
  async function openPoint(lat, lon, name) {
    const my = ++pointReq;
    if (phoneMQ.matches && !state.point) pointTapeReturn = tapeState;
    const keepResort = state.resort && Math.abs(state.resort.resort.lat - lat) < 1e-4 && Math.abs(state.resort.resort.lon - lon) < 1e-4;
    if (!keepResort) { if (WX.ov && WX.ov.clearResortDetail) WX.ov.clearResortDetail(); else state.resort = null; if (state.tab === "resort") state.tab = "now"; }
    document.body.classList.toggle("has-resort", !!keepResort);
    state.point = { lat, lon, data: null, ai: null, prob: null, name: name || null, local: null, obs: null, avy: null, profile: null, cmp: null };
    $("#point").hidden = false;
    restorePointPanelSize(); restoreSheetHeight();
    document.body.classList.add("has-point");
    // A phone's card sits over the layer row anyway, so the controls fold
    // while it is open and come back when it closes. A fold the user chose
    // themselves stays.
    if (phoneMQ.matches && !document.body.classList.contains("tucked")) { softTucked = true; setTucked(true, false); }
    if (phoneMQ.matches) { setTapeState("mini", false); focusMobileSheet(false); }
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
            .then((r) => { if (my === pointReq && r.available !== false) { state.point.ai = r; renderPoint(); WX.tape.renderTape(); } })
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
            if (msg.kind === "point" && msg.error) $("#point-now").innerHTML = `<div class="note">${POINT_FAILED}</div>`;
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
    } catch (e) { if (my !== pointReq) return; $("#point-now").innerHTML = `<div class="note">${POINT_FAILED}</div>`; }
    // local context arrives lazily and re-renders as it lands
    WX.api(`${API}/geo/reverse?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) gotLocal(r); }).catch(() => {});
    WX.api(`${API}/obs?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.obs(r); }).catch(() => {});
    WX.api(`${API}/alerts/point?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.alerts(r); }).catch(() => {});
    WX.api(`${API}/air?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.air(r); }).catch(() => {});
    WX.api(`${API}/tides?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.tides(r); }).catch(() => { if (my === pointReq) got.tides(false); });
    WX.api(`${API}/prob?lat=${lat.toFixed(3)}&lon=${wlon(lon).toFixed(3)}`).then((r) => { if (my === pointReq) got.prob(r); }).catch(() => {});
  }
  function refreshPoint() { if (state.point) openPoint(state.point.lat, state.point.lon, state.point.name); }
  function closePoint() { ++pointReq; state.point = null; if (WX.ov && WX.ov.clearResortDetail) WX.ov.clearResortDetail(); else state.resort = null; $("#point").hidden = true; document.body.classList.remove("has-point", "has-resort");
    if (pointTapeReturn != null) { const previous = pointTapeReturn; pointTapeReturn = null; setTapeState(previous, false); }
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
    // Winter has nothing to say where it cannot snow: a tab that answers
    // "n/a" nine rows deep is worse than no tab (see WXPanes.canSnow).
    const snow = !window.WXPanes.canSnow || window.WXPanes.canSnow(state.point, d);
    $$(".point-tabs button[data-tab=winter]").forEach((b) => b.hidden = !snow);
    if (!snow && state.tab === "winter") state.tab = "now";
    $$(".point-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$("#point-body section").forEach((s) => s.hidden = s.dataset.pane !== state.tab);
    window.WXPanes.render(state.tab, state.point, Math.min(state.stepIdx, d.steps.length - 1));
  }
  WX.renderPoint = renderPoint;
  WX.setStep = setStep;

  // ── misc ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, ms = 3000, kind = "", onTap = null) {
    // One line, one fact. Anything longer is a card, not a toast.
    msg = String(msg).replace(/\.\s*$/, ""); if (msg.length > 72) msg = msg.slice(0, 70).replace(/\s+\S*$/, "") + "…";
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
// ── toolstrip.js ────────────────────────────────────────────────
// A short personal rail, with the complete inventory named in one list.
(function () {
  "use strict";
  const GROUPS = [
    ["Weather", ["radar", "sat", "obs", "aurora", "iso", "aod"]],
    ["Hazards", ["alerts", "storms", "thunder", "sigmet", "fires", "smoke", "aq", "quakes"]],
    ["Mountains", ["winter", "avy", "resorts"]],
    ["Analysis", ["particles", "barbs", "xsection", "route", "measure"]],
  ];
  // The rail shows a fixed short set plus whatever is switched on; the full
  // inventory lives in the flyout. No per-user pinning (Jeff 2026-09-04:
  // "drop the whole favorites/star spiel").
  const RAIL = new Set(["radar", "alerts", "obs", "particles"]);
  try { localStorage.removeItem("wxgrid.toolPins"); } catch (_) { /* nothing stored */ }
  function fit() {
    const st = document.querySelector("#tstrip"), pop = document.querySelector("#strip-more-pop");
    if (!st || !pop || getComputedStyle(st).display === "none") return;
    const more = document.querySelector("#strip-more");
    pop.inert = !st.classList.contains("more-open");
    st.style.setProperty("--strip-btn", "36px");
    st.querySelectorAll(".sep").forEach(el => { el.hidden = true; });
    st.querySelectorAll("button[data-for]").forEach(b => {
      const key = b.dataset.for.replace(/-toggle$/, ""), source = document.getElementById(b.dataset.for);
      const on = source.classList.contains("on");
      b.classList.toggle("on", on); b.hidden = !RAIL.has(key) && !on;
      b.setAttribute("aria-pressed", String(on));
    });
    more.hidden = false;
    more.setAttribute("aria-expanded", String(st.classList.contains("more-open")));
    more.setAttribute("aria-label", "All weather tools");
    const top = st.getBoundingClientRect().top;
    const floor = innerHeight - document.querySelector("#timebar").getBoundingClientRect().height - 16;
    const candidates = [...st.querySelectorAll("button[data-for]")].filter(b => !b.hidden).reverse();
    while (st.getBoundingClientRect().bottom > floor && candidates.length) candidates.shift().hidden = true;
    pop.style.maxHeight = Math.max(120, floor - top) + "px";
    if (pop.dataset.built) {
      pop.querySelectorAll("[data-action]").forEach(b => b.setAttribute("aria-pressed", String(document.getElementById(b.dataset.action + "-toggle").classList.contains("on"))));
      return;
    }
    pop.dataset.built = "1";
    pop.setAttribute("aria-label", "All weather tools");
    pop.innerHTML = GROUPS.map(([label, keys]) => `<section class="tool-group"><h3>${label}</h3>${keys.map(key => {
      const original = st.querySelector(`[data-for="${key}-toggle"]`);
      if (!original) return "";
      const title = original.dataset.tip;
      return `<div class="tool-row"><button data-action="${key}" aria-pressed="${original.classList.contains("on")}">${original.innerHTML}<span>${title}</span></button></div>`;
    }).join("")}</section>`).join("");
    pop.addEventListener("click", e => {
      const action = e.target.closest("[data-action]");
      if (action) document.getElementById(action.dataset.action + "-toggle").click();
      fit();
    });
  }
  window.WX.toolstrip = { fit };
})();

;
// ── field-requests.js ───────────────────────────────────────────
// Reserve bandwidth for what is on screen; speculative frames get one slot.
(function () {
  "use strict";
  class FieldRequests {
    constructor(work, retryMs = 500) {
      this.work = work;
      this.retryMs = retryMs;
      this.jobs = new Map();
      this.active = 0;
    }
    request(url, selected) {
      let job = this.jobs.get(url);
      if (job) {
        job.selected ||= selected;
        this.pump();
        return job.promise;
      }
      job = { url, selected, active: false, controller: new AbortController() };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      this.jobs.set(url, job);
      this.pump();
      return job.promise;
    }
    retain(urls) {
      for (const [url, job] of this.jobs) {
        if (urls.has(url)) continue;
        this.jobs.delete(url);
        job.controller.abort();
        job.reject(new DOMException("Superseded", "AbortError"));
      }
    }
    pump() {
      const jobs = [...this.jobs.values()];
      const waiting = jobs.filter(j => !j.active).sort((a, b) => Number(b.selected) - Number(a.selected));
      let speculative = jobs.filter(j => j.active && !j.selected).length;
      for (const job of waiting) {
        if (this.active >= 3) break;
        if (!job.selected && speculative >= 1) continue;
        job.active = true; this.active++;
        if (!job.selected) speculative++;
        this.run(job);
      }
    }
    async run(job) {
      const signal = job.controller.signal;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            signal.throwIfAborted();
            const value = await this.work(job.url, signal, job.selected);
            signal.throwIfAborted();
            job.resolve(value);
            break;
          } catch (err) {
            if (signal.aborted || attempt || (err.status && err.status < 500) || /altered/.test(err.message)) throw err;
            await new Promise(resolve => setTimeout(resolve, this.retryMs));
          }
        }
      } catch (err) { job.reject(err); }
      finally {
        this.active--;
        if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
        this.pump();
      }
    }
  }
  window.WX.FieldRequests = FieldRequests;
})();

;
// ── field.js ────────────────────────────────────────────────────
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
  let requestKey = "";
  const requests = new WX.FieldRequests(async (url, signal, selected) => {
    const res = await fetch(url, { signal, priority: selected ? "high" : "low",
      headers: { Accept: "image/webp,image/png;q=0.9,*/*;q=0.5" } });
    if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
    return decodeBlob(await res.blob());
  });

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
        const url = URL.createObjectURL(blob);
        im.onload = () => { URL.revokeObjectURL(url); res(im); };
        im.onerror = (err) => { URL.revokeObjectURL(url); rej(err); };
        im.src = url;
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

  function entryFor(url, selected = false) {
    let e = cache.get(url);
    if (e && e.failed && Date.now() >= e.retryAt) { cache.delete(url); e = null; }
    if (e) {
      e.used = ++serial;
      if (!e.img && !e.failed && selected) requests.request(url, true).catch(() => {});
      return e;
    }
    e = { url, img: null, tex: null, bytes: 0, used: ++serial, failed: false, promise: null };
    e.promise = (async () => {
      const img = await requests.request(url, selected);
      e.img = img; e.bytes = img.data.byteLength;
      cacheBytes += e.bytes;
      evict(layer.gl);
      return e;
    })().catch((err) => {
      e.failed = true; e.error = err; e.retryAt = Date.now() + 5000;
      if (err.name === "AbortError" && cache.get(url) === e) cache.delete(url);
      throw err;
    });
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
    const e = entryFor(url, true);
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
    const key = `${spec.a}|${spec.b || ""}`;
    if (key !== requestKey) {
      requestKey = key;
      const wanted = new Set([spec.a, spec.b]);
      requests.retain(wanted);
      // Remove cancelled entries immediately so a quick reversal can ask
      // for the same URL again before the abort promise settles.
      for (const [url, e] of cache) if (!e.img && !e.failed && !wanted.has(url)) cache.delete(url);
    }
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
    metric: { label: "Metric", note: "°C · km/h · mm", values: { temp: "c", wind: "kmh", precip: "mm", snow: "cm", dist: "km", alt: "m", baro: "metric", press: "hpa" } },
    us: { label: "US", note: "°F · mph · in", values: { temp: "f", wind: "mph", precip: "in", snow: "in", dist: "mi", alt: "ft", baro: "feet", press: "inhg" } },
    aviation: { label: "Aviation", note: "°C · kt · NM · FL", values: { temp: "c", wind: "kt", precip: "mm", snow: "cm", dist: "nm", alt: "ft", baro: "flight", press: "hpa" } },
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
      { key: "clock", label: "Clock", opts: [["auto", "Auto"], ["24", "24 h"], ["12", "12 h"]] },
      { key: "tz", label: "Time zone", opts: [["local", "Device"], ["point", "Map"], ["utc", "UTC"]] },
    ] },
  ];

  const style = document.createElement("style");
  style.textContent = `
  #settings-scrim{position:absolute;inset:0;z-index:15;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);opacity:0;transition:opacity .18s}
  #settings-scrim.on{opacity:1}
  #settings{position:absolute;top:0;right:0;bottom:0;width:min(400px,100%);z-index:16;display:flex;flex-direction:column;
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
  #settings .sbody{flex:1;overflow-y:auto;padding:8px 16px 24px;overscroll-behavior:contain}
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
  #settings details.advanced,#settings details.utility{margin-top:10px;border:1px solid var(--line);border-radius:12px;background:rgba(127,127,127,.025);overflow:hidden}
  #settings details.advanced summary,#settings details.utility summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none;
    font:650 12px var(--font-display);color:var(--fg-2)}
  #settings details.advanced summary::-webkit-details-marker,#settings details.utility summary::-webkit-details-marker{display:none}
  #settings details.advanced summary::after,#settings details.utility summary::after{content:"";margin-left:auto;width:7px;height:7px;flex:0 0 7px;
    border-right:1.7px solid var(--dim);border-bottom:1.7px solid var(--dim);border-radius:0.5px;
    transform:rotate(45deg) translate(-1px,-1px);transition:transform .16s}
  #settings details.advanced summary:hover::after,#settings details.utility summary:hover::after{border-color:var(--fg-2)}
  #settings details.advanced[open] summary::after,#settings details.utility[open] summary::after{transform:rotate(225deg) translate(-2px,-2px)}
  #settings details.advanced .advanced-body{padding:2px 10px 8px;border-top:1px solid var(--line)}
  #settings details.utility .utility-body{padding:7px 10px 10px;border-top:1px solid var(--line)}
  #settings .setting-list{border:1px solid var(--line);border-radius:12px;background:rgba(127,127,127,.025);overflow:hidden}
  #settings .row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  #settings .row>span{font:600 12.5px var(--font-display);color:var(--fg-2);flex:0 0 84px}
  #settings .setting-list .row{margin:0;padding:8px 10px}
  #settings .setting-list .row+.row{border-top:1px solid var(--line)}
  #settings .seg{flex:1;display:flex;padding:2px;gap:2px}
  #settings .seg button{flex:1;border:0;background:transparent;color:var(--fg-2);padding:5px 4px;border-radius:7px;
    font:600 11.5px var(--font-display);cursor:pointer;white-space:nowrap}
  #settings .seg button.on{background:var(--accent);color:var(--accent-ink)}
  #settings .krow{display:flex;justify-content:space-between;gap:12px;font:500 12px var(--font-body);color:var(--fg-2);padding:4px 2px}
  #settings kbd{font:600 10.5px var(--font-mono);background:var(--bg-3,rgba(255,255,255,.08));border:1px solid var(--line);
    border-radius:5px;padding:1px 6px;color:var(--fg)}
  #settings .utility .note{display:block;margin:8px 2px 0;line-height:1.35}
  @media (max-width:540px){#settings{width:100%}}
  @media (max-width:380px){#settings .preset{padding:10px 8px}#settings .preset small{font-size:8.5px}}
  `;
  document.head.appendChild(style);

  function build() {
    if ($("#settings")) return;
    const scrim = document.createElement("div"); scrim.id = "settings-scrim"; scrim.hidden = true;
    const el = document.createElement("aside"); el.id = "settings"; el.hidden = true;
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "settings-title");
    el.innerHTML = `<div class="sh"><div><b id="settings-title">Settings</b><small>Units, time & display</small></div><button class="icon" id="settings-close" type="button" title="Close" aria-label="Close settings">×</button></div>
      <div class="sbody">
        <div class="grp"><h4>Measurement system</h4><div class="presets">
          ${Object.entries(PRESETS).map(([key, p]) => `<button type="button" class="preset" data-preset="${key}"><b>${p.label}</b><small>${p.note}</small></button>`).join("")}
        </div>
        <details class="advanced"><summary>Customize each unit</summary><div class="advanced-body">
          ${GROUPS[0].rows.map((r) => `
          <div class="row"><span>${r.label}</span><div class="seg" data-key="${r.key}" role="group" aria-label="${r.label}">
            ${r.opts.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}
          </div></div>`).join("")}
        </div></details></div>
        <div class="grp"><h4>${GROUPS[1].title}</h4><div class="setting-list">${GROUPS[1].rows.map((r) => `
          <div class="row"><span>${r.label}</span><div class="seg" data-key="${r.key}" role="group" aria-label="${r.label}">
            ${r.opts.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}
          </div></div>`).join("")}</div></div>
        <div class="grp"><h4>Display</h4><div class="setting-list">
          <div class="row"><span>Theme</span><div class="seg" data-key="theme" role="group" aria-label="Theme">
            <button type="button" data-v="dark">Dark</button><button type="button" data-v="light">Light</button></div></div>
          <div class="row"><span>Wind</span><div class="seg" data-key="motion" role="group" aria-label="Wind display">
            <button type="button" data-v="particles">Flow</button><button type="button" data-v="barbs">Barbs</button><button type="button" data-v="off">Off</button></div></div>
          <div class="row"><span>Animation</span><div class="seg" data-key="playms" role="group" aria-label="Animation speed">
            <button type="button" data-v="1400">Slow</button><button type="button" data-v="900">Normal</button><button type="button" data-v="450">Fast</button></div></div>
        </div>
        </div>
        <details class="utility"><summary>Keyboard shortcuts</summary><div class="utility-body">
          <div class="krow"><span>Step forward / back</span><span><kbd>←</kbd> <kbd>→</kbd></span></div>
          <div class="krow"><span>Play / pause</span><span><kbd>space</kbd></span></div>
          <div class="krow"><span>Search</span><span><kbd>/</kbd></span></div>
          <div class="krow"><span>Layer menu</span><span><kbd>L</kbd></span></div>
          <div class="krow"><span>Close</span><span><kbd>esc</kbd></span></div>
        </div></details>
        <details class="utility"><summary>Embed this view</summary><div class="utility-body">
          <textarea class="embed-code" id="embed-code" readonly spellcheck="false" aria-label="Embed code"></textarea>
          <div class="embed-row"><button type="button" id="embed-copy">Copy</button><span class="note">Current model, field, time and split view.</span></div>
        </div></details>
      </div>`;
    document.body.appendChild(scrim); document.body.appendChild(el);
    scrim.onclick = close;
    $("#settings-close").onclick = close;
    $("#embed-copy").onclick = async () => {
      const ta = $("#embed-code");
      try { await navigator.clipboard.writeText(ta.value); WX.toast("Embed code copied", 2500); }
      catch (e) { ta.focus(); ta.select(); WX.toast("Select and copy the code", 3000); }
    };
    el.querySelectorAll(".preset").forEach((button) => button.onclick = () => {
      WX.units.setMany(PRESETS[button.dataset.preset].values);
      el.querySelector("details.advanced").open = false;
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
      seg.querySelectorAll("button").forEach((b) => {
        const on = String(cur[k]) === b.dataset.v;
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
      });
    });
    let active = null;
    for (const [key, preset] of Object.entries(PRESETS))
      if (Object.entries(preset.values).every(([unit, value]) => pref[unit] === value)) active = key;
    el.querySelectorAll(".preset").forEach((button) => {
      const on = button.dataset.preset === active;
      button.classList.toggle("on", on); button.setAttribute("aria-pressed", String(on));
    });
    if (!active) el.querySelector("details.advanced").open = true;
  }

  // The iframe snippet for the current view: same hash the permalink carries.
  function embedCode() {
    const src = `${location.origin}${location.pathname}?embed=1${location.hash}`;
    return `<iframe src="${src}" width="800" height="450" style="border:0;border-radius:12px" loading="lazy" allow="fullscreen" title="wxgrid"></iframe>`;
  }
  let returnFocus = null, closeTimer = 0;
  function open(opener = null) {
    build(); const el = $("#settings"), s = $("#settings-scrim");
    if (!el.hidden) return;
    returnFocus = null;
    const candidate = opener instanceof HTMLElement ? opener : document.activeElement;
    if (candidate instanceof HTMLElement && candidate !== document.body && !el.contains(candidate)) returnFocus = candidate;
    clearTimeout(closeTimer); el.hidden = false; s.hidden = false; paint();
    const code = $("#embed-code"); if (code) code.value = embedCode();
    requestAnimationFrame(() => { el.classList.add("on"); s.classList.add("on"); $("#settings-close").focus({ preventScroll: true }); });
  }
  function close() {
    const el = $("#settings"), s = $("#settings-scrim"); if (!el || el.hidden) return;
    el.classList.remove("on"); s.classList.remove("on");
    closeTimer = setTimeout(() => { el.hidden = true; s.hidden = true; if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); }, 220);
  }
  // The desktop strip is rebuilt by app.js as controls change. Delegate its
  // settings action here, where the drawer lifecycle lives, so render order
  // cannot leave a visible gear disconnected from the hidden menu copy.
  document.addEventListener("click", (e) => { const opener = e.target.closest("#strip-settings"); if (opener) open(opener); });
  document.addEventListener("keydown", (e) => {
    const el = $("#settings");
    if (e.key === "Escape" && el && !el.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
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
      ["Save this place", I.star, () => { WX.search.toggleFav(lngLat.lat, lon, WX.fmtCoords(lngLat.lat, lngLat.lng)); WX.fn.toast("Saved to search", 3000); }],
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
    if (!force && (localStorage.getItem(KEY) || ARRIVED_WITH_VIEW || document.body.classList.contains("embed"))) return;
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
  let quakePopup = null, quakeDepth = {};

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
    } catch (e) { WX.fn.toast("No isolines for this layer", 4000, "error"); }
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

  // ── basemap contrast: roads and borders readable under any ramp ──────
  // The vector style draws roads and admin lines UNDER the weather field
  // (the field sits just below the first symbol layer), so a saturated
  // temperature or rain ramp swallowed them. Lift the lines that carry
  // orientation — motorways, major roads, borders — above the field, and
  // give each a contrasting halo so they read on any colour. Idempotent:
  // runs after every style swap and every wx-layer rebuild.
  // motorways, major roads (trunk/primary/secondary/tertiary) and borders only:
  // minor streets stay under the field, a lifted street grid was a black net
  const LIFT_RE = /^(highway_(motorway|major|trunk_primary|secondary_tertiary)(_inner|_casing)?|bridge_(motorway|trunk_primary|secondary_tertiary)(_inner|_casing)?|boundary_(2|3|state|country.*|disputed))$/;
  const HALO_RE = /^(highway_(motorway|major|trunk_primary|secondary_tertiary)(_inner)?|bridge_(motorway|trunk_primary|secondary_tertiary)|boundary_(2|3|state|country.*))$/;
  function boostBasemap() {
    const m = M(); if (!m || !m.getStyle) return;
    const style = m.getStyle(); if (!style || !style.layers) return;
    const light = document.documentElement.dataset.theme === "light";
    const anchor = WX.fn.firstSymbolId();
    // Under the field, the dark style draws every street near-black, and a
    // half-transparent ramp turned that into a black net (Jeff 2026-09-04).
    // Those stay below the field but become faint warm-grey streets.
    if (!light) for (const l of style.layers) {
      if (l.type !== "line" || !/^(highway_|road_|bridge_|tunnel_)/.test(l.id) || LIFT_RE.test(l.id)) continue;
      m.setPaintProperty(l.id, "line-color", "hsl(35,8%,60%)");
      m.setPaintProperty(l.id, "line-opacity", /casing|subtle/.test(l.id) ? 0.25 : 0.45);
    }
    const lines = style.layers.filter((l) => l.type === "line" && LIFT_RE.test(l.id));
    for (const l of lines) {
      const border = /^boundary/.test(l.id);
      const haloId = `${l.id}__halo`;
      if (HALO_RE.test(l.id) && !m.getLayer(haloId)) {
        // the halo is the same geometry, wider, in the colour the line is not
        const spec = { id: haloId, type: "line", source: l.source, "source-layer": l["source-layer"], filter: l.filter,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": light ? "hsl(0,0%,18%)" : "hsl(0,0%,92%)", "line-opacity": border ? 0.3 : 0.2, "line-blur": 0.6,
                   "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 5, border ? 2.2 : 1.6, 10, border ? 3.4 : 3.2, 16, border ? 6 : 12] } };
        if (l.minzoom != null) spec.minzoom = l.minzoom; if (l.maxzoom != null) spec.maxzoom = l.maxzoom;
        m.addLayer(spec, anchor);
      }
      // the line itself: above the field, a touch stronger than the style shipped it
      if (anchor && m.getLayer(l.id)) { if (m.getLayer(haloId)) m.moveLayer(haloId, anchor); m.moveLayer(l.id, anchor); }
          const motorway = /motorway/.test(l.id);
      // major roads fade in from z9 to z11 so a regional view keeps only the
      // motorways and borders; zoomed in, the network fills in
      const fade = (full) => motorway || border ? full : ["interpolate", ["linear"], ["zoom"], 9, 0, 11, full];
      if (border) {
        m.setPaintProperty(l.id, "line-color", light ? "hsl(0,0%,30%)" : "hsl(0,0%,78%)");
        m.setPaintProperty(l.id, "line-opacity", 0.85);
      } else if (/_inner$/.test(l.id)) {
        // hierarchy by weight and brightness, not hue: motorways are the
        // brightest, widest line; no colour competes with the ramp or the
        // app's own accent (Jeff 2026-09-04: not yellow, not orange)
        m.setPaintProperty(l.id, "line-color", motorway ? (light ? "#ffffff" : "hsl(35,10%,88%)") : (light ? "hsl(35,25%,93%)" : "hsl(35,10%,74%)"));
        m.setPaintProperty(l.id, "line-opacity", fade(0.95));
      } else if (/_casing$/.test(l.id)) {
        m.setPaintProperty(l.id, "line-color", motorway ? (light ? "hsl(30,12%,42%)" : "hsl(30,8%,26%)") : (light ? "hsl(30,15%,48%)" : "hsl(30,8%,32%)"));
        m.setPaintProperty(l.id, "line-opacity", fade(0.6));
      }
      if (m.getLayer(haloId) && !motorway && !border) m.setPaintProperty(haloId, "line-opacity", fade(0.2));
    }
  }

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
      WX.fn.toast(rated ? `${rated} avalanche regions rated` : "Avalanche regions · off season, no ratings", 5000);
    } catch (e) { WX.fn.toast("Avalanche layer unavailable", 4000, "error"); state.avy = false; $("#avy-toggle").classList.remove("on"); }
  }
  function clearAvy() { ["avy-line", "avy-fill"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("avy")) M().removeSource("avy"); }

  // ── ski resorts overlay ───────────────────────────────────────────────
  // Pins for every resort; when a snow layer is showing, each pin is sized
  // and coloured by the forecast snowfall in the next 72 h from the selected
  // time (the OpenSnow map), with the amount as its label.
  let resortsCatalog = null, resortSnow = null, resortSnowKey = "", pendingSnow = null;
  const SNOW_STOPS = [0, "#8a8f98", 5, "#9dd3ff", 15, "#6cb6ff", 30, "#8b7cff", 60, "#e05bd0", 100, "#ff5c8a"];
  function resortIcon() {
    const c = document.createElement("canvas"); c.width = 48; c.height = 48;
    const x = c.getContext("2d");
    x.lineJoin = "round"; x.lineCap = "round";
    x.beginPath(); x.moveTo(6, 37); x.lineTo(19, 16); x.lineTo(26, 27); x.lineTo(31, 20); x.lineTo(42, 37); x.closePath();
    x.lineWidth = 5; x.strokeStyle = "rgba(8,12,18,.86)"; x.stroke();
    x.lineWidth = 2.5; x.strokeStyle = "#f7fbff"; x.stroke();
    x.beginPath(); x.moveTo(30, 21); x.lineTo(30, 9); x.lineTo(40, 13); x.lineTo(30, 17);
    x.lineWidth = 4; x.strokeStyle = "rgba(8,12,18,.86)"; x.stroke();
    x.lineWidth = 2; x.strokeStyle = "#ffb454"; x.stroke();
    return x.getImageData(0, 0, 48, 48);
  }
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
      const gj = { type: "FeatureCollection", features: resortsCatalog.map((r) => {
        const sn = snowMode && resortSnow && resortSnowKey === key ? resortSnow[r.id] : null;
        const amount = sn != null && sn >= 1 ? `${Math.round(sn)} cm` : "";
        return { type: "Feature", properties: {
          id: r.id, name: r.name, region: r.region || "", country: r.country || "",
          featured: r.featured ? 1 : 0, snow: sn == null ? -1 : sn,
          label: sn == null ? r.name : amount,
          featured_label: amount ? `${r.name} · ${amount}` : r.name,
        }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } };
      }) };
      if (M().getSource("resorts")) M().getSource("resorts").setData(gj);
      else {
        M().addSource("resorts", { type: "geojson", data: gj });
        M().addLayer({ id: "resort-all-pts", type: "circle", source: "resorts", minzoom: 7,
          filter: ["==", ["get", "featured"], 0], paint: {} });
        M().addLayer({ id: "resort-pts", type: "circle", source: "resorts",
          filter: ["==", ["get", "featured"], 1], paint: {} });
        if (!M().hasImage("resort-mountain")) M().addImage("resort-mountain", resortIcon(), { pixelRatio: 2 });
        M().addLayer({ id: "resort-icon", type: "symbol", source: "resorts",
          filter: ["==", ["get", "featured"], 1],
          layout: { "icon-image": "resort-mountain", "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.72, 8, 1], "icon-allow-overlap": true, "icon-ignore-placement": true } });
        M().addLayer({ id: "resort-lbl", type: "symbol", source: "resorts", minzoom: 7,
          filter: ["==", ["get", "featured"], 0],
          layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.2 } });
        M().addLayer({ id: "resort-featured-lbl", type: "symbol", source: "resorts", minzoom: 3,
          filter: ["==", ["get", "featured"], 1],
          layout: { "text-field": ["get", "featured_label"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10.5, 8, 12], "text-offset": [0, 1.5], "text-anchor": "top", "text-font": ["Noto Sans Regular"], "text-optional": true },
          paint: { "text-color": "#f4f7fb", "text-halo-color": "rgba(0,0,0,.82)", "text-halo-width": 1.4 } });
      }
      // paint by mode
      const snowColor = ["case", ["<", ["get", "snow"], 0], "#ffb454", ["interpolate", ["linear"], ["get", "snow"], ...SNOW_STOPS]];
      for (const id of ["resort-pts", "resort-all-pts"]) {
        M().setPaintProperty(id, "circle-color", snowMode ? snowColor : "#ffb454");
        M().setPaintProperty(id, "circle-radius", snowMode
          ? ["interpolate", ["linear"], ["zoom"], 3, ["+", 3, ["*", 0.05, ["max", 0, ["get", "snow"]]]], 8, ["+", 5, ["*", 0.12, ["max", 0, ["get", "snow"]]]]]
          : ["interpolate", ["linear"], ["zoom"], 3, 3.5, 8, 7]);
        M().setPaintProperty(id, "circle-stroke-color", "#0b0d10");
        M().setPaintProperty(id, "circle-stroke-width", 1.2);
        M().setPaintProperty(id, "circle-opacity", 0.92);
      }
      M().setLayerZoomRange("resort-lbl", 7, 24);
      M().setPaintProperty("resort-lbl", "text-color", snowMode ? "#dfe8ff" : "#ffd39a");
    } catch (e) { WX.fn.toast("Resort catalog unavailable", 4000, "error"); }
  }
  function clearResorts() { ["resort-featured-lbl", "resort-lbl", "resort-icon", "resort-pts", "resort-all-pts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("resorts")) M().removeSource("resorts"); }

  let resortReq = 0;
  function removeResortDetailLayers() {
    ["pistes-lbl", "pistes-groomed", "pistes-free", "pistes-line", "pistes-case", "lifts-lbl", "lifts-line", "bnd-line"].forEach((l) => M().getLayer(l) && M().removeLayer(l));
    ["pistes", "lifts", "bnd"].forEach((s) => M().getSource(s) && M().removeSource(s));
  }
  function clearResortDetail() {
    resortReq++;
    removeResortDetailLayers();
    state.resort = null;
    document.body.classList.remove("has-resort");
  }

  // OSM stores one progressive difficulty vocabulary, but the signs skiers
  // actually see are local. Translate only where the country identifies a
  // published convention; an unknown country keeps the OSM grade labels
  // instead of borrowing somebody else's trail map.
  const pisteGrade = (bucket, label, color, mark, shape = "dot", caseColor = "rgba(0,0,0,.65)") => ({
    bucket, label, color, mark, shape, caseColor,
  });
  function pisteScheme(country) {
    const code = String(country || "").trim().toUpperCase();
    const northAmerica = new Set(["US", "USA", "UNITED STATES", "CA", "CAN", "CANADA", "MX", "MEX", "MEXICO"]);
    const oceania = new Set(["AU", "AUS", "AUSTRALIA", "NZ", "NZL", "NEW ZEALAND"]);
    const scandinavia = new Set(["NO", "NOR", "NORWAY", "SE", "SWE", "SWEDEN", "FI", "FIN", "FINLAND", "IS", "ISL", "ICELAND"]);
    const japan = new Set(["JP", "JPN", "JAPAN"]);
    const europe = new Set(["AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LI", "LT", "LU", "MD", "MC", "ME", "NL", "MK", "PL", "PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "CH", "UA", "GB", "UK"]);
    let id = "osm", label = "OSM difficulty", grades;
    if (northAmerica.has(code) || oceania.has(code)) {
      id = northAmerica.has(code) ? "north-america" : "oceania";
      label = northAmerica.has(code) ? "North American ratings" : "Oceania ratings";
      grades = {
        novice: pisteGrade("green", "Easy", "#50d36b", "●", "circle"),
        easy: pisteGrade("green", "Easy", "#50d36b", "●", "circle"),
        intermediate: pisteGrade("blue", "Intermediate", "#3d8bff", "■", "square"),
        advanced: pisteGrade("black", "Difficult", "#111318", "◆", "diamond", "rgba(245,247,250,.88)"),
        expert: pisteGrade("double-black", "Expert", "#111318", "◆◆", "double", "rgba(245,247,250,.88)"),
        freeride: pisteGrade("freeride", "Freeride", "#ffb454", "⬭", "oval"),
        extreme: pisteGrade("double-black", "Expert", "#111318", "◆◆", "double", "rgba(245,247,250,.88)"),
      };
    } else if (japan.has(code)) {
      id = "japan"; label = "Japanese ratings";
      grades = {
        novice: pisteGrade("beginner", "Beginner", "#50d36b", "●", "circle"),
        easy: pisteGrade("beginner", "Beginner", "#50d36b", "●", "circle"),
        intermediate: pisteGrade("intermediate", "Intermediate", "#ff565d", "●", "circle"),
        advanced: pisteGrade("advanced", "Advanced", "#111318", "◆", "diamond", "rgba(245,247,250,.88)"),
        expert: pisteGrade("advanced", "Advanced", "#111318", "◆", "diamond", "rgba(245,247,250,.88)"),
        freeride: pisteGrade("freeride", "Freeride", "#9aa5b4", "—", "dash"),
        extreme: pisteGrade("extreme", "Extreme", "#9aa5b4", "!", "alert"),
      };
    } else if (code && scandinavia.has(code)) {
      id = "scandinavia"; label = "Scandinavian ratings";
      grades = {
        novice: pisteGrade("green", "Green", "#50d36b", "●", "circle"),
        easy: pisteGrade("blue", "Blue", "#3d8bff", "●", "circle"),
        intermediate: pisteGrade("red", "Red", "#ff565d", "●", "circle"),
        advanced: pisteGrade("black", "Black", "#111318", "◆", "diamond", "rgba(245,247,250,.88)"),
        expert: pisteGrade("double-black", "Double black", "#111318", "◆◆", "double", "rgba(245,247,250,.88)"),
        freeride: pisteGrade("freeride", "Ski route", "#ffd34e", "—", "dash"),
        extreme: pisteGrade("extreme", "Extreme", "#9aa5b4", "!", "alert"),
      };
    } else if (europe.has(code)) {
      id = "europe"; label = "European ratings";
      grades = {
        novice: pisteGrade("green", "Green", "#50d36b", "●", "circle"),
        easy: pisteGrade("blue", "Blue", "#3d8bff", "●", "circle"),
        intermediate: pisteGrade("red", "Red", "#ff565d", "●", "circle"),
        advanced: pisteGrade("black", "Black", "#111318", "◆", "diamond", "rgba(245,247,250,.88)"),
        expert: pisteGrade("expert", "Expert", "#ff9f43", "◆◆", "double"),
        freeride: pisteGrade("freeride", "Ski route", "#ffd34e", "—", "dash"),
        extreme: pisteGrade("extreme", "Extreme", "#9aa5b4", "!", "alert"),
      };
    } else {
      grades = {
        novice: pisteGrade("novice", "Novice", "#50d36b", "●", "circle"), easy: pisteGrade("easy", "Easy", "#3d8bff", "●", "circle"),
        intermediate: pisteGrade("intermediate", "Intermediate", "#ff565d", "●", "circle"), advanced: pisteGrade("advanced", "Advanced", "#f1f3f5", "◆", "diamond"),
        expert: pisteGrade("expert", "Expert", "#c78cff", "◆◆", "double"), freeride: pisteGrade("freeride", "Freeride", "#ffb454", "—", "dash"),
        extreme: pisteGrade("extreme", "Extreme", "#9aa5b4", "!", "alert"),
      };
    }
    const unknown = pisteGrade("unknown", "Unrated", "#9aa5b4", "·", "dot");
    const grade = (key) => grades[String(key || "").toLowerCase()] || unknown;
    const order = [...new Map(Object.values(grades).concat(unknown).map((g) => [g.bucket, g])).values()];
    return { id, label, order, grade };
  }
  WX.pisteScheme = pisteScheme;

  async function selectResort(id) {
    const my = ++resortReq;
    try {
      const d = await WX.api(`${API}/resorts/${id}`);
      if (my !== resortReq) return;
      removeResortDetailLayers();
      state.resort = d;
      document.body.classList.add("has-resort");
      const r = d.resort;
      // lifts + boundary on the M()
      const lifts = d.lifts || { type: "FeatureCollection", features: [] };
      if (M().getSource("lifts")) M().getSource("lifts").setData(lifts);
      else {
        M().addSource("lifts", { type: "geojson", data: lifts });
        M().addLayer({ id: "lifts-line", type: "line", source: "lifts", paint: { "line-color": "#ffb454", "line-width": 2, "line-opacity": 0.9 } });
        M().addLayer({ id: "lifts-lbl", type: "symbol", source: "lifts", minzoom: 11, layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 10, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#ffd39a", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1 } });
      }
      // OSM stores one difficulty vocabulary; the map translates it to the
      // signs used where the resort is. Black trails keep their actual black
      // centre and get a pale casing so they remain visible on the dark map.
      const rawPistes = d.pistes || { type: "FeatureCollection", features: [] };
      const scheme = pisteScheme(r.country);
      const pistes = { ...rawPistes, features: (rawPistes.features || []).map((f) => {
        const local = scheme.grade(f.properties && f.properties.grade);
        return { ...f, properties: { ...(f.properties || {}), local_color: local.color,
          local_case: local.caseColor, local_mark: local.mark, local_label: local.label,
          local_bucket: local.bucket } };
      }) };
      if (M().getSource("pistes")) M().getSource("pistes").setData(pistes);
      else {
        M().addSource("pistes", { type: "geojson", data: pistes });
        M().addLayer({ id: "pistes-case", type: "line", source: "pistes", minzoom: 9,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "local_case"], "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.6, 13, 6.5], "line-opacity": 0.9 } });
        // line-dasharray takes no data expression, so ungroomed runs get their
        // own layer rather than a condition MapLibre would reject silently.
        const pisteWidth = ["interpolate", ["linear"], ["zoom"], 9, 1.3, 13, 4];
        M().addLayer({ id: "pistes-line", type: "line", source: "pistes", minzoom: 9,
          filter: ["!=", ["get", "local_bucket"], "freeride"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "local_color"], "line-width": pisteWidth, "line-opacity": 0.95 } });
        M().addLayer({ id: "pistes-free", type: "line", source: "pistes", minzoom: 9,
          filter: ["==", ["get", "local_bucket"], "freeride"],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: { "line-color": ["get", "local_color"], "line-width": pisteWidth, "line-opacity": 0.95, "line-dasharray": [2, 1.4] } });
        // A fine dotted highlight marks runs whose OSM record names a
        // grooming style.  It is static map metadata, not tonight's report.
        M().addLayer({ id: "pistes-groomed", type: "line", source: "pistes", minzoom: 10.5,
          filter: ["match", ["get", "grooming"], ["classic", "mogul", "skating", "scooter", "skicross"], true, false],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "rgba(255,255,255,.86)", "line-width": ["interpolate", ["linear"], ["zoom"], 10.5, 0.8, 14, 1.4], "line-dasharray": [0.6, 1.8], "line-opacity": 0.9 } });
        M().addLayer({ id: "pistes-lbl", type: "symbol", source: "pistes", minzoom: 12.5,
          filter: ["any", ["has", "name"], ["has", "ref"]],
          layout: { "symbol-placement": "line", "text-field": ["concat", ["get", "local_mark"], " ", ["coalesce", ["get", "name"], ["get", "ref"]]], "text-size": 10, "text-font": ["Noto Sans Regular"] },
          paint: { "text-color": "#eef1f5", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.2 } });
      }
      const bnd = d.boundary ? { type: "FeatureCollection", features: [d.boundary] } : { type: "FeatureCollection", features: [] };
      if (M().getSource("bnd")) M().getSource("bnd").setData(bnd);
      else { M().addSource("bnd", { type: "geojson", data: bnd }); M().addLayer({ id: "bnd-line", type: "line", source: "bnd", paint: { "line-color": "#ffb454", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.8 } }, WX.fn.firstSymbolId()); }
      M().flyTo({ center: [r.lon, r.lat], zoom: Math.max(M().getZoom(), 10.5), duration: 900 });
      state.tab = "resort";
      WX.fn.openPoint(r.lat, r.lon, r.name);
    } catch (e) { if (my === resortReq) WX.fn.toast("Resort detail unavailable", 4000, "error"); }
  }
  WX.selectResort = selectResort;

  // ── alerts: warning polygons (GeoJSON) + Environment Canada (GeoMet WMS) ─
  // A tap opens the shared map card. It used to open a toast clipped at 160
  // characters, which is shorter than the area list on a single British
  // thunderstorm warning, so the one thing a reader needed — where is this —
  // was the thing that got cut.
  const ALERT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>`;
  // MeteoAlarm ships its awareness type as a slug; every other source ships a
  // sentence. Spell the slugs out, title-case whatever else arrives.
  const ALERT_WORD = { "high-temp": "High temperature", "low-temp": "Low temperature",
    "snow-ice": "Snow and ice", thunderstorm: "Thunderstorm", forestfire: "Forest fire",
    coastal: "Coastal event", avalanche: "Avalanche", rain: "Rain", flood: "Flood",
    wind: "Wind", fog: "Fog", warning: "Weather warning" };
  const alertTitle = (ev) => ALERT_WORD[ev] || (ev ? String(ev).charAt(0).toUpperCase() + String(ev).slice(1) : "Weather alert");
  const alertWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : WX.units.dateTime(iso, { weekday: "short", hour: "numeric", minute: "2-digit" }); };
  // "3h 20m" / "2 days" / "" once it is past. The feeds give an absolute
  // expiry in UTC; what a reader wants is how long they have.
  function alertLeft(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const ms = t - Date.now();
    if (ms <= 0) return "";
    const m = Math.round(ms / 60e3);
    if (m < 60) return `${m}m`;
    if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.round(m / 1440)} days`;
  }

  let alertPopup = null, alertTick = null, alertReq = 0, alertsBound = false;
  // The polygon under the open card wears a heavier outline, so a card that
  // covers half the screen still says which shape it belongs to.
  const highlightAlert = (id) => M().getLayer("alerts-hi") &&
    M().setFilter("alerts-hi", ["==", ["get", "id"], id == null ? "" : id]);

  function closeAlertCard() {
    if (alertTick) { clearInterval(alertTick); alertTick = null; }
    if (alertPopup) { alertPopup.remove(); alertPopup = null; }
    highlightAlert("");
  }

  // p is the layer's properties (or an alert from /api/alerts/ec, same shape);
  // `detail` is the prose the layer does not carry, once it lands.
  function openAlertCard(lngLat, p, detail) {
    const d = detail || {};
    const ends = p.ends || d.ends, onset = p.onset || d.onset;
    const left = alertLeft(ends);
    const startsIn = alertLeft(onset);
    const text = [d.description || p.description || "", d.instruction || p.instruction || ""].filter(Boolean).join("\n\n");
    const urgency = d.urgency || p.urgency || "";
    const sender = d.sender || p.sender || "";
    const link = d.url || p.url || "";
    const my = ++alertReq;
    closeAlertCard();
    // On a phone the tape owns the bottom half of the screen. Anchor the card
    // near the top of the map there and let it open downward; anchored at the
    // tap it lands under the timebar, where nobody can read or close it.
    const narrow = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
    let at = lngLat;
    if (narrow) {
      const q = M().project(lngLat), h = M().getCanvas().clientHeight || 800;
      at = M().unproject([q.x, Math.round(h * 0.22)]);   // clear of the layer rails on top
    }
    alertPopup = mapCard(at, "alert-pop", {
      icon: ALERT_SVG, color: p.color || "#f0a020", title: alertTitle(p.event),
      pill: p.severity || "", sub: p.source || "", ago: left ? `expires in ${left}` : "expired",
      hero: [{ k: left ? "Expires in" : "Expires", v: left || "now" },
             startsIn ? { k: "Starts in", v: startsIn } : null,
             urgency ? { k: "Urgency", v: urgency } : null].filter(Boolean),
      // no headline row: every source writes it as the event plus the area plus
      // the issuing office, all three of which are already on this card
      rows: [["Area", p.area], ["Effective", alertWhen(onset)], ["Expires", alertWhen(ends)],
             ["Certainty", d.certainty || p.certainty || ""],
             ["Confidence", d.confidence || p.confidence || ""], ["Impact", d.impact || p.impact || ""],
             ["Issued by", sender]],
      raw: text || (detail ? "" : "loading the full text…"),
      src: p.source ? `Source: ${p.source}` : "",
      link: link ? { href: link, text: "Official bulletin" } : null,
      anchor: narrow ? "top" : undefined, maxWidth: "min(360px, 88vw)" });
    highlightAlert(p.id);
    alertPopup.on("close", () => { if (alertTick) { clearInterval(alertTick); alertTick = null; } highlightAlert(""); });
    // the countdown is the one number on this card that goes stale while you
    // read it
    if (left) alertTick = setInterval(() => {
      const el = alertPopup && alertPopup.getElement();
      const box = el && [...el.querySelectorAll(".mc-hero > div")].find((x) => x.querySelector("small") && /Expires/.test(x.querySelector("small").textContent));
      if (!box) return;
      const now = alertLeft(ends);
      box.querySelector("b").textContent = now || "now";
    }, 30000);
    if (!detail && p.id) {
      WX.api(U(`${API}/alerts/detail?id=${encodeURIComponent(p.id)}&source=${encodeURIComponent(p.source || "")}`))
        .then((got) => { if (my === alertReq && alertPopup && got) openAlertCard(lngLat, p, got); })
        .catch(() => { if (my === alertReq && alertPopup) openAlertCard(lngLat, p, { description: "" }); });
    }
  }
  WX.openAlertCard = openAlertCard;

  // The EC layer is a raster: a tap on it has no feature to read, so ask
  // GeoMet what it painted at that point. Only inside its own bounding box,
  // only when a vector alert has not already answered the same tap.
  const EC_BOX = [-141, 41, -52, 84];
  async function ecAlertAt(e) {
    if (!state.alerts || !M().getLayer("ec-alerts")) return;
    const lon = WX.wlon(e.lngLat.lng), lat = e.lngLat.lat;
    if (lon < EC_BOX[0] || lon > EC_BOX[2] || lat < EC_BOX[1] || lat > EC_BOX[3]) return;
    if (M().getLayer("alerts-fill") && M().queryRenderedFeatures(e.point, { layers: ["alerts-fill"] }).length) return;
    try {
      const r = await WX.api(U(`${API}/alerts/ec?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`));
      const hit = (r.alerts || [])[0];
      if (hit) openAlertCard(e.lngLat, hit, hit);
    } catch (err) { /* nothing painted there, or GeoMet is having a day */ }
  }

  async function loadAlerts() {
    try {
      const gj = await WX.api(`${API}/alerts/layer`);
      if (!state.alerts) return;
      if (M().getSource("alerts")) M().getSource("alerts").setData(gj);
      else {
        M().addSource("alerts", { type: "geojson", data: gj });
        M().addLayer({ id: "alerts-fill", type: "fill", source: "alerts", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.28 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-line", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": 1.6 } }, WX.fn.firstSymbolId());
        M().addLayer({ id: "alerts-hi", type: "line", source: "alerts", filter: ["==", ["get", "id"], ""],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 3.2, "line-opacity": 0.9 } }, WX.fn.firstSymbolId());
        M().on("click", "alerts-fill", (e) => { const f = e.features[0]; if (f) openAlertCard(e.lngLat, f.properties); });
        M().on("mouseenter", "alerts-fill", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "alerts-fill", () => { M().getCanvas().style.cursor = ""; });
        if (!alertsBound) { M().on("click", ecAlertAt); alertsBound = true; }
      }
      if (!M().getSource("ec-alerts")) {
        // "ALERTS" was GeoMet's old name for this and now answers
        // "Couche non disponible" — the Canadian layer had been painting
        // nothing at all. The current name is Current-Alerts, and it is
        // queryable, which is what makes the card above possible.
        M().addSource("ec-alerts", { type: "raster", tileSize: 256, attribution: "Alerts © Environment Canada",
          tiles: ["https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=Current-Alerts&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES="] });
        M().addLayer({ id: "ec-alerts", type: "raster", source: "ec-alerts", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
      }
      WX.fn.toast(`${gj.features.length} warning areas plus Environment Canada · tap one to read it`, 4500);
    } catch (e) { WX.fn.toast("Alerts unavailable", 4000, "error"); state.alerts = false; $("#alerts-toggle").classList.remove("on"); }
  }
  function clearAlerts() { closeAlertCard(); ["alerts-hi", "alerts-line", "alerts-fill", "ec-alerts"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); ["alerts", "ec-alerts"].forEach((sname) => M().getSource(sname) && M().removeSource(sname)); }

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
        // The GEFS members: thirty thin lines under the official track, the
        // width of the forecast before the cone smooths it. Off until the
        // card asks for them, and only ever for the storm whose card is open.
        M().addLayer({ id: "storm-ens", type: "line", source: "storms",
          filter: ["all", ["==", ["get", "layer"], "ens"], ["==", ["get", "id"], ""]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["case", ["get", "mean"], "rgba(255,255,255,.62)", "rgba(255,255,255,.26)"],
                   "line-width": ["case", ["get", "mean"], 1.7, 0.9] } });
        // Where it has been: solid and quiet, per storm, shown when its card
        // is open. Forecast stays dashed; history is fact, so it is solid.
        M().addLayer({ id: "storm-past", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], ""]], paint: { "line-color": "rgba(255,255,255,.45)", "line-width": 1.4 } });
        M().addLayer({ id: "storm-past-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], ""], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 3.2, "circle-color": ["coalesce", ["get", "color"], "#9aa4b2"], "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
        M().addLayer({ id: "storm-track", type: "line", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "LineString"]], paint: { "line-color": "rgba(255,255,255,.72)", "line-width": 1.6, "line-dasharray": [1.6, 1.8] } });
        M().addLayer({ id: "storm-pts", type: "circle", source: "storms", filter: ["all", ["==", ["get", "layer"], "track"], ["==", ["geometry-type"], "Point"]], paint: { "circle-radius": 2.8, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
        // The eye wears its category colour — red deepens with the scale.
        // The eye is the hurricane symbol itself, one image per category
        // colour (Jeff 2026-08-22: the yellow circle was a placeholder).
        for (const col of STORM_COLORS) if (!M().hasImage(`cyc-${col}`)) M().addImage(`cyc-${col}`, cycloneIcon(col), { pixelRatio: 2 });
        M().addLayer({ id: "storm-now", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "icon-image": ["concat", "cyc-", ["coalesce", ["get", "category_color"], "#ef786f"]], "icon-size": 1.15, "icon-allow-overlap": true, "icon-ignore-placement": true } });
        // the category lives INSIDE the eye — "2" in the dark centre, "TD"
        // in the blue one — and the sub-label carries the motion instead
        M().addLayer({ id: "storm-eye", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          layout: { "text-field": ["coalesce", ["get", "eye"], ""], "text-size": 8.5, "text-letter-spacing": -0.04, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true },
          paint: { "text-color": "#fff" } });
        M().addLayer({ id: "storm-lbl", type: "symbol", source: "storms", filter: ["==", ["get", "kind"], "current"],
          // name in bold, motion a notch smaller in regular — two rows, two
          // weights. (The tile server only serves Noto Sans glyphs; the
          // app's Urbanist cannot reach map labels without its own PBFs.)
          layout: { "text-field": ["format", ["concat", ["get", "class"], " ", ["get", "name"]], { "font-scale": 1 }, "\n", {},
                                   ["coalesce", ["get", "moving_short"], ""], { "font-scale": 0.84, "text-font": ["literal", ["Noto Sans Regular"]] }],
                    "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top", "text-font": ["Noto Sans Bold"], "text-line-height": 1.15 },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.4 } });
        M().on("click", "storm-now", (e) => openStormCard(e.features[0]));
        M().on("click", "storm-eye", (e) => openStormCard(e.features[0]));
        M().on("mouseenter", "storm-now", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "storm-now", () => { M().getCanvas().style.cursor = ""; });
      }
      const names = (gj.storms || []).map((x) => `${x.class} ${x.name}`).join(", ");
      WX.fn.toast(names ? `${gj.storms.length} tropical system${gj.storms.length === 1 ? "" : "s"} on the map` : "No tropical systems", 5000);
      if (gj.storms && gj.storms.length && !state.point) { const st = gj.storms[0]; const f = gj.features.find((x) => x.properties.kind === "current" && x.properties.id === st.id); if (f) M().flyTo({ center: f.geometry.coordinates, zoom: Math.max(3.5, Math.min(M().getZoom(), 5)), duration: 1200 }); }
    } catch (e) { WX.fn.toast("Storm feed unavailable", 4000, "error"); state.storms = false; $("#storms-toggle").classList.remove("on"); }
  }
  // ── the map card ──────────────────────────────────────────────────────
  // One builder for every popup on the map. `o`: icon (svg string), color,
  // title, pill, sub, ago, hero [{k, v, unit, note}], rows [[k, v]], raw,
  // src, link {href, text}. Returns the popup; a small "close" bottom-right
  // and a tap anywhere else both close it.
  const escH = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function mapCard(lngLat, cls, o) {
    const hero = (o.hero || []).filter((h) => h && h.v != null && h.v !== "").map((h) =>
      `<div><small>${escH(h.k)}</small><b>${escH(h.v)}${h.unit ? `<i>${escH(h.unit)}</i>` : ""}</b>${h.note ? `<em>${escH(h.note)}</em>` : ""}</div>`).join("");
    const rows = (o.rows || []).filter((r) => r && r[1] != null && r[1] !== "").map(([k, v, rawHtml]) => `<dt>${escH(k)}</dt><dd>${rawHtml ? v : escH(v)}</dd>`).join("");
    const html = `<div class="mc-head">${o.icon ? `<i class="mc-ico" style="color:${o.color || "var(--accent)"}">${o.icon}</i>` : ""}
        <div class="mc-title"><b${o.titleColor ? ` style="color:${o.titleColor}"` : ""}>${escH(o.title)}</b>
        <div class="mc-sub">${o.pill ? `<span class="mc-pill" style="--cat:${o.color || "var(--accent)"}">${escH(o.pill)}</span>` : ""}${o.sub ? `<span>${escH(o.sub)}</span>` : ""}${o.ago ? `<span class="mc-ago">${escH(o.ago)}</span>` : ""}</div></div></div>
      <div class="mc-hero">${hero}</div>
      <dl>${rows}</dl>
      ${o.raw ? `<div class="mc-raw">${escH(o.raw)}</div>` : ""}
      ${o.src ? `<div class="mc-src">${escH(o.src)}</div>` : ""}
      <div class="mc-foot">${o.link ? `<a class="qp-link" href="${escH(o.link.href)}" target="_blank" rel="noopener">${escH(o.link.text)} ↗</a>` : "<span></span>"}<button class="mc-close" type="button">close</button></div>`;
    const pop = new maplibregl.Popup({ className: `quake-pop mapcard ${cls}`, closeButton: false, focusAfterOpen: false, maxWidth: o.maxWidth || "320px", offset: 12, anchor: o.anchor })
      .setLngLat(lngLat).setHTML(html).addTo(M());
    pop.getElement().querySelector(".mc-close").addEventListener("click", () => pop.remove());
    return pop;
  }
  WX.mapCard = mapCard;

  const QUAKE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2.5-6 3 12 3-9 2.5 6 1.5-3H22"/></svg>`;
  let stormPopup = null;
  function openStormCard(f) {
    const p = f.properties;
    const ago = p.updated ? (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`)(Date.now() - new Date(p.updated)) : "";
    const kmh = p.intensity_kt ? Math.round(p.intensity_kt * 1.852) : null;
    const [slon, slat] = f.geometry.coordinates;
    // Which desk is tracking it: the feed says (NHC, CPHC, JTWC).
    const agency = p.agency || (/^cp/i.test(p.id || "") ? "CPHC · Honolulu" : "NHC · Miami");
    const mv = p.movement && !/null/.test(p.movement) ? p.movement : "";
    let mvShown = false;
    if (stormPopup) stormPopup.remove();
    // the spaghetti follows the open card, the same way the past track does
    const showEns = (id) => M().getLayer("storm-ens") &&
      M().setFilter("storm-ens", ["all", ["==", ["get", "layer"], "ens"], ["==", ["get", "id"], id || ""]]);
    showEns("");
    // the card brings the storm's past with it
    const showPast = (id) => ["storm-past", "storm-past-pts"].forEach((l) => M().getLayer(l) && M().setFilter(l, ["all", ["==", ["get", "layer"], "past"], ["==", ["get", "id"], id || ""]].concat(l.endsWith("pts") ? [["==", ["geometry-type"], "Point"]] : [])));
    showPast(p.id);
    stormPopup = mapCard([slon, slat], "storm-pop", {
      icon: WX.CYCLONE_SVG || "", color: p.category_color || "#ef786f",
      title: `${p.class} ${p.name}`, pill: p.category, sub: p.category_label, ago,
      hero: (() => {
        const hero = [p.intensity_kt && { k: "Winds", v: p.intensity_kt, unit: "kt", note: `${kmh} km/h` },
                      p.gusts && { k: "Gusts", v: p.gusts, unit: "kt", note: `${Math.round(p.gusts * 1.852)} km/h` },
                      p.pressure_mb && { k: "Pressure", v: p.pressure_mb, unit: "mb" }].filter(Boolean);
        // A third stat fills the NHC card's empty right slot: heading as a
        // compass point, speed as the note. JTWC cards are already full.
        if (hero.length < 3 && mv) {
          const deg = /(\d+)\s*°/.exec(mv), kt = /at\s+(\d+)/.exec(mv);
          const dir = deg ? ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(+deg[1] / 22.5) % 16] : mv.split(" ")[0];
          hero.push({ k: "Moving", v: dir, unit: "", note: kt ? `at ${kt[1]} kt` : "" });
          mvShown = true;
        }
        return hero;
      })(),
      rows: [mvShown ? null : ["Moving", mv],
             p.ens_members ? ["Spread", `<button type="button" class="mc-ens" aria-pressed="false">${escH(p.ens_members)} GEFS tracks</button>`, true] : null,
             ["Position", WX.fmtCoords ? WX.fmtCoords(slat, slon, 1) : `${slat.toFixed(1)}, ${slon.toFixed(1)}`],
             ["Agency", agency], ["Advisory", p.advisory ? `#${p.advisory}` : ""]].filter(Boolean),
      link: p.url ? { href: p.url, text: "Public advisory" } : null });
    const ensBtn = stormPopup.getElement().querySelector(".mc-ens");
    if (ensBtn) ensBtn.addEventListener("click", () => {
      const on = ensBtn.getAttribute("aria-pressed") !== "true";
      ensBtn.setAttribute("aria-pressed", String(on));
      showEns(on ? p.id : "");
    });
    stormPopup.on("close", () => { showPast(""); showEns(""); });
  }
  WX.openStormCard = openStormCard;
  function clearStorms() {
    if (stormPopup) { stormPopup.remove(); stormPopup = null; } ["storm-lbl", "storm-eye", "storm-now", "storm-pts", "storm-past-pts", "storm-past", "storm-track", "storm-ens", "storm-cone-line", "storm-cone"].forEach((l) => M().getLayer(l) && M().removeLayer(l)); if (M().getSource("storms")) M().removeSource("storms"); }

  // ── satellite: GOES GeoColor via NASA GIBS (timeless URL = latest) ────
  // Three geostationary discs, keyless: GOES East/West GeoColor from NASA
  // GIBS over the Americas and the Pacific; Meteosat MTG (0°, geocolour) and
  // Meteosat IODC (45.5°E, natural colour) from EUMETView's public WMS over
  // Europe, Africa and the Indian Ocean. Himawari has no keyless tile
  // service, so East Asia and the western Pacific stay a gap, and the badge
  // says so.
  // A function, not a table at module scope: WMS() is a const defined further
  // down this file, and reading it here at load time threw (TDZ) and took the
  // whole overlays module with it (2026-09-01).
  const SAT_LAYERS = () => [
    ["sat-east", `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, "Satellite: NASA GIBS / NOAA GOES", 7],
    ["sat-west", `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-West_ABI_GeoColor/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, "Satellite: NASA GIBS / NOAA GOES", 7],
    ["sat-mtg", WMS("mtg_fd:rgb_geocolour", "https://view.eumetsat.int/geoserver/wms"), "Satellite: EUMETSAT Meteosat MTG", 8],
    ["sat-iodc", WMS("msg_iodc:rgb_natural", "https://view.eumetsat.int/geoserver/wms"), "Satellite: EUMETSAT Meteosat IODC", 7],
  ];
  function loadSat() {
    const bust = Math.floor(Date.now() / 6e5);            // a new tile URL every 10 min, so the latest frame wins the cache
    for (const [id, url, attribution, maxzoom] of SAT_LAYERS()) {
      if (M().getSource(id)) continue;
      M().addSource(id, { type: "raster", tileSize: 256, maxzoom, attribution, tiles: [`${url}${url.includes("?") ? "&" : "?"}t=${bust}`] });
      M().addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } }, "wx");
    }
    // The imagery is the point here: the field steps well back, and a badge
    // says what the pixels are and where they end, so a hard disc edge over
    // Asia reads as coverage, not a bug.
    if (M().getLayer("wx")) M().setPaintProperty("wx", "raster-opacity", Math.min(0.3, LAYER_ALPHA[state.layer]));
    badge("sat", `Satellite <b>GOES + Meteosat</b> <small>~1 h old · no Himawari: East Asia / W Pacific uncovered</small>`, "#9fb0c8");
  }
  function clearSat() { SAT_LAYERS().forEach(([l]) => { if (M().getLayer(l)) M().removeLayer(l); if (M().getSource(l)) M().removeSource(l); }); badge("sat", null); WX.fn.applyStep(); }

  // ── corner badges ─────────────────────────────────────────────────────
  // A keyed stack of small chips bottom-left, above the met-service badge:
  // "which radar am I looking at", "which aurora nowcast". Injected rather
  // than added to styles.css so each module carries its own presentation;
  // the values are the app's own tokens, so it follows the theme.
  const BADGE_CSS = `
  #wx-badges { position: absolute; z-index: 5; left: 62px; bottom: calc(var(--tb-h, 150px) + 14px + env(safe-area-inset-bottom));
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
      WX.fn.toast("No radar source answered", 4500, "error");
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
      WX.fn.toast(`${picked.label} · ${state.radarFrames.length} frames, ${span} min`
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
    // radar frames are minutes old or minutes ahead: the age rides in the Now
    // pill the same way a forecast offset does (the latest frame is "Now")
    const nowBtn = $("#tape-now");
    if (nowBtn) { const latest = Math.abs(ageMin) <= 6; nowBtn.innerHTML = latest ? "Now" : `<b class="off">${ageMin >= 0 ? `−${ageMin}m` : `+${-ageMin}m`}</b>`; nowBtn.classList.toggle("on", latest); nowBtn.classList.toggle("away", !latest); }
    badge("radar", `Radar <b>${src.label}</b> <small>${t.toISOString().slice(11, 16)}Z${fr.kind === "nowcast" ? " nowcast" : ""}</small>`, "var(--rain, #6cb6ff)");
    if (WX.fn.renderTapePill) WX.fn.renderTapePill();
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
    toast("Smoke · surface PM2.5, ECCC RAQDPS", 4500);
  }
  function clearSmoke() { if (M().getLayer("smoke")) M().removeLayer("smoke"); if (M().getSource("smoke")) M().removeSource("smoke"); }
  function loadFires() {
    if (M().getSource("fires")) return;
    M().addSource("fires", { type: "raster", tileSize: 256, attribution: "Hotspots: NRCan CWFIS", tiles: [WMS("public:hotspots_last24hrs", "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms")] });
    M().addLayer({ id: "fires", type: "raster", source: "fires", paint: { "raster-opacity": 0.95, "raster-fade-duration": 0 } });
    toast("Hotspots, last 24 h · NRCan CWFIS", 4500);
  }
  function clearFires() { if (M().getLayer("fires")) M().removeLayer("fires"); if (M().getSource("fires")) M().removeSource("fires"); }
  async function loadQuakes() {
    try {
      const gj = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson").then((r) => r.json());
      if (!state.quakes) return;
      // tiles keep only lon/lat — the depth in the third coordinate is gone
      // by the time a click hands the feature back, so remember it by id
      quakeDepth = Object.fromEntries(gj.features.map((q) => [q.id || q.properties.ids, q.geometry.coordinates[2]]));
      if (M().getSource("quakes")) M().getSource("quakes").setData(gj);
      else {
        M().addSource("quakes", { type: "geojson", data: gj });
        M().addLayer({ id: "quakes", type: "circle", source: "quakes", paint: { "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 2.5, 4, 5, 9, 7, 18], "circle-color": ["interpolate", ["linear"], ["get", "mag"], 2.5, "#f5d33c", 5, "#e8590c", 7, "#b30000"], "circle-opacity": 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
        M().on("click", "quakes", (e) => {
          const f = e.features[0], p = f.properties;
          const mag = Number(p.mag);
          const col = mag >= 7 ? "#ff6a5e" : mag >= 5 ? "#e8590c" : "#e3c53c";
          const ago = (ms => ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 86400e3)} d ago`)(Date.now() - p.time);
          const depth = quakeDepth[f.id || p.ids] ?? f.geometry.coordinates[2] ?? null;
          if (quakePopup) quakePopup.remove();
          quakePopup = mapCard(f.geometry.coordinates.slice(0, 2), "eq-pop", {
            icon: QUAKE_SVG, color: col, title: `M${mag.toFixed(1)}`, titleColor: col,
            pill: mag >= 7 ? "major" : mag >= 5 ? "moderate" : "light", sub: p.place || "", ago,
            hero: [depth != null && { k: "Depth", v: Math.round(depth), unit: "km" },
                   Number(p.felt) > 0 && { k: "Felt", v: p.felt, unit: "reports" },
                   Number(p.tsunami) === 1 && { k: "Tsunami", v: "advisory" }],
            rows: [["Time", new Date(p.time).toLocaleString()], ["Source", "USGS"]],
            link: p.url ? { href: p.url, text: "USGS event page" } : null, maxWidth: "290px" });
        });
        M().on("mouseenter", "quakes", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "quakes", () => { M().getCanvas().style.cursor = ""; });
      }
      toast(`${gj.features.length} quakes M2.5+, 24 h · USGS`, 4000);
    } catch (e) { toast("USGS feed unavailable", 4000, "error"); }
  }
  // ── observed: METAR stations across the view ──────────────────────────
  // Observations on a forecast map are the check on the forecast. Pins are
  // coloured by flight category (the aviation shorthand for "how bad is the
  // weather right now"), carry the temperature, and point an arrow the way
  // the wind is blowing; the card shows the decoded report and the raw line.
  let obsReq = 0, obsPopup = null, obsBox = "";
  const FLTCAT = { VFR: "#3ecf6a", MVFR: "#4a9eff", IFR: "#ff5e5e", LIFR: "#d95eff" };
  const OBS_MINZOOM = 4.5;
  function obsWanted() { return state.obs && M().getZoom() >= OBS_MINZOOM; }
  async function loadObs(force) {
    if (!state.obs) return;
    if (!obsWanted()) { if (!force) return; }
    const b = M().getBounds();
    const q = `s=${b.getSouth().toFixed(2)}&w=${Math.max(-180, b.getWest()).toFixed(2)}&n=${b.getNorth().toFixed(2)}&e=${Math.min(180, b.getEast()).toFixed(2)}`;
    if (q === obsBox && M().getSource("obs")) return;
    const my = ++obsReq;
    try {
      const res = await fetch(U(`${API}/obs/layer?${q}`));
      if (my !== obsReq || !state.obs) return;
      if (res.status === 204) { toast("Zoom in for station observations", 3000); return; }
      const gj = await res.json();
      obsBox = q;
      for (const f of gj.features) {
        const p = f.properties;
        p.tempTxt = p.temp_c == null ? "" : `${WX.units.tempC(p.temp_c).v}°`;
        p.windTxt = p.wspd_kt == null ? "" : `${Math.round(speed(p.wspd_kt / 1.943844))}${p.wgst_kt ? `g${Math.round(speed(p.wgst_kt / 1.943844))}` : ""}`;
        p.colour = FLTCAT[p.fltcat] || "#c9d1dc";
        p.hasWind = p.wdir != null && p.wspd_kt > 0 ? 1 : 0;
      }
      if (M().getSource("obs")) M().getSource("obs").setData(gj);
      else {
        M().addSource("obs", { type: "geojson", data: gj });
        // The wind arrow is an SDF sprite (recolourable per station), not a
        // text glyph: the basemap's glyph ranges do not carry arrow symbols.
        // It points the way the air is going, so its tail sits on the station
        // and its head leads downwind — the reported direction is FROM.
        if (!M().hasImage("wx-obs-arrow")) await addObsArrow();
        M().addLayer({ id: "obs-arrow", type: "symbol", source: "obs", minzoom: OBS_MINZOOM, filter: ["==", ["get", "hasWind"], 1],
          layout: { "icon-image": "wx-obs-arrow", "icon-size": ["interpolate", ["linear"], ["coalesce", ["get", "wspd_kt"], 0], 0, 0.6, 15, 0.9, 40, 1.25],
                    "icon-rotate": ["+", ["get", "wdir"], 180], "icon-rotation-alignment": "map", "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true },
          paint: { "icon-color": ["get", "colour"], "icon-opacity": 0.9, "icon-halo-color": "#000", "icon-halo-width": 1 } });
        M().addLayer({ id: "obs", type: "circle", source: "obs", minzoom: OBS_MINZOOM,
          paint: { "circle-radius": 4.2, "circle-color": ["get", "colour"], "circle-stroke-color": "#000", "circle-stroke-width": 1.2, "circle-opacity": 0.95 } });
        M().addLayer({ id: "obs-label", type: "symbol", source: "obs", minzoom: OBS_MINZOOM,
          layout: { "text-field": ["concat", ["get", "tempTxt"], ["case", ["==", ["get", "windTxt"], ""], "", ["concat", "  ", ["get", "windTxt"]]]],
                    "text-size": 11, "text-anchor": "left", "text-offset": [0.9, 0], "text-font": ["Noto Sans Bold"], "text-optional": true },
          paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.85)", "text-halo-width": 1.3 } });
        M().on("click", "obs", (e) => {
          const f = e.features[0], p = f.properties;
          const when = p.time ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(p.time) ? p.time : p.time.replace(" ", "T") + "Z") : NaN;
          const ago = Number.isFinite(when) ? (ms => ms < 90e3 ? "just now" : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${(ms / 3600e3).toFixed(1)} h ago`)(Date.now() - when) : "";
          if (obsPopup) obsPopup.remove();
          const wind = p.wspd_kt == null ? "—" : p.wdir == null ? `variable ${Math.round(speed(p.wspd_kt / 1.943844))} ${speedUnit()}` : `${Math.round(p.wdir)}° ${Math.round(speed(p.wspd_kt / 1.943844))}${p.wgst_kt ? ` gusting ${Math.round(speed(p.wgst_kt / 1.943844))}` : ""} ${speedUnit()}`;
          obsPopup = mapCard(f.geometry.coordinates, "obs-pop", {
            icon: "", color: p.colour, title: p.id, titleColor: p.colour, pill: p.fltcat || "obs", sub: p.name || "", ago,
            hero: [p.temp_c != null && p.temp_c !== "null" && { k: "Temp", v: WX.units.tempC(Number(p.temp_c)).v, unit: WX.units.tempUnit },
                   p.dewpoint_c != null && p.dewpoint_c !== "null" && { k: "Dew pt", v: WX.units.tempC(Number(p.dewpoint_c)).v, unit: WX.units.tempUnit },
                   p.ceiling_ft != null && { k: "Ceiling", v: Math.round(Number(p.ceiling_ft)), unit: "ft" }],
            rows: [["Wind", wind], ["Visibility", p.visib != null && p.visib !== "null" ? `${p.visib} SM` : "—"], ["Pressure", p.altim_hpa != null && p.altim_hpa !== "null" ? `${Number(p.altim_hpa).toFixed(1)} hPa` : "—"],
                   p.wx && p.wx !== "null" ? ["Weather", p.wx] : null, ["METAR", p.raw || "—"]].filter(Boolean),
            maxWidth: "340px" });
        });
        M().on("mouseenter", "obs", () => { M().getCanvas().style.cursor = "pointer"; });
        M().on("mouseleave", "obs", () => { M().getCanvas().style.cursor = ""; });
      }
      if (force) toast(`${gj.features.length} stations reporting · aviationweather.gov`, 3500);
    } catch (e) { if (force) toast("Station observations unavailable", 4000, "error"); }
  }
  function addObsArrow() {
    return new Promise((resolve) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="40" viewBox="0 0 24 40"><path d="M12 2 L21 16 L15 16 L15 38 L9 38 L9 16 L3 16 Z" fill="#fff"/></svg>`;
      const img = new Image(24, 40);
      img.onload = () => { try { if (!M().hasImage("wx-obs-arrow")) M().addImage("wx-obs-arrow", img, { sdf: true }); } catch (e) { /* raced another load */ } resolve(); };
      img.onerror = () => resolve();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }
  function refreshObs() { if (state.obs) loadObs(false); }
  function clearObs() {
    obsBox = "";
    if (obsPopup) { obsPopup.remove(); obsPopup = null; }
    for (const id of ["obs-label", "obs-arrow", "obs"]) if (M().getLayer(id)) M().removeLayer(id);
    if (M().getSource("obs")) M().removeSource("obs");
  }

  // ── aerosol optical depth: MODIS Terra+Aqua combined, yesterday (NASA GIBS)
  function loadAod() {
    if (M().getSource("aod")) return;
    const d = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    M().addSource("aod", { type: "raster", tileSize: 256, maxzoom: 6, attribution: "Aerosol: NASA GIBS MODIS",
      tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/${d}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`] });
    M().addLayer({ id: "aod", type: "raster", source: "aod", paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 } }, WX.fn.firstSymbolId());
    toast(`Aerosol depth · MODIS ${d}`, 5000);
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
    } catch (e) { if (my === thunderReq) toast("No thunder marks for this model", 4000, "error"); }
  }
  // A yellow lightning bolt with a dark outline, drawn once into a canvas.
  // The hurricane symbol, tinted, with a dark eye the category text sits in.
  // Same path as CYCLONE_SVG in panes.js. Known category colours get an
  // image each at load; an unknown colour falls back to the red.
  const CYCLONE_PATH = "M12.50 2.16A7.9 7.9 0 1 1 4.57 13.80A7.1 7.1 0 1 0 12.50 2.16ZM11.50 21.84A7.9 7.9 0 1 1 19.43 10.20A7.1 7.1 0 1 0 11.50 21.84ZM17.8 12A5.8 5.8 0 1 1 6.2 12A5.8 5.8 0 1 1 17.8 12ZM14.9 12A2.9 2.9 0 1 0 9.1 12A2.9 2.9 0 1 0 14.9 12Z";
  const STORM_COLORS = ["#ff5b45", "#ff7a3d", "#ffa23c", "#ffc94d", "#ffe873", "#9fd0ff", "#8fb4d9", "#9aa4b2", "#ef786f"];
  function cycloneIcon(color) {
    const S = 80, c = document.createElement("canvas"); c.width = S; c.height = S; const x = c.getContext("2d");
    const P = new Path2D(CYCLONE_PATH);
    // same mirror + tilt as CYCLONE_SVG in panes.js
    x.translate(S / 2, S / 2); x.scale(S / 24, S / 24); x.rotate(55 * Math.PI / 180); x.scale(-1, 1); x.translate(-12, -12);
    x.lineJoin = "round"; x.lineWidth = 1.6; x.strokeStyle = "rgba(0,0,0,.7)"; x.stroke(P);
    x.fillStyle = color; x.fill(P);
    x.beginPath(); x.arc(12, 12, 4.3, 0, Math.PI * 2); x.fillStyle = "#10131a"; x.fill();
    return x.getImageData(0, 0, S, S);
  }
  function boltIcon() {
    const c = document.createElement("canvas"); c.width = 44; c.height = 44; const x = c.getContext("2d");
    const P = new Path2D("M25 3 L9 25 L21 25 L17 41 L35 17 L23 17 Z");
    x.lineJoin = "round"; x.lineWidth = 5; x.strokeStyle = "rgba(0,0,0,.65)"; x.stroke(P);
    x.fillStyle = "#ffd54a"; x.fill(P);
    return x.getImageData(0, 0, 44, 44);
  }
  function clearThunder() { if (M().getLayer("thunder")) M().removeLayer("thunder"); if (M().getSource("thunder")) M().removeSource("thunder"); }

  function clearQuakes() { if (M().getLayer("quakes")) M().removeLayer("quakes"); if (M().getSource("quakes")) M().removeSource("quakes"); }

  WX.ov = { boostBasemap, loadObs, clearObs, refreshObs, loadImagery, clearImagery, setBase, loadTerrain, clearTerrain, updateNight, clearNight, loadSmoke, clearSmoke, loadFires, clearFires, loadQuakes, clearQuakes, loadAod, clearAod, loadThunder, clearThunder, toggleRadar, loadIso, clearIso, isoVar, loadAvy, clearAvy, loadResorts, clearResorts, selectResort, clearResortDetail, loadAlerts, clearAlerts, loadStorms, clearStorms, loadSat, clearSat, applyRadarFrame, measureClick, clearMeasure, radarTiles,
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
  let tapeAIReq = 0, tapeAIKey = "", tapeAI = null;
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

  // The map can stay on the selected model while the one-day tape continues
  // past that model's horizon with NOAA AI-GFS. Point cards already fetch the
  // same continuation for their week strip; the map-centre tape owns one
  // small, keyed copy for the no-card case.
  const aiRun = () => {
    const m = WX.catalog && WX.catalog.models.find((x) => x.key === "aigfs" && x.runs.length);
    return m && m.runs[0];
  };
  function tapeAIData() {
    if (state.point) return state.point.ai || null;
    const run = aiRun(); if (!run || !M()) return null;
    const c = M().getCenter();
    const key = `${c.lat.toFixed(2)},${WX.wlon(c.lng).toFixed(2)};${run.run}`;
    return key === tapeAIKey ? tapeAI : null;
  }
  function queueTapeAI() {
    if (tapeRes === 24) setTimeout(refreshTapeAI, 0);
  }
  async function refreshTapeAI() {
    // A selected point owns its AI continuation in app.js, where the daily
    // card also consumes it. Avoid asking for the same 16-day series twice.
    if (tapeRes !== 24 || state.model === "aigfs" || state.point) return;
    const primary = tapeData(), run = aiRun();
    if (!primary || !primary.valid || !primary.valid.length || !run) return;
    const primaryEnd = new Date(primary.valid[primary.valid.length - 1]).getTime();
    const aiEnd = new Date(run.valid_from).getTime() + Math.max(...run.steps) * 3600e3;
    if (aiEnd <= primaryEnd + 3600e3) return;
    const c = M().getCenter();
    const key = `${c.lat.toFixed(2)},${WX.wlon(c.lng).toFixed(2)};${run.run}`;
    if (key === tapeAIKey) return;
    tapeAIKey = key; tapeAI = null;
    const my = ++tapeAIReq;
    try {
      const d = await WX.api(`${API}/point?lat=${c.lat.toFixed(2)}&lon=${WX.wlon(c.lng).toFixed(2)}&model=aigfs&run=${run.run}`);
      if (my !== tapeAIReq || key !== tapeAIKey) return;
      tapeAI = d.available === false ? null : d;
      renderTape();
    } catch (_) {
      if (my === tapeAIReq && key === tapeAIKey) tapeAIKey = "";
    }
  }
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
    box.querySelectorAll("button").forEach((b) => b.onclick = () => { tapeRes = Number(b.dataset.v); localStorage.setItem("wxgrid.tapeRes", tapeRes); renderTape(); renderTapeSelection(); queueTapeAI(); });
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

  const columnsFor = (sample, model, ai = false) => sample.d.valid.map((valid, i) => ({
    model, valid, native: sample.keep ? sample.keep[i] : i, ai, aiStart: false,
  }));

  function appendSeries(primary, tail, tailIdx, primaryN) {
    const out = {};
    const names = new Set([...Object.keys(primary || {}), ...Object.keys(tail || {})]);
    names.forEach((name) => {
      const a = primary && primary[name], b = tail && tail[name];
      if (Array.isArray(a) || Array.isArray(b)) {
        const left = Array.isArray(a) ? a.slice(0, primaryN) : Array(primaryN).fill(null);
        out[name] = left.concat(tailIdx.map((i) => Array.isArray(b) ? b[i] : null));
      } else out[name] = a != null ? a : b;
    });
    return out;
  }

  // Build the tape's displayed columns. Only the 24-hour view crosses model
  // boundaries; finer slices retain one model because those columns imply a
  // precision the long-range continuation should not borrow.
  function tapeView(d0) {
    const primary = resample(d0);
    const columns = columnsFor(primary, state.model);
    if (tapeRes !== 24 || state.model === "aigfs") return { ...primary, columns };
    const tail = tapeAIData();
    if (!tail || tail.model !== "aigfs" || !tail.valid || !tail.valid.length) return { ...primary, columns };
    const ai = aggregate(tail, 24);
    if (!ai.agg) return { ...primary, columns };

    const zk = zoner();
    const primaryDays = new Set(primary.d.valid.map((v) => zk(new Date(v)).day));
    const primaryEnd = new Date(d0.valid[d0.valid.length - 1]).getTime();
    const tailIdx = ai.d.valid.map((v, i) => ({ v, i }))
      .filter(({ v }) => new Date(v).getTime() > primaryEnd && !primaryDays.has(zk(new Date(v)).day))
      .map(({ i }) => i);
    if (!tailIdx.length) return { ...primary, columns };

    const valid = primary.d.valid.concat(tailIdx.map((i) => ai.d.valid[i]));
    const base = new Date(valid[0]).getTime();
    const d = {
      ...primary.d,
      valid,
      steps: valid.map((v) => (new Date(v).getTime() - base) / 3600e3),
      series: appendSeries(primary.d.series, ai.d.series, tailIdx, primary.d.valid.length),
    };
    const tailColumns = tailIdx.map((i) => ({
      model: "aigfs", valid: ai.d.valid[i], native: ai.keep ? ai.keep[i] : i, ai: true, aiStart: false,
    }));
    tailColumns[0].aiStart = true;
    // buckets ride along for the primary columns (the hover card draws each
    // day's hours from them); the AI tail has none
    return { d, keep: null, agg: true, res: 24, buckets: primary.buckets, columns: columns.concat(tailColumns) };
  }

  function renderTape() {
    const tape = $("#tape");
    tape.onclick = null; // release the previous column mapping on empty/radar renders
    tape.classList.toggle("radar", state.radar && state.radarFrames.length > 0);
    if (state.radar && state.radarFrames.length) {
      let html = "", lastDay = null;
      state.radarFrames.forEach((fr, i) => {
        const t = new Date(fr.time * 1000), day = t.toDateString();
        if (day !== lastDay) { if (lastDay !== null) html += "</div></div>"; html += `<div class="tape-day"><div class="tape-dayname">${t.toLocaleDateString(undefined, { weekday: "short" })} · radar</div><div class="tape-cols">`; lastDay = day; }
        html += `<div class="tape-col ${fr.kind}" data-radar="${i}"><span class="tape-hour">${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span class="tape-glyph" style="color:${fr.kind === "nowcast" ? "var(--warm)" : "var(--rain)"};text-align:center">${fr.kind === "nowcast" ? "◌" : "●"}</span></div>`;
      });
      tape.innerHTML = html + "</div></div>";
      tape.onclick = (e) => {
        const c = e.target.closest(".tape-col[data-radar]");
        if (c && tape.contains(c)) { state.radarIdx = Number(c.dataset.radar); WX.ov.applyRadarFrame(); }
      };
      $("#tape-where").textContent = "";
      renderTapeSelection();
      return;
    }
    const d0 = tapeData();
    // An empty tape under a live scrubber reads as broken. Say what is happening.
    if (!d0) { tape.innerHTML = `<div class="tape-empty">${tapeKey ? "loading the forecast for the map centre…" : "forecast unavailable here"}</div>`; return; }
    renderRes(d0);
    queueTapeAI();
    // resampling maps every series onto the chosen columns, so the rest of the
    // renderer never has to know whether it is showing model steps, columns
    // between them, or whole periods
    const { d, columns, agg, res: aggRes } = tapeView(d0);
    const s = d.series, n = d.steps.length;
    const dates = d.valid.map((iso) => new Date(iso));
    const zk = zoner();
    // day header cells: colspan per day, grouped in the zone the times are
    // shown in so the header cannot disagree with the columns under it
    const days = [];
    dates.forEach((dt, i) => { const k = zk(dt).day; if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, start: dt, first: i, span: 0, ai: columns[i].ai, aiStart: columns[i].aiStart }); days[days.length - 1].span++; });
    // a day header is a jump: sixteen days of tape is a long way to scrub
    const dayRow = days.map((dy) => { const wd = dy.start.getDay();
      const source = dy.aiStart ? `<small class="model-handoff">AI-GFS</small>` : "";
      const title = dy.ai ? "NOAA AI-GFS continuation · jump to this day" : "Jump to this day";
      return `<th colspan="${dy.span}" class="day${wd === 0 || wd === 6 ? " wknd" : ""}${dy.ai ? " ai-tail" : ""}${dy.aiStart ? " ai-start" : ""}" data-first="${dy.first}" title="${title}"><span class="dlab" data-iso="${dy.start.toISOString()}">${dy.start.toLocaleDateString(undefined, WX.units.timeOpts({ weekday: "long", day: "numeric" }))}</span>${source}</th>`; }).join("");
    // sunrise/sunset as thin amber notches on the hour row: compute each
    // day's events once, then find the column whose span holds them
    const sunCols = new Map();   // shown index -> "rise"|"set"
    // Notches only make sense when a column is close to the event: at 6 h or
    // 12 h spacing the nearest column is hours off and every day grew a bar.
    const colStep = dates.length > 1 ? Math.min(...dates.slice(1).map((d, k) => d.getTime() - dates[k].getTime())) : Infinity;
    if (WXPanes && WXPanes.sunTimes && state.point && colStep <= 3600e3 * 3) {
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
          if (best >= 0 && bd <= colStep / 2) sunCols.set(best, which);
        }
      });
    }
    // the column whose interval holds the current wall-clock time gets a mark
    const nowMs = Date.now();
    const nowIdx = dates.findIndex((dt, i) => nowMs >= dt.getTime() && (i + 1 >= n || nowMs < dates[i + 1].getTime()));
    const cell = (i, inner, cls = "") => `<td class="${cls} ${dates[i].getHours() < 6 || dates[i].getHours() >= 21 ? "night" : ""}${i === nowIdx ? " now" : ""}${sunCols.has(i) ? ` sun-${sunCols.get(i)}` : ""}${columns[i].ai ? " ai-tail" : ""}${columns[i].aiStart ? " ai-start" : ""}" data-i="${i}" data-model="${columns[i].model}" data-valid="${columns[i].valid}">${inner}</td>`;
    // A column that covers half a day is named for that half, not for whichever
    // hour its sample landed on; a column that covers a whole day is named by
    // the date above it and needs no clock at all.
    const hourTxt = (dt) => dt.toLocaleTimeString(undefined, WX.units.timeOpts({ hour: "numeric" }));
    const halfTxt = (dt) => (zk(dt).hour < 12 ? "AM" : "PM");
    const periodTxt = (dt) => ["NITE", "MORN", "NOON", "EVE"][Math.floor(zk(dt).hour / 6)];
    const showHours = !(agg && aggRes >= 24);
    const colTxt = (dt) => (agg && aggRes === 6 ? periodTxt(dt) : agg && aggRes === 12 ? halfTxt(dt)
      : `${hourTxt(dt).replace(":00", "").replace(/\s/, "<small>")}${/[ap]m/i.test(hourTxt(dt)) ? "</small>" : ""}`);
    const hourRow = dates.map((dt, i) => cell(i, `<span class="hr">${colTxt(dt)}</span>`, "hour")).join("");
    const iconRow = dates.map((_, i) => cell(i, glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, dates[i].getHours() < 6 || dates[i].getHours() >= 21), "ico")).join("");
    const pair = (hi, lo, fmt) => (hi == null ? "—" : `<strong class="hi">${fmt(hi)}</strong>${lo == null ? "" : `<i class="pair-sep">/</i><span class="lo">${fmt(lo)}</span>`}`);
    const degC = (v) => `${WX.units.tempC(v).v}°`, degK = (v) => `${WX.units.temp(v).v}°`;
    const tempRow = dates.map((_, i) => cell(i, agg ? pair(s.t2m && s.t2m[i], s.t2m_lo && s.t2m_lo[i], degK)
      : s.t2m && s.t2m[i] != null ? degK(s.t2m[i]) : "—", "temp")).join("");
    const feelsRow = dates.map((_, i) => { const v = agg ? null : feelsAt(s, i);
      return cell(i, agg ? pair(s.feels_hi && s.feels_hi[i], s.feels_lo && s.feels_lo[i], degC) : v == null ? "—" : degC(v), "feels"); }).join("");
    // A continuous filled trace makes the precipitation shape visible across
    // time. Only a bucket with a printed amount owns an area: a dry Sunday
    // must not borrow Monday's rain and quietly look wet.
    const rainAmount = dates.map((_, i) => {
      const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0;
      if (sn >= 0.3) return Math.max(0.1, sn / 10);
      return r != null && r >= 0.1 ? r : 0;
    });
    // One curve through every bucket — a Catmull-Rom spline over the cell
    // centres, so the trace is the same smooth function in every cell and
    // the slices join with matching tangents instead of the old per-cell
    // arcs that read as segments. It may overshoot the row a little at a
    // peak; the cells let it spill (Jeff 2026-09-04: "curvier even if it
    // means spilling over a bit").
    const rainScale = Math.max(8, ...rainAmount);
    // The trace box is 150% of the row (CSS), bottom-anchored: a wet cell may
    // climb into the row above rather than flatten against a low ceiling.
    const rainY = (mm) => 97 - Math.min(97, Math.sqrt(Math.max(0, mm) / rainScale) * 97);
    const rainPts = rainAmount.map((mm) => rainY(mm));
    const crY = (x) => {               // x in cell units; centres at k + 0.5
      const u = x - 0.5, k = Math.floor(u), t = u - k, n = rainPts.length;
      const P = (j) => rainPts[Math.max(0, Math.min(n - 1, j))];
      const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
      const y = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      return Math.min(97, y);
    };
    const rainArea = (i) => {
      const here = rainAmount[i];
      const prev = i ? rainAmount[i - 1] : 0, next = i + 1 < rainAmount.length ? rainAmount[i + 1] : 0;
      if (here <= 0 && prev <= 0 && next <= 0) return "";
      const N = 16;
      const pts = Array.from({ length: N + 1 }, (_, k) => `${(k / N * 100).toFixed(1)} ${crY(i + k / N).toFixed(1)}`);
      const path = `M${pts[0]} ${pts.slice(1).map((p) => `L${p}`).join(" ")}`;
      return `<svg class="precip-area" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="fill" d="${path} L100 100 L0 100 Z"></path><path class="line" d="${path}"></path></svg>`;
    };
    const rainRow = dates.map((_, i) => { const r = s.tp6 ? s.tp6[i] : null, sn = s.sf6 ? s.sf6[i] : 0; if (r == null) return cell(i, rainArea(i), "rain"); if (sn >= 0.3) return cell(i, `${rainArea(i)}<span class="snow">${WX.units.snow(sn).v}</span>`, "rain snowy"); return cell(i, `${rainArea(i)}${r >= 0.1 ? `<span>${WX.units.precip(r).v}</span>` : ""}`, "rain"); }).join("");
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
    const dirRow = dates.map((_, i) => cell(i, s.wdir && s.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(s.wdir[i])}" title="${String(Math.round(s.wdir[i])).padStart(3, "0")}°"></i>` : "", "dir")).join("");
    const label = (t, u) => `<th class="lab">${t}${u ? `<small>${u}</small>` : ""}</th>`;
    tape.innerHTML = `<table class="wtape${agg ? " agg" : ""}${aggRes ? ` slice-${aggRes}` : ""}"><thead><tr><th class="lab corner"></th>${dayRow}</tr></thead><tbody>
      ${showHours ? `<tr class="r-hour">${label("Time")}${hourRow}</tr>` : ""}
      <tr class="r-icon">${label("")}${iconRow}</tr>
      <tr class="r-temp">${label("Air temp", WX.units.tempUnit)}${tempRow}</tr>
      <tr class="r-feels">${label("Feels like", WX.units.tempUnit)}${feelsRow}</tr>
      <tr class="r-rain">${label("Precip", `${WX.units.precipUnit} · ${WX.units.snowUnit}`)}${rainRow}</tr>
      ${probRow ? `<tr class="r-prob">${label("Chance", "%")}${probRow}</tr>` : ""}
      <tr class="r-wind">${label("Wind", speedUnit())}${windRow}</tr>
      ${gustRow ? `<tr class="r-wind">${label("Gusts", speedUnit())}${gustRow}</tr>` : ""}
      <tr class="r-dir">${label("Direction")}${dirRow}</tr>
    </tbody></table>`;
    const pick = (shown) => {
      const col = columns[shown];
      if (!col) return;
      if (col.model !== state.model) WX.fn.jumpModelTime(col.model, col.valid);
      else WX.fn.setStep(col.native);
      fineSelectedValid = col.valid;
      renderTapeSelection();
    };
    tape.onclick = (e) => {
      const c = e.target.closest("td[data-i], th.day[data-first]");
      if (c && tape.contains(c)) pick(Number(c.dataset.i ?? c.dataset.first));
    };
    wireTapeHover(tape);
    renderTapePlace();
    renderTapeSelection();
  }

  // Hover a column (mouse or pen — a finger is already the tap that picks
  // it) and a card reads the column out in words: every row the tape has
  // for that hour, labelled, so nobody has to line numbers up with the
  // labels at the far left. Built from the rendered cells, so it says
  // whatever the tape says, in the tape's units.
  // What one day of the tape holds, read from the data behind its columns:
  // the header is the hover target (Jeff 2026-09-04: the card on "Friday 4",
  // not on every cell under it), so the card is the day's summary — high and
  // low, totals, peaks, the hours as a curve, and its sun.
  const dayCurve = (idx, s0) => {
    if (!idx || idx.length < 3 || !s0 || !s0.t2m) return "";
    const temps = idx.map((k) => s0.t2m[k]).filter((v) => v != null);
    if (temps.length < 3) return "";
    const mn = Math.min(...temps), mx = Math.max(...temps), span = Math.max(mx - mn, 2);
    const W_ = 100, H = 30;
    const pts = idx.map((k, n) => s0.t2m[k] == null ? null : `${(n / (idx.length - 1) * W_).toFixed(1)},${(4 + (H - 10) * (1 - (s0.t2m[k] - mn) / span)).toFixed(1)}`).filter(Boolean).join(" ");
    const rmax = Math.max(0.5, ...idx.map((k) => (s0.tp6 && s0.tp6[k]) || 0));
    const bars = idx.map((k, n) => { const v = (s0.tp6 && s0.tp6[k]) || 0; if (v < 0.05) return ""; const h = Math.max(1.5, v / rmax * 10); return `<rect x="${(n / idx.length * W_).toFixed(1)}" y="${H - h}" width="${(W_ / idx.length * 0.8).toFixed(1)}" height="${h}"/>`; }).join("");
    // no hour labels: the viewBox is stretched, so text would be too; the
    // curve reads left-to-right as midnight-to-midnight on its own
    return `<svg class="day-curve" viewBox="0 0 ${W_} ${H}" preserveAspectRatio="none" aria-hidden="true"><g class="rain">${bars}</g><polyline points="${pts}"/></svg>`;
  };
  function dayCard(first, span) {
    const d0 = tapeData();
    if (!d0 || !d0.series) return null;
    const view = tapeView(d0);
    const s = view.d && view.d.series;
    if (!s || !view.columns || !view.columns[first]) return null;
    const ii = [];
    for (let i = first; i < first + span && i < view.columns.length; i++) ii.push(i);
    const U = WX.units, K = 273.15;
    const vals = (arr) => (arr ? ii.map((i) => arr[i]).filter((v) => v != null) : []);
    const mx = (arr) => { const v = vals(arr); return v.length ? Math.max(...v) : null; };
    const mn = (arr) => { const v = vals(arr); return v.length ? Math.min(...v) : null; };
    const sum = (arr) => { const v = vals(arr); return v.length ? v.reduce((a, x) => a + x, 0) : null; };
    const mean = (arr) => { const v = vals(arr); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
    const tile = (k, v, unit = "", cls = "") => v == null || v === "" ? "" : `<span class="metric ${cls}"><i>${k}</i><b>${v}${unit ? ` <small>${unit}</small>` : ""}</b></span>`;
    const metrics = [];
    const hi = mx(s.t2m), lo = s.t2m_lo ? mn(s.t2m_lo) : mn(s.t2m);
    if (hi != null) metrics.push(tile("High / low", lo != null ? `${U.temp(hi).v}° / ${U.temp(lo).v}°` : `${U.temp(hi).v}°`, "", "temp"));
    const feels = ii.map((i) => (s.feels_hi && s.feels_hi[i] != null ? s.feels_hi[i] : feelsAt(s, i))).filter((v) => v != null);
    const feelsLo = s.feels_lo ? vals(s.feels_lo) : feels;
    if (feels.length && hi != null && (Math.abs(Math.max(...feels) - (hi - K)) >= 1 || (lo != null && Math.abs(Math.min(...feelsLo) - (lo - K)) >= 1)))
      metrics.push(tile("Feels like", `${U.tempC(Math.max(...feels)).v}° / ${U.tempC(Math.min(...feelsLo)).v}°`, "", "feels"));
    const tp = sum(s.tp6), sf = sum(s.sf6);
    if (sf != null && sf >= 0.3) metrics.push(tile("Snow", U.snow(sf).v, U.snowUnit, "precip"));
    if (tp != null && tp >= 0.1) metrics.push(tile("Precip", U.precip(tp).v, U.precipUnit, "precip"));
    const prob = mx(s.prob_rain);
    if (prob != null && prob >= 5) metrics.push(tile("Rain chance", Math.round(prob), "%", "precip"));
    const wpk = mx(s.wind);
    if (wpk != null) {
      const at = ii.find((i) => s.wind[i] === wpk);
      metrics.push(tile("Wind, peak", `${Math.round(WX.speed(wpk))}`, WX.speedUnit(), "wind")
        .replace("</b>", `</b>${s.wdir && at != null && s.wdir[at] != null ? `<em>${WX.arrow(s.wdir[at])} ${Math.round(s.wdir[at])}°</em>` : ""}`));
    }
    const gpk = mx(s.gust);
    if (gpk != null) metrics.push(tile("Gusts", Math.round(WX.speed(gpk)), WX.speedUnit(), "wind"));
    const cloud = mean(s.tcc);
    if (cloud != null) metrics.push(tile("Cloud", Math.round(cloud * 100), "%"));
    const uv = mx(s.uvi);
    if (uv != null && uv >= 1) metrics.push(tile("UV, peak", uv.toFixed(0)));
    const cape = mx(s.cape);
    if (cape != null && cape >= 300) metrics.push(tile("CAPE", Math.round(cape), "J/kg"));
    // a phrase from the sky, the way the hero does it
    const wet = (tp || 0) + (sf || 0);
    let phrase = cloud == null ? "" : cloud < 0.25 ? "Clear" : cloud < 0.7 ? "Partly cloudy" : "Overcast";
    if (wet >= 0.3) phrase = `${phrase ? phrase + ", " : ""}${sf != null && sf >= (tp || 0) ? "snow" : wet >= 5 ? "rain" : "showers"}`;
    if (gpk != null && gpk * 3.6 >= 55) phrase += `${phrase ? " · " : ""}windy`;
    // the hours inside the day: the primary run's own steps, so an AI-tail day has none
    const ai = ii.some((i) => view.columns[i].ai);
    const idx = ai ? [] : view.agg && view.buckets ? ii.flatMap((i) => (view.buckets[i] || { idx: [] }).idx) : ii.map((i) => view.columns[i].native).filter((n) => n != null);
    const spark = dayCurve(idx, d0.series);
    let foot = "";
    if (window.WXPanes && WXPanes.sunTimes && d0.lat != null && d0.lon != null) {
      const sun = WXPanes.sunTimes(d0.lat, d0.lon, new Date(view.columns[first].valid));
      if (sun) foot = `☼ ${sun.rise} – ${sun.set}${sun.len ? ` · ${sun.len}` : ""}`;
    }
    const model = view.columns[first].model || state.model;
    const entry = WX.catalog && WX.catalog.models.find((m) => m.key === model);
    const source = model === "aigfs" ? "AI-GFS" : (entry && entry.short) || model.toUpperCase();
    const icons = ii.map((i) => glyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), s.t2m ? s.t2m[i] : null, false));
    const ico = icons[Math.floor(icons.length / 2)] || "";
    return { metrics, phrase, spark, foot, model, source, ico };
  }

  function wireTapeHover(tape) {
    if (tape.dataset.hoverWired) return;
    tape.dataset.hoverWired = "1";
    let card = document.getElementById("tape-card");
    if (!card) { card = document.createElement("div"); card.id = "tape-card"; card.hidden = true; document.body.appendChild(card); }
    let shownFor = null;
    const hide = () => { card.hidden = true; shownFor = null; };
    const show = (lab) => {
      const th = lab.closest("th");
      const first = Number(th.dataset.first), span = Number(th.getAttribute("colspan") || 1);
      if (shownFor === first) return;
      const rich = dayCard(first, span);
      if (!rich) { hide(); return; }
      shownFor = first;
      // the full date on the card: the header only has room for "Friday 4"
      const day = new Date(lab.dataset.iso).toLocaleDateString(undefined, WX.units.timeOpts({ weekday: "long", month: "long", day: "numeric" }));
      card.innerHTML = `<div class="card-head">${rich.ico ? `<span class="ico">${rich.ico}</span>` : ""}<div class="when-wrap"><b class="when">${day}</b>${rich.phrase ? `<span class="phrase">${rich.phrase}</span>` : ""}</div><span class="source" data-model="${rich.model}">${rich.source}</span></div>
        ${rich.spark}
        <div class="card-metrics">${rich.metrics.join("")}</div>
        ${rich.foot ? `<div class="card-foot">${rich.foot}</div>` : ""}`;
      card.hidden = false;
      // centred on the header's visible part, above the tape
      const r = lab.getBoundingClientRect(), cw = card.offsetWidth, ch = card.offsetHeight;
      const left = Math.max(6, Math.min(innerWidth - cw - 6, r.left + r.width / 2 - cw / 2));
      card.style.left = `${left}px`; card.style.top = `${Math.max(6, r.top - ch - 8)}px`;
    };
    tape.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      // the label text only (Jeff 2026-09-04): a day header spans the whole
      // day, and a card popping from blank space a foot to the right read as a bug
      const lab = e.target.closest && e.target.closest("th.day[data-first] .dlab");
      if (lab) show(lab); else hide();
    });
    tape.addEventListener("pointerleave", hide);
    tape.addEventListener("scroll", hide, { passive: true });
  }

  function renderTapeSelection() {
    const tape = $("#tape");
    const radar = state.radar && state.radarFrames.length;
    const d0 = tapeData();
    const view = d0 ? tapeView(d0) : null;
    const columns = view ? view.columns : [];
    // Only columns from the model currently painted on the map can be "on".
    // AI tail columns become selectable by switching the map to AI-GFS first.
    const own = columns.map((c, i) => ({ ...c, i })).filter((c) => c.model === state.model);
    const pool = own.length ? own : columns.map((c, i) => ({ ...c, i }));
    const shown = !pool.length ? state.stepIdx : pool.reduce((best, col) => {
      const err = fineSelectedValid ? Math.abs(new Date(col.valid) - new Date(fineSelectedValid)) : Math.abs(col.native - state.stepIdx);
      const bestErr = fineSelectedValid ? Math.abs(new Date(best.valid) - new Date(fineSelectedValid)) : Math.abs(best.native - state.stepIdx);
      return err < bestErr ? col : best;
    }, pool[0]).i;
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
// ── compare.js ──────────────────────────────────────────────────
// Compare like periods, even when the models store different step lengths.
(function () {
  "use strict";
  const HOUR = 3600e3;
  const times = (d) => d.valid.map((v) => new Date(v).getTime());

  function value(d, variable, at) {
    const ts = times(d), values = d.series[variable];
    if (!values) return null;
    const b = ts.findIndex((t) => t >= at);
    if (b < 0 || values[b] == null) return null;
    if (ts[b] === at) return values[b];
    if (!b || values[b - 1] == null || ts[b] - ts[b - 1] > 6 * HOUR) return null;
    const f = (at - ts[b - 1]) / (ts[b] - ts[b - 1]);
    return values[b - 1] + f * (values[b] - values[b - 1]);
  }

  function rain(d, start, end) {
    const ts = times(d), values = d.series.tp6;
    const a = ts.indexOf(start), b = ts.indexOf(end);
    // A bucket ends at its valid time. Never scale a partial bucket or
    // substitute zero for an absent hour; those would invent dry weather.
    if (!values || a < 0 || b <= a) return null;
    let total = 0;
    for (let k = a + 1; k <= b; k++) {
      if (values[k] == null) return null;
      total += values[k];
    }
    return total;
  }

  function columns(at) {
    const start = Math.ceil(at / (6 * HOUR)) * 6 * HOUR;
    return Array.from({ length: 8 }, (_, k) => start + k * 12 * HOUR);
  }
  window.WX.compare = { value, rain, columns };
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
  const countryName = (v) => ({ CA: "Canada", US: "United States", MX: "Mexico" })[String(v || "").toUpperCase()] || v || "";
  const stationName = (v) => String(v || "").replace(/,\s*(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s*,\s*CA$/i,
    (_, province) => `, ${province.toUpperCase()}, Canada`);
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
              set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h2M20 18h2M19.07 10.93l-1.41 1.41M22 22H2M16 6l-4 4-4-4M16 18a4 4 0 0 0-8 0"/></svg>',
              day: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>' };

  // A short written forecast built from the series. Rules only: every sentence
  // is read off the numbers, nothing is invented, and missing inputs simply
  // remove that sentence. This deliberately reads like a weather report, not
  // a row of database tags joined with middle dots.
  // The story of the next two days, one tagged sentence per thing — now, rain,
  // wind, temp, sky, fog, uv. The hero and the Outdoors verdict both read it
  // and pick their sentences, so the two never disagree.
  function story(d, sel) {
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
    const parts = [];
    const say = (k, t) => parts.push({ k, t });

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
      say("now", sky ? `${sky}${character ? ` and ${character}` : ""} at ${U.temp(t0).txt}${felt}.` : `${U.temp(t0).txt} right now${felt}.`);
    }

    // Precipitation, and — when the wind belongs to the same weather — the
    // gusts in the same breath, because that is one event, not two.
    const gusts = (s.gust || s.wind || []).slice(i, end + 1).map((v, k) => [v, i + k]).filter(([v]) => v != null);
    const peak = gusts.length ? gusts.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
    const windy = peak && peak[0] * 3.6 >= 35;
    const fromDir = () => (peak && s.wdir && s.wdir[peak[1]] != null ? ` from the ${compass(s.wdir[peak[1]])}` : "");
    const gustPhrase = () => `${s.gust ? "gusting" : "winds"} to ${Math.round(W().speed(peak[0]))} ${W().speedUnit()}${fromDir()}`;
    let windSaid = false;
    if (s.tp6 || s.sf6) {
      const total = idx.reduce((a, k) => a + amountAt(k), 0);
      const much = total >= 1 ? `, ${U.precip(total).txt} of it` : "";
      if (wet(i)) {
        let k = i; while (k <= end && wet(k)) k++;
        const snow = snowAt(i) > rainAt(i), what = snow ? "Snow" : "Rain";
        const withWind = windy && peak[1] <= k ? `, ${gustPhrase()}` : "";
        if (withWind) windSaid = true;
        say("rain", k > end ? `${what} the whole way through${much}${withWind}.` : `${what} easing ${when(k)}${much}${withWind}.`);
      } else if (wetSteps.length) {
        const first = wetSteps[0], snow = snowAt(first) > rainAt(first);
        const scattered = wetSteps.length <= Math.max(2, Math.ceil(idx.length * 0.35));
        say("rain", scattered ? `Mostly dry, ${snow ? "a little snow" : "a few showers"} ${when(first)}.`
                            : `Dry until ${when(first)}, then ${snow ? "snow moves in" : "rain moves in"}${much}.`);
      } else if (damp.length) {
        say("rain", `Dry, bar ${snowAt(damp[0]) > rainAt(damp[0]) ? "the odd flurry" : "a stray shower"}.`);
      } else {
        say("rain", (at(end) - at(i)) / 3600e3 >= 36 ? "Dry for the next couple of days." : "Dry through tomorrow.");
      }
    }
    if (windy && !windSaid) {
      const kmh = peak[0] * 3.6;
      say("wind", `${kmh >= 75 ? "Very windy" : kmh >= 55 ? "Windy" : "Breezy"}, ${gustPhrase()}${peak[1] > i + 1 ? ` ${when(peak[1])}` : ""}.`);
    }

    // Where the temperature goes, said once, with the time it gets there.
    if (s.t2m && t0 != null) {
      const vals = idx.map((k) => [val("t2m", k), k]).filter(([v]) => v != null);
      if (vals.length > 2) {
        const hi = vals.reduce((a, b) => (b[0] > a[0] ? b : a)), lo = vals.reduce((a, b) => (b[0] < a[0] ? b : a));
        const freezes = lo[0] - 273.15 <= 0 && t0 - 273.15 > 0;
        if (freezes) say("temp", `Below freezing ${when(lo[1])}.`);
        else if (hi[0] - t0 > 3) {
          const hic = hi[0] - 273.15;
          say("temp", `${hic >= 30 ? "Hot" : hic >= 24 ? "Warming up" : "Milder"} ${when(hi[1])}, up to ${U.temp(hi[0]).txt}.`);
        } else if (t0 - lo[0] > 3) say("temp", `Cooling to ${U.temp(lo[0]).txt} ${when(lo[1])}.`);
      }
    }

    // Where the sky is going: the sentence people actually want from a
    // forecast — clearing, or clouding over, and when.
    if (s.tcc && cc != null) {
      const half = idx[Math.floor(idx.length / 2)];
      const later = idx.slice(idx.indexOf(half)).map((k) => val("tcc", k)).filter((v) => v != null);
      const cc2 = later.length ? later.reduce((a, b) => a + b, 0) / later.length : null;
      if (cc2 != null && cc2 - cc > 0.35) say("sky", `Clouding over ${when(half)}.`);
      else if (cc2 != null && cc - cc2 > 0.35) say("sky", `Clearing ${when(half)}.`);
    }
    // Two warnings nothing else carries.
    if (dp != null && t0 != null && t0 - dp < 1 && (w0 == null || w0 * 3.6 < 12)) say("fog", "Air at its dew point and hardly moving: expect fog.");
    let uvK = null; for (const k of idx) if (val("uvi", k) != null && (uvK == null || val("uvi", k) > val("uvi", uvK))) uvK = k;
    if (uvK != null && val("uvi", uvK) >= 3) say("uv", `${val("uvi", uvK) >= 8 ? "Strong sun: " : ""}UV peaks at ${Math.round(val("uvi", uvK))} ${when(uvK)}.`);
    // the wind when it is not part of the rain: the Outdoors verdict wants
    // it even when it is only a breeze
    if (peak && !windy) say("breeze", peak[0] * 3.6 >= 15 ? `Breezy at times, ${gustPhrase()}${peak[1] > i + 1 ? ` ${when(peak[1])}` : ""}.` : "Light winds the whole time.");
    return parts;
  }
  // The hero's line: what it is like now, then up to four of the story.
  function summarise(d, sel) {
    const parts = story(d, sel);
    const HERO = ["rain", "wind", "temp", "sky", "fog"];
    const lead = parts.filter((p) => p.k === "now").map((p) => p.t);
    const rest = parts.filter((p) => HERO.includes(p.k) || (p.k === "uv" && /Strong sun/.test(p.t))).map((p) => p.t);
    return [...lead, ...rest.slice(0, 4)].join(" ");
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

  // ── The tide card (Outdoors) ───────────────────────────────────────────
  // The stations hand back turns only — high, low, high — so the water between
  // them is drawn as a half-cosine from one turn to the next, which is the
  // shape a semi-diurnal tide really has and the rule the pocket tables use.
  // The chart earns its axes: heights on the left in the user's unit against
  // the station datum, days and noons along the bottom, a bar at the card's
  // time. Turn heights sit in bands above and below the water so they can
  // never collide with it. Shown only inside the same 40 km the coast
  // readings use: a station 60 km up a strait is not this beach's tide.
  function tideCard(pt) {
    const t = pt && pt.tides;
    if (!t || !t.events || t.events.length < 2 || t.distance_km == null || t.distance_km > 40) return "";
    const U = W().units, unit = U.altUnit;
    const ev = t.events.map((e) => ({ x: new Date(e.time).getTime(), y: e.height_m, type: e.type })).sort((a, b) => a.x - b.x);
    const x0 = ev[0].x, x1 = ev[ev.length - 1].x, span = Math.max(x1 - x0, 1);
    const ys = ev.map((e) => e.y), lo = Math.min(...ys), hi = Math.max(...ys), rng = Math.max(hi - lo, 0.2);
    const X = (x) => (x - x0) / span * 100, Y = (y) => 100 - (y - lo) / rng * 100;
    const between = (a, b, x) => a.y + (b.y - a.y) * (1 - Math.cos(Math.PI * (x - a.x) / (b.x - a.x))) / 2;
    const pts = [];
    for (let k = 0; k + 1 < ev.length; k++)
      for (let q = 0; q < 16; q++) { const x = ev[k].x + (ev[k + 1].x - ev[k].x) * q / 16; pts.push(`${X(x).toFixed(2)},${Y(between(ev[k], ev[k + 1], x)).toFixed(2)}`); }
    pts.push(`100,${Y(ev[ev.length - 1].y).toFixed(2)}`);
    const now = W().validDate.getTime();
    let hNow = null, rising = null;
    for (let k = 0; k + 1 < ev.length; k++)
      if (now >= ev[k].x && now <= ev[k + 1].x) { hNow = between(ev[k], ev[k + 1], now); rising = ev[k + 1].y > ev[k].y; break; }
    const next = ev.find((e) => e.x > now);
    const edge = (x) => x < 6 ? " l" : x > 94 ? " r" : "";
    const labels = ev.map((e) => `<i class="tl ${e.type}${edge(X(e.x))}" style="left:${X(e.x).toFixed(1)}%">${U.alt(e.y, 1).v}</i>`).join("");
    // The card's time is a ring on the water, not a bar across it; a second
    // ring follows the pointer and says the time and height under it.
    const marker = hNow != null ? `<i class="tdot now" style="left:${X(now).toFixed(1)}%;top:${Y(hNow).toFixed(1)}%"></i>` : "";
    const probe = `<i class="tdot hov" hidden></i><s class="tlab" hidden></s>`;
    const evData = esc(JSON.stringify(ev.map((e) => [e.x, e.y])));
    // the datum line, when it is inside the range (a negative low sits under it)
    const datum = lo < 0 && hi > 0 ? `<i class="tzero" style="top:${Y(0).toFixed(1)}%"></i>` : "";
    // x axis: every local midnight is a day, every local noon a tick
    const hourOf = new Intl.DateTimeFormat("en-US", U.timeOpts({ hour: "2-digit", hour12: false }));
    const xt = [];
    for (let x = Math.ceil(x0 / 3600e3) * 3600e3; x <= x1; x += 3600e3) {
      const h = hourOf.format(new Date(x)).replace("24", "00");
      if (h === "00") xt.push(`<i class="day" style="left:${X(x).toFixed(1)}%">${new Date(x).toLocaleDateString(undefined, U.timeOpts({ weekday: "short" }))}</i>`);
      else if (h === "12") xt.push(`<i style="left:${X(x).toFixed(1)}%">noon</i>`);
    }
    const dt = next ? next.x - now : 0, inTxt = dt > 0 ? (dt < 3600e3 ? `${Math.round(dt / 60e3)} min` : `${Math.floor(dt / 3600e3)}h${String(Math.round(dt % 3600e3 / 60e3)).padStart(2, "0")}`) : "";
    const readout = hNow != null
      ? `<div class="tide-now">
          <span class="tnum"><b>${U.alt(hNow, 1).v}</b><i>${unit}</i></span>
          <span class="tdir ${rising ? "up" : "dn"}">${rising ? "↗ rising" : "↘ falling"}</span>
          ${next ? `<span class="tnext"><b class="${next.type}">${next.type === "H" ? "▲" : "▼"} ${U.alt(next.y, 1).v} ${unit}</b><em>${U.time(new Date(next.x))}${inTxt ? ` · ${inTxt}` : ""}</em></span>` : ""}
        </div>`
      : "";
    return `<div class="tide-card">${readout}
      <div class="tide-plot">
        <div class="tide-y"><i>${U.alt(hi, 1).v}</i><i>${U.alt(lo, 1).v}</i><u>${unit}</u></div>
        <div class="tide-area" data-ev="${evData}" data-lo="${lo}" data-rng="${rng}">${nightBands(x0, x1, X)}<div class="tide-water"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,100 ${pts.join(" ")} 100,100"/><polyline points="${pts.join(" ")}"/></svg>${datum}${marker}${probe}</div>${labels}</div>
      </div>
      <div class="tide-x">${xt.join("")}</div>
    </div>`;
  }

  // ── Now: hero, local context, station obs, meteogram ─────────────────
  function renderNow(pt, d, i) {
    // A data arrival can beat the native toggle event. Capture the actual
    // open state before replacing the DOM so that refresh cannot fold it.
    $("#point-now").querySelectorAll("details[data-detail]").forEach((el) => {
      pt.details ||= {}; pt.details[el.dataset.detail] = el.open;
    });
    const { speed, speedUnit, f, arrow } = W();
    const s = d.series;
    const t = s.t2m ? s.t2m[i] : null, night = (() => { const h = new Date(d.valid[i]).getHours(); return h < 6 || h >= 21; })();
    // today's hi/lo (same local calendar day as the shown step)
    const day = new Date(d.valid[i]).toDateString();
    const todays = d.valid.map((v, k) => k).filter((k) => new Date(d.valid[k]).toDateString() === day && s.t2m && s.t2m[k] != null);
    const hi = todays.length ? Math.max(...todays.map((k) => s.t2m[k])) - K : null, lo = todays.length ? Math.min(...todays.map((k) => s.t2m[k])) - K : null;
    const chips = [];
    if (s.wind) {
      // The wind box carries the story, not just the number: a compass rose
      // with the arrow on it and the bearing in degrees, the Beaufort word,
      // the next 24 h of speed as a curve, and the gusts with how gusty they
      // are relative to the mean (Jeff 2026-09-02: "a bit sparse").
      const w = s.wind[i], dir = s.wdir ? s.wdir[i] : null, g = s.gust ? s.gust[i] : null;
      const bf = w != null ? beaufort(w) : null;
      const win = [], gwin = [];
      for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) { if (s.wind[k] != null) win.push(s.wind[k]); if (s.gust && s.gust[k] != null) gwin.push(s.gust[k]); }
      let spark = "";
      if (win.length >= 3) {
        const top = Math.max(1, ...win, ...gwin);
        const pts = (arr) => arr.map((v, k) => `${(k / (arr.length - 1) * 100).toFixed(1)},${(22 - v / top * 20).toFixed(1)}`).join(" ");
        spark = `<svg class="wspark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
          ${gwin.length === win.length ? `<polyline class="g" points="${pts(gwin)}"/>` : ""}
          <polygon class="a" points="0,24 ${pts(win)} 100,24"/><polyline class="w" points="${pts(win)}"/></svg>`;
      }
      const peakG = gwin.length ? Math.max(...gwin) : null;
      // A labelled rose with one open, unbroken needle. The line crosses the
      // centre by itself; a hub only makes this tiny dial look mechanical.
      const dial = `<span class="wind-dial" style="--rot:${dir == null ? 0 : (dir + 180) % 360}deg" title="${dir == null ? "" : `from ${Math.round(dir)}°`}">
        <svg viewBox="0 0 48 48" aria-hidden="true"><circle class="ring" cx="24" cy="24" r="21"/>
        <text class="card" x="24" y="10.2" text-anchor="middle">N</text><text class="card" x="41.2" y="26.6" text-anchor="middle">E</text>
        <text class="card" x="24" y="43.2" text-anchor="middle">S</text><text class="card" x="6.8" y="26.6" text-anchor="middle">W</text>
        <path class="needle" d="M24 28.5 L24 17 M21 20 L24 17 L27 20"/></svg></span>`;
      chips.push(`<span class="wind-readout" style="--wind-color:${windColor(w || 0)}">
        <span class="wind-main"><small>Wind</small><b>${f(w, (v) => speed(v).toFixed(0))} <i>${speedUnit()}</i></b><em>${compass(dir)}${dir != null ? ` ${Math.round(dir)}°` : ""}${bf != null ? ` · ${BEAUFORT_NAME[bf]}` : ""}</em></span>
        ${dial}
        <span class="wind-trend">${spark}<small>next 24 h${peakG != null ? ` · peak gusts ${speed(peakG).toFixed(0)}` : ""}</small></span>
        ${g != null ? `<span class="wind-gust"><small>Gusts</small><b>${speed(g).toFixed(0)} <i>${speedUnit()}</i></b></span>` : ""}
        <span class="wind-storm" id="storm-slot"></span>
      </span>`);
    }
    // Which readings are worth the space depends on where the pin landed. A
    // snow depth of zero in August tells you nothing; wave height does, if you
    // clicked the sea. So: a value that is only news when it is non-zero stays
    // hidden at zero, and the marine readings lead over water while the
    // land-only ones step aside.
    const sea = !!(pt.local && pt.local.place && pt.local.place.water);
    const marine = [], normal = [];
    let pressureCurve = "";
    if (sea && s.wind && s.wind[i] != null) { const bf = beaufort(s.wind[i]);
      marine.push(stat("Beaufort", `F${bf}`, "", "#8ec5f0", `<em>${BEAUFORT_NAME[bf]}</em>`, "", "sea")); }
    if (sea && s.swh && s.swh[i] != null) { const ds = douglas(s.swh[i]);
      marine.push(stat(`Sea · ${DOUGLAS_NAME[ds]}`, ds, "", "#7dd3fc", "", "", "sea")); }
    if (s.swh && s.swh[i] != null) marine.push(stat("Waves", W().units.alt(s.swh[i], 1).v, W().units.altUnit, "#7dd3fc",
      `<em>${s.mwp && s.mwp[i] != null ? `${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` ${arrow((s.mwd[i] + 180) % 360)}` : ""}</em>`, "", "sea"));
    if (s.tp6 && s.tp6[i] > 0.05) normal.push(stat("Rain 6 h", W().units.precip(s.tp6[i]).v, W().units.precipUnit, "var(--rain)", "", "", "precip"));
    // Chance, from the GEFS members, whichever model the card is reading:
    // the max over the next 24 h from the selected time, only when it says
    // something (a 3 % chance is not a pill).
    const chance = probMax(pt, d, i, "prob_rain", 24);
    if (chance != null && chance >= 10) normal.push(stat("Rain chance", chance, "%", "#71b8ff", "", "Share of the 30 GEFS members giving rain in the next 24 h", "precip"));
    const gustChance = probMax(pt, d, i, "prob_gust", 24);
    if (gustChance != null && gustChance >= 20) normal.push(stat("Gale chance", gustChance, "%", "#ffb454", "", "Share of members with gusts over 50 km/h in the next 24 h", "air"));
    if (s.sf6 && s.sf6[i] > 0.05) normal.push(stat("New snow", W().units.snow(s.sf6[i]).v, W().units.snowUnit, "#cfe8ff", "", "", "precip"));
    if (!sea && s.sd_cm && s.sd_cm[i] >= 0.5) normal.push(stat("Snow depth", W().units.snow(s.sd_cm[i]).v, W().units.snowUnit, "#9fd3ff", "", "", "precip"));
    // 24 h totals and changes, from the step after this one to +24 h
    const freezing = d.derived && d.derived.freezing_level_m && d.derived.freezing_level_m[i];
    const ahead = (arr) => { const out = []; for (let k = i + 1; k < d.steps.length && d.steps[k] <= d.steps[i] + 24; k++) if (arr[k] != null) out.push(arr[k]); return out; };
    if (s.tp6) { const r24 = ahead(s.tp6).reduce((a, b) => a + b, 0); if (r24 >= 0.5) normal.push(stat("Rain 24 h", W().units.precip(r24).v, W().units.precipUnit, "#5aa9ff", "", "", "precip")); }
    // when the next rain arrives, or that the next two days stay dry
    if (s.tp6 && (s.tp6[i] || 0) < 0.2) {
      let k = i + 1; while (k < d.steps.length && d.steps[k] <= d.steps[i] + 48 && ((s.tp6[k] || 0) + (s.sf6 ? s.sf6[k] || 0 : 0)) < 0.3) k++;
      const soon = k < d.steps.length && d.steps[k] <= d.steps[i] + 48;
      const hrs = soon ? d.steps[k] - d.steps[i] : null;
      normal.push(stat(soon ? "Next rain" : "Dry spell", soon ? (hrs < 24 ? `${hrs}` : `${Math.round(hrs / 24)}`) : "48", soon ? (hrs < 24 ? "h" : "d") : "h+", soon ? "#5aa9ff" : "#9fb0c8", "", soon ? "Hours until the next wet step" : "No rain in the next two days", "precip"));
    }
    if (freezing != null && s.sf6 && ahead(s.sf6).some((v) => v >= 0.3)) normal.push(stat("Snow level ≈", W().units.alt(Math.max(0, freezing - 300)).v, W().units.altUnit, "#cfe8ff", "", "Freezing level less ~300 m, where snow turns to rain", "precip"));
    if (t != null && s.d2m && s.d2m[i] != null) {
      // Stull's wet-bulb from T and RH: the temperature the sweat gets you
      const tc = t - K, rh = Math.min(100, Math.max(1, 100 * Math.exp(17.625 * (s.d2m[i] - K) / (243.04 + s.d2m[i] - K)) / Math.exp(17.625 * tc / (243.04 + tc))));
      const tw = tc * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(tc + rh) - Math.atan(rh - 1.676331) + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
      normal.push(stat("Wet-bulb", `${W().units.tempC(tw).v}°`, "", tw >= 26 ? "var(--bad)" : tw >= 21 ? "#ff8a3d" : "#6cd7c4", "", "Wet-bulb temperature (Stull): heat stress above ~26°", "air"));
    }
    for (const [key, name] of [["lcc", "Low cloud"], ["mcc", "Mid cloud"], ["hcc", "High cloud"]]) {
      if (s[key] && s[key][i] != null && s[key][i] >= 0.05) normal.push(stat(name, (s[key][i] * 100).toFixed(0), "%", key === "lcc" ? "#9fb0c8" : key === "mcc" ? "#b5c2d2" : "#cfd8e4", "", "", "sky"));
    }
    if (s.tcc && s.tcc[i] != null) normal.push(stat("Cloud", (s.tcc[i] * 100).toFixed(0), "%", "#9fb0c8", "", "", "sky"));
    if (s.t2m && s.d2m && s.t2m[i] != null && s.d2m[i] != null) {
      const rh = Math.round(100 * Math.exp(17.625 * (s.d2m[i] - K) / (243.04 + s.d2m[i] - K)) / Math.exp(17.625 * (s.t2m[i] - K) / (243.04 + s.t2m[i] - K)));
      normal.push(stat("Humidity", rh, "%", rh >= 90 ? "#7cc4ff" : rh <= 30 ? "#ffb454" : "#7fd8e8", "", "", "sky"));
    }
    // the model's UV estimate steps aside when CAMS has the measured one below
    if (!(pt.air && pt.air.uv != null)) { const uv = uvNow(d, i); if (uv && uv.uvi >= 1) normal.push(stat(uv.peak ? "UV peak" : "UV index", uv.uvi.toFixed(0), "", uv.uvi >= 8 ? "var(--bad)" : uv.uvi >= 6 ? "#ff8a3d" : uv.uvi >= 3 ? "#ffd166" : "#78d39a", "", "", "sun")); }
    if (s.vis && s.vis[i] != null) normal.push(stat("Visibility", W().units.dist(s.vis[i] / 1000, s.vis[i] < 5000 ? 1 : 0).v, W().units.dist(1).unit, s.vis[i] > 9000 ? "#78d39a" : s.vis[i] > 3000 ? "#ffd166" : "var(--bad)", "", "", "sky"));
    if (s.t2m && s.t2m[i] != null) { const k24 = d.steps.findIndex((h, k) => k > i && h >= d.steps[i] + 24); const t24 = k24 > 0 ? s.t2m[k24] : null;
      if (t24 != null && Math.abs(t24 - s.t2m[i]) >= 1.5) { const dT = W().units.tempDelta(t24 - s.t2m[i]); normal.push(stat("24 h change", `${dT > 0 ? "+" : "−"}${Math.abs(dT).toFixed(0)}°`, "", dT > 0 ? "#ff8a3d" : "#6cb6ff", "", "", "air")); } }
    if (s.d2m) normal.push(stat("Dew point", `${f(s.d2m[i], (v) => W().units.temp(v).v)}°`, "", "#6cd7c4", "", "", "sky"));
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
        spark = `<svg class="pspark" viewBox="0 0 44 12" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
      }
      pressureCurve = spark;
      normal.push(stat("Pressure", f(s.msl[i], (v) => W().units.press(v).v), W().units.pressUnit, "#b7a6f0",
        `<em class="trend" title="${dP > 0 ? "rising" : dP < 0 ? "falling" : "steady"} ${Math.abs(dP).toFixed(1)} hPa / 6 h">${dP >= 1 ? "↑" : dP <= -1 ? "↓" : "→"}</em>`, "", "air"));
    }
    // What it feels like, when that is not what the thermometer says.
    if (t != null) {
      const c = t - K, w = s.wind ? s.wind[i] : null, dpK = s.d2m ? s.d2m[i] : null;
      let feels = c;
      if (w != null && c <= 10 && w * 3.6 >= 4.8) { const q = Math.pow(w * 3.6, 0.16); feels = 13.12 + 0.6215 * c - 11.37 * q + 0.3965 * c * q; }
      else if (dpK != null && c >= 20) { const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / dpK)); feels = c + 0.5555 * (e - 10); }
      if (Math.abs(Math.round(feels) - Math.round(c)) >= 2)
        normal.push(stat("Feels like", `${W().units.tempC(feels).v}°`, "", tempColor(feels), "", "", "air"));
    }
    // Cloud base from the temperature/dew-point spread: ~125 m per °C. Only
    // worth saying when there is cloud to have a base.
    if (!sea && s.tcc && s.tcc[i] > 0.2 && s.d2m && s.d2m[i] != null && t != null) {
      const spread = (t - s.d2m[i]);
      if (spread > 0.3 && spread < 25) normal.push(stat("Cloud base ≈", W().units.alt(Math.round(spread * 125 / 50) * 50).v, W().units.altUnit, "#a9c4d8", "", "", "sky"));
    }
    if (s.cape && s.cape[i] >= 100) normal.push(stat("CAPE", s.cape[i].toFixed(0), "J/kg", s.cape[i] > 1000 ? "var(--bad)" : "var(--warm)", "", "", "air"));
    // more of the day, read from what the point already carries (Jeff 2026-09-04)
    if (s.tcc && todays.length >= 2) {
      // sunshine: daylight steps with under 30 % cloud, times the step length
      const sun = sunTimes(pt.lat, pt.lon, new Date(d.valid[i]));
      if (sun && sun.riseMs != null && sun.setMs != null) {
        const hrs = todays.reduce((acc, k) => { const t0 = new Date(d.valid[k]).getTime(); const h = stepHrs(d, k);
          if (t0 + h * 1.8e6 < sun.riseMs || t0 - h * 1.8e6 > sun.setMs || s.tcc[k] == null) return acc;
          return acc + h * Math.max(0, 1 - s.tcc[k]); }, 0);
        normal.push(stat("Sunshine", hrs.toFixed(hrs < 10 ? 1 : 0), "h", hrs >= 6 ? "#ffd166" : "#9fb0c8", "", "Daylight hours weighted by clear sky, from cloud cover", "sun"));
      }
    }
    { const a = d.aloft && (d.aloft["850"] || d.aloft["925"]); const lvl = d.aloft && d.aloft["850"] ? "850" : "925";
      if (a && a.wind && a.wind[i] != null) normal.push(stat(`Wind ${lvl} hPa`, Math.round(W().speed(a.wind[i])), `${W().speedUnit()}${a.wdir && a.wdir[i] != null ? ` ${arrow(a.wdir[i])}` : ""}`, "#7fb2ff", "", `Ridge-level wind at ${lvl} hPa (~${lvl === "850" ? "1.5" : "0.8"} km)`, "air")); }
    if (t != null && s.d2m && s.d2m[i] != null && (t - s.d2m[i]) < 1.5 && (!s.wind || s.wind[i] == null || s.wind[i] * 3.6 < 12))
      normal.push(stat("Fog risk", (t - s.d2m[i]) < 0.6 ? "high" : "some", "", "#b0bcc8", "", "Air within a degree of its dew point in light wind", "sky"));
    if (!sea && freezing != null) normal.push(stat("Freezing lvl", W().units.alt(freezing).v, W().units.altUnit, "#7fd8e8", "", "", "air"));
    chips.push(...(sea ? [...marine, ...normal] : [...normal, ...marine]));
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    const moon = moonPhase(W().validDate);
    $("#point-now").innerHTML = `<div class="hero">
        ${bigGlyph(s.tcc ? s.tcc[i] : null, (s.tp6 ? s.tp6[i] : 0) + (s.sf6 ? s.sf6[i] : 0), t, night)}
        <div class="big" style="--temp-color:${t != null ? tempColor(t - K) : "var(--fg)"}">${t == null ? "—" : W().units.temp(t).v}<span class="deg">°</span></div>
        <div class="hl">
          ${hi != null ? `<div class="hilo"><span class="hi"><i>high</i>${W().units.tempC(hi).v}°</span><span class="rule"></span><span class="lo"><i>low</i>${W().units.tempC(lo).v}°</span></div>` : ""}
          ${sun ? `<div class="sun"><span>${W_ICONS.rise}${sun.rise}</span><span>${W_ICONS.set}${sun.set}</span><i class="brk" aria-hidden="true"></i>${sun.len ? `<span class="len" title="Daylight">${W_ICONS.day || ""}${sun.len}</span>` : ""}<span class="moon" title="${moon.name}, ${moon.pct}% lit">${moon.glyph} ${moon.pct}%</span></div>` : ""}
          <div class="vs-normal" id="normal-slot" hidden></div>
        </div>
      </div>
      ${(() => { const t = summarise(d, i); return t ? `<p class="summary"><i>next 48 h</i>${t}${window.WXStatic ? "" : `<button class="why-btn" id="why-btn">Discussion ›</button>`}</p><div id="why" class="why" hidden></div>` : ""; })()}
      ${window.WXStatic ? "" : `<div id="rainnow-slot" class="rainnow" hidden></div>`}
      <div class="meta">${chips.filter((c) => !c.startsWith('<div class="stat')).join("")}${sections(chips.filter((c) => c.startsWith('<div class="stat')), pt)}</div>
      ${contextCues(pt, d, i)}
      ${daysStrip(pt, d, i)}
      ${contextCards(pt, d, i)}
      ${window.WXStatic ? "" : `<div id="cams-slot" class="cams" hidden></div>`}
      ${alertsHtml(pt)}${airHtml(pt)}`;
    $("#point-now").querySelectorAll("details[data-detail]").forEach((el) => el.addEventListener("toggle", () => {
      if (el.isConnected) { pt.details ||= {}; pt.details[el.dataset.detail] = el.open; }
    }));
    pt.pressureCurve = pressureCurve;
    fetchNearStorm(pt);
    fetchCams(pt);
    paintNormal(pt, d, i, todays);
    paintRainNow(pt);
    // local context
    const loc = pt.local || {};
    const bits = [];
    // Join only the parts that exist. A country with no region above it used to
    // print a leading "· SE" — a separator dangling off nothing.
    const where = [];
    if (loc.place && loc.place.name && loc.place.name !== pt.name) where.push(`<b>${esc(loc.place.name)}</b>${loc.place.region ? ", " + esc(loc.place.region) : ""}`);
    else if (loc.place && loc.place.region) where.push(esc(loc.place.region));
    if (loc.place && loc.place.country) where.push(esc(countryName(loc.place.country)));
    if (where.length) bits.push(`<span class="loc">${where.join(" · ")}</span>`);
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
        <div class="obs-head"><span class="stn"><b>${esc(o.station)}</b>${o.name ? `<span class="nm">${esc(stationName(o.name))}</span>` : ""}</span>${o.flight_category ? `<span class="fc ${esc(o.flight_category)}">${esc(o.flight_category)}</span>` : ""}</div>
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
    return `<i class="kicker">long range forecast</i><div class="days${usable.length > 8 ? " extended" : ""}">${cells}</div>${note}`;
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
    const uvCol = (v) => v >= 8 ? "var(--bad)" : v >= 6 ? "#ff8a3d" : v >= 3 ? "#ffd166" : "#78d39a";
    const tiles = [];
    if (b) tiles.push(stat(`US AQI · ${b[1]}`, a.us_aqi, "", b[2], "", "", "aq"));
    if (a.eu_aqi != null) tiles.push(stat("EU AQI", a.eu_aqi, "", "#8fd6a8", "", "", "aq"));
    if (a.pm2_5 != null) tiles.push(stat("PM2.5", a.pm2_5.toFixed(0), "µg/m³", "#e0b57a", "", "", "aq"));
    if (a.pm10 != null) tiles.push(stat("PM10", a.pm10.toFixed(0), "µg/m³", "#d8a06a", "", "", "aq"));
    if (a.ozone != null) tiles.push(stat("Ozone", a.ozone.toFixed(0), "µg/m³", "#8ec7f0", "", "", "aq"));
    if (a.no2 != null) tiles.push(stat("NO₂", a.no2.toFixed(0), "µg/m³", "#d79ac0", "", "", "aq"));
    if (a.uv != null) tiles.push(stat("UV now", a.uv.toFixed(1), "", uvCol(a.uv), "", "", "uv"));
    if (a.uv_clear != null) tiles.push(stat("Clear-sky UV", a.uv_clear.toFixed(1), "", uvCol(a.uv_clear), "", "", "uv"));
    if (uvb) tiles.push(stat(`UV max · ${uvb[0]}`, uvMax.toFixed(0), "", uvb[1], "", "", "uv"));
    return `<div class="meta air">${sections(tiles, pt)}</div>`;
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
    return { rise: fmt(r), set: fmt(s), riseUtc: r, setUtc: s, riseMs: base + r * 3600e3, setMs: base + (s < r ? s + 24 : s) * 3600e3,
             len: `${Math.floor(len)}h${String(Math.round((len % 1) * 60)).padStart(2, "0")}` };
  }

  // ── context modules ───────────────────────────────────────────────────
  // The card used to show the same blocks in Reykjavík in February and on a
  // Queensland beach in January. These decide from geography, season and the
  // data actually present whether a block has anything to say; one that does
  // not apply renders nothing at all, which is the whole contract.
  //
  // The local winter half-year: November to March north of the equator, May to
  // September south of it. Blunt on purpose — it gates whole modules, and a
  // fortnight either way changes nothing.
  const isWinterHalf = (lat, date) => { const m = date.getMonth(); return lat >= 0 ? (m >= 10 || m <= 2) : (m >= 4 && m <= 8); };
  const HIGH_LAT = 55;
  const SKI_LAT = 33;                  // winter tab shown poleward of this, any season

  // Near the coast? Two cheap signals, both already on the card. Marine fields
  // are NaN over land, so a wave height or a sea-surface temperature at this
  // gridpoint puts the sea within a cell — about 28 km at 0.25°. A tide
  // station within 40 km says the same thing where the model's marine mask is
  // too coarse to reach the shore. Neither is a coastline: a beach the wave
  // grid misses and no gauge watches simply gets no module, which is the right
  // way to be wrong here.
  const marineHere = (s, i) => (!!(s.swh && s.swh[i] != null)) || (!!(s.sst && s.sst[i] != null));
  // The server's nearest-water probe (derived.coast) is the answer where the
  // gridpoint is not: it walks out over the model's own land/sea mask and
  // brings the sea state back, so a promenade three kilometres inland reads
  // as coastal instead of as farmland. 40 km is the same reach the tide
  // station uses, and about a cell and a half of the grid it came off.
  const COAST_KM = 40;
  const coastOf = (d) => (d && d.derived && d.derived.coast) || null;
  const coastNear = (d) => { const c = coastOf(d); return c && c.distance_km != null && c.distance_km <= COAST_KM ? c : null; };
  const nearCoast = (pt, d, i) => marineHere(d.series, i) || !!coastNear(d)
    || !!(pt.tides && pt.tides.distance_km != null && pt.tides.distance_km <= 40);
  const onLand = (pt) => !(pt.local && pt.local.place && pt.local.place.water);

  // A marine value at this step: the pin's own gridpoint first, the water the
  // probe found second. `here` says which, so the card can admit it.
  function seaVal(d, i, key) {
    const s = d.series;
    if (s[key] && s[key][i] != null) return { v: s[key][i], here: true };
    const c = coastNear(d);
    if (c && c[key] && c[key][i] != null) return { v: c[key][i], here: false, at: c };
    return null;
  }

  // Next turn of the tide after the time the card is showing.
  function nextTide(pt) {
    if (!pt || !pt.tides || !pt.tides.events) return null;
    const t = W().validDate.getTime();
    return pt.tides.events.find((e) => new Date(e.time).getTime() > t) || null;
  }

  // Can it snow here at all? The model's own snow answers first; failing that,
  // a run that reaches freezing does; failing that, latitude or altitude in
  // the winter half-year. Summer at sea level in Lisbon answers no.
  function canSnow(pt, d) {
    const s = (d && d.series) || {};
    if (s.sf6 && s.sf6.some((v) => v != null && v > 0.5)) return true;
    if (s.sd_cm && s.sd_cm.some((v) => v != null && v > 1)) return true;
    if (s.t2m && s.t2m.some((v) => v != null && v < K + 1)) return true;
    // Winter-sport country stays a winter place all year: the tab is where
    // the snow depth, freezing level and resort bands live even when this
    // week's forecast is dry (Jeff 2026-09-02, snow-forecast.com as the
    // model). Latitude 33° reaches the Andes, Japan and the Rockies' south;
    // 1000 m catches the lower resorts inside that.
    const elev = (pt.local && pt.local.elevation_m) || 0;
    return Math.abs(pt.lat) >= SKI_LAT || elev >= 1000;
  }

  // Minutes of unprotected sun before a fair skin burns. One UV index unit is
  // 25 mW/m² of erythemally weighted irradiance and a type-II minimal
  // erythemal dose is about 250 J/m², so the time is 250/(uvi · 0.025) seconds.
  const burnMinutes = (uvi) => Math.round(250 / (uvi * 0.025) / 60);

  // The UV worth quoting: what it is now, or — once the sun is down — the peak
  // the rest of this local day will reach, which is the number you plan around.
  function uvNow(d, i) {
    const s = d.series;
    if (!s.uvi) return null;
    const v = s.uvi[i];
    if (v != null && v >= 1) return { uvi: v, peak: false };
    const day = new Date(d.valid[i]).toDateString();
    const vals = d.valid.map((iso, k) => (new Date(iso).toDateString() === day && s.uvi[k] != null ? s.uvi[k] : null)).filter((x) => x != null);
    if (!vals.length) return null;
    const hi = Math.max(...vals);
    return hi >= 1 ? { uvi: hi, peak: true } : null;
  }

  // Beach: a coastal point, warm enough to be in the water, outside a
  // high-latitude winter. Sea temperature leads when the model carries one
  // (GFS does, the ECMWF open set does not); otherwise the air temperature
  // stands in, which is what you feel on the sand anyway.
  function beachModule(pt, d, i) {
    const s = d.series;
    if (!nearCoast(pt, d, i) || !onLand(pt)) return "";
    if (Math.abs(pt.lat) >= HIGH_LAT && isWinterHalf(pt.lat, W().validDate)) return "";
    const sea = seaVal(d, i, "sst");
    const sst = sea ? sea.v - K : null;
    const air = s.t2m && s.t2m[i] != null ? s.t2m[i] - K : null;
    if (sst != null ? sst < 16 : !(air != null && air >= 18)) return "";
    const U = W().units;
    const stats = [];
    if (sst != null) stats.push(`<div><small>Water</small><b>${U.tempC(sst).v}<i>${esc(U.tempUnit)}</i></b></div>`);
    const swh = seaVal(d, i, "swh"), mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd");
    if (swh) {
      const wv = U.alt(swh.v, 1);
      // mwd is the direction the swell comes FROM, the way wind is quoted
      const note = [mwd ? `from ${compass(mwd.v)}` : "", mwp ? `${mwp.v.toFixed(0)} s` : ""].filter(Boolean).join(" · ");
      stats.push(`<div><small>Waves</small><b>${wv.v}<i>${esc(U.altUnit)}</i></b>${note ? `<em>${esc(note)}</em>` : ""}</div>`);
    }
    const tide = nextTide(pt);
    if (tide) stats.push(`<div><small>Next ${tide.type === "H" ? "high" : "low"}</small><b>${esc(U.time(tide.time))}</b><em>${esc(U.alt(tide.height_m, 1).txt)}</em></div>`);
    const uv = uvNow(d, i);
    if (uv) stats.push(`<div><small>UV${uv.peak ? " peak" : ""}</small><b>${uv.uvi.toFixed(0)}</b><em>burn in ~${burnMinutes(uv.uvi)} min</em></div>`);
    const sun = sunTimes(pt.lat, pt.lon, W().validDate);
    if (sun) stats.push(`<div><small>Sunset</small><b>${esc(sun.set)}</b></div>`);
    if (stats.length < 2) return "";
    // Where the sea state came from, when it did not come from here: the
    // numbers are the water's, not the sand's, and the card says so.
    const off = [sea, swh, mwp, mwd].find((x) => x && x.here === false);
    const note = off ? `sea ${esc(U.dist(off.at.distance_km).txt)} ${esc(off.at.compass || "")}`.trim()
      : sst == null ? "no sea temperature here" : "";
    return `<div class="modcard beach"><div class="mod-head"><span>Beach</span>${note ? `<span class="dim">${note}</span>` : ""}</div>
      <div class="mod-stats">${stats.join("")}</div></div>`;
  }

  // Stargazing: the coming night is clear and the moon is out of the way
  // enough to be worth saying. 21:00 to 05:00 in the clock the card is using.
  function stargazeCue(pt, d, i) {
    const s = d.series;
    if (!s.tcc) return "";
    const t0 = new Date(d.valid[i]).getTime();
    const night = [];
    d.valid.forEach((iso, k) => {
      const dt = new Date(iso), t = dt.getTime(), h = dt.getHours();
      if (t < t0 || t > t0 + 24 * 3600e3) return;
      if ((h >= 21 || h <= 4) && s.tcc[k] != null) night.push(s.tcc[k]);
    });
    if (night.length < 2 || Math.max(...night) > 0.2) return "";
    const moon = moonPhase(W().validDate);
    return `<span class="cue" style="--cue:#a9b8ff"><b>Good stargazing tonight</b><span>${moon.glyph} moon ${moon.pct}% ${esc(moon.name)}</span></span>`;
  }

  // Surf and kite: a swell worth riding under a wind steady enough to hold a
  // kite. 15–30 kt is the window; below it nothing pulls, above it nothing is
  // fun.
  function surfCue(pt, d, i) {
    const s = d.series;
    const swh = seaVal(d, i, "swh");
    if (!swh || swh.v < 1) return "";
    const w = s.wind ? s.wind[i] : null;
    if (w == null || w < 7.72 || w > 15.43) return "";
    const U = W().units, { speed, speedUnit } = W();
    const wv = U.alt(swh.v, 1);
    const mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd");
    const per = mwp ? ` @ ${mwp.v.toFixed(0)} s` : "";
    // swell direction is the direction it comes FROM: onshore or off is the
    // whole question, and a bare 290° does not answer it
    const from = mwd ? `${compass(mwd.v)} swell · ` : "";
    return `<span class="cue" style="--cue:#4fc3d9"><b>Surf and kite window</b><span>${from}${wv.v} ${esc(U.altUnit)}${per} · ${speed(w).toFixed(0)} ${esc(speedUnit())}</span></span>`;
  }

  // What the point card shows beyond the standard blocks: cue pills first,
  // then the cards. Both are empty strings when nothing applies.
  function contextCues(pt, d, i) {
    const cues = [stargazeCue(pt, d, i), surfCue(pt, d, i)].filter(Boolean);
    return cues.length ? `<div class="cues">${cues.join("")}</div>` : "";
  }
  function contextCards(pt, d, i) {
    return [beachModule(pt, d, i)].filter(Boolean).join("");
  }

  // ── Aloft ─────────────────────────────────────────────────────────────
  function renderAloft(d, i) {
    const { speed, speedUnit, f, arrowRot, LEVEL_FT, LEVEL_M } = W();
    const rows = (d.levels || []).slice().sort((a, b) => b - a).map((lvl) => {
      const a = d.aloft[String(lvl)];
      const gh = a.gh && a.gh[i] != null ? a.gh[i] : null;
      return `<tr><td class="lvl">${lvl} <i class="u">hPa</i></td><td>${gh != null ? W().units.alt(gh).txt : (W().units.altUnit === "ft" ? LEVEL_FT[lvl] : LEVEL_M[lvl])}</td>
        <td class="dir">${a.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(a.wdir[i])}"></i>${String(a.wdir[i]).padStart(3, "0")}°` : "—"}</td>
        <td><span class="wchip" style="background:${windColor(a.wind[i] || 0)}">${f(a.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}</td>
        <td class="tempc" style="color:${a.temp[i] != null ? tempColor(a.temp[i] - K) : "inherit"}">${f(a.temp[i], (v) => W().units.temp(v).v)}°</td></tr>`;
    }).join("");
    const s = d.series;
    const fl = d.derived && d.derived.freezing_level_m ? d.derived.freezing_level_m[i] : null;
    const sfc = s.wind ? `<tr><td class="mono">sfc</td><td>${W().units.alt(10).txt}</td><td class="dir">${s.wdir[i] != null ? `<i class="dirarrow" style="${arrowRot(s.wdir[i])}"></i>${String(s.wdir[i]).padStart(3, "0")}°` : "—"}</td><td><span class="wchip" style="background:${windColor(s.wind[i] || 0)}">${f(s.wind[i], (v) => speed(v).toFixed(0))}</span> ${speedUnit()}${s.gust ? ` <span class="dim">gusts ${f(s.gust[i], (v) => speed(v).toFixed(0))}</span>` : ""}</td><td class="tempc" style="color:${s.t2m && s.t2m[i] != null ? tempColor(s.t2m[i] - K) : "inherit"}">${f(s.t2m && s.t2m[i], (v) => W().units.temp(v).v)}°</td></tr>` : "";
    $("#aloft").innerHTML = `<table class="aloft"><thead><tr><th>Level</th><th>Height</th><th>Dir</th><th>Speed</th><th>Temp</th></tr></thead><tbody>${rows}${sfc}</tbody></table>
      ${statCards([
        ["Freezing level", fl != null ? W().units.alt(fl).txt : (d.levels && d.levels.length ? "below 925 hPa or above 250" : "—"), "", "flake"],
        ["Total cloud", f(s.tcc && s.tcc[i], (v) => (v * 100).toFixed(0) + "%"), "", "cloud", s.tcc && s.tcc[i] != null ? s.tcc[i] : null],
        ["CAPE", `${f(s.cape && s.cape[i], (v) => v.toFixed(0) + " J/kg")}${s.cape ? "" : " <span class=dim>(model has none)</span>"}`, capeClass(s.cape && s.cape[i]), "bolt"],
        ["QNH (MSL)", f(s.msl && s.msl[i], (v) => W().units.press(v, W().units.pressUnit === "hPa" ? 1 : undefined).txt) + (W().state.point && W().state.point.pressureCurve ? `<span class="baro-curve" title="24 h of pressure from this step">${W().state.point.pressureCurve}</span>` : ""), "", "baro"],
        ["Dew point spread", s.d2m && s.t2m && s.t2m[i] != null && s.d2m[i] != null ? W().units.tempDelta(s.t2m[i] - s.d2m[i]).toFixed(1) + " " + W().units.tempUnit : "—", "", "drop"],
      ], "aloft-kv")}
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
  // ── stat tiles ─────────────────────────────────────────────────────────
  // One shape for every reading, the wind box's shape: a small label over
  // the number, unit in the numeral face, the colour as a tint and a ring.
  // Pills read as tags; a grid of these reads as an instrument panel
  // (Jeff 2026-09-02). Each tile names its group so the card can lay them
  // out under headings — "eight cards that don't say their relation to
  // anything" was the complaint (Jeff 2026-09-04).
  const stat = (k, v, unit, color, extra = "", title = "", group = "air") =>
    `<div class="stat" data-g="${group}" style="--c:${color}"${title ? ` title="${title}"` : ""}><small>${k}</small><b>${v}${unit ? `<i>${unit}</i>` : ""}</b>${extra}</div>`;
  const GROUPS = [["precip", "Precipitation"], ["sky", "Sky"], ["air", "Air"], ["sun", "Sun"], ["uv", "UV"], ["sea", "Sea"], ["aq", "Air quality"]];
  // Tiles → sections. A group with one tile still gets its heading: the
  // heading is the relation, not decoration.
  function sections(tiles, pt) {
    const by = {};
    for (const t of tiles) { const g = (t.match(/data-g="([a-z]+)"/) || [])[1] || "air"; (by[g] = by[g] || []).push(t); }
    // Every group is open by default and folds from its heading alone: no
    // caret, no count, a hover shift on the label is the whole affordance
    // (Jeff 2026-09-05: "don't minimize AIR and SUN … clicking the header ONLY").
    return GROUPS.filter(([g]) => by[g]).map(([g, label]) => {
      const content = `<div class="sect-grid">${by[g].join("")}</div>`;
      const closed = pt && pt.details && pt.details[g] === false;
      return `<details class="sect" data-g="${g}" data-detail="${g}"${closed ? "" : " open"}><summary class="sect-h">${label}</summary>${content}</details>`;
    }).join("");
  }

  // ── vs normal: the day against its 1991–2020 ERA5 climatology ──────────
  // Quiet by design: one muted line under the sunrise, "+4° vs normal", the
  // normal high/low on hover. Fetched once per pin (30-day server cache per
  // 0.25° cell); nothing is drawn until it lands.
  const CUM366 = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const day366 = (dt) => CUM366[dt.getMonth()] + dt.getDate() - 1;
  let normalsFetch = 0;
  function paintNormal(pt, d, i, todays) {
    if (window.WXStatic || !document.getElementById("normal-slot")) return;
    const paint = () => {
      // re-query: the card re-renders (streamed panes, step changes) while
      // the fetch is out, and the slot captured earlier is no longer in the DOM
      const el = document.getElementById("normal-slot");
      if (!el) return;
      const nm = pt.normals;
      const s = d.series;
      if (!nm || !nm.tmean || !todays.length || !s.t2m) { el.hidden = true; return; }
      const slot = day366(new Date(d.valid[i]));
      const ref = nm.tmean[slot], hiN = nm.tmax[slot], loN = nm.tmin[slot];
      if (ref == null) { el.hidden = true; return; }
      const dayMean = todays.reduce((a, k) => a + s.t2m[k], 0) / todays.length - K;
      const dT = W().units.tempDelta(dayMean - ref);
      const u = W().units.tempUnit;
      const word = Math.abs(dT) < 1 ? "near normal" : `${dT > 0 ? "+" : "−"}${Math.abs(dT).toFixed(0)}° vs normal`;
      el.hidden = false;
      el.className = `vs-normal${dT >= 4 ? " warm" : dT <= -4 ? " cool" : ""}`;
      el.title = `${nm.years} ERA5 normal for this date: high ${W().units.tempC(hiN).v}${u} · low ${W().units.tempC(loN).v}${u}${nm.precip && nm.precip[slot] != null ? ` · ${W().units.precip(nm.precip[slot]).txt}/day` : ""}`;
      el.textContent = word;
    };
    if (pt.normals !== undefined) { paint(); return; }
    const my = ++normalsFetch;
    pt.normals = null;
    W().api(`${W().API}/normals?lat=${pt.lat.toFixed(3)}&lon=${pt.lon.toFixed(3)}`)
      .then((r) => { pt.normals = r && r.tmean ? r : null; if (my === normalsFetch && W().state.point === pt) paint(); })
      .catch(() => { pt.normals = null; });
  }

  // ── rain now ────────────────────────────────────────────────────────────
  // The next two hours in 15-minute steps (Open-Meteo minutely_15: HRRR /
  // ICON-D2 where they exist, radar-assimilating), shown only when something
  // falls inside the window. Fetched once per pin and refreshed every five
  // minutes; the slot is re-queried because the card re-renders under it.
  let rainNowFetch = 0;
  const rainNowBust = () => Math.floor(Date.now() / 3e5);
  function rainNowHtml(nc) {
    const step = nc.step_min || 15, n = nc.mm.length, now = nc.now || 0;
    const kind = nc.kind || nc.mm.map((v) => (v > 0.1 ? "rain" : "dry"));
    const rate = nc.mm.map((v) => Math.max(0, v) * 60 / step);                 // mm/h per step
    const top = Math.max(7.5, ...rate) * 1.1;
    const H = 100;
    const P = (j) => rate[Math.max(0, Math.min(n - 1, j))];
    // one spline through the step rates, sampled into thin bars: the shape
    // reads at a glance and a bar per 2.5 min keeps the past/future split crisp
    const cr = (u) => { const k = Math.floor(u), t = u - k, p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
      return Math.max(0, 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)); };
    const per = 6, N = n * per, W_ = N;
    const bars = [];
    for (let b = 0; b < N; b++) {
      const u = (b + 0.5) / per - 0.5, r = cr(u), k = Math.min(n - 1, Math.floor((b + 0.5) / per));
      if (r < 0.15) continue;
      const h = Math.max(3, Math.sqrt(Math.min(1, r / top)) * H);
      const past = k < now, snowy = kind[k] === "snow";
      bars.push(`<rect class="${snowy ? "sn" : "rn"}${past ? " past" : ""}" x="${b + 0.15}" y="${(H - h).toFixed(1)}" width="0.7" height="${h.toFixed(1)}" rx="0.35" style="opacity:${(past ? 0.28 : 0.45 + 0.55 * Math.min(1, r / top)).toFixed(2)}"/>`);
    }
    const bandRows = [["light", 2.5], ["moderate", 7.5]].filter(([, r]) => r < top);
    const y = (r) => H - Math.sqrt(Math.min(1, r / top)) * H;
    const bands = bandRows.map(([, r]) => `<line class="band" x1="0" x2="${W_}" y1="${y(r).toFixed(1)}" y2="${y(r).toFixed(1)}"/>`).join("");
    const bandLabels = bandRows.map(([nm, r]) => `<span class="band-l" style="top:${y(r).toFixed(1)}%">${nm}</span>`).join("");
    const nowX = now * per;
    const t0 = new Date(nc.times[now]);
    const tick = (mins) => { const d = new Date(t0.getTime() + mins * 6e4); return d.toLocaleTimeString(undefined, W().units.timeOpts({ hour: "numeric", minute: "2-digit" })).replace(/\s?[ap]m$/i, (m) => m.trim().toLowerCase()); };
    const labels = [];
    for (let k = 0; k < n; k += 4) { const m = (k - now) * step; labels.push(`<span class="${m === 0 ? "now" : ""}" style="left:${(k * per / W_ * 100).toFixed(1)}%">${m === 0 ? "now" : m < 0 ? `${m / 60 === -1 ? "1 h ago" : `${-m} min ago`}` : `${tick(m)}`}</span>`); }
    const snowAny = kind.some((k) => k === "snow"), rainAny = kind.some((k) => k === "rain");
    return `<div class="rn-head"><small class="sect-h">${snowAny && !rainAny ? "Snow" : snowAny ? "Rain & snow" : "Rain"} now</small><i>${nc.source || ""}</i></div>
      <b class="rn-line">${nc.headline || ""}</b>
      <div class="rn-wrap">${bandLabels}<svg class="rn-chart" viewBox="0 0 ${W_} ${H}" preserveAspectRatio="none" aria-hidden="true">
        ${bands}${bars.join("")}
        <line class="now" x1="${nowX}" x2="${nowX}" y1="0" y2="${H}"/>
      </svg></div><div class="rn-x">${labels.join("")}</div>`;
  }
  function paintRainNow(pt) {
    if (window.WXStatic || !document.getElementById("rainnow-slot")) return;
    const paint = () => {
      const el = document.getElementById("rainnow-slot");
      if (!el) return;
      const nc = pt.rainNow;
      if (!nc || !nc.headline) { el.hidden = true; return; }
      el.hidden = false; el.innerHTML = rainNowHtml(nc);
    };
    const bust = rainNowBust();
    if (pt.rainNow !== undefined && pt.rainNowBust === bust) { paint(); return; }
    const my = ++rainNowFetch;
    pt.rainNowBust = bust;
    if (pt.rainNow === undefined) pt.rainNow = null;
    W().api(`${W().API}/nowcast?lat=${pt.lat.toFixed(3)}&lon=${pt.lon.toFixed(3)}`)
      .then((r) => { pt.rainNow = r && r.mm ? r : null; if (my === rainNowFetch && W().state.point === pt) paint(); })
      .catch(() => { pt.rainNow = null; });
  }

  // ── nearby webcams ─────────────────────────────────────────────────────
  // What the sky actually looks like from the nearest pass or shore road.
  // Public DOT cams today (DriveBC); more providers are a server-side list.
  // Fetched once per pin and slotted in, never re-rendered with the step:
  // the pictures do not change with the forecast hour.
  let camsFetch = 0;
  const camBust = () => Math.floor(Date.now() / 3e5);          // fresh still every 5 min, cached in between
  function fetchCams(pt) {
    if (window.WXStatic) return;
    const my = ++camsFetch;
    const paint = (cams) => {
      if (my !== camsFetch) return;
      const el = document.getElementById("cams-slot");
      if (!el) return;
      if (!cams || !cams.length) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = `<div class="cams-head"><small>Webcams nearby</small><span>${cams.length} · ${cams[0].provider}</span></div>
        <div class="cams-strip">${cams.map((c, k) => `<button class="cam${c.stale ? " stale" : ""}" data-cam="${k}" type="button" title="${esc(c.caption || c.name)}">
          <img src="${esc(c.image)}${c.image.includes("?") ? "&" : "?"}t=${camBust()}" alt="" loading="lazy">
          <span class="cam-name">${esc(c.name)}</span>
          <span class="cam-dist">${c.distance_km} km ${compass(c.bearing_deg)}${c.elevation_m != null ? ` · ${W().units.alt(c.elevation_m).v} ${W().units.altUnit}` : ""}</span>
        </button>`).join("")}</div>`;
      el.querySelectorAll(".cam").forEach((b) => {
        b.onclick = () => openCam(cams[+b.dataset.cam]);
        b.onpointerenter = () => camPin(cams[+b.dataset.cam]);
        b.onpointerleave = () => camPin(null);
      });
    };
    if (pt.cams) { paint(pt.cams); return; }
    W().api(`${W().API}/webcams?lat=${pt.lat.toFixed(3)}&lon=${pt.lon.toFixed(3)}&n=8`)
      .then((r) => { pt.cams = (r && r.cams) || []; paint(pt.cams); })
      .catch(() => { pt.cams = []; paint(pt.cams); });
  }
  // Hovering a thumbnail drops a small camera pin where that camera stands,
  // with a soft pulse so the eye finds it (Jeff 2026-09-04: "subtle and
  // modern"). One pin, replaced on the next hover, gone on leave.
  let camMarker = null;
  function camPin(c) {
    if (camMarker) { camMarker.remove(); camMarker = null; }
    if (!c || !W().map || W().map.noMap) return;
    const el = document.createElement("div"); el.className = "cam-pin"; el.title = c.name;
    el.innerHTML = `<i class="ring"></i><span class="dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></span>`;
    camMarker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([c.lon, c.lat]).addTo(W().map);
  }
  function openCam(c) {
    let dlg = document.getElementById("cam-view");
    if (!dlg) {
      dlg = document.createElement("dialog"); dlg.id = "cam-view"; dlg.className = "cam-view";
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    }
    // Sized by the picture, never by the caption: a long title used to
    // stretch the box and leave a small still alone on the left (Jeff 2026-09-04).
    dlg.style.width = "";
    dlg.innerHTML = `<div class="cam-view-head"><div class="cam-view-titles"><b>${esc(c.name)}</b>${c.caption ? `<span>${esc(c.caption)}</span>` : ""}</div><button class="icon cam-view-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
      <img src="${esc(c.image)}${c.image.includes("?") ? "&" : "?"}t=${camBust()}" alt="${esc(c.name)}">
      <div class="cam-view-foot"><span>${[c.updated ? `updated ${new Date(c.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "", c.provider === "Windy" ? "" : esc(c.credit)].filter(Boolean).join(" · ")}</span><a href="${esc(c.page)}" target="_blank" rel="noopener">${esc(c.provider)} ↗</a></div>`;
    const img = dlg.querySelector("img");
    // small provider stills (Windy previews are 400 px) get scaled up to a
    // real viewing size; big ones keep their own width
    const fit = () => { dlg.style.width = `${Math.min(innerWidth * 0.94, Math.max(640, img.naturalWidth || 0))}px`; };
    img.addEventListener("load", fit); if (img.complete && img.naturalWidth) fit();
    dlg.querySelector("button.icon").onclick = () => dlg.close();
    dlg.showModal();
  }
  let stormFetch = 0;
  // The meteorological tropical-cyclone symbol, not an emoji: a core with
  // two trailing arms, drawn in whatever colour the category earned.
  // The NHC symbol proper: a solid ring and two tapered spiral arms, generated
  // as filled polygons (a stroked sketch read as a ring with stubs).
  // The NWS hurricane symbol: a disc with two sickle arms, hollow eye.
  // Same path as the map icon in overlays.js (CYCLONE_PATH); mirrored and
  // tilted so the arms trail anticlockwise like a northern-hemisphere storm
  // (Jeff 2026-08-22: "you drew it backwards").
  const CYCLONE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path transform="translate(12 12) rotate(55) scale(-1 1) translate(-12 -12)" d="M12.50 2.16A7.9 7.9 0 1 1 4.57 13.80A7.1 7.1 0 1 0 12.50 2.16ZM11.50 21.84A7.9 7.9 0 1 1 19.43 10.20A7.1 7.1 0 1 0 11.50 21.84ZM17.8 12A5.8 5.8 0 1 1 6.2 12A5.8 5.8 0 1 1 17.8 12ZM14.9 12A2.9 2.9 0 1 0 9.1 12A2.9 2.9 0 1 0 14.9 12Z"/></svg>`;
  W().CYCLONE_SVG = CYCLONE_SVG;
  // The storm list is the same for every render of the card; fetch it once
  // and keep it five minutes (seven identical requests per open, 2026-08-28).
  let stormMemo = { t: 0, p: null };
  const storms = () => { const now = Date.now(); if (!stormMemo.p || now - stormMemo.t > 300e3) stormMemo = { t: now, p: W().api(`${W().API}/storms`).catch((e) => { stormMemo.p = null; throw e; }) }; return stormMemo.p; };
  function fetchNearStorm(pt) {
    const my = ++stormFetch;
    storms().then((gj) => {
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
      // distance in the user's unit — aviation profile reads nm, not km
      const d = W().units.dist(Math.round(best.km / 10) * 10, 0);
      el.innerHTML = `<span class="ws-ico">${CYCLONE_SVG}${p.category ? `<span class="ws-cat" style="--cat:${p.category_color || "#ef786f"}">${esc(p.category)}</span>` : ""}</span><span class="ws-txt"><small>${esc((p.class || "").toUpperCase())}</small><b>${esc(p.name || "")}</b><em>${d.txt} ${dir}</em></span>`;
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
      <span class="k">Ski area</span><span class="v">${esc(pt.near.name)}<i>${W().units.dist(pt.near.distance_km).txt} away</i></span></button>`;
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
    // Touring: the four things a skinner checks before the car — new snow,
    // where the freezing level is going, which aspects the wind is loading,
    // and today's danger rating — on one card with one call.
    const touringHtml = (() => {
      const U = W().units;
      const newCm = sn24we == null ? null : sn24we * slr / 10;
      const avyDay = pt.avy && pt.avy.days && pt.avy.days[0];
      const lvl = avyDay ? Math.max(...["alp", "tln", "btl"].map((b) => (avyDay[b] && avyDay[b].level != null ? avyDay[b].level : -1))) : -1;
      const lvlName = ["Low", "Moderate", "Considerable", "High", "Extreme"][lvl] || null;
      const loading = w850 != null && speed(w850) > (W().state.units === "kt" ? 15 : W().state.units === "ms" ? 8 : W().state.units === "mph" ? 17 : 28);
      const worries = [];
      if (lvl >= 2) worries.push(`${lvlName.toLowerCase()} danger`);
      if (!lvlName) worries.push("avalanche rating unavailable");
      if (rainOnSnow) worries.push("rain on snow");
      if (loading) worries.push(`${lee} aspects loading`);
      if (flTrend === " ↑") worries.push("freezing level rising");
      const call = lvl >= 3 || rainOnSnow ? ["High concern", "bad"] : lvl === 2 || loading || !lvlName ? ["Caution", "meh"] : ["Lower concern", "good"];
      const concern = worries.length ? esc(worries.join(", ")) : "no major flag in this screen";
      const remark = call[1] === "bad"
        ? `This quick screen flags ${concern}. Start with conservative terrain; the full bulletin and local observations decide the route.`
        : call[1] === "meh"
          ? `This quick screen flags ${concern}. Choose terrain that avoids the problem, then verify it against the full bulletin and local observations.`
          : "Weather and bulletin inputs do not raise a major flag here. Confirm the full bulletin and local observations before choosing terrain.";
      const bulletin = pt.avy && pt.avy.url ? ` <a href="${esc(pt.avy.url)}" target="_blank" rel="noopener">Read bulletin ↗</a>` : "";
      const stats = [
        `<div><small>New snow 24 h</small><b>${newCm == null ? "—" : U.snow(sn24we * slr / 10).v}<i>${esc(U.snowUnit)}</i></b><em>${newCm == null ? "" : `${slr}:1`}</em></div>`,
        `<div><small>Freezing level</small><b>${fl == null ? "—" : U.alt(Math.round(fl / 50) * 50).v}<i>${esc(U.altUnit)}</i></b><em>${flTrend === " ↓" ? "falling" : flTrend === " ↑" ? "rising" : "steady"}</em></div>`,
        `<div><small>Wind loading</small><b>${loading ? lee : "light"}</b><em>${w850 != null ? `<i class="lvl">850 hPa</i>${speed(w850).toFixed(0)} ${esc(speedUnit())}` : ""}</em></div>`,
        lvlName ? `<div><small>Danger</small><b class="avy-${lvl}">${lvlName}</b><em>${esc((avyDay.label || avyDay.date || "today").toString().slice(0, 9))}</em></div>` : "",
      ].filter(Boolean).join("");
      return `<div class="modcard touring ${call[1]}"><div class="mod-head"><span class="call">${call[0]}</span><span class="dim">${worries.length ? worries.join(" · ") : "quick terrain screen"}</span></div><div class="mod-stats">${stats}</div><p class="touring-remark">${remark}${bulletin}</p></div>`;
    })();
    $("#winter").innerHTML = `${touringHtml}${powderHtml}${resortHtml}${boardHtml}<div class="kv">${rows.map(([k, v, cls]) => `<div class="stat ${cls || ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>${avyHtml}
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
    // The verdict: the worst of the calls the rows already made, said once at
    // the top the way a partner would say it at the trailhead — and WHY, by
    // name. The old two-word verdict told nobody what to watch.
    const flagged = rows.filter((r) => r[2] === "bad" || r[2] === "meh");
    const worst = flagged.some((r) => r[2] === "bad") ? "bad" : flagged.length ? "meh" : "good";
    const nameOf = (r) => `${r[0].toLowerCase().replace(/ \(.*\)| 24 h| \/ gust|,.*/g, "")} ${r[1].replace(/<[^>]+>/g, "")}`;
    const why = flagged.filter((r) => r[2] === worst).slice(0, 3).map(nameOf).join(" · ");
    const verdict = worst === "bad" ? ["Rough out there", "bad"] : worst === "meh" ? ["Workable", "meh"] : ["Looks good", "good"];
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
      const now = W().validDate.getTime();
      const turns = t.events.filter((e) => new Date(e.time).getTime() > now).slice(0, 8);
      const hs = turns.map((e) => e.height_m), range = hs.length > 1 ? Math.max(...hs) - Math.min(...hs) : null;
      tidesHtml = `<div class="obs tides-obs"><div class="obs-head"><span class="stn"><b>Tides</b><span class="nm">${esc(t.station)}<small>${W().units.dist(t.distance_km).txt}</small></span></span><span class="src"><b>${esc(t.datum)}</b>${esc(t.source)}</span></div>
        ${tideCard(pt)}
        <div class="tides">${turns.map((e) => `<span class="tide ${e.type}"><b>${e.type === "H" ? "▲" : "▼"} ${W().units.alt(e.height_m, 1).txt}</b><small>${W().units.dateTime(e.time, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small></span>`).join("")}</div>
        ${range != null ? `<div class="tide-foot"><span>range <b>${W().units.alt(range, 1).txt}</b></span><span>${turns.length} turns ahead</span></div>` : ""}</div>`;
    }
    // Each group of readings gets the graphic that explains it, drawn over
    // the same 48 h: the strips share one clock, so the eye lines them up.
    const H = 48;
    const uv = hourStrip(d, i, H, (k) => {
      const v = s.uvi ? s.uvi[k] : null;
      return { bg: v == null || v < 0.5 ? "rgba(127,127,127,.12)" : W().rampColor("uvi", v, 0.85), v, n: v };
    }, (k, c) => c != null && c >= 3 && isDayPeak(d, k, s.uvi) ? c.toFixed(0) : "");
    const sky = hourStrip(d, i, H, (k) => {
      const c = s.tcc ? s.tcc[k] : null, r = s.tp6 ? s.tp6[k] : 0;
      return { bg: c == null ? "transparent" : `rgba(127,140,160,${(0.1 + 0.55 * c).toFixed(2)})`, bar: r > 0.05 ? Math.min(1, r / 8) : 0,
        v: `${c == null ? "" : `cloud ${Math.round(c * 100)}%`}${r > 0.05 ? ` · ${W().units.precip(r).txt}` : ""}` };
    }, () => "");
    const gust = windCard(d, i, H);
    const take = (...keys) => rows.filter((r) => keys.some((k) => r[0].startsWith(k)));
    // The number leads, its unit and qualifier trail small, the label sits
    // under it in plain words: one glance says 28, the next says km/h, the
    // third says which. Green is not painted on — a fine reading is the
    // quiet default; only meh/bad earn a colour and a rule.
    const lead = (v) => { const m = String(v).match(/^(—|[-+]?\d[\d.,]*\s?(?:°[CF]?|%|h(?=\s|$))?)(.*)$/s); return m ? `<b>${m[1]}</b>${m[2].trim() ? `<small>${m[2].trim()}</small>` : ""}` : `<b class="word">${String(v).charAt(0).toUpperCase()}${String(v).slice(1)}</b>`; };
    // Each card carries its glyph in the corner and, where the reading is a
    // share of something, a gauge under the number: cloud is a share of the
    // sky, dry hours a share of three days, UV a share of the 11-point scale.
    const glyphFor = (k) => k.startsWith("Precip now") ? "drop" : k.startsWith("Next 24 h rain") ? "drop" : k.startsWith("Precip chance") ? "dice"
      : k.startsWith("Cloud base") ? "base" : k.startsWith("Cloud") ? "cloud" : k.startsWith("Thunder") ? "bolt" : k.startsWith("Visibility") ? "eye"
      : k.startsWith("UV") ? "sun" : k.startsWith("Wind") ? "wind" : k.startsWith("Max gust") ? "gust" : k.startsWith("Feels") ? "thermo"
      : k.startsWith("Dry, calm") ? "clock" : k.startsWith("Freezing") ? "flake" : k.startsWith("Snow level") ? "peak" : k.startsWith("Sea") ? "wave" : "";
    const gaugeFor = (k, v) => {
      const num = parseFloat(String(v).replace(/<[^>]+>/g, ""));
      if (!isFinite(num)) return null;
      if (k.startsWith("Cloud") && !k.startsWith("Cloud base")) return num / 100;
      if (k.startsWith("Precip chance")) return num / 100;
      if (k.startsWith("Dry, calm")) { const m = String(v).match(/of (\d+)/); return m ? num / +m[1] : null; }
      if (k.startsWith("UV")) return Math.min(1, num / 11);
      if (k.startsWith("Visibility")) return Math.min(1, num / 20);
      return null;
    };
    const kv = (rs) => rs.length ? `<div class="kv">${rs.map(([k, v, cls]) => { const gg = gaugeFor(k, v), gl = glyphFor(k);
      return `<div class="stat ${cls || ""}${gl ? ` g-${gl}` : ""}">${gl ? `<i class="glyph">${OD_GLYPHS[gl] || ""}</i>` : ""}<span class="v">${lead(v)}</span><span class="k">${k.replace(/ \(≈\)/, " ≈").replace("Precip", "Precip.")}</span>${gg != null ? `<i class="gauge"><b style="width:${(gg * 100).toFixed(0)}%"></b></i>` : ""}</div>`; }).join("")}</div>` : "";
    const section = (title, graphic, rs, note) => `<section class="od"><h4>${title}${note ? `<span>${note}</span>` : ""}</h4>${graphic || ""}${kv(rs)}</section>`;
    const cold = fl != null && (t == null || t < 12 || snowLevel < 3000);
    const brief = outdoorsBrief(d, i, { rain24, chance, gustMax24, fl, snowLevel, cold, calm, gusty });
    $("#outdoors").innerHTML = `<div class="verdict ${verdict[1]}"><b>${verdict[0]}</b>${why ? `<span class="why">${why}</span>` : ""}${winHtml}${brief ? `<p class="brief">${brief}</p>` : ""}</div>
      ${section("Sky &amp; rain", sky, take("Precip", "Next 24 h rain", "Cloud", "Visibility", "Thunder"), "cloud cover · rain bars, 48 h")}
      ${section("Sun", uv, take("UV"), "uv index, 48 h · daily peaks labelled")}
      ${section("Wind", gust, take("Wind", "Max gust", "Feels like", "Dry, calm"), "gusts, 48 h")}
      ${cold ? section("Snow &amp; cold", "", take("Freezing", "Snow level")) : ""}
      ${take("Sea state").length ? section("Sea", marineCard(pt, d, i), take("Sea state")) : ""}
      ${tidesHtml}${airHtml(pt || {})}
      <div class="note">Snow level ≈ freezing level − ${W().units.alt(300).txt}. Gusts come from models that ship one. Terrain is unresolved at 0.25°.</div>`;
    wireTideProbe();
    wireWindProbe();
    wireStripProbes();
  }

  // The trailhead briefing under the verdict: the two days ahead in the
  // order a person plans them — rain, wind, sun, snow, sea — each in one
  // sentence with a time attached, none of them a restatement of a card.
  function outdoorsBrief(d, i, c) {
    const s = d.series, U = W().units;
    const parts = story(d, i);
    const out = parts.filter((p) => ["rain", "sky", "wind", "breeze", "uv", "fog"].includes(p.k)).map((p) => p.t);
    // snow: only where the freezing level is part of the plan
    if (c.cold && c.fl != null) out.push(`Freezing level ${U.alt(Math.round(c.fl / 50) * 50).txt}, snow above about ${U.alt(Math.round(c.snowLevel / 50) * 50).txt}.`);
    // sea: the swell, from where
    if (s.swh && s.swh[i] != null) out.push(`Swell ${U.alt(s.swh[i], 1).txt}${s.mwp && s.mwp[i] != null ? ` at ${s.mwp[i].toFixed(0)} s` : ""}${s.mwd && s.mwd[i] != null ? ` from the ${compass(s.mwd[i])}` : ""}.`);
    return out.join(" ");
  }

  // Pointer over the tide chart: a ring rides the water under the cursor
  // and a tag says when and how high. Same cosine as the drawing, so the
  // ring sits on the line rather than near it.
  function wireTideProbe() {
    const area = $("#outdoors .tide-area[data-ev]");
    if (!area || area.dataset.wired) return;
    area.dataset.wired = "1";
    const ev = JSON.parse(area.dataset.ev), lo = +area.dataset.lo, rng = +area.dataset.rng;
    const x0 = ev[0][0], x1 = ev[ev.length - 1][0];
    const dot = area.querySelector(".tdot.hov"), lab = area.querySelector(".tlab");
    const show = (clientX) => {
      const r = area.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const x = x0 + f * (x1 - x0);
      let h = null;
      for (let k = 0; k + 1 < ev.length; k++)
        if (x >= ev[k][0] && x <= ev[k + 1][0]) { h = ev[k][1] + (ev[k + 1][1] - ev[k][1]) * (1 - Math.cos(Math.PI * (x - ev[k][0]) / (ev[k + 1][0] - ev[k][0]))) / 2; break; }
      if (h == null) return;
      const top = 100 - (h - lo) / rng * 100;
      dot.style.left = `${(f * 100).toFixed(1)}%`; dot.style.top = `${top.toFixed(1)}%`; dot.hidden = false;
      lab.textContent = `${W().units.dateTime(new Date(x), { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${W().units.alt(h, 1).txt}`;
      lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
    };
    const hide = () => { dot.hidden = true; lab.hidden = true; };
    area.addEventListener("pointermove", (e) => show(e.clientX));
    area.addEventListener("pointerdown", (e) => show(e.clientX));
    area.addEventListener("pointerleave", hide);
  }

  // Stat cards the way Outdoors draws them — number first, unit small, label
  // under, a glyph in the corner, a gauge when the value is a share — for the
  // other tabs that carry a handful of readings.
  function statCards(rows, cls) {
    const lead = (v) => { const m = String(v).match(/^(—|[-+]?\d[\d.,]*\s?(?:°[CF]?|%|h(?=\s|$))?)(.*)$/s); return m ? `<b>${m[1]}</b>${m[2].trim() ? `<small>${m[2].trim()}</small>` : ""}` : `<b class="word">${String(v).charAt(0).toUpperCase()}${String(v).slice(1)}</b>`; };
    return `<div class="kv ${cls || ""}">${rows.map(([k, v, c, g, share]) => `<div class="stat ${c || ""}${g ? ` g-${g}` : ""}">${g ? `<i class="glyph">${OD_GLYPHS[g] || ""}</i>` : ""}<span class="v">${lead(v)}</span><span class="k">${k}</span>${share != null ? `<i class="gauge"><b style="width:${(share * 100).toFixed(0)}%"></b></i>` : ""}</div>`).join("")}</div>`;
  }

  // The card glyphs: 24-unit strokes, one line weight, coloured by the card
  // through currentColor so a flagged card's glyph flags with it.
  const OD_GLYPHS = (() => {
    const w = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    return {
      drop: w('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
      dice: w('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>'),
      cloud: w('<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.4 1.6A3.5 3.5 0 0 1 17.5 18z"/>'),
      base: w('<path d="M7 14a4 4 0 0 1-.5-8 6 6 0 0 1 11.4 1.6A3.5 3.5 0 0 1 17.5 14z"/><path d="M4 20h16"/>'),
      bolt: w('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
      eye: w('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
      sun: w('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
      wind: w('<path d="M3 8h9a3 3 0 1 0-3-3M3 12h14a3 3 0 1 1-3 3M3 16h7a2 2 0 1 1-2 2"/>'),
      gust: w('<path d="M3 10h11a3 3 0 1 0-3-3M3 14h16a3 3 0 1 1-3 3"/><path d="M4 19l2-1 2 1 2-1"/>'),
      thermo: w('<path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v6"/>'),
      clock: w('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
      flake: w('<path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19"/>'),
      peak: w('<path d="M3 20 10 7l3 5 2-3 6 11z"/><path d="M8 11l2-1 2 1"/>'),
      wave: w('<path d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0M2 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>'),
      baro: w('<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/><path d="M12 5v2M5 13h2M17 13h2"/>'),
    };
  })();

  // The sea, for someone going in: swell, period, where it comes from, the
  // wind against it (offshore holds a wave up, onshore knocks it down), the
  // water, the tide's turn — and one verdict from all of it, with a 48 h
  // swell strip so the call for tomorrow is on the same card.
  function marineCard(pt, d, i) {
    const s = d.series, U = W().units, { speed, speedUnit, arrow } = W();
    const swh = seaVal(d, i, "swh"); if (!swh) return "";
    const mwp = seaVal(d, i, "mwp"), mwd = seaVal(d, i, "mwd"), sst = seaVal(d, i, "sst");
    const w = s.wind ? s.wind[i] : null, wd = s.wdir ? s.wdir[i] : null;
    // onshore / offshore: the coast probe says which way the sea lies from
    // the pin; wind blowing TOWARD the sea is offshore. With no probe the
    // swell's own direction stands in for "where the sea is".
    const seaBearing = (() => { const c = coastNear(d); if (c && c.bearing_deg != null) return c.bearing_deg; return mwd ? mwd.v : null; })();
    let rel = null;
    if (w != null && wd != null && seaBearing != null) {
      const to = (wd + 180) % 360, diff = Math.abs(((to - seaBearing) + 540) % 360 - 180);
      rel = diff < 60 ? "offshore" : diff > 120 ? "onshore" : "cross-shore";
    }
    const kmh = w == null ? null : w * 3.6;
    const per = mwp ? mwp.v : null, h = swh.v;
    // the call: size, period and wind, in the order a surfer weighs them
    let call, cls, why;
    if (h > 3.5 || (kmh != null && kmh > 40 && rel !== "offshore")) { call = "Heavy"; cls = "bad"; why = h > 3.5 ? "big swell" : "strong onshore wind"; }
    else if (h < 0.5) { call = "Flat"; cls = "meh"; why = "no swell to speak of"; }
    else if ((per == null || per >= 9) && (kmh == null || kmh < 15 || rel === "offshore")) { call = "Clean"; cls = "good"; why = rel === "offshore" ? "offshore wind, groomed faces" : "light wind, long-period swell"; }
    else if (kmh != null && kmh >= 25 && rel === "onshore") { call = "Blown out"; cls = "bad"; why = "onshore wind on the faces"; }
    else { call = "Rideable"; cls = "meh"; why = per != null && per < 9 ? "short-period wind swell" : "some wind on it"; }
    const tide = nextTide(pt);
    const tideTxt = tide ? `${tide.type === "H" ? "high" : "low"} at ${U.time(tide.time)}` : "";
    const stats = [
      `<div><small>Swell</small><b>${U.alt(h, 1).v}<i>${esc(U.altUnit)}</i></b>${mwd ? `<em>${arrow(mwd.v)} from ${compass(mwd.v)}</em>` : ""}</div>`,
      per != null ? `<div><small>Period</small><b>${per.toFixed(0)}<i>s</i></b><em>${per >= 12 ? "ground swell" : per >= 9 ? "mid-period" : "wind swell"}</em></div>` : "",
      w != null ? `<div><small>Wind</small><b>${speed(w).toFixed(0)}<i>${esc(speedUnit())}</i></b><em>${wd != null ? `${arrow(wd)} ${compass(wd)}` : ""}${rel ? ` · ${rel}` : ""}</em></div>` : "",
      sst ? `<div><small>Water</small><b>${U.tempC(sst.v - K).v}<i>${esc(U.tempUnit)}</i></b><em>${sst.v - K < 12 ? "5/4 hooded" : sst.v - K < 16 ? "4/3 wetsuit" : sst.v - K < 20 ? "3/2 wetsuit" : "boardshorts"}</em></div>` : "",
      tide ? `<div><small>Tide</small><b>${esc(U.time(tide.time))}</b><em>next ${tide.type === "H" ? "high" : "low"} · ${esc(U.alt(tide.height_m, 1).txt)}</em></div>` : "",
    ].filter(Boolean).join("");
    // 48 h of swell as a strip: height in the cell, the ramp by size
    const strip = hourStrip(d, i, 48, (k) => {
      const v = s.swh ? s.swh[k] : null;
      return { bg: v == null ? "transparent" : `rgba(74,169,217,${Math.min(0.85, 0.12 + v / 4).toFixed(2)})`, v: v == null ? "" : `swell ${U.alt(v, 1).txt}${s.mwp && s.mwp[k] != null ? ` · ${s.mwp[k].toFixed(0)} s` : ""}`, n: v };
    }, (k, v) => (v != null && (k === i || isDayPeak(d, k, s.swh)) ? U.alt(v, 1).v : ""));
    return `<div class="modcard marine ${cls}"><div class="mod-head"><span class="call">${call}</span><span class="dim">${why}${tideTxt ? ` · ${tideTxt}` : ""}</span></div>
      <div class="mod-stats">${stats}</div>${strip}</div>`;
  }

  // A row of hour cells over the next `hours` from step i, each as wide as
  // the hours it covers, with the day named where it changes. `cell(k)`
  // gives {bg, bar?, v}; `label(k, v)` prints inside the cell or nothing.
  // Is it night at this point at this instant? Between sunset and sunrise
  // by the same arithmetic the hero's sun times use; polar day/night when
  // the sun never crosses the horizon.
  function isNight(lat, lon, when) {
    const st = sunTimes(lat, lon, when);
    const h = when.getUTCHours() + when.getUTCMinutes() / 60;
    if (!st) return Math.abs(lat) > 60 && (lat > 0) === (when.getUTCMonth() < 3 || when.getUTCMonth() > 8);
    const r = st.riseUtc, s = st.setUtc;
    return r < s ? (h < r || h >= s) : (h >= s && h < r);
  }
  function hourStrip(d, i, hours, cell, label) {
    const cells = [], days = [];
    const pt = W().state.point || {};
    let total = 0, lastDay = null;
    for (let k = i; k < d.steps.length && d.steps[k] < d.steps[i] + hours; k++) {
      const h = stepHrs(d, k), c = cell(k), when = new Date(d.valid[k]);
      const night = pt.lat != null && isNight(pt.lat, pt.lon, when);
      const day = when.toLocaleDateString(undefined, W().units.timeOpts({ weekday: "short" }));
      if (day !== lastDay) { days.push(`<i style="left:${(total / hours * 100).toFixed(1)}%">${day}</i>`); lastDay = day; }
      const said = c.v == null || c.v === "" ? "" : typeof c.v === "number" ? ` · UV ${c.v.toFixed(0)}` : ` · ${c.v}`;
      cells.push(`<i class="${night ? "n" : ""}" style="flex:${h} 0 0;background:${c.bg}" title="${when.toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }))}${said}">${c.bar ? `<b style="height:${(c.bar * 100).toFixed(0)}%"></b>` : ""}<s>${label(k, c.n != null ? c.n : c.v)}</s></i>`);
      total += h;
    }
    if (cells.length < 4) return "";
    return `<div class="hstrip"><div class="cells">${cells.join("")}</div><div class="hx">${days.join("")}</div></div>`;
  }
  function isDayPeak(d, k, arr) {
    if (!arr || arr[k] == null) return false;
    const day = new Date(d.valid[k]).toDateString();
    for (let q = 0; q < d.valid.length; q++)
      if (new Date(d.valid[q]).toDateString() === day && arr[q] != null && (arr[q] > arr[k] || (arr[q] === arr[k] && q < k))) return false;
    return true;
  }
  // The wind over the next `hours` as the tide is drawn: a readout on top
  // (wind now, from where, the gust with it, the peak gust ahead and when),
  // a chart with its y axis in the user's unit, wind as the line and gusts
  // as the lighter band above it, a ring at the card's time, and a pointer
  // probe that says the time, wind, gust and direction under the finger.
  function windCard(d, i, hours) {
    const { speed, speedUnit, arrow } = W(), s = d.series;
    if (!s.wind) return "";
    const unit = speedUnit();
    const rows = [];
    for (let k = i; k < d.steps.length && d.steps[k] <= d.steps[i] + hours; k++)
      if (s.wind[k] != null) rows.push([new Date(d.valid[k]).getTime(), speed(s.wind[k]), s.gust && s.gust[k] != null ? speed(s.gust[k]) : null, s.wdir ? s.wdir[k] : null]);
    if (rows.length < 4) return "";
    const x0 = rows[0][0], x1 = rows[rows.length - 1][0], span = Math.max(x1 - x0, 1);
    const mx = Math.max(1, ...rows.map((r) => Math.max(r[1], r[2] || 0)));
    const X = (x) => (x - x0) / span * 100, Y = (v) => 100 - v / mx * 92;
    const wpts = rows.map((r) => `${X(r[0]).toFixed(2)},${Y(r[1]).toFixed(2)}`);
    const gpts = rows.filter((r) => r[2] != null).map((r) => `${X(r[0]).toFixed(2)},${Y(r[2]).toFixed(2)}`);
    // the peak gust ahead (or the peak wind if the model ships no gust)
    let peak = rows[0]; for (const r of rows) if ((r[2] ?? r[1]) > (peak[2] ?? peak[1])) peak = r;
    const now = W().validDate.getTime();
    const dt = peak[0] - now, inTxt = dt > 3600e3 ? `${Math.floor(dt / 3600e3)}h${String(Math.round(dt % 3600e3 / 60e3)).padStart(2, "0")}` : dt > 0 ? `${Math.round(dt / 60e3)} min` : "";
    const cur = rows[0];
    const readout = `<div class="tide-now wind-now">
        <span class="tnum"><b>${cur[1].toFixed(0)}</b><i>${unit}</i></span>
        <span class="tdir">${cur[3] != null ? `${arrow(cur[3])} ${compass(cur[3])}` : ""}${cur[2] != null ? ` · gusts ${cur[2].toFixed(0)}` : ""}</span>
        ${peak !== cur ? `<span class="tnext"><b>peak ${(peak[2] ?? peak[1]).toFixed(0)} ${unit}</b><em>${W().units.dateTime(new Date(peak[0]), { weekday: "short", hour: "numeric" })}${inTxt ? ` · ${inTxt}` : ""}</em></span>` : ""}
      </div>`;
    // x axis: every local midnight is a day, every local noon a tick
    const hourOf = new Intl.DateTimeFormat("en-US", W().units.timeOpts({ hour: "2-digit", hour12: false }));
    const xt = [];
    for (let x = Math.ceil(x0 / 3600e3) * 3600e3; x <= x1; x += 3600e3) {
      const h = hourOf.format(new Date(x)).replace("24", "00");
      if (h === "00") xt.push(`<i class="day" style="left:${X(x).toFixed(1)}%">${new Date(x).toLocaleDateString(undefined, W().units.timeOpts({ weekday: "short" }))}</i>`);
      else if (h === "12") xt.push(`<i style="left:${X(x).toFixed(1)}%">noon</i>`);
    }
    const marker = `<i class="tdot now" style="left:0%;top:${Y(cur[1]).toFixed(1)}%"></i>`;
    const probe = `<i class="tdot hov" hidden></i><s class="tlab" hidden></s>`;
    const nights = nightBands(x0, x1, X);
    const data = esc(JSON.stringify(rows.map((r) => [r[0], +r[1].toFixed(1), r[2] == null ? null : +r[2].toFixed(1), r[3] == null ? null : Math.round(r[3])])));
    return `<div class="tide-card wind-card">${readout}
      <div class="tide-plot">
        <div class="tide-y"><i>${mx.toFixed(0)}</i><i>0</i><u>${unit}</u></div>
        <div class="tide-area wind-area" data-rows="${data}" data-mx="${mx}">${nights}<div class="tide-water wind-water"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${gpts.length > 3 ? `<polygon class="g" points="${gpts.join(" ")} ${wpts.slice().reverse().join(" ")}"/>` : ""}<polygon class="w" points="0,100 ${wpts.join(" ")} 100,100"/>${gpts.length > 3 ? `<polyline class="g" points="${gpts.join(" ")}"/>` : ""}<polyline class="w" points="${wpts.join(" ")}"/></svg>${marker}${probe}</div></div>
      </div>
      <div class="tide-x">${xt.join("")}</div>
    </div>`;
  }
  // Hover on any hour strip (sky, sun): a tag names the hour and the value
  // under the pointer. The cells already carry that text as a title for the
  // long-press crowd; the tag shows it without the wait.
  function wireStripProbes() {
    document.querySelectorAll("#outdoors .hstrip").forEach((strip) => {
      if (strip.dataset.wired) return;
      strip.dataset.wired = "1";
      const cells = strip.querySelector(".cells");
      const lab = document.createElement("s"); lab.className = "tlab"; lab.hidden = true; cells.appendChild(lab);
      const show = (clientX) => {
        const r = cells.getBoundingClientRect(), f = Math.max(0, Math.min(0.999, (clientX - r.left) / r.width));
        const el = document.elementFromPoint(r.left + f * r.width, r.top + r.height / 2);
        const cell = el && el.closest("i[title]");
        if (!cell) { lab.hidden = true; return; }
        lab.textContent = cell.title; lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
      };
      cells.addEventListener("pointermove", (e) => show(e.clientX));
      cells.addEventListener("pointerdown", (e) => show(e.clientX));
      cells.addEventListener("pointerleave", () => { lab.hidden = true; });
    });
  }
  // Night as bands across a chart between x0 and x1 (ms), hour by hour.
  function nightBands(x0, x1, X) {
    const pt = W().state.point; if (!pt || pt.lat == null) return "";
    const out = []; let start = null;
    for (let x = x0; x <= x1 + 3600e3; x += 3600e3) {
      const n = x <= x1 && isNight(pt.lat, pt.lon, new Date(x));
      if (n && start == null) start = x;
      if (!n && start != null) { out.push(`<i class="nb" style="left:${X(start).toFixed(1)}%;width:${(X(Math.min(x, x1)) - X(start)).toFixed(1)}%"></i>`); start = null; }
    }
    return out.join("");
  }
  function wireWindProbe() {
    const area = $("#outdoors .wind-area");
    if (!area || area.dataset.wired) return;
    area.dataset.wired = "1";
    const rows = JSON.parse(area.dataset.rows), mx = +area.dataset.mx;
    const x0 = rows[0][0], x1 = rows[rows.length - 1][0];
    const dot = area.querySelector(".tdot.hov"), lab = area.querySelector(".tlab");
    const show = (clientX) => {
      const r = area.getBoundingClientRect(), f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const x = x0 + f * (x1 - x0);
      let a = rows[0], b = rows[rows.length - 1];
      for (let k = 0; k + 1 < rows.length; k++) if (x >= rows[k][0] && x <= rows[k + 1][0]) { a = rows[k]; b = rows[k + 1]; break; }
      const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
      const w = a[1] + (b[1] - a[1]) * t, g = a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * t : null;
      const near = t < 0.5 ? a : b;
      dot.style.left = `${(f * 100).toFixed(1)}%`; dot.style.top = `${(100 - w / mx * 92).toFixed(1)}%`; dot.hidden = false;
      lab.textContent = `${W().units.dateTime(new Date(x), { weekday: "short", hour: "numeric" })} · ${w.toFixed(0)}${g != null ? ` / ${g.toFixed(0)}` : ""} ${W().speedUnit()}${near[3] != null ? ` ${W().arrow(near[3])} ${compass(near[3])}` : ""}`;
      lab.style.left = `${(f * 100).toFixed(1)}%`; lab.classList.toggle("r", f > 0.6); lab.hidden = false;
    };
    const hide = () => { dot.hidden = true; lab.hidden = true; };
    area.addEventListener("pointermove", (e) => show(e.clientX));
    area.addEventListener("pointerdown", (e) => show(e.clientX));
    area.addEventListener("pointerleave", hide);
  }

  // ── Spread: how much the ensemble disagrees with itself ───────────────
  const SPREAD_VARS = [
    { key: "t2m", label: "Temp", color: "#ff9254" },
    { key: "wind", label: "Wind", color: "#4fc6b2" },
    { key: "tp6", label: "Rain", color: "#59a8ff" },
    { key: "msl", label: "Pressure", color: "#b69cff" },
  ];
  let spreadVar = localStorage.getItem("wxgrid.spreadVar") || "t2m";
  function renderSpread(pt, d, i) {
    const box = $("#spread-vars");
    box.innerHTML = SPREAD_VARS.map(({ key, label, color }) => `<button data-v="${key}" style="--spread-color:${color}" class="${key === spreadVar ? "on" : ""}">${label}</button>`).join("");
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
    const selected = SPREAD_VARS.find((v) => v.key === spreadVar) || SPREAD_VARS[0];
    window.WXEns && window.WXEns.drawPlume(c, pt.plume, { color: selected.color });
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
    const C = W().compare, cols = C.columns(t0);
    const fmt = (t) => new Date(t).toLocaleString(undefined, W().units.timeOpts({ weekday: "short", hour: "numeric" }));
    const head = cols.map((t) => `<th>${fmt(t)}</th>`).join("");
    const rowFor = (label, pick) => pt.cmp.order.map((k) => pt.cmp.rows[k]).filter(Boolean).map(({ model, data }) => {
      const cells = cols.map((t) => `<td>${pick(data, t)}</td>`).join("");
      // Each model's own resolution beside its name: the reason two rows differ
      // is usually that one of them resolves the terrain and the other does not.
      return `<tr><th scope="row" class="mdl" title="Run ${esc(data.run)}Z">${model.short}${model.grid ? `<i>${model.grid}</i>` : ""}</th>${cells}</tr>`;
    }).join("");
    const readings = Object.values(pt.cmp.rows).map(({ model, data }) => ({ model, v: C.value(data, "t2m", cols[0]) })).filter((r) => r.v != null).sort((a, b) => a.v - b.v);
    const low = readings[0], high = readings[readings.length - 1];
    const takeaway = readings.length > 1 ? `<div class="cmp-takeaway"><small>${esc(fmt(cols[0]))} · ${readings.length} models${pt.cmp.pending ? " · loading more" : ""}</small><b>${W().units.temp(low.v).v}–${W().units.temp(high.v).v} ${W().units.tempUnit}</b><span>${esc(low.model.short)} coolest · ${esc(high.model.short)} warmest</span></div>` : "";
    const display = (v, convert) => v == null ? "—" : convert(v);
    $("#compare").innerHTML = `${takeaway}<div class="cmp-scroll" tabindex="0" role="region" aria-label="Model comparison table"><table class="cmp"><thead><tr><th>Temp ${W().units.tempUnit}</th>${head}</tr></thead><tbody>${rowFor("t", (d, t) => display(C.value(d, "t2m", t), v => W().units.temp(v).v))}</tbody>
      <thead><tr><th>Wind ${speedUnit()}</th>${head}</tr></thead><tbody>${rowFor("w", (d, t) => display(C.value(d, "wind", t), v => Math.round(speed(v))))}</tbody>
      <thead><tr><th>Rain ${W().units.precipUnit}<small>following 12 h</small></th>${head}</tr></thead><tbody>${rowFor("r", (d, t) => display(C.rain(d, t, t + 12 * 3600e3), v => `<span class="r">${W().units.precip(v).v}</span>`))}</tbody></table></div>
      <div class="note">${pt.cmp.pending ? "Still loading… " : ""}Shared six-hour boundaries, starting at or after your selected time. Each model's latest run; rain totals cover the following 12 hours. A dash means incomplete coverage. Model range shows disagreement, not a probability or a confidence interval.</div>`;
  }

  // ── Resort: elevation-band forecast, whistlerpeak-style ───────────────
  function renderResort(pt, d, i) {
    const { speed, speedUnit, state, API, api } = W();
    const R = state.resort; if (!R) { $("#resort").innerHTML = ""; return; }
    const r = R.resort, base = R.elevation.base_m, summit = R.elevation.summit_m;
    const liftFeatures = (R.lifts && R.lifts.features) || [];
    const pisteFeatures = (R.pistes && R.pistes.features) || [];
    const lifts = liftFeatures.length, segments = pisteFeatures.length;
    const vertical = base != null && summit != null && summit > base ? summit - base : null;
    const namedLifts = [...new Set(liftFeatures.map((f) => f.properties && f.properties.name).filter(Boolean))];
    const liftTypes = {};
    liftFeatures.forEach((f) => { const kind = f.properties && f.properties.aerialway || "other"; liftTypes[kind] = (liftTypes[kind] || 0) + 1; });
    const fallbackGrade = { bucket: "unknown", label: "Unrated", color: "#9aa5b4", mark: "·", shape: "dot" };
    const fallbackScheme = ["CA", "US", "MX"].includes(String(r.country || "").toUpperCase()) ? "North American ratings" : "OSM difficulty";
    const scheme = W().pisteScheme ? W().pisteScheme(r.country) : { label: fallbackScheme, order: [fallbackGrade], grade: () => fallbackGrade };
    const grades = {};
    const grooming = {};
    pisteFeatures.forEach((f) => {
      const p = f.properties || {}, local = scheme.grade(p.grade), groom = p.grooming;
      grades[local.bucket] = (grades[local.bucket] || 0) + 1;
      if (groom) { const key = groom === "no" || groom === "backcountry" ? "ungroomed" : groom; grooming[key] = (grooming[key] || 0) + 1; }
    });
    const gradeMark = (shape, color, mark) => {
      if (shape === "circle") return `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="${color}"/></svg>`;
      if (shape === "square") return `<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1" fill="${color}"/></svg>`;
      if (shape === "diamond") return `<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="${color}" stroke="#eef1f5" stroke-width="1"/></svg>`;
      if (shape === "double") return `<svg class="double" viewBox="0 0 20 14" aria-hidden="true"><path d="M5.5 1.5 10.5 7l-5 5.5L.5 7Z M14.5 1.5l5 5.5-5 5.5-5-5.5Z" fill="${color}" stroke="#eef1f5" stroke-width="1"/></svg>`;
      if (shape === "oval") return `<svg viewBox="0 0 18 14" aria-hidden="true"><ellipse cx="9" cy="7" rx="7" ry="4.5" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
      if (shape === "dash") return `<svg viewBox="0 0 18 14" aria-hidden="true"><path d="M2 7h14" stroke="${color}" stroke-width="2" stroke-dasharray="3 2"/></svg>`;
      return `<i style="color:${color}">${esc(mark)}</i>`;
    };
    const gradeBars = scheme.order.filter(({ bucket }) => grades[bucket]).map(({ bucket, label, color, mark, shape }) => {
      const n = grades[bucket], pct = segments ? n / segments * 100 : 0;
      return `<div class="resort-grade"><span>${gradeMark(shape, color, mark)}${esc(label)}</span><b>${n}</b><em><i style="width:${pct.toFixed(1)}%;background:${color};box-shadow:inset 0 0 0 1px rgba(238,241,245,.42)"></i></em></div>`;
    }).join("") || `<div class="note">No mapped difficulty tags.</div>`;
    const groomingName = { classic: "Machine-groomed", mogul: "Moguls", ungroomed: "Ungroomed", skating: "Skate", "classic+skating": "Classic + skate", "classic;skating": "Classic + skate", scooter: "Snowmobile", skicross: "Skicross" };
    const groomingPills = Object.entries(grooming).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `<span>${esc(groomingName[kind] || kind.replaceAll("_", " "))} <b>${n}</b></span>`).join("");
    const groomingTagged = Object.values(grooming).reduce((a, b) => a + b, 0);
    const liftWords = { chair_lift: ["chair", "chairs"], gondola: ["gondola", "gondolas"], magic_carpet: ["carpet", "carpets"], t_bar: ["T-bar", "T-bars"], platter: ["platter", "platters"], drag_lift: ["drag lift", "drag lifts"], rope_tow: ["rope tow", "rope tows"], station: ["station", "stations"], cable_car: ["cable car", "cable cars"], mixed_lift: ["mixed lift", "mixed lifts"], zip_line: ["zip line", "zip lines"] };
    const liftEntries = Object.entries(liftTypes).sort((a, b) => b[1] - a[1]);
    const liftTypeLine = liftEntries.slice(0, 4).map(([kind, n]) => { const words = liftWords[kind] || [kind.replaceAll("_", " "), `${kind.replaceAll("_", " ")}s`]; return `${n} ${esc(words[n === 1 ? 0 : 1])}`; }).join(" · ") + (liftEntries.length > 4 ? ` · +${liftEntries.length - 4} types` : "");
    const official = r.conditions_url || r.website;
    const camsUrl = r.cams_url || "";
    const mountainCams = Array.isArray(r.mountain_cams) ? r.mountain_cams.filter((c) => c && c.image).slice(0, 4) : [];
    const country = countryName(r.country);
    const place = [r.region, country].filter(Boolean).join(" · ");
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
        return `<tr><td class="name">${name}<small>${W().units.alt(z).txt}</small></td><td><b>${t == null ? "—" : W().units.temp(t).v + "°"}</b></td><td>${w == null ? "—" : `<i class="dirarrow" style="${W().arrowRot(dir)}"></i>${Math.round(speed(w))} ${speedUnit()}`}</td><td>${pty ? `<span class="pill ${pty}">${pty}</span>` : "<span class=dim>—</span>"}</td><td>${snow24 >= 0.5 ? `<span class="pill snow">${W().units.snow(snow24).txt}</span>` : rain24 >= 0.5 ? `<span class="pill rain">${W().units.precip(rain24).txt}</span>` : "<span class=dim>·</span>"}</td></tr>`;
      }).join("");
      const fl = p.freezing_level_m ? p.freezing_level_m[k] : null;
      const snow72 = (() => { let s3 = 0; const b = p.bands[p.bands.length - 1]; for (let q = k + 1; q < p.steps.length && p.steps[q] <= p.steps[k] + 72; q++) if (b.ptype[q] === "snow") s3 += (p.tp6 && p.tp6[q]) || 0; return s3; })();
      bandsHtml = `<div class="snowline"><span>freezing level <b>${fl != null ? W().units.alt(fl).txt : "—"}</b></span><span>peak snow 72 h <b>${W().units.snow(snow72).txt}</b></span></div>
        <table class="bands"><thead><tr><th>Band</th><th>Temp</th><th>Wind</th><th>Precip type</th><th>Next 24 h</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="board-head"><span>Morning / afternoon / night</span></div>${bandTable(p, P.bands.slice().reverse())}`;
    }
    const liftNames = namedLifts.slice(0, 6).map((name) => `<span>${esc(name)}</span>`).join("");
    const camCards = mountainCams.map((c, k) => `<button class="cam resort-cam" data-resort-cam="${k}" type="button" title="${esc(c.caption || c.name)}">
      <img src="${esc(c.image)}${c.image.includes("?") ? "&" : "?"}t=${camBust()}" alt="" loading="lazy">
      <span class="cam-name">${esc(c.name)}</span>
      <span class="cam-dist">${c.elevation_m != null ? W().units.alt(c.elevation_m).txt : esc(c.caption || "Live view")}</span>
    </button>`).join("");
    const camsHtml = camCards ? `<section class="cams resort-cams"><div class="cams-head"><small>Mountain cams</small>${camsUrl ? `<a href="${esc(camsUrl)}" target="_blank" rel="noopener">All cams ↗</a>` : ""}</div><div class="cams-strip">${camCards}</div></section>` : "";
    $("#resort").innerHTML = `<div class="resort-head"><div><span>${esc(place)}</span><small>Model forecast · OpenStreetMap</small></div><div class="resort-actions">${official ? `<a class="resort-live" href="${esc(official)}" target="_blank" rel="noopener">Live conditions ↗</a>` : ""}${camsUrl ? `<a class="resort-cams-link" href="${esc(camsUrl)}" target="_blank" rel="noopener">Cams ↗</a>` : ""}</div></div>
      <div class="resort-overview">
        <div><b>${vertical == null ? "—" : W().units.alt(vertical).txt}</b><span>vertical</span></div>
        <div><b>${base == null ? "—" : W().units.alt(base).txt}</b><span>base</span></div>
        <div><b>${summit == null ? "—" : W().units.alt(summit).txt}</b><span>summit</span></div>
        <div><b>${lifts}</b><span>lifts</span></div>
        <div><b>${segments}</b><span>run segments</span></div>
        <div><b>${groomingTagged}</b><span>groom tags</span></div>
      </div>
      <div class="resort-columns">
        <section><h4>Runs <small>${esc(scheme.label)}</small></h4>${gradeBars}</section>
        <section><h4>Lifts</h4><p class="resort-type">${liftTypeLine || "No lift types mapped."}</p><div class="resort-lift-list">${liftNames || `<span>No named lifts mapped</span>`}${namedLifts.length > 6 ? `<span class="more">+${namedLifts.length - 6} more</span>` : ""}</div></section>
      </div>
      <section class="resort-groom"><h4>Grooming</h4><div>${groomingPills || `<span>no grooming tags</span>`}</div></section>
      ${camsHtml}
      <h4 class="resort-forecast-title">Mountain forecast</h4>
      ${bandsHtml}`;
    $("#resort").querySelectorAll("[data-resort-cam]").forEach((b) => b.onclick = () => openCam(mountainCams[+b.dataset.resortCam]));
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

  window.WXPanes = { render, sunTimes, canSnow };
})();
