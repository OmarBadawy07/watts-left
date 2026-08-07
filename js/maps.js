/**
 * maps.js — every line of Leaflet in the app, and nothing else.
 *
 * ============================================================================
 * WHY TWO MAP INSTANCES
 * ============================================================================
 *   planMap — the full-screen route planner
 *   navMap  — the full-screen navigation view
 *
 * One shared map moved between screens sounds tidier, but Leaflet has to
 * re-measure and re-render every time its container changes size or
 * visibility, which produced a visible grey flash on every screen change.
 * Two instances cost a little memory and remove the problem entirely.
 */

import { $ } from './dom.js';
import { state, nav, ui } from './state.js';
import { BASEMAPS } from './navigation.js';

export const maps = {
  plan: { map: null, tiles: null, routeLayers: [], start: null, end: null, me: null },
  nav: { map: null, tiles: null, route: null, travelled: null, me: null, end: null },
};

/** Where the planner opens before it knows anything about you. */
const DEFAULT_VIEW = [30.04, 31.24];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function makeMap(containerId, opts = {}) {
  const m = L.map(containerId, {
    zoomControl: false,
    attributionControl: true,
    // Leaflet's default 1px "tap tolerance" makes dragging feel sticky on
    // touch screens; a slightly larger value feels like a native map.
    tapTolerance: 15,
    ...opts,
  });
  L.control.zoom({ position: 'topright' }).addTo(m);
  return m;
}

function applyBasemap(slot) {
  const cfg = BASEMAPS[ui.basemap];
  if (slot.tiles) slot.tiles.remove();
  slot.tiles = L.tileLayer(cfg.url, {
    maxZoom: cfg.maxZoom,
    attribution: cfg.attribution,
    subdomains: cfg.subdomains || 'abc',
    // Retina tiles where the provider offers them; {r} resolves to "@2x".
    detectRetina: ui.basemap !== 'satellite',
  }).addTo(slot.map);
}

/**
 * Switch basemap style. Does NOT persist — the caller decides whether this was
 * a user choice worth remembering or just the restore-on-load pass. Keeping
 * persistence out of here is what stops maps.js and persistence.js becoming
 * circular.
 */
export function setBasemap(style) {
  ui.basemap = style;
  $('layerMenu').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.basemap === style);
  });
  for (const slot of [maps.plan, maps.nav]) if (slot.map) applyBasemap(slot);
}

export function ensurePlanMap(onMapClick) {
  if (maps.plan.map || typeof L === 'undefined') return;
  maps.plan.map = makeMap('planMap').setView(DEFAULT_VIEW, 5);
  applyBasemap(maps.plan);
  if (onMapClick) maps.plan.map.on('click', onMapClick);
  if (state.home) maps.plan.map.setView([state.home.lat, state.home.lon], 11);
}

export function ensureNavMap(onDragStart) {
  if (maps.nav.map || typeof L === 'undefined') return;
  maps.nav.map = makeMap('navMap', { zoomControl: false }).setView(DEFAULT_VIEW, 15);
  applyBasemap(maps.nav);
  // Dragging the map during navigation means "let me look around", so it
  // suspends camera following until the recentre button is pressed.
  if (onDragStart) maps.nav.map.on('dragstart', onDragStart);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export function pinIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="map-pin ${kind}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export const ME_ICON = () => L.divIcon({
  className: '', html: '<div class="me-dot"></div>',
  iconSize: [20, 20], iconAnchor: [10, 10],
});

/** Drop or move the "you are here" dot on the planner map. */
export function showMeOnPlanMap(lat, lon, zoomTo) {
  if (!maps.plan.map) return;
  if (maps.plan.me) maps.plan.me.remove();
  maps.plan.me = L.marker([lat, lon], { icon: ME_ICON() }).addTo(maps.plan.map);
  if (zoomTo) maps.plan.map.setView([lat, lon], 14);
}

// ---------------------------------------------------------------------------
// The planner map
// ---------------------------------------------------------------------------

/** Draw every alternative, with the chosen one highlighted and on top. */
export function drawRouteAlternatives(onSelect) {
  const slot = maps.plan;
  if (!slot.map) return;

  slot.routeLayers.forEach((l) => l.remove());
  slot.routeLayers = [];

  // Draw unselected routes first so the chosen one is always on top.
  const order = state.routes
    .map((r, i) => i)
    .sort((a, b) => (a === state.selectedRoute ? 1 : 0) - (b === state.selectedRoute ? 1 : 0));

  for (const i of order) {
    const chosen = i === state.selectedRoute;
    // A wide transparent "casing" underneath makes a thin line easy to tap.
    const casing = L.polyline(state.routes[i].coords, {
      color: chosen ? '#38e08a' : '#7b8aa5',
      weight: chosen ? 11 : 9,
      opacity: chosen ? 0.28 : 0.16,
    }).addTo(slot.map);
    const line = L.polyline(state.routes[i].coords, {
      color: chosen ? '#38e08a' : '#7b8aa5',
      weight: chosen ? 6 : 4,
      opacity: chosen ? 1 : 0.75,
      dashArray: chosen ? null : '1,9',
      lineCap: 'round',
    }).addTo(slot.map);
    line.on('click', (e) => { L.DomEvent.stop(e); onSelect(i); });
    casing.on('click', (e) => { L.DomEvent.stop(e); onSelect(i); });
    slot.routeLayers.push(casing, line);
  }

  if (slot.start) slot.start.remove();
  if (slot.end) slot.end.remove();
  const c = state.route.coords;
  slot.start = L.marker(c[0], { icon: pinIcon('start') }).addTo(slot.map);
  slot.end = L.marker(c[c.length - 1], { icon: pinIcon('end') }).addTo(slot.map);
}

/** Remove every route line and the endpoint pin for `which`. */
export function clearPlanRoute(which) {
  const slot = maps.plan;
  slot.routeLayers.forEach((l) => l.remove());
  slot.routeLayers = [];
  if (which === 'from' && slot.start) { slot.start.remove(); slot.start = null; }
  if (which === 'to' && slot.end) { slot.end.remove(); slot.end = null; }
}

export function fitPlanMap() {
  const slot = maps.plan;
  if (!slot.map || !state.route?.coords?.length) return;
  const bounds = L.latLngBounds(state.route.coords);
  slot.map.fitBounds(bounds, { paddingTopLeft: [30, 190], paddingBottomRight: [30, 250] });
}

/** Centre the planner on the detected home region, unless a route is showing. */
export function centreOnHome() {
  if (!state.home || !maps.plan.map) return;
  if (!state.route) maps.plan.map.setView([state.home.lat, state.home.lon], 11);
}

// ---------------------------------------------------------------------------
// The navigation map
// ---------------------------------------------------------------------------

/** Draw the route on the navigation map, plus a "travelled" overlay. */
export function drawNavRoute() {
  const slot = maps.nav;
  if (!slot.map) return;

  for (const key of ['route', 'travelled', 'end']) {
    if (slot[key]) { slot[key].remove(); slot[key] = null; }
  }
  // Guard on the geometry, not merely on the route object existing. A restored
  // route carries distance and duration but may have no coordinates at all.
  if (!state.route?.coords?.length) return;

  slot.route = L.polyline(state.route.coords, {
    color: '#38e08a', weight: 7, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
  }).addTo(slot.map);

  // Drawn on top in a muted colour so the road already covered visibly falls
  // behind you — the clearest signal that the app is tracking your progress.
  slot.travelled = L.polyline([], {
    color: '#54627d', weight: 7, opacity: 0.85, lineCap: 'round',
  }).addTo(slot.map);

  const c = state.route.coords;
  slot.end = L.marker(c[c.length - 1], { icon: pinIcon('end') }).addTo(slot.map);
  slot.map.fitBounds(L.latLngBounds(c), { padding: [50, 120] });
}

/** Move the driver dot, extend the travelled overlay, and follow if asked. */
export function updateNavCamera(position, loc) {
  const slot = maps.nav;
  if (!slot.map) return;

  if (!slot.me) {
    slot.me = L.marker(position, { icon: ME_ICON(), zIndexOffset: 1000 }).addTo(slot.map);
  } else {
    // Snap the marker to the road unless we are genuinely off it, so the dot
    // does not shimmer around beside the line on ordinary GPS noise.
    slot.me.setLatLng(nav.offRoute ? position : loc.snapped);
  }

  if (slot.travelled && state.route) {
    const upTo = state.route.cumKm.findIndex((k) => k > nav.travelledKm);
    const cut = upTo < 0 ? state.route.coords.length : upTo;
    slot.travelled.setLatLngs(state.route.coords.slice(0, Math.max(2, cut)));
  }

  if (nav.follow) {
    slot.map.setView(nav.offRoute ? position : loc.snapped, Math.max(slot.map.getZoom(), 15), {
      animate: true, duration: 0.6,
    });
  }
}

/** Jump the navigation camera back to a position. */
export function recentreNav(lat, lon) {
  if (maps.nav.map) maps.nav.map.setView([lat, lon], 16);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * Show one of the three screens.
 *
 * Leaflet measures its container on creation. If that container was hidden at
 * the time, it renders as a grey box until told to re-measure — which is
 * exactly what a "broken map" looks like. Hence the invalidateSize calls.
 *
 * @param {'setup'|'map'|'live'} which
 * @param {{onMapClick?:Function, onNavDrag?:Function}} [handlers]
 */
export function showScreen(which, handlers = {}) {
  for (const id of ['screen-setup', 'screen-map', 'screen-live']) {
    $(id).classList.toggle('active', id === `screen-${which}`);
  }
  window.scrollTo(0, 0);

  if (which === 'map') {
    ensurePlanMap(handlers.onMapClick);
    setTimeout(() => { maps.plan.map?.invalidateSize(); fitPlanMap(); }, 60);
  }
  if (which === 'live') {
    ensureNavMap(handlers.onNavDrag);
    setTimeout(() => maps.nav.map?.invalidateSize(), 60);
  }
}
