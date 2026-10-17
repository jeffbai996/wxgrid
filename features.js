// Nonessential feature modules. Keep them out of the parser/DCL path and out
// of the first weather-data request wave; they still load as plain scripts,
// remain individually editable, and are precached by sw.js for offline use.
(function () {
  "use strict";
  let started = false;
  const fallback = setTimeout(load, 5000);

  function load() {
    if (started) return;
    started = true;
    clearTimeout(fallback);
    document.querySelectorAll("script[data-lazy-src]").forEach((slot) => {
      const script = document.createElement("script");
      // Dynamic scripts default to async. Preserve the source order so every
      // feature sees the same WX namespace shape as the original script list.
      script.async = false;
      script.src = slot.dataset.lazySrc;
      slot.replaceWith(script);
    });
  }

  const ready = window.WX && window.WX.initialDataReady;
  if (ready && typeof ready.then === "function") ready.then(() => setTimeout(load, 250));
  else document.addEventListener("wx-initial-data", () => setTimeout(load, 250), { once: true });
})();
