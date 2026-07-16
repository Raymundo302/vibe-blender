import { Vec3 } from '../math/vec3';
import type { CurveData } from '../scene/objectData';
import { dersBasisFuns, findSpan } from './basis';
import {
  cloneNCurve,
  curveDerivs,
  curveDomain,
  elevateDegree,
  fromCurveData,
  rebuildCurve,
  toCurveData,
  type NCurve,
} from './curve';

/**
 * NB-B2 — geometric curve-end continuity matching (the "Align" tool).
 *
 * `matchCurveEnd` moves the control points nearest ONE end of a source curve so
 * that this end joins a target curve's end with Gⁿ (n = 0..3) geometric
 * continuity: G0 = coincident point, G1 = tangent direction, G2 = curvature
 * vector, G3 = rate-of-change of the curvature vector along arc length. Only the
 * near control points change (the far end is provably fixed for a clamped
 * B-spline), so the rest of the source's shape is minimally disturbed.
 *
 * Strategy (Farin/Piegl geometric-continuity constraints, arc-length form):
 *  1. Normalise the source to an OPEN, CLAMPED, NON-RATIONAL B-spline of degree
 *     ≥ level+1. Cyclic or rational sources are rebuilt (rebuildCurve resets
 *     weights to 1 and produces an open clamped curve); a low-degree source is
 *     degree-elevated (exact shape preservation). Both give enough free control
 *     points at the end and unit weights, so the end derivatives are a simple
 *     triangular linear system in the last (first) k+1 control points.
 *  2. Read the target end's geometry: point Q, unit tangent T̂, curvature vector
 *     K = κN̂ (an arc-length quantity, INVARIANT to traversal direction), and
 *     the arc-length third derivative W = d(κN̂)/ds (dK/ds — ODD, so it flips
 *     with traversal direction). Orient T̂ and W to FLOW across the join with a
 *     single sign ε (see below) so the two curves continue smoothly instead of
 *     folding back on each other.
 *  3. Preserve the source end SPEED m = |C'| (minimises the shape change) and
 *     build the desired parametric end derivatives D1,D2,D3 that reproduce the
 *     target's arc-length quantities at that speed, keeping the source's own
 *     tangential residuals where they don't affect the geometry.
 *  4. Solve the triangular system top-down for the control points.
 *
 * Sign bookkeeping. σ = +1 for the 'end' (upper-domain) side, −1 for the 'start'
 * (lower-domain) side. The source's own forward parametrisation, oriented to
 * continue the target smoothly, runs the SAME way as the target's forward
 * parametrisation when ε = −σ_src·σ_tgt = +1, and opposite when ε = −1. The
 * even-order curvature vector K is unaffected by ε; the odd-order tangent T̂ and
 * third derivative W both pick up the factor ε.
 */

export type CurveEnd = 'start' | 'end';
export type MatchLevel = 0 | 1 | 2 | 3;

/**
 * Arc-length SECOND derivative r_ss = d²r/ds² (the curvature vector κN̂) from
 * the parametric derivatives d1 = C', d2 = C''. Depends only on the component of
 * d2 perpendicular to the tangent, so it is exactly the curvature vector.
 */
function arcSecond(d1: Vec3, d2: Vec3): Vec3 {
  const s1 = d1.length();
  if (s1 < 1e-14) return new Vec3();
  const t = d1.scale(1 / s1); // unit tangent
  const s2 = t.dot(d2); // s'' = (C'·C'')/|C'|
  return d2.sub(t.scale(s2)).scale(1 / (s1 * s1));
}

/**
 * Arc-length THIRD derivative r_sss = d³r/ds³ (= dK/ds, the change of the
 * curvature vector along arc length) from d1 = C', d2 = C'', d3 = C'''.
 * Full chain rule for a speed-varying parametrisation.
 */
function arcThird(d1: Vec3, d2: Vec3, d3: Vec3): Vec3 {
  const s1 = d1.length();
  if (s1 < 1e-14) return new Vec3();
  const s1_2 = s1 * s1, s1_3 = s1_2 * s1, s1_4 = s1_3 * s1, s1_5 = s1_4 * s1;
  const d1d2 = d1.dot(d2);
  const s2 = d1d2 / s1; // s''
  const s3 = (d2.dot(d2) + d1.dot(d3)) / s1 - (d1d2 * d1d2) / s1_3; // s'''
  // r_sss = C'''/s'³ − 3C''·s''/s'⁴ − C'·s'''/s'⁴ + 3C'·s''²/s'⁵
  return d3.scale(1 / s1_3)
    .sub(d2.scale((3 * s2) / s1_4))
    .sub(d1.scale(s3 / s1_4))
    .add(d1.scale((3 * s2 * s2) / s1_5));
}

/** Vec3 from a homogeneous control point (non-rational, w = 1). */
function ptOf(q: number[]): Vec3 {
  return new Vec3(q[0], q[1], q[2]);
}

/**
 * Normalise a source into an open, clamped, NON-RATIONAL B-spline of degree
 * ≥ minDegree. Cyclic/rational payloads are rebuilt (weights reset to 1, keeping
 * the control-point count); an under-degree curve is exactly degree-elevated.
 */
function prepareSource(src: CurveData, minDegree: number): NCurve {
  const c0 = fromCurveData(src);
  if (!c0) throw new Error('matchCurveEnd: source needs at least 2 control points');
  let c = c0;
  const rational = c.Pw.some((q) => Math.abs((q[3] ?? 1) - 1) > 1e-9);
  if (src.cyclic || rational) {
    c = rebuildCurve(c, c.Pw.length, Math.max(c.p, minDegree));
  }
  if (c.p < minDegree) c = elevateDegree(c, minDegree - c.p);
  else if (c === c0) c = cloneNCurve(c); // never mutate the caller's data via toCurveData paths
  return c;
}

/**
 * Match the `srcEnd` of `src` to the `targetEnd` of `target` with G`level`
 * continuity. Returns a NEW CurveData (open NURBS, explicit knots) for the
 * source; `target` is untouched. Both curves are read in their OWN coordinate
 * frames — a caller joining two transformed objects must first express the
 * target in the source's local frame (see alignPopover).
 */
export function matchCurveEnd(
  src: CurveData,
  srcEnd: CurveEnd,
  target: CurveData,
  targetEnd: CurveEnd,
  level: MatchLevel,
): CurveData {
  const tc = fromCurveData(target);
  if (!tc) throw new Error('matchCurveEnd: target needs at least 2 control points');
  const c = prepareSource(src, level + 1);

  const [cLo, cHi] = curveDomain(c);
  const uSrc = srcEnd === 'end' ? cHi : cLo;
  const [tLo, tHi] = curveDomain(tc);
  const uTgt = targetEnd === 'end' ? tHi : tLo;

  // --- Target end geometry (arc-length quantities) --------------------------
  const [tPoint, td1, td2, td3] = curveDerivs(tc, uTgt, 3);
  const tSpeed = td1.length();
  if (tSpeed < 1e-14) throw new Error('matchCurveEnd: target end is degenerate (zero tangent)');
  const tTangent = td1.scale(1 / tSpeed); // target forward unit tangent
  const kTarget = arcSecond(td1, td2); // curvature vector κN̂ (traversal-invariant)
  const wTargetFwd = arcThird(td1, td2, td3); // dK/ds in the target's forward param (odd)

  // --- Source end original derivatives --------------------------------------
  const [, sd1, sd2, sd3] = curveDerivs(c, uSrc, 3);
  const m = sd1.length(); // preserved end speed
  if (m < 1e-14) throw new Error('matchCurveEnd: source end is degenerate (zero tangent)');

  // Flow orientation across the join.
  const sigmaSrc = srcEnd === 'end' ? 1 : -1;
  const sigmaTgt = targetEnd === 'end' ? 1 : -1;
  const eps = -sigmaSrc * sigmaTgt; // +1 same forward direction, −1 opposite

  const tHat = tTangent.scale(eps); // desired source FORWARD unit tangent
  const wSrc = wTargetFwd.scale(eps); // target dK/ds re-oriented to source-forward

  // Desired parametric end derivatives.
  const D0 = tPoint; // G0: coincident point Q
  const D1 = tHat.scale(m); // G1: preserve speed, align tangent
  // G2: normal component realises K at speed m; keep source's tangential residual.
  const t2 = sd2.dot(tHat);
  const D2 = kTarget.scale(m * m).add(tHat.scale(t2));
  // G3: perpendicular component realises dK/ds; keep source's tangential residual.
  const t3 = sd3.dot(tHat);
  const rRemainder = arcThird(D1, D2, tHat.scale(t3)); // r_sss with D3 purely tangential
  const D3 = wSrc.sub(rRemainder).scale(m * m * m).add(tHat.scale(t3));

  const desired = [D0, D1, D2, D3];

  // --- Solve the triangular control-point system ----------------------------
  // At a clamped end the k-th end derivative is a combination of exactly the
  // last (first) k+1 control points; solve G0→G1→G2→G3 top-down. Weights are 1.
  const count = c.Pw.length;
  const p = c.p;
  const n = count - 1;
  const span = findSpan(count, p, uSrc, c.U);
  const ders = dersBasisFuns(span, uSrc, p, level, c.U);
  const P = c.Pw.map(ptOf);

  if (srcEnd === 'end') {
    // C^(k)(uHi) = Σ_{i=0..k} ders[k][p−i]·P_{n−i}
    for (let k = 0; k <= level; k++) {
      let acc = new Vec3();
      for (let i = 0; i < k; i++) acc = acc.add(P[n - i].scale(ders[k][p - i]));
      const coeff = ders[k][p - k];
      P[n - k] = desired[k].sub(acc).scale(1 / coeff);
    }
  } else {
    // C^(k)(uLo) = Σ_{j=0..k} ders[k][j]·P_j
    for (let k = 0; k <= level; k++) {
      let acc = new Vec3();
      for (let j = 0; j < k; j++) acc = acc.add(P[j].scale(ders[k][j]));
      const coeff = ders[k][k];
      P[k] = desired[k].sub(acc).scale(1 / coeff);
    }
  }

  const out = cloneNCurve(c);
  out.Pw = P.map((v) => [v.x, v.y, v.z, 1]);
  return toCurveData(out, src.resolution);
}
