/**
 * persistence.js — remembering your car, your trip and your route.
 *
 * ============================================================================
 * LOADING DOES NOT DRAW
 * ============================================================================
 * `loadSettings()` restores data and touches only the form controls that hold
 * that data. It deliberately does NOT repaint the route summary or the
 * elevation chart, even though an earlier version did.
 *
 * That is not tidiness for its own sake. Painting means calling into the
 * planner, and the planner saves settings, so the two modules would import each
 * other. Keeping "read the data" and "draw the data" apart makes the dependency
 * point one way and is the honest description of what each function does.
 * app.js calls them in order at startup.
 */

import { $ } from './dom.js';
import { cumulativeKm } from './geometry.js';
import { state, nav, ui } from './state.js';
import { findCar } from './cars.js';
import { BASEMAPS } from './navigation.js';

const KEY = 'wattsleft.settings';

/** Every form control whose raw value is worth remembering verbatim. */
const FIELD_IDS = ['soh', 'soc', 'tripKm', 'elevationM', 'reserve', 'speed',
  'temp', 'wind', 'passengers', 'cargoKg',
  'customKwh', 'customMass', 'customCd', 'customArea'];

export function saveSettings() {
  const data = {
    carId: state.carId,
    useCustom: state.useCustom,
    tripMode: state.tripMode,
    climateLevel: state.climateLevel,
    heatPump: $('customHeatPump').checked,
    home: state.home,
    from: state.from,
    to: state.to,
    basemap: ui.basemap,
    voice: nav.voice,
    // The geometry IS persisted, coordinates and all.
    //
    // An earlier version stripped it to "save space", which turned out to be a
    // serious mistake: on the next visit the route had no coordinates, and
    // starting a trip threw inside drawNavRoute(). Because startTrip() is
    // async that throw became a swallowed promise rejection, so GPS and the
    // tick loop never started and the trip screen was simply dead.
    //
    // The space worry was unfounded. A 218 km route is ~1,500 points, about
    // 25 KB at five decimal places (roughly 1 m precision) — trivial against
    // a ~5 MB localStorage budget. writeSettings() guards the edge case.
    route: state.route?.coords?.length
      ? {
          distanceKm: state.route.distanceKm,
          durationMin: state.route.durationMin,
          summary: state.route.summary,
          coords: state.route.coords.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]),
          steps: state.route.steps,
        }
      : null,
    profile: state.profile
      ? {
          climbM: state.profile.climbM, descentM: state.profile.descentM,
          netM: state.profile.netM, minM: state.profile.minM,
          maxM: state.profile.maxM, samples: state.profile.samples,
        }
      : null,
  };
  for (const id of FIELD_IDS) data[id] = $(id).value;
  writeSettings(data);
}

/**
 * Persist, and degrade sensibly if the browser refuses.
 *
 * If the payload is somehow too large — a very long route, or a browser with a
 * stingy quota — drop the geometry and retry rather than losing every setting.
 * A route without geometry is explicitly marked so the app knows to re-fetch
 * it instead of trying to navigate along coordinates that are not there.
 */
function writeSettings(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return;
  } catch { /* quota exceeded — fall through */ }

  try {
    const lean = { ...data };
    if (lean.route) lean.route = { ...lean.route, coords: null, steps: [], needsRefetch: true };
    localStorage.setItem(KEY, JSON.stringify(lean));
  } catch { /* storage unavailable entirely; the app still works in-session */ }
}

export function loadSettings() {
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* corrupt */ }
  if (!data) return;

  for (const id of FIELD_IDS) {
    if (data[id] !== undefined && $(id)) $(id).value = data[id];
  }
  if (data.heatPump !== undefined) $('customHeatPump').checked = data.heatPump;
  if (data.climateLevel) state.climateLevel = data.climateLevel;
  if (data.carId && findCar(data.carId)) state.carId = data.carId;
  state.useCustom = !!data.useCustom;
  state.home = data.home || null;
  state.from = data.from || null;
  state.to = data.to || null;
  state.profile = data.profile || null;
  if (data.basemap && BASEMAPS[data.basemap]) ui.basemap = data.basemap;
  if (data.voice !== undefined) nav.voice = data.voice;
  if (data.tripMode) state.tripMode = data.tripMode;

  restoreRoute(data.route);

  if (state.from) $('fromSearch').value = state.from.label;
  if (state.to) $('toSearch').value = state.to.label;
  $('customCarFields').classList.toggle('hidden', !state.useCustom);
}

/**
 * Rebuild state.route from what was stored.
 *
 * `cumKm` is derived rather than stored, because recomputing it is instant and
 * storing it would double the payload for no benefit.
 */
function restoreRoute(stored) {
  if (stored?.coords?.length) {
    state.route = {
      ...stored,
      coords: stored.coords,
      steps: stored.steps || [],
      cumKm: cumulativeKm(stored.coords),
      profile: state.profile,
    };
    state.routes = [state.route];
    state.selectedRoute = 0;
    return;
  }

  if (stored) {
    // Geometry was dropped (quota) or predates this version. Keep the summary
    // so the prediction still works, and flag it for re-fetching before any
    // attempt to navigate.
    state.route = {
      ...stored, coords: null, steps: [], cumKm: [],
      needsRefetch: true, profile: state.profile,
    };
    state.routes = [];
    state.selectedRoute = 0;
    return;
  }

  state.route = null;
  state.routes = [];
  state.selectedRoute = 0;
}
