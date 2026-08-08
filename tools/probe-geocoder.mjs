/* Measure which Photon parameters actually improve LOCAL ranking.
 *
 *     node probe-geocoder.mjs
 *
 * There is a note in this project's history saying `location_bias_scale` and
 * `zoom` "break" the location bias. That was an observation, not an
 * explanation, and the docs suggest the causal model behind it was wrong:
 *
 *   location_bias_scale (0-1, default 0.4) = how much a result's GLOBAL
 *   PROMINENCE still counts. Higher means MORE global, not more local. So
 *   scale=1 making results worse is exactly what the parameter is for.
 *
 *   zoom (default 12) = the radius around the focus point. HIGHER is tighter.
 *
 * If that reading is right, the fix is a LOW scale and a HIGHER zoom, not
 * omitting them. This script settles it with numbers instead of opinion:
 * for a set of queries typed from a set of cities, what fraction of the top
 * results land in the right country, and how far away are they?
 */

const PHOTON = 'https://photon.komoot.io/api/';

const PLACES = [
  { city: 'Cairo',     lat: 30.0444, lon: 31.2357, cc: 'Egypt' },
  { city: 'London',    lat: 51.5074, lon: -0.1278, cc: 'United Kingdom' },
  { city: 'Tokyo',     lat: 35.6762, lon: 139.6503, cc: 'Japan' },
  { city: 'New York',  lat: 40.7128, lon: -74.0060, cc: 'United States' },
  { city: 'Mumbai',    lat: 19.0760, lon: 72.8777, cc: 'India' },
  { city: 'Sao Paulo', lat: -23.5505, lon: -46.6333, cc: 'Brazil' },
];

// Deliberately ambiguous: every one of these exists in dozens of countries,
// so an unbiased geocoder will scatter them across the globe.
const QUERIES = ['pharmacy', 'central station', 'main street', 'airport', 'museum'];

const VARIANTS = {
  'plain lat/lon':            (p) => `&lat=${p.lat}&lon=${p.lon}`,
  'scale=0.1':                (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.1`,
  'scale=0.1 zoom=14':        (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.1&zoom=14`,
  'scale=0.2 zoom=13':        (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.2&zoom=13`,
  'scale=1.0 (the old note)': (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=1`,
  'no bias at all':           () => '',
};

const R = 6371;
const toRad = (d) => (d * Math.PI) / 180;
const distKm = (a, b, c, d) => {
  const x = Math.sin(toRad(c - a) / 2) ** 2
    + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(toRad(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function score(buildBias) {
  let inCountry = 0;
  let total = 0;
  const distances = [];

  for (const place of PLACES) {
    for (const q of QUERIES) {
      const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=5${buildBias(place)}`;
      let features = [];
      try {
        const res = await fetch(url);
        if (res.ok) features = (await res.json()).features || [];
      } catch { /* network hiccup — counts as a miss */ }

      for (const f of features) {
        total++;
        if (f.properties.country === place.cc) inCountry++;
        distances.push(distKm(place.lat, place.lon,
          f.geometry.coordinates[1], f.geometry.coordinates[0]));
      }
      await sleep(120); // be polite to a free community service
    }
  }

  distances.sort((a, b) => a - b);
  return {
    localPct: total ? Math.round((inCountry / total) * 100) : 0,
    medianKm: distances.length ? Math.round(distances[Math.floor(distances.length / 2)]) : null,
    total,
  };
}

console.log(`${PLACES.length} cities x ${QUERIES.length} ambiguous queries, top 5 each\n`);
console.log('variant                     in-country   median distance');
console.log('-'.repeat(60));

for (const [name, build] of Object.entries(VARIANTS)) {
  const s = await score(build);
  console.log(`${name.padEnd(27)} ${String(s.localPct + '%').padStart(6)}   ${String(s.medianKm + ' km').padStart(12)}`);
}
