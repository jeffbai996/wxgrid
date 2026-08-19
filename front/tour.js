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
    { sel: "#layers", title: "Layers", text: "Wind, temperature, rain, snow, waves, air quality. Some have variants — rain over 6, 24 or 72 hours — and the picker for those sits next to the legend." },
    { sel: "#tstrip", title: "Overlays and tools", text: "Radar, satellite, warnings, wildfires, avalanche, cross-sections. Hover any icon for its name." },
    { sel: "#timebar", title: "The forecast tape", text: "Scrub with ← and →, space to animate, click any column to jump. The chevron folds it away." },
    { sel: "#strip-settings", title: "Make it yours", text: "Units, clock, theme and motion. Set °F and inches once and every number on screen follows." },
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
    const s = STEPS[i], t = document.querySelector(s.sel);
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
    addEventListener("resize", () => box && place());
    i = 0; place();
  }
  WX.tour = { start, done };
})();
