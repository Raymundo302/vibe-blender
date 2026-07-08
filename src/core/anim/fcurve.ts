/**
 * Animation curves (F15-1, decision A15).
 *
 * An FCurve animates ONE float channel, addressed by a channelPath string
 * ("location.x", "scale.z", "rotation.y" — euler radians —, and payload
 * paths like "light.power" wired up by P15-4). Keys are kept sorted by
 * frame. Evaluation between keys follows the LEFT key's interp mode:
 * constant (step), linear, or bezier (smooth Catmull-Rom auto-tangent
 * Hermite — Blender's "Bezier (Auto)" feel without 2D handle editing;
 * P15-2/P15-3 add per-key modes + editing UI on top of this).
 */

export type Interp = 'constant' | 'linear' | 'bezier';

export interface Keyframe {
  frame: number;
  value: number;
  interp: Interp;
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
export function insertKey(
  anim: AnimData,
  channelPath: string,
  frame: number,
  value: number,
  interp: Interp = 'bezier',
): Keyframe | undefined {
  let curve = findCurve(anim, channelPath);
  if (!curve) {
    curve = { channelPath, keys: [] };
    anim.fcurves.push(curve);
  }
  const i = curve.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) {
    const before = curve.keys[i];
    curve.keys[i] = { frame, value, interp };
    return before;
  }
  curve.keys.push({ frame, value, interp });
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
      // Catmull-Rom auto tangents (in value-per-frame), cubic Hermite in t.
      const prev = i > 0 ? keys[i - 1] : a;
      const next = i + 2 < keys.length ? keys[i + 2] : b;
      const dt = b.frame - a.frame;
      const m0 = ((b.value - prev.value) / Math.max(b.frame - prev.frame, 1e-9)) * dt;
      const m1 = ((next.value - a.value) / Math.max(next.frame - a.frame, 1e-9)) * dt;
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        (2 * t3 - 3 * t2 + 1) * a.value +
        (t3 - 2 * t2 + t) * m0 +
        (-2 * t3 + 3 * t2) * b.value +
        (t3 - t2) * m1
      );
    }
  }
}
