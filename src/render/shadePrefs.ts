/**
 * Viewport shading options (the checkboxes in the viewport-header shading
 * dropdown) — an APP PREFERENCE like overlayPrefs: not undoable, survives
 * scene load, persisted in localStorage and replayed at boot.
 */

/** AO estimator family: 'screen' = GTAO from the depth buffer; 'object' =
 *  Ray's AO-Prototype technique — a march against per-object voxel SDFs in
 *  world space, camera-independent by construction. */
export type AoMode = 'screen' | 'object';

/** The Object-AO estimator menu (from AO-Prototype/ao-hybrid.html; trimmed
 *  2026-07-09 — Dithered/Cone cut on looks, Supersample ×4 on perf; the
 *  keepers are gain-calibrated to match each other and the GTAO look at the
 *  same slider settings). */
export const AO_METHODS: { label: string; desc: string }[] = [
  { label: 'Baseline', desc: 'Linear march along the normal — simple and even' },
  { label: 'Hemisphere', desc: 'Golden-angle directions across the hemisphere — smoother and directional' },
  { label: 'Exp-weighted', desc: 'Taps packed near the surface with exponential weights — soft contact falloff' },
];

export interface ShadePrefs {
  /** Screen-space ambient occlusion in the solid shaded modes (not wireframe). */
  ao: boolean;
  /** Which AO estimator drives the pass. */
  aoMode: AoMode;
  /** Object-AO method index into AO_METHODS (used when aoMode = 'object'). */
  aoMethod: number;
  /** AO sample radius in world units (bigger = broader, softer occlusion). */
  aoRadius: number;
  /** AO darkening multiplier: 0 = invisible, 1 = default, 2 = doubled. */
  aoStrength: number;
  /** AO samples per pixel (2·slices·steps) — more = cleaner, slower. */
  aoSamples: number;
  /** Draw the edge wireframe on top of the shaded modes. */
  wireOverlay: boolean;
  /** Wireframe mode: hide backfacing wires + wires behind geometry (depth-
   *  primed hidden-line look) instead of the classic see-through wireframe. */
  wireHiddenLine: boolean;
}

/** Slider bounds — shared by the UI and the loader's clamping. */
export const AO_RADIUS_RANGE = { min: 0.1, max: 2.5, default: 0.3 };
export const AO_STRENGTH_RANGE = { min: 0, max: 2, default: 1 };
export const AO_SAMPLES_RANGE = { min: 16, max: 96, default: 48 };

// v3: Object (SDF) AO became the default estimator with Ray's picked look
// (Baseline, radius 0.3, strength 1) — new key so stored v2 GTAO-era values
// don't shadow the new defaults. (v2: half-res GTAO rebuild, 2026-07-08.)
const STORAGE_KEY = 'vibe-shading-v3';

export function defaultShadePrefs(): ShadePrefs {
  return {
    ao: false,
    aoMode: 'object',   // Ray's SDF technique is the house default (2026-07-09)
    aoMethod: 0,        // Baseline — his preferred estimator from the prototype
    aoRadius: AO_RADIUS_RANGE.default,
    aoStrength: AO_STRENGTH_RANGE.default,
    aoSamples: AO_SAMPLES_RANGE.default,
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
  if (shadePrefs.aoMode !== 'screen' && shadePrefs.aoMode !== 'object') shadePrefs.aoMode = 'object';
  shadePrefs.aoMethod = Math.min(AO_METHODS.length - 1, Math.max(0, Math.round(shadePrefs.aoMethod)));
  shadePrefs.aoRadius = Math.min(AO_RADIUS_RANGE.max, Math.max(AO_RADIUS_RANGE.min, shadePrefs.aoRadius));
  shadePrefs.aoStrength = Math.min(AO_STRENGTH_RANGE.max, Math.max(AO_STRENGTH_RANGE.min, shadePrefs.aoStrength));
  shadePrefs.aoSamples = Math.min(AO_SAMPLES_RANGE.max, Math.max(AO_SAMPLES_RANGE.min, shadePrefs.aoSamples));
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
