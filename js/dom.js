/**
 * dom.js — the small DOM helpers every screen reaches for.
 *
 * Nothing here knows anything about electric cars. It is the layer between
 * "what the app wants to say" and "what the browser needs to be told", kept
 * separate so the modules above it read as app logic rather than as element
 * plumbing.
 */

/** Shorthand for getElementById, used everywhere. */
export const $ = (id) => document.getElementById(id);

/**
 * Create an element with a class and (safely) some text.
 *
 * `textContent`, never `innerHTML`: place names come from a third-party
 * geocoder and must never be interpreted as markup.
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Stroked 24x24 paths, one per search-result category. Drawing these inline
 * keeps the app self-contained — no icon font, no sprite sheet, no request.
 */
export const ICONS = {
  pin: '<path d="M12 21s6.5-5.9 6.5-10.3a6.5 6.5 0 1 0-13 0C5.5 15.1 12 21 12 21z"/><circle cx="12" cy="10.7" r="2.4"/>',
  city: '<path d="M3 21h18M5 21V9l5-3v15M14 21V11l5-2.5V21M8 11v0M8 14v0"/>',
  road: '<path d="M7 21 9.5 3M17 21 14.5 3M12 6v3M12 12v3M12 18v1"/>',
  rail: '<rect x="6" y="3.5" width="12" height="12" rx="3"/><path d="M8.5 19 6.5 21M15.5 19l2 2M6 15.5h12"/><circle cx="9.3" cy="9" r="1"/><circle cx="14.7" cy="9" r="1"/>',
  air: '<path d="M21 3 3.5 10.2l6.8 3.5L13.8 20z"/>',
  charge: '<path d="M13 2.5 6 13h5l-1 8.5L18 11h-5z"/>',
  poi: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  home: '<path d="M3.5 11 12 4l8.5 7M6 9.7V20h12V9.7"/>',
  car: '<path d="M4 15h16M6 15l1.6-5.2A2 2 0 0 1 9.5 8.4h5a2 2 0 0 1 1.9 1.4L18 15M4 15v3M20 15v3"/><circle cx="7.5" cy="18" r="1.4"/><circle cx="16.5" cy="18" r="1.4"/>',
};

export function iconSvg(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = ICONS[kind] || ICONS.pin;
  return svg;
}

/** Read a numeric input, falling back when it is empty or unparseable. */
export const numVal = (id, fallback = 0) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
};

/** Set a range input, clamped to its own min/max so it cannot go out of band. */
export function setSlider(id, value) {
  const node = $(id);
  node.value = Math.max(+node.min, Math.min(+node.max, value));
}

/**
 * Paint one of the coloured verdict boxes.
 *
 * The parameter is `node`, not `el` — an earlier version shadowed the `el()`
 * helper above, which is why two nearby functions ended up with a variable
 * awkwardly named `elx` to dodge the collision.
 *
 * @param {HTMLElement} node
 * @param {'ok'|'tight'|'bad'} kind
 * @param {string} html  trusted, app-authored markup only
 */
export function setVerdict(node, kind, html) {
  node.className = `verdict ${node.classList.contains('big') ? 'big ' : ''}${kind}`;
  node.innerHTML = html;
}

/**
 * Publish the lowest bottom edge of `nodes` as a CSS variable on `screenEl`.
 *
 * The counterpart to the `--sheet-h` trick: anything floating over the map has
 * to know where the fixed chrome ends, and hard-coding that offset is how the
 * SIMULATED badge ended up printed across the "then…" line. The turn banner
 * grows and shrinks with the instruction text, and the "then" line appears and
 * disappears, so the only correct answer is a measured one.
 *
 * Hidden nodes are skipped rather than measured — `display: none` reports a
 * zero-size rect at the document origin, which would drag the answer to 0.
 */
export function publishBottomEdge(nodes, screenEl, varName) {
  const top = screenEl.getBoundingClientRect().top;
  let lowest = 0;
  for (const node of nodes) {
    if (!node || node.classList.contains('hidden') || !node.offsetParent) continue;
    lowest = Math.max(lowest, node.getBoundingClientRect().bottom - top);
  }
  screenEl.style.setProperty(varName, `${Math.round(lowest)}px`);
}

/**
 * Straight-line distance for a search result, from KILOMETRES.
 *
 * Named for its unit on purpose: navigation.js has a `formatDistance` that
 * takes METRES. Two same-named formatters a factor of 1000 apart is a bug
 * waiting to be written, and an import alias only hides it.
 */
export function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
