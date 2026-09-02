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
    el.innerHTML = `<div class="sh"><div><b>Settings</b></div><button class="icon" id="settings-close" type="button" title="Close" aria-label="Close settings">×</button></div>
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
        <div class="grp"><h4>Embed</h4>
          <textarea class="embed-code" id="embed-code" readonly spellcheck="false" aria-label="Embed code"></textarea>
          <div class="embed-row"><button type="button" id="embed-copy">Copy</button><span class="note">This view — model, layer, time, split — as an iframe. The frame shows the map, legend and clock; its wordmark opens the full app here.</span></div>
        </div>
        <p class="note">Units apply everywhere: the tape, the card, the legend, the cursor readout and the cross-section.</p>
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

  // The iframe snippet for the current view: same hash the permalink carries.
  function embedCode() {
    const src = `${location.origin}${location.pathname}?embed=1${location.hash}`;
    return `<iframe src="${src}" width="800" height="450" style="border:0;border-radius:12px" loading="lazy" allow="fullscreen" title="wxgrid"></iframe>`;
  }
  function open() { build(); const el = $("#settings"), s = $("#settings-scrim"); el.hidden = false; s.hidden = false; paint(); const code = $("#embed-code"); if (code) code.value = embedCode(); requestAnimationFrame(() => { el.classList.add("on"); s.classList.add("on"); }); }
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
