/**
 * state.js — everything the app remembers, in one place.
 *
 * Three objects, deliberately separate because they have different lifetimes:
 *
 *   state — what the user has CHOSEN. Survives reloads (see persistence.js).
 *   nav   — where we are along a route. Lives as long as one drive.
 *   trip  — the energy bookkeeping for the drive in progress. Reset by startTrip.
 *
 * Mutable module state shared by import is a deliberate choice here, not an
 * accident. The alternative — threading these through every function signature
 * — would add a parameter to roughly a hundred call sites and make the code
 * harder to read, not easier, for a single-page app with exactly one of each.
 */

import { CARS } from './cars.js';

/** What the user has chosen: car, trip, endpoints, route. Persisted. */
export const state = {
  carId: CARS[0].id,
  useCustom: false,
  tripMode: 'route',        // 'route' | 'manual'
  home: null,               // detected/chosen region that search is ranked around
  from: null,               // {label, lat, lon}
  to: null,
  routes: [],               // every alternative returned by the router
  selectedRoute: 0,
  route: null,              // routes[selectedRoute], for convenience
  profile: null,            // {climbM, descentM, netM, samples, minM, maxM}
  climateLevel: 'medium',
};

/** Live navigation state, separate from the trip's energy bookkeeping. */
export const nav = {
  active: false,
  follow: true,             // is the camera locked to the driver?
  voice: true,
  travelledKm: 0,
  stepIndex: -1,
  offRoute: false,
  offRouteSince: 0,
  rerouting: false,
  guide: null,              // VoiceGuide, created on first trip
};

/** Everything about the trip currently in progress. Reset by startTrip(). */
export const trip = {
  active: false,
  startedAt: 0,
  lastTickAt: 0,
  drivenKm: 0,
  usedWh: 0,          // energy the MODEL says we have consumed so far
  startSoc: 80,
  speedKmh: 0,        // smoothed speed actually used by the model
  rawSpeedKmh: 0,     // latest unsmoothed reading from the active source
  speedSource: 'gps', // 'gps' | 'manual'
  manualSpeedKmh: 100,
  lastFixAt: 0,       // when the last usable GPS fix arrived
  staleWarned: false,
  fixCount: 0,        // every position the browser delivered
  usableFixCount: 0,  // those we could actually get a speed out of
  lastAccuracy: null,
  hasDopplerSpeed: false,
  hasSeenMovement: false,  // has this device ever demonstrated it detects motion?
  smoothedDrawW: 0,        // slow-moving draw behind the headline countdown
  paused: true,            // nothing is counted until the driver says they are driving
  fellBackToManual: false, // guard: the GPS error callback fires over and over
  refFix: null,       // reference position for the movement-vs-noise test
  watchdogId: null,
  simulating: false,
  simIndex: 0,
  simMultiplier: 10,
  elapsedH: 0,        // trip time, compressed along with everything else in a sim
  lastLogAt: 0,
  calibration: 1,
  lastFix: null,
  watchId: null,
  timerId: null,
  wakeLock: null,
};

/** Presentation choices that are not about the car or the trip. Persisted. */
export const ui = {
  basemap: 'dark',    // key into navigation.js BASEMAPS
};

/**
 * ============================================================================
 * THE HOOKS SEAM — how the lower layers call upward without a cycle
 * ============================================================================
 * tracking.js needs to do two things that belong to trip.js:
 *
 *   - recompute the screen after changing the speed source  (requestTick)
 *   - resume a paused trip when the device measures movement (onMovementDetected)
 *
 * Importing trip.js from tracking.js would make the two modules circular, since
 * trip.js starts and stops the GPS. ES modules technically tolerate that, but a
 * cycle is a trap for whoever edits this next: it works until someone adds a
 * top-level statement, and then it fails in a way that is genuinely hard to
 * read.
 *
 * So the dependency is inverted instead. trip.js fills these in, tracking.js
 * only ever calls them, and the arrows all point one way. The no-op defaults
 * mean tracking.js is safe to use before — or without — trip.js.
 */
export const hooks = {
  /** Recompute and repaint the live screen right now. */
  requestTick: () => {},
  /** The device has proved the car is moving at the given speed. */
  onMovementDetected: () => {},
};

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * Never let a failure be silent again.
 *
 * The worst bug this app has had was a throw inside an async function:
 * startTrip() failed partway, the rejection went unhandled, and the trip screen
 * sat there dead with nothing reported anywhere. `window.onerror` does NOT
 * catch that — unhandled promise rejections need their own listener. Both are
 * wired up here, and both surface the problem in the diagnostics panel rather
 * than only in a console nobody has open while driving.
 */
export const bootErrors = [];

export function recordFailure(what, err) {
  const msg = err?.message || String(err);
  bootErrors.push(`${what}: ${msg}`);
  const box = document.getElementById('diagErrors');
  if (box) {
    box.classList.remove('hidden');
    box.textContent = bootErrors.slice(-3).join(' · ');
  }
}

window.addEventListener('unhandledrejection', (e) => recordFailure('Async failure', e.reason));
window.addEventListener('error', (e) => recordFailure('Error', e.error || e.message));
