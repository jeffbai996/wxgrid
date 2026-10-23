// Forecast evolution ("Changes" pane): what changed between successive runs of
// the same model at a selected location, aligned strictly by UTC valid time.
(function () {
  "use strict";

  const K = 273.15;
  const HOUR_MS = 3600e3;
  const MAX_GAP_MS = 6 * HOUR_MS;
  const MAX_RETAINED_RUNS = 4;
  const MAX_CACHE_ENTRIES = 48;

  const $ = (s) => (typeof document !== "undefined" ? document.querySelector(s) : null);
  const W = () => (typeof window !== "undefined" ? window.WX : null);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function parseRunMs(runId) {
    if (!runId || typeof runId !== "string") return NaN;
    const clean = runId.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(clean)) return Date.parse(clean + ":00:00Z");
    return Date.parse(clean);
  }

  function fmtRunShort(runId) {
    if (!runId || typeof runId !== "string") return "—";
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(runId);
    if (!m) return runId;
    return `${m[2]}-${m[3]} ${m[4]}Z`;
  }

  function fmtRunReadable(runId) {
    const ms = parseRunMs(runId);
    if (!Number.isFinite(ms)) return fmtRunShort(runId);
    const dt = new Date(ms);
    const monDay = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const hh = String(dt.getUTCHours()).padStart(2, "0");
    return `${monDay}, ${hh}Z`;
  }

  // Resolve concrete reference, baseline, and up to 4 retained runs from the
  // model's catalog entry. Never leave "latest" unresolved, and never silently
  // substitute a newer run when an explicitly requested run ID is absent.
  function selectRunSet(modelEntry, activeRunId, requestedBaselineId) {
    const runs = (modelEntry && Array.isArray(modelEntry.runs) ? modelEntry.runs : [])
      .map((r) => (typeof r === "string" ? { run: r } : r))
      .filter((r) => r && typeof r.run === "string" && r.run.length > 0);

    if (runs.length === 0) {
      return {
        status: "no-runs",
        model: modelEntry ? modelEntry.key : "",
        runs: [],
        refRun: null,
        baseRun: null,
        compareRuns: [],
      };
    }

    const explicitRef = activeRunId && activeRunId !== "latest" ? activeRunId : runs[0].run;
    const refIdx = runs.findIndex((r) => r.run === explicitRef);
    if (refIdx < 0) {
      return {
        status: "missing-run",
        missingRun: explicitRef,
        missingRole: "reference",
        model: modelEntry ? modelEntry.key : "",
        runs: runs.map((r) => r.run),
        refRun: null,
        baseRun: null,
        compareRuns: [],
      };
    }

    const refRun = runs[refIdx].run;
    if (runs.length === 1) {
      return {
        status: "single-run",
        model: modelEntry ? modelEntry.key : "",
        runs: [refRun],
        refRun,
        baseRun: null,
        compareRuns: [refRun],
      };
    }

    let baseRun = null;
    if (requestedBaselineId && requestedBaselineId !== refRun) {
      const baseIdx = runs.findIndex((r) => r.run === requestedBaselineId);
      if (baseIdx < 0) {
        return {
          status: "missing-run",
          missingRun: requestedBaselineId,
          missingRole: "baseline",
          model: modelEntry ? modelEntry.key : "",
          runs: runs.map((r) => r.run),
          refRun,
          baseRun: null,
          compareRuns: [refRun],
        };
      }
      baseRun = runs[baseIdx].run;
    } else {
      const defaultBase = runs[refIdx + 1] || runs[refIdx - 1];
      baseRun = defaultBase ? defaultBase.run : null;
    }

    if (!baseRun) {
      return {
        status: "single-run",
        model: modelEntry ? modelEntry.key : "",
        runs: runs.map((r) => r.run),
        refRun,
        baseRun: null,
        compareRuns: [refRun],
      };
    }

    // Build up to 4 retained runs: [refRun, baseRun, ...up to 2 other retained runs]
    const compareRuns = [refRun, baseRun];
    for (const r of runs) {
      if (compareRuns.length >= MAX_RETAINED_RUNS) break;
      if (!compareRuns.includes(r.run)) compareRuns.push(r.run);
    }

    const baselines = runs.map((r) => r.run).filter((id) => id !== refRun);

    return {
      status: "ok",
      model: modelEntry ? modelEntry.key : "",
      runs: runs.map((r) => r.run),
      refRun,
      baseRun,
      baselines,
      compareRuns,
    };
  }

  // Cache parsed UTC timestamps on each run payload so repeated lookups are O(1).
  function stamps(d) {
    if (!d || !Array.isArray(d.valid)) return [];
    if (!d._evoStamps || d._evoStampsSource !== d.valid) {
      d._evoStamps = d.valid.map((iso) => Date.parse(iso));
      d._evoStampsSource = d.valid;
    }
    return d._evoStamps;
  }

  function computeOverlap(refData, baseData, horizonHours = 72) {
    const refTs = stamps(refData).filter(Number.isFinite);
    const baseTs = stamps(baseData).filter(Number.isFinite);
    if (!refTs.length || !baseTs.length) {
      return { status: "no-overlap", reason: "One of the selected runs has no valid forecast timestamps." };
    }
    const refStart = refTs[0], refEnd = refTs[refTs.length - 1];
    const baseStart = baseTs[0], baseEnd = baseTs[baseTs.length - 1];
    const overlapStart = Math.max(refStart, baseStart);
    const overlapEnd = Math.min(refEnd, baseEnd);
    if (!(overlapEnd > overlapStart)) {
      return {
        status: "no-overlap",
        refRange: [refStart, refEnd],
        baseRange: [baseStart, baseEnd],
        reason: `Runs ${fmtRunShort(refData && refData.run)} and ${fmtRunShort(baseData && baseData.run)} do not share overlapping valid times.`,
      };
    }
    const totalOverlapHours = Math.round((overlapEnd - overlapStart) / HOUR_MS);
    const capHours = horizonHours === 168 ? 168 : 72;
    const windowEnd = Math.min(overlapEnd, overlapStart + capHours * HOUR_MS);
    const windowHours = Math.round((windowEnd - overlapStart) / HOUR_MS);
    return {
      status: "ok",
      overlapStart,
      overlapEnd,
      windowStart: overlapStart,
      windowEnd,
      totalOverlapHours,
      windowHours,
      canExtend7d: totalOverlapHours > 72,
    };
  }

  function binarySearchGe(arr, t) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] >= t) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  // Sample an instantaneous variable (t2m, wind, gust) at UTC timestamp tMs.
  // Preserves native samples, interpolates linearly only inside [ts[0], ts[last]]
  // when both bounding samples are non-null and separated by at most 6 hours.
  function sampleInstant(d, key, tMs) {
    const ts = stamps(d);
    const arr = d && d.series && d.series[key];
    if (!ts.length || !Array.isArray(arr) || tMs < ts[0] || tMs > ts[ts.length - 1]) return null;
    const hi = binarySearchGe(ts, tMs);
    if (hi < 0) return null;
    if (ts[hi] === tMs) {
      const v = arr[hi];
      return v != null && Number.isFinite(v) ? v : null;
    }
    const lo = hi - 1;
    if (lo < 0) return null;
    const a = arr[lo], b = arr[hi], span = ts[hi] - ts[lo];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || span <= 0 || span > MAX_GAP_MS) {
      return null;
    }
    return a + (b - a) * ((tMs - ts[lo]) / span);
  }

  function circularDeltaDeg(refDeg, baseDeg) {
    if (refDeg == null || baseDeg == null || !Number.isFinite(refDeg) || !Number.isFinite(baseDeg)) return null;
    const diff = ((refDeg - baseDeg) % 360 + 540) % 360 - 180;
    return diff === -180 ? 180 : diff;
  }

  function sampleDirection(d, tMs) {
    const ts = stamps(d);
    const arr = d && d.series && d.series.wdir;
    if (!ts.length || !Array.isArray(arr) || tMs < ts[0] || tMs > ts[ts.length - 1]) return null;
    const hi = binarySearchGe(ts, tMs);
    if (hi < 0) return null;
    if (ts[hi] === tMs) {
      const v = arr[hi];
      return v != null && Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
    }
    const lo = hi - 1;
    if (lo < 0) return null;
    const a = arr[lo], b = arr[hi], span = ts[hi] - ts[lo];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || span <= 0 || span > MAX_GAP_MS) {
      return null;
    }
    const delta = circularDeltaDeg(b, a);
    return (((a + delta * ((tMs - ts[lo]) / span)) % 360) + 360) % 360;
  }

  // Sum water-equivalent precipitation over the exact interval (startMs, endMs].
  // Both startMs and endMs must be stored valid timestamps in d.valid (0 <= a < b),
  // so the first stored sample (a = 0) only ever acts as the start boundary of
  // (ts[0], ts[1]], never as an unanchored bucket end. Never prorates or differences.
  function precipInterval(d, startMs, endMs) {
    const ts = stamps(d);
    const arr = d && d.series && d.series.tp6;
    if (!ts.length || !Array.isArray(arr) || !(endMs > startMs)) return null;
    const a = ts.indexOf(startMs);
    const b = ts.indexOf(endMs);
    if (a < 0 || b <= a) return null;
    let total = 0;
    for (let k = a + 1; k <= b; k++) {
      const v = arr[k];
      const span = ts[k] - ts[k - 1];
      if (v == null || !Number.isFinite(v) || span <= 0 || span > MAX_GAP_MS) return null;
      total += Math.max(0, v);
    }
    return total;
  }

  function buildInstantSeries(runsData, key, windowStartMs, windowEndMs) {
    const [ref, base] = runsData;
    const timeSet = new Set();
    for (const d of [ref, base]) {
      for (const t of stamps(d)) {
        if (t >= windowStartMs && t <= windowEndMs) timeSet.add(t);
      }
    }
    const times = [...timeSet].sort((a, b) => a - b);
    const points = times.map((t) => {
      const values = runsData.map((d) => sampleInstant(d, key, t));
      const refVal = values[0];
      const baseVal = values[1];
      const delta = refVal != null && baseVal != null ? refVal - baseVal : null;
      return { t, ref: refVal, base: baseVal, delta, values };
    });
    const comparableCount = points.filter((p) => p.delta != null).length;
    return { key, times, points, comparableCount };
  }

  // Choose a uniform precipitation interval cadence (3h or 6h, or 12h if needed)
  // so every bar on the chart compares identical start and end times and equal durations.
  function buildPrecipSeries(runsData, windowStartMs, windowEndMs, horizonHours = 72) {
    const [ref, base] = runsData;
    const refTs = stamps(ref).filter((t) => t >= windowStartMs && t <= windowEndMs);
    const baseTs = stamps(base).filter((t) => t >= windowStartMs && t <= windowEndMs);
    const baseSet = new Set(baseTs);
    const shared = refTs.filter((t) => baseSet.has(t)).sort((a, b) => a - b);

    if (shared.length < 2) {
      return { bucketHours: 6, buckets: [], completeCount: 0 };
    }

    // Check max native step spacing of ref and base inside the window
    const maxStepHrs = (ts) => {
      let m = 0;
      for (let i = 1; i < ts.length; i++) {
        const dh = Math.round((ts[i] - ts[i - 1]) / HOUR_MS);
        if (dh > m && dh <= 12) m = dh;
      }
      return m || 6;
    };
    const minCadence = Math.max(3, maxStepHrs(refTs), maxStepHrs(baseTs), horizonHours > 72 ? 6 : 3);
    const candidates = [3, 6, 12, 24].filter((h) => h >= minCadence);

    let chosenHours = candidates[0] || 6;
    let bestBuckets = [];

    for (const h of candidates) {
      const stepMs = h * HOUR_MS;
      // Align grid start to the first shared timestamp on the UTC synoptic cadence boundary
      const firstAligned = shared.find((t) => t % stepMs === 0) ?? shared[0];
      const buckets = [];
      for (let t = firstAligned; t + stepMs <= windowEndMs; t += stepMs) {
        const end = t + stepMs;
        const values = runsData.map((d) => precipInterval(d, t, end));
        const rVal = values[0], bVal = values[1];
        const delta = rVal != null && bVal != null ? rVal - bVal : null;
        buckets.push({ start: t, end, hours: h, ref: rVal, base: bVal, delta, values });
      }
      const complete = buckets.filter((b) => b.delta != null).length;
      if (complete > 0) {
        chosenHours = h;
        bestBuckets = buckets;
        break;
      }
    }

    const completeCount = bestBuckets.filter((b) => b.delta != null).length;
    return { bucketHours: chosenHours, buckets: bestBuckets, completeCount };
  }

  function dayKeyInZone(ms, timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone || undefined,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(ms));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch (_) {}
    return new Date(ms).toISOString().slice(0, 10);
  }

  function fmtWeekday(ms, timeZone, long = true) {
    try {
      return new Date(ms).toLocaleDateString("en-US", {
        weekday: long ? "long" : "short",
        timeZone: timeZone || undefined,
      });
    } catch (_) {
      return new Date(ms).toLocaleDateString("en-US", { weekday: long ? "long" : "short" });
    }
  }

  function fmtDayTime(ms, timeZone) {
    try {
      const dt = new Date(ms);
      const day = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: timeZone || undefined });
      const hr = dt.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timeZone || undefined,
      });
      return `${day} ${hr}`;
    } catch (_) {
      return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
    }
  }

  function fmtDayPart(ms, timeZone) {
    let hour = new Date(ms).getUTCHours();
    try {
      const hStr = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timeZone || undefined,
      }).format(new Date(ms));
      const parsed = Number(hStr);
      if (Number.isFinite(parsed)) hour = parsed % 24;
    } catch (_) {}
    const day = fmtWeekday(ms, timeZone, true);
    const hh = String(hour).padStart(2, "0") + ":00";
    if (hour >= 5 && hour < 12) return `${day} morning (${hh})`;
    if (hour >= 12 && hour < 17) return `${day} afternoon (${hh})`;
    if (hour >= 17 && hour < 22) return `${day} evening (${hh})`;
    return `${day} night (${hh})`;
  }

  // Group complete shared precipitation buckets into calendar days (in the
  // display timezone) so daily precipitation summaries compare identical
  // start/end boundaries and explicitly label partial vs full 24h windows.
  function buildDayPrecipWindows(runsData, windowStartMs, windowEndMs, timeZone) {
    const pSeries = buildPrecipSeries(runsData, windowStartMs, windowEndMs, 168);
    const completeBuckets = pSeries.buckets.filter((b) => b.delta != null);
    if (!completeBuckets.length) return [];

    const byDay = new Map();
    for (const b of completeBuckets) {
      const mid = Math.round((b.start + b.end) / 2);
      const key = dayKeyInZone(mid, timeZone);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(b);
    }

    const windows = [];
    for (const [key, list] of byDay.entries()) {
      // Require contiguous buckets inside the day group
      let contiguous = true;
      for (let i = 1; i < list.length; i++) {
        if (list[i].start !== list[i - 1].end) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) continue;
      const start = list[0].start;
      const end = list[list.length - 1].end;
      const hours = Math.round((end - start) / HOUR_MS);
      if (hours < 12) continue;
      const mid = Math.round((start + end) / 2);
      const weekday = fmtWeekday(mid, timeZone, true);
      const fullDay = hours >= 24;
      const label = fullDay ? `${weekday}’s` : `${weekday} (${hours} h window)`;
      const shortLabel = fullDay ? weekday : `${fmtWeekday(mid, timeZone, false)} (${hours} h)`;
      const values = runsData.map((d) => precipInterval(d, start, end));
      const peakBucket = list.reduce((best, b) => (Math.abs(b.delta || 0) > Math.abs(best.delta || 0) ? b : best), list[0]);
      windows.push({
        key,
        start,
        end,
        hours,
        fullDay,
        label,
        shortLabel,
        ref: values[0],
        base: values[1],
        delta: values[0] != null && values[1] != null ? values[0] - values[1] : null,
        values,
        focusMs: peakBucket ? peakBucket.end : end,
      });
    }

    // If no calendar day had >=12h (e.g. a very short overlap), still evaluate the complete shared span
    if (!windows.length && completeBuckets.length >= 2) {
      let endIdx = 0;
      while (endIdx + 1 < completeBuckets.length && completeBuckets[endIdx + 1].start === completeBuckets[endIdx].end) {
        endIdx++;
      }
      const start = completeBuckets[0].start;
      const end = completeBuckets[endIdx].end;
      const hours = Math.round((end - start) / HOUR_MS);
      if (hours >= 6) {
        const values = runsData.map((d) => precipInterval(d, start, end));
        windows.push({
          key: "shared",
          start,
          end,
          hours,
          fullDay: hours === 24,
          label: `Next ${hours} h`,
          shortLabel: `${hours} h window`,
          ref: values[0],
          base: values[1],
          delta: values[0] != null && values[1] != null ? values[0] - values[1] : null,
          values,
          focusMs: end,
        });
      }
    }

    return windows;
  }

  function normTempDelta(units, dc) {
    const raw = units && units.tempDelta ? units.tempDelta(dc) : dc;
    if (raw && typeof raw === "object" && "v" in raw) {
      return { v: Number(raw.v), unit: raw.unit || (units && units.tempUnit) || "°C" };
    }
    return { v: Math.round(Number(raw) * 10) / 10, unit: (units && units.tempUnit) || "°C" };
  }

  function defaultUnits() {
    const wx = W();
    if (wx && wx.units) {
      const tz =
        (wx.units.timeOpts && wx.units.timeOpts({}).timeZone) ||
        wx.units.zone ||
        wx.units.pointZone ||
        null;
      return {
        tempUnit: wx.units.tempUnit || "°C",
        precipUnit: wx.units.precipUnit || "mm",
        zone: tz,
        temp: (k) => wx.units.temp(k),
        tempC: (c) => wx.units.tempC(c),
        tempDelta: (dc) => normTempDelta({ tempDelta: (x) => wx.units.tempDelta(x), tempUnit: wx.units.tempUnit || "°C" }, dc),
        precip: (mm) => wx.units.precip(mm),
        speed: (ms) => (wx.speed ? wx.speed(ms) : ms * 3.6),
        speedUnit: () => (wx.speedUnit ? wx.speedUnit() : "km/h"),
      };
    }
    return {
      tempUnit: "°C",
      precipUnit: "mm",
      zone: "UTC",
      temp: (k) => ({ v: Math.round(k - K), unit: "°C", txt: `${Math.round(k - K)}°C` }),
      tempC: (c) => ({ v: Math.round(c), unit: "°C", txt: `${Math.round(c)}°C` }),
      tempDelta: (dc) => ({ v: Math.round(dc * 10) / 10, unit: "°C" }),
      precip: (mm) => ({ v: Number(mm.toFixed(1)), unit: "mm", txt: `${mm.toFixed(1)} mm` }),
      speed: (ms) => ms * 3.6,
      speedUnit: () => "km/h",
    };
  }

  function fmtSigned(val, unit, decimals = 1) {
    const n = Number(val);
    const mag = decimals === 0 ? String(Math.round(Math.abs(n))) : Math.abs(n).toFixed(decimals).replace(/\.0$/, "");
    const sign = n > 0 ? "+" : n < 0 ? "−" : "";
    return `${sign}${mag}${unit.startsWith("°") ? unit : " " + unit}`;
  }

  function buildSummaries(comparison, units = defaultUnits()) {
    const {
      runsData,
      tempSeries,
      windSeries,
      gustSeries,
      precipSeries,
      dayPrecipWindows,
      hasSharedGust,
    } = comparison;
    const tz = units.zone;
    const candidates = [];

    // 1. Largest meaningful temperature revision (|deltaC| >= 1.5°C)
    const tempPts = tempSeries.points.filter((p) => p.delta != null);
    let maxAbsTempC = 0;
    let bestTemp = null;
    for (const p of tempPts) {
      const absC = Math.abs(p.delta);
      if (absC > maxAbsTempC) {
        maxAbsTempC = absC;
        bestTemp = p;
      }
    }
    if (bestTemp && maxAbsTempC >= 1.5) {
      const td = normTempDelta(units, bestTemp.delta);
      const absDeltaDisp = Math.abs(td.v).toFixed(1).replace(/\.0$/, "");
      const dirWord = bestTemp.delta > 0 ? "warmer" : "colder";
      const refT = units.temp(bestTemp.ref).v;
      const baseT = units.temp(bestTemp.base).v;
      const when = fmtDayPart(bestTemp.t, tz);
      candidates.push({
        kind: "temp",
        variable: "t2m",
        score: maxAbsTempC / 1.5,
        validMs: bestTemp.t,
        period: fmtDayTime(bestTemp.t, tz),
        badge: fmtSigned(td.v, td.unit, 1),
        tone: bestTemp.delta > 0 ? "warm" : "cool",
        text: `${when} is ${absDeltaDisp}${td.unit} ${dirWord} than the previous run (${refT}${units.tempUnit} vs ${baseT}${units.tempUnit}).`,
      });
    }

    // 2. Precipitation total revision over a shared day or window (|deltaMm| >= 2.0 mm)
    let maxAbsPrecipMm = null;
    let bestPrecipWin = null;
    for (const w of dayPrecipWindows) {
      if (w.delta == null) continue;
      const absMm = Math.abs(w.delta);
      if (maxAbsPrecipMm == null || absMm > maxAbsPrecipMm) {
        maxAbsPrecipMm = absMm;
        bestPrecipWin = w;
      }
    }
    if (bestPrecipWin && maxAbsPrecipMm >= 2.0) {
      const refP = units.precip(bestPrecipWin.ref);
      const baseP = units.precip(bestPrecipWin.base);
      const deltaP = units.precip(Math.abs(bestPrecipWin.delta));
      const dirWord = bestPrecipWin.delta > 0 ? "increased" : "decreased";
      const sign = bestPrecipWin.delta > 0 ? "+" : "−";
      const poss = bestPrecipWin.label.endsWith("’s") ? bestPrecipWin.label : `${bestPrecipWin.label}`;
      candidates.push({
        kind: "precip",
        variable: "tp6",
        score: maxAbsPrecipMm / 2.0 + 0.25,
        validMs: bestPrecipWin.focusMs,
        period: bestPrecipWin.shortLabel,
        badge: `${sign}${deltaP.txt}`,
        tone: "rain",
        text: `${poss} precipitation ${dirWord} from ${baseP.txt} to ${refP.txt} (${sign}${deltaP.txt}).`,
      });
    } else if (maxAbsPrecipMm == null && precipSeries.completeCount > 0) {
      maxAbsPrecipMm = Math.max(0, ...precipSeries.buckets.filter((b) => b.delta != null).map((b) => Math.abs(b.delta)));
    }

    // 3. Sustained wind peak revision, defensible peak timing shift, and optional gust peak
    const windPts = windSeries.points.filter((p) => p.delta != null);
    let maxAbsWindMs = 0;
    if (windPts.length) {
      for (const p of windPts) {
        if (Math.abs(p.delta) > maxAbsWindMs) maxAbsWindMs = Math.abs(p.delta);
      }
      const refPeakPt = windPts.reduce((best, p) => (p.ref > best.ref ? p : best), windPts[0]);
      const basePeakPt = windPts.reduce((best, p) => (p.base > best.base ? p : best), windPts[0]);
      const peakDeltaMs = refPeakPt.ref - basePeakPt.base;

      // Check for a defensible timing shift of the wind peak:
      // - Both runs have an actual peak >= 6.0 m/s
      // - Peaks are separated by at least one step cadence and at most 18 hours
      // - Not a flat plateau (ref's value at basePeakPt.t is > 0.5 m/s below refPeakPt.ref,
      //   and base's value at refPeakPt.t is > 0.5 m/s below basePeakPt.base)
      // - Neither peak is clamped against the very first or last sample of the window
      const firstT = windPts[0].t, lastT = windPts[windPts.length - 1].t;
      const shiftHrs = Math.round((refPeakPt.t - basePeakPt.t) / HOUR_MS);
      const notPlateau =
        refPeakPt.ref - refPeakPt.base > 0.5 &&
        basePeakPt.base - basePeakPt.ref > 0.5 &&
        Math.abs(refPeakPt.ref - basePeakPt.base) <= 6.0;
      const notAtBoundary =
        refPeakPt.t > firstT && refPeakPt.t < lastT && basePeakPt.t > firstT && basePeakPt.t < lastT;
      const timingShiftValid =
        refPeakPt.ref >= 6.0 &&
        basePeakPt.base >= 6.0 &&
        Math.abs(shiftHrs) >= 3 &&
        Math.abs(shiftHrs) <= 18 &&
        notPlateau &&
        notAtBoundary;

      // Optional gust peak comparison when both runs supply gusts
      let gustClause = "";
      let gustPeakDeltaMs = 0;
      if (hasSharedGust && gustSeries && gustSeries.points.length) {
        const gPts = gustSeries.points.filter((p) => p.delta != null);
        if (gPts.length) {
          const refGPeak = gPts.reduce((b, p) => (p.ref > b.ref ? p : b), gPts[0]);
          const baseGPeak = gPts.reduce((b, p) => (p.base > b.base ? p : b), gPts[0]);
          gustPeakDeltaMs = refGPeak.ref - baseGPeak.base;
          if (Math.abs(gustPeakDeltaMs) >= 2.5) {
            const rg = Math.round(units.speed(refGPeak.ref));
            const bg = Math.round(units.speed(baseGPeak.base));
            gustClause = ` (gusts ${rg} vs ${bg} ${units.speedUnit()})`;
          }
        }
      }

      if (Math.abs(peakDeltaMs) >= 2.0 || Math.abs(gustPeakDeltaMs) >= 3.0) {
        const refSpd = Math.round(units.speed(refPeakPt.ref));
        const baseSpd = Math.round(units.speed(basePeakPt.base));
        const dSpd = refSpd - baseSpd;
        const dirWord = peakDeltaMs >= 0 ? "increased" : "decreased";
        const when = fmtDayPart(refPeakPt.t, tz);
        candidates.push({
          kind: "wind",
          variable: "wind",
          score: Math.max(Math.abs(peakDeltaMs) / 2.0, Math.abs(gustPeakDeltaMs) / 3.0),
          validMs: refPeakPt.t,
          period: fmtDayTime(refPeakPt.t, tz),
          badge: fmtSigned(dSpd, units.speedUnit(), 0),
          tone: "wind",
          text: `Peak sustained wind on ${when} ${dirWord} from ${baseSpd} to ${refSpd} ${units.speedUnit()}${gustClause}.`,
        });
      } else if (timingShiftValid) {
        const refSpd = Math.round(units.speed(refPeakPt.ref));
        const shiftDir = shiftHrs > 0 ? "later" : "earlier";
        const when = fmtDayPart(refPeakPt.t, tz);
        candidates.push({
          kind: "wind",
          variable: "wind",
          score: 1.15 + Math.abs(shiftHrs) / 18,
          validMs: refPeakPt.t,
          period: fmtDayTime(refPeakPt.t, tz),
          badge: `${shiftHrs > 0 ? "+" : "−"}${Math.abs(shiftHrs)} h`,
          tone: "wind",
          text: `The strongest wind now occurs ${when} (${refSpd} ${units.speedUnit()}, ${Math.abs(shiftHrs)} h ${shiftDir} than the previous run)${gustClause}.`,
        });
      } else if (maxAbsWindMs >= 2.5) {
        const bestWindPt = windPts.reduce((b, p) => (Math.abs(p.delta) > Math.abs(b.delta) ? p : b), windPts[0]);
        const refSpd = Math.round(units.speed(bestWindPt.ref));
        const baseSpd = Math.round(units.speed(bestWindPt.base));
        const dSpd = refSpd - baseSpd;
        const dirWord = bestWindPt.delta > 0 ? "increased" : "decreased";
        candidates.push({
          kind: "wind",
          variable: "wind",
          score: maxAbsWindMs / 2.5,
          validMs: bestWindPt.t,
          period: fmtDayTime(bestWindPt.t, tz),
          badge: fmtSigned(dSpd, units.speedUnit(), 0),
          tone: "wind",
          text: `Sustained wind on ${fmtDayPart(bestWindPt.t, tz)} ${dirWord} from ${baseSpd} to ${refSpd} ${units.speedUnit()}${gustClause}.`,
        });
      }
    }

    // 4. Consistent multi-run revision trend across >= 3 comparable runs
    if (runsData.length >= 3) {
      let trendCandidate = null;
      // Check precipitation trend across shared day windows first (oldest -> newest)
      for (const w of dayPrecipWindows) {
        const vals = w.values.slice().reverse(); // oldest to newest
        if (vals.length >= 3 && vals.every((v) => v != null && Number.isFinite(v))) {
          const diffs = [];
          for (let i = 1; i < vals.length; i++) diffs.push(vals[i] - vals[i - 1]);
          const net = vals[vals.length - 1] - vals[0];
          const allUp = diffs.every((d) => d >= 0.5) && net >= 3.0;
          const allDown = diffs.every((d) => d <= -0.5) && net <= -3.0;
          if (allUp || allDown) {
            const firstP = units.precip(vals[0]).txt;
            const lastP = units.precip(vals[vals.length - 1]).txt;
            const dirWord = allUp ? "increased" : "decreased";
            const score = Math.abs(net) / 2.5 + 0.4;
            if (!trendCandidate || score > trendCandidate.score) {
              trendCandidate = {
                kind: "trend",
                variable: "tp6",
                score,
                validMs: w.focusMs,
                period: `${vals.length} runs · ${w.shortLabel}`,
                badge: `${ vals.map((v) => units.precip(v).v).join(" → ")} ${units.precipUnit}`,
                tone: "trend",
                text: `The last ${vals.length} runs have ${dirWord} ${w.label} precipitation (${firstP} → ${lastP}).`,
              };
            }
          }
        }
      }

      // If no precip trend, check temperature revision trend at comparable valid times
      if (!trendCandidate) {
        for (const p of tempPts) {
          const vals = p.values.slice().reverse(); // oldest to newest in Kelvin
          if (vals.length >= 3 && vals.every((v) => v != null && Number.isFinite(v))) {
            const diffs = [];
            for (let i = 1; i < vals.length; i++) diffs.push(vals[i] - vals[i - 1]);
            const netC = vals[vals.length - 1] - vals[0];
            const allWarm = diffs.every((d) => d >= 0.5) && netC >= 2.0;
            const allCold = diffs.every((d) => d <= -0.5) && netC <= -2.0;
            if (allWarm || allCold) {
              const firstT = units.temp(vals[0]).txt;
              const lastT = units.temp(vals[vals.length - 1]).txt;
              const dirWord = allWarm ? "warmer" : "colder";
              const score = Math.abs(netC) / 2.0 + 0.3;
              if (!trendCandidate || score > trendCandidate.score) {
                trendCandidate = {
                  kind: "trend",
                  variable: "t2m",
                  score,
                  validMs: p.t,
                  period: `${vals.length} runs · ${fmtDayTime(p.t, tz)}`,
                  badge: `${firstT} → ${lastT}`,
                  tone: "trend",
                  text: `The last ${vals.length} runs have trended ${dirWord} for ${fmtDayPart(p.t, tz)} (${firstT} → ${lastT}).`,
                };
              }
            }
          }
        }
      }

      if (trendCandidate) candidates.push(trendCandidate);
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates.slice(0, 3);
    }

    // Calm fallback when all changes are below thresholds
    const refRun = runsData[0] && runsData[0].run;
    const baseRun = runsData[1] && runsData[1].run;
    const tBound = normTempDelta(units, Math.max(0.1, maxAbsTempC));
    const wBound = Math.max(1, Math.round(units.speed(maxAbsWindMs)));
    const pClause =
      maxAbsPrecipMm != null
        ? `, and precipitation within ${units.precip(Math.max(0.1, maxAbsPrecipMm)).txt}`
        : "";
    const focusT = (tempPts[0] && tempPts[0].t) || comparison.windowStart;
    return [
      {
        kind: "calm",
        variable: "t2m",
        score: 0,
        validMs: focusT,
        period: `${fmtRunShort(baseRun)} → ${fmtRunShort(refRun)}`,
        badge: "Steady",
        tone: "calm",
        text: `Little change between ${fmtRunShort(baseRun)} and ${fmtRunShort(refRun)}: temperature within ${Math.abs(tBound.v).toFixed(1).replace(/\.0$/, "")}${tBound.unit}, sustained wind within ${wBound} ${units.speedUnit()}${pClause}.`,
      },
    ];
  }

  function compareRuns(runsData, opts = {}) {
    const validRuns = (runsData || []).filter(Boolean);
    if (validRuns.length < 2) {
      return {
        status: validRuns.length === 1 ? "single-run" : "no-runs",
        runsData: validRuns,
        summaries: [],
      };
    }
    const [ref, base] = validRuns;
    if (ref.available === false || base.available === false) {
      return {
        status: "outside-domain",
        reason: (ref.available === false ? ref.reason : base.reason) || "This point is outside the selected model's forecast domain.",
        runsData: validRuns,
        summaries: [],
      };
    }

    const horizonHours = opts.horizonHours === 168 ? 168 : 72;
    const overlap = computeOverlap(ref, base, horizonHours);
    if (overlap.status !== "ok") {
      return {
        status: overlap.status,
        reason: overlap.reason,
        overlap,
        runsData: validRuns,
        summaries: [],
      };
    }

    const units = opts.units || defaultUnits();
    const { windowStart, windowEnd } = overlap;
    const tempSeries = buildInstantSeries(validRuns, "t2m", windowStart, windowEnd);
    const windSeries = buildInstantSeries(validRuns, "wind", windowStart, windowEnd);
    const hasSharedGust = Boolean(
      ref.series && Array.isArray(ref.series.gust) && base.series && Array.isArray(base.series.gust)
    );
    const gustSeries = hasSharedGust ? buildInstantSeries(validRuns, "gust", windowStart, windowEnd) : null;
    const precipSeries = buildPrecipSeries(validRuns, windowStart, windowEnd, horizonHours);
    const dayPrecipWindows = buildDayPrecipWindows(validRuns, windowStart, windowEnd, units.zone);

    const missingVariables = [];
    if (tempSeries.comparableCount === 0) missingVariables.push("temperature");
    if (windSeries.comparableCount === 0) missingVariables.push("sustained wind");
    if (precipSeries.completeCount === 0) missingVariables.push("precipitation");

    const comparison = {
      status: "ok",
      runsData: validRuns,
      overlap,
      windowStart,
      windowEnd,
      horizonHours,
      tempSeries,
      windSeries,
      gustSeries,
      hasSharedGust,
      precipSeries,
      dayPrecipWindows,
      missingVariables,
    };
    comparison.summaries = buildSummaries(comparison, units);
    return comparison;
  }

  // Resolve a target UTC valid timestamp against a specific run's steps array.
  // Never reuses an array index from another run.
  function resolveStepForValidTime(runEntry, targetMs) {
    if (!runEntry || !Array.isArray(runEntry.steps) || !runEntry.steps.length || !Number.isFinite(targetMs)) {
      return 0;
    }
    const baseMs = runEntry.valid_from ? Date.parse(runEntry.valid_from) : parseRunMs(runEntry.run);
    if (!Number.isFinite(baseMs)) return 0;
    let bestIdx = 0;
    let bestErr = Infinity;
    for (let i = 0; i < runEntry.steps.length; i++) {
      const stepMs = baseMs + runEntry.steps[i] * HOUR_MS;
      const err = Math.abs(stepMs - targetMs);
      if (err < bestErr) {
        bestErr = err;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Controller managing point-run cache, request deduplication, race tokens,
  // and pruned-run catalog recovery.
  function createController(env = {}) {
    const cache = new Map();
    const inflight = new Map();
    let reqSeq = 0;
    let activeView = { status: "idle" };
    let selectedBaselineByModel = {};
    let selectedVariable = "t2m";
    let selectedHorizon = 72;

    const getState = env.getState || (() => (W() && W().state) || {});
    const getCatalog = env.getCatalog || (() => (W() && W().catalog) || { models: [] });
    const wlon = env.wlon || ((lon) => (W() && W().wlon ? W().wlon(lon) : lon));
    const fetchPoint =
      env.fetchPoint ||
      ((url) => {
        const wx = W();
        return wx.api(url);
      });
    const refreshCatalog =
      env.refreshCatalog ||
      (async () => {
        const wx = W();
        if (!wx || !wx.api) return null;
        const fresh = await wx.api(`${wx.API}/models?ts=${Date.now()}`, { cache: "no-store" });
        if (fresh && Array.isArray(fresh.models) && wx.catalog) {
          wx.catalog.models = fresh.models;
        }
        return fresh;
      });
    const onUpdate = env.onUpdate || (() => {});

    function cacheKey(model, run, lat, lon) {
      return `${model}:${run}:${Number(lat).toFixed(3)}:${Number(wlon(lon)).toFixed(3)}`;
    }

    function putCache(key, data) {
      if (cache.has(key)) cache.delete(key);
      cache.set(key, data);
      while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
    }

    function getRunPoint(model, run, lat, lon) {
      const key = cacheKey(model, run, lat, lon);
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      if (inflight.has(key)) return inflight.get(key);
      const apiBase = (W() && W().API) || "/api";
      const url = `${apiBase}/point?lat=${Number(lat).toFixed(3)}&lon=${Number(wlon(lon)).toFixed(3)}&model=${encodeURIComponent(model)}&run=${encodeURIComponent(run)}`;
      const p = new Promise((resolve, reject) => {
        try {
          Promise.resolve(fetchPoint(url)).then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      })
        .then((res) => {
          inflight.delete(key);
          if (res) putCache(key, res);
          return res;
        })
        .catch((err) => {
          inflight.delete(key);
          throw err;
        });
      inflight.set(key, p);
      return p;
    }

    async function loadPoint(pt, opts = {}) {
      const state = getState();
      const catalog = getCatalog();
      const targetPt = pt || state.point;
      if (!targetPt) return activeView;

      const lat = targetPt.lat;
      const lon = targetPt.lon;
      const modelKey = state.model;
      const modelEntry = (catalog.models || []).find((m) => m.key === modelKey) || {
        key: modelKey,
        short: String(modelKey || "").toUpperCase(),
        label: String(modelKey || "").toUpperCase(),
        runs: [],
      };

      // Snapshot catalog runs for this request so an incoming run cannot swap half the pair
      const snapshotModel = {
        ...modelEntry,
        runs: Array.isArray(modelEntry.runs) ? modelEntry.runs.map((r) => ({ ...r })) : [],
      };

      if (targetPt.outside) {
        activeView = {
          status: "outside-domain",
          model: snapshotModel,
          lat,
          lon,
          reason: targetPt.outside.reason || "This point is outside the selected model's forecast domain.",
        };
        onUpdate(activeView);
        return activeView;
      }

      // Seed cache with state.point.data if it already matches model + run + coords
      if (
        targetPt.data &&
        targetPt.data.available !== false &&
        targetPt.data.model === modelKey &&
        targetPt.data.run
      ) {
        putCache(cacheKey(modelKey, targetPt.data.run, lat, lon), targetPt.data);
      }

      const requestedBase =
        opts.baselineRun !== undefined ? opts.baselineRun : selectedBaselineByModel[modelKey] || null;
      const selection = selectRunSet(snapshotModel, state.run, requestedBase);

      if (selection.status !== "ok") {
        activeView = {
          ...selection,
          model: snapshotModel,
          lat,
          lon,
        };
        onUpdate(activeView);
        return activeView;
      }

      selectedBaselineByModel[modelKey] = selection.baseRun;
      const token = ++reqSeq;
      const sig = `${modelKey}:${selection.refRun}:${selection.baseRun}:${Number(lat).toFixed(3)}:${Number(wlon(lon)).toFixed(3)}`;

      // Check if reference + baseline are already in cache for immediate synchronous render
      const refKey = cacheKey(modelKey, selection.refRun, lat, lon);
      const baseKey = cacheKey(modelKey, selection.baseRun, lat, lon);
      if (!cache.has(refKey) || !cache.has(baseKey)) {
        activeView = {
          status: "loading",
          model: snapshotModel,
          selection,
          lat,
          lon,
        };
        onUpdate(activeView);
      }

      try {
        // Fetch reference and baseline first so the primary comparison renders immediately.
        // Additional older runs (3rd/4th) then load sequentially in the background without
        // blocking the primary chart or competing on disk I/O.
        const [refData, baseData] = await Promise.all([
          getRunPoint(modelKey, selection.refRun, lat, lon),
          getRunPoint(modelKey, selection.baseRun, lat, lon),
        ]);

        const isStale = () => {
          const curState = getState();
          const curPt = curState.point;
          const curSig = curPt
            ? `${curState.model}:${selection.refRun}:${selectedBaselineByModel[curState.model] || selection.baseRun}:${Number(curPt.lat).toFixed(3)}:${Number(wlon(curPt.lon)).toFixed(3)}`
            : "";
          return token !== reqSeq || curSig !== sig;
        };

        if (isStale()) return activeView;

        const olderRunIds = selection.compareRuns.slice(2);
        const olderByRunId = new Map();
        const uncachedOlderIds = [];
        for (const rId of olderRunIds) {
          const k = cacheKey(modelKey, rId, lat, lon);
          if (cache.has(k)) {
            const d = cache.get(k);
            if (d && d.available !== false) olderByRunId.set(rId, d);
          } else {
            uncachedOlderIds.push(rId);
          }
        }

        const publishComparison = (loadingOlder) => {
          const orderedOlder = olderRunIds.map((id) => olderByRunId.get(id)).filter(Boolean);
          const comparison = compareRuns([refData, baseData, ...orderedOlder], {
            horizonHours: selectedHorizon,
          });
          activeView = {
            ...comparison,
            loadingOlder: Boolean(loadingOlder),
            model: snapshotModel,
            selection,
            lat,
            lon,
          };
          onUpdate(activeView);
        };

        publishComparison(uncachedOlderIds.length > 0);

        for (let i = 0; i < uncachedOlderIds.length; i++) {
          const rId = uncachedOlderIds[i];
          const d = await getRunPoint(modelKey, rId, lat, lon).catch(() => null);
          if (isStale()) return activeView;
          if (d && d.available !== false) {
            olderByRunId.set(rId, d);
          }
          const moreRemaining = i < uncachedOlderIds.length - 1;
          if (d || !moreRemaining) {
            publishComparison(moreRemaining);
          }
        }

        return activeView;
      } catch (err) {
        const msg = String((err && err.message) || err || "");
        if (msg.includes("404")) {
          // A run was pruned between catalog discovery and the point request.
          // Refresh catalog state and explain the unavailable comparison without silent substitution.
          try {
            await refreshCatalog();
          } catch (_) {}
          const curState = getState();
          const curPt = curState.point;
          if (
            token !== reqSeq &&
            (!curPt ||
              Number(curPt.lat).toFixed(3) !== Number(lat).toFixed(3) ||
              Number(wlon(curPt.lon)).toFixed(3) !== Number(wlon(lon)).toFixed(3))
          ) {
            return activeView;
          }
          const updatedCatalog = getCatalog();
          const updatedModel =
            (updatedCatalog.models || []).find((m) => m.key === modelKey) || snapshotModel;
          const stillHasRef = (updatedModel.runs || []).some((r) => r.run === selection.refRun);
          const missingRun = !stillHasRef ? selection.refRun : selection.baseRun;
          if (selectedBaselineByModel[modelKey] === missingRun) {
            delete selectedBaselineByModel[modelKey];
          }
          activeView = {
            status: "pruned-run",
            missingRun,
            model: updatedModel,
            selection,
            lat,
            lon,
          };
          onUpdate(activeView);
          return activeView;
        }

        if (token === reqSeq) {
          activeView = {
            status: "error",
            model: snapshotModel,
            selection,
            lat,
            lon,
            reason: "Could not load the comparison forecast runs right now.",
          };
          onUpdate(activeView);
        }
        return activeView;
      }
    }

    return {
      loadPoint,
      getView: () => activeView,
      setBaseline: (modelKey, runId) => {
        selectedBaselineByModel[modelKey] = runId;
        const st = getState();
        if (st && st.point) return loadPoint(st.point, { baselineRun: runId });
        return Promise.resolve(activeView);
      },
      getVariable: () => selectedVariable,
      setVariable: (v) => {
        selectedVariable = v;
        onUpdate(activeView);
      },
      getHorizon: () => selectedHorizon,
      setHorizon: (h) => {
        selectedHorizon = h === 168 ? 168 : 72;
        if (activeView && activeView.status === "ok" && activeView.runsData) {
          const recomputed = compareRuns(activeView.runsData, { horizonHours: selectedHorizon });
          activeView = {
            ...activeView,
            ...recomputed,
          };
          onUpdate(activeView);
        }
      },
    };
  }

  // ── Browser UI & Interactive Chart Rendering ──────────────────────────
  const VAR_META = {
    t2m: { key: "t2m", label: "Temp", color: "#ffb454", lightColor: "#d97706" },
    wind: { key: "wind", label: "Wind", color: "#4fc6b2", lightColor: "#0d9488" },
    tp6: { key: "tp6", label: "Precip", color: "#6cb6ff", lightColor: "#1f74d8" },
  };

  let browserCtrl = null;
  let lastHoverIdx = null;

  function ensureBrowserCtrl() {
    if (!browserCtrl) {
      browserCtrl = createController({
        onUpdate: (view) => renderDom(view),
      });
    }
    return browserCtrl;
  }

  function jumpToValidTime(targetMs) {
    const wx = W();
    if (!wx || !Number.isFinite(targetMs)) return;
    const model = (wx.catalog && wx.catalog.models || []).find((m) => m.key === wx.state.model);
    if (!model || !model.runs.length) return;
    const mapRun = model.runs.find((r) => r.run === wx.state.run) || model.runs[0];
    const bestIdx = resolveStepForValidTime(mapRun, targetMs);
    if (wx.setStep) wx.setStep(bestIdx);
    setTimeout(() => {
      const on = $("#tape td.on");
      if (on && on.scrollIntoView) {
        on.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    }, 50);
    syncMapMarkerLine();
  }

  function fmtPeriodSpan(startMs, endMs, hours, tz) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "—";
    try {
      const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz || undefined };
      const s = new Date(startMs).toLocaleString("en-US", opts);
      const e = new Date(endMs).toLocaleString("en-US", opts);
      return `${s} – ${e} (${hours} h)`;
    } catch (_) {
      return `${new Date(startMs).toISOString().slice(5, 16)} – ${new Date(endMs).toISOString().slice(5, 16)} (${hours} h)`;
    }
  }

  function renderContextHeader(model, selection, view, units) {
    const wx = W();
    const mapRunId = wx && wx.state ? wx.state.run : selection && selection.refRun;
    const isLatestRef = model && model.runs && model.runs[0] && selection && selection.refRun === model.runs[0].run;
    const baselines = (selection && selection.baselines) || [];

    const baselineControls =
      baselines.length > 1
        ? `<div class="evo-baselines seg small" role="group" aria-label="Baseline run">${baselines
            .slice(0, 4)
            .map(
              (rId) =>
                `<button type="button" data-base-run="${esc(rId)}" class="${rId === selection.baseRun ? "on" : ""}" title="Compare against ${esc(fmtRunReadable(rId))} run">${esc(fmtRunShort(rId))}</button>`
            )
            .join("")}</div>`
        : baselines.length === 1
        ? `<span class="evo-run-pill base" title="Baseline run">${esc(fmtRunReadable(baselines[0]))}</span>`
        : "";

    const overlapText =
      view.status === "ok" && view.overlap
        ? fmtPeriodSpan(view.windowStart, view.windowEnd, view.overlap.windowHours, units.zone)
        : "";

    const mapDiffersFromRef = selection && selection.refRun && mapRunId && mapRunId !== selection.refRun;
    const mapRunSwitch =
      selection && selection.baseRun
        ? `<div class="evo-map-run">
            <span>Map run: <b>${esc(fmtRunShort(mapRunId))}</b>${mapRunId === (model.runs[0] && model.runs[0].run) ? " <i>latest</i>" : ""}</span>
            <div class="evo-map-actions">
              ${
                mapRunId !== selection.baseRun
                  ? `<button type="button" class="evo-map-btn" data-map-run="${esc(selection.baseRun)}">Show ${esc(fmtRunShort(selection.baseRun))} on map</button>`
                  : ""
              }
              ${
                mapDiffersFromRef
                  ? `<button type="button" class="evo-map-btn" data-map-run="${esc(selection.refRun)}">Show ${esc(fmtRunShort(selection.refRun))} on map</button>`
                  : ""
              }
            </div>
          </div>`
        : "";

    return `<div class="evo-context">
      <div class="evo-context-top">
        <span class="evo-model-badge"><b>${esc(model.short || model.key)}</b>${model.grid ? `<i>${esc(model.grid)}</i>` : ""}</span>
        ${
          selection && selection.refRun
            ? `<span class="evo-run-pill ref" title="Reference run">${esc(fmtRunReadable(selection.refRun))}${isLatestRef ? " <i>latest</i>" : ""}</span>
               <span class="evo-vs">vs</span>
               ${baselineControls}`
            : ""
        }
      </div>
      ${overlapText ? `<div class="evo-period">Shared forecast window: <b>${esc(overlapText)}</b></div>` : ""}
      ${mapRunSwitch}
    </div>`;
  }

  function renderDom(view) {
    const host = $("#changes");
    if (!host) return;
    const ctrl = ensureBrowserCtrl();
    const units = defaultUnits();
    const model = (view && view.model) || { key: "", short: "Model", runs: [] };
    const selection = view && view.selection;

    if (!view || view.status === "idle" || view.status === "loading") {
      host.innerHTML = `${selection ? renderContextHeader(model, selection, view || {}, units) : ""}
        <div class="evo-empty note">Loading retained ${esc(model.short || model.key)} runs for this location…</div>`;
      wireHeaderControls(host, ctrl);
      return;
    }

    if (view.status === "outside-domain") {
      host.innerHTML = `<div class="evo-context"><div class="evo-context-top"><span class="evo-model-badge"><b>${esc(model.short || model.key)}</b>${model.grid ? `<i>${esc(model.grid)}</i>` : ""}</span></div></div>
        <div class="evo-empty note">${esc(view.reason || "This point is outside the selected model's forecast domain.")}</div>`;
      return;
    }

    if (view.status === "no-runs") {
      host.innerHTML = `<div class="evo-context"><div class="evo-context-top"><span class="evo-model-badge"><b>${esc(model.short || model.key)}</b>${model.grid ? `<i>${esc(model.grid)}</i>` : ""}</span></div></div>
        <div class="evo-empty note">No complete ${esc(model.short || model.key)} runs are in the store right now.</div>`;
      return;
    }

    if (view.status === "single-run") {
      const onlyRun = (view.runs && view.runs[0]) || (model.runs[0] && model.runs[0].run) || "—";
      host.innerHTML = `<div class="evo-context"><div class="evo-context-top">
          <span class="evo-model-badge"><b>${esc(model.short || model.key)}</b>${model.grid ? `<i>${esc(model.grid)}</i>` : ""}</span>
          <span class="evo-run-pill ref">${esc(fmtRunReadable(onlyRun))} <i>only retained run</i></span>
        </div></div>
        <div class="evo-empty note">Only one complete ${esc(model.short || model.key)} run (${esc(fmtRunReadable(onlyRun))}) is retained right now. A second run is required to compare run-to-run revisions.</div>`;
      return;
    }

    if (view.status === "missing-run" || view.status === "pruned-run") {
      const remaining = (model.runs || []).map((r) => (typeof r === "string" ? r : r.run)).filter(Boolean);
      const buttons = remaining
        .filter((rId) => !selection || rId !== selection.refRun)
        .map(
          (rId) =>
            `<button type="button" class="chip" data-base-run="${esc(rId)}">Compare with ${esc(fmtRunReadable(rId))}</button>`
        )
        .join("");
      host.innerHTML = `<div class="evo-context"><div class="evo-context-top">
          <span class="evo-model-badge"><b>${esc(model.short || model.key)}</b>${model.grid ? `<i>${esc(model.grid)}</i>` : ""}</span>
        </div></div>
        <div class="evo-empty note">Run <b>${esc(fmtRunReadable(view.missingRun))}</b> is no longer in the store (retired when a newer forecast arrived). ${
          buttons ? "Pick an available retained run below:" : "Only one complete run remains in the store."
        }</div>
        ${buttons ? `<div class="evo-recover-actions">${buttons}</div>` : ""}`;
      wireHeaderControls(host, ctrl);
      return;
    }

    if (view.status === "no-overlap") {
      host.innerHTML = `${renderContextHeader(model, selection, view, units)}
        <div class="evo-empty note">${esc(view.reason || "The selected runs do not share overlapping valid times.")}</div>`;
      wireHeaderControls(host, ctrl);
      return;
    }

    if (view.status !== "ok") {
      host.innerHTML = `${selection ? renderContextHeader(model, selection, view, units) : ""}
        <div class="evo-empty note">${esc(view.reason || "Comparison unavailable for this point.")}</div>`;
      wireHeaderControls(host, ctrl);
      return;
    }

    const curVar = ctrl.getVariable();
    const curHorizon = ctrl.getHorizon();
    view.dayPrecipWindows = buildDayPrecipWindows(view.runsData, view.windowStart, view.windowEnd, units.zone);
    view.summaries = buildSummaries(view, units);
    const summariesHtml = (view.summaries || [])
      .map(
        (s, idx) => `<button type="button" class="evo-sum ${esc(s.tone || "")}" data-sum-idx="${idx}" data-valid-ms="${s.validMs}" data-var="${esc(s.variable)}" title="Jump map and timeline to ${esc(s.period)}">
          <div class="evo-sum-head">
            <span class="evo-sum-when">${esc(s.period)}</span>
            <b class="evo-sum-badge">${esc(s.badge)}</b>
          </div>
          <div class="evo-sum-body">${esc(s.text)}</div>
        </button>`
      )
      .join("");

    const missingNote =
      view.missingVariables && view.missingVariables.length
        ? `<div class="evo-missing-note note">Unavailable in this comparison: ${esc(view.missingVariables.join(", "))}.</div>`
        : "";

    const varButtons = Object.values(VAR_META)
      .map(({ key, label }) => {
        const unitLabel =
          key === "t2m"
            ? units.tempUnit
            : key === "wind"
            ? units.speedUnit()
            : `${units.precipUnit}/${view.precipSeries.bucketHours}h`;
        return `<button type="button" data-evo-var="${key}" class="${key === curVar ? "on" : ""}">${label} <small>${esc(unitLabel)}</small></button>`;
      })
      .join("");

    const horizonControl = view.overlap.canExtend7d
      ? `<div class="evo-horizon seg small" role="group" aria-label="Comparison horizon">
          <button type="button" data-evo-horizon="72" class="${curHorizon === 72 ? "on" : ""}">72 h</button>
          <button type="button" data-evo-horizon="168" class="${curHorizon === 168 ? "on" : ""}">${
            view.overlap.totalOverlapHours >= 168 ? "7 d" : `${view.overlap.totalOverlapHours} h`
          }</button>
        </div>`
      : "";

    const legendItems = view.runsData
      .map((d, idx) => {
        const role = idx === 0 ? "ref" : idx === 1 ? "base" : `old-${idx - 1}`;
        const tag = idx === 0 ? "ref" : idx === 1 ? "base" : `−${idx}`;
        return `<span class="evo-leg-item ${role}"><i class="sw"></i><b>${esc(fmtRunShort(d.run))}</b><small>${tag}</small></span>`;
      })
      .join("");
    const gustLegend =
      curVar === "wind" && view.hasSharedGust
        ? `<span class="evo-leg-item gust"><i class="sw"></i><small>gusts</small></span>`
        : "";

    host.innerHTML = `${renderContextHeader(model, selection, view, units)}
      <div class="evo-summaries" role="list" aria-label="Forecast change summaries">${summariesHtml}</div>
      ${missingNote}
      <div class="evo-chart-card">
        <div class="evo-chart-bar">
          <div class="evo-vars seg small" role="tablist" aria-label="Comparison variable">${varButtons}</div>
          ${horizonControl}
        </div>
        <div class="evo-legend">${legendItems}${gustLegend}</div>
        <div class="evo-canvas-wrap">
          <canvas id="evo-canvas" width="640" height="176" aria-label="Forecast run comparison chart"></canvas>
          <div id="evo-tip" class="gtip evo-tip" hidden></div>
        </div>
      </div>
      <details class="evo-details">
        <summary class="note">Aligned by UTC valid time · Δ is ${esc(fmtRunShort(selection.refRun))} minus ${esc(fmtRunShort(selection.baseRun))} · click chart or summary to jump</summary>
        <div class="evo-details-body note">
          Comparisons match predictions for the same UTC valid timestamp across ${view.runsData.length} retained ${esc(model.short || model.key)} runs. Temperature and wind use native steps with bounded interpolation (≤ 6 h). Precipitation bars sum complete ${view.precipSeries.bucketHours}-hour water-equivalent intervals over identical start and end times without prorating partial buckets.
        </div>
      </details>`;

    wireHeaderControls(host, ctrl);

    host.querySelectorAll(".evo-sum").forEach((btn) => {
      btn.onclick = () => {
        const vKey = btn.dataset.var;
        const targetMs = Number(btn.dataset.validMs);
        if (vKey && VAR_META[vKey] && vKey !== ctrl.getVariable()) {
          ctrl.setVariable(vKey);
        }
        if (Number.isFinite(targetMs)) jumpToValidTime(targetMs);
      };
    });

    host.querySelectorAll("[data-evo-var]").forEach((btn) => {
      btn.onclick = () => ctrl.setVariable(btn.dataset.evoVar);
    });

    host.querySelectorAll("[data-evo-horizon]").forEach((btn) => {
      btn.onclick = () => ctrl.setHorizon(Number(btn.dataset.evoHorizon));
    });

    drawChart(view, curVar, units);
  }

  function wireHeaderControls(host, ctrl) {
    const wx = W();
    host.querySelectorAll("[data-base-run]").forEach((btn) => {
      btn.onclick = () => {
        const modelKey = wx && wx.state ? wx.state.model : "";
        ctrl.setBaseline(modelKey, btn.dataset.baseRun);
      };
    });
    host.querySelectorAll("[data-map-run]").forEach((btn) => {
      btn.onclick = () => {
        const targetRun = btn.dataset.mapRun;
        const sel = $("#rail-run");
        if (sel && targetRun) {
          sel.value = targetRun;
          if (typeof sel.onchange === "function") sel.onchange();
        }
      };
    });
  }

  function drawChart(view, varKey, units, hoverIdx = null) {
    const canvas = $("#evo-canvas");
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const cssW = Math.max(280, Math.round((wrap && wrap.clientWidth) || 420));
    const cssH = 176;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const isLight =
      typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
    const meta = VAR_META[varKey] || VAR_META.t2m;
    const refColor = isLight ? meta.lightColor : meta.color;
    const baseColor = isLight ? "#3a4250" : "#c8d0dc";
    const oldColors = isLight ? ["#788292", "#9aa3b2"] : ["#7f8a9c", "#5e6878"];
    const gridColor = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.08)";
    const textDim = isLight ? "#6b7482" : "#7c8492";
    const textFg = isLight ? "#141821" : "#eef1f5";
    const accentColor = isLight ? "#e8651f" : "#ff8a3d";

    const padL = 38, padR = 12, padT = 14, padB = 24;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const t0 = view.windowStart;
    const t1 = view.windowEnd;
    const spanMs = Math.max(HOUR_MS, t1 - t0);
    const xOf = (ms) => padL + ((ms - t0) / spanMs) * plotW;

    // Day boundary vertical lines & weekday labels
    ctx.font = "600 10px 'Urbanist', 'Inter', system-ui, sans-serif";
    ctx.textAlign = "left";
    let lastDayKey = dayKeyInZone(t0, units.zone);
    const stepCheckMs = HOUR_MS;
    for (let t = Math.ceil(t0 / stepCheckMs) * stepCheckMs; t <= t1; t += stepCheckMs) {
      const dk = dayKeyInZone(t, units.zone);
      if (dk !== lastDayKey) {
        lastDayKey = dk;
        const x = xOf(t);
        if (x >= padL + 4 && x <= cssW - padR - 22) {
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          ctx.fillStyle = textDim;
          ctx.fillText(fmtWeekday(t + 2 * HOUR_MS, units.zone, false), x + 4, cssH - 7);
        }
      }
    }

    // Selected map valid-time vertical marker
    const wx = W();
    if (wx && wx.state) {
      const model = (wx.catalog && wx.catalog.models || []).find((m) => m.key === wx.state.model);
      const mapRun = model && (model.runs.find((r) => r.run === wx.state.run) || model.runs[0]);
      if (mapRun && Array.isArray(mapRun.steps)) {
        const idx = Math.min(wx.state.stepIdx || 0, mapRun.steps.length - 1);
        const rMs = mapRun.valid_from ? Date.parse(mapRun.valid_from) : parseRunMs(mapRun.run);
        const mapValidMs = rMs + mapRun.steps[idx] * HOUR_MS;
        if (mapValidMs >= t0 && mapValidMs <= t1) {
          const mx = xOf(mapValidMs);
          ctx.strokeStyle = accentColor;
          ctx.lineWidth = 1.25;
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.moveTo(mx, padT);
          ctx.lineTo(mx, padT + plotH);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    if (varKey === "tp6") {
      drawPrecipBars(ctx, view, units, {
        padL, padR, padT, padB, plotW, plotH, cssW, cssH, xOf,
        refColor, baseColor, oldColors, gridColor, textDim, textFg, isLight, hoverIdx,
      });
    } else {
      drawInstantCurves(ctx, view, varKey, units, {
        padL, padR, padT, padB, plotW, plotH, cssW, cssH, xOf,
        refColor, baseColor, oldColors, gridColor, textDim, textFg, isLight, hoverIdx,
      });
    }

    ctx.restore();
    wireCanvasInteraction(canvas, view, varKey, units, { padL, padR, plotW, cssW, t0, t1 });
  }

  function drawInstantCurves(ctx, view, varKey, units, geom) {
    const {
      padL, padT, plotW, plotH, cssW, xOf,
      refColor, baseColor, oldColors, gridColor, textDim, isLight, hoverIdx,
    } = geom;
    const series = varKey === "wind" ? view.windSeries : view.tempSeries;
    const gustSeries = varKey === "wind" && view.hasSharedGust ? view.gustSeries : null;
    const convert =
      varKey === "wind"
        ? (v) => (v == null ? null : units.speed(v))
        : (v) => (v == null ? null : units.temp(v).v);

    const allVals = [];
    for (const p of series.points) {
      for (const raw of p.values) {
        const cv = convert(raw);
        if (cv != null && Number.isFinite(cv)) allVals.push(cv);
      }
    }
    if (gustSeries) {
      for (const p of gustSeries.points) {
        for (const raw of p.values.slice(0, 2)) {
          const cv = convert(raw);
          if (cv != null && Number.isFinite(cv)) allVals.push(cv);
        }
      }
    }

    if (!allVals.length) {
      ctx.fillStyle = textDim;
      ctx.font = "500 12px 'DM Sans', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Variable unavailable in the selected runs", padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const step = varKey === "wind" ? 10 : units.tempUnit === "°F" ? 10 : 5;
    const lo = varKey === "wind" ? 0 : Math.floor((Math.min(...allVals) - 1) / step) * step;
    const hi = Math.max(lo + step, Math.ceil((Math.max(...allVals) + 1) / step) * step);
    const yOf = (v) => padT + plotH * (1 - (v - lo) / (hi - lo || 1));

    // Horizontal grid lines and y-axis labels
    ctx.font = "600 10px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = "right";
    for (let g = lo; g <= hi; g += step) {
      const y = yOf(g);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - geom.padR, y);
      ctx.stroke();
      ctx.fillStyle = textDim;
      ctx.fillText(varKey === "t2m" ? `${g}°` : `${g}`, padL - 5, y + 3.5);
    }

    // Difference shading between Reference (index 0) and Baseline (index 1)
    ctx.fillStyle = isLight ? "rgba(232,101,31,0.10)" : "rgba(255,180,84,0.11)";
    let seg = [];
    const flushFill = () => {
      if (seg.length < 2) { seg = []; return; }
      ctx.beginPath();
      seg.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.yRef) : ctx.lineTo(pt.x, pt.yRef)));
      for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i].x, seg[i].yBase);
      ctx.closePath();
      ctx.fill();
      seg = [];
    };
    for (const p of series.points) {
      const rv = convert(p.ref), bv = convert(p.base);
      if (rv != null && bv != null) {
        seg.push({ x: xOf(p.t), yRef: yOf(rv), yBase: yOf(bv) });
      } else {
        flushFill();
      }
    }
    flushFill();

    // Draw older runs (indices 2, 3) first so reference & baseline sit cleanly on top
    const strokeRun = (runIdx, ptsSource, dash, width, color, alpha) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      ctx.setLineDash(dash);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let penDown = false;
      let prevT = null;
      for (const p of ptsSource) {
        const v = convert(p.values[runIdx]);
        if (v == null || (prevT != null && p.t - prevT > MAX_GAP_MS)) {
          penDown = false;
        }
        if (v != null) {
          const x = xOf(p.t), y = yOf(v);
          if (!penDown) {
            ctx.moveTo(x, y);
            penDown = true;
          } else {
            ctx.lineTo(x, y);
          }
          prevT = p.t;
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    for (let rIdx = view.runsData.length - 1; rIdx >= 2; rIdx--) {
      strokeRun(
        rIdx,
        series.points,
        rIdx === 2 ? [2, 3] : [6, 3, 1.5, 3],
        1.25,
        oldColors[rIdx - 2] || oldColors[0],
        rIdx === 2 ? 0.65 : 0.5
      );
    }

    // Optional secondary gust curves for baseline and reference
    if (gustSeries) {
      strokeRun(1, gustSeries.points, [2, 3], 1.1, baseColor, 0.45);
      strokeRun(0, gustSeries.points, [3, 2.5], 1.35, refColor, 0.65);
    }

    // Baseline run (dashed, high-contrast secondary)
    strokeRun(1, series.points, [5, 3.5], 1.75, baseColor, 0.9);
    // Reference run (solid, prominent primary)
    strokeRun(0, series.points, [], 2.25, refColor, 1.0);

    // Hover crosshair and dots
    if (hoverIdx != null && series.points[hoverIdx]) {
      const hp = series.points[hoverIdx];
      const hx = xOf(hp.t);
      ctx.strokeStyle = isLight ? "rgba(20,24,33,0.35)" : "rgba(238,241,245,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();

      [1, 0].forEach((rIdx) => {
        const v = convert(hp.values[rIdx]);
        if (v == null) return;
        ctx.fillStyle = rIdx === 0 ? refColor : baseColor;
        ctx.beginPath();
        ctx.arc(hx, yOf(v), rIdx === 0 ? 4 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  function drawPrecipBars(ctx, view, units, geom) {
    const {
      padL, padT, plotW, plotH, cssW, xOf,
      refColor, baseColor, oldColors, gridColor, textDim, isLight, hoverIdx,
    } = geom;
    const buckets = view.precipSeries.buckets;
    if (!buckets.length) {
      ctx.fillStyle = textDim;
      ctx.font = "500 12px 'DM Sans', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No shared complete precipitation intervals in this window", padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const conv = (mm) => (mm == null ? null : units.precip(mm).v);
    const allVals = [];
    for (const b of buckets) {
      for (const v of b.values) {
        const cv = conv(v);
        if (cv != null && Number.isFinite(cv)) allVals.push(cv);
      }
    }
    const minTop = units.precipUnit === "in" ? 0.2 : 5;
    const hi = Math.max(minTop, Math.ceil(Math.max(0, ...allVals) * 1.15 * 10) / 10);
    const yOf = (v) => padT + plotH * (1 - v / (hi || 1));

    // Horizontal grid lines
    ctx.font = "600 10px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = "right";
    for (const frac of [0, 0.5, 1]) {
      const val = hi * frac;
      const y = yOf(val);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - geom.padR, y);
      ctx.stroke();
      ctx.fillStyle = textDim;
      ctx.fillText(units.precipUnit === "in" ? val.toFixed(2) : val.toFixed(0), padL - 5, y + 3.5);
    }

    buckets.forEach((b, idx) => {
      const x0 = Math.max(padL, xOf(b.start));
      const x1 = Math.min(cssW - geom.padR, xOf(b.end));
      const slotW = Math.max(4, x1 - x0 - 2);
      const pairW = Math.max(2, (slotW - 1) / 2);
      const baseX = x0 + 1;
      const refX = baseX + pairW + 1;
      const bottomY = padT + plotH;

      if (hoverIdx === idx) {
        ctx.fillStyle = isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)";
        ctx.fillRect(x0, padT, x1 - x0, plotH);
      }

      // Baseline bar (left)
      const bVal = conv(b.base);
      if (bVal != null) {
        const bh = Math.max(bVal > 0 ? 2 : 0, plotH * (bVal / hi));
        ctx.fillStyle = isLight ? "rgba(58,66,80,0.38)" : "rgba(180,187,198,0.38)";
        ctx.fillRect(baseX, bottomY - bh, pairW, bh);
        ctx.strokeStyle = baseColor;
        ctx.lineWidth = 1;
        if (bh > 0) ctx.strokeRect(baseX + 0.5, bottomY - bh + 0.5, Math.max(1, pairW - 1), Math.max(1, bh - 1));
      }

      // Reference bar (right)
      const rVal = conv(b.ref);
      if (rVal != null) {
        const rh = Math.max(rVal > 0 ? 2 : 0, plotH * (rVal / hi));
        ctx.fillStyle = refColor;
        ctx.fillRect(refX, bottomY - rh, pairW, rh);
      }

      // Older runs (3rd/4th) shown as quiet horizontal ticks across the slot
      for (let rIdx = 2; rIdx < b.values.length; rIdx++) {
        const ov = conv(b.values[rIdx]);
        if (ov != null && ov > 0) {
          const oy = yOf(ov);
          ctx.strokeStyle = oldColors[rIdx - 2] || oldColors[0];
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x0 + 1, oy);
          ctx.lineTo(x1 - 1, oy);
          ctx.stroke();
        }
      }
    });
  }

  function wireCanvasInteraction(canvas, view, varKey, units, geom) {
    const tip = $("#evo-tip");
    const { padL, plotW, cssW, t0, t1 } = geom;

    const indexFromClientX = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / (rect.width || 1)) * cssW;
      const clampedRatio = Math.max(0, Math.min(1, (x - padL) / (plotW || 1)));
      const targetMs = t0 + clampedRatio * (t1 - t0);

      if (varKey === "tp6") {
        const buckets = view.precipSeries.buckets;
        if (!buckets.length) return -1;
        const found = buckets.findIndex((b) => targetMs >= b.start && targetMs <= b.end);
        if (found >= 0) return found;
        let best = 0;
        buckets.forEach((b, i) => {
          const mid = (b.start + b.end) / 2;
          const bestMid = (buckets[best].start + buckets[best].end) / 2;
          if (Math.abs(mid - targetMs) < Math.abs(bestMid - targetMs)) best = i;
        });
        return best;
      }

      const pts = (varKey === "wind" ? view.windSeries : view.tempSeries).points;
      if (!pts.length) return -1;
      let best = 0;
      pts.forEach((p, i) => {
        if (Math.abs(p.t - targetMs) < Math.abs(pts[best].t - targetMs)) best = i;
      });
      return best;
    };

    const showTipAt = (idx, clientX) => {
      if (!tip || idx < 0) return;
      lastHoverIdx = idx;
      drawChart(view, varKey, units, idx);

      let whenLabel = "";
      let rowsHtml = "";
      let deltaHtml = "";

      if (varKey === "tp6") {
        const b = view.precipSeries.buckets[idx];
        if (!b) return;
        whenLabel = `${fmtDayTime(b.start, units.zone)} – ${fmtDayTime(b.end, units.zone)} (${b.hours} h)`;
        rowsHtml = view.runsData
          .map((d, rIdx) => {
            const val = b.values[rIdx];
            const txt = val == null ? "— (incomplete)" : units.precip(val).txt;
            return `<span><i>${esc(fmtRunShort(d.run))}</i><b>${esc(txt)}</b></span>`;
          })
          .join("");
        if (b.delta != null) {
          const dp = units.precip(Math.abs(b.delta));
          const sign = b.delta > 0 ? "+" : b.delta < 0 ? "−" : "";
          deltaHtml = `<span class="evo-tip-delta"><i>Δ</i><b>${sign}${esc(dp.txt)}</b></span>`;
        }
      } else {
        const series = varKey === "wind" ? view.windSeries : view.tempSeries;
        const p = series.points[idx];
        if (!p) return;
        whenLabel = fmtDayTime(p.t, units.zone);
        rowsHtml = view.runsData
          .map((d, rIdx) => {
            const raw = p.values[rIdx];
            let txt = "—";
            if (raw != null) {
              if (varKey === "wind") {
                const spd = `${Math.round(units.speed(raw))} ${units.speedUnit()}`;
                const gRaw =
                  view.hasSharedGust && view.gustSeries && view.gustSeries.points[idx]
                    ? view.gustSeries.points[idx].values[rIdx]
                    : null;
                txt = gRaw != null ? `${spd} (g ${Math.round(units.speed(gRaw))})` : spd;
              } else {
                txt = units.temp(raw).txt;
              }
            }
            return `<span><i>${esc(fmtRunShort(d.run))}</i><b>${esc(txt)}</b></span>`;
          })
          .join("");
        if (p.delta != null) {
          const dStr =
            varKey === "wind"
              ? fmtSigned(Math.round(units.speed(p.ref)) - Math.round(units.speed(p.base)), units.speedUnit(), 0)
              : fmtSigned(normTempDelta(units, p.delta).v, normTempDelta(units, p.delta).unit, 1);
          deltaHtml = `<span class="evo-tip-delta"><i>Δ</i><b>${esc(dStr)}</b></span>`;
        }
      }

      tip.innerHTML = `<span class="when">${esc(whenLabel)}</span>${rowsHtml}${deltaHtml}`;
      tip.hidden = false;
      const rect = canvas.getBoundingClientRect();
      const relX = Math.max(56, Math.min(rect.width - 56, clientX - rect.left));
      tip.style.left = `${relX}px`;
      tip.style.top = `8px`;
    };

    canvas.onpointermove = (e) => {
      const idx = indexFromClientX(e.clientX);
      if (idx >= 0) showTipAt(idx, e.clientX);
    };
    canvas.onpointerleave = () => {
      lastHoverIdx = null;
      if (tip) tip.hidden = true;
      drawChart(view, varKey, units, null);
    };
    canvas.onclick = (e) => {
      const idx = indexFromClientX(e.clientX);
      if (idx < 0) return;
      if (varKey === "tp6") {
        const b = view.precipSeries.buckets[idx];
        if (b) jumpToValidTime(b.end);
      } else {
        const pts = (varKey === "wind" ? view.windSeries : view.tempSeries).points;
        if (pts[idx]) jumpToValidTime(pts[idx].t);
      }
    };
  }

  function syncMapMarkerLine() {
    const ctrl = ensureBrowserCtrl();
    const view = ctrl.getView();
    if (view && view.status === "ok") {
      drawChart(view, ctrl.getVariable(), defaultUnits(), lastHoverIdx);
    }
  }

  function renderPane(pt) {
    const ctrl = ensureBrowserCtrl();
    const view = ctrl.getView();
    const wx = W();
    const wlon = wx && wx.wlon ? wx.wlon : (x) => x;
    const sameTarget =
      view &&
      (view.status === "ok" || view.status === "loading") &&
      pt &&
      view.model &&
      wx &&
      view.model.key === wx.state.model &&
      view.selection &&
      view.selection.refRun === wx.state.run &&
      Math.abs(view.lat - pt.lat) < 1e-4 &&
      Math.abs(wlon(view.lon) - wlon(pt.lon)) < 1e-4 &&
      !pt.outside;

    if (sameTarget) {
      renderDom(view);
      return;
    }
    ctrl.loadPoint(pt);
  }

  const exported = {
    parseRunMs,
    fmtRunShort,
    fmtRunReadable,
    selectRunSet,
    computeOverlap,
    sampleInstant,
    sampleDirection,
    circularDeltaDeg,
    precipInterval,
    buildInstantSeries,
    buildPrecipSeries,
    buildDayPrecipWindows,
    buildSummaries,
    compareRuns,
    resolveStepForValidTime,
    createController,
    render: renderPane,
    syncStep: syncMapMarkerLine,
  };

  if (typeof window !== "undefined") {
    window.WXEvolution = exported;
    if (window.WX) window.WX.evolution = exported;
  }
})();
