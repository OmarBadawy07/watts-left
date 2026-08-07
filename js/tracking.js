/**
 * tracking.js — getting a trustworthy speed out of the Geolocation API.
 *
 * This module talks upward through `hooks` (see state.js) rather than importing
 * trip.js, because trip.js starts and stops the GPS. That keeps the dependency
 * arrows pointing one way instead of forming a cycle.
 */

import { $, numVal } from './dom.js';
import { haversineKm } from './geometry.js';
import { trip, hooks } from './state.js';

/** No usable fix for this long means GPS has effectively dropped out. */
export const STALE_FIX_MS = 12000;
/** If nothing usable arrives in this long after starting, stop waiting. */
const GPS_WATCHDOG_MS = 12000;
/** Above this, the reading is a GPS glitch rather than a car. */
const MAX_PLAUSIBLE_KMH = 200;
/** No road car changes speed faster than this (~0.34 g). */
const MAX_ACCEL_KMH_PER_S = 12;
/** Baseline needed before net displacement means anything. */
const MIN_SPEED_WINDOW_S = 6;
/** net displacement / path walked. Travel ~0.9, winding road ~0.7, jitter <0.3 */
const MIN_STRAIGHTNESS = 0.5;

/**
 * ============================================================================
 * HOW SPEED IS DERIVED, AND WHY IT IS NOT A SIMPLE ACCURACY CUTOFF
 * ============================================================================
 * There are two ways to get speed out of the Geolocation API, and they fail
 * in completely different ways.
 *
 * 1. `coords.speed` — computed by the GNSS chip from the Doppler shift of the
 *    satellite signals. Accurate, and importantly INDEPENDENT of how well the
 *    position itself is known. It is used whenever present, whatever the
 *    accuracy figure says.
 *
 * 2. Differentiating position — distance between two fixes over the time
 *    between them. This is where it gets dangerous, because the error in the
 *    result is the error in the positions divided by the time between them.
 *    Two fixes each ±850 m taken 0.7 s apart can manufacture 4000 km/h.
 *
 * The previous version guarded (2) with a hard rule: refuse any fix worse than
 * 50 m. That stopped the phantom speeds, but it also meant a laptop — whose
 * Wi-Fi positions are typically 100-300 m — had EVERY fix rejected and sat on
 * "waiting for a GPS lock" forever, with no fallback, because a coarse fix is
 * not an error and so never triggered the error path.
 *
 * The fix is to compare movement against noise instead of judging accuracy in
 * isolation. We hold a reference fix and only believe a displacement once it
 * clearly exceeds the positional uncertainty. A coarse signal simply needs a
 * longer baseline before it can say anything: at ±165 m you cannot tell 25 m
 * of movement from noise, but 400 m of movement is unmistakable. That is the
 * honest reading of the data, and it degrades gracefully instead of dying.
 */
export function startGeolocation() {
  trip.fixCount = 0;
  trip.usableFixCount = 0;
  trip.lastAccuracy = null;
  trip.hasDopplerSpeed = false;
  trip.hasSeenMovement = false;
  trip.refFix = null;

  if (!('geolocation' in navigator)) {
    fallBackToManual('This device has no location support.');
    return;
  }
  if (!window.isSecureContext) {
    // http:// on anything other than localhost. The browser will simply never
    // deliver a position, so say why instead of spinning forever.
    fallBackToManual('Location needs a secure (https) connection.');
    return;
  }

  // If nothing usable has arrived by the time this fires, stop waiting and
  // switch to manual. Without this the app can wait indefinitely for a lock
  // that the hardware is incapable of producing.
  clearTimeout(trip.watchdogId);
  trip.watchdogId = setTimeout(() => {
    if (trip.active && trip.speedSource === 'gps' && trip.usableFixCount === 0) {
      fallBackToManual(
        trip.fixCount === 0
          ? 'No GPS fix arrived.'
          : `This device reports a position but no speed (±${Math.round(trip.lastAccuracy || 0)} m) — `
            + 'it has no GPS chip.',
      );
    }
  }, GPS_WATCHDOG_MS);

  trip.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { speed, latitude, longitude, accuracy } = pos.coords;
      trip.fixCount++;
      trip.lastAccuracy = accuracy;

      if (typeof speed === 'number' && !Number.isNaN(speed)) {
        // Doppler speed: trustworthy regardless of positional accuracy.
        trip.hasDopplerSpeed = true;
        trip.rawSpeedKmh = Math.max(0, speed * 3.6);
        acceptFix(accuracy);
      } else {
        deriveSpeedFromMovement(latitude, longitude, accuracy, pos.timestamp);
      }

      trip.lastFix = { lat: latitude, lon: longitude, t: pos.timestamp, accuracy };
    },
    (err) => {
      fallBackToManual(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied.'
          : err.code === err.TIMEOUT
            ? 'GPS timed out.'
            : 'GPS unavailable on this device.',
      );
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
}

export function stopGeolocation() {
  if (trip.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(trip.watchId);
  }
  clearTimeout(trip.watchdogId);
  trip.watchId = null;
  trip.watchdogId = null;
}

/**
 * Derive speed from position when the device gives no `coords.speed`.
 *
 * ============================================================================
 * THE STRAIGHTNESS TEST
 * ============================================================================
 * The naive approach — distance between consecutive fixes over the time
 * between them — fails badly on a device without a GPS chip, because Wi-Fi
 * positioning hops between access points. A position that alternates between
 * two points 180 m apart looks EXACTLY like driving at 108 km/h if you only
 * measure consecutive pairs, and no accuracy threshold catches it: the jump is
 * four times the reported accuracy, so it looks like a confident measurement.
 *
 * What distinguishes travel from jitter is not distance, it is DIRECTION.
 * Driving accumulates displacement in a consistent direction, so the straight
 * line from start to finish is nearly as long as the path walked. Jitter goes
 * back and forth, so the path is long while the net displacement stays near
 * zero.
 *
 * So we hold a reference fix for a few seconds and compare:
 *
 *      straightness = net displacement / total path length
 *
 * Driving down a road gives ~0.9-1.0. A winding road still gives ~0.7. Jitter
 * bouncing between two points gives ~0.25 or less. Requiring 0.5 cleanly
 * separates them, and it is a physical property of travel rather than a magic
 * threshold tuned to one device.
 */
function deriveSpeedFromMovement(lat, lon, accuracy, timestamp) {
  const ref = trip.refFix;

  if (!ref) {
    trip.refFix = { lat, lon, t: timestamp, acc: accuracy, pathM: 0 };
    return;
  }

  // Accumulate the length of the path actually walked between fixes.
  if (trip.lastFix) {
    ref.pathM += haversineKm([trip.lastFix.lat, trip.lastFix.lon], [lat, lon]) * 1000;
  }

  const dt = (timestamp - ref.t) / 1000;
  if (dt < MIN_SPEED_WINDOW_S) return; // not enough baseline yet

  const netM = haversineKm([ref.lat, ref.lon], [lat, lon]) * 1000;
  const noiseM = Math.max(20, 0.75 * Math.max(accuracy, ref.acc));
  const straightness = ref.pathM > 0 ? netM / ref.pathM : 0;
  const impliedKmh = (netM / 1000 / dt) * 3600;

  const rebase = () => {
    trip.refFix = { lat, lon, t: timestamp, acc: accuracy, pathM: 0 };
  };

  if (netM > noiseM && straightness >= MIN_STRAIGHTNESS && impliedKmh <= MAX_PLAUSIBLE_KMH) {
    // Real travel. Rate-limit the change anyway: no road car alters its speed
    // by more than ~12 km/h per second.
    const maxChange = MAX_ACCEL_KMH_PER_S * dt;
    const prev = trip.rawSpeedKmh;
    trip.rawSpeedKmh = Math.max(prev - maxChange, Math.min(prev + maxChange, impliedKmh));
    trip.hasSeenMovement = true;
    rebase();
    acceptFix(accuracy);
    return;
  }

  if (trip.hasSeenMovement && netM <= noiseM) {
    // This device has proved it can detect motion, and now there is none —
    // the car really has stopped. That is information, not a failure.
    trip.rawSpeedKmh = 0;
    rebase();
    acceptFix(accuracy);
    return;
  }

  // Could not measure. Either the position is bouncing around (jitter), or the
  // device has never demonstrated it can detect movement at all — on such
  // hardware "no movement detected" means "cannot tell", not "stopped". Leave
  // the fix unaccepted so the watchdog switches to manual speed rather than
  // reporting a confident and wrong zero.
  rebase();
  if (trip.usableFixCount === 0) {
    setGpsState(
      straightness < MIN_STRAIGHTNESS && ref.pathM > noiseM
        ? 'Position jumping around — cannot measure speed from this signal'
        : `Signal ±${Math.round(accuracy)} m — need more movement to measure speed`,
      'error',
    );
  }
}

function acceptFix(accuracy) {
  trip.lastFixAt = Date.now();
  trip.usableFixCount++;
  trip.staleWarned = false;
  if (trip.speedSource === 'gps') {
    const how = trip.hasDopplerSpeed ? 'GPS' : 'GPS (from movement)';
    setGpsState(`${how} · ±${Math.round(accuracy)} m`, 'live');
  }

  // Measured movement is proof the car is being driven, so resume by itself.
  // This is why a phone user never has to think about the pause control: they
  // pull away and the trip starts counting.
  if (trip.paused && trip.rawSpeedKmh > 8) hooks.onMovementDetected();
}

/**
 * Switch to manual speed and say why.
 *
 * The previous version of this code told the user it was "using your planned
 * speed instead" and then did no such thing — the speed stayed at zero and the
 * live screen sat on "Stationary" forever. Now the fallback is real: manual
 * mode is seeded with the speed they planned for, and the control to change it
 * is right there on screen.
 */
export function fallBackToManual(reason) {
  clearTimeout(trip.watchdogId);
  setGpsState(`${reason} Using manual speed.`, 'error');

  // ONLY act once per trip.
  //
  // watchPosition's error callback fires repeatedly — the browser re-reports on
  // every timeout — and this function used to re-open the sheet each time. The
  // user would collapse it, and a second later it sprang back, so the handle
  // looked broken and the map stayed permanently buried. Collapsing a panel is
  // a decision; the app must not keep overriding it.
  if (trip.fellBackToManual) return;
  trip.fellBackToManual = true;

  trip.manualSpeedKmh = numVal('speed', 100);
  setSpeedSource('manual');
  $('manualSpeed').value = trip.manualSpeedKmh;
  syncManualSpeedLabel();
  $('speedSourceHint').textContent =
    `${reason} Set your speed below — everything else (climate, terrain, wind, `
    + 'calibration) still updates live.';
  // Open the sheet once, so the manual speed control is in front of the user
  // rather than hidden behind a handle they have not tapped.
  $('navSheet').classList.add('expanded');
}

export function setGpsState(text, cls) {
  const node = $('gpsState');
  node.textContent = text;
  node.className = `gps-state ${cls || ''}`;
}

// ---------------------------------------------------------------------------
// Speed source
// ---------------------------------------------------------------------------

/**
 * Choose between live GPS and a manually-set speed.
 *
 * Manual mode is not just a desktop testing aid. It is the honest answer
 * whenever GPS cannot be trusted: a long tunnel, an underground car park, a
 * phone that has locked its screen, or a laptop with no GPS hardware at all.
 * The prediction stays useful because the physics does not care where the
 * speed number came from.
 */
export function setSpeedSource(src) {
  trip.speedSource = src;
  $('speedSource').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.src === src);
  });
  $('manualSpeedWrap').classList.toggle('hidden', src !== 'manual');

  $('speedSourceHint').textContent = src === 'manual'
    ? 'Using the speed you set below. Everything else — climate, terrain, wind — still updates live.'
    : "Reading your phone's GPS. Needs an HTTPS connection and a device with GPS hardware.";

  if (src === 'gps') {
    trip.staleWarned = false;
    setGpsState(trip.lastFixAt ? 'GPS live' : 'Waiting for GPS…', trip.lastFixAt ? 'live' : '');
  }
  if (trip.active) hooks.requestTick();
}

export function syncManualSpeedLabel() {
  $('manualSpeedOut').textContent = `${Math.round(trip.manualSpeedKmh)} km/h`;
}

// ---------------------------------------------------------------------------
// Screen wake lock
// ---------------------------------------------------------------------------

export async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { trip.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
}

export function releaseWakeLock() {
  if (trip.wakeLock) { trip.wakeLock.release().catch(() => {}); trip.wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (trip.active && document.visibilityState === 'visible') requestWakeLock();
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Show exactly what the browser is reporting.
 *
 * "Tracking doesn't work" is unanswerable without this. It turns an opaque
 * failure into a specific one: no permission, no secure context, no speed
 * field, or a signal too coarse to measure movement against.
 */
export async function paintDiagnostics() {
  const set = (id, value, cls = '') => {
    const node = $(id);
    if (!node) return;
    node.textContent = value;
    node.className = `diag-value ${cls}`;
  };

  set('diagSecure', window.isSecureContext ? 'yes' : 'NO — geolocation blocked',
    window.isSecureContext ? 'ok' : 'bad');
  set('diagOrigin', location.origin);

  let perm = 'unknown';
  try {
    perm = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch { /* Safari and older browsers do not expose this */ }
  set('diagPermission', perm, perm === 'granted' ? 'ok' : perm === 'denied' ? 'bad' : 'warn');

  set('diagFixes', `${trip.fixCount} received, ${trip.usableFixCount} usable`,
    trip.usableFixCount > 0 ? 'ok' : trip.fixCount > 0 ? 'warn' : 'bad');
  set('diagAccuracy', trip.lastAccuracy == null ? '—' : `±${Math.round(trip.lastAccuracy)} m`,
    trip.lastAccuracy == null ? '' : trip.lastAccuracy < 50 ? 'ok' : 'warn');
  set('diagSpeedField', trip.hasDopplerSpeed ? 'yes — real GPS speed' : 'no — deriving from movement',
    trip.hasDopplerSpeed ? 'ok' : 'warn');
  set('diagSince', trip.lastFixAt ? `${((Date.now() - trip.lastFixAt) / 1000).toFixed(0)} s ago` : 'never',
    !trip.lastFixAt ? 'bad' : Date.now() - trip.lastFixAt < STALE_FIX_MS ? 'ok' : 'warn');
  set('diagSource', trip.simulating ? 'SIMULATED — not a real position' : trip.speedSource,
    trip.simulating ? 'bad' : '');

  // Reporting a problem is only half the job — say what to do about it.
  const advice = $('diagAdvice');
  if (!advice) return;

  if (trip.simulating) {
    advice.textContent = 'This is a simulated drive. The route and energy maths are real, '
      + 'but the position is synthetic — nothing is measuring where you are.';
    advice.className = 'diag-advice bad';
  } else if (!window.isSecureContext) {
    advice.textContent = 'Geolocation is blocked on insecure origins. Open the app over https '
      + '(localhost is exempt, a LAN IP like 192.168.x.x is not).';
    advice.className = 'diag-advice bad';
  } else if (perm === 'denied') {
    advice.textContent = 'Location is blocked for this site. Click the icon at the left of the '
      + 'address bar, set Location to Allow, then reload. Note that a desktop has no GPS chip, '
      + 'so even when allowed it reports a rough Wi-Fi position with no speed — real tracking '
      + 'needs a phone.';
    advice.className = 'diag-advice warn';
  } else if (trip.fixCount > 0 && trip.usableFixCount === 0) {
    advice.textContent = `Positions are arriving but are too coarse (±${Math.round(trip.lastAccuracy || 0)} m) `
      + 'to measure speed from. This is normal on a laptop, which locates itself by Wi-Fi. '
      + 'Manual speed is being used instead.';
    advice.className = 'diag-advice warn';
  } else if (trip.usableFixCount > 0 && !trip.hasDopplerSpeed) {
    advice.textContent = 'Working, but speed is being derived from how far you move between '
      + 'fixes rather than read from a GPS chip. Expect it to lag real changes in speed.';
    advice.className = 'diag-advice warn';
  } else if (trip.usableFixCount > 0) {
    advice.textContent = 'Real GPS tracking is active.';
    advice.className = 'diag-advice ok';
  } else {
    advice.textContent = 'Waiting for the first position…';
    advice.className = 'diag-advice';
  }
}
