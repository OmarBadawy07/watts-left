/* Screenshot harness for Watt's Left.
 *
 * The app is a static PWA with no build step, so this lives apart from it in
 * tools/ and only ever drives it through the browser. Run the preview server
 * first (.claude/launch.json entry "ev-range-app", port 8123), then:
 *
 *     npm run shots
 *
 * Every shot is wrapped individually: one broken step should still leave you
 * with the other nine images plus a report saying exactly which one failed.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'shots');
const BASE = process.env.BASE_URL || 'http://localhost:8123';

// Cairo — the user is in Egypt, and search bias behaves differently elsewhere.
const CAIRO = { latitude: 30.0444, longitude: 31.2357 };

const report = [];
const log = (name, ok, note = '') => {
  report.push({ name, ok, note });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

/** Screenshot + record, never throw. */
async function shot(page, name, opts = {}) {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
    log(name, true);
  } catch (err) {
    log(name, false, err.message);
  }
}

/**
 * Open a <details> panel.
 *
 * The advanced controls now fold away so a driver is not faced with a wall of
 * them, which means anything inside one is genuinely not clickable until it is
 * opened — the same step a real user takes.
 */
async function openPanel(page, id) {
  await page.evaluate((elId) => {
    const d = document.getElementById(elId);
    if (d) d.open = true;
  }, id);
  await page.waitForTimeout(250);
}

/**
 * Console errors and unhandled rejections are as interesting as the pixels.
 *
 * One exception: a third-party geocoder or tile server being unreachable is
 * not a regression in this app — the whole point of the fallbacks is that it
 * keeps working — and failing the run for it would train us to ignore the run.
 * Those are collected separately and reported, not failed on.
 */
const EXTERNAL_HOSTS = /photon\.komoot\.io|nominatim\.openstreetmap\.org|router\.project-osrm\.org|api\.open-meteo\.com|basemaps\.cartocdn\.com|arcgisonline\.com/;

function watch(page, sink, externalSink = []) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const isNetwork = /net::ERR|Failed to load resource/.test(text);
    // A resource error names its URL in the request, not always the message,
    // so treat any bare network failure as external — our own files are served
    // from the same origin and would fail loudly in other ways too.
    if (isNetwork) externalSink.push(text);
    else sink.push(`console.error: ${text}`);
  });
  page.on('requestfailed', (r) => {
    if (!EXTERNAL_HOSTS.test(r.url())) sink.push(`request failed: ${r.url()}`);
  });
  page.on('pageerror', (e) => sink.push(`pageerror: ${e.message}`));
}

/** Pick a car and switch to manual distance so setup is complete. */
async function fillSetup(page, { km = 150 } = {}) {
  // A car is already selected on a fresh load (the search box hides behind the
  // chip), so only drive the search when there is nothing chosen yet.
  const chosen = await page.isVisible('#carChip:not(.hidden)');
  if (!chosen) {
    await page.waitForSelector('#carSearch');
    await page.fill('#carSearch', 'Model 3');
    await page.waitForSelector('#carResults li', { timeout: 5000 });
    await page.click('#carResults li');
    await page.waitForSelector('#carChip:not(.hidden)');
  }

  await page.click('#tripMode button[data-mode="manual"]');
  await page.fill('#tripKm', String(km));
  await page.dispatchEvent('#tripKm', 'input');
  await page.waitForTimeout(400);
}

async function run(label, viewport, { denyGeo = false } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    locale: 'en-GB',
    timezoneId: 'Africa/Cairo',
    ...(denyGeo ? {} : { permissions: ['geolocation'], geolocation: CAIRO }),
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  watch(page, errors, external);

  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await shot(page, `${label}-01-setup-empty`, { fullPage: true });

    await fillSetup(page);
    await shot(page, `${label}-02-setup-filled`, { fullPage: true });

    // The prediction block is the payoff of the setup screen — frame it alone.
    try {
      await page.locator('#setupResult').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator('#setupResult').screenshot({
        path: path.join(OUT, `${label}-03-prediction.png`),
      });
      log(`${label}-03-prediction`, true);
    } catch (err) {
      log(`${label}-03-prediction`, false, err.message);
    }

    // ---- Route planner ----------------------------------------------------
    try {
      await page.click('#tripMode button[data-mode="route"]');
      await page.click('#openMap');
      // `.active` is the real class — an earlier `:not(.hidden)` here matched
      // whether the screen was showing or not, so the wait proved nothing.
      await page.waitForSelector('#screen-map.active', { timeout: 5000 });
      await page.waitForTimeout(3500); // let basemap tiles arrive
      await shot(page, `${label}-04-map`);

      // Search bias check: from Cairo, "mcdonalds" must not return Sydney.
      await page.fill('#toSearch', 'mcdonalds');
      // Wait for REAL results, not the "Searching…" placeholder. Waiting for
      // any <li> passed the moment the spinner text appeared, so this assertion
      // used to succeed without a single place ever being found.
      // NOTE the `null`: waitForFunction(fn, arg, options). Passing options as
      // the second argument silently makes them the ARGUMENT and falls back to
      // the default timeout, which is how this waited 30 s instead of 25 s and
      // reported a failure it could not explain.
      await page.waitForFunction(() => {
        const items = [...document.querySelectorAll('#toResults li')];
        return items.length > 0 && !items.some((li) => li.classList.contains('loading'));
      }, null, { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(400);
      await shot(page, `${label}-05-map-search`);

      const results = await page.$$eval('#toResults li', (els) =>
        els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
      );
      const real = results.filter((r) => r && !/^Searching|^Nothing found|unavailable/.test(r));
      // On failure, say WHY: which external services failed, and what the
      // module returns when called directly with the same bias. A bare "no
      // results" sends you guessing; this points straight at the cause.
      let diag = '';
      if (!real.length) {
        const direct = await page.evaluate(async () => {
          try {
            const geo = await import('./js/geo.js');
            const r = await geo.searchPlaces('mcdonalds', undefined,
              { lat: 30.0444, lon: 31.2357 });
            return `module returned ${r.length}`;
          } catch (e) { return `module threw ${e.name}: ${e.message}`; }
        }).catch((e) => `probe failed: ${e.message}`);
        diag = ` | ${direct} | external failures: ${[...new Set(external.map(
          (t) => (t.match(/https?:\/\/([^/]+)/) || [, 'unknown'])[1]))].join(', ') || 'none'}`;
      }
      log(`${label}-search-results`, real.length > 0,
        real.length ? real.slice(0, 5).join(' | ')
          : `no real results (got: ${results.join(' | ')})${diag}`);

      await page.click('#mapBack');
      await page.waitForTimeout(600);
    } catch (err) {
      log(`${label}-04-map`, false, err.message);
    }

    // ---- Live / navigation screen ----------------------------------------
    try {
      await page.click('#tripMode button[data-mode="manual"]');
      await page.click('#startTrip');
      await page.waitForSelector('#screen-live', { timeout: 8000 });
      await page.waitForTimeout(2500);
      await shot(page, `${label}-06-live-sheet-open`);

      const openState = await page.evaluate(() => ({
        heroLabel: document.getElementById('heroLabel')?.textContent.trim(),
        hero: document.getElementById('lTimeToEmpty')?.textContent.trim(),
        drive: document.getElementById('driveLabel')?.textContent.trim(),
        used: document.getElementById('lUsed')?.textContent.trim(),
        driven: document.getElementById('lDriven')?.textContent.trim(),
        expanded: document.getElementById('navSheet')?.classList.contains('expanded'),
        sheetPct: Math.round(
          (document.getElementById('navSheet').getBoundingClientRect().height /
            window.innerHeight) * 100,
        ),
      }));
      log(`${label}-live-state`, true, JSON.stringify(openState));

      // The bug the user hit: tap the handle, does it STAY collapsed? The sheet
      // may start either way (it auto-expands only when geolocation fails), so
      // force it open first — otherwise the tap expands it and the check is
      // measuring the opposite of what it claims to.
      const setSheet = async (open) => {
        const isOpen = await page.evaluate(() =>
          document.getElementById('navSheet').classList.contains('expanded'),
        );
        if (isOpen !== open) await page.click('#navSheetHandle');
        await page.waitForTimeout(600);
      };

      await setSheet(true);
      await page.click('#navSheetHandle'); // collapse
      await page.waitForTimeout(5000); // long enough for a geolocation retry
      const stayed = await page.evaluate(() =>
        !document.getElementById('navSheet').classList.contains('expanded'),
      );
      log(`${label}-handle-stays-collapsed`, stayed, stayed ? '' : 'sheet sprang back open');
      await shot(page, `${label}-07-live-sheet-collapsed`);

      // Are the floating map controls reachable with the sheet wide open?
      await setSheet(true);
      const fabs = await page.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const overlaps = (a, b) =>
          a.left < b.right - 1 && a.right > b.left + 1 &&
          a.top < b.bottom - 1 && a.bottom > b.top + 1;

        const sheet = box('navSheet');
        const seen = {};
        for (const id of ['navVoice', 'navRecenter', 'gpsState']) {
          seen[id] = !overlaps(box(id), sheet);
        }
        // The GPS chip and the button column are both bottom-anchored, so they
        // collide with each other as readily as with the sheet.
        seen.gpsStateVsFabs =
          !overlaps(box('gpsState'), box('navVoice')) &&
          !overlaps(box('gpsState'), box('navRecenter'));
        return seen;
      });
      const allClear = Object.values(fabs).every(Boolean);
      log(`${label}-controls-not-buried`, allClear, JSON.stringify(fabs));

      // Drive + simulate, so the screen shows a moving car rather than zeros.
      // Both controls live in the sheet body, so it has to be open to click them.
      await page.click('#driveToggle');
      await page.waitForTimeout(500);
      await openPanel(page, 'diagDisclosure');
      await page.click('#simToggle');
      await page.waitForTimeout(6000);
      await setSheet(true);
      await shot(page, `${label}-08-live-driving`);

      const driving = await page.evaluate(() => ({
        hero: document.getElementById('lTimeToEmpty')?.textContent.trim(),
        speed: document.getElementById('lSpeed')?.textContent.trim(),
        power: document.getElementById('lPower')?.textContent.trim(),
        driven: document.getElementById('lDriven')?.textContent.trim(),
        soc: document.getElementById('lSoc')?.textContent.trim(),
      }));
      log(`${label}-driving-state`, true, JSON.stringify(driving));
    } catch (err) {
      log(`${label}-06-live`, false, err.message);
    }
  } catch (err) {
    log(`${label}-run`, false, err.message);
  }

  if (errors.length) log(`${label}-page-errors`, false, errors.slice(0, 8).join(' || '));
  else log(`${label}-page-errors`, true, external.length
    ? `none (${external.length} external service failures — see note)` : 'none');

  await browser.close();
}

/**
 * The route pass: plan a real trip, navigate it, and simulate driving it.
 *
 * The two viewport passes above never plan a route — they use manual distance —
 * so routing, turn-by-turn and the simulation went completely untested, which
 * is exactly where the interesting bugs turned out to be. Run once, on desktop
 * only: it hits four free community services and there is no call for doing
 * that twice.
 */
async function runRoute() {
  const label = 'route';
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    locale: 'en-GB',
    timezoneId: 'Africa/Cairo',
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  watch(page, errors, external);

  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await fillSetup(page);
    await page.click('#tripMode button[data-mode="route"]');
    await page.click('#openMap');
    await page.waitForSelector('#screen-map.active', { timeout: 5000 });
    await page.waitForTimeout(2500);

    // Pick a start and destination the way a person would: type, then choose
    // the first result actually in the country we are searching from.
    const pick = async (field, query) => {
      await page.fill(`#${field}Search`, query);
      // Real results, not the loading placeholder — see the note in run().
      await page.waitForFunction((f) => {
        const items = [...document.querySelectorAll(`#${f}Results li`)];
        return items.length > 0 && !items.some((li) => li.classList.contains('loading'));
      }, field, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(500);
      const chose = await page.evaluate(({ field: f, country }) => {
        const items = [...document.querySelectorAll(`#${f}Results li`)];
        const hit = items.find((li) => li.innerText.includes(country)) || items[0];
        if (!hit) return null;
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return hit.innerText.replace(/\s+/g, ' ').trim();
      }, { field, country: 'Egypt' });
      return chose;
    };

    // ---- Tile fetching during a zoom -------------------------------------
    //
    // The "map glitches before it renders" report came down to Leaflet's TWO
    // high-DPI mechanisms both being switched on for the same layer: the {r}
    // token in the CARTO URL, which Leaflet substitutes on any retina display,
    // AND detectRetina, which independently halves the tile size and fetches
    // from one zoom level deeper. Together they pulled four @2x tiles where
    // one was wanted.
    //
    // Both facts are checked, because either alone can regress: the layer must
    // not be running detectRetina, and a zoom must not fetch an absurd number
    // of tiles.
    const tiles = [];
    const onTile = (r) => { if (/basemaps\.cartocdn\.com/.test(r.url())) tiles.push(r.url()); };
    page.on('request', onTile);
    await page.evaluate(() => window.__maps.plan.map.setZoom(13));
    await page.waitForTimeout(2500);
    tiles.length = 0;
    await page.evaluate(() => window.__maps.plan.map.setZoom(15));
    await page.waitForTimeout(3000);
    page.off('request', onTile);

    const layer = await page.evaluate(() => {
      const t = window.__maps.plan.tiles.options;
      return { detectRetina: !!t.detectRetina, tileSize: t.tileSize, keepBuffer: t.keepBuffer };
    });
    log(`${label}-tiles-one-retina-mechanism`, layer.detectRetina === false,
      `detectRetina=${layer.detectRetina} tileSize=${layer.tileSize} keepBuffer=${layer.keepBuffer}`);

    // A 1280x800 viewport at zoom 15 needs roughly 5x4 tiles, plus the
    // keepBuffer ring: comfortably under 60. The doubled-up configuration
    // asked for four times that.
    const retina2x = tiles.filter((u) => u.includes('@2x')).length;
    log(`${label}-zoom-tile-count-sane`, tiles.length > 0 && tiles.length <= 60,
      `${tiles.length} tiles for one zoom step (${retina2x} at @2x)`);

    log(`${label}-pick-from`, true, await pick('from', 'Cairo'));
    log(`${label}-pick-to`, true, await pick('to', 'Alexandria'));

    // Routing + elevation for every alternative + weather takes a few seconds.
    // Generous on purpose: with one geocoder unavailable every lookup pays a
    // timeout first, and this step covers routing, elevation for every
    // alternative, and weather.
    //
    // If it times out anyway, find out WHOSE fault it was before failing. This
    // step depends on a free public router, and one run in several has died
    // here while the router was demonstrably healthy a second later. A suite
    // that reports somebody else's bad minute as our regression is a suite
    // people stop reading — the same reasoning as EXTERNAL_HOSTS above, which
    // already applies to console and request errors but not to this wait.
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('#routeAlts .route-alt').length > 0,
        null,
        { timeout: 90000 },
      );
    } catch (err) {
      const reachable = await page.evaluate(async () => {
        try {
          const r = await fetch('https://router.project-osrm.org/route/v1/driving/'
            + '31.2357,30.0444;31.2001,29.9187?overview=false', { cache: 'no-store' });
          return r.ok;
        } catch { return false; }
      });
      log(`${label}-planned`, false, reachable
        ? 'no routes drawn, and the router IS reachable — this one is ours'
        : 'the router did not answer — external outage, not a regression');
      throw err;
    }
    await page.waitForTimeout(9000);
    await shot(page, `${label}-01-planned`);

    const plan = await page.evaluate(() => ({
      alts: document.querySelectorAll('#routeAlts .route-alt').length,
      steps: document.querySelectorAll('#directionsList li').length,
      distance: document.getElementById('rDistance').textContent,
      climb: document.getElementById('rClimb').textContent,
      elevDrawn: document.getElementById('elevProfile').innerHTML.length > 200,
      weather: document.getElementById('weatherState').textContent.length > 0,
    }));
    const planOk = plan.alts > 0 && plan.steps > 5 && plan.elevDrawn;
    log(`${label}-planned`, planOk, JSON.stringify(plan));

    // ---- Navigate it -------------------------------------------------------
    await page.click('#startNav');
    await page.waitForSelector('#screen-live.active', { timeout: 8000 });
    await page.waitForTimeout(4000);

    const totalKm = await page.evaluate(
      () => parseFloat(document.getElementById('lRemaining').textContent),
    );

    // ---- Simulate driving it ----------------------------------------------
    // Expand the sheet BEFORE opening the panel inside it: a <details> can be
    // open and still invisible when an ancestor is display:none. Relying on
    // GPS failure to expand the sheet for us was a side-effect, not a step.
    await page.evaluate(() => document.getElementById('navSheet').classList.add('expanded'));
    await page.waitForTimeout(300);
    await openPanel(page, 'diagDisclosure');
    await page.click('#simToggle');
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1500);
      samples.push(await page.evaluate(() => ({
        driven: parseFloat(document.getElementById('lDriven').textContent),
        remaining: parseFloat(document.getElementById('lRemaining').textContent),
        speed: parseFloat(document.getElementById('lSpeed').textContent),
      })));
    }
    await shot(page, `${label}-02-navigating`);

    // A simulated speed is a stated intention, not a measurement, so it must
    // NOT be smoothed. The old EMA ramped from zero over ~10 s.
    const noRamp = samples[0].speed > 50;
    log(`${label}-sim-speed-not-smoothed`, noRamp, `first sample ${samples[0].speed} km/h`);

    // The real prize: distance driven and distance remaining are computed by
    // two different mechanisms (integrating speed vs walking the polyline).
    // They used to disagree while the EMA was still catching up.
    const drift = samples.map((s) => Math.abs(s.driven + s.remaining - totalKm));
    const worst = Math.max(...drift);
    log(`${label}-distance-counters-agree`, worst <= 1.5,
      `worst |driven+remaining-total| = ${worst.toFixed(2)} km of ${totalKm}`);

    const advanced = samples[samples.length - 1].driven > samples[0].driven;
    log(`${label}-sim-advances`, advanced,
      `${samples[0].driven} km -> ${samples[samples.length - 1].driven} km`);

    // The "road already covered" overlay must be BEHIND the driver.
    //
    // Worth testing rather than eyeballing: on a screenshot the overlay and
    // the route are two similar greens on a dark map, and which end of the
    // line is dimmed is genuinely hard to judge by looking. Geometry settles
    // it — the overlay must start at the route's first coordinate and end at
    // the driver, never the other way round.
    const overlay = await page.evaluate(() => {
      const R = window.__maps?.nav;
      if (!R?.travelled || !R?.me) return null;
      const km = (a, b) => {
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return 6371 * 2 * Math.asin(Math.sqrt(h));
      };
      const pts = R.travelled.getLatLngs();
      if (pts.length < 2) return null;
      const routePts = R.route.getLatLngs();
      const me = R.me.getLatLng();
      return {
        n: pts.length,
        fromStart: km(pts[0], routePts[0]),
        fromEnd: km(pts[0], routePts[routePts.length - 1]),
        tailToDriver: km(pts[pts.length - 1], me),
      };
    });
    const overlayOk = overlay
      && overlay.fromStart < overlay.fromEnd   // anchored at the start, not the end
      && overlay.tailToDriver < 1.0;           // and it stops where the driver is
    log(`${label}-travelled-overlay-behind-driver`, !!overlayOk,
      overlay
        ? `head ${overlay.fromStart.toFixed(2)} km from route start / `
          + `${overlay.fromEnd.toFixed(2)} km from end · `
          + `tail ${overlay.tailToDriver.toFixed(2)} km from driver`
        : 'no overlay drawn');

    // Diagnostics must not report synthetic positions as real GPS fixes.
    await page.evaluate(() => document.getElementById('navSheet').classList.add('expanded'));
    await page.waitForTimeout(1500);
    const diag = await page.evaluate(() => ({
      fixes: document.getElementById('diagFixes').textContent,
      source: document.getElementById('diagSource').textContent,
    }));
    log(`${label}-diagnostics-honest`,
      diag.fixes.startsWith('0 received') && diag.source.startsWith('SIMULATED'),
      JSON.stringify(diag));

    // The SIMULATED badge must clear the turn banner and its "then…" line.
    const badge = await page.evaluate(() => {
      const b = document.getElementById('simBadge').getBoundingClientRect();
      const then = document.getElementById('navThen');
      const t = then.classList.contains('hidden')
        ? document.getElementById('navBanner').getBoundingClientRect()
        : then.getBoundingClientRect();
      return { badgeTop: Math.round(b.top), blockBottom: Math.round(t.bottom) };
    });
    log(`${label}-badge-clears-banner`, badge.badgeTop >= badge.blockBottom, JSON.stringify(badge));
  } catch (err) {
    log(`${label}-run`, false, err.message);
  }

  if (errors.length) log(`${label}-page-errors`, false, errors.slice(0, 8).join(' || '));
  else log(`${label}-page-errors`, true, external.length
    ? `none (${external.length} external service failures — see note)` : 'none');

  await browser.close();
}

/**
 * The countdown pass.
 *
 * "Battery empty in" is `remaining energy / draw`. Because the draw is a
 * DENOMINATOR, anything that makes it drift makes the headline move
 * hyperbolically — and a 30-second average of the draw once shed SIX HOURS PER
 * SECOND while the kW tile sat perfectly still:
 *
 *     67h 45m -> 27h 46m -> 21h 39m -> 17h 51m -> 15h 15m ...
 *
 * At a steady speed the headline may only fall at real time: ten seconds of
 * driving costs ten seconds of range, not ten hours. That is what this checks.
 */
async function runCountdown() {
  const label = 'countdown';
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-GB',
    timezoneId: 'Africa/Cairo',
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  watch(page, errors, external);

  /** "2h 46m" / "45 min" / "99h+" -> minutes. */
  const toMinutes = (s) => {
    if (!s || s.includes('+') || s.includes('—')) return null;
    const h = /(\d+)\s*h/.exec(s);
    const m = /(\d+)\s*m/.exec(s);
    return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  };

  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await fillSetup(page);
    await page.click('#startTrip');
    await page.waitForSelector('#screen-live.active', { timeout: 8000 });
    await page.waitForTimeout(3500);

    const paused = await page.evaluate(() => ({
      label: document.getElementById('heroLabel').textContent,
      hero: document.getElementById('lTimeToEmpty').textContent,
    }));

    await page.click('#driveToggle');

    const samples = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1000);
      samples.push(await page.evaluate(() => ({
        hero: document.getElementById('lTimeToEmpty').textContent,
        kw: document.getElementById('lPower').textContent,
      })));
    }

    // 1. Starting to drive must not move the figure much: paused already
    //    projects at the speed you intend to hold, so there is nothing to jump
    //    from. Allow a few minutes for rounding and real elapsed drain.
    const pausedMin = toMinutes(paused.hero);
    const firstMin = toMinutes(samples[0].hero);
    const startJump = Math.abs(firstMin - pausedMin);
    log(`${label}-no-jump-on-start`, startJump <= 5,
      `${paused.hero} -> ${samples[0].hero} (${startJump} min)`);

    // 2. Across ten seconds of steady driving the headline may fall by at most
    //    a couple of minutes. The old behaviour lost fifteen HOURS here.
    const mins = samples.map((s) => toMinutes(s.hero)).filter((m) => m !== null);
    const totalDrop = mins[0] - mins[mins.length - 1];
    log(`${label}-falls-at-real-time`, totalDrop >= 0 && totalDrop <= 3,
      `${samples[0].hero} -> ${samples[samples.length - 1].hero} = ${totalDrop} min over ${mins.length}s`);

    // 3. No single second may lose more than a minute.
    let worstStep = 0;
    for (let i = 1; i < mins.length; i++) worstStep = Math.max(worstStep, mins[i - 1] - mins[i]);
    log(`${label}-no-cliff`, worstStep <= 2, `worst single-second drop ${worstStep} min`);

    // 4. The power reading must be steady too — if it is not, a moving
    //    headline would be honest and this test would be measuring the wrong
    //    thing.
    const kws = [...new Set(samples.map((s) => s.kw))];
    log(`${label}-draw-steady`, kws.length <= 2, `kW values seen: ${kws.join(', ')}`);

    log(`${label}-pausedlabel`, /battery would last/i.test(paused.label), paused.label);
  } catch (err) {
    log(`${label}-run`, false, err.message);
  }

  if (errors.length) log(`${label}-page-errors`, false, errors.slice(0, 8).join(' || '));
  else log(`${label}-page-errors`, true, external.length
    ? `none (${external.length} external service failures — see note)` : 'none');

  await browser.close();
}

/**
 * Search from several places in the world.
 *
 * The point is not that a specific business exists — OSM coverage varies — but
 * that what comes back is LOCAL to wherever the user is, and that it comes
 * back at all when one of the two geocoders is unavailable. Both are free
 * community services; during this work Photon blocked this machine outright
 * after too many probe requests, which is exactly the case the fallback exists
 * for.
 *
 * Deliberately few queries: these are services being used on trust.
 */
async function runSearch() {
  const label = 'search';
  const browser = await chromium.launch();

  // Three regions, one query each, with the answer we expect to be near.
  const CASES = [
    { city: 'Cairo',    tz: 'Africa/Cairo',      lat: 30.0444, lon: 31.2357, q: 'pharmacy' },
    { city: 'London',   tz: 'Europe/London',     lat: 51.5074, lon: -0.1278, q: 'station' },
    { city: 'New York', tz: 'America/New_York',  lat: 40.7128, lon: -74.0060, q: 'museum' },
  ];

  for (const c of CASES) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      timezoneId: c.tz,
      locale: 'en-GB',
    });
    const page = await context.newPage();
    try {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

      // Call the module directly with an explicit bias point. Driving the UI
      // would also depend on the home-region lookup, and this test is about
      // the search itself.
      const found = await page.evaluate(async ({ q, lat, lon }) => {
        const geo = await import('./js/geo.js');
        const places = await geo.searchPlaces(q, undefined, { lat, lon });
        return places.map((p) => ({
          title: p.title,
          km: p.distanceKm == null ? null : Math.round(p.distanceKm),
        }));
      }, c);

      // 120 km is "the region you would drive in", not "the same street". It
      // has to tolerate single-provider mode: when one geocoder is down the
      // surviving one has a thinner index, and the nearest museum genuinely
      // may be 80 km away. The check is that results are LOCAL, not perfect.
      const near = found.filter((f) => f.km !== null && f.km <= 120).length;
      log(`${label}-${c.city}`, found.length > 0 && near >= Math.ceil(found.length / 2),
        `${found.length} results, ${near} within 120 km — top: ${found[0]?.title} (${found[0]?.km} km)`);
    } catch (err) {
      log(`${label}-${c.city}`, false, err.message);
    }
    await context.close();
    await new Promise((r) => setTimeout(r, 1500)); // be polite between regions
  }

  // Typed coordinates must resolve without any network at all.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    const coord = await page.evaluate(async () => {
      const geo = await import('./js/geo.js');
      const r = await geo.searchPlaces('30.0444, 31.2357', undefined, null);
      return r[0] || null;
    });
    log(`${label}-coordinates`, coord?.lat === 30.0444 && coord?.lon === 31.2357,
      coord ? `${coord.title}` : 'nothing returned');
  } catch (err) {
    log(`${label}-coordinates`, false, err.message);
  }
  await context.close();

  await browser.close();
}

await mkdir(OUT, { recursive: true });
await run('mobile', { width: 390, height: 844 });
await run('desktop', { width: 1280, height: 800 }, { denyGeo: true });
await runRoute();
await runCountdown();
await runSearch();

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.filter((r) => !r.ok);
console.log(`\n${report.length - failed.length}/${report.length} passed`);
if (failed.length) console.log('failures:', failed.map((f) => f.name).join(', '));
