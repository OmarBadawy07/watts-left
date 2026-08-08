/**
 * test-ui.mjs — the checks the screenshot harness cannot make.
 *
 *     node tools/test-ui.mjs
 *
 * shoot.mjs drives the happy path and saves pictures. This drives the STATES:
 * what the prediction card does at the edges of its range, whether the numbers
 * on one screen agree with each other, and whether anything overflows its box.
 *
 * The distinction that matters: a screenshot proves a layout existed once, at
 * one size, with one set of values. These assertions hold across the range of
 * values the app actually produces — which is where layout breaks.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8123';
const CAIRO = { latitude: 30.0444, longitude: 31.2357 };

let passed = 0;
const failures = [];
const ok = (name, cond, note = '') => {
  if (cond) { passed++; console.log(`ok    ${name}${note ? '  — ' + note : ''}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${note ? '  — ' + note : ''}`); }
};

/** Set a control and let the app re-render. */
async function set(page, id, value) {
  await page.evaluate(({ i, v }) => {
    const el = document.getElementById(i);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { i: id, v: String(value) });
  await page.waitForTimeout(160);
}

const readCard = (page) => page.evaluate(() => {
  const t = (id) => document.getElementById(id).textContent.trim();
  const pct = (id) => parseFloat(document.getElementById(id).style.width) || 0;
  return {
    arrival: parseFloat(t('pArrival')),
    range: parseFloat(t('pRange')),
    whKm: parseFloat(t('pWhKm')),
    empty: t('pTimeToEmpty'),
    verdict: document.getElementById('pVerdict').className,
    verdictText: t('pVerdict'),
    result: document.getElementById('setupResult').className,
    trackLeft: pct('pTrackLeft'),
    trackSpend: pct('pTrackSpend'),
    reserveLeft: parseFloat(document.getElementById('pTrackReserve').style.left) || 0,
    climate: [...document.querySelectorAll('#climateSetup [data-cost]')].map((e) => e.textContent.trim()),
  };
});

/** Anything whose content is wider than the box it sits in. */
const overflowing = (page) => page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#screen-setup *')) {
    if (!el.offsetParent && el.id !== 'screen-setup') continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.position === 'absolute') continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : '.' + (el.className || '').toString().split(' ')[0]}`
        + ` ${el.scrollWidth}>${el.clientWidth}`);
    }
  }
  return bad;
});

const browser = await chromium.launch();

for (const [label, viewport] of [['mobile', { width: 375, height: 812 }],
  ['desktop', { width: 1280, height: 900 }]]) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'Africa/Cairo',
    permissions: ['geolocation'], geolocation: CAIRO,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#carChip:not(.hidden)', { timeout: 10000 });
  await page.click('#tripMode button[data-mode="manual"]');
  await set(page, 'tripKm', 150);

  // -- 1. The three status states, and the card agreeing with itself --------
  //
  // "Tight" means arriving above 0 but below the reserve, which for a 150 km
  // trip is a band about five percentage points wide. Hardcoding a charge
  // that lands in it makes the test a hostage to the coefficients: nudge the
  // model and the fixture silently becomes a "bad" case that still passes
  // three of its four assertions. So the band gets searched for.
  const socFor = async (want) => {
    for (let soc = 100; soc >= 5; soc -= 1) {
      await set(page, 'soc', soc);
      if ((await readCard(page)).result.includes(want)) return soc;
    }
    return null;
  };
  const seen = {};
  for (const name of ['ok', 'tight', 'bad']) {
    const soc = await socFor(name);
    const c = soc === null ? null : await readCard(page);
    seen[name] = c;
    ok(`${label}-status-${name}`, !!c && c.verdict.includes(name),
      soc === null ? 'no charge level produces this state'
        : `soc ${soc}% -> arrival ${c.arrival}% · ${c.result.replace('card result ', '')}`);
  }
  ok(`${label}-status-ordered`,
    seen.ok && seen.tight && seen.bad
      && seen.ok.arrival > seen.tight.arrival && seen.tight.arrival >= seen.bad.arrival,
    seen.ok ? `${seen.ok.arrival} > ${seen.tight.arrival} >= ${seen.bad.arrival}` : 'missing a state');

  // -- 2. The battery track has to agree with the numbers beside it ---------
  await set(page, 'soc', 80);
  await set(page, 'reserve', 15);
  const c = await readCard(page);
  ok(`${label}-track-matches-arrival`, Math.abs(c.trackLeft - c.arrival) <= 1,
    `bar ${c.trackLeft.toFixed(1)}% vs figure ${c.arrival}%`);
  ok(`${label}-track-spend-closes-the-gap`, Math.abs(c.trackLeft + c.trackSpend - 80) <= 1.5,
    `left ${c.trackLeft.toFixed(1)} + spend ${c.trackSpend.toFixed(1)} vs charge 80%`);
  ok(`${label}-track-reserve-mark-placed`, Math.abs(c.reserveLeft - 15) < 0.01,
    `mark at ${c.reserveLeft}% for a 15% reserve`);
  await set(page, 'reserve', 10);

  // -- 3. Range and arrival must tell the same story ------------------------
  // Fraction of the charge the trip eats, computed two ways.
  const byArrival = (80 - c.arrival) / 80;
  const byRange = 150 / c.range;
  ok(`${label}-range-agrees-with-arrival`, Math.abs(byArrival - byRange) < 0.06,
    `trip is ${(byArrival * 100).toFixed(0)}% of charge by arrival, ${(byRange * 100).toFixed(0)}% by range`);

  // -- 4. The climate control has to visibly respond ------------------------
  // The complaint that started this: changing the level appeared to do
  // nothing. Every level must now carry a distinct, ordered cost.
  const costs = c.climate;
  const nums = costs.slice(1).map((x) => parseFloat(x));
  ok(`${label}-climate-costs-shown`, costs[0] === '—' && nums.every(Number.isFinite),
    costs.join(' / '));
  ok(`${label}-climate-costs-ordered`, nums[0] < nums[1] && nums[1] < nums[2], nums.join(' < '));

  // And they must actually move the prediction when the weather makes them
  // matter. At 38 C the spread has to be plainly visible, not a rounding blip.
  await page.evaluate(() => { document.querySelector('.disclosure').open = true; });
  await set(page, 'temp', 38);
  await page.click('#climateSetup button[data-climate="off"]');
  await page.waitForTimeout(150);
  const acOff = await readCard(page);
  await page.click('#climateSetup button[data-climate="high"]');
  await page.waitForTimeout(150);
  const acHigh = await readCard(page);
  ok(`${label}-climate-changes-arrival-when-hot`, acOff.arrival - acHigh.arrival >= 2,
    `38 C: off ${acOff.arrival}% vs high ${acHigh.arrival}% (${(acOff.arrival - acHigh.arrival).toFixed(0)} points)`);
  await set(page, 'temp', 20);
  await page.click('#climateSetup button[data-climate="medium"]');

  // -- 5. Nothing overflows its box, at either width ------------------------
  const bad = await overflowing(page);
  ok(`${label}-nothing-overflows`, bad.length === 0, bad.slice(0, 4).join(' | ') || 'clean');

  // -- 6. Small text must clear the contrast floor --------------------------
  // Quiet tokens are the ones that drift below it, and the ones that carry
  // every label on the screen.
  const contrast = await page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
        .map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
      }
      return 'rgb(10,11,13)';
    };
    const bad = [];
    for (const el of document.querySelectorAll('#screen-setup label, #screen-setup .hint, #screen-setup h2, .stat label, .track-keys, .card-note, .tagline')) {
      if (!el.offsetParent || !el.textContent.trim()) continue;
      const cs = getComputedStyle(el);
      const a = lum(cs.color); const b = lum(bgOf(el));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
      if (ratio < (big ? 3 : 4.5)) {
        bad.push(`${el.className || el.tagName} ${cs.fontSize} ${ratio.toFixed(2)}:1`);
      }
    }
    return [...new Set(bad)];
  });
  ok(`${label}-small-text-contrast`, contrast.length === 0, contrast.slice(0, 4).join(' | ') || 'all pass');

  ok(`${label}-no-page-errors`, errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');
  await context.close();
}

await browser.close();
console.log('');
console.log(failures.length === 0
  ? `  ${passed}/${passed} UI assertions passed`
  : `  ${passed} passed, ${failures.length} FAILED: ${failures.join(', ')}`);
if (failures.length) process.exitCode = 1;
