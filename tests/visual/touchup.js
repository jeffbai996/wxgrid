// Run with the Playwright browser tool against a served instance. Uses a fresh
// context, real model data, and assertions on interactions rather than pixels.
async (page) => {
  const base = page.url().split('/').slice(0, 3).join('/');
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const p = await context.newPage(), errors = [];
  const check = (ok, why) => { if (!ok) throw new Error(why); };
  p.on("pageerror", e => errors.push(e.message));
  const box = async selector => p.locator(selector).boundingBox();
  const report = {};
  try {
    await p.addInitScript(() => { localStorage.setItem("wxgrid.tour", "1"); });
    await p.goto(base);
    await p.waitForFunction(() => window.WX?.field?.ready(), null, { timeout: 30000 });
    await p.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent === 'Skip') b.click(); }); WX.openPoint(40, -100); });
    await p.waitForFunction(() => WX.state.point?.data && document.querySelector('#timebar').classList.contains('mini'));
    report.phoneCard = await box('#point'); report.phoneTape = await box('#timebar');
    check(report.phoneTape.height < 80, 'point should open with a compact clock');
    check(report.phoneCard.y > 200, 'point should leave usable map above');
    await p.locator('[data-tab="cmp"]').click();
    await p.waitForFunction(() => WX.state.point?.cmp?.pending === 0, { timeout: 30000 });
    report.compare = await p.locator('.cmp-takeaway').innerText();
    check(await p.locator('.cmp-takeaway').count() === 1, 'comparison takeaway missing');
    const ai = await p.evaluate(() => [...document.querySelectorAll('.cmp tbody:first-of-type tr')].filter(tr => /AIFS|AI-GFS/.test(tr.innerText)).map(tr => tr.querySelector('td').textContent));
    check(ai.length === 2 && ai.every(v => v !== '—'), 'AI rows should have values on common forecast times');
    await p.evaluate(() => WX.fn.setTapeState('full', false));
    await p.waitForTimeout(450);
    check((await box('#point')).height <= 190, 'full tape should reduce card to summary');
    check(await p.evaluate(() => WX.state.tab === 'now'), 'summary should show conditions, even from Compare');
    await p.locator('.sheet-grip').click();
    await p.waitForTimeout(450);
    check(await p.evaluate(() => WX.state.tab === 'cmp' && WX.fn.getTapeState() === 'mini'), 'expanding card should restore Compare and compact clock');
    await p.locator('[data-tab="now"]').click();
    await p.locator('details[data-detail="air"] summary').click();
    await p.evaluate(() => WX.renderPoint());
    check(await p.locator('details[data-detail="air"]').getAttribute('open') !== null, 'details should remain open on data refresh');
    await p.locator('#point-close').click();
    await p.waitForTimeout(450);
    check(await p.evaluate(() => WX.fn.getTapeState() === 'full'), 'closing card should restore original tape');
    await p.setViewportSize({ width: 1280, height: 900 });
    await p.locator('#strip-more').click();
    check(await p.locator('.tool-group h3').count() === 4, 'named tool groups missing');
    await p.locator('[data-pin="route"]').click();
    check(await p.locator('#tstrip [data-for="route-toggle"]').isVisible(), 'pin should appear on rail');
    await p.keyboard.press('Escape');
    check(await p.locator('#strip-more-pop').evaluate(el => el.inert), 'closed tools should leave the keyboard focus order');
    await p.reload();
    await p.waitForFunction(() => window.WX?.field?.ready());
    check(await p.locator('#tstrip [data-for="route-toggle"]').isVisible(), 'pin should survive reload');
    for (const theme of ['light', 'dark']) {
      await p.evaluate(theme => { WX.fn.applyTheme(theme); WX.openPoint(40, -100); }, theme);
      await p.waitForFunction(() => WX.state.point?.data);
      check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} layout overflow`);
      report[theme] = await p.evaluate(() => getComputedStyle(document.querySelector('.hero .big')).color);
      check(!!report[theme], `${theme} hero color should resolve on the rendered node`);
    }
    // Exercise the production field consumer, not just the queue in isolation.
    await p.evaluate(() => WX.closePoint());
    let failed = 0;
    await p.route('**/api/field/**', async route => {
      if (route.request().url().includes('/42/wind.png') && failed++ === 0) await route.fulfill({ status: 503, body: 'temporary' });
      else await route.continue();
    });
    await p.evaluate(() => WX.setStep(WX.fn.steps().indexOf(42)));
    await p.waitForFunction(() => WX.field.shown.a?.url.includes('/42/wind.png'), { timeout: 30000 });
    check(failed >= 2, 'selected frame should retry a transient server failure');
    await p.evaluate(() => { for (const step of [17, 20, 18, 21]) WX.setStep(step); });
    await p.waitForFunction(() => WX.field.shown.a?.url.includes('/63/wind.png'), { timeout: 30000 });
    check(await p.evaluate(() => WX.field.live && WX.field.ready()), 'rapid scrubbing should finish on the requested GPU frame');
    report.retryAttempts = failed;
    report.catalogMs = await p.evaluate(() => performance.getEntriesByType('resource').filter(x => x.name.includes('/api/models')).map(x => Math.round(x.duration)));
    check(errors.length === 0, 'browser exceptions: ' + errors.join('; '));
    report.passed = true;
    return report;
  } finally { await context.close(); }
}
