/**
 * physics.js — The energy model. This is the heart of the app.
 *
 * ============================================================================
 * WHY A PHYSICS MODEL INSTEAD OF A LOOKUP TABLE
 * ============================================================================
 * Your car's built-in range estimate is essentially:
 *
 *     remaining_km = remaining_kWh / (average kWh/km over the last N km)
 *
 * That is BACKWARD-looking. It cannot know that you are about to join a
 * motorway at 130 km/h, or that you just turned the AC to max, or that there
 * is a 25 km/h headwind. This model is FORWARD-looking: you tell it the
 * conditions, and it computes the consumption those conditions produce.
 *
 * ============================================================================
 * THE CORE EQUATION
 * ============================================================================
 * Energy leaves the battery through two fundamentally different channels:
 *
 *   1. MOVING THE CAR — this costs energy PER KILOMETRE.
 *   2. RUNNING THE CLIMATE + ELECTRONICS — this costs energy PER HOUR.
 *
 * Mixing those two up is the single most common mistake in range estimation.
 * To combine them we convert the per-hour load into per-kilometre by dividing
 * by speed:
 *
 *     Wh/km  =  (F_roll + F_aero + F_grade) x 1000 / 3600 / eta   +   P_aux / v
 *                \_______________________________________/           \_______/
 *                        driving  (per kilometre)                  climate etc.
 *                                                                  (per hour,
 *                                                                converted to
 *                                                                per kilometre)
 *
 * The consequence is the most useful insight the app has to offer:
 *
 *   - In slow city traffic (20 km/h) a 2 kW AC load costs 100 Wh/km — often
 *     MORE than actually moving the car. AC is brutal in traffic.
 *   - On the motorway (120 km/h) that same 2 kW costs only 17 Wh/km, which is
 *     noise next to aerodynamic drag. AC barely matters at speed.
 *
 * Meanwhile aerodynamic drag does the exact opposite: force grows with v², so
 * energy per kilometre also grows with v². Going from 100 to 130 km/h raises
 * the aero part of your consumption by roughly (130/100)² = 1.7x.
 *
 * Nothing here needs an internet connection, an API key, or a database.
 * It is just Newtonian mechanics and thermodynamics.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------
export const C = {
  G: 9.81,               // m/s²  — gravitational acceleration
  AIR_R: 287.05,         // J/(kg·K) — specific gas constant for dry air
  SEA_LEVEL_PA: 101325,  // Pa — standard atmospheric pressure
  COMFORT_C: 21,         // °C — the cabin temperature the climate system targets
  BASELINE_AUX_W: 300,   // W — lights, screens, pumps, 12 V systems. Always on.

  /**
   * CABIN_UA — how fast heat leaks through the car's shell, in thermal watts
   * per °C of difference between cabin and outside. Includes conduction
   * through the glass and panels plus the energy needed to warm (or cool) the
   * fresh air the ventilation system continuously draws in.
   *
   * ~130 W/°C is representative of a mid-size car. Sanity check: at -10 °C
   * outside and 21 °C inside, the difference is 31 °C, so the cabin needs
   * 130 x 31 = 4.0 kW of heat. A resistive heater burns 4.0 kW of electricity
   * to make that; a heat pump at COP 1.2 needs only ~3.4 kW. Both match
   * published measurements for real cars in winter.
   */
  CABIN_UA: 130,

  /**
   * SOLAR_GAIN — extra thermal watts the air conditioning has to remove on a
   * warm day that have nothing to do with the temperature difference: sunlight
   * through a large glass area, body heat from the occupants, and the latent
   * heat of pulling moisture out of the air.
   */
  SOLAR_GAIN: 600,
  REGEN_EFF: 0.65,       // fraction of downhill potential energy recovered by
                         // regenerative braking (the rest is lost to friction
                         // brakes, inverter losses and heat)

  /**
   * REAL-WORLD FACTOR — applied to the driving terms only.
   *
   * The force equation below describes a car holding a perfectly constant
   * speed on smooth, flat, dry tarmac. Real driving is not that. It includes
   * speed variation and the acceleration losses that come with it, imperfect
   * road surfaces, brake-pad and wheel-bearing drag, crosswind yaw, and rain
   * or standing water.
   *
   * Validated against published constant-speed test data (e.g. a Tesla Model 3
   * RWD at 110 km/h measures around 150-155 Wh/km, while the bare equation
   * gives ~138), the gap sits consistently around 10%.
   *
   * This deliberately biases the model slightly PESSIMISTIC. For a range app,
   * being 10% optimistic strands people; being 10% pessimistic just means you
   * arrive with more charge than you expected. The live calibration then tunes
   * this away for the specific car and driver.
   */
  REALWORLD_FACTOR: 1.10,
};

/** Clamp helper — keeps a value inside [lo, hi]. */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------
// 1. AIR DENSITY
// ---------------------------------------------------------------------------
/**
 * Air density from the ideal gas law: rho = P / (R * T).
 *
 * This matters more than people expect. Air at -10 °C is about 12% denser than
 * air at +25 °C, and aerodynamic drag is directly proportional to density. So
 * part of the notorious "winter range loss" is simply that you are pushing
 * through thicker air.
 *
 * @param {number} tempC  outside air temperature in °C
 * @returns {number} density in kg/m³
 */
export function airDensity(tempC) {
  const kelvin = tempC + 273.15;
  return C.SEA_LEVEL_PA / (C.AIR_R * kelvin);
}

// ---------------------------------------------------------------------------
// 2. TEMPERATURE EFFECT ON THE TYRES
// ---------------------------------------------------------------------------
/**
 * Cold rubber is stiffer and cold air in the tyre is at lower pressure, both of
 * which raise rolling resistance. Roughly +11% at -10 °C versus a mild day.
 * Above 15 °C we treat rolling resistance as flat.
 */
export function rollingCoeff(baseCrr, tempC) {
  const coldness = Math.max(0, 15 - tempC);
  return baseCrr * (1 + 0.0045 * coldness);
}

// ---------------------------------------------------------------------------
// 3. TEMPERATURE EFFECT ON USABLE BATTERY CAPACITY
// ---------------------------------------------------------------------------
/**
 * A lithium-ion pack does not just "use energy faster" in the cold — it can
 * genuinely deliver less of it. Higher internal resistance means more of the
 * stored energy is wasted as heat inside the cells, and the BMS becomes more
 * conservative about how low it will let the pack go.
 *
 * We model this as a straight derate below 15 °C, floored at 0.85 so the
 * estimate never becomes absurd.
 *
 * IMPORTANT: this is a SEPARATE effect from cabin heating. Both happen at once
 * in winter, which is why cold-weather range loss stacks up so quickly:
 *   denser air + stiffer tyres + reduced capacity + cabin heating.
 */
export function coldCapacityFactor(tempC) {
  return clamp(1 - (15 - tempC) * 0.005, 0.85, 1.0);
}

// ---------------------------------------------------------------------------
// 4. CLIMATE CONTROL POWER
// ---------------------------------------------------------------------------
/** Fraction of full climate output requested at each user-selectable level. */
export const CLIMATE_LEVELS = {
  off:    { label: 'Off',    factor: 0.00, blowerW: 0 },
  low:    { label: 'Low',    factor: 0.45, blowerW: 60 },
  medium: { label: 'Medium', factor: 0.75, blowerW: 140 },
  high:   { label: 'High',   factor: 1.00, blowerW: 240 },
};

/**
 * Electrical power drawn by the climate system, in watts.
 *
 * The key modelling idea: we first work out how much HEAT (in thermal watts)
 * has to be moved to keep the cabin at ~21 °C, then divide by the coefficient
 * of performance (COP) of the machine doing the moving.
 *
 *   COP = thermal watts delivered / electrical watts consumed
 *
 *   - Air conditioning is a heat pump running in reverse. COP ≈ 2.7.
 *   - A HEAT PUMP in heating mode has COP ≈ 3.2 in mild weather, falling to
 *     ~1.2 in deep cold (there is less ambient heat available to harvest).
 *   - A RESISTIVE (PTC) heater has COP = 1.0, always. Every watt of
 *     electricity gives exactly one watt of heat. This is why cars without a
 *     heat pump are so much worse in winter.
 *
 * @param {string} level      one of the CLIMATE_LEVELS keys
 * @param {number} tempC      outside temperature
 * @param {boolean} heatPump  does the car have a heat pump?
 * @returns {number} watts
 */
export function climatePowerW(level, tempC, heatPump) {
  const cfg = CLIMATE_LEVELS[level] ?? CLIMATE_LEVELS.off;
  if (cfg.factor === 0) return 0;

  const delta = tempC - C.COMFORT_C; // positive = too hot, negative = too cold
  let electricalW;

  if (delta > 1) {
    // COOLING. Heat leaks IN through the bodywork and glass, plus the solar,
    // occupant and humidity load that exists even on a merely-warm day.
    const thermalW = C.CABIN_UA * delta + C.SOLAR_GAIN;
    electricalW = thermalW / 2.7; // AC compressor COP
  } else if (delta < -1) {
    // HEATING. Heat leaks OUT at the same rate it would leak in.
    const thermalW = C.CABIN_UA * -delta;
    // Heat pump COP degrades as it gets colder; resistive heating is stuck at 1.
    const cop = heatPump ? clamp(1.8 + 0.07 * tempC, 1.2, 3.2) : 1.0;
    electricalW = thermalW / cop;
  } else {
    // Near-perfect ambient temperature: just moving air around.
    electricalW = 150;
  }

  return cfg.factor * electricalW + cfg.blowerW;
}

// ---------------------------------------------------------------------------
// 5. CONSUMPTION AT A GIVEN SPEED  — the main equation
// ---------------------------------------------------------------------------
/**
 * Energy cost of the route's terrain, in Wh per kilometre.
 *
 * Two modes, and the difference between them matters a lot:
 *
 * PROFILE MODE (climbM + descentM, from the trip planner)
 *   Climbing and descending are totalled separately. This is the honest
 *   calculation, because the two are NOT symmetric: climbing 1000 m costs
 *   m·g·h divided by drivetrain efficiency, while descending 1000 m returns
 *   only about 65% of m·g·h. A mountain pass that returns you to your starting
 *   altitude has a NET elevation change of zero but is nowhere near free.
 *
 * NET MODE (gradePercent, from manual entry)
 *   Fallback when we only know the start and end heights. It treats the route
 *   as one constant slope. Reasonable for gently rolling terrain, but it will
 *   under-read badly on a route that goes up and comes back down — which is
 *   exactly why the trip planner exists.
 */
function elevationWhPerKm({ mass, eta, climbM, descentM, tripKm, gradePercent }) {
  const haveProfile = Number.isFinite(climbM) && Number.isFinite(descentM);

  if (haveProfile && tripKm > 0) {
    // Joules to watt-hours is a division by 3600.
    const climbWh = (mass * C.G * climbM) / 3600 / eta;
    const descentWh = ((mass * C.G * descentM) / 3600) * C.REGEN_EFF;
    return (climbWh - descentWh) / tripKm;
  }

  // Net mode: F = m·g·sin(theta), constant over the whole trip.
  const fGrade = mass * C.G * Math.sin(Math.atan(gradePercent / 100));
  const raw = (fGrade * 1000) / 3600;
  return raw >= 0 ? raw / eta : raw * C.REGEN_EFF;
}

/**
 * @typedef {Object} Conditions
 * @property {Object}  car            a record from cars.js
 * @property {number}  speedKmh       ground speed
 * @property {number}  tempC          outside temperature
 * @property {number}  headwindKmh    positive = headwind, negative = tailwind
 * @property {number}  extraMassKg    passengers + cargo on top of kerb mass
 * @property {number}  gradePercent   average road gradient (rise/run x 100)
 * @property {string}  climateLevel   key into CLIMATE_LEVELS
 * @property {number}  calibration    live-learned correction factor (1 = none)
 */

/**
 * Compute instantaneous consumption and power draw under the given conditions.
 *
 * @param {Conditions} cond
 * @returns {{whPerKm:number, powerW:number, breakdown:Object, airDensity:number}}
 */
export function consumption(cond) {
  const {
    car, speedKmh, tempC, headwindKmh = 0, extraMassKg = 0,
    gradePercent = 0, climateLevel = 'off', calibration = 1,
    // Optional elevation PROFILE. When the trip planner has fetched real
    // terrain data these carry the total metres climbed and descended over the
    // route, which is strictly better than a single net figure — see below.
    climbM = null, descentM = null, tripKm = 0,
  } = cond;

  // Guard: at a standstill the "per kilometre" framing breaks down (you would
  // be dividing by zero). Treat anything under 3 km/h as 3 km/h so the numbers
  // stay finite; the app shows a "stationary" state in the UI anyway.
  const v_kmh = Math.max(3, speedKmh);
  const v = v_kmh / 3.6;                        // ground speed, m/s
  const vAir = Math.max(0, v + headwindKmh / 3.6); // air speed over the body

  const mass = car.massKg + extraMassKg;
  const rho = airDensity(tempC);
  const crr = rollingCoeff(car.crr, tempC);

  // --- Forces acting against the car, in newtons ---------------------------

  // Aerodynamic drag: F = ½ · rho · Cd · A · v_air²
  // Note we use AIR speed here (ground speed + headwind) because that is what
  // the body actually experiences. A 30 km/h headwind at 100 km/h ground speed
  // makes the car feel aerodynamically like it is doing 130.
  const fAero = 0.5 * rho * car.cd * car.areaM2 * vAir * vAir;

  // Rolling resistance: F = Crr · m · g. Essentially constant with speed,
  // which is why it dominates in town and fades into the background on the
  // motorway.
  const fRoll = crr * mass * C.G;

  // --- Convert force to energy per kilometre -------------------------------
  // Work = force x distance, so a constant force of F newtons over 1000 m
  // costs F x 1000 joules. Divide by 3600 to get watt-hours.
  //
  //     Wh per km = F [N] x 1000 [m] / 3600 [J per Wh]
  //
  // Then divide by drivetrain efficiency, because the battery must supply MORE
  // than what reaches the road to cover inverter/motor/gearbox losses.
  //
  // REALWORLD_FACTOR (see the constant above) covers what a perfectly steady
  // cruise on smooth tarmac leaves out. It applies to the driving terms only —
  // the climate load is already a direct electrical measurement and needs no
  // such correction.
  const toWhPerKm = (force) => (force * 1000 * C.REALWORLD_FACTOR) / 3600;

  const aeroWhKm = toWhPerKm(fAero) / car.eta;
  const rollWhKm = toWhPerKm(fRoll) / car.eta;

  // --- Elevation -----------------------------------------------------------
  // Note this term does NOT get the real-world factor. Potential energy is
  // exactly computable from mass and height; there is no empirical fudge to
  // apply. The factor exists to cover speed variation and surface losses,
  // which are already accounted for in the two terms above.
  const gradeWhKm = elevationWhPerKm({
    mass, eta: car.eta, climbM, descentM, tripKm, gradePercent,
  });

  // --- The per-hour loads, converted to per-kilometre ----------------------
  const climateW = climatePowerW(climateLevel, tempC, car.heatPump);
  const auxW = climateW + C.BASELINE_AUX_W;
  // W ÷ (km/h) = Wh/km. The units work out exactly.
  const auxWhKm = auxW / v_kmh;

  // --- Total ---------------------------------------------------------------
  // The calibration factor is learned during the trip by comparing predicted
  // energy use against the real drop in state of charge. It silently absorbs
  // everything the model cannot see: your driving style, tyre pressure, a roof
  // box, pack degradation beyond what the user entered, road surface.
  const rawWhKm = aeroWhKm + rollWhKm + gradeWhKm + auxWhKm;
  const calibrated = rawWhKm * calibration;
  const whPerKm = Math.max(20, calibrated); // floor stops silly values

  // When the floor bites — a steep sustained descent can drive the raw total
  // negative — the parts must be scaled with it. Otherwise the legend on screen
  // sums to something other than the Wh/km printed above it, and a breakdown
  // that does not add up to its own total reads as a bug.
  const floorScale = calibrated > 0 ? whPerKm / calibrated : 1;
  const part = (x) => x * calibration * floorScale;

  return {
    whPerKm,
    powerW: whPerKm * v_kmh, // Wh/km x km/h = Wh/h = W
    airDensity: rho,
    climateW,
    breakdown: {
      aero: part(aeroWhKm),
      rolling: part(rollWhKm),
      grade: part(gradeWhKm),
      aux: part(auxWhKm),
    },
  };
}

// ---------------------------------------------------------------------------
// 6. BATTERY ENERGY AVAILABLE
// ---------------------------------------------------------------------------
/**
 * How many watt-hours are actually on board right now.
 *
 * Three multiplications, each for a real reason:
 *   usableKwh   — the pack's rated usable energy when new
 *   x soh       — battery health; a five-year-old pack may hold only 90%
 *   x coldFac   — the cold-weather derate described above
 *   x soc       — how full it is right now
 */
export function availableEnergyWh(car, socPercent, sohPercent, tempC) {
  const fullWh = car.usableKwh * 1000 * (sohPercent / 100) * coldCapacityFactor(tempC);
  return {
    fullWh,
    remainingWh: fullWh * (socPercent / 100),
  };
}

// ---------------------------------------------------------------------------
// 7. THE PREDICTIONS THE USER ACTUALLY SEES
// ---------------------------------------------------------------------------
/**
 * Turn conditions + battery state into the numbers on screen.
 *
 * @param {Conditions & {socPercent:number, sohPercent:number,
 *                       tripKm:number, elevationM:number,
 *                       reservePercent:number}} input
 */
export function predict(input) {
  const {
    car, socPercent, sohPercent, tempC, tripKm, elevationM = 0,
    reservePercent = 0,
  } = input;

  // Express the net elevation change as an average gradient. This is only used
  // when the caller has NOT supplied a real climb/descent profile — see
  // elevationWhPerKm(), which prefers the profile whenever it is available.
  const gradePercent = tripKm > 0 ? (elevationM / (tripKm * 1000)) * 100 : 0;

  const cons = consumption({ ...input, gradePercent });
  const { fullWh, remainingWh } = availableEnergyWh(car, socPercent, sohPercent, tempC);

  // Reserve: the buffer the user wants to arrive with, never planned into.
  const reserveWh = fullWh * (reservePercent / 100);
  const usableNowWh = Math.max(0, remainingWh - reserveWh);

  // --- Headline number: when do we hit 0%? ---------------------------------
  const hoursToEmpty = cons.powerW > 0 ? remainingWh / cons.powerW : Infinity;
  const kmToEmpty = remainingWh / cons.whPerKm;

  // --- The number that actually drives decisions: do we make it? -----------
  const tripEnergyWh = cons.whPerKm * tripKm;
  const arrivalWh = remainingWh - tripEnergyWh;
  const arrivalSoc = (arrivalWh / fullWh) * 100;
  const shortfallKm = arrivalWh >= 0 ? 0 : (-arrivalWh) / cons.whPerKm;
  const tripHours = tripKm / Math.max(3, input.speedKmh);

  return {
    whPerKm: cons.whPerKm,
    powerKw: cons.powerW / 1000,
    climateW: cons.climateW,
    breakdown: cons.breakdown,
    fullWh,
    remainingWh,
    usableNowWh,
    hoursToEmpty,
    kmToEmpty,
    tripEnergyWh,
    arrivalSoc,
    shortfallKm,
    tripHours,
    makesIt: arrivalWh >= reserveWh,
    gradePercent,
  };
}

// ---------------------------------------------------------------------------
// 8. "HOW SLOW DO I NEED TO GO?"
// ---------------------------------------------------------------------------
/**
 * Find the highest steady speed at which the remaining distance is still
 * achievable (keeping the reserve intact).
 *
 * We scan downward from 160 km/h in 1 km/h steps rather than binary-searching,
 * because range-versus-speed is NOT monotonic: there is an optimum speed
 * (usually 40–60 km/h) where the per-kilometre climate cost and the aero cost
 * balance. Below that optimum, slowing down actually makes things WORSE,
 * because you sit in the car for longer running the AC. A linear scan handles
 * that shape correctly and costs a trivial ~130 iterations.
 *
 * @returns {number|null} km/h, or null if no speed in range completes the trip
 */
export function maxSustainableSpeed(input) {
  for (let v = 160; v >= 25; v -= 1) {
    const p = predict({ ...input, speedKmh: v });
    if (p.makesIt) return v;
  }
  return null;
}

/**
 * The speed that maximises distance for the CURRENT conditions — the "if you
 * really need every last kilometre" hint.
 *
 * The scan starts at 30 km/h rather than lower on purpose. With the climate
 * off the mathematical optimum keeps sliding down towards walking pace, which
 * is true in the equations but useless as advice, and the model does not
 * capture the low-speed drivetrain losses that would flatten it out in
 * reality. 30 km/h is the slowest speed anyone would actually drive between
 * places. The caller decides whether the answer is worth showing at all — see
 * buildAdvice() in app.js.
 */
export function mostEfficientSpeed(input) {
  let best = { v: 30, km: -1 };
  for (let v = 30; v <= 130; v += 1) {
    const p = predict({ ...input, speedKmh: v });
    if (p.kmToEmpty > best.km) best = { v, km: p.kmToEmpty };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 9. LIVE SELF-CALIBRATION
// ---------------------------------------------------------------------------
/**
 * Compare what the model THOUGHT we would use against what the battery ACTUALLY
 * gave up, and return a correction factor to multiply future estimates by.
 *
 * This is the feature that makes the app better than the dashboard over time:
 * no OBD dongle, no manufacturer API, just "you said you were at 80%, now you
 * say 62%, and I predicted you'd be at 65% — so I'm running about 9% optimistic
 * and I'll adjust."
 *
 * @param {number} modelUsedWh   energy the model accumulated since trip start
 * @param {number} actualUsedWh  (startSoc - nowSoc)/100 x fullWh
 * @param {number} previous      the calibration factor currently in use
 * @returns {number} new calibration factor
 */
export function updateCalibration(modelUsedWh, actualUsedWh, previous = 1) {
  // Below ~500 Wh the state-of-charge readout (usually whole percent) is too
  // coarse to learn anything trustworthy from.
  if (modelUsedWh < 500 || actualUsedWh <= 0) return previous;

  const observed = actualUsedWh / modelUsedWh;

  // Blend with the existing factor so one noisy reading cannot yank the
  // prediction around, and clamp to a sane band so a mistyped SoC cannot
  // produce a wild estimate.
  const blended = previous * 0.4 + observed * 0.6;
  return clamp(blended, 0.6, 1.6);
}

// ---------------------------------------------------------------------------
// Formatting helpers used by the UI
// ---------------------------------------------------------------------------
export function formatDuration(hours) {
  if (!isFinite(hours)) return '—';
  if (hours > 99) return '99h+';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

/** Convert an hours-from-now offset into a wall-clock time like "14:32". */
export function clockTimeIn(hours) {
  if (!isFinite(hours) || hours > 99) return '—';
  const t = new Date(Date.now() + hours * 3600 * 1000);
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
