import { Vec3 } from '../math/vec3';
import { clampCurveResolution, type CurveData, type CurvePoint } from '../scene/objectData';

/**
 * Pure curve evaluation (UR11-1): a Bezier / NURBS control-point payload → a
 * flat polyline of world-LOCAL points, plus curve length and parallel-transport
 * frames for the UR11-2 Pipe sweep. No GL, no DOM — unit-tested against
 * closed-form values.
 */

function co(p: CurvePoint): Vec3 {
  return new Vec3(p.co[0], p.co[1], p.co[2]);
}

/** Mirror handle `h` about anchor `a` (2a − h) — Blender's mirrored-handle rule. */
function mirror(a: Vec3, h: Vec3): Vec3 {
  return a.scale(2).sub(h);
}

/** Right (outgoing) handle of a bezier point: explicit, else mirror of hl, else co. */
export function rightHandle(p: CurvePoint): Vec3 {
  if (p.hr) return new Vec3(p.hr[0], p.hr[1], p.hr[2]);
  if (p.hl) return mirror(co(p), new Vec3(p.hl[0], p.hl[1], p.hl[2]));
  return co(p);
}

/** Left (incoming) handle of a bezier point: explicit, else mirror of hr, else co. */
export function leftHandle(p: CurvePoint): Vec3 {
  if (p.hl) return new Vec3(p.hl[0], p.hl[1], p.hl[2]);
  if (p.hr) return mirror(co(p), new Vec3(p.hr[0], p.hr[1], p.hr[2]));
  return co(p);
}

/** Cubic Bezier point on the span P0→(P1,P2)→P3 at parameter t∈[0,1]. */
export function cubicBezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return new Vec3(
    b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
    b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z,
  );
}

/** Evaluate a Bezier curve to a polyline (see evaluateCurve). */
function evaluateBezier(data: CurveData): Vec3[] {
  const pts = data.points;
  const n = pts.length;
  const res = clampCurveResolution(data.resolution);
  const out: Vec3[] = [];
  if (n === 0) return out;
  if (n === 1) return [co(pts[0])];

  const spanCount = data.cyclic ? n : n - 1;
  for (let i = 0; i < spanCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const p0 = co(a);
    const p1 = rightHandle(a);
    const p2 = leftHandle(b);
    const p3 = co(b);
    // Emit start-inclusive, end-exclusive so span joins are not duplicated.
    for (let j = 0; j < res; j++) out.push(cubicBezier(p0, p1, p2, p3, j / res));
  }
  // Close the drawn line: open curves append the final anchor; cyclic ones
  // append the first anchor to wrap the loop back to the start.
  out.push(co(pts[data.cyclic ? 0 : n - 1]));
  return out;
}

// --- NURBS (Cox-de Boor, rational) ------------------------------------------

/**
 * All B-spline basis functions N_{i,p}(u) for a clamped/uniform knot vector.
 * Returns an array of length ctrlCount (the i-th value = N_{i,p}(u)). Partition
 * of unity holds: the returned values sum to 1 for any u in the valid domain.
 * Exported for the partition-of-unity unit test.
 */
export function nurbsBasis(ctrlCount: number, p: number, knots: number[], u: number): number[] {
  const N = new Array(ctrlCount).fill(0) as number[];
  // Find the knot span index `span` with knots[span] <= u < knots[span+1]
  // (clamped to the last valid span at the domain's upper end).
  const m = knots.length - 1;
  let span = -1;
  const uMax = knots[m - p];
  if (u >= uMax) {
    span = m - p - 1; // last span
  } else {
    for (let i = p; i < m - p; i++) {
      if (u >= knots[i] && u < knots[i + 1]) { span = i; break; }
    }
    if (span < 0) span = p;
  }
  // Cox-de Boor triangular computation of the p+1 nonzero basis functions.
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  const ndu = new Array(p + 1).fill(1);
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : ndu[r] / denom;
      ndu[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j] = saved;
  }
  for (let i = 0; i <= p; i++) {
    const ci = span - p + i;
    if (ci >= 0 && ci < ctrlCount) N[ci] = ndu[i];
  }
  return N;
}

/** Build a clamped-uniform knot vector for `n` control points of degree `p`. */
export function clampedKnots(n: number, p: number): number[] {
  const m = n + p; // last index; knots length = n + p + 1
  const knots: number[] = [];
  const inner = n - p; // upper domain bound
  for (let i = 0; i <= m; i++) {
    if (i <= p) knots.push(0);
    else if (i >= m - p) knots.push(inner);
    else knots.push(i - p);
  }
  return knots;
}

/** Evaluate a NURBS curve to a polyline (see evaluateCurve). */
function evaluateNurbs(data: CurveData): Vec3[] {
  const src = data.points;
  const n0 = src.length;
  const res = clampCurveResolution(data.resolution);
  if (n0 === 0) return [];
  if (n0 === 1) return [co(src[0])];

  const k = Math.max(2, Math.min(data.order ?? 4, n0));
  const p = k - 1;

  // Control points + weights, WRAPPED for cyclic (periodic-lite: repeat the
  // first `p` points and use a uniform, non-clamped knot vector so the curve
  // closes; a documented simplification vs a true periodic NURBS basis).
  const ctrl: Vec3[] = src.map(co);
  const weights: number[] = src.map((q) => q.w ?? 1);
  let knots: number[];
  let uStart: number;
  let uEnd: number;
  if (data.cyclic) {
    for (let i = 0; i < p; i++) {
      ctrl.push(co(src[i % n0]));
      weights.push(src[i % n0].w ?? 1);
    }
    const n = ctrl.length;
    // Uniform knots 0..n+p (open/non-clamped); valid periodic domain [p, n].
    knots = [];
    for (let i = 0; i <= n + p; i++) knots.push(i);
    uStart = p;
    uEnd = n;
  } else {
    knots = clampedKnots(n0, p);
    uStart = 0;
    uEnd = n0 - p;
  }

  const spans = uEnd - uStart; // number of knot intervals in the domain
  const total = Math.max(1, Math.round(spans)) * res;
  const out: Vec3[] = [];
  for (let s = 0; s <= total; s++) {
    const u = uStart + (uEnd - uStart) * (s / total);
    const N = nurbsBasis(ctrl.length, p, knots, u);
    let x = 0, y = 0, z = 0, wsum = 0;
    for (let i = 0; i < ctrl.length; i++) {
      const wN = N[i] * weights[i];
      if (wN === 0) continue;
      x += wN * ctrl[i].x;
      y += wN * ctrl[i].y;
      z += wN * ctrl[i].z;
      wsum += wN;
    }
    out.push(wsum === 0 ? ctrl[0] : new Vec3(x / wsum, y / wsum, z / wsum));
  }
  return out;
}

/**
 * Evaluate a curve payload to a flat polyline of object-local points. Bezier:
 * cubic per span from (co,hr)→(hl,co) with auto-mirrored handles when absent.
 * NURBS: clamped-uniform Cox-de Boor with rational weights. Cyclic closes the
 * loop. The polyline is what the viewport draws and what the Pipe modifier sweeps.
 */
export function evaluateCurve(data: CurveData): Vec3[] {
  return data.kind === 'nurbs' ? evaluateNurbs(data) : evaluateBezier(data);
}

/** Total arc length of a polyline (sum of segment lengths). */
export function curveLength(pts: Vec3[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  return len;
}

export interface CurveFrame {
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

/** Rotate `v` about unit `axis` by `angle` (Rodrigues). */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return v.scale(c).add(axis.cross(v).scale(s)).add(axis.scale(axis.dot(v) * (1 - c)));
}

/**
 * Parallel-transport (rotation-minimizing) frames along a polyline — position,
 * tangent, normal, binormal per point. The normal is propagated by the minimal
 * rotation that aligns each tangent to the next, so it never spins about the
 * tangent (no flips) — the UR11-2 sweep needs this to avoid pinched geometry.
 */
export function frames(pts: Vec3[]): CurveFrame[] {
  const n = pts.length;
  if (n === 0) return [];
  // Per-point tangents (forward difference; last repeats the previous).
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    let t: Vec3;
    if (i < n - 1) t = pts[i + 1].sub(pts[i]);
    else t = pts[i].sub(pts[i - 1] ?? pts[i]);
    if (t.lengthSq() < 1e-18) t = tangents[i - 1] ?? Vec3.X;
    tangents.push(t.normalize());
  }
  // Seed normal: a world axis made perpendicular to the first tangent.
  let up = Vec3.Z;
  if (Math.abs(tangents[0].dot(up)) > 0.99) up = Vec3.X;
  let normal = up.sub(tangents[0].scale(tangents[0].dot(up))).normalize();
  if (normal.lengthSq() < 1e-12) normal = Vec3.Y;

  const out: CurveFrame[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const t0 = tangents[i - 1];
      const t1 = tangents[i];
      const axis = t0.cross(t1);
      const sinA = axis.length();
      if (sinA > 1e-8) {
        const angle = Math.atan2(sinA, Math.max(-1, Math.min(1, t0.dot(t1))));
        normal = rotateAbout(normal, axis.normalize(), angle);
      }
      // Re-orthogonalize against drift and renormalize.
      normal = normal.sub(t1.scale(t1.dot(normal))).normalize();
      if (normal.lengthSq() < 1e-12) normal = out[i - 1].normal;
    }
    const binormal = tangents[i].cross(normal).normalize();
    out.push({ position: pts[i], tangent: tangents[i], normal, binormal });
  }
  return out;
}
