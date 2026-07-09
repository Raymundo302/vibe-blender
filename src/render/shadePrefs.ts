/**
 * Viewport shading options (the checkboxes in the viewport-header shading
 * dropdown) — an APP PREFERENCE like overlayPrefs: not undoable, survives
 * scene load, persisted in localStorage and replayed at boot.
 */

export interface ShadePrefs {
  /** Screen-space ambient occlusion in the solid shaded modes (not wireframe). */
  ao: boolean;
  /** AO sample radius in world units (bigger = broader, softer occlusion). */
  aoRadius: number;
  /** AO darkening multiplier: 0 = invisible, 1 = default, 2 = doubled. */
  aoStrength: number;
  /** Draw the edge wireframe on top of the shaded modes. */
  wireOverlay: boolean;
  /** Wireframe mode: hide backfacing wires + wires behind geometry (depth-
   *  primed hidden-line look) instead of the classic see-through wireframe. */
  wireHiddenLine: boolean;
}

/** Slider bounds — shared by the UI and the loader's clamping. */
export const AO_RADIUS_RANGE = { min: 0.1, max: 2.5, default: 0.55 };
export const AO_STRENGTH_RANGE = { min: 0, max: 2, default: 1 };

const STORAGE_KEY = 'vibe-shading';

export function defaultShadePrefs(): ShadePrefs {
  return {
    ao: false,
    aoRadius: AO_RADIUS_RANGE.default,
    aoStrength: AO_STRENGTH_RANGE.default,
    wireOverlay: false,
    wireHiddenLine: false,
  };
}

/** The live singleton the Renderer + shading menu read/write. */
export const shadePrefs: ShadePrefs = defaultShadePrefs();

/** Read prefs from localStorage into the singleton (missing keys → defaults). */
export function loadShadePrefs(): ShadePrefs {
  const d = defaultShadePrefs();
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const src = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  for (const key of Object.keys(d) as (keyof ShadePrefs)[]) {
    const want = typeof d[key];
    const v = src[key];
    (shadePrefs as unknown as Record<string, unknown>)[key] =
      typeof v === want && (want !== 'number' || Number.isFinite(v as number)) ? v : d[key];
  }
  // Clamp the numeric prefs into their slider ranges (stale/hand-edited storage).
  shadePrefs.aoRadius = Math.min(AO_RADIUS_RANGE.max, Math.max(AO_RADIUS_RANGE.min, shadePrefs.aoRadius));
  shadePrefs.aoStrength = Math.min(AO_STRENGTH_RANGE.max, Math.max(AO_STRENGTH_RANGE.min, shadePrefs.aoStrength));
  return shadePrefs;
}

/** Persist the current singleton (no-op if storage throws). */
export function saveShadePrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shadePrefs));
  } catch {
    /* storage unavailable — prefs stay in-memory only */
  }
}
