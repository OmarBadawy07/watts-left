/**
 * planner.js — the full-screen map: search, routes, terrain, weather.
 *
 * Its job is to turn "Cairo to Alexandria" into the four numbers the model
 * needs — distance, climb, descent, and the weather along the way — so the
 * driver never has to know their route's net elevation change.
 */

import { $, el, setSlider } from './dom.js';
import { state } from './state.js';
import { predict } from './physics.js';
import {
  reverseGeocode, detectHomeRegion,
  fetchElevationProfile, fetchWeather, effectiveHeadwind, compassPoint,
} from './geo.js';
import {
  fetchRoutes, MANEUVER_PATHS,
  formatDistance as formatNavDistance, formatDuration as formatNavDuration,
} from './navigation.js';
import {
  maps, ensurePlanMap, drawRouteAlternatives, clearPlanRoute, fitPlanMap,
  centreOnHome, showMeOnPlanMap, showScreen,
} from './maps.js';
import { readConditions } from './conditions.js';
import { render } from './setup-screen.js';
import { saveSettings } from './persistence.js';

// ---------------------------------------------------------------------------
// 1. Search bias — the single most important function on this screen
// ---------------------------------------------------------------------------

/**
 * Where should search results be biased towards?
 *
 * ============================================================================
 * THIS FUNCTION IS THE WHOLE BALL GAME
 * ============================================================================
 * Without a bias point the geocoder ranks by global importance, so a user in
 * Cairo searching "mcdonalds" gets Sydney, Caracas and Little Falls. With one,
 * they get Cairo and Giza. Measured, not guessed.
 *
 * An earlier version returned null unless the map was zoomed past level 6.
 * Since the map opened on a wide view, it returned null essentially always,
 * and every user outside that default view got global noise. The lesson: this
 * must ALWAYS produce a point if one can possibly be had.
 *
 * Priority, most specific first:
 *   1. The other end of the trip.
 *   2. Wherever the map is currently looking.
 *   3. The detected home region — the backstop that makes search sane from the
 *      very first keystroke.
 *
 * It RANKS, it does not restrict: biased to Cairo, "Berlin" still returns
 * Berlin, Germany first, so planning a trip abroad still works.
 */
export function getBias(which) {
  if (which === 'to' && state.from) return { lat: state.from.lat, lon: state.from.lon };
  if (which === 'from' && state.to) return { lat: state.to.lat, lon: state.to.lon };
  const m = maps.plan.map;
  if (m && m.getZoom() >= 6) {
    const c = m.getCenter();
    return { lat: c.lat, lon: c.lng };
  }
  if (state.home) return { lat: state.home.lat, lon: state.home.lon };
  return null;
}

// ---------------------------------------------------------------------------
// 2. Home region
// ---------------------------------------------------------------------------

export async function initHomeRegion() {
  if (state.home) { paintRegion(); centreOnHome(); return; }

  paintRegion();
  const home = await detectHomeRegion();
  if (!home) {
    $('regionName').textContent = 'anywhere';
    return;
  }
  state.home = home;
  paintRegion();
  centreOnHome();
  saveSettings();
}

export function paintRegion() {
  $('regionName').textContent = state.home ? state.home.title : 'detecting…';
}

export function setHomeRegion(place) {
  state.home = place;
  paintRegion();
  $('regionEditor').classList.add('hidden');
  $('regionRow').classList.remove('hidden');
  $('regionSearch').value = '';
  if (maps.plan.map && !state.route) maps.plan.map.setView([place.lat, place.lon], 11);
  saveSettings();
}

// ---------------------------------------------------------------------------
// 3. Screen plumbing
// ---------------------------------------------------------------------------

export function setMapStatus(text, cls = '') {
  const node = $('mapStatus');
  node.textContent = text;
  node.className = `map-status ${cls}`;
}

export function setTripMode(mode) {
  state.tripMode = mode;
  $('tripMode').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  $('routePanel').classList.toggle('hidden', mode !== 'route');
  $('manualPanel').classList.toggle('hidden', mode !== 'manual');
  render();
  saveSettings();
}

export function openMapScreen() {
  showScreen('map', { onMapClick });
  if (state.from) $('fromSearch').value = state.from.label;
  if (state.to) $('toSearch').value = state.to.label;
  updateClearButtons();
  paintPlanSheet();

  // Both endpoints known but no usable geometry — because the route was
  // dropped on a storage-quota fallback, or came from an older version, or the
  // endpoints were restored without it. Fetch it rather than presenting an
  // empty planner to someone who has already told us where they are going.
  if (state.from && state.to && !state.route?.coords?.length) updateRoute();
}

export function updateClearButtons() {
  $('fromClear').classList.toggle('hidden', !$('fromSearch').value);
  $('toClear').classList.toggle('hidden', !$('toSearch').value);
  $('carSearchClear').classList.toggle('hidden', !$('carSearch').value);
}

// ---------------------------------------------------------------------------
// 4. Routing
// ---------------------------------------------------------------------------

/**
 * Fetch route alternatives, their terrain, and the weather along them.
 *
 * Each stage degrades independently: if elevation is unavailable you still get
 * real road distances, and if the weather service is down you still get the
 * terrain. A third-party outage must never leave the app unusable.
 */
export async function updateRoute() {
  if (!state.from || !state.to) { paintPlanSheet(); return; }

  ensurePlanMap(onMapClick);
  setMapStatus('Finding routes…', 'busy');

  let routes;
  try {
    routes = await fetchRoutes([state.from, state.to], true);
  } catch (err) {
    setMapStatus(err.message || 'Could not find a route.', 'error');
    state.routes = [];
    state.route = null;
    state.selectedRoute = 0;
    state.profile = null;
    paintPlanSheet();
    render();
    return;
  }

  state.routes = routes;
  state.selectedRoute = 0;
  state.route = routes[0];
  drawRouteAlternatives(selectRoute);
  fitPlanMap();
  setMapStatus('Reading the terrain…', 'busy');
  paintPlanSheet();

  // Terrain for every alternative — this is what lets us rank them by energy
  // rather than only by time.
  await Promise.all(routes.map(async (r) => {
    try {
      r.profile = await fetchElevationProfile(r.coords, r.distanceKm);
    } catch {
      r.profile = null;
    }
  }));
  state.profile = routes[0].profile;

  setMapStatus('');
  if ($('useWeather').checked) await applyWeather();

  paintPlanSheet();
  paintRouteSummary();
  render();
  saveSettings();
}

export function selectRoute(index) {
  if (!state.routes[index]) return;
  state.selectedRoute = index;
  state.route = state.routes[index];
  state.profile = state.route.profile || null;
  drawRouteAlternatives(selectRoute);
  paintPlanSheet();
  paintRouteSummary();
  render();
  saveSettings();
}

// ---------------------------------------------------------------------------
// 5. Route alternatives, ranked by battery
// ---------------------------------------------------------------------------

/**
 * Score each route the way this app can and Google Maps cannot: by energy.
 *
 * The shortest or fastest route is often not the cheapest for a battery. A
 * motorway route is quick but burns energy on aerodynamic drag; a flatter
 * detour can arrive with more charge despite covering more ground. Because we
 * have a physical model and a terrain profile for every alternative, we can
 * just work it out and say so.
 */
function evaluateRoutes() {
  return state.routes.map((r) => {
    const cond = readConditions({
      tripKm: r.distanceKm,
      elevationM: r.profile?.netM ?? 0,
      climbM: r.profile ? r.profile.climbM : null,
      descentM: r.profile ? r.profile.descentM : null,
    });
    return { route: r, prediction: predict(cond), cond };
  });
}

export function paintPlanSheet() {
  const holder = $('routeAlts');
  holder.replaceChildren();

  const hasRoutes = state.routes.length > 0;
  $('planEmpty').classList.toggle('hidden', hasRoutes);
  $('planActions').classList.toggle('hidden', !hasRoutes);
  $('directionsList').replaceChildren();

  if (!hasRoutes) {
    $('planSheet').classList.remove('expanded');
    return;
  }

  const scored = evaluateRoutes();
  const fastest = scored.reduce((a, b, i) => (b.route.durationMin < scored[a].route.durationMin ? i : a), 0);
  const leanest = scored.reduce((a, b, i) => (b.prediction.tripEnergyWh < scored[a].prediction.tripEnergyWh ? i : a), 0);

  scored.forEach((s, i) => {
    const btn = el('button', `route-alt${i === state.selectedRoute ? ' on' : ''}`);
    btn.type = 'button';

    const main = el('div', 'route-alt-main');
    main.appendChild(el('div', 'route-alt-time', formatNavDuration(s.route.durationMin)));
    const sub = `${s.route.distanceKm.toFixed(0)} km`
      + (s.route.summary ? ` · ${s.route.summary}` : '')
      + (s.route.profile ? ` · ${Math.round(s.route.profile.climbM)} m climb` : '');
    main.appendChild(el('div', 'route-alt-sub', sub));

    // Only badge a route when there is a genuine trade-off to point out.
    if (scored.length > 1 && fastest !== leanest) {
      if (i === fastest) main.appendChild(el('span', 'route-badge fastest', 'Fastest'));
      else if (i === leanest) main.appendChild(el('span', 'route-badge efficient', 'Least battery'));
    }
    btn.appendChild(main);

    const energy = el('div', 'route-alt-energy');
    const soc = Math.round(s.prediction.arrivalSoc);
    const cls = soc < 0 ? 'bad' : soc < s.cond.reservePercent ? 'tight' : 'ok';
    energy.appendChild(el('div', `route-alt-soc ${cls}`, soc >= 0 ? `${soc}%` : '0%'));
    energy.appendChild(el('span', null, `${(s.prediction.tripEnergyWh / 1000).toFixed(1)} kWh`));
    btn.appendChild(energy);

    btn.addEventListener('click', () => selectRoute(i));
    holder.appendChild(btn);
  });

  paintDirections();
}

export function paintDirections(activeStep = -1) {
  const list = $('directionsList');
  list.replaceChildren();
  if (!state.route?.steps?.length) return;

  state.route.steps.forEach((step, i) => {
    const li = el('li');
    if (activeStep >= 0 && i < activeStep) li.classList.add('done');
    if (i === activeStep) li.classList.add('current');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'dir-icon');
    svg.innerHTML = MANEUVER_PATHS[step.icon] || MANEUVER_PATHS.straight;
    li.appendChild(svg);

    li.appendChild(el('div', 'dir-text', step.instruction));
    if (step.distanceM > 0) {
      li.appendChild(el('div', 'dir-dist', formatNavDistance(step.distanceM)));
    }
    list.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// 6. The route card on the setup screen
// ---------------------------------------------------------------------------

export function paintRouteSummary() {
  if (!state.route) { $('routeSummary').classList.add('hidden'); return; }

  $('routeSummary').classList.remove('hidden');
  $('rDistance').textContent = `${state.route.distanceKm.toFixed(0)} km`;
  $('rDriveTime').textContent = formatNavDuration(state.route.durationMin);

  const p = state.profile;
  $('rClimb').textContent = p ? `${Math.round(p.climbM)} m` : '—';
  $('rDescent').textContent = p ? `${Math.round(p.descentM)} m` : '—';
  if (p) paintElevation();

  $('tripFromLabel').textContent = state.from ? state.from.title : 'Choose starting point';
  $('tripToLabel').textContent = state.to ? state.to.title : 'Choose destination';
  $('tripFromLabel').classList.toggle('set', !!state.from);
  $('tripToLabel').classList.toggle('set', !!state.to);
}

/** Draw the elevation profile as an SVG area chart. */
export function paintElevation() {
  const p = state.profile;
  if (!p?.samples?.length) return;

  const W = 320;
  const H = 90;
  const pad = 6;
  const span = Math.max(1, p.maxM - p.minM); // avoid divide-by-zero on flat routes
  const totalKm = p.samples[p.samples.length - 1].km || 1;

  const x = (km) => (km / totalKm) * W;
  const y = (m) => H - pad - ((m - p.minM) / span) * (H - pad * 2);

  const line = p.samples
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.km).toFixed(1)},${y(s.elevM).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  $('elevProfile').innerHTML = `
    <defs>
      <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#c07dff" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#c07dff" stop-opacity="0.04"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#elevFill)"/>
    <path d="${line}" fill="none" stroke="#c07dff" stroke-width="1.6"
          vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;

  $('elevMin').textContent = `low ${Math.round(p.minM)} m`;
  $('elevMax').textContent = `high ${Math.round(p.maxM)} m`;
  $('elevNet').textContent = `net ${p.netM >= 0 ? '+' : ''}${Math.round(p.netM)} m`;

  const netAbs = Math.abs(p.netM);
  $('elevExplain').textContent = p.climbM > netAbs * 1.5 && p.climbM > 100
    ? `The route climbs ${Math.round(p.climbM)} m in total but only ends ${Math.round(netAbs)} m `
      + `${p.netM >= 0 ? 'higher' : 'lower'} than it starts. Regen returns about 65% of what you `
      + `spend going up, so those hills still cost you energy even though they cancel out on paper.`
    : 'Sampled about every kilometre along the route.';
}

/** Redraw whatever a restored session left in state. Called once at startup. */
export function paintRestoredRoute() {
  if (!state.route) return;
  $('rDistance').textContent = `${state.route.distanceKm.toFixed(0)} km`;
  $('rDriveTime').textContent = formatNavDuration(state.route.durationMin);
  $('routeSummary').classList.remove('hidden');
  if (state.profile) paintElevation();
}

// ---------------------------------------------------------------------------
// 7. Weather
// ---------------------------------------------------------------------------

/** Fetch weather at the route midpoint and resolve the wind onto the route. */
export async function applyWeather() {
  if (!state.route?.coords?.length) return;
  const mid = state.route.coords[Math.floor(state.route.coords.length / 2)];

  try {
    const wx = await fetchWeather(mid[0], mid[1]);
    const head = effectiveHeadwind(state.route.coords, wx.windKmh, wx.windFromDeg);

    setSlider('temp', Math.round(wx.tempC));
    setSlider('wind', Math.round(head));
    $('tempAuto').classList.remove('hidden');
    $('windAuto').classList.remove('hidden');

    const dir = head >= 0 ? 'headwind' : 'tailwind';
    $('weatherState').textContent =
      `${wx.tempC.toFixed(0)} °C, wind ${wx.windKmh.toFixed(0)} km/h from the `
      + `${compassPoint(wx.windFromDeg)} — that works out as a `
      + `${Math.abs(head).toFixed(0)} km/h ${dir} along your route.`;
  } catch {
    $('weatherState').textContent = 'Weather unavailable — set temperature and wind by hand.';
  }
}

// ---------------------------------------------------------------------------
// 8. Setting the endpoints
// ---------------------------------------------------------------------------

export async function pickPlace(which, place) {
  state[which] = place;
  $(`${which}Search`).value = place.label;
  updateClearButtons();
  paintRouteSummary();
  await updateRoute();
}

export async function swapEnds() {
  const { from, to } = state;
  state.from = to;
  state.to = from;
  $('fromSearch').value = state.from ? state.from.label : '';
  $('toSearch').value = state.to ? state.to.label : '';
  updateClearButtons();
  if (state.from && state.to) await updateRoute();
}

export function clearEnd(which) {
  state[which] = null;
  state.routes = [];
  state.route = null;
  state.selectedRoute = 0; // an index into a list that no longer exists
  state.profile = null;
  $(`${which}Search`).value = '';
  updateClearButtons();

  clearPlanRoute(which);
  setMapStatus('');
  $('routeSummary').classList.add('hidden');

  // The weather readout describes a specific route ("...along your route"), so
  // it becomes a lie the moment that route is gone. The slider values stay —
  // the temperature outside has not changed — but the "auto" claim goes.
  $('weatherState').textContent = '';
  $('tempAuto').classList.add('hidden');
  $('windAuto').classList.add('hidden');

  paintPlanSheet();
  paintRouteSummary();
  $(`${which}Search`).focus();
  render();
  saveSettings();
}

/**
 * Tap the map to drop a pin, then choose what it is.
 *
 * The escape hatch for everything geocoding cannot do: an imprecise "current
 * location", a place with no name, a specific motorway junction, or a spot the
 * search box will not find. It is also how you correct a wrong automatic
 * location — you can see where the app thinks you are and tap the right place.
 */
export function onMapClick(e) {
  const { lat, lng } = e.latlng;

  const box = el('div', 'pin-popup');
  box.appendChild(el('div', 'pin-name', 'Finding this place…'));
  const popup = L.popup({ maxWidth: 250, closeButton: true })
    .setLatLng(e.latlng).setContent(box).openOn(maps.plan.map);

  reverseGeocode(lat, lng).then((place) => {
    box.replaceChildren();
    const name = el('div', 'pin-name', place.title);
    if (place.subtitle) name.appendChild(el('div', 'pin-sub', place.subtitle));
    box.appendChild(name);

    const actions = el('div', 'pin-actions');
    const start = el('button', 'as-start', 'Set as start');
    const end = el('button', 'as-end', 'Destination');
    start.addEventListener('click', () => { maps.plan.map.closePopup(popup); pickPlace('from', place); });
    end.addEventListener('click', () => { maps.plan.map.closePopup(popup); pickPlace('to', place); });
    actions.append(start, end);
    box.appendChild(actions);
    popup.update();
  });
}

/**
 * "Use my current location".
 *
 * The important part is honesty about accuracy. A phone with a GPS lock reports
 * a few metres. A laptop has no GPS at all — the browser looks up nearby Wi-Fi
 * networks or your IP address, which can be hundreds of metres out on a good
 * day and tens of kilometres out on a bad one.
 *
 * So we name the place we landed on, show the error radius, and say plainly
 * when it is a network estimate. A wrong location the user can SEE is wrong is
 * recoverable; a wrong location presented as fact is not.
 */
export function useMyLocation() {
  if (!('geolocation' in navigator)) {
    setMapStatus('This device has no location support — type a starting point instead.', 'error');
    return;
  }
  setMapStatus('Getting your location…', 'busy');

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const place = await reverseGeocode(lat, lon);
      await pickPlace('from', place);

      showMeOnPlanMap(lat, lon, !state.route);

      // Anything worse than ~500 m did not come from a GPS chip.
      if (accuracy > 500) {
        const km = accuracy / 1000;
        setMapStatus(
          `Located you near ${place.title}, but only to within `
          + `${km >= 1 ? `${km.toFixed(km < 10 ? 1 : 0)} km` : `${Math.round(accuracy)} m`}. `
          + 'No GPS on this device, so that is a network estimate — tap the map to correct it.',
          'error',
        );
      } else {
        setMapStatus(`Located you near ${place.title} (±${Math.round(accuracy)} m).`);
        setTimeout(() => setMapStatus(''), 4000);
      }
    },
    (err) => {
      setMapStatus(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied — type a starting point, or tap the map.'
          : 'Could not get your location — type a starting point, or tap the map.',
        'error',
      );
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
  );
}
