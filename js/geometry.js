/**
 * geometry.js — the great-circle maths every other module needs.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `haversineKm` used to be written out three times — in app.js, geo.js and
 * navigation.js — and, worse, with TWO DIFFERENT CALLING CONVENTIONS. app.js
 * took four loose numbers, the other two took a pair of [lat, lon] arrays:
 *
 *     haversineKm(lat1, lon1, lat2, lon2)     // app.js
 *     haversineKm([lat1, lon1], [lat2, lon2]) // geo.js, navigation.js
 *
 * Both compiled. Both ran. Calling one with the other's arguments would have
 * returned a confidently wrong distance rather than an error, which is the
 * worst kind of bug in a range app: no crash, just a number that is quietly
 * incorrect. One definition, one signature, no ambiguity.
 *
 * Everything here is pure — no DOM, no network, no state — so it can be
 * imported by any module and tested from Node without a browser.
 *
 * CONVENTION: every point is `[latitude, longitude]`, in that order, always.
 * (GeoJSON and OSRM use [lon, lat]; those are flipped at the boundary where
 * they enter the app, never carried inwards.)
 */

/** Mean Earth radius in kilometres. */
const EARTH_R_KM = 6371;

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Great-circle distance between two [lat, lon] points, in kilometres.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number} kilometres
 */
export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(h));
}

/**
 * Compass bearing travelled when going from a to b, in degrees clockwise from
 * north. Used to resolve a wind vector onto the direction of travel.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number} 0-360
 */
export function bearing([lat1, lon1], [lat2, lon2]) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
          - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Cumulative distance along a list of [lat, lon] points, in kilometres.
 *
 * The result is always the same length as the input, starting at 0, so
 * `cum[i]` is how far you have travelled by the time you reach `coords[i]`.
 * Derived rather than stored: recomputing it is instant, and persisting it
 * would double the size of a saved route for no benefit.
 *
 * @param {Array<[number, number]>} coords
 * @returns {number[]}
 */
export function cumulativeKm(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]));
  }
  return cum;
}

/**
 * Project a point onto a line segment, in a local flat approximation.
 *
 * Over the tens of metres that matter for snapping a driver to a road,
 * treating latitude/longitude as a flat plane (with longitude scaled by
 * cos(latitude)) is accurate to well under a metre — far below GPS noise — and
 * is dramatically cheaper than spherical geometry on every segment at 1 Hz.
 *
 * @returns {{t:number, point:[number,number], distKm:number}} `t` is how far
 *          along the segment the closest point lies, clamped to [0, 1].
 */
export function projectOntoSegment(p, a, b) {
  const latScale = Math.cos(toRad(p[0]));
  const ax = a[1] * latScale; const ay = a[0];
  const bx = b[1] * latScale; const by = b[0];
  const px = p[1] * latScale; const py = p[0];

  const dx = bx - ax; const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));

  const projected = [ay + t * dy, (ax + t * dx) / latScale];
  return { t, point: projected, distKm: haversineKm(p, projected) };
}
