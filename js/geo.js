/**
 * geo.js — Turning "Amsterdam to Cologne" into numbers the model can use.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Asking a driver for their trip's net elevation change is unreasonable —
 * nobody knows it. This module works it out for them, and while it is at it,
 * also fetches the real road distance and the actual weather along the route.
 * That removes four manual inputs: distance, elevation, temperature and wind.
 *
 * ============================================================================
 * SERVICES USED — all free, all keyless
 * ============================================================================
 *   Photon (Komoot)   place search / autocomplete, built on OpenStreetMap
 *   Nominatim (OSM)   fallback place search
 *   OSRM              real road routing — distance and route geometry
 *   Open-Meteo        ground elevation, and current temperature + wind
 *
 * These are community and demo servers. They are perfect for personal use but
 * carry no uptime guarantee and ask that you not hammer them. Every call here
 * is debounced, and every failure degrades gracefully back to manual entry —
 * the app must never become unusable because a third-party server is down.
 *
 * PRIVACY NOTE: using the trip planner sends your start and destination to
 * these third parties. The rest of the app is entirely on-device; if that
 * matters to you, enter the distance manually instead.
 */

import { toRad, haversineKm, bearing, cumulativeKm } from './geometry.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const METEO_ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** Open-Meteo accepts at most this many coordinates in one elevation request. */
const MAX_COORDS_PER_REQUEST = 100;

// ---------------------------------------------------------------------------
// 1. PLACE SEARCH
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Place
 * @property {string} title      the bold first line — "Innsbruck", "Aral Tankstelle"
 * @property {string} subtitle   the grey second line — the address context
 * @property {string} label      title + subtitle, used as the input's value
 * @property {number} lat
 * @property {number} lon
 * @property {string} kind       coarse category, drives the result icon
 * @property {number} [distanceKm] straight-line distance from the bias point
 */

/**
 * Turn a typed string into a short list of candidate places.
 *
 * Photon is the primary because it is purpose-built for type-ahead search and
 * responds quickly to partial input. Nominatim is the fallback — it is the
 * canonical OSM geocoder but is tuned for complete addresses and asks callers
 * to stay under one request per second.
 *
 * BIASING: passing a `near` point makes the geocoder rank nearby matches first,
 * which is what makes search feel like a maps app rather than a database query.
 * Typing "hauptbahnhof" near Munich should offer Munich's station, not one in
 * a city 500 km away. We bias towards whatever the map is currently looking at.
 *
 * @param {string} query
 * @param {AbortSignal} [signal] so an in-flight search can be cancelled when
 *        the user keeps typing
 * @param {{lat:number, lon:number}} [near] optional bias point
 * @returns {Promise<Place[]>}
 */
export async function searchPlaces(query, signal, near = null) {
  const q = query.trim();
  if (q.length < 2) return [];

  const bias = near ? `&lat=${near.lat.toFixed(4)}&lon=${near.lon.toFixed(4)}` : '';

  let results = [];
  try {
    const res = await fetch(`${PHOTON}?q=${encodeURIComponent(q)}&limit=8${bias}`, { signal });
    if (!res.ok) throw new Error(`photon ${res.status}`);
    const data = await res.json();
    results = (data.features || []).map((f) => ({
      ...describePhoton(f.properties),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    }));
  } catch (err) {
    // An abort is the user typing, not a failure — do not fall through to a
    // second request they no longer want.
    if (err.name === 'AbortError') throw err;
  }

  if (!results.length) {
    try { results = await searchPlacesNominatim(q, signal); } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }

  return decorate(dedupe(results), near);
}

async function searchPlacesNominatim(q, signal) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((d) => {
    // Nominatim gives one long comma-joined string; split off the first part as
    // the headline and keep the rest as context.
    const parts = d.display_name.split(', ');
    return {
      title: parts[0],
      subtitle: parts.slice(1).join(', '),
      label: d.display_name,
      kind: coarseKind(d.class, d.type),
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon),
    };
  });
}

/** Build the two-line description from Photon's structured address fields. */
function describePhoton(p = {}) {
  const street = p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.street;
  const town = p.city || p.town || p.village || p.county;

  // The headline is the most specific thing we know; everything less specific
  // becomes context. Falling back down the chain keeps a result usable even
  // when the record is sparse.
  const title = p.name || street || town || p.state || p.country || 'Unnamed place';

  const subtitle = [
    title !== street ? street : null,
    p.district,
    title !== town ? town : null,
    p.postcode,
    p.state,
    p.country,
  ].filter(Boolean).join(', ');

  return {
    title,
    subtitle,
    label: subtitle ? `${title}, ${subtitle}` : title,
    kind: coarseKind(p.osm_key, p.osm_value),
  };
}

/** Collapse OSM's hundreds of tags into the handful of icons the UI has. */
function coarseKind(key, value) {
  if (key === 'place') {
    return ['city', 'town', 'village', 'hamlet', 'suburb', 'municipality'].includes(value)
      ? 'city' : 'pin';
  }
  if (key === 'highway') return 'road';
  if (key === 'railway' || key === 'public_transport') return 'rail';
  if (key === 'aeroway') return 'air';
  if (key === 'amenity' && value === 'charging_station') return 'charge';
  if (key === 'amenity' || key === 'shop' || key === 'tourism' || key === 'leisure') return 'poi';
  if (key === 'building' || key === 'address') return 'home';
  if (key === 'boundary') return 'city';
  return 'pin';
}

/**
 * Drop duplicates — OSM stores one real-world place as many tagged records.
 *
 * A single railway station typically comes back three or four times: the
 * station area, the building, the entrance, the kiss-and-ride bay. They all
 * carry the same name a few hundred metres apart, and showing all of them
 * makes the list look broken.
 *
 * Rounding coordinates to two decimals (~1.1 km) means same-named records
 * within about a kilometre collapse into one. That is deliberately coarse:
 * two genuinely different places sharing a name AND sitting within a kilometre
 * of each other are, for the purpose of "where am I driving to", the same
 * place.
 */
function dedupe(places) {
  const seen = new Set();
  return places.filter((p) => {
    const key = `${p.title.toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Attach straight-line distance from the bias point, when there is one. */
function decorate(places, near) {
  if (!near) return places;
  return places.map((p) => ({
    ...p,
    distanceKm: haversineKm([near.lat, near.lon], [p.lat, p.lon]),
  }));
}

/**
 * Work out roughly where the user is, with no permission prompt.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Without a bias point, a geocoder ranks results by global importance. Search
 * "mcdonalds" from Cairo and you get Sydney, Caracas and Little Falls — useless.
 * With a bias point you get Cairo and Giza. The bias is the single most
 * important thing about making search feel correct, so the app needs SOME idea
 * of where you are before you have typed anything or granted anything.
 *
 * The trick: IANA timezone identifiers are city names. "Africa/Cairo",
 * "America/New_York", "Asia/Tokyo". Reading the timezone requires no
 * permission, no network call and no tracking — the browser just tells you —
 * and geocoding that city name gives a bias point that is easily good enough.
 *
 * Precision genuinely does not matter here. Being 40 km off is irrelevant when
 * the job is ranking Cairo above Sydney. This is the rare case where a very
 * rough location is exactly as useful as a precise one.
 *
 * The catch is that it follows the device clock, so a traveller who has not
 * changed their timezone gets their home city. That is why the result is
 * surfaced in the UI as an editable "Searching near X" chip rather than being
 * applied invisibly.
 *
 * @returns {Promise<Place|null>}
 */
export async function detectHomeRegion() {
  let tz;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (!tz || !tz.includes('/')) return null;

  // "America/Argentina/Buenos_Aires" -> "Buenos Aires"
  const city = tz.split('/').pop().replace(/_/g, ' ');

  // osm_tag=place keeps this to settlements, so "Africa/Cairo" cannot match a
  // shop or a street that happens to be called Cairo.
  try {
    const res = await fetch(
      `${PHOTON}?q=${encodeURIComponent(city)}&limit=1&osm_tag=place`,
    );
    if (res.ok) {
      const f = (await res.json()).features?.[0];
      if (f) {
        return {
          ...describePhoton(f.properties),
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
        };
      }
    }
  } catch { /* fall through to Nominatim */ }

  // Photon is a free community service and does occasionally blink — during
  // testing it returned a response with no CORS headers for a minute or two.
  // Losing the home region is not cosmetic: without a bias point, searching
  // "mcdonalds" from Cairo returns Sydney. So this falls back rather than
  // giving up.
  try {
    const res = await fetch(
      `${NOMINATIM}?q=${encodeURIComponent(city)}&format=json&limit=1&featureType=city`,
    );
    if (!res.ok) return null;
    const d = (await res.json())[0];
    if (!d) return null;
    const parts = d.display_name.split(', ');
    return {
      title: parts[0],
      subtitle: parts.slice(1).join(', '),
      label: d.display_name,
      kind: 'city',
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon),
    };
  } catch {
    return null;
  }
}

/**
 * Turn coordinates into a place name.
 *
 * Used for "my current location" and for pins dropped on the map. Showing
 * "Marienplatz, Munich" instead of "48.137, 11.576" is the difference between
 * a user being able to sanity-check the point and having to take it on faith —
 * which matters a great deal when the position came from a rough Wi-Fi
 * estimate rather than GPS.
 */
export async function reverseGeocode(lat, lon) {
  const fallback = {
    title: 'Dropped pin',
    subtitle: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    label: `Pin at ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    kind: 'pin',
    lat,
    lon,
  };

  try {
    const res = await fetch(`${PHOTON}reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    if (res.ok) {
      const f = (await res.json()).features?.[0];
      if (f) return { ...describePhoton(f.properties), lat, lon };
    }
  } catch { /* fall through to Nominatim */ }

  try {
    const res = await fetch(
      `${NOMINATIM.replace('/search', '/reverse')}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&format=json`,
    );
    if (res.ok) {
      const d = await res.json();
      if (d?.display_name) {
        const parts = d.display_name.split(', ');
        return {
          title: parts[0],
          subtitle: parts.slice(1).join(', '),
          label: d.display_name,
          kind: 'pin',
          lat,
          lon,
        };
      }
    }
  } catch { /* both geocoders unavailable */ }

  // Coordinates are still a usable answer — the pin works, it just has no name.
  return fallback;
}

// ---------------------------------------------------------------------------
// 2. SAMPLING ALONG A ROUTE
//
// Routing itself lives in navigation.js — it needs turn-by-turn steps and route
// alternatives, which this module never did. An earlier single-route
// fetchRoute() here was superseded by that and sat unused; it is gone.
// ---------------------------------------------------------------------------

/**
 * Pick `count` points spread evenly along the route BY DISTANCE.
 *
 * Routing geometry is not evenly spaced — it has a dense cluster of points at
 * every junction and long empty stretches on the motorway. Sampling the raw
 * array would therefore over-sample towns and under-sample the open road.
 *
 * @returns {Array<{lat:number, lon:number, km:number}>}
 */
export function sampleAlongRoute(coords, count) {
  if (coords.length < 2) return [];

  const cum = cumulativeKm(coords);
  const total = cum[cum.length - 1];

  const out = [];
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (seg < cum.length - 1 && cum[seg] < target) seg++;

    // Linear interpolation between the two vertices that straddle `target`.
    const spanKm = cum[seg] - cum[seg - 1];
    const t = spanKm > 0 ? (target - cum[seg - 1]) / spanKm : 0;
    const [lat1, lon1] = coords[seg - 1];
    const [lat2, lon2] = coords[seg];
    out.push({
      lat: lat1 + (lat2 - lat1) * t,
      lon: lon1 + (lon2 - lon1) * t,
      km: target,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. ELEVATION PROFILE
// ---------------------------------------------------------------------------

/**
 * Build a height profile for the route and total up the climbing.
 *
 * SAMPLING RESOLUTION — why roughly 1 km is enough:
 * Sampling every kilometre smooths away small undulations, which sounds like
 * it would lose accuracy. It mostly does not, because small undulations are
 * very nearly energy-neutral: you spend energy climbing a 5 m rise and regen
 * most of it back on the far side. What actually costs you energy is the
 * large-scale profile — a mountain pass, a long climb out of a valley — and
 * that survives 1 km sampling intact.
 *
 * The trade-off is real but small, and it is documented rather than hidden:
 * total climb will read slightly low on genuinely lumpy terrain.
 *
 * @returns {Promise<{samples:Array<{km:number, elevM:number}>,
 *                    netM:number, climbM:number, descentM:number,
 *                    minM:number, maxM:number}>}
 */
export async function fetchElevationProfile(coords, distanceKm) {
  // One sample per kilometre, kept inside sane bounds. 400 points is four
  // requests, which is as much as it is polite to ask of a free service.
  const count = Math.max(20, Math.min(400, Math.round(distanceKm)));
  const points = sampleAlongRoute(coords, count);

  const elevations = [];
  for (let i = 0; i < points.length; i += MAX_COORDS_PER_REQUEST) {
    const chunk = points.slice(i, i + MAX_COORDS_PER_REQUEST);
    const lats = chunk.map((p) => p.lat.toFixed(5)).join(',');
    const lons = chunk.map((p) => p.lon.toFixed(5)).join(',');
    const res = await fetch(`${METEO_ELEVATION}?latitude=${lats}&longitude=${lons}`);
    if (!res.ok) throw new Error(`Elevation service returned ${res.status}`);
    const data = await res.json();
    elevations.push(...data.elevation);
  }

  const samples = points.map((p, i) => ({ km: p.km, elevM: elevations[i] ?? 0 }));

  // Total up climbs and descents separately. This is the whole point of having
  // a profile instead of a single net figure: a route that climbs a pass and
  // comes back down has a net change of zero but is far from free, because
  // regen only returns about 65% of what the climb cost.
  let climbM = 0;
  let descentM = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].elevM - samples[i - 1].elevM;
    if (d > 0) climbM += d; else descentM += -d;
  }

  const heights = samples.map((s) => s.elevM);
  return {
    samples,
    netM: samples[samples.length - 1].elevM - samples[0].elevM,
    climbM,
    descentM,
    minM: Math.min(...heights),
    maxM: Math.max(...heights),
  };
}

// ---------------------------------------------------------------------------
// 5. WEATHER
// ---------------------------------------------------------------------------

/**
 * Current temperature and wind at a point.
 *
 * @returns {Promise<{tempC:number, windKmh:number, windFromDeg:number}>}
 *          windFromDeg is meteorological convention: the direction the wind is
 *          blowing FROM. A "northerly" of 0° blows from north towards south.
 */
export async function fetchWeather(lat, lon) {
  const url = `${METEO_FORECAST}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
            + '&current=temperature_2m,wind_speed_10m,wind_direction_10m';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const { current } = await res.json();
  return {
    tempC: current.temperature_2m,
    windKmh: current.wind_speed_10m,
    windFromDeg: current.wind_direction_10m,
  };
}

/**
 * Resolve a wind vector into the headwind the car actually experiences,
 * averaged over the whole route and weighted by segment length.
 *
 * A single average bearing would be wrong: a route that heads north then turns
 * south averages to no direction at all, yet the wind is a headwind for half of
 * it and a tailwind for the other half. Instead we resolve the component
 * segment by segment and let the long segments dominate — which is correct,
 * because that is where you spend the energy.
 *
 * The component is windSpeed x cos(windFrom - travelBearing):
 *   wind coming from straight ahead  -> cos(0)   = +1  full headwind
 *   wind coming from directly behind -> cos(180) = -1  full tailwind
 *   wind straight across             -> cos(90)  =  0  no along-track effect
 *
 * (A pure crosswind does add a little drag in reality through body yaw, but far
 * less than treating it as a headwind would imply, so ignoring it is the more
 * accurate simplification.)
 *
 * @returns {number} effective headwind in km/h; negative means a net tailwind
 */
export function effectiveHeadwind(coords, windKmh, windFromDeg) {
  if (coords.length < 2) return 0;

  let weighted = 0;
  let totalKm = 0;
  for (let i = 1; i < coords.length; i++) {
    const segKm = haversineKm(coords[i - 1], coords[i]);
    if (segKm <= 0) continue;
    const travel = bearing(coords[i - 1], coords[i]);
    weighted += Math.cos(toRad(windFromDeg - travel)) * segKm;
    totalKm += segKm;
  }
  return totalKm > 0 ? windKmh * (weighted / totalKm) : 0;
}

/** Human-readable compass point, for showing the user where the wind is from. */
export function compassPoint(deg) {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(((deg % 360) / 45)) % 8];
}
