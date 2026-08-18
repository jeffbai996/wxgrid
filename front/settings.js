// Settings drawer: units, clock, map and motion. Everything here writes
// through WX.units (or state) and fires `wx-units`, which app.js listens for
// to repaint the legend, card, tape, probe and cross-section together.
(function () {
  "use strict";
  const WX = window.WX;
  const $ = (s) => document.querySelector(s);

  const GROUPS = [
    { title: "Units", rows: [
      { key: "temp", label: "Temperature", opts: [["c", "°C"], ["f", "°F"]] },
      { key: "wind", label: "Wind", opts: [["kmh", "km/h"], ["mph", "mph"], ["kt", "kt"], ["ms", "m/s"]] },
      { key: "precip", label: "Rain", opts: [["mm", "mm"], ["in", "in"]] },
      { key: "snow", label: "Snow", opts: [["cm", "cm"], ["in", "in"]] },
      { key: "dist", label: "Distance", opts: [["km", "km"], ["mi", "mi"], ["nm", "nm"]] },
      { key: "alt", label: "Altitude", opts: [["m", "m"], ["ft", "ft"]] },
      { key: "press", label: "Pressure", opts: [["hpa", "hPa"], ["inhg", "inHg"], ["mmhg", "mmHg"]] },
    ] },
    { title: "Time", rows: [
      { key: "clock", label: "Clock", opts: [["auto", "auto"], ["24", "24 h"], ["12", "12 h"]] },
      { key: "tz", label: "Zone", opts: [["local", "mine"], ["point", "the place"], ["utc", "UTC"]] },
    ] },
  ];

  const style = document.createElement("style");
  style.textContent = `
  #settings-scrim{position:absolute;inset:0;z-index:11;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);opacity:0;transition:opacity .18s}
  #settings-scrim.on{opacity:1}
  #settings{position:absolute;top:0;right:0;bottom:0;width:min(360px,100%);z-index:12;display:flex;flex-direction:column;
    background:var(--panel-solid);border-left:1px solid var(--line-strong);box-shadow:-20px 0 60px rgba(0,0,0,.5);
    transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);
    padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  #settings.on{transform:translateX(0)}
  #settings[hidden],#settings-scrim[hidden]{display:none}
  #settings .sh{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--line)}
  #settings .sh b{font:800 15px var(--font-display);letter-spacing:-.01em}
  #settings .sh .icon{margin-left:auto}
  #settings .sbody{flex:1;overflow-y:auto;padding:6px 14px 20px;overscroll-behavior:contain}
  #settings .grp{margin-top:14px}
  #settings .grp>h4{font:700 10px var(--font-display);letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin:0 0 8px 2px}
  #settings .row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  #settings .row>span{font:600 12.5px var(--font-display);color:var(--fg-2);flex:0 0 84px}
  #settings .seg{flex:1;display:flex;padding:2px;gap:2px}
  #settings .seg button{flex:1;border:0;background:transparent;color:var(--fg-2);padding:5px 4px;border-radius:7px;
    font:600 11.5px var(--font-display);cursor:pointer;white-space:nowrap}
  #settings .seg button.on{background:var(--accent);color:var(--accent-ink)}
  #settings .krow{display:flex;justify-content:space-between;gap:12px;font:500 12px var(--font-body);color:var(--fg-2);padding:4px 2px}
  #settings kbd{font:600 10.5px var(--font-mono);background:var(--bg-3,rgba(255,255,255,.08));border:1px solid var(--line);
    border-radius:5px;padding:1px 6px;color:var(--fg)}
  #settings .note{margin-top:12px}
  @media (max-width:820px){#settings{width:100%}}
  `;
  document.head.appendChild(style);

  function build() {
    if ($("#settings")) return;
    const scrim = document.createElement("div"); scrim.id = "settings-scrim"; scrim.hidden = true;
    const el = document.createElement("aside"); el.id = "settings"; el.hidden = true;
    el.innerHTML = `<div class="sh"><b>Settings</b><button class="icon" id="settings-close" title="Close">×</button></div>
      <div class="sbody">
        ${GROUPS.map((g) => `<div class="grp"><h4>${g.title}</h4>${g.rows.map((r) => `
          <div class="row"><span>${r.label}</span><div class="seg" data-key="${r.key}">
            ${r.opts.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join("")}
          </div></div>`).join("")}</div>`).join("")}
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
  }

  function open() { build(); const el = $("#settings"), s = $("#settings-scrim"); el.hidden = false; s.hidden = false; paint(); requestAnimationFrame(() => { el.classList.add("on"); s.classList.add("on"); }); }
  function close() { const el = $("#settings"), s = $("#settings-scrim"); if (!el) return; el.classList.remove("on"); s.classList.remove("on"); setTimeout(() => { el.hidden = true; s.hidden = true; }, 220); }
  document.addEventListener("wx-units", paint);
  WX.settings = { open, close, toggle: () => ($("#settings") && !$("#settings").hidden ? close() : open()) };
})();
