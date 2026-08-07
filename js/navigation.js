/**
 * navigation.js — Routing, turn-by-turn guidance, and map presentation.
 *
 * ============================================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ============================================================================
 * This is a navigation engine built on free, keyless services: OSRM for
 * routing, OpenStreetMap-derived tiles for the map. It does turn-by-turn
 * directions, spoken guidance, route alternatives, off-route detection and
 * automatic rerouting.
 *
 * It is NOT Google Maps, and a few gaps are worth naming honestly:
 *   - no live traffic, so travel times are free-flow estimates
 *   - no Street View, no lane-guidance imagery
 *   - POI coverage is OpenStreetMap's, which is excellent in cities and
 *     patchier for small businesses than Google's
 *
 * What it does that Google Maps does not: compare route alternatives by
 * ENERGY. On a hilly route the shortest path is often not the cheapest one for
 * a battery, and no mainstream navigation app tells you that.
 */

import { haversineKm, cumulativeKm, projectOntoSegment } from './geometry.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

// ---------------------------------------------------------------------------
// 1. BASEMAPS
// ---------------------------------------------------------------------------

/**
 * Real basemap styles, replacing an earlier hack that CSS-inverted the standard
 * OpenStreetMap tiles to fake a dark theme. Inverting a map image also inverts
 * its labels and colour-coding — motorways come out the wrong colour and text
 * looks like a photographic negative. These are purpose-designed styles.
 */
export const BASEMAPS = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap, © CARTO',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap, © CARTO',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri',
    maxZoom: 19,
    subdomains: '',
  },
};

// ---------------------------------------------------------------------------
// 2. ROUTING
// ---------------------------------------------------------------------------

/**
 * Fetch driving routes, including alternatives and turn-by-turn steps.
 *
 * @param {Array<{lat:number, lon:number}>} points  origin, then any vias, then destination
 * @param {boolean} [alternatives]
 * @returns {Promise<Array<Route>>}
 *
 * @typedef {Object} Route
 * @property {number} distanceKm
 * @property {number} durationMin
 * @property {Array<[number,number]>} coords    [lat, lon] in travel order
 * @property {Array<Step>} steps
 * @property {number[]} cumKm      cumulative distance at each coordinate
 * @property {string} summary      the main roads used
 */
export async function fetchRoutes(points, alternatives = true) {
  const coordString = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${OSRM}${coordString}`
            + `?overview=full&geometries=geojson&steps=true&alternatives=${alternatives}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();

  if (data.code === 'NoRoute') throw new Error('No driving route exists between those points.');
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('Could not find a route.');

  return data.routes.map((r) => buildRoute(r));
}

function buildRoute(raw) {
  const coords = raw.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

  // Flatten every leg's steps into one list. Multi-leg routes only happen when
  // there are via points, but the flattening is harmless either way.
  const steps = [];
  let cursor = 0;
  for (const leg of raw.legs) {
    for (const s of leg.steps) {
      steps.push({
        instruction: describeManeuver(s),
        icon: maneuverIcon(s.maneuver),
        name: s.name || '',
        distanceM: s.distance,
        durationS: s.duration,
        startKm: cursor / 1000,
        location: [s.maneuver.location[1], s.maneuver.location[0]], // [lat, lon]
        type: s.maneuver.type,
        modifier: s.maneuver.modifier || null,
      });
      cursor += s.distance;
    }
  }

  return {
    distanceKm: raw.distance / 1000,
    durationMin: raw.duration / 60,
    coords,
    steps,
    cumKm: cumulativeKm(coords),
    summary: raw.legs.map((l) => l.summary).filter(Boolean).join(' / '),
  };
}

// ---------------------------------------------------------------------------
// 3. TURNING OSRM MANEUVERS INTO SENTENCES
// ---------------------------------------------------------------------------

const DIRECTION_WORDS = {
  'sharp left': 'sharp left',
  left: 'left',
  'slight left': 'slight left',
  straight: 'straight ahead',
  'slight right': 'slight right',
  right: 'right',
  'sharp right': 'sharp right',
  uturn: 'around',
};

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

function compass(bearing) {
  const names = ['north', 'north-east', 'east', 'south-east',
                 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(((bearing % 360) / 45)) % 8];
}

/**
 * Build the spoken/written instruction for a step.
 *
 * OSRM hands back a maneuver type and modifier rather than a sentence, so the
 * phrasing is ours. The wording deliberately mirrors what navigation apps say,
 * because those phrasings are what drivers can parse at speed without thinking.
 */
export function describeManeuver(step) {
  const m = step.maneuver;
  const road = step.name ? ` onto ${step.name}` : '';
  const onRoad = step.name ? ` on ${step.name}` : '';
  const dir = DIRECTION_WORDS[m.modifier] || '';

  switch (m.type) {
    case 'depart':
      return `Head ${compass(m.bearing_after)}${onRoad}`;
    case 'turn':
      if (m.modifier === 'straight') return `Continue straight${road}`;
      if (m.modifier === 'uturn') return `Make a U-turn${road}`;
      return `Turn ${dir}${road}`;
    case 'new name':
      return `Continue${road}`;
    case 'continue':
      return m.modifier === 'uturn' ? `Make a U-turn${road}` : `Continue${road}`;
    case 'merge':
      return `Merge ${dir}${road}`;
    case 'on ramp':
      return `Take the ramp${dir ? ` on the ${dir}` : ''}${road}`;
    case 'off ramp':
      return `Take the exit${dir ? ` on the ${dir}` : ''}${road}`;
    case 'fork':
      return `Keep ${dir}${road}`;
    case 'end of road':
      return `Turn ${dir} at the end of the road${road}`;
    case 'roundabout':
    case 'rotary':
      return m.exit
        ? `At the roundabout, take the ${ORDINALS[m.exit] || `${m.exit}th`} exit${road}`
        : `Enter the roundabout${road}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${road}`;
    case 'roundabout turn':
      return `At the roundabout, turn ${dir}${road}`;
    case 'notification':
      return `Continue${road}`;
    case 'arrive':
      if (m.modifier === 'left') return 'Arrive at your destination, on the left';
      if (m.modifier === 'right') return 'Arrive at your destination, on the right';
      return 'Arrive at your destination';
    default:
      return `Continue${road}`;
  }
}

/**
 * Which arrow to draw. Returns a key into MANEUVER_PATHS.
 * Kept coarse on purpose: a driver glancing at the screen needs to read the
 * shape instantly, so a handful of unmistakable arrows beats twenty subtle ones.
 */
export function maneuverIcon(m) {
  const t = m.type;
  const mod = m.modifier || 'straight';

  if (t === 'depart') return 'depart';
  if (t === 'arrive') return 'arrive';
  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') return 'roundabout';
  if (t === 'exit roundabout' || t === 'exit rotary') return 'roundabout';
  if (t === 'merge') return 'merge';
  if (t === 'on ramp') return 'ramp';
  if (t === 'off ramp') return 'exit';
  if (t === 'fork') return mod.includes('left') ? 'fork-left' : 'fork-right';
  if (mod === 'uturn') return 'uturn';
  if (mod === 'straight') return 'straight';
  if (mod === 'sharp left') return 'sharp-left';
  if (mod === 'sharp right') return 'sharp-right';
  if (mod === 'slight left') return 'slight-left';
  if (mod === 'slight right') return 'slight-right';
  if (mod === 'left') return 'left';
  if (mod === 'right') return 'right';
  return 'straight';
}

/** Stroked 24x24 arrow paths, one per maneuver shape. */
export const MANEUVER_PATHS = {
  straight: '<path d="M12 21V5M12 5 6.5 10.5M12 5l5.5 5.5"/>',
  left: '<path d="M18 21v-8a4 4 0 0 0-4-4H6M6 9l4.5-4.5M6 9l4.5 4.5"/>',
  right: '<path d="M6 21v-8a4 4 0 0 1 4-4h8M18 9l-4.5-4.5M18 9l4.5 4.5"/>',
  'slight-left': '<path d="M17 21v-6.5a5 5 0 0 0-1.6-3.7L8.5 4.5M8.5 4.5h5.5M8.5 4.5V10"/>',
  'slight-right': '<path d="M7 21v-6.5a5 5 0 0 1 1.6-3.7l6.9-6.3M15.5 4.5H10M15.5 4.5V10"/>',
  'sharp-left': '<path d="M17 21v-6a5 5 0 0 0-5-5H7.5M7.5 10l4-4M7.5 10l4 4"/>',
  'sharp-right': '<path d="M7 21v-6a5 5 0 0 1 5-5h4.5M16.5 10l-4-4M16.5 10l4 4"/>',
  uturn: '<path d="M8 21V10a4.5 4.5 0 0 1 9 0v4M17 14l-3.5-3.5M17 14l3.5-3.5"/>',
  'fork-left': '<path d="M12 21v-7M12 14 7 8.5V4M12 14l4.5-5"/>',
  'fork-right': '<path d="M12 21v-7M12 14l5-5.5V4M12 14 7.5 9"/>',
  merge: '<path d="M12 21v-9M12 12 7 7M12 12c0-4 2-6 5-7"/><path d="M7 7V3.5M7 7h3.5"/>',
  ramp: '<path d="M7 21V9a5 5 0 0 1 5-5h5M17 4l-3.5-3M17 4l-3.5 3"/>',
  exit: '<path d="M9 21V9a5 5 0 0 1 5-5M14 4h4M18 4l-3 3M18 4l-3-3"/>',
  roundabout: '<circle cx="10" cy="10" r="4.5"/><path d="M10 21v-6.5M14.5 10H20M20 10l-3-3M20 10l-3 3"/>',
  depart: '<circle cx="12" cy="12" r="4"/><path d="M12 21v-5M12 8V3"/>',
  arrive: '<path d="M12 21s6-6.2 6-10.6A6 6 0 0 0 6 10.4C6 14.8 12 21 12 21z"/><circle cx="12" cy="10.3" r="2.2"/>',
};

// ---------------------------------------------------------------------------
// 4. SNAPPING THE DRIVER TO THE ROUTE
//
// The great-circle maths itself lives in geometry.js — it was written out here,
// in geo.js and in app.js, with two incompatible signatures between them.
// ---------------------------------------------------------------------------

/**
 * Find where along the route the driver currently is.
 *
 * @param {Route} route
 * @param {[number,number]} position
 * @param {number} [searchFromKm] only look forward from here, so a route that
 *        doubles back on itself cannot snap the driver to the wrong pass
 * @returns {{travelledKm:number, offRouteM:number, snapped:[number,number], index:number}}
 */
export function locateOnRoute(route, position, searchFromKm = 0) {
  const { coords, cumKm } = route;
  let best = { distKm: Infinity, travelledKm: 0, snapped: position, index: 0 };

  // Skip segments well behind us. The 0.5 km of slack lets GPS noise and small
  // backtracks resolve without losing the lock.
  let startIdx = 0;
  while (startIdx < cumKm.length - 2 && cumKm[startIdx + 1] < searchFromKm - 0.5) startIdx++;

  for (let i = startIdx; i < coords.length - 1; i++) {
    const seg = projectOntoSegment(position, coords[i], coords[i + 1]);
    if (seg.distKm < best.distKm) {
      const segLen = cumKm[i + 1] - cumKm[i];
      best = {
        distKm: seg.distKm,
        travelledKm: cumKm[i] + segLen * seg.t,
        snapped: seg.point,
        index: i,
      };
    }
    // Once we are within 15 m of the line there is no better answer worth
    // hunting for, and stopping early keeps this cheap on long routes.
    if (best.distKm < 0.015) break;
  }

  return {
    travelledKm: best.travelledKm,
    offRouteM: best.distKm * 1000,
    snapped: best.snapped,
    index: best.index,
  };
}

/**
 * Which step are we driving, and how far to the next manoeuvre?
 *
 * OSRM places each step's manoeuvre at its START, so while you are driving
 * step i, the turn you are approaching is the manoeuvre of step i+1.
 */
export function currentGuidance(route, travelledKm) {
  const steps = route.steps;
  let i = 0;
  while (i < steps.length - 1 && steps[i + 1].startKm <= travelledKm) i++;

  const upcoming = steps[i + 1] || steps[steps.length - 1];
  const distanceToManeuverM = Math.max(0, (upcoming.startKm - travelledKm) * 1000);

  return {
    stepIndex: i,
    current: steps[i],
    upcoming,
    distanceToManeuverM,
    isFinal: i >= steps.length - 2,
  };
}

// ---------------------------------------------------------------------------
// 5. VOICE GUIDANCE
// ---------------------------------------------------------------------------

/**
 * Spoken directions through the browser's built-in speech synthesiser.
 *
 * Free, offline on most platforms, and no API key. The announcement ladder
 * mirrors what drivers expect: a long-range warning, a get-ready warning, and
 * a call at the turn itself. Thresholds scale with speed, because "in 300
 * metres" is ample warning in town and far too late at 120 km/h.
 */
export class VoiceGuide {
  constructor() {
    this.enabled = 'speechSynthesis' in window;
    this.spokenFor = new Map(); // stepIndex -> highest tier already announced
    this.lastSpokenAt = 0;
  }

  reset() {
    this.spokenFor.clear();
    if (this.enabled) window.speechSynthesis.cancel();
  }

  say(text, { force = false } = {}) {
    if (!this.enabled || !text) return;
    // Never stack announcements on top of each other.
    const now = Date.now();
    if (!force && now - this.lastSpokenAt < 2500) return;
    this.lastSpokenAt = now;

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  }

  /**
   * Decide whether this moment deserves an announcement.
   * @param {number} stepIndex   which manoeuvre is upcoming
   * @param {string} instruction what to say
   * @param {number} distanceM   how far away it is
   * @param {number} speedKmh    current speed, used to scale the warning distances
   */
  update(stepIndex, instruction, distanceM, speedKmh) {
    if (!this.enabled) return;

    // Roughly 30 seconds, 12 seconds and 4 seconds of travel time ahead.
    const perSecond = Math.max(8, speedKmh) / 3.6;
    const far = Math.min(2000, Math.max(300, perSecond * 30));
    const near = Math.max(120, perSecond * 12);
    const now = Math.max(30, perSecond * 4);

    const tier = distanceM <= now ? 3 : distanceM <= near ? 2 : distanceM <= far ? 1 : 0;
    if (tier === 0) return;

    const already = this.spokenFor.get(stepIndex) || 0;
    if (tier <= already) return;
    this.spokenFor.set(stepIndex, tier);

    const prefix = tier === 3 ? '' : `In ${formatDistance(distanceM)}, `;
    const text = tier === 3
      ? instruction
      : prefix + instruction.charAt(0).toLowerCase() + instruction.slice(1);
    this.say(text, { force: tier === 3 });
  }
}

// ---------------------------------------------------------------------------
// 6. FORMATTING
// ---------------------------------------------------------------------------

/** Distances the way a navigation app says them, not the way a computer would. */
export function formatDistance(metres) {
  if (metres < 10) return 'now';
  if (metres < 500) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  if (metres < 10000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000)} km`;
}

export function formatDuration(minutes) {
  if (!isFinite(minutes)) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}

/** Wall-clock arrival time, e.g. "14:32". */
export function arrivalClock(minutesFromNow) {
  if (!isFinite(minutesFromNow)) return '—';
  const t = new Date(Date.now() + minutesFromNow * 60000);
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
