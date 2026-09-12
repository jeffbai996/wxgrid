// A short personal rail, with the complete inventory named in one list.
(function () {
  "use strict";
  const GROUPS = [
    ["Weather", ["radar", "sat", "obs", "aurora", "iso", "aod"]],
    ["Hazards", ["alerts", "storms", "thunder", "sigmet", "fires", "smoke", "aq", "quakes"]],
    ["Mountains", ["winter", "avy", "resorts"]],
    ["Analysis", ["particles", "barbs", "xsection", "route", "measure"]],
  ];
  // The rail shows as much of the inventory as the height allows, in the
  // strip's own order; whatever is switched on and the short core set are
  // never the ones trimmed. The full inventory lives in the flyout. No
  // per-user pinning (Jeff 2026-09-04: "drop the whole favorites/star
  // spiel"); the rail fills the room it has rather than stopping at the core
  // set (Jeff 2026-09-06: "when there's the vertical space, display more").
  const RAIL = new Set(["radar", "alerts", "obs", "particles"]);
  const BTN = "32px";
  try { localStorage.removeItem("wxgrid.toolPins"); } catch (_) { /* nothing stored */ }
  function fit() {
    const st = document.querySelector("#tstrip"), pop = document.querySelector("#strip-more-pop");
    if (!st || !pop || getComputedStyle(st).display === "none") return;
    const more = document.querySelector("#strip-more");
    pop.inert = !st.classList.contains("more-open");
    st.style.setProperty("--strip-btn", BTN);
    st.querySelectorAll(".sep").forEach(el => { el.hidden = true; });
    const keyOf = b => b.dataset.for.replace(/-toggle$/, "");
    st.querySelectorAll("button[data-for]").forEach(b => {
      const on = document.getElementById(b.dataset.for).classList.contains("on");
      b.classList.toggle("on", on); b.hidden = false;
      b.setAttribute("aria-pressed", String(on));
    });
    more.hidden = false;
    more.setAttribute("aria-expanded", String(st.classList.contains("more-open")));
    more.setAttribute("aria-label", "All weather tools");
    const top = st.getBoundingClientRect().top;
    const floor = innerHeight - document.querySelector("#timebar").getBoundingClientRect().height - 16;
    // Trim from the bottom until the strip clears the tape: the optional
    // extras go first, the core set only after them, what is on never.
    const all = [...st.querySelectorAll("button[data-for]")].reverse();
    const off = b => !b.classList.contains("on");
    const candidates = all.filter(b => off(b) && !RAIL.has(keyOf(b))).concat(all.filter(b => off(b) && RAIL.has(keyOf(b))));
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
