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
  formatDuration, clockTimeIn,
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

  const fmt = (v) => `${Math.round(v)} Wh/km`;
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
}

/** Recompute and repaint the setup screen. Cheap enough to run on every input. */
export function render() {
  syncOutputs();

  const cond = readConditions();
  const p = predict(cond);

  $('pTimeToEmpty').textContent = formatDuration(p.hoursToEmpty);
  $('pEmptyClock').textContent = isFinite(p.hoursToEmpty)
    ? `around ${clockTimeIn(p.hoursToEmpty)} if you set off now`
    : '';

  $('pArrival').textContent = p.arrivalSoc >= 0 ? `${Math.round(p.arrivalSoc)}%` : '0%';
  $('pWhKm').textContent = Math.round(p.whPerKm);
  $('pRange').textContent = Math.round(p.kmToEmpty);
  $('pDuration').textContent = formatDuration(p.tripHours);

  const reserve = cond.reservePercent;
  if (cond.tripKm <= 0) {
    setVerdict($('pVerdict'), 'tight', 'Pick a destination, or switch to entering the distance by hand.');
  } else if (p.arrivalSoc < 0) {
    setVerdict($('pVerdict'), 'bad',
      `You run out <strong>${Math.round(p.shortfallKm)} km short</strong> of your destination.`);
  } else if (p.arrivalSoc < reserve) {
    setVerdict($('pVerdict'), 'tight',
      `You arrive with <strong>${Math.round(p.arrivalSoc)}%</strong> — below your ${reserve}% reserve.`);
  } else {
    setVerdict($('pVerdict'), 'ok',
      `You make it with <strong>${Math.round(p.arrivalSoc)}%</strong> to spare.`);
  }

  renderBreakdown(p.breakdown, {
    bar: 'pBar', aero: 'lgAero', roll: 'lgRoll', grade: 'lgGrade', aux: 'lgAux',
  });

  $('climateHint').textContent = climateDescription(cond);
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
  const w = climatePowerW(cond.climateLevel, cond.tempC, cond.car.heatPump);
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
  return `${text}.`;
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
