/**
 * Viewport view options (the N-panel View tab, UR5-6) — an APP PREFERENCE like
 * shadePrefs/overlayPrefs: not undoable, survives scene load, persisted in
 * localStorage and replayed at boot.
 *
 * Currently just the passepartout toggle (Blender's darkened border while
 * looking through a camera), matching Blender where passepartout is a view
 * preference, not scene data.
 */

/** Which path-tracing backend F12 / Ctrl+F12 use (UR12-3). */
export type RenderEngine = 'cpu' | 'gpu';

/** Animation output container (UR16-3 Render tab ▸ Output; syncs Ctrl+F12). */
export type AnimFormat = 'webm' | 'mp4' | 'png';

export interface ViewPrefs {
  /** Show the darkened passepartout border while in camera view. */
  passepartout: boolean;
  /**
   * Path-tracer backend. 'gpu' = the WebGL2 fragment-shader tracer (UR12);
   * 'cpu' = the original Web Worker tracer. Default 'gpu' — the render engine
   * downgrades to CPU at render time when the GPU probe fails (and the render
   * window's Engine select disables the GPU option with the reason as tooltip).
   */
  renderEngine: RenderEngine;
  /** F12 default samples-per-pixel cap (UR16-3). Render tab + render window sync
   *  this; both engines accumulate up to it. Clamped 1..4096. */
  renderSamples: number;
  /**
   * Limit GPU load (UR16-3) — Ray's Beelink mouse-stutter guard. When on, F12 /
   * anim GPU renders use small per-batch spp and yield between batches (target
   * ≤ 8 ms GPU work per rAF). Off by default (a fast GPU won't care). Machine
   * preference, NOT scene data — persisted here, never serialized.
   */
  limitGpuLoad: boolean;
  /** Animation Output container the Ctrl+F12 modal defaults to (UR16-3). */
  animFormat: AnimFormat;
}

const STORAGE_KEY = 'vibe-view-v1';

export function defaultViewPrefs(): ViewPrefs {
  return {
    // Blender ships passepartout ON by default.
    passepartout: true,
    // Prefer the GPU tracer when available (probed at render time).
    renderEngine: 'gpu',
    // Preserve the historical F12 progressive cap (512 spp).
    renderSamples: 512,
    // Off by default — only Ray's weak Vega needs the pacing.
    limitGpuLoad: false,
    animFormat: 'webm',
  };
}

/** Clamp a samples value into the accepted F12 range (1..4096, integer). */
export function clampRenderSamples(n: number): number {
  if (!Number.isFinite(n)) return 512;
  return Math.max(1, Math.min(4096, Math.round(n)));
}

/** The live singleton the Passepartout overlay + View tab read/write. */
export const viewPrefs: ViewPrefs = defaultViewPrefs();

/** Read prefs from localStorage into the singleton (missing/bad keys → defaults). */
export function loadViewPrefs(): ViewPrefs {
  const d = defaultViewPrefs();
  let src: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') src = p as Record<string, unknown>;
    }
  } catch {
    src = {};
  }
  for (const key of Object.keys(d) as (keyof ViewPrefs)[]) {
    const want = typeof d[key];
    const v = src[key];
    (viewPrefs as unknown as Record<string, unknown>)[key] =
      typeof v === want ? v : d[key];
  }
  // renderEngine is a string union — reject anything that isn't a known backend.
  if (viewPrefs.renderEngine !== 'cpu' && viewPrefs.renderEngine !== 'gpu') {
    viewPrefs.renderEngine = d.renderEngine;
  }
  // animFormat is a string union too.
  if (!['webm', 'mp4', 'png'].includes(viewPrefs.animFormat)) {
    viewPrefs.animFormat = d.animFormat;
  }
  // renderSamples must be a sane integer spp.
  viewPrefs.renderSamples = clampRenderSamples(viewPrefs.renderSamples);
  return viewPrefs;
}

/** Persist the current singleton (no-op if storage throws). */
export function saveViewPrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(viewPrefs));
  } catch {
    /* storage unavailable — prefs stay in-memory only */
  }
}
