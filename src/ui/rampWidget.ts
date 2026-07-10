/**
 * ColorRamp widget (Use & Refine — "ramp widget UI").
 *
 * Replaces the bare "(ramp)" placeholder in the Shader Editor's param strip for
 * a ColorRamp node with a proper gradient bar + draggable stop markers, a color
 * picker + position field for the selected stop, and +/− add/remove buttons.
 *
 * The math is factored into DOM-free pure functions (unit-tested in
 * rampWidget.test.ts); the DOM half (createRampWidget) talks to the Shader
 * Editor through a small RampWidgetHost so every edit rides the same
 * GraphEditCommand snapshot-undo path as every other node param. A horizontal
 * marker drag previews live inside the widget and commits ONE undo entry on
 * release (the node param is untouched until then).
 */
import './rampWidget.css';

export interface RampStop {
  pos: number;
  color: [number, number, number];
}

const DEFAULT_STOPS: RampStop[] = [
  { pos: 0, color: [0, 0, 0] },
  { pos: 1, color: [1, 1, 1] },
];

/** Deep copy of a stop array (colors are fresh tuples). */
export function cloneStops(stops: RampStop[]): RampStop[] {
  return stops.map((s) => ({ pos: s.pos, color: [s.color[0], s.color[1], s.color[2]] }));
}

/** Parse a (possibly malformed) ramp param into sorted, valid stops (≥2). */
export function normalizeStops(param: unknown): RampStop[] {
  const raw = (param as { stops?: unknown } | null)?.stops;
  const stops: RampStop[] = [];
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const pos = (s as { pos?: unknown })?.pos;
      const col = (s as { color?: unknown })?.color;
      if (
        typeof pos === 'number' && Number.isFinite(pos) &&
        Array.isArray(col) && col.length === 3 &&
        col.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        stops.push({ pos: clamp01(pos), color: [col[0], col[1], col[2]] });
      }
    }
  }
  if (stops.length < 2) return cloneStops(DEFAULT_STOPS);
  stops.sort((a, b) => a.pos - b.pos);
  return stops;
}

/** Linearly-interpolated color at `pos`, clipped to the end stops (Blender default). */
export function sampleRampColor(stops: RampStop[], pos: number): [number, number, number] {
  if (stops.length === 0) return [0, 0, 0];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (pos <= first.pos) return [...first.color];
  if (pos >= last.pos) return [...last.color];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (pos >= a.pos && pos <= b.pos) {
      const span = b.pos - a.pos;
      const t = span > 1e-12 ? (pos - a.pos) / span : 0;
      return [
        a.color[0] + (b.color[0] - a.color[0]) * t,
        a.color[1] + (b.color[1] - a.color[1]) * t,
        a.color[2] + (b.color[2] - a.color[2]) * t,
      ];
    }
  }
  return [...last.color];
}

/**
 * Add a stop midway between the selected stop and the next one (or at 0.5 when
 * the selected stop is the last), taking the interpolated color there. Returns
 * the new stop array (sorted) and the index of the freshly-added stop.
 */
export function insertStop(stops: RampStop[], selectedIndex: number): { stops: RampStop[]; selected: number } {
  const src = cloneStops(stops);
  const sel = clampIndex(selectedIndex, src.length);
  const next = src[sel + 1];
  const pos = next ? (src[sel].pos + next.pos) / 2 : 0.5;
  const added: RampStop = { pos: clamp01(pos), color: sampleRampColor(src, pos) };
  src.push(added);
  src.sort((a, b) => a.pos - b.pos);
  return { stops: src, selected: src.indexOf(added) };
}

/**
 * Remove the selected stop, enforcing a minimum of 2 stops (a no-op below that).
 * Returns the new array and a clamped selection index.
 */
export function removeStop(stops: RampStop[], selectedIndex: number): { stops: RampStop[]; selected: number } {
  const sel = clampIndex(selectedIndex, stops.length);
  if (stops.length <= 2) return { stops: cloneStops(stops), selected: sel };
  const src = cloneStops(stops);
  src.splice(sel, 1);
  return { stops: src, selected: clampIndex(sel, src.length) };
}

/**
 * Set stop `index`'s position, clamped to 0..1, then re-sort so stops stay
 * ordered. The moved stop keeps its identity — the returned `selected` is its
 * index after the sort.
 */
export function setStopPosition(stops: RampStop[], index: number, pos: number): { stops: RampStop[]; selected: number } {
  const src = cloneStops(stops);
  const idx = clampIndex(index, src.length);
  const moved = src[idx];
  moved.pos = clamp01(Number.isFinite(pos) ? pos : moved.pos);
  src.sort((a, b) => a.pos - b.pos);
  return { stops: src, selected: src.indexOf(moved) };
}

/** Set stop `index`'s color (does not reorder). */
export function setStopColor(stops: RampStop[], index: number, color: [number, number, number]): RampStop[] {
  const src = cloneStops(stops);
  const idx = clampIndex(index, src.length);
  src[idx].color = [color[0], color[1], color[2]];
  return src;
}

/** A CSS `linear-gradient(...)` matching the ramp's linear interpolation. */
export function rampGradientCss(stops: RampStop[]): string {
  if (stops.length === 0) return 'none';
  const parts = stops.map((s) => `${cssRgb(s.color)} ${(clamp01(s.pos) * 100).toFixed(2)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

// --- DOM widget -------------------------------------------------------------

/** How the widget reaches back into the Shader Editor / node param + undo. */
export interface RampWidgetHost {
  /** Current stops from the node param (already normalized). */
  getStops(): RampStop[];
  /** Persisted selected-stop index (survives param-strip rebuilds). */
  getSelected(): number;
  setSelected(index: number): void;
  /** Apply `stops` to the node param as ONE undo entry, storing `selected`. */
  commit(name: string, stops: RampStop[], selected: number): void;
}

export function createRampWidget(host: RampWidgetHost): HTMLElement {
  let stops = host.getStops();
  let selected = clampIndex(host.getSelected(), stops.length);

  const root = document.createElement('div');
  root.className = 'ramp-widget';

  // Gradient bar + marker layer.
  const bar = document.createElement('div');
  bar.className = 'ramp-bar';
  const markers = document.createElement('div');
  markers.className = 'ramp-stops-layer';
  bar.append(markers);
  root.append(bar);

  // +/− add/remove row.
  const btnRow = document.createElement('div');
  btnRow.className = 'ramp-buttons';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ramp-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add stop';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'ramp-remove';
  removeBtn.textContent = '−';
  removeBtn.title = 'Remove selected stop';
  btnRow.append(addBtn, removeBtn);
  root.append(btnRow);

  // Selected-stop editors.
  const editRow = document.createElement('div');
  editRow.className = 'ramp-edit';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'ramp-color';
  const posInput = document.createElement('input');
  posInput.type = 'number';
  posInput.className = 'ramp-pos';
  posInput.step = '0.01';
  posInput.min = '0';
  posInput.max = '1';
  editRow.append(colorInput, posInput);
  root.append(editRow);

  function render(): void {
    bar.style.background = rampGradientCss(stops);
    markers.replaceChildren();
    stops.forEach((s, i) => {
      const m = document.createElement('div');
      m.className = 'ramp-stop' + (i === selected ? ' selected' : '');
      m.dataset.index = String(i);
      m.style.left = `${clamp01(s.pos) * 100}%`;
      m.addEventListener('pointerdown', (e) => onMarkerDown(e, i));
      markers.append(m);
    });
    const sel = stops[selected];
    if (sel) {
      colorInput.value = rgbToHex(sel.color);
      posInput.value = String(round4(sel.pos));
    }
    removeBtn.disabled = stops.length <= 2;
    exposeHandle();
  }

  function onMarkerDown(e: PointerEvent, i: number): void {
    e.preventDefault();
    e.stopPropagation();
    let dragIndex = clampIndex(i, stops.length);
    selected = dragIndex;
    host.setSelected(selected);
    render();
    const rect = bar.getBoundingClientRect();
    const move = (ev: PointerEvent): void => {
      const t = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0;
      const res = setStopPosition(stops, dragIndex, t);
      stops = res.stops;
      dragIndex = res.selected;
      selected = dragIndex;
      host.setSelected(selected);
      render(); // live preview — node param untouched until pointerup
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      host.commit('Move Ramp Stop', stops, selected);
      render();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  addBtn.addEventListener('click', () => {
    const res = insertStop(stops, selected);
    stops = res.stops;
    selected = res.selected;
    host.setSelected(selected);
    host.commit('Add Ramp Stop', stops, selected);
    render();
  });

  removeBtn.addEventListener('click', () => {
    const res = removeStop(stops, selected);
    stops = res.stops;
    selected = res.selected;
    host.setSelected(selected);
    host.commit('Remove Ramp Stop', stops, selected);
    render();
  });

  colorInput.addEventListener('change', () => {
    stops = setStopColor(stops, selected, hexToRgb(colorInput.value));
    host.commit('Ramp Color', stops, selected);
    render();
  });

  posInput.addEventListener('change', () => {
    const res = setStopPosition(stops, selected, Number(posInput.value));
    stops = res.stops;
    selected = res.selected;
    host.setSelected(selected);
    host.commit('Ramp Position', stops, selected);
    render();
  });

  function exposeHandle(): void {
    (window as unknown as Record<string, unknown>).__rampWidget = {
      stops: () => cloneStops(stops),
      selected: () => selected,
      barRect: () => bar.getBoundingClientRect(),
    };
  }

  render();
  return root;
}

// --- small helpers ----------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(len - 1, Math.floor(i)));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function ch(n: number): number {
  return Math.round(clamp01(n) * 255);
}

function cssRgb(c: [number, number, number]): string {
  return `rgb(${ch(c[0])}, ${ch(c[1])}, ${ch(c[2])})`;
}

function rgbToHex(c: [number, number, number]): string {
  const h = (n: number): string => ch(n).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
