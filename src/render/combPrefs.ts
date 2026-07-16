/**
 * Curvature-comb display preferences (NB-B1) — Blender/Rhino "curvature graph"
 * style porcupine combs for curve objects. Unlike the viewport-wide overlay /
 * shading prefs, comb settings are PER CURVE OBJECT (keyed by object id): each
 * curve remembers whether its comb is shown, its tooth scale, and the sample
 * count. These are an APP PREFERENCE, not scene state — NOT undoable, they
 * survive scene load / new file, and they persist in localStorage under
 * `vibe-curve-combs`.
 *
 * Storage is lazy-loaded on first access (combFor / saveCombPrefs) rather than
 * replayed by a boot hook, because main.ts is out of scope for this task and the
 * per-id map has no single boot owner. loadCombPrefs() forces a reload (used by
 * the unit test to simulate a fresh session).
 */

export interface CombPref {
  /** Show the curvature comb for this curve. */
  on: boolean;
  /** Tooth-length multiplier (world length = kappa * 0.35 * scale). */
  scale: number;
  /** Uniform domain samples along the curve (teeth count). */
  samples: number;
}

/** Slider bounds — shared by the N-panel UI and the loader/setter clamping. */
export const COMB_SCALE_RANGE = { min: 0.01, max: 100, default: 1 };
export const COMB_SAMPLES_RANGE = { min: 8, max: 256, default: 64 };

const STORAGE_KEY = 'vibe-curve-combs';

/** A fresh default pref (comb off). */
export function defaultCombPref(): CombPref {
  return { on: false, scale: COMB_SCALE_RANGE.default, samples: COMB_SAMPLES_RANGE.default };
}

const clampScale = (v: number): number =>
  Number.isFinite(v) ? Math.min(COMB_SCALE_RANGE.max, Math.max(COMB_SCALE_RANGE.min, v)) : COMB_SCALE_RANGE.default;
const clampSamples = (v: number): number =>
  Number.isFinite(v) ? Math.min(COMB_SAMPLES_RANGE.max, Math.max(COMB_SAMPLES_RANGE.min, Math.round(v))) : COMB_SAMPLES_RANGE.default;

/** The live per-object-id map. Lazy-loaded from localStorage on first access. */
const prefs = new Map<number, CombPref>();
let loaded = false;

/** Sanitize a raw stored entry into a valid CombPref (missing/garbage → default). */
function sanitize(raw: unknown): CombPref {
  const d = defaultCombPref();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    on: typeof r.on === 'boolean' ? r.on : d.on,
    scale: typeof r.scale === 'number' ? clampScale(r.scale) : d.scale,
    samples: typeof r.samples === 'number' ? clampSamples(r.samples) : d.samples,
  };
}

/** (Re)load the whole map from localStorage. Clears the in-memory map first, so
 *  a boot / test can start from a clean slate. */
export function loadCombPrefs(): void {
  prefs.clear();
  loaded = true;
  let stored: unknown = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) stored = JSON.parse(raw);
  } catch {
    stored = null; // malformed JSON or unavailable storage → empty (all defaults)
  }
  if (stored && typeof stored === 'object') {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      const id = Number(k);
      if (Number.isFinite(id)) prefs.set(id, sanitize(v));
    }
  }
}

function ensureLoaded(): void {
  if (!loaded) loadCombPrefs();
}

/** Persist the current map to localStorage (no-op if storage throws). */
export function saveCombPrefs(): void {
  ensureLoaded();
  try {
    const obj: Record<string, CombPref> = {};
    for (const [id, p] of prefs) obj[id] = p;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* storage unavailable (private mode / quota) — prefs stay in-memory only */
  }
}

/**
 * The live comb pref for object `id`. Returns the SAME object across calls (so
 * mutating it in place is picked up next frame); a missing entry is created from
 * defaults and cached in-memory (not persisted until saveCombPrefs()).
 */
export function combFor(id: number): CombPref {
  ensureLoaded();
  let p = prefs.get(id);
  if (!p) {
    p = defaultCombPref();
    prefs.set(id, p);
  }
  return p;
}

/** Update a curve's comb pref (clamped) and persist. UI helper. */
export function setComb(id: number, patch: Partial<CombPref>): CombPref {
  const p = combFor(id);
  if (patch.on !== undefined) p.on = patch.on;
  if (patch.scale !== undefined) p.scale = clampScale(patch.scale);
  if (patch.samples !== undefined) p.samples = clampSamples(patch.samples);
  saveCombPrefs();
  return p;
}
