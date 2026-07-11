import { evalFCurve, findCurve, type AnimData, type FCurve } from './fcurve';

/**
 * Page-clock model (UR7-1) — the heart of keyable HTML-plane playback.
 *
 *   pageTime(frame) = Σ_{k = frameStart .. frame-1} playing(k) / scene.fps
 *
 * `playing(k)` samples the object's "html.playing" F-curve at INTEGER frame `k`
 * with CONSTANT interpretation (any keyed value > 0.5 = on), or the static
 * `html.playing` flag when the channel was never keyed. So page-local seconds
 * accumulate ONLY while Play is keyed on — key Play on at frame 30 and the page
 * animation starts there; a playing=0 span freezes the page (identical rasters).
 *
 * The integral is deterministic in viewport playback, scrubbing AND Ctrl+F12
 * renders (same frame → same pageTime → same raster).
 *
 * {@link pageTimePure} is the plain, allocation-free integral (unit-tested for
 * the on/off spans + fractional fps). {@link pageTime} wraps it with a per-target
 * PREFIX-SUM cache so scrubbing is O(1) amortized; the cache invalidates when the
 * curve (or fps/frameStart) changes — see {@link pageTimeRebuildCount}.
 */

/**
 * Play state at INTEGER frame `frame`, constant-interp: the F-curve value > 0.5
 * (if the channel is keyed) else the static flag. Returns 0 or 1.
 */
export function samplePlaying(curve: FCurve | undefined, staticPlaying: boolean, frame: number): 0 | 1 {
  if (curve && curve.keys.length > 0) return evalFCurve(curve, frame) > 0.5 ? 1 : 0;
  return staticPlaying ? 1 : 0;
}

/**
 * The page clock at `frame`: the pure integral, no cache. Frames at or before
 * `frameStart` (and a non-positive fps) yield 0. `frame` is floored — the clock
 * advances one whole scene-frame at a time.
 */
export function pageTimePure(
  curve: FCurve | undefined,
  staticPlaying: boolean,
  fps: number,
  frameStart: number,
  frame: number,
): number {
  const f = Math.floor(frame);
  if (f <= frameStart || fps <= 0) return 0;
  let on = 0;
  for (let k = frameStart; k < f; k++) on += samplePlaying(curve, staticPlaying, k);
  return on / fps;
}

// --- Cached path -------------------------------------------------------------

/** A stable signature of what the integral depends on for one target. */
function playingSignature(curve: FCurve | undefined, staticPlaying: boolean): string {
  if (!curve || curve.keys.length === 0) return `s:${staticPlaying ? 1 : 0}`;
  return 'c:' + curve.keys.map((k) => `${k.frame}:${k.value}:${k.interp}`).join('|');
}

interface CacheEntry {
  sig: string;
  fps: number;
  frameStart: number;
  curve: FCurve | undefined;
  staticPlaying: boolean;
  /** prefix[i] = count of "on" frames in [frameStart, frameStart + i). prefix[0]=0.
   *  Grown on demand so amortized lookups are O(1). */
  prefix: number[];
}

const cache = new WeakMap<object, CacheEntry>();

let rebuilds = 0;
/** Number of times a target's prefix-sum cache was (re)built — a test hook for
 *  proving invalidation fires exactly on a curve/fps/frameStart change. */
export function pageTimeRebuildCount(): number {
  return rebuilds;
}

/** Minimal shape {@link pageTime} needs — a SceneObject satisfies it. */
export interface PageTimeTarget {
  anim?: AnimData;
  html?: { playing: boolean };
}

/**
 * Cached page clock at `frame` for one target (keyed by object identity). The
 * prefix-sum table is rebuilt only when the html.playing curve, fps or frameStart
 * changes (signature miss); otherwise a scrub is a single array lookup + division.
 * Returns 0 for targets without an html payload.
 */
export function pageTime(target: PageTimeTarget, frame: number, fps: number, frameStart: number): number {
  const html = target.html;
  if (!html) return 0;
  const curve = target.anim ? findCurve(target.anim, 'html.playing') : undefined;
  const sig = playingSignature(curve, html.playing);
  let e = cache.get(target);
  if (!e || e.sig !== sig || e.fps !== fps || e.frameStart !== frameStart) {
    rebuilds++;
    e = { sig, fps, frameStart, curve, staticPlaying: html.playing, prefix: [0] };
    cache.set(target, e);
  }
  const f = Math.floor(frame);
  if (f <= frameStart || fps <= 0) return 0;
  const need = f - frameStart; // prefix index whose value = on-count over [frameStart, f)
  while (e.prefix.length <= need) {
    const i = e.prefix.length;
    const k = frameStart + i - 1;
    e.prefix.push(e.prefix[i - 1] + samplePlaying(e.curve, e.staticPlaying, k));
  }
  return e.prefix[need] / fps;
}
