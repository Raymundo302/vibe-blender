/**
 * Overlay display preferences (P12-2) — Blender's viewport "Overlays" popover.
 * A single mutable singleton (`overlays`) the Renderer reads every frame to
 * decide which non-scene decorations to draw (grid, selected-object origin
 * dots, light/camera icons, camera frustums, the 3D cursor marker, the
 * transform gizmo) and how the floor grid looks (floor lines, axis/grid colors,
 * fade distance). These are an APP PREFERENCE, not scene state: they are NOT
 * undoable and they survive scene load / new file. Persistence lives in
 * localStorage under `vibe-overlays` and is replayed at boot by
 * loadOverlayPrefs().
 */

/** RGB triple in linear 0..1 (matches themeViewport color arrays). */
export type RGB = [number, number, number];

export interface OverlayPrefs {
  /** Master floor-grid overlay (grid + axis lines). */
  grid: boolean;
  originPoints: boolean;
  icons: boolean;
  frustums: boolean;
  cursor3d: boolean;
  /** Show the transform gizmo (move arrows + plane handles). */
  gizmo: boolean;
  /** The grey floor lines within the grid (the "floor"). Axis lines stay. */
  floor: boolean;
  /** Axis colors — drive BOTH the floor grid axis lines AND the gizmo arrows,
   *  so the viewport's X/Y/Z read the same everywhere. */
  axisX: RGB;
  axisY: RGB;
  axisZ: RGB;
  /** Grey grid-line color (the floor lines). */
  gridColor: RGB;
  /** Distance (world units) at which the floor grid fully fades out. */
  gridFade: number;
}

const STORAGE_KEY = 'vibe-overlays';

/** Every overlay defaults to ON; colors seed the vivid gizmo palette (so the
 *  arrows stay saturated) and the fade matches the historical 120-unit reach. */
export function defaultOverlayPrefs(): OverlayPrefs {
  return {
    grid: true,
    originPoints: true,
    icons: true,
    frustums: true,
    cursor3d: true,
    gizmo: true,
    floor: true,
    axisX: [0.89, 0.35, 0.35],
    axisY: [0.45, 0.78, 0.31],
    axisZ: [0.33, 0.5, 0.9],
    gridColor: [0.32, 0.32, 0.32],
    gridFade: 120,
  };
}

/** The live singleton the Renderer + originDots read. Mutated in place so all
 *  readers see the same object; loadOverlayPrefs() copies stored values onto it. */
export const overlays: OverlayPrefs = defaultOverlayPrefs();

/** True when `v` is a finite-number RGB triple. */
function isRGB(v: unknown): v is RGB {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Read prefs from localStorage into the singleton. Each key is validated
 * against its default's type (boolean / number / RGB); anything missing or
 * malformed falls back to its default. Older stored blobs (booleans only) keep
 * working — the new color/number keys simply default in. Returns the singleton.
 */
export function loadOverlayPrefs(): OverlayPrefs {
  const d = defaultOverlayPrefs();
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) stored = JSON.parse(raw);
  } catch {
    stored = null; // malformed JSON or unavailable storage → defaults
  }
  const src = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  for (const key of Object.keys(d) as (keyof OverlayPrefs)[]) {
    const def = d[key];
    const raw = src[key];
    if (typeof def === 'boolean') {
      (overlays[key] as boolean) = typeof raw === 'boolean' ? raw : def;
    } else if (typeof def === 'number') {
      (overlays[key] as number) = typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
    } else {
      // RGB triple: copy a validated array, else the default (fresh copy).
      (overlays[key] as RGB) = isRGB(raw) ? [raw[0], raw[1], raw[2]] : [...(def as RGB)];
    }
  }
  return overlays;
}

/** Persist the current singleton to localStorage (no-op if storage throws). */
export function saveOverlayPrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
  } catch {
    /* storage unavailable (private mode / quota) — prefs stay in-memory only */
  }
}
