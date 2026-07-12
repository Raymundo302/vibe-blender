import './tooltip.css';

/**
 * UR14-3 item 2 — shared instant styled tooltip.
 *
 * A single, document-level delegated tooltip: any element that carries a
 * `data-tip` attribute (the name) and optional `data-tip-key` (a shortcut chip)
 * shows a styled popover ~150ms after the pointer settles on it, matching the
 * look of the app's dropdown rows. This replaces the browser-native `title`
 * (slow ~1s, tiny, unstyled) on the toolbar buttons, topbar icon buttons and
 * the area-header glyphs (⋮ / ⛶ / corner drag).
 *
 * Use {@link setTip} to tag an element — it also strips any native `title` so
 * the two tooltips never double up.
 */

const SHOW_DELAY_MS = 150;

let host: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let currentTarget: HTMLElement | null = null;
let listenersAttached = false;

function ensureHost(): HTMLDivElement {
  if (host) return host;
  const h = document.createElement('div');
  h.className = 'vb-tooltip';
  h.setAttribute('role', 'tooltip');
  h.style.display = 'none';
  document.body.appendChild(h);
  host = h;
  // e2e handle (like window.__toolbar / window.__timeline).
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__tooltip = {
      host: h,
      visible: (): boolean => h.style.display !== 'none',
      text: (): string => h.textContent ?? '',
    };
  }
  return h;
}

function hide(): void {
  if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
  currentTarget = null;
  if (host) host.style.display = 'none';
}

function render(el: HTMLElement): void {
  const tip = el.dataset.tip;
  if (!tip) return;
  const h = ensureHost();
  h.textContent = '';
  const name = document.createElement('span');
  name.className = 'vb-tooltip-name';
  name.textContent = tip;
  h.appendChild(name);
  const key = el.dataset.tipKey;
  if (key) {
    const k = document.createElement('kbd');
    k.className = 'vb-tooltip-key';
    k.textContent = key;
    h.appendChild(k);
  }
  h.style.display = 'flex';
  position(el, h);
}

/** Anchor below the element, clamped to the viewport; flip above if it would
 *  overflow the bottom edge. */
function position(el: HTMLElement, h: HTMLDivElement): void {
  const r = el.getBoundingClientRect();
  const tw = h.offsetWidth;
  const th = h.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, vw - tw - 4));
  let top = r.bottom + 6;
  if (top + th > vh - 4) top = r.top - th - 6; // flip above
  top = Math.max(4, top);
  h.style.left = `${left}px`;
  h.style.top = `${top}px`;
}

function scheduleShow(el: HTMLElement): void {
  if (!el.dataset.tip) return;
  if (showTimer !== null) clearTimeout(showTimer);
  currentTarget = el;
  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentTarget === el && el.isConnected) render(el);
  }, SHOW_DELAY_MS);
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  const onOver = (e: Event): void => {
    const target = e.target as Element | null;
    const el = target?.closest?.('[data-tip]') as HTMLElement | null;
    if (el) {
      if (el !== currentTarget) scheduleShow(el);
    } else if (currentTarget) {
      hide();
    }
  };
  const onOut = (e: Event): void => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]');
    if (el && el === currentTarget) {
      const related = (e as MouseEvent).relatedTarget as Element | null;
      if (!related || related.closest?.('[data-tip]') !== el) hide();
    }
  };

  // Both pointer + mouse events so it fires under real pointers AND the CDP
  // mouseMoved events the e2e harness dispatches.
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}

/**
 * Tag an element with an instant styled tooltip. `name` is the primary label,
 * `shortcut` (optional) renders as a key chip. Strips any native `title` so the
 * browser tooltip never double-shows.
 */
export function setTip(el: HTMLElement, name: string, shortcut?: string): void {
  ensureHost();
  attachListeners();
  el.dataset.tip = name;
  if (shortcut) el.dataset.tipKey = shortcut;
  else delete el.dataset.tipKey;
  if (el.hasAttribute('title')) el.removeAttribute('title');
  // If this element's tip is updated while its own tooltip is showing, refresh.
  if (currentTarget === el && host && host.style.display !== 'none') render(el);
}
