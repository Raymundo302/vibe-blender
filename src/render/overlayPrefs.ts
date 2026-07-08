/**
 * Overlay display preferences (P12-2) — Blender's viewport "Overlays" popover.
 * A single mutable singleton (`overlays`) the Renderer reads every frame to
 * decide which non-scene decorations to draw (grid, selected-object origin
 * dots, light/camera icons, camera frustums, the 3D cursor marker). These are
 * an APP PREFERENCE, not scene state: they are NOT undoable and they survive
 * scene load / new file. Persistence lives in localStorage under `vibe-overlays`
 * and is replayed at boot by loadOverlayPrefs().
 */

export interface OverlayPrefs {
  grid: boolean;
  originPoints: boolean;
  icons: boolean;
  frustums: boolean;
  cursor3d: boolean;
}

const STORAGE_KEY = 'vibe-overlays';

/** Every overlay defaults to ON — the app looks the same as before this feature. */
export function defaultOverlayPrefs(): OverlayPrefs {
  return { grid: true, originPoints: true, icons: true, frustums: true, cursor3d: true };
}

/** The live singleton the Renderer + originDots read. Mutated in place so all
 *  readers see the same object; loadOverlayPrefs() copies stored values onto it. */
export const overlays: OverlayPrefs = defaultOverlayPrefs();

/**
 * Read prefs from localStorage into the singleton. Any missing key falls back
 * to its default; malformed / non-object JSON (or a throwing storage) resets
 * every key to its default. Returns the singleton for convenience.
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
    overlays[key] = typeof src[key] === 'boolean' ? src[key] as boolean : d[key];
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
