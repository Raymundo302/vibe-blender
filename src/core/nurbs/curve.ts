import { Vec3 } from '../math/vec3';
import type { CurveData } from '../scene/objectData';
import {
  basisFuns,
  binomial,
  clampToDomain,
  clampedUniformKnots,
  dersBasisFuns,
  findSpan,
  knotDomain,
  knotMultiplicity,
  validKnots,
} from './basis';

/**
 * Rational B-spline CURVES (NB-CORE): a normalized homogeneous representation
 * plus the operations the NURBS toolset needs — exact evaluation, derivatives,
 * curvature (combs), knot insertion (spans), degree elevation (A5.9), rebuild
 * (global interpolation), and closest-point projection. Pure math, unit-tested
 * against closed forms (rational circle, finite differences, shape invariance).
 *
 * The app-facing CurveData payload (bezier or nurbs, optional explicit knots)
 * converts to/from this via fromCurveData()/toCurveData(). Legacy payloads
 * without explicit knots use the same clamped-uniform integer convention as
 * core/curve/eval.ts, so nothing existing changes shape.
 */

export interface NCurve {
  /** Degree p. */
  p: number;
  /** Knot vector, length Pw.length + p + 1, non-decreasing. */
  U: number[];
  /** HOMOGENEOUS control points [x·w, y·w, z·w, w]. */
  Pw: number[][];
}

/** Deep copy. */
export function cloneNCurve(c: NCurve): NCurve {
  return { p: c.p, U: [...c.U], Pw: c.Pw.map((q) => [...q]) };
}

/** The evaluable [lo, hi] parameter domain. */
export function curveDomain(c: NCurve): [number, number] {
  return knotDomain(c.Pw.length, c.p, c.U);
}

/** Homogeneous point [X,Y,Z,W] at u. */
export function curvePointH(c: NCurve, u: number): number[] {
  const n = c.Pw.length;
  const uu = clampToDomain(n, c.p, c.U, u);
  const span = findSpan(n, c.p, uu, c.U);
  const N = basisFuns(span, uu, c.p, c.U);
  const out = [0, 0, 0, 0];
  for (let j = 0; j <= c.p; j++) {
    const P = c.Pw[span - c.p + j];
    out[0] += N[j] * P[0];
    out[1] += N[j] * P[1];
    out[2] += N[j] * P[2];
    out[3] += N[j] * P[3];
  }
  return out;
}

/** Euclidean point at u. */
export function curvePoint(c: NCurve, u: number): Vec3 {
  const h = curvePointH(c, u);
  const w = h[3] === 0 ? 1 : h[3];
  return new Vec3(h[0] / w, h[1] / w, h[2] / w);
}

/**
 * Euclidean derivatives C(u), C'(u), … C^(d)(u) (A4.2: homogeneous derivatives
 * via the basis derivative table, then the rational correction).
 */
export function curveDerivs(c: NCurve, u: number, d: number): Vec3[] {
  const n = c.Pw.length;
  const uu = clampToDomain(n, c.p, c.U, u);
  const span = findSpan(n, c.p, uu, c.U);
  const nd = Math.min(d, c.p); // derivatives beyond the degree are zero
  const ders = dersBasisFuns(span, uu, c.p, nd, c.U);

  // Homogeneous derivatives A^(k) (xyz) and w^(k).
  const Aders: number[][] = [];
  const wders: number[] = [];
  for (let k = 0; k <= d; k++) {
    const a = [0, 0, 0];
    let w = 0;
    if (k <= nd) {
      for (let j = 0; j <= c.p; j++) {
        const P = c.Pw[span - c.p + j];
        const b = ders[k][j];
        a[0] += b * P[0];
        a[1] += b * P[1];
        a[2] += b * P[2];
        w += b * P[3];
      }
    }
    Aders.push(a);
    wders.push(w);
  }

  // Rational correction: C^(k) = (A^(k) - Σ_{i=1..k} C(k,i) w^(i) C^(k-i)) / w.
  const CK: Vec3[] = [];
  for (let k = 0; k <= d; k++) {
    let vx = Aders[k][0], vy = Aders[k][1], vz = Aders[k][2];
    for (let i = 1; i <= k; i++) {
      const b = binomial(k, i) * wders[i];
      vx -= b * CK[k - i].x;
      vy -= b * CK[k - i].y;
      vz -= b * CK[k - i].z;
    }
    const w = wders[0] === 0 ? 1 : wders[0];
    CK.push(new Vec3(vx / w, vy / w, vz / w));
  }
  return CK;
}

export interface CurvatureSample {
  u: number;
  point: Vec3;
  /** Unit tangent (zero vector on a degenerate span). */
  tangent: Vec3;
  /** Curvature magnitude κ = |C'×C''| / |C'|³. */
  kappa: number;
  /** Unit principal normal (points toward the center of curvature); zero when
   *  κ ≈ 0 (straight) — comb renderers draw nothing there. */
  normal: Vec3;
}

/** Curvature at u — the curvature-comb primitive. */
export function curvatureAt(c: NCurve, u: number): CurvatureSample {
  const [C, C1, C2] = curveDerivs(c, u, 2);
  const speed = C1.length();
  if (speed < 1e-12) {
    return { u, point: C, tangent: new Vec3(), kappa: 0, normal: new Vec3() };
  }
  const cross = C1.cross(C2);
  const crossLen = cross.length();
  const kappa = crossLen / (speed * speed * speed);
  const tangent = C1.scale(1 / speed);
  let normal = new Vec3();
  if (crossLen > 1e-14) {
    // Principal normal: ((C'×C'')×C') normalized — in-plane, ⟂ tangent.
    normal = cross.cross(C1).normalize();
  }
  return { u, point: C, tangent, kappa, normal };
}

// --- CurveData conversion -----------------------------------------------------

/** Effective degree of a CurveData (nurbs order-1 clamped to count-1; bezier 3). */
export function curveDataDegree(data: CurveData): number {
  if (data.kind === 'bezier') return 3;
  const k = Math.max(2, Math.min(data.order ?? 4, data.points.length));
  return k - 1;
}

/**
 * Normalize a CurveData payload into an NCurve.
 *  - nurbs: explicit `knots` when present+valid, else clamped-uniform. Cyclic
 *    uses the same periodic-lite wrap as the legacy evaluator (first p points
 *    repeated, uniform knots, domain [p, n]).
 *  - bezier: exact conversion to a degree-3 NURBS (interior knots at each span
 *    boundary with multiplicity 3), handles resolved with the mirror rule.
 * Returns null for payloads with < 2 points (nothing evaluable).
 */
export function fromCurveData(data: CurveData): NCurve | null {
  const pts = data.points;
  if (pts.length < 2) return null;

  if (data.kind === 'bezier') {
    const n = pts.length;
    const co = (i: number): Vec3 => new Vec3(pts[i].co[0], pts[i].co[1], pts[i].co[2]);
    const mirror = (a: Vec3, h: Vec3): Vec3 => a.scale(2).sub(h);
    const right = (i: number): Vec3 => {
      const p = pts[i];
      if (p.hr) return new Vec3(p.hr[0], p.hr[1], p.hr[2]);
      if (p.hl) return mirror(co(i), new Vec3(p.hl[0], p.hl[1], p.hl[2]));
      return co(i);
    };
    const left = (i: number): Vec3 => {
      const p = pts[i];
      if (p.hl) return new Vec3(p.hl[0], p.hl[1], p.hl[2]);
      if (p.hr) return mirror(co(i), new Vec3(p.hr[0], p.hr[1], p.hr[2]));
      return co(i);
    };
    const spans = data.cyclic ? n : n - 1;
    const Pw: number[][] = [];
    const push = (v: Vec3) => Pw.push([v.x, v.y, v.z, 1]);
    push(co(0));
    for (let s = 0; s < spans; s++) {
      const a = s, b = (s + 1) % n;
      push(right(a));
      push(left(b));
      push(co(b));
    }
    const U: number[] = [0, 0, 0, 0];
    for (let s = 1; s < spans; s++) U.push(s, s, s);
    U.push(spans, spans, spans, spans);
    return { p: 3, U, Pw };
  }

  // NURBS
  const k = Math.max(2, Math.min(data.order ?? 4, pts.length));
  const p = k - 1;
  const toH = (i: number): number[] => {
    const q = pts[i % pts.length];
    const w = q.w ?? 1;
    return [q.co[0] * w, q.co[1] * w, q.co[2] * w, w];
  };
  if (data.cyclic) {
    const Pw: number[][] = [];
    for (let i = 0; i < pts.length; i++) Pw.push(toH(i));
    for (let i = 0; i < p; i++) Pw.push(toH(i));
    const n = Pw.length;
    const U: number[] = [];
    for (let i = 0; i <= n + p; i++) U.push(i);
    return { p, U, Pw };
  }
  const Pw = pts.map((_, i) => toH(i));
  let U: number[];
  if (data.knots && validKnots(Pw.length, p, data.knots)) U = [...data.knots];
  else U = clampedUniformKnots(Pw.length, p);
  return { p, U, Pw };
}

/**
 * NCurve → a NURBS CurveData payload (open, explicit knots). The inverse of
 * fromCurveData for open nurbs; bezier/cyclic payloads round-trip through this
 * as plain open NURBS (used by degree/span rebuild UIs and IGES import).
 */
export function toCurveData(c: NCurve, resolution = 12): CurveData {
  return {
    kind: 'nurbs',
    cyclic: false,
    resolution,
    order: c.p + 1,
    knots: [...c.U],
    points: c.Pw.map((q) => {
      const w = q[3] === 0 ? 1 : q[3];
      const pt: { co: [number, number, number]; w?: number } = {
        co: [q[0] / w, q[1] / w, q[2] / w],
      };
      if (Math.abs(w - 1) > 1e-12) pt.w = w;
      return pt;
    }),
  };
}

// --- Knot insertion (A5.1) ----------------------------------------------------

/**
 * Insert knot value `u` `times` times (A5.1, homogeneous — exact shape
 * preservation). Insertion count is clamped so total multiplicity ≤ p.
 * Returns a NEW curve; the input is untouched.
 */
export function insertKnot(c: NCurve, u: number, times = 1): NCurve {
  const n = c.Pw.length;
  const [lo, hi] = curveDomain(c);
  if (u <= lo + 1e-12 || u >= hi - 1e-12) return cloneNCurve(c); // ends: no-op
  const s = knotMultiplicity(c.U, u);
  const r = Math.min(times, c.p - s);
  if (r <= 0) return cloneNCurve(c);

  const p = c.p;
  const k = findSpan(n, p, u, c.U);
  const UP = c.U;
  const Pw = c.Pw;

  const UQ: number[] = new Array(UP.length + r);
  for (let i = 0; i <= k; i++) UQ[i] = UP[i];
  for (let i = 1; i <= r; i++) UQ[k + i] = u;
  for (let i = k + 1; i < UP.length; i++) UQ[i + r] = UP[i];

  const Qw: number[][] = new Array(n + r);
  for (let i = 0; i <= k - p; i++) Qw[i] = [...Pw[i]];
  for (let i = k - s; i < n; i++) Qw[i + r] = [...Pw[i]];

  const Rw: number[][] = [];
  for (let i = 0; i <= p - s; i++) Rw.push([...Pw[k - p + i]]);

  let L = 0;
  for (let j = 1; j <= r; j++) {
    L = k - p + j;
    for (let i = 0; i <= p - j - s; i++) {
      const alpha = (u - UP[L + i]) / (UP[i + k + 1] - UP[L + i]);
      for (let d = 0; d < 4; d++) Rw[i][d] = alpha * Rw[i + 1][d] + (1 - alpha) * Rw[i][d];
    }
    Qw[L] = [...Rw[0]];
    Qw[k + r - j - s] = [...Rw[p - j - s]];
  }
  for (let i = L + 1; i < k - s; i++) Qw[i] = [...Rw[i - L]];

  return { p, U: UQ, Pw: Qw };
}

// --- Degree elevation (A5.9) ---------------------------------------------------

/**
 * Raise the curve's degree by `t` (A5.9, homogeneous — exact shape
 * preservation; interior knot multiplicities increase by t). Returns a NEW
 * curve. t ≤ 0 returns a clone.
 */
export function elevateDegree(c: NCurve, t: number): NCurve {
  if (t <= 0) return cloneNCurve(c);
  const p = c.p;
  const U = c.U;
  const Pw = c.Pw;
  const n = Pw.length - 1;
  const m = n + p + 1;
  const ph = p + t;
  const ph2 = Math.floor(ph / 2);

  // Bezier elevation coefficients.
  const bezalfs: number[][] = Array.from({ length: ph + 1 }, () => new Array<number>(p + 1).fill(0));
  bezalfs[0][0] = 1;
  bezalfs[ph][p] = 1;
  for (let i = 1; i <= ph2; i++) {
    const inv = 1 / binomial(ph, i);
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j++) {
      bezalfs[i][j] = inv * binomial(p, j) * binomial(t, i - j);
    }
  }
  for (let i = ph2 + 1; i <= ph - 1; i++) {
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j++) {
      bezalfs[i][j] = bezalfs[ph - i][p - j];
    }
  }

  const zero4 = () => [0, 0, 0, 0];
  let mh = ph;
  let kind = ph + 1;
  let r = -1;
  let a = p;
  let b = p + 1;
  let cind = 1;
  let ua = U[0];

  // Generous output sizing: every interior knot gains t multiplicity.
  const maxNewPts = Pw.length * (t + 1) + ph + 2;
  const Qw: number[][] = Array.from({ length: maxNewPts }, zero4);
  const Uh: number[] = new Array(maxNewPts + ph + 1).fill(0);

  Qw[0] = [...Pw[0]];
  for (let i = 0; i <= ph; i++) Uh[i] = ua;

  const bpts: number[][] = [];
  for (let i = 0; i <= p; i++) bpts.push([...Pw[i]]);
  const ebpts: number[][] = Array.from({ length: ph + 1 }, zero4);
  const Nextbpts: number[][] = Array.from({ length: Math.max(p - 1, 1) }, zero4);
  const alfs: number[] = new Array(Math.max(p - 1, 1)).fill(0);

  while (b < m) {
    const i0 = b;
    while (b < m && U[b] === U[b + 1]) b++;
    const mul = b - i0 + 1;
    mh += mul + t;
    const ub = U[b];
    const oldr = r;
    r = p - mul;
    const lbz = oldr > 0 ? Math.floor((oldr + 2) / 2) : 1;
    const rbz = r > 0 ? ph - Math.floor((r + 1) / 2) : ph;

    if (r > 0) {
      // Insert knot ub r times to expose the bezier segment.
      const numer = ub - ua;
      for (let k = p; k > mul; k--) alfs[k - mul - 1] = numer / (U[a + k] - ua);
      for (let j = 1; j <= r; j++) {
        const save = r - j;
        const s = mul + j;
        for (let k = p; k >= s; k--) {
          for (let d = 0; d < 4; d++) {
            bpts[k][d] = alfs[k - s] * bpts[k][d] + (1 - alfs[k - s]) * bpts[k - 1][d];
          }
        }
        Nextbpts[save] = [...bpts[p]];
      }
    }
    // Elevate the bezier segment.
    for (let i = lbz; i <= ph; i++) {
      ebpts[i] = zero4();
      const mpi = Math.min(p, i);
      for (let j = Math.max(0, i - t); j <= mpi; j++) {
        for (let d = 0; d < 4; d++) ebpts[i][d] += bezalfs[i][j] * bpts[j][d];
      }
    }
    if (oldr > 1) {
      // Remove the knot ua oldr-1 times (it was inserted to expose segments).
      let first = kind - 2;
      let last = kind;
      const den = ub - ua;
      const bet = (ub - Uh[kind - 1]) / den;
      for (let tr = 1; tr < oldr; tr++) {
        let i = first;
        let j = last;
        let kj = j - kind + 1;
        while (j - i > tr) {
          if (i < cind) {
            const alf = (ub - Uh[i]) / (ua - Uh[i]);
            for (let d = 0; d < 4; d++) Qw[i][d] = alf * Qw[i][d] + (1 - alf) * Qw[i - 1][d];
          }
          if (j >= lbz) {
            if (j - tr <= kind - ph + oldr) {
              const gam = (ub - Uh[j - tr]) / den;
              for (let d = 0; d < 4; d++) ebpts[kj][d] = gam * ebpts[kj][d] + (1 - gam) * ebpts[kj + 1][d];
            } else {
              for (let d = 0; d < 4; d++) ebpts[kj][d] = bet * ebpts[kj][d] + (1 - bet) * ebpts[kj + 1][d];
            }
          }
          i++; j--; kj--;
        }
        first--; last++;
      }
    }
    if (a !== p) {
      for (let i = 0; i < ph - oldr; i++) {
        Uh[kind] = ua;
        kind++;
      }
    }
    for (let j = lbz; j <= rbz; j++) {
      Qw[cind] = [...ebpts[j]];
      cind++;
    }
    if (b < m) {
      for (let j = 0; j < r; j++) bpts[j] = [...Nextbpts[j]];
      for (let j = r; j <= p; j++) bpts[j] = [...Pw[b - p + j]];
      a = b;
      b++;
      ua = ub;
    } else {
      for (let i = 0; i <= ph; i++) Uh[kind + i] = ub;
    }
  }

  const nh = mh - ph - 1; // last control index
  return { p: ph, U: Uh.slice(0, nh + ph + 2), Pw: Qw.slice(0, nh + 1) };
}

// --- Rebuild (global interpolation, A9.1) --------------------------------------

/** Chord-length parameters for a point list, normalized to [0, 1]. */
export function chordParams(Q: Vec3[]): number[] {
  const n = Q.length;
  const t = new Array<number>(n).fill(0);
  let total = 0;
  for (let i = 1; i < n; i++) total += Q[i].distanceTo(Q[i - 1]);
  if (total === 0) {
    for (let i = 0; i < n; i++) t[i] = i / (n - 1);
    return t;
  }
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Q[i].distanceTo(Q[i - 1]);
    t[i] = acc / total;
  }
  t[n - 1] = 1;
  return t;
}

/** Averaged knot vector (eq. 9.8) for interpolation params `t`, degree p. */
export function averagedKnots(t: number[], p: number): number[] {
  const n = t.length;
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let j = 1; j <= n - p - 1; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += t[i];
    U.push(s / p);
  }
  for (let i = 0; i <= p; i++) U.push(1);
  return U;
}

/** Dense Gaussian elimination with partial pivoting. A is n×n, b is n×dims.
 *  Returns x (n×dims). Throws on a singular system. */
export function solveDense(A: number[][], b: number[][]): number[][] {
  const n = A.length;
  const dims = b[0].length;
  const M = A.map((row, i) => [...row, ...b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('singular interpolation system');
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let cc = col; cc < n + dims; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  const x: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  for (let r = n - 1; r >= 0; r--) {
    for (let d = 0; d < dims; d++) {
      let s = M[r][n + d];
      for (let cc = r + 1; cc < n; cc++) s -= M[r][cc] * x[cc][d];
      x[r][d] = s / M[r][r];
    }
  }
  return x;
}

/**
 * Global curve interpolation (A9.1): a degree-p non-rational NURBS through the
 * points Q (in order), parameters by chord length, knots by averaging.
 * Q.length must be ≥ p+1.
 */
export function interpolateCurve(Q: Vec3[], p: number): NCurve {
  const n = Q.length;
  const deg = Math.min(p, n - 1);
  const t = chordParams(Q);
  const U = averagedKnots(t, deg);
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const span = findSpan(n, deg, t[i], U);
    const N = basisFuns(span, t[i], deg, U);
    for (let j = 0; j <= deg; j++) A[i][span - deg + j] = N[j];
  }
  const x = solveDense(A, Q.map((q) => [q.x, q.y, q.z]));
  return { p: deg, U, Pw: x.map((r) => [r[0], r[1], r[2], 1]) };
}

/**
 * Rebuild: re-approximate the curve with `pointCount` control points of degree
 * `degree` by sampling it densely and interpolating a fresh non-rational curve
 * through `pointCount` samples at uniform arc positions (the Alias/Rhino
 * "rebuild" semantic — shape approximated, weights reset to 1, knots averaged).
 */
export function rebuildCurve(c: NCurve, pointCount: number, degree: number): NCurve {
  const count = Math.max(degree + 1, pointCount);
  const [lo, hi] = curveDomain(c);
  // Dense arc-length table (parameter → cumulative length).
  const SAMPLES = Math.max(200, count * 8);
  const us: number[] = [];
  const pts: Vec3[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = lo + ((hi - lo) * i) / SAMPLES;
    us.push(u);
    pts.push(curvePoint(c, u));
  }
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = cum[cum.length - 1];
  // Pick `count` points at uniform arc length.
  const Q: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const target = total === 0 ? 0 : (total * k) / (count - 1);
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] < target) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg === 0 ? 0 : (target - cum[i]) / seg;
    const u = us[i] + (us[i + 1] - us[i]) * f;
    Q.push(curvePoint(c, u));
  }
  return interpolateCurve(Q, degree);
}

// --- Closest point --------------------------------------------------------------

/**
 * Closest point on the curve to P: coarse multi-start sampling + Newton
 * refinement on f(u) = (C−P)·C' (Piegl 6.1 style). Returns the parameter,
 * point, and distance.
 */
export function projectPointToCurve(c: NCurve, P: Vec3): { u: number; point: Vec3; dist: number } {
  const [lo, hi] = curveDomain(c);
  const COARSE = Math.max(32, c.Pw.length * 4);
  let bestU = lo;
  let bestD = Infinity;
  for (let i = 0; i <= COARSE; i++) {
    const u = lo + ((hi - lo) * i) / COARSE;
    const d = curvePoint(c, u).distanceTo(P);
    if (d < bestD) { bestD = d; bestU = u; }
  }
  let u = bestU;
  for (let it = 0; it < 25; it++) {
    const [C, C1, C2] = curveDerivs(c, u, 2);
    const r = C.sub(P);
    const f = r.dot(C1);
    const fp = C1.dot(C1) + r.dot(C2);
    if (Math.abs(fp) < 1e-14) break;
    let next = u - f / fp;
    if (next < lo) next = lo;
    if (next > hi) next = hi;
    if (Math.abs(next - u) < 1e-12) { u = next; break; }
    u = next;
  }
  const point = curvePoint(c, u);
  const dist = point.distanceTo(P);
  if (dist <= bestD) return { u, point, dist };
  return { u: bestU, point: curvePoint(c, bestU), dist: bestD };
}
