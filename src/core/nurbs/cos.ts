import { Vec3 } from '../math/vec3';
import type { CurveData, SurfaceCurve, SurfaceData } from '../scene/objectData';
import {
  curveDataDegree,
  curveDomain,
  curvePoint,
  fromCurveData,
  interpolateCurve,
  rebuildCurve,
  toCurveData,
} from './curve';
import { fromSurfaceData, isoCurve, surfaceDomain, surfacePoint } from './surface';

/**
 * Curves-on-surface helpers (NB-C1). A SurfaceCurve is a CurveData whose control
 * points live in the surface's UV parameter space (co = [u, v, 0]); these pure
 * functions map such a UV curve onto the surface (→ a 3D polyline for display),
 * synthesize isoparametric UV lines, and extract a standalone 3D NURBS curve
 * that approximates (or, for exact isoparms, equals) the on-surface curve.
 *
 * No GL, no DOM — the render pass and the Surface tab consume these.
 */

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Sample the UV curve at `segs`+1 params and map each (u, v) through the surface
 * (clamped into the parameter domain) → a 3D polyline in the surface's LOCAL
 * space. Returns [] when the surface net is too small to evaluate. Falls back to
 * the raw UV control points when the curve payload isn't evaluable (< 2 points).
 */
export function evalSurfaceCurve3D(data: SurfaceData, curve: CurveData, segs = 96): Vec3[] {
  const s = fromSurfaceData(data);
  if (!s) return [];
  const [ul, uh, vl, vh] = surfaceDomain(s);
  const out: Vec3[] = [];
  const c = fromCurveData(curve);
  if (!c) {
    for (const p of curve.points) {
      out.push(surfacePoint(s, clamp(p.co[0], ul, uh), clamp(p.co[1], vl, vh)));
    }
    return out;
  }
  const [lo, hi] = curveDomain(c);
  const n = Math.max(2, Math.round(segs));
  for (let i = 0; i <= n; i++) {
    const p = curvePoint(c, lo + ((hi - lo) * i) / n);
    out.push(surfacePoint(s, clamp(p.x, ul, uh), clamp(p.y, vl, vh)));
  }
  return out;
}

/**
 * A degree-1, two-point UV line spanning the domain at parameter `t`: dir 'u'
 * fixes u = t (the line runs across V), dir 'v' fixes v = t (runs across U). `t`
 * is in the REAL parameter domain (the caller maps a 0..1 slider). The returned
 * SurfaceCurve is named "IsoU"/"IsoV"; the caller renames it "IsoU.NNN"-style.
 */
export function isoparmSurfaceCurve(data: SurfaceData, dir: 'u' | 'v', t: number): SurfaceCurve {
  const s = fromSurfaceData(data);
  const [ul, uh, vl, vh] = s ? surfaceDomain(s) : [0, 1, 0, 1];
  const tt = dir === 'u' ? clamp(t, ul, uh) : clamp(t, vl, vh);
  const points =
    dir === 'u'
      ? [{ co: [tt, vl, 0] as [number, number, number] }, { co: [tt, vh, 0] as [number, number, number] }]
      : [{ co: [ul, tt, 0] as [number, number, number] }, { co: [uh, tt, 0] as [number, number, number] }];
  const curve: CurveData = { kind: 'nurbs', cyclic: false, resolution: 12, order: 2, points };
  return { name: dir === 'u' ? 'IsoU' : 'IsoV', curve };
}

/**
 * Detect an EXACT isoparm UV curve: a degree-1 curve of exactly two control
 * points at a constant u or v. Returns the direction + parameter, or null.
 */
function detectIsoparm(curve: CurveData): { dir: 'u' | 'v'; t: number } | null {
  if (curve.points.length !== 2 || curveDataDegree(curve) !== 1) return null;
  const a = curve.points[0].co;
  const b = curve.points[1].co;
  const eps = 1e-9;
  if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) > eps) return { dir: 'u', t: a[0] };
  if (Math.abs(a[1] - b[1]) <= eps && Math.abs(a[0] - b[0]) > eps) return { dir: 'v', t: a[1] };
  return null;
}

/** Number of UV-map samples used to fit a general on-surface curve. */
const EXTRACT_SAMPLES = 128;
/** Control-point count / degree of the fitted standalone curve. */
const EXTRACT_POINTS = 24;
const EXTRACT_DEGREE = 3;

/**
 * A standalone 3D CurveData approximating (or equalling) the on-surface curve.
 *
 * EXACT isoparm lines (a degree-1 two-point UV curve at constant u or v) are
 * lifted with `isoCurve` → `toCurveData`, which is mathematically exact.
 *
 * General UV curves are APPROXIMATED: sample EXTRACT_SAMPLES points through the
 * surface map, interpolate a degree-3 curve through them, then rebuild to
 * EXTRACT_POINTS control points (the Alias/Rhino "rebuild" fit). The result
 * stays on the surface to within tessellation-scale error (well under 1e-3 on
 * the smooth patches this toolset produces).
 */
export function extractSurfaceCurveToCurveData(data: SurfaceData, curve: CurveData): CurveData {
  const s = fromSurfaceData(data);
  if (!s) return { kind: 'nurbs', cyclic: false, resolution: 12, points: curve.points.map((p) => ({ co: [...p.co] as [number, number, number] })) };

  const iso = detectIsoparm(curve);
  if (iso) {
    return toCurveData(isoCurve(s, iso.dir, iso.t), curve.resolution);
  }

  // General curve: dense sample through the surface, then a rebuild-style fit.
  const pts = evalSurfaceCurve3D(data, curve, EXTRACT_SAMPLES - 1); // → EXTRACT_SAMPLES points
  const dense = interpolateCurve(pts, EXTRACT_DEGREE);
  const fitted = rebuildCurve(dense, EXTRACT_POINTS, EXTRACT_DEGREE);
  return toCurveData(fitted, curve.resolution);
}
