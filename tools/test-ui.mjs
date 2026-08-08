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

/**
 * Read the panel, including the plot's real SVG geometry.
 *
 * The plot is the headline now, so it has to be tested as a drawing and not
 * just as the numbers beside it. Everything below is pulled out of the
 * attributes the renderer actually set, in the SVG's own coordinate space.
 */
const readCard = (page) => page.evaluate(() => {
  const t = (id) => document.getElementById(id).textContent.trim();
  const num = (id, attr) => parseFloat(document.getElementById(id).getAttribute(attr));
  const H = 156;
  const W = 360;
  const TOP = 7;   // must match PLOT.top in setup-screen.js

  // Where a path ends, in SVG units: "M0 y L x h" -> its second point.
  const endOf = (id) => {
    const el = document.getElementById(id);
    if (el.style.display === 'none') return null;
    const m = /L\s*([\d.]+)\s+([\d.]+)/.exec(el.getAttribute('d') || '');
    return m ? { x: +m[1], y: +m[2] } : null;
  };

  return {
    arrival: parseFloat(t('pArrival')),
    range: parseFloat(t('pRange')),
    whKm: parseFloat(t('pWhKm')),
    empty: t('pTimeToEmpty'),
    verdict: document.getElementById('pVerdict').className,
    verdictText: t('pVerdict'),
    result: document.getElementById('setupResult').className,
    climate: [...document.querySelectorAll('#climateSetup [data-cost]')].map((e) => e.textContent.trim()),
    plot: {
      W,
      H,
      TOP,
      line: endOf('plotLine'),
      ghost: endOf('plotGhost'),
      destX: num('plotDest', 'x1'),
      dotShown: !document.getElementById('plotDot').classList.contains('hidden'),
      dotX: num('plotDot', 'cx'),
      dotY: num('plotDot', 'cy'),
      reserveY: num('plotReserve', 'y'),
      reserveShown: document.getElementById('plotReserve').style.display !== 'none',
      xMax: parseFloat(t('plotXMax')),
      now: parseFloat(t('plotTop')),
    },
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

  // -- 2. The plot is the headline, so test it as a DRAWING -----------------
  //
  // Every one of these converts a pixel back into the quantity it is supposed
  // to represent and compares it against the figure printed beside it. A plot
  // whose geometry disagrees with its own labels is worse than no plot.
  await set(page, 'soc', 80);
  await set(page, 'reserve', 15);
  const c = await readCard(page);
  const { plot } = c;
  // y is inverted and scaled to the current charge: pct = soc * (1 - y/H).
  const pctAt = (y) => plot.now * (1 - (y - plot.TOP) / (plot.H - plot.TOP));
  const kmAt = (x) => (x / plot.W) * plot.xMax;

  ok(`${label}-plot-top-is-current-charge`, plot.now === 80, `${plot.now}%`);
  ok(`${label}-plot-dot-sits-at-arrival`,
    plot.dotShown && Math.abs(pctAt(plot.dotY) - c.arrival) <= 1.5,
    `dot reads ${pctAt(plot.dotY).toFixed(1)}% vs figure ${c.arrival}%`);
  ok(`${label}-plot-destination-at-trip-distance`, Math.abs(kmAt(plot.destX) - 150) <= 4,
    `rule at ${kmAt(plot.destX).toFixed(0)} km for a 150 km trip`);
  ok(`${label}-plot-dot-on-the-destination-rule`, Math.abs(plot.dotX - plot.destX) < 0.6,
    `dot x ${plot.dotX} vs rule x ${plot.destX}`);
  ok(`${label}-plot-line-ends-where-range-does`,
    plot.line && Math.abs(kmAt(plot.line.x) - c.range) <= 6,
    plot.line ? `line ends at ${kmAt(plot.line.x).toFixed(0)} km vs range ${c.range} km` : 'no line');
  ok(`${label}-plot-line-ends-at-zero-charge`, plot.line && Math.abs(plot.line.y - plot.H) < 0.6,
    plot.line ? `y=${plot.line.y} of ${plot.H}` : 'no line');
  ok(`${label}-plot-reserve-band-at-reserve`,
    plot.reserveShown && Math.abs(pctAt(plot.reserveY) - 15) <= 0.5,
    `band top reads ${pctAt(plot.reserveY).toFixed(1)}% for a 15% reserve`);
  // The counterfactual must go FURTHER, or it is not a counterfactual.
  ok(`${label}-plot-ghost-outlasts-the-real-line`,
    !plot.ghost || plot.ghost.x > plot.line.x,
    plot.ghost ? `ghost ${kmAt(plot.ghost.x).toFixed(0)} km vs line ${kmAt(plot.line.x).toFixed(0)} km`
      : 'no ghost drawn');
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
