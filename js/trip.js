/**
 * trip.js — the drive itself: the 1 Hz loop, the live screen, and navigation.
 *
 * Everything on the live screen is derived once per second from three inputs:
 * the current speed, where we are along the route, and how much energy the
 * model says has been spent. Nothing on that screen is stored twice.
 */

import { $, el, numVal, setVerdict, publishBottomEdge } from './dom.js';
import { state, nav, trip, hooks } from './state.js';
import {
  C, predict, availableEnergyWh, updateCalibration, climatePowerW,
  formatDuration, clockTimeIn,
} from './physics.js';
import { fetchElevationProfile } from './geo.js';
import {
  fetchRoutes, MANEUVER_PATHS, locateOnRoute, currentGuidance, VoiceGuide,
  formatDistance as formatNavDistance, arrivalClock,
} from './navigation.js';
import {
  maps, drawNavRoute, updateNavCamera, recentreNav, showScreen,
} from './maps.js';
import { readConditions } from './conditions.js';
import {
  render, climateDescription, speedAdvice, advicePara, paintClimateCosts,
} from './setup-screen.js';
import { paintDirections } from './planner.js';
import {
  STALE_FIX_MS, startGeolocation, stopGeolocation, setGpsState, setSpeedSource,
  syncManualSpeedLabel, requestWakeLock, releaseWakeLock, paintDiagnostics,
} from './tracking.js';

// ---------------------------------------------------------------------------
// 1. Starting and stopping
// ---------------------------------------------------------------------------

/**
 * Tear down everything a running trip owns.
 *
 * Split out of endTrip() so that startTrip() can call it too. Without this,
 * pressing Start twice left the first 1 Hz loop running and started a second
 * one — and because every loop adds its own `drawW * dt` to the energy total,
 * the battery drained at N times real speed. The visible symptom was the
 * "battery empty in" figure racing down and the predicted empty-time clock
 * walking BACKWARDS, which is impossible with a single loop: energy falls at
 * exactly the rate the clock advances, so the predicted moment stays put.
 *
 * It is easy to hit: "Start navigation" on the map returns you to the setup
 * screen, where "Start trip & navigate" is sitting right there.
 */
export function stopTripLoops() {
  if (trip.timerId) clearInterval(trip.timerId);
  trip.timerId = null;
  stopGeolocation();
}

export async function startTrip() {
  // Starting is idempotent: never leave a previous loop running.
  stopTripLoops();
  const cond = readConditions();

  trip.active = true;
  trip.startedAt = Date.now();
  trip.lastTickAt = Date.now();
  trip.lastLogAt = Date.now();
  trip.elapsedH = 0;
  trip.drivenKm = 0;
  trip.usedWh = 0;
  trip.startSoc = cond.socPercent;
  trip.speedKmh = 0;
  trip.rawSpeedKmh = 0;
  trip.calibration = 1;
  trip.lastFix = null;
  trip.lastFixAt = 0;
  trip.staleWarned = false;
  trip.fellBackToManual = false;

  // Start optimistic: try GPS, and seed manual mode with the planned speed so
  // the fallback is instantly usable if GPS never arrives.
  trip.manualSpeedKmh = cond.speedKmh;
  $('manualSpeed').value = cond.speedKmh;
  syncManualSpeedLabel();
  setSpeedSource('gps');

  $('calibrationState').textContent = 'No correction applied yet.';
  setClimate(state.climateLevel);

  // Begin paused. Nothing is counted until there is a reason to believe the
  // car is moving — either the driver says so, or the device measures it.
  setDriving(false, 'Nothing is being counted yet');

  nav.follow = true;
  nav.travelledKm = 0;
  nav.stepIndex = -1;
  nav.offRoute = false;
  nav.rerouting = false;
  nav.active = false;
  if (!nav.guide) nav.guide = new VoiceGuide();
  nav.guide.reset();

  showScreen('live', { onNavDrag: () => { if (nav.active) setFollow(false); } });

  // ---- Start the parts that must never fail, first ------------------------
  // The energy monitor is the app's core job and does not depend on
  // navigation, so it starts before anything that can throw. An earlier
  // version set navigation up first; when that threw, GPS and the tick loop
  // below never started and the entire screen was dead with no error shown.
  startGeolocation();
  requestWakeLock();
  trip.timerId = setInterval(tick, 1000);

  // ---- Then try to add navigation on top ----------------------------------
  try {
    if (state.tripMode === 'route' && state.route) {
      // A route restored from a previous session may have lost its geometry.
      // Fetch it again rather than trying to navigate along nothing.
      if (!state.route.coords?.length && state.from && state.to) {
        $('navInstr').textContent = 'Loading your route…';
        const routes = await fetchRoutes([state.from, state.to], false);
        routes[0].profile = state.route.profile || null;
        state.route = routes[0];
        state.routes = routes;
        state.selectedRoute = 0;
      }
      if (state.route.coords?.length) {
        nav.active = true;
        drawNavRoute();
        paintDirections(0);
      }
    }
  } catch {
    // Navigation is a bonus; losing it must not cost the driver their range
    // prediction. Say so plainly instead of failing silently.
    nav.active = false;
    setGpsState('Could not load turn-by-turn directions — tracking energy only.', 'error');
  }

  paintNavBanner(null);
  tick();
}

export function endTrip() {
  trip.active = false;
  nav.active = false;
  trip.simulating = false;
  syncSimUI();
  stopTripLoops();
  nav.guide?.reset();
  releaseWakeLock();
  showScreen('setup');
  render();
}

// ---------------------------------------------------------------------------
// 2. Navigation mode
// ---------------------------------------------------------------------------

export function setFollow(on) {
  nav.follow = on;
  $('navRecenter').classList.toggle('on', on);
}

export function setVoice(on) {
  nav.voice = on;
  $('navVoice').classList.toggle('off', !on);
  $('navVoice').classList.toggle('on', on);
  if (!on) window.speechSynthesis?.cancel();
}

/** Jump the camera back to the driver and resume following. */
export function recentreOnMe() {
  setFollow(true);
  if (trip.lastFix) recentreNav(trip.lastFix.lat, trip.lastFix.lon);
}

/**
 * Advance navigation for the current GPS position.
 *
 * Called from the 1 Hz tick. Everything here is derived from one number — how
 * far along the route we are — which keeps guidance, the map overlay and the
 * remaining-distance figure all consistent with each other.
 */
function updateNavigation(position, speedKmh) {
  if (!nav.active || !position) return null;
  if (!state.route?.coords?.length || !state.route.steps?.length) return null;

  const loc = locateOnRoute(state.route, position, nav.travelledKm);

  // Off-route: only react after a few seconds of being genuinely away from the
  // line. A single bad fix, a parallel service road or a multi-level junction
  // will all momentarily read as "off route", and rerouting on every one of
  // those would be maddening.
  const OFF_ROUTE_M = 60;
  if (loc.offRouteM > OFF_ROUTE_M) {
    if (!nav.offRouteSince) nav.offRouteSince = Date.now();
    if (Date.now() - nav.offRouteSince > 6000 && !nav.rerouting) reroute(position);
    nav.offRoute = true;
  } else {
    nav.offRouteSince = 0;
    nav.offRoute = false;
    nav.travelledKm = loc.travelledKm;
  }

  const g = currentGuidance(state.route, nav.travelledKm);

  if (nav.voice) {
    nav.guide.update(g.stepIndex + 1, g.upcoming.instruction, g.distanceToManeuverM, speedKmh);
  }
  if (g.stepIndex !== nav.stepIndex) {
    nav.stepIndex = g.stepIndex;
    paintDirections(g.stepIndex + 1);
  }

  paintNavBanner(g);
  updateNavCamera(position, loc);

  return { guidance: g, loc };
}

/** Ask the router for a fresh route from where the driver actually is. */
async function reroute(position) {
  nav.rerouting = true;
  $('navBanner').classList.add('rerouting');
  $('navInstr').textContent = 'Off route — finding a new way…';

  try {
    const routes = await fetchRoutes(
      [{ lat: position[0], lon: position[1] }, state.to], false,
    );
    state.routes = routes;
    state.selectedRoute = 0;
    state.route = routes[0];
    // The new route starts where we are, so progress along it resets.
    nav.travelledKm = 0;
    nav.stepIndex = -1;
    nav.guide.reset();
    // Terrain for the new route matters — the remaining climb changes the
    // energy prediction, which is the whole reason this app exists.
    try {
      state.route.profile = await fetchElevationProfile(state.route.coords, state.route.distanceKm);
      state.profile = state.route.profile;
    } catch { /* keep going without terrain */ }
    drawNavRoute();
    paintDirections(0);
    nav.guide.say('Route updated', { force: true });
  } catch {
    $('navInstr').textContent = 'Off route — could not find a new route.';
  } finally {
    nav.rerouting = false;
    $('navBanner').classList.remove('rerouting');
  }
}

/**
 * The big next-turn banner, plus the smaller "then…" line under it.
 *
 * Every exit from this function republishes `--nav-top-h`, because the height
 * of this block is what the SIMULATED badge positions itself below.
 */
function paintNavBanner(g) {
  try {
    return paintNavBannerInner(g);
  } finally {
    publishBottomEdge([$('navBanner'), $('navThen')], $('screen-live'), '--nav-top-h');
  }
}

function paintNavBannerInner(g) {
  // The banner is never hidden, even with no route to guide along: it carries
  // the end-trip button, and hiding it stranded the driver on a screen with no
  // way out. Without a route it becomes a plain energy-monitor header.
  $('navThen').classList.add('hidden');

  if (!nav.active) {
    $('navArrow').innerHTML = MANEUVER_PATHS.depart;
    $('navDist').textContent = 'Live';
    $('navInstr').textContent = state.tripMode === 'manual'
      ? 'Energy monitor — no route to navigate'
      : 'Plan a route to get turn-by-turn directions';
    return;
  }

  if (!g) {
    $('navArrow').innerHTML = MANEUVER_PATHS.depart;
    $('navDist').textContent = '—';
    // Be specific about WHY there is no guidance. "Waiting for GPS…" while
    // running a simulation, or while already on manual speed, is simply false.
    $('navInstr').textContent = trip.simulating
      ? 'Simulated drive — starting…'
      : trip.speedSource === 'manual'
        ? 'No live position — manual speed'
        : 'Waiting for GPS…';
    return;
  }
  $('navThen').classList.remove('hidden');

  $('navArrow').innerHTML = MANEUVER_PATHS[g.upcoming.icon] || MANEUVER_PATHS.straight;
  $('navDist').textContent = formatNavDistance(g.distanceToManeuverM);
  $('navInstr').textContent = g.upcoming.instruction;

  const after = state.route.steps[g.stepIndex + 2];
  $('navThen').classList.toggle('hidden', !after);
  if (after) {
    $('navThen').replaceChildren();
    $('navThen').append('then ', el('b', null, after.instruction));
  }
}

// ---------------------------------------------------------------------------
// 3. Simulated drive
// ---------------------------------------------------------------------------

/**
 * Drive the planned route without a car.
 *
 * This exists because the app is almost impossible to develop or demonstrate
 * otherwise: a laptop has no GPS, and the only way to see turn-by-turn, voice
 * guidance and the battery countdown working together was to actually get in a
 * car. It walks a synthetic position along the real route geometry at the
 * planned speed times a multiplier.
 *
 * It is deliberately loud about being fake — a red SIMULATED badge sits over
 * the map — because a range prediction the driver believes is live, but is
 * not, would be genuinely dangerous.
 */
export function startSimulation() {
  if (!state.route?.coords?.length) {
    setGpsState('Plan a route first — there is nothing to simulate.', 'error');
    return;
  }
  clearTimeout(trip.watchdogId);
  trip.simulating = true;
  trip.simIndex = 0;
  // A simulated drive is a drive: it must actually count, or there is nothing
  // to watch.
  if (trip.paused) setDriving(true, 'Simulated drive running');
  syncSimUI();
  $('navSheet').classList.remove('expanded');
  setGpsState('Simulated drive — not a real position', 'error');
  nav.guide?.reset();
}

export function stopSimulation() {
  trip.simulating = false;
  syncSimUI();
  setGpsState('Simulation stopped', '');
}

export function toggleSimulation() {
  if (trip.simulating) stopSimulation(); else startSimulation();
}

/**
 * Keep every simulation-related control telling the same story.
 *
 * The simulation can end on its own when it reaches the destination, and when
 * it did, the badge disappeared but the button still read "Stop simulation"
 * while the diagnostics said "manual" — three controls describing three
 * different states. Anything that can change `trip.simulating` now routes
 * through here, and the tick calls it too, so self-completion cannot leave the
 * UI lying.
 */
function syncSimUI() {
  const on = trip.simulating;
  $('simBadge').classList.toggle('hidden', !on);
  $('simToggle').textContent = on ? 'Stop simulation' : 'Simulate this drive';
  $('simToggle').classList.toggle('on', on);
}

/**
 * Advance the simulated position by one tick.
 * @param {number} dtH hours elapsed since the previous tick
 */
function stepSimulation(dtH) {
  const route = state.route;
  if (!route?.coords?.length) return;

  // The speed the simulated CAR is doing — taken from the live screen's manual
  // control, not the setup slider, so the control the driver can actually see
  // and move is the one that steers the simulation.
  const carSpeedKmh = trip.manualSpeedKmh > 0 ? trip.manualSpeedKmh : numVal('speed', 100);

  // The multiplier compresses TIME, not the car: position, distance, energy and
  // elapsed time are all scaled by it, so the drive stays physically coherent.
  const stepKm = carSpeedKmh * trip.simMultiplier * dtH;

  // Walk forward along the polyline by the distance covered.
  let target = nav.travelledKm + stepKm;
  if (target >= route.distanceKm) target = route.distanceKm;

  let i = trip.simIndex;
  while (i < route.cumKm.length - 1 && route.cumKm[i + 1] < target) i++;
  trip.simIndex = i;

  // The synthetic position IS needed — the map, the camera and the turn-by-turn
  // guidance all read trip.lastFix. But it must not be counted as a GPS fix:
  // inflating usableFixCount made the diagnostics panel report working GPS on a
  // machine with no GPS at all, and that panel exists precisely to tell the
  // truth about the signal.
  const p = route.coords[Math.min(i, route.coords.length - 1)];
  trip.lastFix = { lat: p[0], lon: p[1], t: Date.now(), accuracy: 5 };
  trip.rawSpeedKmh = carSpeedKmh;

  if (target >= route.distanceKm) {
    trip.simulating = false;
    syncSimUI();
    setGpsState('Simulated drive complete', '');
  }
}

// ---------------------------------------------------------------------------
// 4. Driving vs paused
// ---------------------------------------------------------------------------

/**
 * Whether the car is actually being driven.
 *
 * ============================================================================
 * WHY A TRIP STARTS PAUSED
 * ============================================================================
 * The app used to assume that pressing "Start" meant you were driving, and
 * began draining the battery at your planned speed immediately. On a laptop —
 * which cannot measure movement at all — that produced a battery countdown
 * racing away while the user sat at a desk, with no way to tell the app it was
 * wrong. It was inventing consumption that never happened.
 *
 * So a trip now begins paused. Nothing accumulates: no energy, no distance, no
 * elapsed time. The numbers still update, but as a PROJECTION — "at this speed
 * the battery would last 24 h" — which is genuinely useful while parked,
 * because you can see what turning the AC up or slowing down would cost before
 * you set off.
 *
 * If the device can actually measure movement, driving off resumes it
 * automatically, so a phone user never has to think about this.
 */
export function setDriving(on, reason = '') {
  trip.paused = !on;

  const btn = $('driveToggle');
  btn.classList.toggle('driving', on);
  btn.classList.toggle('paused', !on);
  $('driveLabel').textContent = on ? 'Pause' : 'Start driving';
  $('driveSub').textContent = on
    ? (reason || 'Counting energy and distance')
    : (reason || 'Nothing is being counted yet');

  // Pause icon when driving, play icon when paused.
  btn.querySelector('.drive-icon').innerHTML = on
    ? '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>'
    : '<path d="M8 5l11 7-11 7z"/>';

  // A manual speed is a stated intention, not a noisy measurement, so when
  // driving starts there is nothing to smooth — jump straight to it. This also
  // removes the startup ramp that made the headline appear to plummet.
  if (on && trip.speedSource === 'manual' && !trip.simulating) {
    trip.speedKmh = trip.manualSpeedKmh;
  }

  if (trip.active) tick();
}

// ---------------------------------------------------------------------------
// 5. The live tick
// ---------------------------------------------------------------------------

export function tick() {
  const now = Date.now();
  const dtH = (now - trip.lastTickAt) / 3600000;
  trip.lastTickAt = now;

  // --- Where does the speed come from? ------------------------------------
  if (trip.simulating) {
    stepSimulation(dtH);
  } else if (trip.speedSource === 'manual') {
    trip.rawSpeedKmh = trip.manualSpeedKmh;
  } else if (trip.lastFixAt && now - trip.lastFixAt > STALE_FIX_MS) {
    // GPS has gone quiet — a tunnel, a multi-storey car park, or the browser
    // suspending updates because the screen locked. Hold the last known speed
    // rather than pretending we have stopped (which would make the prediction
    // lurch), but say so, because a held value is not a measurement.
    if (!trip.staleWarned) {
      trip.staleWarned = true;
      setGpsState('No GPS fix for a while — holding last known speed', 'error');
    }
  }

  // A stated speed — manual or simulated — is an intention, not a noisy
  // measurement, so it is used directly. Smoothing produced a slow ramp from
  // zero that made the headline appear to plummet for the first half-minute.
  //
  // For a simulation it was worse than cosmetic. stepSimulation() advances the
  // position at the full speed immediately while the smoothed value was still
  // climbing, so `trip.drivenKm` (from the smoothed speed) and
  // `nav.travelledKm` (from walking the polyline) disagreed about how far the
  // same drive had gone. Only a measurement gets smoothed.
  if (trip.simulating || trip.speedSource === 'manual') {
    trip.speedKmh = trip.rawSpeedKmh;
  } else {
    // Exponential moving average smooths GPS jitter without much lag. alpha=0.3
    // settles in 8-10 seconds: responsive when you accelerate, steady at cruise.
    trip.speedKmh += 0.3 * (trip.rawSpeedKmh - trip.speedKmh);
  }
  const v = trip.speedKmh < 2 ? 0 : trip.speedKmh;

  // --- Is anything actually being consumed? --------------------------------
  // While paused nothing accumulates. The figures below still update, but as a
  // projection of what WOULD happen at this speed — never as a claim about
  // energy the car has spent.
  //
  // A simulated drive compresses time: position advances at `simMultiplier`
  // times real speed, so distance and energy must be compressed by the SAME
  // factor or the simulation becomes physically incoherent.
  const effDtH = trip.paused
    ? 0
    : (trip.simulating ? dtH * trip.simMultiplier : dtH);

  const base = readConditions();
  trip.drivenKm += v * effDtH;

  // --- Navigation ----------------------------------------------------------
  const navResult = trip.lastFix
    ? updateNavigation([trip.lastFix.lat, trip.lastFix.lon], v)
    : null;
  // Repaint whenever there is NO guidance, not only when navigation is off.
  // Previously a route with no position left the banner frozen on whatever it
  // last said — which is how it ended up claiming "Waiting for GPS…" during a
  // simulation that had already finished.
  if (!navResult) paintNavBanner(null);
  syncSimUI();

  // Remaining distance now has a much better source than dead reckoning: when
  // navigating we know exactly where on the route the driver is, so a detour,
  // a wrong turn or a traffic queue no longer corrupts the figure.
  const remainingKm = nav.active && navResult
    ? Math.max(0, state.route.distanceKm - nav.travelledKm)
    : Math.max(0, base.tripKm - trip.drivenKm);

  // Scale the terrain still ahead in proportion to the distance left.
  const totalKm = nav.active && state.route ? state.route.distanceKm : base.tripKm;
  const frac = totalKm > 0 ? remainingKm / totalKm : 0;

  // ==========================================================================
  // WHICH SPEED THE PROJECTION USES WHILE PAUSED
  // ==========================================================================
  // Nothing is being measured while paused, so projecting at the MEASURED
  // speed means projecting at zero — which produced a headline of "67 h" that
  // then had to collapse to "2 h 46 m" the moment driving began. Two different
  // questions were sharing one giant number.
  //
  // Paused, the useful question is "what will this trip cost at the speed I
  // intend to hold?", so the projection uses the planned speed. Pressing Start
  // driving then changes the LABEL, not the figure, and there is nothing to
  // fall from. The genuinely useful parked-with-the-AC-on number has not been
  // lost — it moves to the advice line below, where it reads as a fact rather
  // than a countdown.
  // There is a third state besides paused and driving: DRIVING BUT NOT YET
  // MEASURING. Pressing Start driving before the first GPS fix arrives used to
  // show a confident 0 km/h for the eight seconds until the watchdog gave up.
  // Zero is not what the car is doing; it is what we do not know yet. So the
  // planned speed stands in, and the label says so rather than pretending.
  const plannedKmh = trip.manualSpeedKmh > 0 ? trip.manualSpeedKmh : numVal('speed', 100);
  const speedKnown = trip.simulating
    || trip.speedSource === 'manual'
    || trip.usableFixCount > 0;
  const assuming = !trip.paused && !speedKnown;
  const vShown = (trip.paused || assuming) ? plannedKmh : v;

  const live = {
    ...base,
    speedKmh: vShown,
    tripKm: remainingKm,
    elevationM: base.elevationM * frac,
    climbM: base.climbM == null ? null : base.climbM * frac,
    descentM: base.descentM == null ? null : base.descentM * frac,
    socPercent: currentSoc(base),
    calibration: trip.calibration,
  };

  const p = predict(live);

  // When stationary the "per kilometre" framing is meaningless, so bill only
  // the genuine per-hour loads. That is a useful readout in itself: "parked
  // with the AC on, you have 9 hours".
  const idleW = climatePowerW(base.climateLevel, base.tempC, base.car.heatPump, base.occupants)
              + C.BASELINE_AUX_W;
  const drawW = vShown === 0 ? idleW : p.powerKw * 1000;
  // effDtH is 0 while paused, so a projected speed can never invent energy.
  trip.usedWh += drawW * effDtH;

  // ==========================================================================
  // THE HEADLINE COUNTDOWN, AND THE TWO BUGS THAT SHAPED IT
  // ==========================================================================
  // FIRST BUG — smoothing the draw. The headline is `energy / draw`, so the
  // draw is a DENOMINATOR: a slowly-rising denominator makes the headline fall
  // hyperbolically, fastest at the start. Pressing "Start driving" at 110 km/h
  // took the draw from 0.7 kW to 17.2 kW instantly, but a 30-second average
  // crawled between the two — and the headline shed SIX HOURS PER SECOND while
  // the kW tile sat perfectly still at 17.2:
  //
  //     67h 45m -> 27h 46m -> 21h 39m -> 17h 51m -> 15h 15m ...
  //
  // The smoothing had been added to stop the headline jumping. It turned one
  // honest instant jump into a half-minute freefall that looked far worse.
  //
  // The rule that holds: smooth a MEASUREMENT, never a STATEMENT. Manual and
  // simulated speeds are stated intentions and are exact. GPS speed is a
  // measurement and is ALREADY smoothed above at alpha 0.3, so anything
  // derived from it is smooth too. A second stage bought nothing, and it is
  // now gone entirely — this is just the model's own answer.
  //
  // SECOND BUG — the model's own answer was wrong whenever the route climbed,
  // because range divided the whole battery by a Wh/km that had the route's
  // hill baked into it. predict() now covers the route at the route's cost and
  // continues on the flat beyond it, so take the figure straight from there.
  renderLive(live, p, vShown, drawW, idleW, remainingKm, assuming);
}

/** SoC right now = what we started with, minus what the model says we used. */
function currentSoc(cond) {
  const { fullWh } = availableEnergyWh(cond.car, 100, cond.sohPercent, cond.tempC);
  return Math.max(0, trip.startSoc - (trip.usedWh / fullWh) * 100);
}

// ---------------------------------------------------------------------------
// 6. Live screen rendering
// ---------------------------------------------------------------------------

function renderLive(cond, p, v, drawW, idleW, remainingKm, assuming = false) {
  const soc = cond.socPercent;
  const { fullWh } = availableEnergyWh(cond.car, 100, cond.sohPercent, cond.tempC);
  const remainingWh = fullWh * (soc / 100);

  // Standing still, "per kilometre" means nothing and the only thing draining
  // the pack is the climate system and the electronics — so that is the honest
  // denominator. Moving, predict() has already worked out how far this charge
  // goes over the route and the level ground beyond it.
  const hoursToEmpty = v === 0
    ? (idleW > 0 ? remainingWh / idleW : Infinity)
    : p.hoursToEmpty;

  $('lTimeToEmpty').textContent = formatDuration(hoursToEmpty);
  $('lEmptyClock').textContent = clockTimeIn(hoursToEmpty);
  $('lSpeed').textContent = v === 0 ? '0' : Math.round(v);
  $('lWhKm').textContent = v === 0 ? '—' : Math.round(p.whPerKm);
  $('lPower').textContent = (drawW / 1000).toFixed(1);
  $('lRemaining').textContent = remainingKm.toFixed(0);
  $('lSoc').textContent = soc.toFixed(0);
  const arrivalSoc = remainingKm <= 0
    ? Math.round(soc)
    : (p.arrivalSoc > 0 ? Math.round(p.arrivalSoc) : 0);
  $('lArrival').textContent = arrivalSoc;
  $('lUsed').textContent = (trip.usedWh / 1000).toFixed(1);

  // --- The ETA strip at the top of the sheet -------------------------------
  // Estimated from the driver's actual current speed rather than the router's
  // free-flow figure, because that is the number that reflects the traffic they
  // are genuinely sitting in.
  const etaMin = v > 3 ? (remainingKm / v) * 60 : Infinity;
  $('navEtaTime').textContent = arrivalClock(etaMin);
  $('navEtaLeft').textContent = remainingKm >= 10
    ? `${Math.round(remainingKm)} km`
    : `${remainingKm.toFixed(1)} km`;

  const batteryTile = $('navBatteryTile');
  batteryTile.classList.toggle('bad', arrivalSoc <= 0);
  batteryTile.classList.toggle('tight', arrivalSoc > 0 && arrivalSoc < cond.reservePercent);

  // --- Countdown, or projection? -------------------------------------------
  // While paused this is not a countdown at all — nothing is draining — so it
  // must not be labelled as one. Saying "battery empty in 24 h" while the car
  // sits on a driveway is simply false.
  const hero = $('hero');
  hero.classList.toggle('paused', trip.paused);
  hero.classList.toggle('bad', !trip.paused && hoursToEmpty < 0.5);
  hero.classList.toggle('warn', !trip.paused && hoursToEmpty >= 0.5 && hoursToEmpty < 1);

  // Paused, the figure is a projection at the speed you intend to hold — the
  // same number you will see the moment you set off, so nothing jumps. Driving
  // and genuinely stopped (a red light, a queue), it is the parked figure.
  $('heroLabel').textContent = trip.paused
    ? `At ${Math.round(v)} km/h the battery would last`
    : assuming
      ? `Assuming ${Math.round(v)} km/h — battery empty in`
      : v < 2
        ? 'Stopped — the battery would last'
        : 'Battery empty in';
  $('heroClock').style.visibility = trip.paused ? 'hidden' : 'visible';
  $('speedTileLabel').textContent = (trip.paused || assuming) ? 'km/h assumed' : 'km/h now';

  const vEl = $('lVerdict');
  if (trip.paused) {
    setVerdict(vEl, 'tight',
      'Paused — nothing is being counted. Press <strong>Start driving</strong> when you set off.');
    // The parked-with-the-climate-on figure is genuinely useful — waiting in
    // the car is a real thing people do — but it belongs here as a fact, not
    // in the headline where it reads as a countdown and has to collapse by
    // sixty hours the moment you set off.
    const parkedHours = idleW > 0 ? (fullWh * (soc / 100)) / idleW : Infinity;
    $('lAdvice').innerHTML = advicePara(
      `A projection at ${Math.round(v)} km/h — change the speed or climate above to see the `
      + `effect before you leave. Sitting still with the climate on, this charge would last `
      + `<strong>${formatDuration(parkedHours)}</strong>.`);
    $('climateLiveHint').textContent = climateDescription({ ...cond, speedKmh: Math.max(3, v) });
    paintClimateCosts(cond, 'climateLive', Math.max(3, v));
    paintTripLog();
    if ($('navSheet').classList.contains('expanded')) paintDiagnostics();
    return;
  }

  if (remainingKm <= 0.2) {
    setVerdict(vEl, 'ok', `Arrived. <strong>${soc.toFixed(0)}%</strong> left in the battery.`);
    $('lAdvice').innerHTML = '';
  } else if (v === 0) {
    setVerdict(vEl, 'tight',
      `Stationary. Climate and electronics are drawing <strong>${(idleW / 1000).toFixed(1)} kW</strong>.`);
    $('lAdvice').innerHTML = advicePara(
      `Parked like this you'd flatten the battery in ${formatDuration(hoursToEmpty)}.`);
  } else if (p.arrivalSoc < 0) {
    setVerdict(vEl, 'bad', `<strong>${Math.round(p.shortfallKm)} km short</strong> at this pace.`);
    const tip = speedAdvice(cond, v);
    $('lAdvice').innerHTML = advicePara(tip
      ? `${tip} Turning the climate down helps too — it's currently costing ${Math.round(p.breakdown.aux)} Wh/km.`
      : "Slowing down alone won't be enough. Find a charger.");
  } else if (p.arrivalSoc < cond.reservePercent) {
    setVerdict(vEl, 'tight',
      `Arriving on <strong>${Math.round(p.arrivalSoc)}%</strong> — under your ${cond.reservePercent}% reserve.`);
    const tip = speedAdvice(cond, v);
    $('lAdvice').innerHTML = advicePara(tip || 'Tight but reachable. Ease off if you can.');
  } else {
    setVerdict(vEl, 'ok', `On track — arriving with <strong>${Math.round(p.arrivalSoc)}%</strong>.`);
    $('lAdvice').innerHTML = '';
  }

  // Recompute the climate explanation every tick, not just on a button tap —
  // its point is the cost per km at your CURRENT speed, which changes as you
  // drive.
  $('climateLiveHint').textContent = climateDescription({ ...cond, speedKmh: Math.max(3, v) });
  paintClimateCosts(cond, 'climateLive', Math.max(3, v));

  paintTripLog();

  // Only worth recomputing while the panel is actually on screen.
  if ($('navSheet').classList.contains('expanded')) paintDiagnostics();
}

/** The driven / elapsed / average-speed row at the bottom of the sheet. */
function paintTripLog() {
  // Elapsed time follows the same compression as distance and energy, and stops
  // entirely while paused — a trip that has not started has not taken any time.
  if (!trip.paused) {
    trip.elapsedH += (Date.now() - trip.lastLogAt) / 3600000
                   * (trip.simulating ? trip.simMultiplier : 1);
  }
  trip.lastLogAt = Date.now();

  $('lDriven').textContent = `${trip.drivenKm.toFixed(1)} km`;
  $('lElapsed').textContent = formatDuration(trip.elapsedH);
  $('lAvgSpeed').textContent = trip.elapsedH > 0.003
    ? `${(trip.drivenKm / trip.elapsedH).toFixed(0)} km/h` : '—';

  // Closed-row summaries, so folding these away costs no information.
  $('tripLogSummary').textContent = `${trip.drivenKm.toFixed(1)} km`;
  $('speedSourceSummary').textContent = trip.simulating
    ? 'simulated'
    : trip.speedSource === 'manual'
      ? `manual · ${Math.round(trip.manualSpeedKmh)} km/h`
      : 'GPS';
}

// ---------------------------------------------------------------------------
// 7. Climate and calibration
// ---------------------------------------------------------------------------

/** Both screens carry the same climate control, so both stay in step. */
export function setClimate(level) {
  state.climateLevel = level;
  for (const group of ['climateSetup', 'climateLive']) {
    $(group).querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.climate === level);
    });
  }
  if (trip.active) tick(); else render();
}

export function applyCalibration() {
  const actual = parseFloat($('actualSoc').value);
  if (!Number.isFinite(actual) || actual < 0 || actual > 100) {
    $('calibrationState').textContent = 'Enter the percentage your car is showing (0–100).';
    return;
  }

  const cond = readConditions();
  const { fullWh } = availableEnergyWh(cond.car, 100, cond.sohPercent, cond.tempC);
  const actualUsedWh = ((trip.startSoc - actual) / 100) * fullWh;

  const before = trip.calibration;
  trip.calibration = updateCalibration(trip.usedWh, actualUsedWh, before);

  const pctOf = (c) => Math.round((c - 1) * 100);
  $('calibrationSummary').textContent = trip.calibration === 1
    ? 'not yet'
    : `${pctOf(trip.calibration) > 0 ? '+' : ''}${pctOf(trip.calibration)}%`;

  if (trip.calibration === before) {
    $('calibrationState').textContent =
      'Not enough driving yet for a reliable correction — try again after a few more kilometres.';
  } else {
    // Re-base our own tracking onto the number the car reported, so the live
    // SoC readout agrees with the dashboard from here on.
    trip.usedWh = actualUsedWh;
    const pct = Math.round((trip.calibration - 1) * 100);
    $('calibrationState').textContent = pct === 0
      ? 'Model matches your car — no correction needed.'
      : `Correction applied: your car uses ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'} than the model predicted.`;
  }
  $('actualSoc').value = '';
  tick();
}

// ---------------------------------------------------------------------------
// 8. Close the hooks seam
//
// tracking.js needs these two but must not import this module (see state.js).
// Assigning them here, at import time, is what makes that inversion work.
// ---------------------------------------------------------------------------

hooks.requestTick = tick;
hooks.onMovementDetected = () => setDriving(true, 'Started automatically — movement detected');
