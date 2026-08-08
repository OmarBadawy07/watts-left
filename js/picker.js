/**
 * picker.js — one searchable dropdown, used by four different search boxes.
 *
 * The car picker filters a local array; the two endpoint pickers and the region
 * picker hit a network geocoder. Everything else about them is identical, so
 * they share this component and differ only in the `search` function they are
 * handed.
 */

import { $, el, iconSvg } from './dom.js';

/**
 * Wire up a text input + suggestion list, with the behaviour people expect
 * from a maps search box:
 *
 *   - results as you type, debounced and abortable
 *   - up/down arrows to move through results, Enter to choose, Escape to close
 *   - a visible "Searching…" state, because a network geocoder is not instant
 *   - two-line results: a bold name and the address context underneath
 *
 * Both abort the previous lookup, so typing quickly does not fire one request
 * per keystroke — which matters because the geocoder is a free community
 * service being used on trust.
 *
 * @param {Object} opts
 * @param {HTMLInputElement} opts.input
 * @param {HTMLElement} opts.list
 * @param {(q:string, signal:AbortSignal)=>Promise<Array>|Array} opts.search
 * @param {(item:any)=>{title:string, sub?:string, kind?:string, meta?:string}} opts.render
 * @param {(item:any)=>void} opts.onPick
 * @param {()=>Array} [opts.quickActions] offered when the field is empty
 * @param {()=>void} [opts.onType]  fired on every keystroke (toggles the clear button)
 * @param {number} [opts.minChars]
 * @param {number} [opts.debounceMs]
 * @param {boolean} [opts.showLoading]
 */
export function attachPicker({
  input, list, search, render, onPick, onType, quickActions,
  minChars = 2, debounceMs = 250, showLoading = false,
}) {
  let timer = null;
  let controller = null;
  let items = [];
  let activeIndex = -1;

  const hide = () => {
    list.classList.add('hidden');
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  };

  const setActive = (i) => {
    const nodes = [...list.querySelectorAll('li[data-idx]')];
    if (!nodes.length) return;
    activeIndex = (i + nodes.length) % nodes.length;
    nodes.forEach((n, j) => n.classList.toggle('active', j === activeIndex));
    nodes[activeIndex].scrollIntoView({ block: 'nearest' });
  };

  const showMessage = (cls, text) => {
    list.replaceChildren(el('li', cls, text));
    list.classList.remove('hidden');
  };

  const show = (results) => {
    items = results;
    activeIndex = -1;
    list.replaceChildren();

    if (!results.length) { showMessage('empty', 'Nothing found'); return; }

    results.forEach((item, idx) => {
      const { title, sub, kind, meta } = render(item);
      const li = el('li');
      li.dataset.idx = String(idx);
      // The category drives the icon tint, which is what makes a long list
      // scannable — you find the city among the shops by colour before you
      // have read a single word.
      li.dataset.kind = kind || 'pin';
      li.setAttribute('role', 'option');

      const iconWrap = el('div', 'sg-icon');
      iconWrap.appendChild(iconSvg(kind));
      li.appendChild(iconWrap);

      const text = el('div', 'sg-text');
      text.appendChild(el('span', 'sg-title', title));
      if (sub) text.appendChild(el('span', 'sg-sub', sub));
      li.appendChild(text);

      if (meta) li.appendChild(el('span', 'sg-dist', meta));

      // mousedown, not click: blur fires first on click and would tear the
      // list down before the selection registers.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); hide(); onPick(item); });
      li.addEventListener('mouseenter', () => setActive(idx));
      list.appendChild(li);
    });

    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  };

  const run = async () => {
    const q = input.value.trim();

    // An empty field is an opportunity, not a dead end: offer the one or two
    // things the user is most likely to want, the way a maps app does.
    if (q.length < minChars) {
      const quick = quickActions ? quickActions() : [];
      if (quick.length) show(quick); else hide();
      return;
    }

    if (controller) controller.abort();
    controller = new AbortController();

    if (showLoading) showMessage('loading', 'Searching…');
    try {
      show(await search(q, controller.signal));
    } catch (err) {
      if (err.name !== 'AbortError') showMessage('empty', 'Search unavailable — check your connection');
    }
  };

  input.addEventListener('input', () => {
    if (onType) onType();
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  });
  input.addEventListener('focus', run);
  // The delay lets a mousedown on a result land before the list disappears.
  input.addEventListener('blur', () => setTimeout(hide, 160));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter with nothing highlighted takes the first result, which is what
      // people expect when they type a place and hit return.
      const idx = activeIndex >= 0 ? activeIndex : 0;
      if (items[idx]) { hide(); onPick(items[idx]); }
    }
  });

  return { hide };
}

/**
 * Make a bottom sheet respond to both a tap and a drag.
 *
 * The grab bar looks like something you pull, so it has to actually pull — a
 * control that only accepts taps while looking draggable reads as broken.
 * Pointer events cover mouse, touch and pen through one code path.
 *
 * @param {HTMLElement} handle
 * @param {HTMLElement} sheet
 * @param {() => void} [onOpen] run whenever the sheet becomes visible
 */
export function attachSheetHandle(handle, sheet, onOpen) {
  let startY = null;
  let moved = 0;

  const setExpanded = (open) => {
    sheet.classList.toggle('expanded', open);
    // Panels that only refresh while visible should repaint on open, rather
    // than showing whatever was true when the sheet was last closed.
    if (open && onOpen) onOpen();
  };

  // Pointer capture keeps a drag tracking even if the finger leaves the handle.
  // It is a nicety, not a requirement — and it throws if the browser does not
  // recognise the pointer id. Letting that throw propagate would abort the
  // handler BEFORE the sheet actually moved, so the tap would do nothing.
  // Never let an optional API failure block the thing the user asked for.
  const capture = (fn, id) => { try { fn.call(handle, id); } catch { /* optional */ } };

  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    moved = 0;
    capture(handle.setPointerCapture, e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (startY !== null) moved = e.clientY - startY;
  });

  handle.addEventListener('pointerup', (e) => {
    if (startY === null) return;
    capture(handle.releasePointerCapture, e.pointerId);
    startY = null;

    // A deliberate drag sets the state directly; anything smaller is a tap,
    // which toggles. 30 px sits comfortably above accidental finger movement.
    if (moved > 30) setExpanded(false);
    else if (moved < -30) setExpanded(true);
    else setExpanded(!sheet.classList.contains('expanded'));
  });

  // Keyboard access: the handle is a <button>, so it must respond to Enter and
  // Space like one. Pointer handlers alone would leave it unusable.
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded(!sheet.classList.contains('expanded'));
    }
  });

  handle.addEventListener('pointercancel', () => { startY = null; });

  trackSheetHeight(sheet);
}

/**
 * Publish a sheet's live height as `--sheet-h` on the screen that contains it.
 *
 * The floating map buttons, the GPS chip and the status toast all sit above the
 * sheet, and they used to do it with a hard-coded `bottom: 150px` — a guess at
 * the COLLAPSED height. Expanding the sheet swallowed them whole: the voice and
 * recentre buttons simply vanished under it with no way to reach them.
 *
 * Measuring beats guessing. A ResizeObserver covers every cause of a height
 * change at once — expanding, collapsing, content growing, the window resizing —
 * so nothing has to remember to keep the two in step.
 */
function trackSheetHeight(sheet) {
  const screen = sheet.closest('.screen') || sheet.parentElement;
  if (!screen) return;

  const publish = () => {
    screen.style.setProperty('--sheet-h', `${Math.round(sheet.offsetHeight)}px`);
  };

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(publish).observe(sheet);
  } else {
    window.addEventListener('resize', publish);
  }
  publish();
}
