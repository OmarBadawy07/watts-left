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

/**
 * How long to wait for a geocoder before giving up on it.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * A dead service is not the problem — the app has a second geocoder for that.
 * A SLOW one is, because the browser's own connection timeout is around thirty
 * seconds, and the fallback cannot start until the first attempt finishes.
 *
 * Measured: with Photon unreachable, search took over 30 s to return anything
 * at all. It did eventually work, which is worse than failing, because the
 * search box just sits on "Searching…" long enough that any real person
 * concludes the app is broken.
 *
 * Four seconds is well beyond a healthy response (typically 200-400 ms) and
 * short enough that falling back still feels like search rather than a hang.
 */
const GEOCODER_TIMEOUT_MS = 4000;

/**
 * fetch() with a deadline, still honouring the caller's own abort signal.
 *
 * The caller's signal means "the user typed another character"; the deadline
 * means "this service is not answering". Both must be able to cancel the
 * request, so they are combined rather than one replacing the other.
 */
async function fetchSoon(url, signal, ms = GEOCODER_TIMEOUT_MS) {
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(), ms);
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetch(url, { signal: timer.signal });
  } catch (err) {
    // Distinguish "the user moved on" from "this service is too slow". Only
    // the first should stop the search; the second must fall through to the
    // other provider.
    if (signal?.aborted) {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    throw new Error(`timeout or network failure after ${ms} ms`);
  } finally {
    clearTimeout(stop);
    signal?.removeEventListener('abort', onAbort);
  }
}

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
 * ============================================================================
 * HOW THIS FINDS THINGS ANYWHERE IN THE WORLD
 * ============================================================================
 * Four things have to be true for a search box to feel like a maps app rather
 * than a database query, and each is handled somewhere below:
 *
 *  1. IT KNOWS ROUGHLY WHERE YOU ARE, before you type anything and without
 *     asking permission — see detectHomeRegion(). Without a bias point a
 *     geocoder ranks by global fame, so "pharmacy" from Cairo returns Sydney.
 *
 *  2. IT ASKS THE RIGHT ENGINE. Photon is built for type-ahead and is strong
 *     on names and partial input; Nominatim is the canonical OSM geocoder and
 *     far better at a complete address with a house number. Both are asked,
 *     rather than one being a fallback for the other, so a house-number search
 *     no longer depends on whatever Photon could manage.
 *
 *  3. IT RANKS THE MERGED RESULT ITSELF. Neither provider's ordering survives
 *     a merge, and the balance between "near me" and "what I actually typed"
 *     is a product decision, not an API default — see rankPlaces().
 *
 *  4. IT STILL WORKS WHEN A SERVICE DOES NOT. Both are free community servers.
 *     Every request has a deadline, and either engine alone is enough.
 *
 * Biasing RANKS, it does not RESTRICT: biased to Cairo, "Berlin" still returns
 * Berlin, Germany first, so planning a trip abroad works.
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

  // Typed coordinates are a place too, and no geocoder handles them well.
  const coord = parseCoordinates(q);
  if (coord) return [coord];

  // Both geocoders, not one with the other as a fallback.
  //
  // They are good at different things: Photon is built for type-ahead and is
  // strong on names and partial input, while Nominatim is the canonical OSM
  // geocoder and far better at complete addresses with a house number. Running
  // Nominatim only when Photon returned NOTHING meant its strength was never
  // used — a house number search fell to whatever Photon could manage.
  //
  // Nominatim's public server asks for at most one request a second, so it is
  // called only when the query looks like it needs it, and throttled on top.
  const [photon, nominatim] = await Promise.all([
    breakerAllows(photonBreaker)
      ? searchPhoton(q, signal, near).catch(passAbort)
      : Promise.resolve([]),
    looksLikeAddress(q)
      ? searchNominatim(q, signal, near).catch(passAbort)
      : Promise.resolve([]),
  ]);

  let merged = [...photon, ...nominatim];

  // Photon can go away — it is a free community service, it rate-limits, and
  // during development it blocked this machine outright after too many probe
  // requests. When it does, a query without a digit would otherwise return
  // NOTHING, because Nominatim was never asked. Ask it now.
  //
  // This is the difference between "search is a bit worse today" and "search
  // is broken", and it costs one request in the rare case it is needed.
  if (!merged.length) {
    merged = await searchNominatim(q, signal, near).catch(passAbort);
  }

  return rankPlaces(merged, near, q).slice(0, 8);
}

/** An abort is the user still typing, not a failure — let it propagate. */
function passAbort(err) {
  if (err?.name === 'AbortError') throw err;
  return [];
}

/**
 * ============================================================================
 * STOP ASKING A SERVICE THAT HAS ALREADY SAID NO
 * ============================================================================
 * The timeout above stops a dead provider hanging the app, but on its own it
 * makes every single search pay the full penalty: measured at 4.2 s per query
 * with Photon unreachable, on every keystroke, forever. Correct, and horrible.
 *
 * So failures are remembered. Two in a row and Photon is skipped entirely for
 * a couple of minutes, which takes search straight to Nominatim and back down
 * to normal speed. After the cool-off it is tried again — outages end, and an
 * app that gives up permanently is its own kind of bug.
 *
 * One success resets everything: this must never latch on a single bad moment
 * on a train.
 */
const BREAKER_TRIP_AFTER = 2;
const BREAKER_COOLOFF_MS = 120000;

const photonBreaker = { failures: 0, openUntil: 0 };

function breakerAllows(b) {
  return Date.now() >= b.openUntil;
}

function breakerRecord(b, ok) {
  if (ok) {
    b.failures = 0;
    b.openUntil = 0;
    return;
  }
  b.failures++;
  if (b.failures >= BREAKER_TRIP_AFTER) b.openUntil = Date.now() + BREAKER_COOLOFF_MS;
}

/** A digit usually means a house number or a postcode: Nominatim's territory. */
function looksLikeAddress(q) {
  return /\d/.test(q);
}

// ---------------------------------------------------------------------------
// 1a. Providers
// ---------------------------------------------------------------------------

/**
 * Photon, tuned by measurement rather than by feel.
 *
 * ============================================================================
 * WHAT location_bias_scale AND zoom ACTUALLY DO
 * ============================================================================
 * There was a long-standing note in this project saying these two parameters
 * "break" the location bias, so plain lat/lon was used alone. That was a real
 * observation with the wrong explanation, and it cost accuracy for months.
 *
 *   location_bias_scale (0-1, default 0.4) is how much a result's GLOBAL
 *   PROMINENCE still counts. HIGHER means MORE global. Setting it to 1 — which
 *   is what that note was based on — asks for maximum global prominence, so of
 *   course results scattered worldwide.
 *
 *   zoom (default 12) is the radius of the focus. HIGHER is TIGHTER.
 *
 * Measured over 6 cities x 5 deliberately ambiguous queries (tools/probe-
 * geocoder.mjs), fraction of results landing in the right country and the
 * median distance from the user:
 *
 *     plain lat/lon        45%    15 km
 *     scale=0.2 zoom=13    51%    10 km      <- chosen
 *     scale=0.1 zoom=14    47%     6 km
 *     scale=1.0            8%   5705 km      <- the old note's setting
 *
 * scale=0.2/zoom=13 was chosen over the tighter option because searching for
 * somewhere deliberately far away still has to work — this app plans road
 * trips. tools/probe-faraway.mjs is the regression test for that.
 */
async function searchPhoton(q, signal, near) {
  const params = new URLSearchParams({ q, limit: '10' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lon.toFixed(4));
    params.set('location_bias_scale', '0.2');
    params.set('zoom', '13');
  }
  const lang = photonLanguage();
  if (lang) params.set('lang', lang);

  let res;
  try {
    res = await fetchSoon(`${PHOTON}?${params}`, signal);
  } catch (err) {
    // A user abort says nothing about the service's health, so it must not
    // count towards tripping the breaker.
    if (err.name !== 'AbortError') breakerRecord(photonBreaker, false);
    throw err;
  }
  if (!res.ok) {
    breakerRecord(photonBreaker, false);
    throw new Error(`photon ${res.status}`);
  }
  breakerRecord(photonBreaker, true);

  const data = await res.json();
  return (data.features || []).map((f) => ({
    ...describePhoton(f.properties),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    source: 'photon',
  }));
}

/**
 * The public Photon translates into a fixed set of languages. Sending anything
 * else is not an error — it falls back to the local name, which is usually
 * what someone in that country wants anyway — so this only names the ones
 * worth asking for and stays quiet otherwise.
 */
const PHOTON_LANGS = new Set(['en', 'de', 'fr', 'it']);

function photonLanguage() {
  const tag = (navigator.language || 'en').toLowerCase().split('-')[0];
  return PHOTON_LANGS.has(tag) ? tag : null;
}

/**
 * Nominatim, with the viewbox used as a BOOST rather than a filter.
 *
 * `bounded=0` (the default) makes viewbox bias the ranking without excluding
 * anything outside it, which is exactly the behaviour this app needs: local
 * results first, but a search for somewhere abroad still works.
 */
async function searchNominatim(q, signal, near) {
  await nominatimThrottle();

  const params = new URLSearchParams({
    q, format: 'json', limit: '6', addressdetails: '1', dedupe: '1',
  });
  if (near) {
    // Roughly ±80 km, which is a plausible "around here" for a driver.
    const d = 0.7;
    params.set('viewbox',
      `${(near.lon - d).toFixed(3)},${(near.lat - d).toFixed(3)},`
      + `${(near.lon + d).toFixed(3)},${(near.lat + d).toFixed(3)}`);
    params.set('bounded', '0');
  }
  if (navigator.language) params.set('accept-language', navigator.language);

  const res = await fetchSoon(`${NOMINATIM}?${params}`, signal);
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((d) => ({
    ...describeNominatim(d),
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    source: 'nominatim',
  }));
}

/**
 * Keep to Nominatim's stated limit of one request per second.
 *
 * The search box debounces at 250 ms, so without this a fast typist would
 * comfortably exceed what a free community service asks for. Being a good
 * citizen of these APIs is not optional — they are the only reason this app
 * needs no API key.
 */
let nominatimNextAllowedAt = 0;
function nominatimThrottle() {
  const now = Date.now();
  const wait = Math.max(0, nominatimNextAllowedAt - now);
  nominatimNextAllowedAt = now + wait + 1100;
  return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

/** Nominatim gives one long comma-joined string; split off the headline. */
function describeNominatim(d) {
  const a = d.address || {};
  const parts = d.display_name.split(', ');
  // With addressdetails we can do better than "first comma-separated chunk":
  // name the thing, then say where it is.
  const house = [a.house_number, a.road].filter(Boolean).join(' ');
  const title = a.amenity || a.shop || a.tourism || a.building
    || house || parts[0];
  return {
    title,
    subtitle: parts.filter((p) => p !== title).join(', '),
    label: d.display_name,
    kind: coarseKind(d.class, d.type),
  };
}

// ---------------------------------------------------------------------------
// 1b. Typed coordinates
// ---------------------------------------------------------------------------

/**
 * Accept a raw coordinate pair as a search result.
 *
 * "30.0444, 31.2357" is a perfectly good way to name a place — it is what you
 * get when someone shares a location, or copies a pin out of another map — and
 * no geocoder handles it, because it is not a name. Cheap to support and it
 * removes a dead end.
 */
export function parseCoordinates(text) {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return {
    title: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    subtitle: 'Coordinates',
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    kind: 'pin',
    lat,
    lon,
  };
}

/** Build the two-line description from Photon's structured address fields. */
function describePhoton(p = {}) {
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
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

// ---------------------------------------------------------------------------
// 1c. Merging and ranking two providers
// ---------------------------------------------------------------------------

/** How much a result type is worth on its own merits. */
const KIND_SCORE = {
  city: 12, home: 8, road: 7, charge: 6, air: 6, rail: 5, poi: 4, pin: 2,
};

/**
 * How much PROXIMITY should matter, by result type.
 *
 * Someone typing a city name means that city, wherever it is — "Berlin" from
 * Cairo is a road trip, not a mistake. Someone typing a shop or a street
 * almost always means one near them. Judging both by distance equally is what
 * makes a search box feel stupid in one direction or the other.
 */
const PROXIMITY_WEIGHT = {
  city: 0.35, road: 1, home: 1, poi: 1, charge: 1, rail: 0.8, air: 0.5, pin: 0.9,
};

/** Most a partial match can score: prefix 45 + best kind 12 + proximity 50. */
const BEST_PARTIAL = 107;
/** An exact name match must beat that outright. See rankPlaces(). */
const EXACT_MATCH = BEST_PARTIAL + 33;

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Score and order the combined results.
 *
 * Neither provider's own ordering can be trusted once you merge two of them,
 * and each optimises for something slightly different anyway. Ranking here
 * puts the decision in one place where it can be reasoned about — and where
 * the balance between "near me" and "what I actually typed" is explicit
 * rather than an accident of whichever API answered first.
 */
export function rankPlaces(places, near, query) {
  const q = norm(query);

  const scored = places.map((p) => {
    const title = norm(p.title || '');
    let score = KIND_SCORE[p.kind] ?? 0;

    // Name match.
    //
    // EXACT_MATCH is not a tuned number, it is an invariant: an exact name
    // match must outrank the best possible partial match, so that typing
    // "Berlin" in Cairo gives Berlin, Germany rather than a Berlin Street
    // three hundred metres away. The best a partial can score is
    //   prefix (45) + best kind (12) + full proximity (50) = 107,
    // so anything above that guarantees it. Change those and change this.
    if (title === q) score += EXACT_MATCH;
    else if (title.startsWith(q)) score += 45;
    else if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) score += 28;
    else if (title.includes(q)) score += 12;

    // Proximity, on a log curve: the difference between 2 km and 20 km matters
    // far more than the difference between 500 km and 5000 km.
    let distanceKm;
    if (near) {
      distanceKm = haversineKm([near.lat, near.lon], [p.lat, p.lon]);
      const closeness = Math.max(0, 1 - Math.log10(1 + distanceKm / 4) / Math.log10(1 + 150));
      score += 50 * closeness * (PROXIMITY_WEIGHT[p.kind] ?? 1);
    }

    // A result carrying a house number answers a more specific question than
    // one that does not, so prefer it when someone typed a number.
    if (/\d/.test(query) && /\d/.test(p.title || '')) score += 15;

    return { ...p, distanceKm, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return dedupe(scored);
}

/**
 * Drop duplicates — OSM stores one real-world place as many tagged records,
 * and running two geocoders guarantees genuine overlap on top of that.
 *
 * A single railway station typically comes back three or four times: the
 * station area, the building, the entrance, the kiss-and-ride bay. They carry
 * the same name a few hundred metres apart, and showing all of them makes the
 * list look broken.
 *
 * This used to round coordinates to two decimals, roughly 1.1 km. That was too
 * coarse for a dense city: two genuinely different branches of the same chain
 * 600 m apart collapsed into one, so a search for a shop in a city centre
 * silently hid most of the answers. Comparing real distances against a 350 m
 * threshold keeps distinct branches while still folding the duplicate records
 * of a single place — and it has no cell-boundary artefacts, where two points
 * 50 m apart could land either side of a rounding step.
 *
 * Input must already be sorted best-first: the first of a cluster survives.
 */
const DUPLICATE_RADIUS_KM = 0.35;

function dedupe(places) {
  const kept = [];
  for (const p of places) {
    const title = norm(p.title || '');
    const clash = kept.some((k) => norm(k.title || '') === title
      && haversineKm([k.lat, k.lon], [p.lat, p.lon]) < DUPLICATE_RADIUS_KM);
    if (!clash) kept.push(p);
  }
  return kept;
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
    const res = await fetchSoon(
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
    const res = await fetchSoon(
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
    const res = await fetchSoon(`${PHOTON}reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    if (res.ok) {
      const f = (await res.json()).features?.[0];
      if (f) return { ...describePhoton(f.properties), lat, lon };
    }
  } catch { /* fall through to Nominatim */ }

  try {
    const res = await fetchSoon(
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
    const res = await fetchSoon(`${METEO_ELEVATION}?latitude=${lats}&longitude=${lons}`, null, 8000);
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
  const res = await fetchSoon(url, null, 8000);
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
