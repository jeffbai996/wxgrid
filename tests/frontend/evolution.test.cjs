const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadEvolution(overrides = {}) {
  const ctx = {
    window: {},
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    Intl,
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  ctx.window.WX = ctx.WX || {
    units: {
      tempUnit: '°C',
      precipUnit: 'mm',
      zone: 'UTC',
      temp: (k) => ({ v: Math.round(k - 273.15), unit: '°C', txt: `${Math.round(k - 273.15)}°C` }),
      tempC: (c) => ({ v: Math.round(c), unit: '°C', txt: `${Math.round(c)}°C` }),
      tempDelta: (dc) => ({ v: Math.round(dc * 10) / 10, unit: '°C' }),
      precip: (mm) => ({ v: Number(mm.toFixed(1)), unit: 'mm', txt: `${mm.toFixed(1)} mm` }),
      timeOpts: (o) => ({ ...o, timeZone: 'UTC' }),
    },
    speed: (ms) => ms * 3.6,
    speedUnit: () => 'km/h',
    wlon: (lon) => lon,
    ...(overrides.wx || {}),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('front/evolution.js', 'utf8'), ctx);
  return ctx.window.WXEvolution;
}

function makeRun(runId, stepHours, seriesFn) {
  const baseMs = Date.parse(runId + ':00:00Z');
  const valid = stepHours.map((h) => new Date(baseMs + h * 3600e3).toISOString().replace('.000Z', 'Z'));
  const series = seriesFn(stepHours, valid, baseMs);
  return {
    available: true,
    model: 'gfs',
    run: runId,
    lat: 49.28,
    lon: -123.12,
    steps: stepHours,
    valid,
    series,
  };
}

test('aligns different run initialization times by UTC valid time, never by step index', () => {
  const E = loadEvolution();
  const tTarget = Date.parse('2026-10-23T06:00:00Z');
  // Reference run 18Z: 06Z is step +12h (index 2). Baseline run 12Z: 06Z is step +18h (index 3).
  const ref = makeRun('2026-10-22T18', [0, 6, 12, 18, 24], (steps, valid) => ({
    t2m: valid.map((iso) => (Date.parse(iso) === tTarget ? 285.15 : 280.15)),
    wind: steps.map(() => 5),
  }));
  const base = makeRun('2026-10-22T12', [0, 6, 12, 18, 24, 30], (steps, valid) => ({
    t2m: valid.map((iso) => (Date.parse(iso) === tTarget ? 281.15 : 280.15)),
    wind: steps.map(() => 5),
  }));

  const overlap = E.computeOverlap(ref, base, 72);
  assert.equal(overlap.status, 'ok');
  assert.equal(overlap.windowStart, Date.parse('2026-10-22T18:00:00Z'));
  assert.equal(overlap.windowEnd, Date.parse('2026-10-23T18:00:00Z'));
  assert.equal(overlap.totalOverlapHours, 24);

  const series = E.buildInstantSeries([ref, base], 't2m', overlap.windowStart, overlap.windowEnd);
  const pt = series.points.find((p) => p.t === tTarget);
  assert.ok(pt, 'shared valid timestamp is present');
  assert.ok(Math.abs(pt.ref - 285.15) < 1e-6);
  assert.ok(Math.abs(pt.base - 281.15) < 1e-6);
  assert.ok(Math.abs(pt.delta - 4.0) < 1e-6);

  const otherPts = series.points.filter((p) => p.t !== tTarget);
  for (const p of otherPts) {
    assert.ok(Math.abs(p.delta) < 1e-6, `expected 0 delta at ${new Date(p.t).toISOString()}, got ${p.delta}`);
  }
});

test('bounded interpolation works across 3h and 6h cadences but refuses >6h gaps, nulls, and out-of-range times', () => {
  const E = loadEvolution();
  // 6h run with a 12h gap between +6h and +18h, and a null at +24h
  const run6 = makeRun('2026-10-22T00', [0, 6, 18, 24, 30], () => ({
    t2m: [280.15, 286.15, 292.15, null, 290.15],
  }));

  // Inside 0..6h (6h span): midpoint +3h interpolates linearly to 283.15 K
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-22T03:00:00Z')), 283.15);
  // Before start or after end: null
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-21T23:00:00Z')), null);
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-23T07:00:00Z')), null);
  // Across 12h gap (+6h to +18h): refuses interpolation -> null
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-22T12:00:00Z')), null);
  // Across null sample (+18h to +24h or +24h to +30h): refuses interpolation -> null
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-22T21:00:00Z')), null);
  assert.equal(E.sampleInstant(run6, 't2m', Date.parse('2026-10-23T00:00:00Z')), null);
});

test('zero values are preserved and never confused with missing null values', () => {
  const E = loadEvolution();
  const ref = makeRun('2026-10-22T12', [0, 6, 12], () => ({
    t2m: [273.15, 273.15, null],
    wind: [0, 0, null],
    tp6: [0, 0, null],
  }));
  const base = makeRun('2026-10-22T06', [0, 6, 12, 18], () => ({
    t2m: [273.15, 273.15, 273.15, 273.15],
    wind: [4, 0, 5, 5],
    tp6: [0, 0, 0, 2],
  }));

  const t06 = Date.parse('2026-10-22T12:00:00Z');
  const t12 = Date.parse('2026-10-22T18:00:00Z');
  const t18 = Date.parse('2026-10-23T00:00:00Z');

  assert.equal(E.sampleInstant(ref, 'wind', t12), 0);
  assert.equal(E.sampleInstant(ref, 'wind', t18), null);
  assert.equal(E.precipInterval(ref, t06, t12), 0);
  assert.equal(E.precipInterval(base, t06, t12), 0);
  assert.equal(E.precipInterval(ref, t12, t18), null);
});

test('precipitation intervals sum interval buckets without differencing, prorating, or using unanchored initial step', () => {
  const E = loadEvolution();
  // Ref has 3h steps: (12Z..15Z]=2mm, (15Z..18Z]=3mm, (18Z..21Z]=1mm, (21Z..00Z]=4mm
  // Notice tp6[0] = 99 (e.g. unanchored initial value) which must NEVER be included in (12Z..18Z]
  const ref = makeRun('2026-10-22T12', [0, 3, 6, 9, 12], () => ({
    tp6: [99, 2, 3, 1, 4],
  }));
  // Base has 6h steps: (06Z..12Z]=5mm, (12Z..18Z]=1.5mm, (18Z..00Z]=2.5mm
  const base = makeRun('2026-10-22T06', [0, 6, 12, 18], () => ({
    tp6: [0, 5, 1.5, 2.5],
  }));

  const t12 = Date.parse('2026-10-22T12:00:00Z');
  const t15 = Date.parse('2026-10-22T15:00:00Z');
  const t18 = Date.parse('2026-10-22T18:00:00Z');
  const t00 = Date.parse('2026-10-23T00:00:00Z');

  // 3h interval works on ref, but returns null on 6h base (never prorated!)
  assert.equal(E.precipInterval(ref, t12, t15), 2);
  assert.equal(E.precipInterval(base, t12, t15), null);

  // Shared 6h intervals sum ref's two 3h buckets (2+3=5, 1+4=5) and match base's 6h buckets (1.5, 2.5)
  assert.equal(E.precipInterval(ref, t12, t18), 5);
  assert.equal(E.precipInterval(base, t12, t18), 1.5);
  assert.equal(E.precipInterval(ref, t18, t00), 5);
  assert.equal(E.precipInterval(base, t18, t00), 2.5);

  // buildPrecipSeries automatically selects 6h shared cadence because base is 6-hourly
  const pSeries = E.buildPrecipSeries([ref, base], t12, t00, 72);
  assert.equal(pSeries.bucketHours, 6);
  assert.equal(pSeries.buckets.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(pSeries.buckets.map((b) => [b.ref, b.base, b.delta]))), [
    [5, 1.5, 3.5],
    [5, 2.5, 2.5],
  ]);

  // A run whose first stored step is +6h (like WN2) cannot use steps[0] as the end of an unanchored bucket
  const wn = makeRun('2026-10-22T12', [6, 12, 18], () => ({
    tp6: [7, 4, 2],
  }));
  // 12Z is not in wn.valid (which starts at 18Z), so (12Z..18Z] is null; (18Z..00Z] is 4
  assert.equal(E.precipInterval(wn, t12, t18), null);
  assert.equal(E.precipInterval(wn, t18, t00), 4);
});

test('temperature delta conversion scales by 1.8 in Fahrenheit without a +32 offset', () => {
  const E = loadEvolution({
    wx: {
      units: {
        tempUnit: '°F',
        precipUnit: 'in',
        zone: 'UTC',
        temp: (k) => ({ v: Math.round((k - 273.15) * 1.8 + 32), unit: '°F', txt: `${Math.round((k - 273.15) * 1.8 + 32)}°F` }),
        tempC: (c) => ({ v: Math.round(c * 1.8 + 32), unit: '°F', txt: `${Math.round(c * 1.8 + 32)}°F` }),
        tempDelta: (dc) => ({ v: Math.round(dc * 1.8 * 10) / 10, unit: '°F' }),
        precip: (mm) => ({ v: Number((mm / 25.4).toFixed(2)), unit: 'in', txt: `${(mm / 25.4).toFixed(2)} in` }),
        timeOpts: (o) => ({ ...o, timeZone: 'UTC' }),
      },
      speed: (ms) => ms * 2.23694,
      speedUnit: () => 'mph',
    },
  });

  // -3°C cooling equals -5.4°F cooling, never +26.6°F
  const steps = [0, 6, 12, 18, 24];
  const ref = makeRun('2026-10-22T12', steps, () => ({
    t2m: [283.15, 283.15, 280.15, 283.15, 283.15], // 10°C except +12h is 7°C (45°F)
    wind: [4, 4, 4, 4, 4],
    tp6: [0, 0, 0, 0, 0],
  }));
  const base = makeRun('2026-10-22T06', [0, 6, 12, 18, 24, 30], () => ({
    t2m: [283.15, 283.15, 283.15, 283.15, 283.15, 283.15], // 10°C (50°F)
    wind: [4, 4, 4, 4, 4, 4],
    tp6: [0, 0, 0, 0, 0, 0],
  }));

  const cmp = E.compareRuns([ref, base], { horizonHours: 72 });
  const tempSummary = cmp.summaries.find((s) => s.kind === 'temp');
  assert.ok(tempSummary, 'expected temperature summary');
  assert.match(tempSummary.text, /5\.4°F|5°F/);
  assert.match(tempSummary.text, /colder/);
  assert.doesNotMatch(tempSummary.text, /26\.6|37\.4/);
});

test('deterministic summaries cover precip increases, wind peak shifts, trends across >=3 runs, and calm small changes', () => {
  const E = loadEvolution();
  const steps = [0, 6, 12, 18, 24, 30, 36, 42, 48];
  // Three runs: 00Z (oldest), 06Z (base), 12Z (ref)
  // On 2026-10-23 (00Z..24Z = steps 12..36 of 12Z run):
  // 00Z run had 4 mm total (1mm x 4), 06Z run had 8 mm total (2mm x 4), 12Z run has 14 mm total (3.5mm x 4)
  const r12 = makeRun('2026-10-22T12', steps, (st, valid) => ({
    t2m: st.map(() => 283.15),
    wind: valid.map((iso) => (iso === '2026-10-23T18:00:00Z' ? 14 : 5)),
    gust: valid.map((iso) => (iso === '2026-10-23T18:00:00Z' ? 21 : 8)),
    tp6: valid.map((iso) => (iso > '2026-10-23T00:00:00Z' && iso <= '2026-10-24T00:00:00Z' ? 3.5 : 0)),
  }));
  const r06 = makeRun('2026-10-22T06', [0, 6, 12, 18, 24, 30, 36, 42, 48, 54], (st, valid) => ({
    t2m: st.map(() => 283.15),
    wind: valid.map((iso) => (iso === '2026-10-23T12:00:00Z' ? 10 : 5)),
    gust: valid.map((iso) => (iso === '2026-10-23T12:00:00Z' ? 15 : 8)),
    tp6: valid.map((iso) => (iso > '2026-10-23T00:00:00Z' && iso <= '2026-10-24T00:00:00Z' ? 2.0 : 0)),
  }));
  const r00 = makeRun('2026-10-22T00', [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60], (st, valid) => ({
    t2m: st.map(() => 283.15),
    wind: valid.map((iso) => (iso === '2026-10-23T12:00:00Z' ? 8 : 5)),
    gust: valid.map((iso) => (iso === '2026-10-23T12:00:00Z' ? 12 : 8)),
    tp6: valid.map((iso) => (iso > '2026-10-23T00:00:00Z' && iso <= '2026-10-24T00:00:00Z' ? 1.0 : 0)),
  }));

  const cmp = E.compareRuns([r12, r06, r00], { horizonHours: 72 });
  assert.ok(cmp.summaries.length >= 2 && cmp.summaries.length <= 3);
  const texts = cmp.summaries.map((s) => s.text).join(' | ');
  // Concrete precip increase from 8.0 to 14.0 mm
  assert.match(texts, /8\.0\s*(to|→)\s*14\.0 mm|from 8\.0 mm to 14\.0 mm/);
  // Trend across 3 runs or wind revision
  assert.ok(cmp.summaries.some((s) => s.kind === 'trend' || s.kind === 'wind'));

  // Small changes produce a single calm summary without dramatic language
  const calmRef = makeRun('2026-10-22T12', [0, 6, 12, 18, 24], () => ({
    t2m: [283.15, 283.45, 283.15, 283.05, 283.15],
    wind: [5.0, 5.2, 5.0, 4.9, 5.0],
    tp6: [0, 0.2, 0, 0, 0],
  }));
  const calmBase = makeRun('2026-10-22T06', [0, 6, 12, 18, 24, 30], () => ({
    t2m: [283.15, 283.15, 283.15, 283.15, 283.15, 283.15],
    wind: [5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
    tp6: [0, 0, 0, 0, 0, 0],
  }));
  const calmCmp = E.compareRuns([calmRef, calmBase], { horizonHours: 72 });
  assert.equal(calmCmp.summaries.length, 1);
  assert.equal(calmCmp.summaries[0].kind, 'calm');
  assert.match(calmCmp.summaries[0].text, /Little change/i);
});

test('handles 0 runs, 1 run, non-overlapping runs, missing gusts, and resolves map step by valid time', () => {
  const E = loadEvolution();

  assert.equal(E.selectRunSet({ key: 'gfs', runs: [] }, null, null).status, 'no-runs');
  assert.equal(E.selectRunSet({ key: 'wn2', runs: [{ run: '2026-10-01T12' }] }, '2026-10-01T12', null).status, 'single-run');

  // Requesting an explicit baseline that was pruned returns missing-run, never silent substitution
  const pruned = E.selectRunSet(
    { key: 'gfs', runs: [{ run: '2026-10-22T18' }, { run: '2026-10-22T12' }] },
    '2026-10-22T18',
    '2026-10-22T00'
  );
  assert.equal(pruned.status, 'missing-run');
  assert.equal(pruned.missingRun, '2026-10-22T00');

  // Non-overlapping runs
  const rNew = makeRun('2026-10-25T00', [0, 6, 12], () => ({ t2m: [280, 280, 280] }));
  const rOld = makeRun('2026-10-20T00', [0, 6, 12], () => ({ t2m: [280, 280, 280] }));
  assert.equal(E.computeOverlap(rNew, rOld, 72).status, 'no-overlap');

  // Missing gusts in one run does not break wind comparison
  const noGustRef = makeRun('2026-10-22T12', [0, 6, 12, 18, 24], () => ({
    t2m: [280, 280, 280, 280, 280],
    wind: [5, 12, 6, 5, 5],
  }));
  const withGustBase = makeRun('2026-10-22T06', [0, 6, 12, 18, 24, 30], () => ({
    t2m: [280, 280, 280, 280, 280, 280],
    wind: [5, 5, 6, 5, 5, 5],
    gust: [8, 8, 10, 8, 8, 8],
  }));
  const windCmp = E.compareRuns([noGustRef, withGustBase], { horizonHours: 72 });
  assert.equal(windCmp.status, 'ok');
  assert.equal(windCmp.hasSharedGust, false);
  assert.ok(windCmp.summaries.some((s) => s.kind === 'wind'));

  // Map step resolution resolves by valid time against the map run, not array index
  const mapRun = { run: '2026-10-22T18', steps: [0, 3, 6, 9, 12, 15, 18] };
  const targetMs = Date.parse('2026-10-23T06:00:00Z'); // +12h in 18Z run -> index 4
  assert.equal(E.resolveStepForValidTime(mapRun, targetMs), 4);

  // Circular wind direction difference across 0°/360° north
  assert.equal(E.circularDeltaDeg(10, 350), 20);
  assert.equal(E.circularDeltaDeg(350, 10), -20);

  // Tied peaks / flat plateaus do not report arbitrary timing shifts
  const plateauRef = makeRun('2026-10-22T12', [0, 6, 12, 18, 24], () => ({
    t2m: [280, 280, 280, 280, 280],
    wind: [5, 11.0, 11.1, 5, 5],
  }));
  const plateauBase = makeRun('2026-10-22T06', [0, 6, 12, 18, 24, 30], () => ({
    t2m: [280, 280, 280, 280, 280, 280],
    wind: [5, 5, 11.1, 11.0, 5, 5],
  }));
  const plateauCmp = E.compareRuns([plateauRef, plateauBase], { horizonHours: 72 });
  assert.ok(!plateauCmp.summaries.some((s) => /earlier|later|occurs/i.test(s.text)), 'flat plateau must not claim a timing shift');
});

test('controller ignores stale async responses after rapid location changes and handles 404 pruned runs by refreshing catalog', async () => {
  const E = loadEvolution();
  let catalogRefreshes = 0;
  const resolvers = [];
  const state = {
    model: 'gfs',
    run: '2026-10-22T18',
    tab: 'changes',
    stepIdx: 0,
    point: { lat: 49.28, lon: -123.12 },
  };
  const catalog = {
    models: [{
      key: 'gfs',
      short: 'GFS',
      label: 'NOAA GFS',
      runs: [{ run: '2026-10-22T18' }, { run: '2026-10-22T12' }],
    }],
  };

  const ctrl = E.createController({
    getState: () => state,
    getCatalog: () => catalog,
    fetchPoint: (url) => new Promise((resolve, reject) => {
      resolvers.push({ url, resolve, reject });
    }),
    refreshCatalog: async () => {
      catalogRefreshes += 1;
      catalog.models[0].runs = [{ run: '2026-10-22T18' }];
    },
  });

  // Start request for point A
  const pA = ctrl.loadPoint(state.point);
  // Rapidly switch to point B before point A resolves
  state.point = { lat: 47.61, lon: -122.33 };
  const pB = ctrl.loadPoint(state.point);

  assert.equal(resolvers.length, 4); // 2 runs for A, 2 runs for B

  // Resolve point B first with valid data
  const run18B = makeRun('2026-10-22T18', [0, 6, 12], () => ({ t2m: [285, 285, 285], wind: [5, 5, 5], tp6: [0, 1, 1] }));
  const run12B = makeRun('2026-10-22T12', [0, 6, 12, 18], () => ({ t2m: [280, 280, 280, 280], wind: [5, 5, 5, 5], tp6: [0, 0, 1, 1] }));
  resolvers[2].resolve(run18B);
  resolvers[3].resolve(run12B);
  await pB;
  assert.equal(ctrl.getView().status, 'ok');
  assert.equal(ctrl.getView().lat, 47.61);

  // Now resolve stale point A: must NOT overwrite point B's active view
  const run18A = makeRun('2026-10-22T18', [0, 6, 12], () => ({ t2m: [270, 270, 270], wind: [5, 5, 5], tp6: [0, 0, 0] }));
  const run12A = makeRun('2026-10-22T12', [0, 6, 12, 18], () => ({ t2m: [270, 270, 270, 270], wind: [5, 5, 5, 5], tp6: [0, 0, 0, 0] }));
  resolvers[0].resolve(run18A);
  resolvers[1].resolve(run12A);
  await pA;
  assert.equal(ctrl.getView().lat, 47.61);

  // Now simulate a pruned baseline run returning 404 on point C
  state.point = { lat: 45.52, lon: -122.68 };
  const pC = ctrl.loadPoint(state.point);
  resolvers[4].resolve(run18B);
  resolvers[5].reject(new Error('404'));
  await pC;
  assert.equal(catalogRefreshes, 1);
  assert.equal(ctrl.getView().status, 'pruned-run');
  assert.equal(ctrl.getView().missingRun, '2026-10-22T12');
});
