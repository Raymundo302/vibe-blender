/**
 * Viewport shading options (the checkboxes in the viewport-header shading
 * dropdown) — an APP PREFERENCE like overlayPrefs: not undoable, survives
 * scene load, persisted in localStorage and replayed at boot.
 */

import type { ShadingMode } from './Renderer';

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
  /** Wire line color (0..1 rgb) — drives BOTH the wireframe SHADING MODE and
   *  the Wireframe overlay. The edit cage keeps its own colors (not affected). */
  wireColor: [number, number, number];
  /** UR6 proximity width scaling on/off. Off → constant width (= wireMaxPx). */
  wireProximity: boolean;
  /** Ribbon clamp bounds (px): thin (near-min) and thick (near-max) half-widths. */
  wireMinPx: number;
  wireMaxPx: number;
  /** Draw mesh-mesh intersection curves as light grey lines (all shading
   *  modes) — where two objects' geometry passes through each other. */
  intersections: boolean;
  /** Intersection line core color (0..1 rgb); the rim behavior stays as-is. */
  intersectColor: [number, number, number];
  /**
   * Hidden Line, PER shading mode. In wireframe mode, true = depth-primed
   * hidden-line look, false = classic see-through wireframe. In the solid
   * modes (matcap/studio/rendered), it drives the Wireframe OVERLAY and the
   * edit CAGE: true = depth-tested (occluded wires/cage hidden), false = drawn
   * with the depth test OFF so the full mesh / full orange cage shows through
   * geometry. Also feeds edit-mode element pick + object select-through.
   */
  hiddenLine: Record<ShadingMode, boolean>;
  /** Per-section expanded (disclosure) state in the shading dropdown; all
   *  default collapsed (false). UI-only — no render effect. */
  sections: { ao: boolean; wire: boolean; intersect: boolean };
}

/** Slider bounds — shared by the UI and the loader's clamping. */
export const AO_RADIUS_RANGE = { min: 0.1, max: 2.5, default: 0.3 };
export const AO_STRENGTH_RANGE = { min: 0, max: 2, default: 1 };
export const AO_SAMPLES_RANGE = { min: 16, max: 96, default: 48 };
// Wire ribbon width bounds — defaults come from ribbon.ts (WIRE_MIN_PX /
// WIRE_MAX_PX) so the prefs match the historical constant look out of the box.
export const WIRE_MIN_PX_RANGE = { min: 0.3, max: 2, default: 0.6 };
export const WIRE_MAX_PX_RANGE = { min: 1, max: 8, default: 3.5 };

// v4: Hidden Line went PER shading mode (was the single wireframe-only
// `wireHiddenLine`). New key so a stored v3 blob's boolean can be migrated into
// `.wireframe` without shadowing the new per-mode defaults.
// (v3: Object SDF AO default; v2: half-res GTAO rebuild, 2026-07-08.)
// v5: added wireColor / wireProximity / wireMinPx / wireMaxPx / intersectColor
// and the per-section disclosure state. New key so a stored v4 blob loads its
// values + the new defaults (and the v3→v4 wireHiddenLine chain still applies
// when only a v3 blob exists).
// (v4: Hidden Line per shading mode. v3: Object SDF AO default. v2: half-res
// GTAO rebuild, 2026-07-08.)
const STORAGE_KEY = 'vibe-shading-v5';
const LEGACY_V4_KEY = 'vibe-shading-v4';
const LEGACY_V3_KEY = 'vibe-shading-v3';

export function defaultShadePrefs(): ShadePrefs {
  return {
    ao: false,
    aoMode: 'object',   // Ray's SDF technique is the house default (2026-07-09)
    aoMethod: 0,        // Baseline — his preferred estimator from the prototype
    aoRadius: AO_RADIUS_RANGE.default,
    aoStrength: AO_STRENGTH_RANGE.default,
    aoSamples: AO_SAMPLES_RANGE.default,
    wireOverlay: false,
    wireColor: [0.05, 0.05, 0.06],   // the historical hardcoded wire dark
    wireProximity: true,
    wireMinPx: WIRE_MIN_PX_RANGE.default,
    wireMaxPx: WIRE_MAX_PX_RANGE.default,
    intersections: false,
    intersectColor: [0.45, 0.45, 0.48], // the current intersect core grey
    // Hidden Line on in the solid modes (occlusion looks natural there),
    // off in wireframe (classic see-through is the historical default).
    hiddenLine: { matcap: true, studio: true, rendered: true, wireframe: false },
    sections: { ao: false, wire: false, intersect: false }, // all collapsed
  };
}

/** Sanitize a stored [r,g,b] into a fresh clamped 0..1 tuple; else `fallback`. */
function sanitizeColor(
  v: unknown, fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) return [...fallback];
  const out: number[] = [];
  for (const c of v) {
    if (typeof c !== 'number' || !Number.isFinite(c)) return [...fallback];
    out.push(Math.min(1, Math.max(0, c)));
  }
  return [out[0], out[1], out[2]];
}

/** The live singleton the Renderer + shading menu read/write. */
export const shadePrefs: ShadePrefs = defaultShadePrefs();

/** Read prefs from localStorage into the singleton (missing keys → defaults).
 *  Prefers the v4 blob; falls back to a stored v3 blob and migrates its single
 *  `wireHiddenLine` boolean into `hiddenLine.wireframe` (other modes default). */
export function loadShadePrefs(): ShadePrefs {
  const d = defaultShadePrefs();
  let src: Record<string, unknown> = {};
  let fromV3 = false;
  try {
    const rawV5 = localStorage.getItem(STORAGE_KEY);
    const rawV4 = localStorage.getItem(LEGACY_V4_KEY);
    const rawV3 = localStorage.getItem(LEGACY_V3_KEY);
    if (rawV5 !== null) {
      const p = JSON.parse(rawV5);
      if (p && typeof p === 'object') src = p as Record<string, unknown>;
    } else if (rawV4 !== null) {
      // v4 blob: its values load directly; the new v5 fields take defaults.
      const p = JSON.parse(rawV4);
      if (p && typeof p === 'object') src = p as Record<string, unknown>;
    } else if (rawV3 !== null) {
      const p = JSON.parse(rawV3);
      if (p && typeof p === 'object') { src = p as Record<string, unknown>; fromV3 = true; }
    }
  } catch {
    src = {};
    fromV3 = false;
  }
  // Object-valued prefs are sanitized explicitly below; skip them in the
  // primitive (boolean/number/string) copy loop.
  const objectKeys = new Set<keyof ShadePrefs>(['hiddenLine', 'wireColor', 'intersectColor', 'sections']);
  for (const key of Object.keys(d) as (keyof ShadePrefs)[]) {
    if (objectKeys.has(key)) continue;
    const want = typeof d[key];
    const v = src[key];
    (shadePrefs as unknown as Record<string, unknown>)[key] =
      typeof v === want && (want !== 'number' || Number.isFinite(v as number)) ? v : d[key];
  }
  // Colors: fresh clamped 0..1 tuples (missing/garbage → defaults).
  shadePrefs.wireColor = sanitizeColor(src.wireColor, d.wireColor);
  shadePrefs.intersectColor = sanitizeColor(src.intersectColor, d.intersectColor);
  // Sections: start from defaults, overlay any valid stored booleans.
  const sec = { ...d.sections };
  const storedSec = src.sections;
  if (storedSec && typeof storedSec === 'object') {
    for (const s of Object.keys(sec) as (keyof typeof sec)[]) {
      const val = (storedSec as Record<string, unknown>)[s];
      if (typeof val === 'boolean') sec[s] = val;
    }
  }
  shadePrefs.sections = sec;
  // Hidden Line: per-mode record. Start from defaults, overlay any valid stored
  // booleans, then migrate a v3 blob's flat `wireHiddenLine` into `.wireframe`.
  const hl: Record<ShadingMode, boolean> = { ...d.hiddenLine };
  const storedHl = src.hiddenLine;
  if (storedHl && typeof storedHl === 'object') {
    for (const m of Object.keys(hl) as ShadingMode[]) {
      const val = (storedHl as Record<string, unknown>)[m];
      if (typeof val === 'boolean') hl[m] = val;
    }
  }
  if (fromV3 && typeof src.wireHiddenLine === 'boolean') hl.wireframe = src.wireHiddenLine;
  shadePrefs.hiddenLine = hl;
  // Clamp the numeric prefs into their slider ranges (stale/hand-edited storage).
  if (shadePrefs.aoMode !== 'screen' && shadePrefs.aoMode !== 'object') shadePrefs.aoMode = 'object';
  shadePrefs.aoMethod = Math.min(AO_METHODS.length - 1, Math.max(0, Math.round(shadePrefs.aoMethod)));
  shadePrefs.aoRadius = Math.min(AO_RADIUS_RANGE.max, Math.max(AO_RADIUS_RANGE.min, shadePrefs.aoRadius));
  shadePrefs.aoStrength = Math.min(AO_STRENGTH_RANGE.max, Math.max(AO_STRENGTH_RANGE.min, shadePrefs.aoStrength));
  shadePrefs.aoSamples = Math.min(AO_SAMPLES_RANGE.max, Math.max(AO_SAMPLES_RANGE.min, shadePrefs.aoSamples));
  shadePrefs.wireMinPx = Math.min(WIRE_MIN_PX_RANGE.max, Math.max(WIRE_MIN_PX_RANGE.min, shadePrefs.wireMinPx));
  shadePrefs.wireMaxPx = Math.min(WIRE_MAX_PX_RANGE.max, Math.max(WIRE_MAX_PX_RANGE.min, shadePrefs.wireMaxPx));
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
