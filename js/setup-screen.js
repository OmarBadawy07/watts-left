/**
 * setup-screen.js — the form, the prediction, and the advice under it.
 *
 * This screen answers one question before you set off: at these settings, do
 * you make it? Everything here is recomputed from scratch on every keystroke,
 * which is affordable because the model is pure arithmetic on ~150 numbers.
 */

import { $, setVerdict } from './dom.js';
import { state } from './state.js';
import { CARS, findCar } from './cars.js';
import {
  C, predict, maxSustainableSpeed, mostEfficientSpeed, climatePowerW,
  availableEnergyWh, formatDuration, clockTimeIn,
} from './physics.js';
import { readConditions, currentCar, carSubtitle } from './conditions.js';

// ---------------------------------------------------------------------------
// The car chip
// ---------------------------------------------------------------------------

/** Match every whitespace-separated token, so "id 4" finds "VW ID.4 Pro". */
export function filterCars(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const norm = (s) => s.toLowerCase().replace(/[.\-/]/g, ' ');
  return CARS
    .filter((car) => {
      const hay = norm(car.name);
      return tokens.every((t) => hay.includes(t.replace(/[.\-/]/g, ' ')));
    })
    .slice(0, 12);
}

/** Show either the selected-car chip or the search input, never both. */
export function paintCarChoice() {
  const car = currentCar();
  const chosen = !!(state.useCustom || findCar(state.carId));

  $('carChip').classList.toggle('hidden', !chosen);
  $('carField').classList.toggle('hidden', chosen);
  $('carResults').classList.add('hidden');
  $('carChipName').textContent = state.useCustom ? 'Custom vehicle' : car.name;
  $('carSpecs').textContent = carSubtitle(car);
  $('toggleCustom').textContent = state.useCustom
    ? 'Pick from the catalog instead'
    : "Can't find your car? Enter its specs manually";
}

// ---------------------------------------------------------------------------
// The prediction
// ---------------------------------------------------------------------------

function renderBreakdown(breakdown, ids) {
  // Only positive contributions get bar width. A negative "climbing" figure
  // (net downhill) is real and worth showing in the legend, but cannot be
  // drawn as a slice of a 100% bar.
  const parts = {
    aero: Math.max(0, breakdown.aero),
    roll: Math.max(0, breakdown.rolling),
    grade: Math.max(0, breakdown.grade),
    aux: Math.max(0, breakdown.aux),
  };
  const total = parts.aero + parts.roll + parts.grade + parts.aux || 1;
  const segs = $(ids.bar).querySelectorAll('.seg');
  const order = [parts.aero, parts.roll, parts.grade, parts.aux];
  segs.forEach((seg, i) => { seg.style.width = `${(order[i] / total) * 100}%`; });

  // Bare numbers — the unit is stated once, on the heading above the bar.
  const fmt = (v) => `${Math.round(v)}`;
  $(ids.aero).textContent = fmt(breakdown.aero);
  $(ids.roll).textContent = fmt(breakdown.rolling);
  $(ids.grade).textContent = fmt(breakdown.grade);
  $(ids.aux).textContent = fmt(breakdown.aux);
}

function syncOutputs() {
  $('socOut').textContent = `${$('soc').value}%`;
  $('sohOut').textContent = `${$('soh').value}%`;
  $('speedOut').textContent = `${$('speed').value} km/h`;
  $('tempOut').textContent = `${$('temp').value} °C`;
  $('windOut').textContent = `${$('wind').value} km/h`;
  $('reserveOut').textContent = `${$('reserve').value}%`;
  $('carCount').textContent = `${CARS.length} models`;

  // The folded "Weather & load" card still reports itself on its closed row,
  // so collapsing it tidies the form without concealing a setting. Only the
  // non-default parts are named — a summary that always reads "1 passenger,
  // 0 kg" is noise.
  const parts = [`${$('temp').value} °C`];
  const wind = +$('wind').value;
  if (wind > 0) parts.push(`${wind} km/h headwind`);
  else if (wind < 0) parts.push(`${-wind} km/h tailwind`);
  const people = +$('passengers').value;
  if (people > 1) parts.push(`${people} people`);
  const cargo = +$('cargoKg').value;
  if (cargo > 0) parts.push(`${cargo} kg`);
  $('fineTuneSummary').textContent = parts.join(' · ');
}

/**
 * Paint what each climate level would cost, on every button at once.
 *
 * This exists because the control looked broken. On a mild day the difference
 * between Off and High is genuinely under one percent of the battery, so an
 * arrival figure rounded to whole percent did not move when you changed it,
 * and the reasonable conclusion was that the setting was being ignored.
 *
 * Showing all four costs together fixes that honestly — it does not
 * exaggerate the effect, it just stops hiding it. It also makes the model's
 * most interesting behaviour visible: the same four numbers roughly triple
 * between 20 °C and 38 °C, and triple again if you are crawling in traffic
 * rather than cruising, because climate is a cost per HOUR.
 *
 * @param {Object} cond     conditions, already read
 * @param {string} groupId  the segmented control to paint
 * @param {number} speedKmh speed to bill the per-hour load at
 */
export function paintClimateCosts(cond, groupId, speedKmh = cond.speedKmh) {
  const group = $(groupId);
  if (!group) return;

  const { fullWh } = availableEnergyWh(cond.car, 100, cond.sohPercent, cond.tempC);
  // With a trip on the table, quote the whole trip. Without one there is no
  // distance to spread it over, so quote it per hour — which is the unit the
  // load is really in anyway.
  const hours = cond.tripKm > 0 ? cond.tripKm / Math.max(3, speedKmh) : 1;

  for (const btn of group.querySelectorAll('button[data-climate]')) {
    const out = btn.querySelector('[data-cost]');
    if (!out) continue;
    const w = climatePowerW(btn.dataset.climate, cond.tempC, cond.car.heatPump, cond.occupants);
    if (w === 0 || !(fullWh > 0)) { out.textContent = '—'; continue; }
    const pct = ((w * hours) / fullWh) * 100;
    // One decimal below 10% — the whole point is that small differences stay
    // visible, and rounding them away is the bug this is fixing.
    out.textContent = pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  }
}

/**
 * The battery track: the entire prediction as one picture.
 *
 * Left to right is 100% of the pack down to 0%, so the bar drains the way a
 * fuel gauge does. The solid part is what you arrive with, the dimmed part is
 * what the trip eats, and the notch is the reserve. If the solid part ends
 * before the notch you are under your reserve, which you can see without
 * reading any of the numbers.
 */
function renderTrack(cond, p) {
  const now = Math.max(0, Math.min(100, cond.socPercent));
  const arrival = Math.max(0, Math.min(now, p.arrivalSoc));
  const spend = Math.max(0, now - arrival);

  $('pTrackLeft').style.width = `${arrival}%`;
  $('pTrackSpend').style.left = `${arrival}%`;
  $('pTrackSpend').style.width = `${spend}%`;

  const mark = $('pTrackReserve');
  mark.style.left = `${Math.min(100, cond.reservePercent)}%`;
  mark.classList.toggle('hidden', cond.reservePercent <= 0);

  $('pKeyLeft').textContent = `${Math.round(arrival)}% on arrival`;
  $('pKeySpend').textContent = cond.tripKm > 0
    ? `${Math.round(spend)}% for ${Math.round(cond.tripKm)} km`
    : 'no trip set';
  $('pKeyReserve').textContent = `${Math.round(cond.reservePercent)}% reserve`;
}

/** Recompute and repaint the setup screen. Cheap enough to run on every input. */
export function render() {
  syncOutputs();

  const cond = readConditions();
  const p = predict(cond);

  // Arrival leads: before setting off, the question is "do I make it?", and
  // that is a percentage. The countdown leads the LIVE screen instead, where
  // the question has become "how long have I got?".
  $('pArrival').textContent = p.arrivalSoc >= 0 ? Math.round(p.arrivalSoc) : 0;
  $('pTimeToEmpty').textContent = formatDuration(p.hoursToEmpty);
  $('pEmptyClock').textContent = isFinite(p.hoursToEmpty) && cond.tripKm > 0
    ? `Flat out at ${Math.round(cond.speedKmh)} km/h this charge runs out around ${clockTimeIn(p.hoursToEmpty)}.`
    : '';
  $('pWhKm').textContent = Math.round(p.whPerKm);
  $('pRange').textContent = Math.round(p.kmToEmpty);
  $('pDuration').textContent = formatDuration(p.tripHours);
  $('pTripNote').textContent = cond.tripKm > 0
    ? `${Math.round(cond.tripKm)} km · ${state.tripMode === 'route' ? 'planned route' : 'entered by hand'}`
    : '';

  renderTrack(cond, p);

  const reserve = cond.reservePercent;
  const result = $('setupResult');
  let status = 'ok';
  if (cond.tripKm <= 0) {
    status = 'tight';
    setVerdict($('pVerdict'), 'tight', 'Pick a destination, or switch to entering the distance by hand.');
  } else if (p.arrivalSoc < 0) {
    status = 'bad';
    setVerdict($('pVerdict'), 'bad',
      `You run out <strong>${Math.round(p.shortfallKm)} km short</strong> of your destination.`);
  } else if (p.arrivalSoc < reserve) {
    status = 'tight';
    setVerdict($('pVerdict'), 'tight',
      `You arrive with <strong>${Math.round(p.arrivalSoc)}%</strong> — below your ${reserve}% reserve.`);
  } else {
    setVerdict($('pVerdict'), 'ok',
      `You make it with <strong>${Math.round(p.arrivalSoc)}%</strong> to spare.`);
  }
  // The status drives the colour of the hero and the track. It is never the
  // only signal — the verdict below always says it in words, and carries an
  // icon — because the amber and green here are a pair that protanopes and
  // deuteranopes cannot reliably tell apart.
  for (const s of ['ok', 'tight', 'bad']) result.classList.toggle(s, s === status);

  renderBreakdown(p.breakdown, {
    bar: 'pBar', aero: 'lgAero', roll: 'lgRoll', grade: 'lgGrade', aux: 'lgAux',
  });

  $('climateHint').textContent = climateDescription(cond);
  paintClimateCosts(cond, 'climateSetup');
  $('pAdvice').innerHTML = cond.tripKm > 0 ? buildAdvice(cond, p) : '';
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

/**
 * Explain what the current climate setting costs — and make the speed
 * dependency explicit, because that is the app's whole thesis.
 *
 * Exported because the live screen recomputes it every tick against the
 * driver's ACTUAL speed, which is where the point really lands.
 */
export function climateDescription(cond) {
  const w = climatePowerW(cond.climateLevel, cond.tempC, cond.car.heatPump, cond.occupants);
  if (w === 0) return 'Climate off — only the ~300 W baseline electronics load.';

  const perKmNow = w / Math.max(3, cond.speedKmh);
  const mode = cond.tempC > C.COMFORT_C + 1 ? 'cooling'
             : cond.tempC < C.COMFORT_C - 1 ? 'heating' : 'ventilating';
  const pump = mode === 'heating'
    ? (cond.car.heatPump ? ' (heat pump)' : ' (resistive heater — no heat pump)')
    : '';

  let text = `${(w / 1000).toFixed(1)} kW ${mode}${pump} — `
           + `${perKmNow.toFixed(0)} Wh/km at ${Math.round(cond.speedKmh)} km/h`;
  // The contrast is the point, so only show it when there IS a contrast.
  if (cond.speedKmh > 40) {
    text += `, but ${(w / 30).toFixed(0)} Wh/km if you drop to 30 km/h in traffic`;
  }
  // Say what the figures on the buttons are a share OF. Without this they are
  // four unlabelled percentages, which is its own kind of unreadable.
  const basis = cond.tripKm > 0
    ? ' Percentages above are each level\'s share of your battery over this trip.'
    : ' Percentages above are each level\'s share of your battery per hour.';
  return `${text}.${basis}`;
}

/**
 * Work out what slowing down can and cannot achieve, and say it precisely.
 *
 * Three genuinely different situations, and conflating them produces
 * contradictory advice (telling someone the trip is unreachable while quoting
 * a range figure that clearly covers it — the difference being their reserve):
 *   1. A slower speed gets you there WITH the reserve intact.
 *   2. A slower speed gets you there, but only by eating the reserve.
 *   3. No speed gets you there at all.
 */
export function speedAdvice(cond, currentSpeedKmh) {
  const withReserve = maxSustainableSpeed(cond);
  if (withReserve && withReserve < currentSpeedKmh) {
    return `Slow to <strong>${withReserve} km/h</strong> and you arrive with your ${cond.reservePercent}% reserve intact.`;
  }
  const bare = maxSustainableSpeed({ ...cond, reservePercent: 0 });
  if (bare && bare < currentSpeedKmh) {
    return `No speed keeps your ${cond.reservePercent}% reserve intact. You could just reach it at <strong>${bare} km/h</strong>, but you would arrive on essentially nothing — treat that as a last resort, not a plan.`;
  }
  return null;
}

function buildAdvice(cond, p) {
  const tips = [];

  if (!p.makesIt) {
    const speedTip = speedAdvice(cond, cond.speedKmh);
    if (speedTip) {
      tips.push(speedTip);
    } else {
      if (state.climateLevel !== 'off') {
        const off = predict({ ...cond, climateLevel: 'off' });
        const gained = off.kmToEmpty - p.kmToEmpty;
        if (gained > 1) {
          tips.push(`Speed alone won't close the gap. Turning the climate off buys about <strong>${Math.round(gained)} km</strong> — you'll still need a charging stop.`);
        }
      }
      if (tips.length === 0) tips.push('This trip is out of reach on the current charge. Plan a charging stop.');
    }
  } else {
    if (state.climateLevel !== 'off') {
      const off = predict({ ...cond, climateLevel: 'off' });
      const gained = off.kmToEmpty - p.kmToEmpty;
      if (gained >= 3) {
        tips.push(`Your climate setting is costing about <strong>${Math.round(gained)} km</strong> of range.`);
      }
    }
    if (cond.speedKmh >= 100) {
      const slower = predict({ ...cond, speedKmh: cond.speedKmh - 10 });
      const gained = slower.kmToEmpty - p.kmToEmpty;
      if (gained >= 5) {
        tips.push(`Dropping 10 km/h would add roughly <strong>${Math.round(gained)} km</strong> of range — drag rises with the square of speed.`);
      }
    }
  }

  // A meaningful "sweet spot" only exists when the climate system's per-hour
  // draw is big enough to punish you for driving slowly. With the climate off,
  // slower is simply always further, and quoting an optimum would be
  // technically true and practically useless.
  const eff = mostEfficientSpeed(cond);
  if (eff.v >= 45) {
    tips.push(`Best range right now comes at about <strong>${eff.v} km/h</strong> (${Math.round(eff.km)} km). Go slower than that and the climate system's per-hour draw starts costing you more than the drag you save.`);
  } else {
    tips.push('With this climate load, slower is simply further — drag falls away faster than the per-hour draw builds up.');
  }

  if (cond.tempC <= 5) {
    tips.push('Cold weather is hitting you three ways at once: denser air, stiffer tyres, and a pack that holds less usable energy.');
  }

  return tips.map((t) => `<p style="margin:0 0 8px">${t}</p>`).join('');
}

/**
 * Wrap advice text in the paragraph both screens use, so they stay visually
 * identical. Trusted, app-authored markup only — never user or geocoder text.
 */
export function advicePara(html) {
  return `<p style="margin:0">${html}</p>`;
}
