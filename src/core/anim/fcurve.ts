/**
 * Animation curves (F15-1, decision A15; easing + handle editing added for the
 * Graph Editor batch, 2026-07-09).
 *
 * An FCurve animates ONE float channel, addressed by a channelPath string
 * ("location.x", "scale.z", "rotation.y" — euler radians —, and payload
 * paths like "light.power" wired up by P15-4). Keys are kept sorted by
 * frame. Evaluation between keys follows the LEFT key's interp mode:
 *
 *  - constant / linear — step / lerp.
 *  - bezier — smooth spline. Each side of a span uses that key's HANDLE when
 *    the key is 'free' (user dragged it in the Graph Editor), else the
 *    Catmull-Rom auto tangent (Blender's "Bezier (Auto)" feel). Mixed spans
 *    (one auto key, one free key) work naturally: both reduce to a 2D cubic
 *    bezier whose control points come per-side.
 *  - easing families (sine/quad/cubic/quart/back/bounce/elastic) — Penner
 *    easing of the normalized span time, direction from the key's `easing`
 *    ('auto' = Blender's rule: ease-in for transitional curves, ease-out for
 *    the dynamic ones — back/bounce/elastic).
 */

export type Interp =
  | 'constant' | 'linear' | 'bezier'
  | 'sine' | 'quad' | 'cubic' | 'quart'
  | 'back' | 'bounce' | 'elastic';

export type Easing = 'auto' | 'in' | 'out' | 'inout';

/** Interp values that use the `easing` direction. */
export const EASED_INTERPS: readonly Interp[] = ['sine', 'quad', 'cubic', 'quart', 'back', 'bounce', 'elastic'];

/** Dropdown order + labels for the pickers (Timeline + Graph Editor). */
export const INTERP_MODES: readonly { value: Interp; label: string }[] = [
  { value: 'constant', label: 'Constant' },
  { value: 'linear', label: 'Linear' },
  { value: 'bezier', label: 'Bezier' },
  { value: 'sine', label: 'Sinusoidal' },
  { value: 'quad', label: 'Quadratic' },
  { value: 'cubic', label: 'Cubic' },
  { value: 'quart', label: 'Quartic' },
  { value: 'back', label: 'Back' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'elastic', label: 'Elastic' },
];

export const EASING_MODES: readonly { value: Easing; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'in', label: 'Ease In' },
  { value: 'out', label: 'Ease Out' },
  { value: 'inout', label: 'Ease In-Out' },
];

export interface Keyframe {
  frame: number;
  value: number;
  interp: Interp;
  /** Easing direction for the eased interps; absent = 'auto'. */
  easing?: Easing;
  /** 'free' once a bezier handle was hand-edited; absent = auto tangents. */
  handleMode?: 'auto' | 'free';
  /** Left/right handle OFFSETS from the key, [frames, value] — only
   *  meaningful (and only serialized) when handleMode is 'free'. */
  hl?: [number, number];
  hr?: [number, number];
}

export interface FCurve {
  channelPath: string;
  /** Sorted by frame, unique frames (insertKey replaces same-frame keys). */
  keys: Keyframe[];
}

/** Per-object animation payload (SceneObject.anim). */
export interface AnimData {
  fcurves: FCurve[];
}

export function findCurve(anim: AnimData, channelPath: string): FCurve | undefined {
  return anim.fcurves.find((c) => c.channelPath === channelPath);
}

/**
 * Insert (or replace, same frame) a key. Returns what was there before:
 * undefined = new key; a Keyframe = replaced (undo data). Creates the curve
 * when missing. Default interp 'bezier' (Blender's default feel).
 */
export type KeyExtras = Pick<Keyframe, 'easing' | 'handleMode' | 'hl' | 'hr'>;

export function insertKey(
  anim: AnimData,
  channelPath: string,
  frame: number,
  value: number,
  interp: Interp = 'bezier',
  extras?: KeyExtras,
): Keyframe | undefined {
  let curve = findCurve(anim, channelPath);
  if (!curve) {
    curve = { channelPath, keys: [] };
    anim.fcurves.push(curve);
  }
  const key: Keyframe = { frame, value, interp };
  if (extras?.easing) key.easing = extras.easing;
  if (extras?.handleMode) key.handleMode = extras.handleMode;
  if (extras?.hl) key.hl = extras.hl;
  if (extras?.hr) key.hr = extras.hr;
  const i = curve.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) {
    const before = curve.keys[i];
    curve.keys[i] = key;
    return before;
  }
  curve.keys.push(key);
  curve.keys.sort((a, b) => a.frame - b.frame);
  return undefined;
}

/** Remove the key at `frame`; returns it (undo data) or undefined. Drops the
 *  curve entirely when its last key goes. */
export function deleteKey(anim: AnimData, channelPath: string, frame: number): Keyframe | undefined {
  const curve = findCurve(anim, channelPath);
  if (!curve) return undefined;
  const i = curve.keys.findIndex((k) => k.frame === frame);
  if (i < 0) return undefined;
  const [removed] = curve.keys.splice(i, 1);
  if (curve.keys.length === 0) anim.fcurves = anim.fcurves.filter((c) => c !== curve);
  return removed;
}

// ---------------------------------------------------------------------------
// Easing (Penner) — every ease* maps t in [0,1] to [0,1] as EASE-IN; the
// direction wrappers derive out / in-out from it.

function easeInOf(interp: Interp, t: number): number {
  switch (interp) {
    case 'sine': return 1 - Math.cos((t * Math.PI) / 2);
    case 'quad': return t * t;
    case 'cubic': return t * t * t;
    case 'quart': return t * t * t * t;
    case 'back': {
      const s = 1.70158;
      return t * t * ((s + 1) * t - s);
    }
    case 'elastic': {
      if (t === 0 || t === 1) return t;
      return -Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1) - 0.075) * (2 * Math.PI) / 0.3);
    }
    case 'bounce': return 1 - bounceOut(1 - t);
    default: return t;
  }
}

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}

/** Blender's "Automatic Easing": transitional curves ease IN, the dynamic
 *  ones (back/bounce/elastic) ease OUT. */
export function resolveEasing(interp: Interp, easing: Easing | undefined): 'in' | 'out' | 'inout' {
  const e = easing ?? 'auto';
  if (e !== 'auto') return e;
  return interp === 'back' || interp === 'bounce' || interp === 'elastic' ? 'out' : 'in';
}

function ease(interp: Interp, easing: Easing | undefined, t: number): number {
  const dir = resolveEasing(interp, easing);
  if (dir === 'in') return easeInOf(interp, t);
  if (dir === 'out') return 1 - easeInOf(interp, 1 - t);
  return t < 0.5
    ? easeInOf(interp, t * 2) / 2
    : 1 - easeInOf(interp, (1 - t) * 2) / 2;
}

// ---------------------------------------------------------------------------
// Bezier span with handles.

/** The auto (Catmull-Rom) tangent at keys[i], in value-per-frame. */
function autoTangent(keys: Keyframe[], i: number): number {
  const prev = keys[i - 1] ?? keys[i];
  const next = keys[i + 1] ?? keys[i];
  if (next.frame === prev.frame) return 0;
  return (next.value - prev.value) / (next.frame - prev.frame);
}

/** Solve cubic-bezier x(t) = x for t in [0,1] (x0 < x3, monotonic after the
 *  handle clamp). Newton with bisection fallback — the standard CSS-easing
 *  approach. */
function bezierTForX(x0: number, x1: number, x2: number, x3: number, x: number): number {
  const cx = (t: number) => {
    const u = 1 - t;
    return u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
  };
  let t = (x - x0) / Math.max(x3 - x0, 1e-9); // good initial guess
  for (let it = 0; it < 8; it++) {
    const err = cx(t) - x;
    if (Math.abs(err) < 1e-5) return t;
    const u = 1 - t;
    const dxdt = 3 * u * u * (x1 - x0) + 6 * u * t * (x2 - x1) + 3 * t * t * (x3 - x2);
    if (Math.abs(dxdt) < 1e-9) break;
    t = Math.min(1, Math.max(0, t - err / dxdt));
  }
  // Bisection fallback (cx is monotonic in [0,1] after clamping).
  let lo = 0, hi = 1;
  for (let it = 0; it < 32; it++) {
    t = (lo + hi) / 2;
    if (cx(t) < x) lo = t; else hi = t;
  }
  return t;
}

/** Evaluate a curve at a (possibly fractional) frame. Clamps outside range. */
export function evalFCurve(curve: FCurve, frame: number): number {
  const keys = curve.keys;
  if (keys.length === 0) return 0;
  if (frame <= keys[0].frame) return keys[0].value;
  if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;
  // Find the span [i, i+1] containing frame (keys.length >= 2 here).
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].frame <= frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.frame === b.frame) return b.value;
  const t = (frame - a.frame) / (b.frame - a.frame);
  switch (a.interp) {
    case 'constant':
      return a.value;
    case 'linear':
      return a.value + (b.value - a.value) * t;
    case 'bezier': {
      const dt = b.frame - a.frame;
      // Per-side control points: the key's own free handle, else the auto
      // tangent expressed as a bezier handle (Hermite ÷ 3).
      const aFree = a.handleMode === 'free' && a.hr;
      const bFree = b.handleMode === 'free' && b.hl;
      if (!aFree && !bFree) {
        // Pure auto span: keep the exact Hermite of the original implementation
        // (bit-stable with pre-handle files).
        const m0 = autoTangent(keys, i) * dt;
        const m1 = autoTangent(keys, i + 1) * dt;
        const t2 = t * t;
        const t3 = t2 * t;
        return (
          (2 * t3 - 3 * t2 + 1) * a.value +
          (t3 - 2 * t2 + t) * m0 +
          (-2 * t3 + 3 * t2) * b.value +
          (t3 - t2) * m1
        );
      }
      // 2D cubic bezier. Handle x offsets are clamped into the span so x(t)
      // stays monotonic — Blender's auto-clamp, no time-travel loops.
      const h1: [number, number] = aFree ? a.hr! : [dt / 3, (autoTangent(keys, i) * dt) / 3];
      const h2: [number, number] = bFree ? b.hl! : [-dt / 3, -(autoTangent(keys, i + 1) * dt) / 3];
      const x1 = a.frame + Math.min(Math.max(h1[0], 0), dt);
      const y1 = a.value + h1[1];
      const x2 = b.frame + Math.min(Math.max(h2[0], -dt), 0);
      const y2 = b.value + h2[1];
      const tb = bezierTForX(a.frame, x1, x2, b.frame, frame);
      const u = 1 - tb;
      return u * u * u * a.value + 3 * u * u * tb * y1 + 3 * u * tb * tb * y2 + tb * tb * tb * b.value;
    }
    default:
      return a.value + (b.value - a.value) * ease(a.interp, a.easing, t);
  }
}
