import type { SurfaceData, SurfacePoint } from '../scene/objectData';
import { defaultSurfaceTess } from '../scene/objectData';

/**
 * Shift+A ▸ Surface primitives (NB-A1): pure builders returning EXACT rational
 * NURBS control nets. World is Z-up, the axis of revolution is Z, and every
 * primitive is centered at the origin — matching the mesh primitives in
 * core/mesh/primitives.ts. The quadric shapes (sphere/cylinder/cone/torus) are
 * EXACT (rational weights + circle knot vectors), not tessellated approximations,
 * so the closed-form tests hit machine precision.
 *
 * Grid convention (SurfaceData / core/nurbs/surface.ts): points is row-major with
 * flat index iu*pointsV + iv — iu runs along U, iv along V.
 */

/** √2/2 — the middle weight of a rational quadratic 90° arc (cos 45°). */
const S = Math.SQRT1_2;

/**
 * The classic exact rational unit circle: 9 control points (degree 2) built from
 * four 90° arcs, alternating weights 1 / √2/2. Euclidean control coords — the
 * corners sit at (±1, ±1) with the fractional weight. Evaluates to radius 1.
 */
const CIRCLE_PTS: readonly [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0],
];
const CIRCLE_W: readonly number[] = [1, S, 1, S, 1, S, 1, S, 1];
/** Circle knot vector: four double interior knots (length 9 + 2 + 1 = 12). */
const CIRCLE_KNOTS: readonly number[] = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

/**
 * A 4×4 bicubic flat patch in the XY plane (z = 0), spanning ±size/2. Same net
 * layout as defaultSurfaceData but without the center bump — a clean plane.
 */
export function surfPatch(size = 2): SurfaceData {
  const h = size / 2;
  const points: SurfacePoint[] = [];
  for (let iu = 0; iu < 4; iu++) {
    for (let iv = 0; iv < 4; iv++) {
      const x = -h + (size * iu) / 3;
      const y = -h + (size * iv) / 3;
      points.push({ co: [x, y, 0] });
    }
  }
  return { degreeU: 3, degreeV: 3, pointsU: 4, pointsV: 4, points, tess: defaultSurfaceTess() };
}

/**
 * An EXACT rational sphere of the given radius, centered at origin, poles on Z.
 * Tensor product of a 9-point full circle (U, the parallels) and a 5-point
 * pole-to-pole semicircle meridian (V), each a rational quadric. Net weight =
 * product of the two arc weights. Because both arcs are exact and their radii/
 * heights separate, every evaluated point sits at distance `radius` from origin.
 */
export function surfSphere(radius = 1): SurfaceData {
  // Meridian semicircle in (r, z): north pole → equator → south pole.
  const merR = [0, radius, radius, radius, 0];
  const merZ = [radius, radius, 0, -radius, -radius];
  const merW = [1, S, 1, S, 1];
  const merKnots = [0, 0, 0, 0.5, 0.5, 1, 1, 1]; // length 5 + 2 + 1 = 8
  const points: SurfacePoint[] = [];
  for (let iu = 0; iu < 9; iu++) {
    const [cx, cy] = CIRCLE_PTS[iu];
    const cw = CIRCLE_W[iu];
    for (let iv = 0; iv < 5; iv++) {
      points.push({ co: [merR[iv] * cx, merR[iv] * cy, merZ[iv]], w: cw * merW[iv] });
    }
  }
  return {
    degreeU: 2, degreeV: 2, pointsU: 9, pointsV: 5, points,
    knotsU: [...CIRCLE_KNOTS], knotsV: merKnots, tess: defaultSurfaceTess(),
  };
}

/**
 * An EXACT rational cylinder wall: a 9-point circle (U) swept LINEARLY (degree 1
 * in V) from z = -depth/2 to +depth/2. No caps (open tube, Blender's surface
 * cylinder). Radius exact via the rational circle.
 */
export function surfCylinder(radius = 1, depth = 2): SurfaceData {
  const zs = [-depth / 2, depth / 2];
  const points: SurfacePoint[] = [];
  for (let iu = 0; iu < 9; iu++) {
    const [cx, cy] = CIRCLE_PTS[iu];
    const cw = CIRCLE_W[iu];
    for (let iv = 0; iv < 2; iv++) {
      points.push({ co: [radius * cx, radius * cy, zs[iv]], w: cw });
    }
  }
  return {
    degreeU: 2, degreeV: 1, pointsU: 9, pointsV: 2, points,
    knotsU: [...CIRCLE_KNOTS], knotsV: [0, 0, 1, 1], tess: defaultSurfaceTess(),
  };
}

/**
 * An EXACT rational cone: a 9-point circle rim at z = -depth/2 (U) swept LINEARLY
 * (degree 1 in V) to an apex at (0, 0, +depth/2). The apex row collapses to one
 * point; its per-column weight is set to the rim's column weight so each column
 * is a straight homogeneous segment (exact straight rim→apex lines). The
 * tessellator welds the collapsed row into triangles.
 */
export function surfCone(radius = 1, depth = 2): SurfaceData {
  const points: SurfacePoint[] = [];
  for (let iu = 0; iu < 9; iu++) {
    const [cx, cy] = CIRCLE_PTS[iu];
    const cw = CIRCLE_W[iu];
    points.push({ co: [radius * cx, radius * cy, -depth / 2], w: cw }); // iv=0 rim
    points.push({ co: [0, 0, depth / 2], w: cw });                      // iv=1 apex
  }
  return {
    degreeU: 2, degreeV: 1, pointsU: 9, pointsV: 2, points,
    knotsU: [...CIRCLE_KNOTS], knotsV: [0, 0, 1, 1], tess: defaultSurfaceTess(),
  };
}

/**
 * An EXACT rational torus centered at origin, axis Z: a 9-point major circle (U,
 * radius `major`) revolving a 9-point minor circle (V, radius `minor`) whose
 * cross-section lies in the r-z plane centered at (major, 0). Net weight =
 * product of the two arc weights. Every evaluated point sits at distance `minor`
 * from the major ring.
 */
export function surfTorus(major = 1, minor = 0.25): SurfaceData {
  const points: SurfacePoint[] = [];
  for (let iu = 0; iu < 9; iu++) {
    const [ux, uy] = CIRCLE_PTS[iu];
    const uw = CIRCLE_W[iu];
    for (let iv = 0; iv < 9; iv++) {
      const [vx, vy] = CIRCLE_PTS[iv];
      const vw = CIRCLE_W[iv];
      const r = major + minor * vx; // cross-section radial coord (from Z axis)
      const z = minor * vy;         // cross-section height
      points.push({ co: [r * ux, r * uy, z], w: uw * vw });
    }
  }
  return {
    degreeU: 2, degreeV: 2, pointsU: 9, pointsV: 9, points,
    knotsU: [...CIRCLE_KNOTS], knotsV: [...CIRCLE_KNOTS], tess: defaultSurfaceTess(),
  };
}
