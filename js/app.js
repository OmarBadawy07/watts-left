/**
 * app.js — startup and event wiring. No app logic lives here.
 *
 * ============================================================================
 * HOW THE MODULES FIT TOGETHER
 * ============================================================================
 * This file used to be 2,900 lines doing eight jobs at once, with a section map
 * at the top that had drifted out of step with the sections below it. It is now
 * the wiring harness and nothing else: every handler is one line that names the
 * function doing the work.
 *
 * Dependencies point strictly downward, so you can read any module without
 * chasing a cycle:
 *
 *     geometry ── physics ── cars            (pure: no DOM, no network)
 *         │         │
 *        geo    navigation                   (network: geocoder, router, tiles)
 *         └────┬────┘
 *              │
 *        dom · state                          (browser + shared state)
 *              │
 *     picker · conditions · maps · persistence
 *              │
 *        setup-screen ── planner              (the two planning screens)
 *              │
 *        tracking ── trip                     (the drive itself)
 *              │
 *            app.js                           (you are here)
 *
 * The one place an arrow would have pointed back up — tracking.js needing to
 * poke the tick loop that lives in trip.js — goes through the `hooks` object in
 * state.js instead. See the comment there.
 */

import { $, formatKm } from './dom.js';
import { state, nav, trip, ui } from './state.js';
import { CUSTOM_CAR_DEFAULTS, findCar } from './cars.js';
import { searchPlaces } from './geo.js';
import { attachPicker, attachSheetHandle } from './picker.js';
import { setBasemap, showScreen } from './maps.js';
import { carSubtitle } from './conditions.js';
import { loadSettings, saveSettings } from './persistence.js';
import { render, paintCarChoice, filterCars } from './setup-screen.js';
import {
  getBias, initHomeRegion, setHomeRegion, setTripMode, openMapScreen,
  updateClearButtons, paintPlanSheet, paintRouteSummary, paintRestoredRoute,
  applyWeather, pickPlace, swapEnds, clearEnd, useMyLocation,
} from './planner.js';
import {
  startTrip, endTrip, setClimate, setVoice, setFollow, recentreOnMe,
  setDriving, toggleSimulation, applyCalibration, tick,
} from './trip.js';
import { setSpeedSource, syncManualSpeedLabel, paintDiagnostics } from './tracking.js';

/** Choosing a car is the one setup action that is not a plain form input. */
function setCar(carId) {
  state.carId = carId;
  state.useCustom = false;
  $('customCarFields').classList.add('hidden');
  paintCarChoice();
  render();
  saveSettings();
}

function wireCarPicker() {
  attachPicker({
    input: $('carSearch'),
    list: $('carResults'),
    minChars: 1,
    debounceMs: 60, // local array, no network — can afford to be snappy
    search: (q) => filterCars(q),
    render: (car) => ({ title: car.name, sub: carSubtitle(car), kind: 'car' }),
    onPick: (car) => setCar(car.id),
    onType: updateClearButtons,
  });

  $('carSearchClear').addEventListener('click', () => {
    $('carSearch').value = '';
    updateClearButtons();
    $('carSearch').focus();
  });

  $('carClear').addEventListener('click', () => {
    $('carChip').classList.add('hidden');
    $('carField').classList.remove('hidden');
    $('carSearch').value = '';
    updateClearButtons();
    $('carSearch').focus();
  });

  $('toggleCustom').addEventListener('click', () => {
    state.useCustom = !state.useCustom;
    $('customCarFields').classList.toggle('hidden', !state.useCustom);
    if (state.useCustom) {
      // Seed the custom fields from whatever car was selected, so the user
      // starts from something close rather than a blank form.
      const car = findCar(state.carId) || CUSTOM_CAR_DEFAULTS;
      if (!$('customKwh').value) $('customKwh').value = car.usableKwh;
      if (!$('customMass').value) $('customMass').value = car.massKg;
      if (!$('customCd').value) $('customCd').value = car.cd;
      if (!$('customArea').value) $('customArea').value = car.areaM2;
      $('customHeatPump').checked = car.heatPump;
    }
    paintCarChoice();
    render();
    saveSettings();
  });
}

function wirePlacePickers() {
  for (const which of ['from', 'to']) {
    attachPicker({
      input: $(`${which}Search`),
      list: $(`${which}Results`),
      minChars: 2,
      debounceMs: 250,
      showLoading: true,
      search: (q, signal) => searchPlaces(q, signal, getBias(which)),
      render: (place) => ({
        title: place.title,
        sub: place.subtitle,
        kind: place.kind,
        meta: place.distanceKm !== undefined ? formatKm(place.distanceKm) : undefined,
      }),
      // Shown when the field is empty, so the common cases are one tap away.
      quickActions: () => {
        const quick = [];
        if (which === 'from') {
          quick.push({
            __quick: 'gps', title: 'Use my current location',
            subtitle: 'Needs GPS and an HTTPS connection', kind: 'pin',
          });
        }
        if (state.home) {
          quick.push({
            ...state.home,
            __quick: 'home',
            subtitle: state.home.subtitle || 'Your area',
          });
        }
        return quick;
      },
      onPick: (item) => {
        if (item.__quick === 'gps') { useMyLocation(); return; }
        pickPlace(which, item);
      },
      onType: updateClearButtons,
    });
    $(`${which}Clear`).addEventListener('click', () => clearEnd(which));
  }

  // Region search is deliberately NOT biased — someone correcting a wrong
  // guess is, by definition, somewhere the current guess is not.
  attachPicker({
    input: $('regionSearch'),
    list: $('regionResults'),
    minChars: 2,
    showLoading: true,
    search: (q, signal) => searchPlaces(q, signal, null),
    render: (place) => ({ title: place.title, sub: place.subtitle, kind: place.kind }),
    onPick: (place) => setHomeRegion(place),
  });

  $('changeRegion').addEventListener('click', () => {
    $('regionRow').classList.add('hidden');
    $('regionEditor').classList.remove('hidden');
    $('regionSearch').focus();
  });
  $('regionCancel').addEventListener('click', () => {
    $('regionEditor').classList.add('hidden');
    $('regionRow').classList.remove('hidden');
    $('regionSearch').value = '';
  });
}

function wireMapScreen() {
  $('openMap').addEventListener('click', openMapScreen);
  $('mapBack').addEventListener('click', () => showScreen('setup'));
  $('useRoute').addEventListener('click', () => showScreen('setup'));
  $('startNav').addEventListener('click', () => { showScreen('setup'); startTrip(); });
  $('swapEnds').addEventListener('click', swapEnds);
  $('useMyLocation').addEventListener('click', useMyLocation);
  $('locateBtn').addEventListener('click', useMyLocation);

  $('layerBtn').addEventListener('click', () => {
    $('layerMenu').classList.toggle('hidden');
  });
  $('layerMenu').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-basemap]');
    if (!btn) return;
    // setBasemap does not persist by itself — that keeps maps.js and
    // persistence.js from importing each other. A deliberate choice is saved
    // here; the restore-on-load pass below is not.
    setBasemap(btn.dataset.basemap);
    saveSettings();
    $('layerMenu').classList.add('hidden');
  });

  $('useWeather').addEventListener('change', () => {
    if ($('useWeather').checked) {
      applyWeather().then(render);
    } else {
      $('tempAuto').classList.add('hidden');
      $('windAuto').classList.add('hidden');
      $('weatherState').textContent = '';
    }
  });
}

function wireLiveScreen() {
  $('navRecenter').addEventListener('click', recentreOnMe);
  $('navVoice').addEventListener('click', () => { setVoice(!nav.voice); saveSettings(); });
  $('driveToggle').addEventListener('click', () => setDriving(trip.paused));
  $('endTrip').addEventListener('click', endTrip);
  $('applyCalibration').addEventListener('click', applyCalibration);

  $('simToggle').addEventListener('click', toggleSimulation);
  $('simMult').addEventListener('input', () => {
    trip.simMultiplier = parseFloat($('simMult').value) || 1;
    $('simMultOut').textContent = `${trip.simMultiplier}×`;
  });

  $('speedSource').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-src]');
    if (btn) setSpeedSource(btn.dataset.src);
  });
  $('manualSpeed').addEventListener('input', () => {
    trip.manualSpeedKmh = parseFloat($('manualSpeed').value) || 0;
    syncManualSpeedLabel();
    if (trip.active) tick();
  });
}

function wireSharedControls() {
  $('tripMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) setTripMode(btn.dataset.mode);
  });

  for (const group of ['climateSetup', 'climateLive']) {
    $(group).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-climate]');
      if (btn) { setClimate(btn.dataset.climate); saveSettings(); }
    });
  }

  // Any change on the setup screen re-runs the prediction immediately. Manual
  // edits to temperature or wind clear the "auto" badge, because the value is
  // no longer what the weather service said.
  $('screen-setup').addEventListener('input', (e) => {
    if (e.target.id === 'temp') $('tempAuto').classList.add('hidden');
    if (e.target.id === 'wind') $('windAuto').classList.add('hidden');
    render();
    saveSettings();
  });

  $('startTrip').addEventListener('click', startTrip);

  attachSheetHandle($('planSheetHandle'), $('planSheet'));
  // The diagnostics panel only refreshes while visible, so it repaints on open.
  attachSheetHandle($('navSheetHandle'), $('navSheet'), paintDiagnostics);
}

function init() {
  // Read the saved data first, then draw it. Keeping those two steps apart is
  // what lets persistence.js stay independent of the screens — see the note at
  // the top of that file.
  loadSettings();
  paintRestoredRoute();

  wireCarPicker();
  wirePlacePickers();
  wireMapScreen();
  wireLiveScreen();
  wireSharedControls();

  paintCarChoice();
  updateClearButtons();
  setTripMode(state.tripMode);
  setClimate(state.climateLevel);
  setBasemap(ui.basemap);
  setVoice(nav.voice);
  setFollow(true);
  paintRouteSummary();
  paintPlanSheet();
  render();

  // Fire and forget: search must be usable the moment the app opens, but a
  // failed region lookup must never stop the rest of the app working.
  initHomeRegion();
}

init();

// ---------------------------------------------------------------------------
// Service worker — installable and usable offline.
//
// The model runs entirely on-device, so once cached there is nothing to fetch.
// (Route search still needs a connection; it degrades to manual entry.)
//
// NOT registered on localhost. The worker is cache-first, which is right for
// the product but poison for development: every edit appears to do nothing
// until you bump the cache name, and it is very easy to spend an hour
// debugging code the browser is not actually running. Deployed over HTTPS —
// which is required for the GPS anyway — it registers normally and the app is
// fully installable and offline-capable.
// ---------------------------------------------------------------------------
const isLocalDev = ['localhost', '127.0.0.1', ''].includes(location.hostname);

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isLocalDev) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
} else if (isLocalDev && 'serviceWorker' in navigator) {
  // Clean up any worker left behind by an earlier visit, so a stale cache from
  // a previous session cannot keep shadowing local edits.
  navigator.serviceWorker.getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
}
