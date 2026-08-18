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
      ["Cross-section from here", I.xs, () => { if (!WX.state.xsection) $("#xsection-toggle").click(); WX.xs.click(lngLat); }],
      ["Measure from here", I.ruler, () => { if (!WX.state.measure) $("#measure-toggle").click(); WX.ov.measureClick(lngLat); }],
      ["Save this place", I.star, () => { WX.search.toggleFav(lngLat.lat, lon, `${lngLat.lat.toFixed(2)}°, ${lon.toFixed(2)}°`); WX.fn.toast("Saved. Focus the search box to see your places.", 3000); }],
      ["Copy coordinates", I.copy, async () => { const t = `${lngLat.lat.toFixed(4)}, ${lon.toFixed(4)}`; try { await navigator.clipboard.writeText(t); WX.fn.toast("Copied " + t, 2500); } catch (e) { WX.fn.toast(t, 5000); } }],
      ["Centre the map here", I.centre, () => M().easeTo({ center: [lngLat.lng, lngLat.lat], duration: 500 })],
    ];
    el.innerHTML = `<div class="mm-head">${lngLat.lat.toFixed(3)}°, ${lon.toFixed(3)}°</div>` +
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
