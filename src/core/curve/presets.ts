import type { CurveData } from '../scene/objectData';

/**
 * Shift+A ▸ Curve presets (UR11-1). All in object-local space, spawned at the
 * 3D cursor by the add menu. World is Z-up; curves lie in the XY plane.
 */

export type CurvePreset = 'bezier' | 'circle' | 'nurbs';

/** Bezier magic constant for a 4-point circle handle length (4/3·(√2−1)). */
const KAPPA = 0.5522847498;

/** A gentle S-shaped 2-point Bezier (Blender's default curve feel). */
export function bezierPreset(): CurveData {
  return {
    kind: 'bezier',
    cyclic: false,
    resolution: 12,
    points: [
      { co: [-1, 0, 0], hl: [-1.4, -0.6, 0], hr: [-0.4, 0.6, 0] },
      { co: [1, 0, 0], hl: [0.4, -0.6, 0], hr: [1.4, 0.6, 0] },
    ],
  };
}

/** A 4-point cyclic Bezier circle of radius 1 in the XY plane. */
export function circlePreset(): CurveData {
  const k = KAPPA;
  return {
    kind: 'bezier',
    cyclic: true,
    resolution: 12,
    points: [
      { co: [1, 0, 0], hl: [1, -k, 0], hr: [1, k, 0] },
      { co: [0, 1, 0], hl: [k, 1, 0], hr: [-k, 1, 0] },
      { co: [-1, 0, 0], hl: [-1, k, 0], hr: [-1, -k, 0] },
      { co: [0, -1, 0], hl: [-k, -1, 0], hr: [k, -1, 0] },
    ],
  };
}

/** A 5-point NURBS strip along X (order 4, straight-ish). */
export function nurbsPreset(): CurveData {
  return {
    kind: 'nurbs',
    cyclic: false,
    resolution: 12,
    order: 4,
    points: [
      { co: [-2, 0, 0] },
      { co: [-1, 0.4, 0] },
      { co: [0, 0, 0] },
      { co: [1, 0.4, 0] },
      { co: [2, 0, 0] },
    ],
  };
}

/** Build the payload + a name for a given preset. */
export function curvePreset(preset: CurvePreset): { name: string; data: CurveData } {
  switch (preset) {
    case 'circle': return { name: 'BezierCircle', data: circlePreset() };
    case 'nurbs': return { name: 'NurbsCurve', data: nurbsPreset() };
    default: return { name: 'BezierCurve', data: bezierPreset() };
  }
}
