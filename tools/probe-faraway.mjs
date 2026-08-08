/* The counter-test to probe-geocoder.mjs.
 *
 * Tightening the location bias improves local results — but this app plans
 * road trips, and someone in Cairo searching "Berlin" must still get Berlin,
 * Germany. The bias is supposed to RANK, not RESTRICT. Over-tuning for local
 * would quietly destroy that, and it is the kind of regression nobody notices
 * until they try to plan a trip abroad.
 *
 * So: from each home city, search for famous places thousands of km away and
 * check the correct one is the FIRST result.
 */

const PHOTON = 'https://photon.komoot.io/api/';

const HOMES = [
  { city: 'Cairo',    lat: 30.0444, lon: 31.2357 },
  { city: 'New York', lat: 40.7128, lon: -74.0060 },
  { city: 'Tokyo',    lat: 35.6762, lon: 139.6503 },
];

// query -> the country the top hit must be in
const FARAWAY = [
  ['Berlin', 'Germany'],
  ['Eiffel Tower', 'France'],
  ['Sydney Opera House', 'Australia'],
  ['Times Square', 'United States'],
  ['Colosseum', 'Italy'],
  ['Machu Picchu', 'Peru'],
];

const VARIANTS = {
  'plain lat/lon':     (p) => `&lat=${p.lat}&lon=${p.lon}`,
  'scale=0.2 zoom=13': (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.2&zoom=13`,
  'scale=0.1 zoom=14': (p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.1&zoom=14`,
  'scale=0.15 zoom=12':(p) => `&lat=${p.lat}&lon=${p.lon}&location_bias_scale=0.15&zoom=12`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, build] of Object.entries(VARIANTS)) {
  let topHit = 0;
  let inTop5 = 0;
  let total = 0;
  const misses = [];

  for (const home of HOMES) {
    for (const [q, wantCountry] of FARAWAY) {
      total++;
      const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=5${build(home)}`;
      let features = [];
      try {
        const res = await fetch(url);
        if (res.ok) features = (await res.json()).features || [];
      } catch { /* counts as a miss */ }

      const countries = features.map((f) => f.properties.country);
      if (countries[0] === wantCountry) topHit++;
      else if (countries.includes(wantCountry)) inTop5++;
      else misses.push(`${q} from ${home.city} -> ${countries[0] || 'nothing'}`);

      await sleep(150);
    }
  }

  console.log(`${name.padEnd(20)} first: ${topHit}/${total}   in top 5: ${topHit + inTop5}/${total}`);
  for (const m of misses) console.log(`    miss: ${m}`);
}
