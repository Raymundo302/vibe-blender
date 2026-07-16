/**
 * Per-surface isoparm display preference (NB-B3). A tiny app-level pref — NOT
 * scene/payload state (SurfaceData is do-not-touch and `showNet` lives there;
 * isoparms deliberately do NOT piggyback on it). Modeled on overlayPrefs /
 * combPrefs: a mutable singleton the Surface tab writes and the surface net pass
 * reads every frame, persisted to localStorage, keyed per object id.
 *
 * Like overlays, this is NOT undoable and survives scene load / new file. Object
 * ids are per-session, so a stored blob is a best-effort convenience — a stale
 * id simply defaults to off. Loading is lazy (first access) so no boot wiring in
 * main.ts (do-not-touch) is required.
 */

const STORAGE_KEY = 'vibe-isoparms';

/** Object ids whose isoparms are ON. */
const onIds = new Set<number>();
let loaded = false;

/** Read persisted ids once, on first access. Malformed/absent → empty set. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const v of arr) if (typeof v === 'number' && Number.isFinite(v)) onIds.add(v);
      }
    }
  } catch {
    /* malformed JSON or unavailable storage — start empty */
  }
}

/** Persist the current set (no-op if storage throws). */
function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...onIds]));
  } catch {
    /* storage unavailable (private mode / quota) — stays in-memory only */
  }
}

/** Whether the surface object `id` should draw its isoparametric curves. */
export function isoparmsOn(id: number): boolean {
  ensureLoaded();
  return onIds.has(id);
}

/** Turn isoparms on/off for object `id` and persist. */
export function setIsoparms(id: number, on: boolean): void {
  ensureLoaded();
  if (on) onIds.add(id);
  else onIds.delete(id);
  save();
}
