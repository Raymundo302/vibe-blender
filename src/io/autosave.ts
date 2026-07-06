/**
 * Autosave + crash-restore (P6-4).
 *
 * Every `intervalMs` (default 30s) and whenever the tab is hidden
 * (visibilitychange → hidden), the current scene is serialized to localStorage
 * under `AUTOSAVE_KEY`, wrapped with a small envelope carrying a timestamp. On
 * boot `main.ts` reads it back and, if it differs from the pristine default
 * scene, offers a Restore prompt.
 *
 * The wrapper functions (`wrapAutosave` / `parseAutosave`) are PURE — no
 * localStorage, no DOM — so they can be unit-tested directly. The `Autosave`
 * class owns the interval + storage side-effects (exercised by e2e, not units).
 */

/** localStorage key the autosave envelope lives under. */
export const AUTOSAVE_KEY = 'vibe-blender-autosave';
/** Envelope format tag + version (independent of the inner scene-file version). */
export const AUTOSAVE_FORMAT = 'vibe-blender-autosave';
export const AUTOSAVE_VERSION = 1;
/** Default autosave cadence. Injectable so tests/config can override it. */
export const DEFAULT_AUTOSAVE_INTERVAL_MS = 30000;

/** The on-disk envelope: format/version tag, a save timestamp, and the scene JSON string. */
export interface AutosaveWrapper {
  format: string;
  version: number;
  savedAt: number;
  scene: string;
}

/** Wrap a serialized scene string in a timestamped envelope (pure, testable). */
export function wrapAutosave(sceneJson: string, now: number = Date.now()): AutosaveWrapper {
  return { format: AUTOSAVE_FORMAT, version: AUTOSAVE_VERSION, savedAt: now, scene: sceneJson };
}

/**
 * Parse a raw localStorage string back into an envelope, or null if it is
 * missing / not valid / not our envelope. Never throws (pure, testable).
 */
export function parseAutosave(raw: string | null): AutosaveWrapper | null {
  if (raw === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const w = obj as Record<string, unknown>;
  if (
    w.format === AUTOSAVE_FORMAT &&
    typeof w.version === 'number' &&
    typeof w.savedAt === 'number' &&
    typeof w.scene === 'string'
  ) {
    return { format: w.format, version: w.version, savedAt: w.savedAt, scene: w.scene };
  }
  return null;
}

export interface AutosaveOptions {
  /** Returns the current scene serialized to a JSON string. */
  serialize: () => string;
  /** Autosave cadence in ms; defaults to DEFAULT_AUTOSAVE_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Owns the autosave interval + the visibilitychange listener + all localStorage
 * access. `start()` is idempotent; `stop()` tears everything down. Storage
 * failures (quota, disabled) are swallowed — autosave is best-effort.
 */
export class Autosave {
  private readonly serialize: () => string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.saveNow();
  };

  constructor(opts: AutosaveOptions) {
    this.serialize = opts.serialize;
    this.intervalMs = opts.intervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;
  }

  /** Begin periodic saving + save-on-hidden. Safe to call more than once. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => this.saveNow(), this.intervalMs);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Stop the interval and remove the visibility listener. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Serialize the scene and write the envelope now (best-effort). */
  saveNow(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(wrapAutosave(this.serialize())));
    } catch {
      /* storage full or unavailable — autosave is best-effort */
    }
  }

  /** Read + parse the stored envelope, or null if none/invalid. */
  load(): AutosaveWrapper | null {
    try {
      return parseAutosave(localStorage.getItem(AUTOSAVE_KEY));
    } catch {
      return null;
    }
  }

  /** Delete the stored envelope (on Discard, or after a file save/load). */
  clear(): void {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
  }
}
