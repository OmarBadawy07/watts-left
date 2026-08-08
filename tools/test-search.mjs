/* Unit tests for the search ranking. No network, no browser.
 *
 *     node test-search.mjs
 *
 * The ranking is where the judgement lives — how much "near me" should
 * outweigh "what I actually typed" — and it is the part most likely to be
 * broken by a well-meaning tweak. Testing it directly means it can be tuned
 * with confidence instead of by feel, and it does not depend on a free
 * geocoder being reachable, which it sometimes is not.
 */
import { rankPlaces, parseCoordinates } from '../js/geo.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const CAIRO = { lat: 30.0444, lon: 31.2357 };
const place = (title, kind, lat, lon) => ({ title, kind, lat, lon, subtitle: '' });

// ---------------------------------------------------------------------------
// Local results beat distant ones for ordinary things
// ---------------------------------------------------------------------------
{
  const out = rankPlaces([
    place('Pharmacy', 'poi', 33.8688, 151.2093),   // Sydney
    place('Pharmacy', 'poi', 30.0500, 31.2400),    // ~700 m away
    place('Pharmacy', 'poi', 40.7128, -74.0060),   // New York
  ], CAIRO, 'pharmacy');
  check('nearest POI ranks first', Math.round(out[0].distanceKm) <= 1,
    `top is ${Math.round(out[0].distanceKm)} km away`);
}

// ---------------------------------------------------------------------------
// ...but a deliberate long-distance search still works
// ---------------------------------------------------------------------------
{
  const out = rankPlaces([
    place('Berlin Street', 'road', 30.0460, 31.2380),  // 300 m from home
    place('Berlin', 'city', 52.5200, 13.4050),         // 2900 km away
  ], CAIRO, 'berlin');
  check('exact city name beats a local street', out[0].title === 'Berlin',
    `got "${out[0].title}"`);
}

{
  const out = rankPlaces([
    place('Tokyo Cafe', 'poi', 30.0450, 31.2360),
    place('Tokyo', 'city', 35.6762, 139.6503),
  ], CAIRO, 'tokyo');
  check('exact city beats a local POI of the same name', out[0].title === 'Tokyo',
    `got "${out[0].title}"`);
}

// ---------------------------------------------------------------------------
// Dense-city dedupe: distinct branches survive, duplicate records collapse
// ---------------------------------------------------------------------------
{
  // Four branches spread across a city, plus one duplicate record 80 m from
  // the first (OSM stores the building and the entrance separately).
  const out = rankPlaces([
    place("McDonald's", 'poi', 30.0444, 31.2357),
    place("McDonald's", 'poi', 30.0451, 31.2360),   // ~80 m — duplicate record
    place("McDonald's", 'poi', 30.0550, 31.2500),   // ~1.7 km — real branch
    place("McDonald's", 'poi', 30.0300, 31.2100),   // ~2.7 km — real branch
    place("McDonald's", 'poi', 30.0900, 31.3000),   // ~8 km  — real branch
  ], CAIRO, 'mcdonalds');
  check('distinct branches survive dedupe', out.length === 4,
    `${out.length} kept of 5 (1 duplicate expected to collapse)`);
}

{
  // The old 2-decimal rounding collapsed anything within ~1.1 km. Two branches
  // 600 m apart are genuinely different places and must both survive.
  const out = rankPlaces([
    place('Starbucks', 'poi', 30.0444, 31.2357),
    place('Starbucks', 'poi', 30.0498, 31.2357),    // ~600 m
  ], CAIRO, 'starbucks');
  check('branches 600 m apart are not merged', out.length === 2,
    `${out.length} kept of 2`);
}

{
  const out = rankPlaces([
    place('Ramses Station', 'rail', 30.0626, 31.2497),
    place('Ramses Station', 'rail', 30.0629, 31.2499),  // ~35 m, same place
  ], CAIRO, 'ramses');
  check('duplicate records of one place collapse', out.length === 1,
    `${out.length} kept of 2`);
}

// ---------------------------------------------------------------------------
// House numbers
// ---------------------------------------------------------------------------
{
  const out = rankPlaces([
    place('Tahrir Street', 'road', 30.0450, 31.2360),
    place('12 Tahrir Street', 'home', 30.0452, 31.2362),
  ], CAIRO, '12 tahrir street');
  check('a numbered address beats the bare street', out[0].title === '12 Tahrir Street',
    `got "${out[0].title}"`);
}

// ---------------------------------------------------------------------------
// Typed coordinates
// ---------------------------------------------------------------------------
check('parses "30.0444, 31.2357"', parseCoordinates('30.0444, 31.2357')?.lat === 30.0444);
check('parses space separated', parseCoordinates('-23.5505 -46.6333')?.lon === -46.6333);
check('rejects out-of-range latitude', parseCoordinates('130.0, 31.0') === null);
check('rejects ordinary text', parseCoordinates('Cairo') === null);
check('rejects a lone number', parseCoordinates('31') === null);

// ---------------------------------------------------------------------------
// No bias point at all must not throw
// ---------------------------------------------------------------------------
{
  const out = rankPlaces([place('Cairo', 'city', 30.04, 31.23)], null, 'cairo');
  check('works with no bias point', out.length === 1 && out[0].distanceKm === undefined);
}

console.log(failures ? `\n${failures} failed` : '\nall ranking tests passed');
process.exit(failures ? 1 : 0);
