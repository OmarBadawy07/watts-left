/**
 * conditions.js — turning the form into the object physics.predict() wants.
 *
 * This is the single seam between "what is on screen" and "what the model
 * computes". Both screens go through it, which is why the live screen can
 * substitute GPS speed and remaining distance with an `overrides` object and
 * get an otherwise identical calculation.
 */

import { $, numVal } from './dom.js';
import { state, trip } from './state.js';
import { CUSTOM_CAR_DEFAULTS, findCar } from './cars.js';

/** The one-line spec summary shown under the car chip and in search results. */
export function carSubtitle(car) {
  return `${car.usableKwh} kWh usable · ${car.massKg} kg · Cd ${car.cd.toFixed(3)}`
       + ` · ${car.heatPump ? 'heat pump' : 'resistive heater'}`;
}

/** The car record fed to the model — catalog entry or the custom fields. */
export function currentCar() {
  if (!state.useCustom) {
    const known = findCar(state.carId);
    if (known) return known;
  }
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    ...CUSTOM_CAR_DEFAULTS,
    usableKwh: num('customKwh', CUSTOM_CAR_DEFAULTS.usableKwh),
    massKg: num('customMass', CUSTOM_CAR_DEFAULTS.massKg),
    cd: num('customCd', CUSTOM_CAR_DEFAULTS.cd),
    areaM2: num('customArea', CUSTOM_CAR_DEFAULTS.areaM2),
    heatPump: $('customHeatPump').checked,
  };
}

/**
 * Collect every input into the shape physics.predict() expects.
 *
 * `overrides` lets the live screen substitute GPS speed, remaining distance
 * and the running SoC estimate — applied last, so they always win.
 */
export function readConditions(overrides = {}) {
  const passengers = Math.max(1, numVal('passengers', 1));

  // Distance and terrain come from the planned route in route mode, and from
  // the manual fields in manual mode.
  //
  // Note the deliberate 0 when route mode is selected but no route has been
  // found yet. Falling back to the manual field's value would quietly show a
  // confident prediction for a trip the user never asked about — better to
  // show nothing and prompt them to pick a destination.
  const routeMode = state.tripMode === 'route';
  const useRoute = routeMode && state.route;
  const tripKm = routeMode
    ? (state.route ? state.route.distanceKm : 0)
    : Math.max(0, numVal('tripKm', 100));
  const profile = useRoute ? state.profile : null;

  return {
    car: currentCar(),
    socPercent: numVal('soc', 80),
    sohPercent: numVal('soh', 100),
    tripKm,
    // Net elevation is the fallback path; climbM/descentM take priority in the
    // model whenever they are present.
    elevationM: useRoute ? (profile?.netM ?? 0) : numVal('elevationM', 0),
    climbM: profile ? profile.climbM : null,
    descentM: profile ? profile.descentM : null,
    reservePercent: numVal('reserve', 10),
    speedKmh: numVal('speed', 100),
    tempC: numVal('temp', 20),
    headwindKmh: numVal('wind', 0),
    // Driver and passengers at 75 kg each, plus declared cargo. Kerb mass is
    // for an empty car, so the driver's own mass belongs here.
    extraMassKg: passengers * 75 + numVal('cargoKg', 0),
    // People are also a thermal load — about 100 W of body heat each, which
    // the air conditioning has to remove. Passed separately from the mass
    // because it is a completely different term in the model.
    occupants: passengers,
    climateLevel: state.climateLevel,
    calibration: trip.calibration,
    ...overrides,
  };
}
