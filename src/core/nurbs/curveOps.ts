import { Vec3 } from '../math/vec3';
import { evaluateCurve } from '../curve/eval';
import { cloneCurveData, type CurveData, type CurvePoint } from '../scene/objectData';
import {
  curveDataDegree,
  curveDomain,
  elevateDegree,
  fromCurveData,
  insertKnot,
  rebuildCurve,
  toCurveData,
} from './curve';

/**
 * PURE curve payload transforms (NB-A4) — CurveData → CurveData, no GL/DOM.
 * These are the app-facing degree / spans / knot-insert operations the N-panel
 * Curve section drives, layered over the exact NURBS math in curve.ts.
 *
 * Two representations live here:
 *  - OPEN NURBS payloads round-trip through fromCurveData/toCurveData, so the
 *    exact operations (elevateDegree, insertKnot) preserve shape bit-for-bit and
 *    write explicit knots back into the payload.
 *  - BEZIER and CYCLIC payloads have no directly-editable open knot vector
 *    (bezier is handle-driven; cyclic uses the evaluator's periodic-lite wrap),
 *    so they convert by REBUILDING — re-approximating the evaluated shape with a
 *    fresh control net. Bezier rebuilds to an open NURBS; cyclic stays cyclic
 *    (the closed loop is resampled, periodic-lite like the presets).
 *
 * `resolution` (eval segments per span) is a display setting, untouched by every
 * op — it is copied straight onto every result.
 */

/** Degree clamp for the UI/ops: 1..5 and never more than points-1. */
export const CURVE_DEGREE_MIN = 1;
export const CURVE_DEGREE_MAX = 5;

/** Clamp a requested degree to 1..5 and to at most `pointCount - 1` (a curve of n
 *  control points can be at most degree n-1). */
export function clampCurveDegree(degree: number, pointCount: number): number {
  const maxByPoints = Math.max(CURVE_DEGREE_MIN, pointCount - 1);
  const d = Math.round(degree);
  return Math.max(CURVE_DEGREE_MIN, Math.min(CURVE_DEGREE_MAX, Math.min(d, maxByPoints)));
}

/** A CurvePoint list from Euclidean points (weights 1). */
function toPoints(pts: Vec3[]): CurvePoint[] {
  return pts.map((p) => ({ co: [p.x, p.y, p.z] as [number, number, number] }));
}

/** A cyclic NURBS payload from Euclidean points — no explicit knots, so the
 *  evaluator uses its periodic-lite wrap (uniform knots), exactly like the
 *  Shift+A cyclic presets. */
function cyclicNurbsData(pts: Vec3[], degree: number, resolution: number): CurveData {
  return {
    kind: 'nurbs',
    cyclic: true,
    resolution,
    order: degree + 1,
    points: toPoints(pts),
  };
}

/** The evaluated polyline of a cyclic curve, guaranteed closed (first point
 *  appended when the evaluator didn't already close it) so it can be resampled
 *  as a loop. */
function closedPolyline(data: CurveData): Vec3[] {
  const poly = evaluateCurve(data).map((p) => new Vec3(p.x, p.y, p.z));
  if (poly.length === 0) return poly;
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (first.distanceTo(last) > 1e-9) poly.push(new Vec3(first.x, first.y, first.z));
  return poly;
}

/** Resample a closed loop polyline into `count` points at uniform arc-length
 *  fractions k/count (k = 0..count-1) — the fraction denominator is `count`, not
 *  count-1, so the last sample stops short of the duplicated closing point. */
function resampleLoop(poly: Vec3[], count: number): Vec3[] {
  if (poly.length === 0) return [];
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + poly[i].distanceTo(poly[i - 1]));
  const total = cum[cum.length - 1];
  const out: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const target = total === 0 ? 0 : (total * k) / count;
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] < target) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg === 0 ? 0 : (target - cum[i]) / seg;
    out.push(poly[i].add(poly[i + 1].sub(poly[i]).scale(f)));
  }
  return out;
}

/**
 * Set a curve's degree (NB-A4).
 *  - OPEN NURBS: increasing the degree uses the EXACT elevateDegree (shape
 *    preserved bit-for-bit, control count grows); decreasing rebuilds the curve
 *    at the new degree, keeping the current control-point count (a rebuild can't
 *    be exact — a lower degree can't represent every higher-degree shape).
 *  - BEZIER: convert to an open NURBS by rebuilding the evaluated shape at the
 *    requested degree (result is kind 'nurbs' but follows the bezier's shape).
 *  - CYCLIC: stay cyclic — resample the closed loop back into the same number of
 *    points at the requested degree (periodic-lite, like the presets).
 * The requested degree is clamped to 1..5 and to points-1. `resolution` is
 * preserved. Returns a NEW payload; the input is untouched.
 */
export function setCurveDegree(data: CurveData, degree: number): CurveData {
  const target = clampCurveDegree(degree, data.points.length);
  const res = data.resolution;

  if (data.cyclic) {
    // Keep the closed shape AND the point count; only the degree changes.
    const count = data.points.length;
    const pts = resampleLoop(closedPolyline(data), count);
    if (pts.length === 0) return cloneCurveData(data);
    return cyclicNurbsData(pts, Math.min(target, count - 1), res);
  }

  const c = fromCurveData(data);
  if (!c) return cloneCurveData(data);

  if (data.kind === 'bezier') {
    // Rebuild the evaluated bezier shape as an open NURBS at the target degree,
    // keeping roughly the bezier's control resolution.
    const count = Math.max(target + 1, c.Pw.length);
    return toCurveData(rebuildCurve(c, count, target), res);
  }

  // Open NURBS.
  const cur = curveDataDegree(data);
  if (target > cur) return toCurveData(elevateDegree(c, target - cur), res);
  if (target < cur) return toCurveData(rebuildCurve(c, data.points.length, target), res);
  return cloneCurveData(data); // unchanged
}

/**
 * Rebuild a curve to `pointCount` control points of `degree` (NB-A4). Open
 * payloads (bezier/open-nurbs) rebuild via rebuildCurve into an open NURBS.
 * Cyclic payloads stay cyclic: the closed loop is sampled, the duplicate end
 * point dropped, weights reset to 1, periodic-lite (no explicit knots) like the
 * presets. Degree is clamped 1..5, count to at least degree+1. `resolution` is
 * preserved.
 */
export function rebuildCurveData(data: CurveData, pointCount: number, degree: number): CurveData {
  const res = data.resolution;
  const deg = Math.max(CURVE_DEGREE_MIN, Math.min(CURVE_DEGREE_MAX, Math.round(degree)));
  const count = Math.max(deg + 1, Math.round(pointCount));

  if (data.cyclic) {
    const pts = resampleLoop(closedPolyline(data), count);
    if (pts.length === 0) return cloneCurveData(data);
    return cyclicNurbsData(pts, deg, res);
  }

  const c = fromCurveData(data);
  if (!c) return cloneCurveData(data);
  return toCurveData(rebuildCurve(c, count, deg), res);
}

/**
 * Insert a single knot at parameter `u` (NB-A4). OPEN NURBS only: the exact
 * A5.1 insertion preserves the shape and adds one control point, and the result
 * carries the explicit knot vector. For bezier / cyclic payloads there is no
 * editable open knot vector, so the input is returned UNCHANGED (the N-panel
 * disables the Insert button there). Returns a NEW payload.
 */
export function insertCurveKnotAt(data: CurveData, u: number): CurveData {
  if (data.kind !== 'nurbs' || data.cyclic) return cloneCurveData(data);
  const c = fromCurveData(data);
  if (!c) return cloneCurveData(data);
  return toCurveData(insertKnot(c, u, 1), data.resolution);
}

/**
 * The parametric midpoint of the WIDEST knot span (NB-A4) — the target the
 * N-panel's Insert Knot button inserts at, so a click splits the largest gap.
 * Returns null when knot insertion doesn't apply (bezier, cyclic, < 2 points, or
 * no non-degenerate span inside the domain).
 */
export function largestSpanMid(data: CurveData): number | null {
  if (data.kind !== 'nurbs' || data.cyclic) return null;
  const c = fromCurveData(data);
  if (!c) return null;
  const [lo, hi] = curveDomain(c);
  let bestMid: number | null = null;
  let bestWidth = 0;
  for (let i = 0; i < c.U.length - 1; i++) {
    // Clip each knot span to the evaluable domain so a boundary span's midpoint
    // stays interior (insertion at the exact domain ends is a no-op).
    const a = Math.max(c.U[i], lo);
    const b = Math.min(c.U[i + 1], hi);
    const w = b - a;
    if (w > bestWidth + 1e-12) {
      bestWidth = w;
      bestMid = (a + b) / 2;
    }
  }
  return bestMid;
}

/** Knot / span counts for a curve's read-out (NB-A4): the number of DISTINCT
 *  knot spans (intervals of positive width in the domain) and the total stored
 *  knot count. Bezier/cyclic have no explicit open knot vector, so they report
 *  their implicit clamped/periodic structure via fromCurveData. Null when the
 *  payload has nothing evaluable (< 2 points). */
export function curveKnotInfo(data: CurveData): { knots: number; spans: number } | null {
  const c = fromCurveData(data);
  if (!c) return null;
  const [lo, hi] = curveDomain(c);
  let spans = 0;
  for (let i = 0; i < c.U.length - 1; i++) {
    const a = Math.max(c.U[i], lo);
    const b = Math.min(c.U[i + 1], hi);
    if (b - a > 1e-12) spans++;
  }
  return { knots: c.U.length, spans };
}
