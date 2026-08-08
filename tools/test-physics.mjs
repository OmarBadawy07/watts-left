/**
 * test-physics.mjs — the model's own test suite. No network, no browser.
 *
 *     node tools/test-physics.mjs
 *
 * These are INVARIANTS, not golden numbers. Pinning "a Model 3 at 110 km/h
 * uses 152 Wh/km" would fail the moment anyone legitimately improved a
 * coefficient, and would teach us nothing when it did. What is asserted here
 * is the set of things that must stay true whatever the coefficients are:
 * units cancel, quantities move the right way, curves do not step, and the
 * numbers shown side by side on one screen agree with each other.
 *
 * Two sections carry regression tests for bugs that shipped. Those are marked,
 * because a test whose reason for existing is forgotten is a test somebody
 * eventually deletes.
 */

import {
  C, consumption, predict, climatePowerW, availableEnergyWh,
  updateCalibration, airDensity, coldCapacityFactor, rollingCoeff,
  maxSustainableSpeed, mostEfficientSpeed, formatDuration,
} from '../js/physics.js';
import { CARS, findCar } from '../js/cars.js';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let section = '';

const group = (name) => { section = name; };

function ok(label, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${section} :: ${label}${detail ? `\n      ${detail}` : ''}`);
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const HEATPUMP = findCar('tesla-model-3-rwd') || CARS.find((c) => c.heatPump);
const RESISTIVE = CARS.find((c) => !c.heatPump);

const BASE = {
  car: HEATPUMP,
  socPercent: 80,
  sohPercent: 100,
  tempC: 20,
  speedKmh: 110,
  climateLevel: 'medium',
  extraMassKg: 75,
  occupants: 1,
  reservePercent: 10,
  tripKm: 100,
};

const p = (over = {}) => predict({ ...BASE, ...over });

// ===========================================================================
group('1. Units and internal consistency');
// ===========================================================================
{
  const r = p();

  // W = Wh/km x km/h. If this ever drifts, some caller is mixing per-km and
  // per-hour quantities, which is THE classic range-estimation mistake.
  ok('powerW = whPerKm x speed', near(r.powerKw * 1000, r.whPerKm * BASE.speedKmh, 1e-9));

  // The countdown and the range figure are the same statement in different
  // units. They are shown together, so they must be derived together.
  ok('hoursToEmpty x speed = kmToEmpty', near(r.hoursToEmpty * BASE.speedKmh, r.kmToEmpty, 1e-9));

  // A legend that does not add up to the total printed above it reads as a bug
  // even when the total is right.
  const b = r.breakdown;
  ok('breakdown sums to whPerKm', near(b.aero + b.rolling + b.grade + b.aux, r.whPerKm, 1e-9),
    `parts=${(b.aero + b.rolling + b.grade + b.aux).toFixed(6)} total=${r.whPerKm.toFixed(6)}`);

  ok('tripEnergyWh = whPerKm x tripKm', near(r.tripEnergyWh, r.whPerKm * BASE.tripKm, 1e-9));

  // Arrival is just the trip's energy expressed as a share of the pack.
  const expected = BASE.socPercent - (r.tripEnergyWh / r.fullWh) * 100;
  ok('arrivalSoc follows from tripEnergyWh', near(r.arrivalSoc, expected, 1e-9));

  ok('remainingWh = fullWh x soc', near(r.remainingWh, r.fullWh * 0.8, 1e-9));
  ok('tripHours = tripKm / speed', near(r.tripHours, BASE.tripKm / BASE.speedKmh, 1e-9));

  // The floor scales the parts with it, so the legend still adds up even when
  // a steep descent drives the raw total negative.
  const steep = p({ tripKm: 20, climbM: 0, descentM: 2000 });
  const sb = steep.breakdown;
  ok('breakdown sums to whPerKm even when the 20 Wh/km floor bites',
    near(sb.aero + sb.rolling + sb.grade + sb.aux, steep.whPerKm, 1e-9),
    `whPerKm=${steep.whPerKm}`);
  ok('floor holds at 20 Wh/km', steep.whPerKm >= 20 - 1e-9, `got ${steep.whPerKm}`);
}

// ===========================================================================
group('2. Things must move the right way');
// ===========================================================================
{
  const wh = (o) => consumption({ ...BASE, ...o }).whPerKm;

  ok('faster costs more above the optimum', wh({ speedKmh: 130 }) > wh({ speedKmh: 110 }));
  ok('headwind costs more', wh({ headwindKmh: 30 }) > wh({ headwindKmh: 0 }));
  ok('tailwind costs less', wh({ headwindKmh: -30 }) < wh({ headwindKmh: 0 }));
  ok('extra mass costs more', wh({ extraMassKg: 500 }) > wh({ extraMassKg: 75 }));
  ok('uphill costs more', wh({ gradePercent: 3 }) > wh({ gradePercent: 0 }));
  ok('downhill costs less', wh({ gradePercent: -3 }) < wh({ gradePercent: 0 }));
  ok('cold costs more', wh({ tempC: -10 }) > wh({ tempC: 20 }));

  // Aero is proportional to v^2, so its share of the total must rise with
  // speed while the per-hour climate share falls.
  const slow = consumption({ ...BASE, speedKmh: 40 }).breakdown;
  const fast = consumption({ ...BASE, speedKmh: 130 }).breakdown;
  ok('aero share rises with speed', fast.aero / fast.aux > slow.aero / slow.aux);
  ok('climate costs fewer Wh/km at speed', fast.aux < slow.aux);

  // Monotone in trip length and in charge.
  ok('longer trip arrives lower', p({ tripKm: 200 }).arrivalSoc < p({ tripKm: 100 }).arrivalSoc);
  ok('more charge arrives higher', p({ socPercent: 90 }).arrivalSoc > p({ socPercent: 80 }).arrivalSoc);
  ok('a tired pack arrives lower', p({ sohPercent: 80 }).arrivalSoc < p({ sohPercent: 100 }).arrivalSoc);

  // Sub-models, checked directly.
  ok('cold air is denser', airDensity(-10) > airDensity(25));
  ok('air density is sane at 20C', Math.abs(airDensity(20) - 1.204) < 0.01, `${airDensity(20)}`);
  ok('cold raises rolling resistance', rollingCoeff(0.01, -10) > rollingCoeff(0.01, 20));
  ok('cold derates capacity', coldCapacityFactor(-20) < coldCapacityFactor(20));
  ok('capacity derate is floored at 0.85', coldCapacityFactor(-100) >= 0.85);
  ok('capacity derate never exceeds 1', coldCapacityFactor(50) <= 1);
}

// ===========================================================================
group('3. Climate — ordering, magnitude, and validation against measurements');
// ===========================================================================
{
  const LEVELS = ['off', 'low', 'medium', 'high'];

  for (const t of [-20, -10, 0, 10, 17, 18, 20, 21, 25, 30, 35, 45]) {
    const w = LEVELS.map((l) => climatePowerW(l, t, true, 1));
    ok(`levels are ordered at ${t}C`,
      w[0] < w[1] && w[1] < w[2] && w[2] < w[3], w.map((x) => x.toFixed(0)).join(' < '));
    ok(`off draws exactly nothing at ${t}C`, w[0] === 0);
  }

  ok('hotter needs more cooling', climatePowerW('high', 40, true) > climatePowerW('high', 30, true));
  ok('colder needs more heating', climatePowerW('high', -20, true) > climatePowerW('high', 0, true));
  ok('a heat pump beats a resistive heater in the cold',
    climatePowerW('high', -10, true) < climatePowerW('high', -10, false));
  ok('heat pump and resistive are identical when cooling',
    near(climatePowerW('high', 35, true), climatePowerW('high', 35, false), 1e-9));
  ok('more people means more cooling',
    climatePowerW('high', 30, true, 4) > climatePowerW('high', 30, true, 1));

  // --- Validation against published measurements ---------------------------
  // ADAC ran a Tesla Model Y for eight hours at 35 C ambient and measured
  // 1.3-1.5 kW of steady-state cooling. Other lab work puts steady-state
  // cabin cooling at 1.0-1.5 kW. Our figure excludes the 300 W baseline
  // electronics, which those tests include, so allow a wider lower bound.
  const hot = climatePowerW('high', 35, true, 1);
  ok('35C cooling is in the measured 1.0-1.6 kW band', hot > 1000 && hot < 1600,
    `${hot.toFixed(0)} W`);

  // Deep-cold resistive heating is the worst case any EV faces.
  const freezing = climatePowerW('high', -10, false, 1);
  ok('-10C resistive heating is 3-5 kW', freezing > 3000 && freezing < 5000,
    `${freezing.toFixed(0)} W`);

  // ---- REGRESSION: air conditioning was nearly free at mild temperatures ---
  // The old model had a dead zone for |ambient - 21C| <= 1 that returned a
  // flat 150 W and threw away the solar and occupant gains entirely. Sunlight
  // through the glass does not stop heating the cabin because the outside air
  // happens to be 21 C -- that is exactly when a parked car still cooks.
  const mild = climatePowerW('high', 21, true, 1);
  ok('REGRESSION: AC at 21C is not almost free', mild > 300, `${mild.toFixed(0)} W`);

  // ---- REGRESSION: the curve stepped at the mode boundary ------------------
  // A user experiences a step as "the number lurched for no reason". Testing
  // it needs care: the honest curve is genuinely STEEP in deep cold, around
  // 100 W per 0.1 C, so a plain first-difference threshold cannot tell a step
  // from a slope and just flags the coldest part of a perfectly good curve.
  //
  // The second difference can. On a smooth curve it is O(h^2 f'') and stays
  // near zero; a kink makes it the size of the slope change; a genuine step
  // makes it the size of the step. The old dead zone at +/-1 C of comfort
  // produced 120 W here.
  for (const car of [true, false]) {
    let worst = 0;
    let worstAt = null;
    for (let t = -25; t <= 45; t += 0.1) {
      const d2 = Math.abs(climatePowerW('high', t + 0.1, car)
        - 2 * climatePowerW('high', t, car)
        + climatePowerW('high', t - 0.1, car));
      if (d2 > worst) { worst = d2; worstAt = t; }
    }
    ok(`REGRESSION: climate power is continuous in temperature (${car ? 'heat pump' : 'resistive'})`,
      worst < 20, `worst second difference ${worst.toFixed(1)} W near ${worstAt?.toFixed(1)}C`);
  }

  // The whole thesis of the app, asserted: the SAME climate load costs wildly
  // different amounts per kilometre depending on how fast you are going.
  const inTraffic = consumption({ ...BASE, speedKmh: 20 }).breakdown.aux;
  const onMotorway = consumption({ ...BASE, speedKmh: 120 }).breakdown.aux;
  ok('climate hurts far more in traffic than on the motorway', inTraffic > onMotorway * 4,
    `${inTraffic.toFixed(0)} vs ${onMotorway.toFixed(0)} Wh/km`);
}

// ===========================================================================
group('4. Terrain, regen, and the range figure');
// ===========================================================================
{
  ok('climbing costs energy', p({ climbM: 500, descentM: 0 }).whPerKm > p({ climbM: 0, descentM: 0 }).whPerKm);
  ok('descending returns energy', p({ climbM: 0, descentM: 500 }).whPerKm < p({ climbM: 0, descentM: 0 }).whPerKm);

  // Regen is not free. A pass that returns you to your starting altitude has
  // zero NET elevation change and still costs real energy -- this asymmetry is
  // the entire reason the app fetches a climb/descent profile instead of
  // subtracting two heights.
  const pass = p({ climbM: 800, descentM: 800 });
  const flat = p({ climbM: 0, descentM: 0 });
  ok('a round trip over a pass costs more than flat', pass.whPerKm > flat.whPerKm);
  const recovered = 1 - (pass.whPerKm - flat.whPerKm)
    / (p({ climbM: 800, descentM: 0 }).whPerKm - flat.whPerKm);
  ok('regen recovers roughly REGEN_EFF of the descent', Math.abs(recovered - C.REGEN_EFF) < 0.12,
    `recovered ${(recovered * 100).toFixed(0)}%, REGEN_EFF ${(C.REGEN_EFF * 100).toFixed(0)}%`);

  // ---- REGRESSION: route terrain was extrapolated for ever ----------------
  // kmToEmpty divided the whole battery by a Wh/km that had the route's climb
  // amortised into it, so a short steep route reported a range for a car that
  // does not exist. A 5 km route with 500 m of climb gave "0% in 36 minutes"
  // beside "arrival 74%" on the same card.
  //
  // The same hill, spread over four route lengths, must not change how far the
  // car can go -- only how much of that distance the hill eats.
  const ranges = [5, 10, 40, 100].map((tripKm) => p({ tripKm, climbM: 500, descentM: 0 }).kmToEmpty);
  const spread = (Math.max(...ranges) - Math.min(...ranges)) / Math.max(...ranges);
  ok('REGRESSION: range does not depend on how the same climb is spread out',
    spread < 0.15, `ranges ${ranges.map((r) => r.toFixed(0)).join(', ')} km — spread ${(spread * 100).toFixed(0)}%`);

  // The contradiction the user actually saw, stated directly.
  for (const tripKm of [3, 5, 10, 25, 50, 100, 200]) {
    const r = p({ tripKm, climbM: tripKm * 100, descentM: 0 });
    if (r.arrivalSoc < 0) continue;
    ok(`range exceeds a trip you can complete (${tripKm} km)`, r.kmToEmpty >= tripKm,
      `range ${r.kmToEmpty.toFixed(0)} km, arrival ${r.arrivalSoc.toFixed(0)}%`);
    ok(`countdown outlasts a trip you can complete (${tripKm} km)`, r.hoursToEmpty >= r.tripHours);
  }

  // Terrain must still reach the arrival figure -- the fix isolates range,
  // it does not discard the hill.
  ok('a climb still lowers arrival SoC',
    p({ climbM: 800, descentM: 0 }).arrivalSoc < p({ climbM: 0, descentM: 0 }).arrivalSoc);
  ok('cruiseWhPerKm ignores terrain',
    near(p({ climbM: 800, descentM: 0 }).cruiseWhPerKm, p({ climbM: 0, descentM: 0 }).cruiseWhPerKm, 1e-9));
  ok('cruiseWhPerKm equals whPerKm on a flat route',
    near(flat.cruiseWhPerKm, flat.whPerKm, 1e-9));
}

// ===========================================================================
group('5. Advice functions');
// ===========================================================================
{
  // A trip that is out of reach at 130 km/h but fine at 70 must produce a
  // speed that genuinely completes it -- with the reserve intact.
  const hard = { ...BASE, socPercent: 32, tripKm: 150, speedKmh: 130 };
  const v = maxSustainableSpeed(hard);
  ok('maxSustainableSpeed returns a speed that actually makes it',
    v === null || predict({ ...hard, speedKmh: v }).makesIt, `v=${v}`);
  ok('one km/h faster would not make it',
    v === null || v >= 160 || !predict({ ...hard, speedKmh: v + 1 }).makesIt, `v=${v}`);

  // An impossible trip must return null rather than a speed that fails.
  ok('an unreachable trip returns null',
    maxSustainableSpeed({ ...BASE, socPercent: 5, tripKm: 900 }) === null);

  // The efficiency optimum must genuinely be the maximum of the scan.
  const eff = mostEfficientSpeed(BASE);
  for (const v2 of [30, 50, 70, 90, 110, 130]) {
    ok(`mostEfficientSpeed beats ${v2} km/h`, eff.km >= p({ speedKmh: v2 }).kmToEmpty - 1e-6);
  }
  // With a big per-hour load the optimum must sit above walking pace; with the
  // climate off, slower really is always further.
  ok('a heavy climate load creates a sweet spot above 30 km/h',
    mostEfficientSpeed({ ...BASE, tempC: 38, climateLevel: 'high' }).v > 30);
  ok('with climate off the optimum is the slowest speed scanned',
    mostEfficientSpeed({ ...BASE, climateLevel: 'off' }).v === 30);
}

// ===========================================================================
group('6. Calibration');
// ===========================================================================
{
  ok('too little data leaves the factor alone', updateCalibration(200, 300, 1) === 1);
  ok('a nonsense actual leaves the factor alone', updateCalibration(5000, 0, 1) === 1);
  ok('using more than predicted raises the factor', updateCalibration(5000, 6000, 1) > 1);
  ok('using less than predicted lowers the factor', updateCalibration(5000, 4000, 1) < 1);
  ok('the factor is clamped low', updateCalibration(5000, 100, 1) >= 0.6);
  ok('the factor is clamped high', updateCalibration(5000, 500000, 1) <= 1.6);

  // Calibration must scale the answer, not shift it.
  const a = p({ calibration: 1 });
  const b = p({ calibration: 1.2 });
  ok('calibration scales consumption', near(b.whPerKm, a.whPerKm * 1.2, 1e-9));
  ok('calibration scales the breakdown too',
    near(b.breakdown.aero + b.breakdown.rolling + b.breakdown.grade + b.breakdown.aux, b.whPerKm, 1e-9));
}

// ===========================================================================
group('7. Nothing produces a NaN, an Infinity, or a negative distance');
// ===========================================================================
{
  let bad = 0;
  let firstBad = null;
  const FIELDS = ['whPerKm', 'cruiseWhPerKm', 'powerKw', 'kmToEmpty', 'hoursToEmpty',
    'arrivalSoc', 'tripEnergyWh', 'shortfallKm', 'tripHours', 'fullWh', 'remainingWh'];

  for (const car of [HEATPUMP, RESISTIVE]) {
    for (const speedKmh of [0, 1, 3, 20, 60, 110, 160, 250]) {
      for (const tempC of [-25, -5, 15, 21, 30, 45]) {
        for (const tripKm of [0, 0.5, 5, 100, 1200]) {
          for (const socPercent of [0, 1, 50, 100]) {
            for (const climateLevel of ['off', 'high']) {
              for (const terrain of [{}, { climbM: 900, descentM: 0 }, { climbM: 0, descentM: 900 }]) {
                const r = predict({
                  ...BASE, car, speedKmh, tempC, tripKm, socPercent, climateLevel,
                  headwindKmh: -60, sohPercent: 70, extraMassKg: 600, occupants: 5, ...terrain,
                });
                for (const f of FIELDS) {
                  const v = r[f];
                  const finiteOk = Number.isFinite(v) || (f === 'hoursToEmpty' && v === Infinity);
                  if (!finiteOk) {
                    bad++;
                    firstBad ??= `${f}=${v} at speed=${speedKmh} temp=${tempC} trip=${tripKm} soc=${socPercent}`;
                  }
                }
                if (r.kmToEmpty < 0 || r.shortfallKm < 0 || r.tripHours < 0) {
                  bad++;
                  firstBad ??= `negative distance at speed=${speedKmh} trip=${tripKm} soc=${socPercent}`;
                }
              }
            }
          }
        }
      }
    }
  }
  ok('4608 combinations of extreme inputs stay finite and non-negative', bad === 0,
    firstBad || '');

  // A flat battery is a flat battery, not a negative range.
  const dead = p({ socPercent: 0 });
  ok('0% charge gives 0 km of range', near(dead.kmToEmpty, 0, 1e-9));
  ok('0% charge cannot make a trip', !dead.makesIt);

  ok('formatDuration handles infinity', formatDuration(Infinity) === '—');
  ok('formatDuration caps absurd values', formatDuration(500) === '99h+');
  ok('formatDuration rolls minutes into hours', formatDuration(1.5) === '1h 30m');
  ok('formatDuration omits a zero hour', formatDuration(0.5) === '30 min');
}

// ===========================================================================
group('8. The catalog');
// ===========================================================================
{
  const seen = new Set();
  for (const car of CARS) {
    const label = car.name;
    if (seen.has(car.id)) ok(`${label} has a unique id`, false, `duplicate id ${car.id}`);
    seen.add(car.id);
    ok(`${label} has a plausible battery`, car.usableKwh > 10 && car.usableKwh < 250, `${car.usableKwh} kWh`);
    ok(`${label} has a plausible mass`, car.massKg > 700 && car.massKg < 4500, `${car.massKg} kg`);
    // 0.20 is about as slippery as a production EV gets (Lucid Air, EQS);
    // 0.50 is the Hummer EV, which really is that much of a brick.
    ok(`${label} has a plausible drag coefficient`, car.cd >= 0.18 && car.cd <= 0.52, `Cd ${car.cd}`);
    ok(`${label} has a plausible frontal area`, car.areaM2 > 1.5 && car.areaM2 < 5, `${car.areaM2} m2`);
    ok(`${label} has a plausible drivetrain efficiency`, car.eta > 0.7 && car.eta < 1, `eta ${car.eta}`);
    ok(`${label} has a plausible rolling coefficient`, car.crr > 0.005 && car.crr < 0.02, `Crr ${car.crr}`);

    // The real test of a catalog entry: does it predict a sane motorway
    // consumption? Anything outside the band is a typo in the specs.
    //
    // The band has to depend on what kind of vehicle it is. An electric van or
    // full-size pickup genuinely does use 400-600 Wh/km at 110 km/h — the
    // Hummer EV is measured around 55-60 kWh/100 km — so a single band tuned
    // for hatchbacks would reject the correct answer for a whole class of
    // vehicle. Mass is the honest proxy for that class.
    const heavy = car.massKg > 2600;
    const ceiling = heavy ? 650 : 400;
    const wh = consumption({
      ...BASE, car, speedKmh: 110, climateLevel: 'off', tempC: 20, extraMassKg: 75,
    }).whPerKm;
    ok(`${label} consumes a plausible amount at 110 km/h`, wh > 110 && wh < ceiling,
      `${wh.toFixed(0)} Wh/km (limit ${ceiling} for a ${heavy ? 'heavy' : 'normal'} vehicle)`);
  }
  ok('the catalog is not empty', CARS.length > 50, `${CARS.length} cars`);
}

// ===========================================================================
group('9. Battery energy');
// ===========================================================================
{
  const { fullWh, remainingWh } = availableEnergyWh(HEATPUMP, 50, 100, 20);
  ok('full energy matches the rated pack in mild weather',
    near(fullWh, HEATPUMP.usableKwh * 1000 * coldCapacityFactor(20), 1e-9));
  ok('remaining is the stated fraction of full', near(remainingWh, fullWh * 0.5, 1e-9));
  ok('a degraded pack holds less',
    availableEnergyWh(HEATPUMP, 100, 80, 20).fullWh < availableEnergyWh(HEATPUMP, 100, 100, 20).fullWh);
  ok('a cold pack holds less',
    availableEnergyWh(HEATPUMP, 100, 100, -20).fullWh < availableEnergyWh(HEATPUMP, 100, 100, 20).fullWh);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length === 0) {
  console.log(`  all ${passed} physics assertions passed`);
} else {
  console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
}
console.log('');
