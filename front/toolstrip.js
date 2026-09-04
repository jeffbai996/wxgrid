// A short personal rail, with the complete inventory named in one list.
(function () {
  "use strict";
  const GROUPS = [
    ["Weather", ["radar", "sat", "obs", "aurora", "iso", "aod"]],
    ["Hazards", ["alerts", "storms", "thunder", "sigmet", "fires", "smoke", "aq", "quakes"]],
    ["Mountains", ["winter", "avy", "resorts"]],
    ["Analysis", ["particles", "barbs", "xsection", "route", "measure"]],
  ];
  let pins;
  try { pins = JSON.parse(localStorage.getItem("wxgrid.toolPins")); } catch (_) { /* use defaults */ }
  pins = new Set(Array.isArray(pins) ? pins : ["radar", "alerts", "obs", "particles"]);
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
      b.classList.toggle("on", on); b.hidden = !pins.has(key) && !on;
      b.setAttribute("aria-pressed", String(on));
    });
    more.hidden = false;
    more.setAttribute("aria-expanded", String(st.classList.contains("more-open")));
    more.setAttribute("aria-label", "All tools and pinned shortcuts");
    const top = st.getBoundingClientRect().top;
    const floor = innerHeight - document.querySelector("#timebar").getBoundingClientRect().height - 16;
    const candidates = [...st.querySelectorAll("button[data-for]")].filter(b => !b.hidden).reverse();
    while (st.getBoundingClientRect().bottom > floor && candidates.length) candidates.shift().hidden = true;
    pop.style.maxHeight = Math.max(120, floor - top) + "px";
    if (pop.dataset.built) {
      pop.querySelectorAll("[data-action]").forEach(b => b.setAttribute("aria-pressed", String(document.getElementById(b.dataset.action + "-toggle").classList.contains("on"))));
      pop.querySelectorAll("[data-pin]").forEach(b => {
        const pinned = pins.has(b.dataset.pin);
        b.setAttribute("aria-pressed", String(pinned)); b.textContent = pinned ? "★" : "☆";
      });
      return;
    }
    pop.dataset.built = "1";
    pop.setAttribute("aria-label", "All weather tools");
    pop.innerHTML = GROUPS.map(([label, keys]) => `<section class="tool-group"><h3>${label}</h3>${keys.map(key => {
      const original = st.querySelector(`[data-for="${key}-toggle"]`);
      if (!original) return "";
      const title = original.dataset.tip;
      return `<div class="tool-row"><button data-action="${key}" aria-pressed="${original.classList.contains("on")}">${original.innerHTML}<span>${title}</span></button><button data-pin="${key}" aria-label="Pin ${title}" aria-pressed="${pins.has(key)}" title="Pin to toolbar">${pins.has(key) ? "★" : "☆"}</button></div>`;
    }).join("")}</section>`).join("");
    pop.addEventListener("click", e => {
      const action = e.target.closest("[data-action]"), pin = e.target.closest("[data-pin]");
      if (action) document.getElementById(action.dataset.action + "-toggle").click();
      if (pin) {
        const key = pin.dataset.pin;
        if (pins.has(key)) pins.delete(key); else pins.add(key);
        localStorage.setItem("wxgrid.toolPins", JSON.stringify([...pins]));
      }
      fit();
    });
  }
  window.WX.toolstrip = { fit };
})();
