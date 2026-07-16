import { Vec3 } from '../math/vec3';
import type { SurfaceData } from '../scene/objectData';
import {
  basisFuns,
  binomial,
  clampToDomain,
  clampedUniformKnots,
  dersBasisFuns,
  findSpan,
  knotDomain,
  validKnots,
} from './basis';
import { elevateDegree, insertKnot, interpolateCurve, type NCurve } from './curve';

/**
 * Rational B-spline SURFACES (NB-CORE). Normalized homogeneous tensor-product
 * representation + the operations the toolset needs: exact evaluation,
 * derivatives (A4.4), normals, knot insertion / degree elevation per direction
 * (each U-row/V-column treated as a homogeneous curve — the alphas depend only
 * on the shared knot vector, so results stay a consistent grid), rebuild,
 * isoparm extraction, and closest-point (u,v) projection for the projection /
 * trimming tools. Pure math, no app imports beyond the payload type.
 *
 * GRID CONVENTION (used by tessellate.ts / SurfaceData / every consumer):
 * control point (iu, iv) lives at flat index iu*nv + iv — iu runs along the U
 * direction (0..nu-1), iv along V (0..nv-1).
 */

export interface NSurface {
  /** Degrees in U and V. */
  pu: number;
  pv: number;
  /** Control counts in U and V. */
  nu: number;
  nv: number;
  /** Knot vectors: U.length = nu+pu+1, V.length = nv+pv+1. */
  U: number[];
  V: number[];
  /** HOMOGENEOUS control points [x·w, y·w, z·w, w], flat index iu*nv + iv. */
  Pw: number[][];
}

export function cloneNSurface(s: NSurface): NSurface {
  return { pu: s.pu, pv: s.pv, nu: s.nu, nv: s.nv, U: [...s.U], V: [...s.V], Pw: s.Pw.map((q) => [...q]) };
}

/** The evaluable parameter domain: [uLo, uHi, vLo, vHi]. */
export function surfaceDomain(s: NSurface): [number, number, number, number] {
  const [ul, uh] = knotDomain(s.nu, s.pu, s.U);
  const [vl, vh] = knotDomain(s.nv, s.pv, s.V);
  return [ul, uh, vl, vh];
}

/**
 * Normalize a SurfaceData payload into an NSurface: explicit knots when
 * present+valid, else clamped-uniform. Degrees clamp to counts-1. Returns null
 * when the net is too small to evaluate (needs ≥ 2×2).
 */
export function fromSurfaceData(data: SurfaceData): NSurface | null {
  const nu = data.pointsU;
  const nv = data.pointsV;
  if (nu < 2 || nv < 2 || data.points.length !== nu * nv) return null;
  const pu = Math.max(1, Math.min(data.degreeU, nu - 1));
  const pv = Math.max(1, Math.min(data.degreeV, nv - 1));
  const Pw = data.points.map((q) => {
    const w = q.w ?? 1;
    return [q.co[0] * w, q.co[1] * w, q.co[2] * w, w];
  });
  const U = data.knotsU && validKnots(nu, pu, data.knotsU) ? [...data.knotsU] : clampedUniformKnots(nu, pu);
  const V = data.knotsV && validKnots(nv, pv, data.knotsV) ? [...data.knotsV] : clampedUniformKnots(nv, pv);
  return { pu, pv, nu, nv, U, V, Pw };
}

/** NSurface → the SurfaceData geometry fields (knots always explicit). The
 *  caller merges tess/display fields. */
export function toSurfaceFields(s: NSurface): Pick<SurfaceData, 'degreeU' | 'degreeV' | 'pointsU' | 'pointsV' | 'points' | 'knotsU' | 'knotsV'> {
  return {
    degreeU: s.pu,
    degreeV: s.pv,
    pointsU: s.nu,
    pointsV: s.nv,
    knotsU: [...s.U],
    knotsV: [...s.V],
    points: s.Pw.map((q) => {
      const w = q[3] === 0 ? 1 : q[3];
      const pt: { co: [number, number, number]; w?: number } = { co: [q[0] / w, q[1] / w, q[2] / w] };
      if (Math.abs(w - 1) > 1e-12) pt.w = w;
      return pt;
    }),
  };
}

/** Homogeneous surface point [X,Y,Z,W] at (u,v). */
export function surfacePointH(s: NSurface, u: number, v: number): number[] {
  const uu = clampToDomain(s.nu, s.pu, s.U, u);
  const vv = clampToDomain(s.nv, s.pv, s.V, v);
  const spanU = findSpan(s.nu, s.pu, uu, s.U);
  const spanV = findSpan(s.nv, s.pv, vv, s.V);
  const Nu = basisFuns(spanU, uu, s.pu, s.U);
  const Nv = basisFuns(spanV, vv, s.pv, s.V);
  const out = [0, 0, 0, 0];
  for (let i = 0; i <= s.pu; i++) {
    const iu = spanU - s.pu + i;
    for (let j = 0; j <= s.pv; j++) {
      const iv = spanV - s.pv + j;
      const P = s.Pw[iu * s.nv + iv];
      const b = Nu[i] * Nv[j];
      out[0] += b * P[0];
      out[1] += b * P[1];
      out[2] += b * P[2];
      out[3] += b * P[3];
    }
  }
  return out;
}

/** Euclidean surface point at (u,v). */
export function surfacePoint(s: NSurface, u: number, v: number): Vec3 {
  const h = surfacePointH(s, u, v);
  const w = h[3] === 0 ? 1 : h[3];
  return new Vec3(h[0] / w, h[1] / w, h[2] / w);
}

/**
 * Euclidean partial derivatives SKL[k][l] = ∂^(k+l) S / ∂u^k ∂v^l for
 * k+l ≤ d (A3.6 homogeneous + A4.4 rational correction). SKL[0][0] is the
 * point itself.
 */
export function surfaceDerivs(s: NSurface, u: number, v: number, d: number): Vec3[][] {
  const uu = clampToDomain(s.nu, s.pu, s.U, u);
  const vv = clampToDomain(s.nv, s.pv, s.V, v);
  const du = Math.min(d, s.pu);
  const dv = Math.min(d, s.pv);
  const spanU = findSpan(s.nu, s.pu, uu, s.U);
  const spanV = findSpan(s.nv, s.pv, vv, s.V);
  const Nu = dersBasisFuns(spanU, uu, s.pu, du, s.U);
  const Nv = dersBasisFuns(spanV, vv, s.pv, dv, s.V);

  // Homogeneous derivatives Aders (xyz) + wders.
  const Aders: number[][][] = Array.from({ length: d + 1 }, () =>
    Array.from({ length: d + 1 }, () => [0, 0, 0]));
  const wders: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  for (let k = 0; k <= du; k++) {
    for (let l = 0; l <= dv; l++) {
      if (k + l > d) continue;
      const a = Aders[k][l];
      for (let i = 0; i <= s.pu; i++) {
        const iu = spanU - s.pu + i;
        for (let j = 0; j <= s.pv; j++) {
          const iv = spanV - s.pv + j;
          const P = s.Pw[iu * s.nv + iv];
          const b = Nu[k][i] * Nv[l][j];
          a[0] += b * P[0];
          a[1] += b * P[1];
          a[2] += b * P[2];
          wders[k][l] += b * P[3];
        }
      }
    }
  }

  // Rational correction (A4.4).
  const SKL: Vec3[][] = Array.from({ length: d + 1 }, () =>
    Array.from({ length: d + 1 }, () => new Vec3()));
  const w00 = wders[0][0] === 0 ? 1 : wders[0][0];
  for (let k = 0; k <= d; k++) {
    for (let l = 0; l <= d - k; l++) {
      let vx = Aders[k][l][0], vy = Aders[k][l][1], vz = Aders[k][l][2];
      for (let j = 1; j <= l; j++) {
        const b = binomial(l, j) * wders[0][j];
        vx -= b * SKL[k][l - j].x; vy -= b * SKL[k][l - j].y; vz -= b * SKL[k][l - j].z;
      }
      for (let i = 1; i <= k; i++) {
        const bi = binomial(k, i);
        const bw = bi * wders[i][0];
        vx -= bw * SKL[k - i][l].x; vy -= bw * SKL[k - i][l].y; vz -= bw * SKL[k - i][l].z;
        let v2x = 0, v2y = 0, v2z = 0;
        for (let j = 1; j <= l; j++) {
          const b2 = binomial(l, j) * wders[i][j];
          v2x += b2 * SKL[k - i][l - j].x; v2y += b2 * SKL[k - i][l - j].y; v2z += b2 * SKL[k - i][l - j].z;
        }
        vx -= bi * v2x; vy -= bi * v2y; vz -= bi * v2z;
      }
      SKL[k][l] = new Vec3(vx / w00, vy / w00, vz / w00);
    }
  }
  return SKL;
}

/**
 * Unit surface normal Su×Sv at (u,v). Degenerate spots (sphere poles: one
 * partial vanishes) retry from a point nudged toward the domain interior, so
 * tessellation normals never go zero.
 */
export function surfaceNormal(s: NSurface, u: number, v: number): Vec3 {
  const [ul, uh, vl, vh] = surfaceDomain(s);
  let uu = u, vv = v;
  for (let attempt = 0; attempt < 4; attempt++) {
    const d = surfaceDerivs(s, uu, vv, 1);
    const n = d[1][0].cross(d[0][1]);
    if (n.lengthSq() > 1e-18) return n.normalize();
    // Nudge toward the interior and retry (poles / collapsed edges).
    const eps = (attempt + 1) * 1e-3;
    uu = Math.min(uh - (uh - ul) * eps, Math.max(ul + (uh - ul) * eps, uu + (uu < (ul + uh) / 2 ? 1 : -1) * (uh - ul) * eps));
    vv = Math.min(vh - (vh - vl) * eps, Math.max(vl + (vh - vl) * eps, vv + (vv < (vl + vh) / 2 ? 1 : -1) * (vh - vl) * eps));
  }
  return Vec3.Z;
}

// --- Direction-wise ops via the curve algorithms --------------------------------

/** Iterate the surface as nv COLUMN curves (fixed iv, varying iu): each is a
 *  homogeneous curve over knots U. */
function columns(s: NSurface): NCurve[] {
  const out: NCurve[] = [];
  for (let iv = 0; iv < s.nv; iv++) {
    const Pw: number[][] = [];
    for (let iu = 0; iu < s.nu; iu++) Pw.push([...s.Pw[iu * s.nv + iv]]);
    out.push({ p: s.pu, U: [...s.U], Pw });
  }
  return out;
}

/** Iterate the surface as nu ROW curves (fixed iu, varying iv) over knots V. */
function rows(s: NSurface): NCurve[] {
  const out: NCurve[] = [];
  for (let iu = 0; iu < s.nu; iu++) {
    const Pw: number[][] = [];
    for (let iv = 0; iv < s.nv; iv++) Pw.push([...s.Pw[iu * s.nv + iv]]);
    out.push({ p: s.pv, U: [...s.V], Pw });
  }
  return out;
}

/** Rebuild the grid from transformed COLUMN curves (all share knots/count). */
function fromColumns(cols: NCurve[], pv: number, V: number[]): NSurface {
  const nv = cols.length;
  const nu = cols[0].Pw.length;
  const Pw: number[][] = new Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) Pw[iu * nv + iv] = [...cols[iv].Pw[iu]];
  }
  return { pu: cols[0].p, pv, nu, nv, U: [...cols[0].U], V: [...V], Pw };
}

/** Rebuild the grid from transformed ROW curves (all share knots/count). */
function fromRows(rws: NCurve[], pu: number, U: number[]): NSurface {
  const nu = rws.length;
  const nv = rws[0].Pw.length;
  const Pw: number[][] = new Array(nu * nv);
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) Pw[iu * nv + iv] = [...rws[iu].Pw[iv]];
  }
  return { pu, pv: rws[0].p, nu, nv, U: [...U], V: [...rws[0].U], Pw };
}

/** Insert knot `u` `times` times in the U direction (exact shape). */
export function surfaceInsertKnotU(s: NSurface, u: number, times = 1): NSurface {
  return fromColumns(columns(s).map((c) => insertKnot(c, u, times)), s.pv, s.V);
}

/** Insert knot `v` `times` times in the V direction (exact shape). */
export function surfaceInsertKnotV(s: NSurface, v: number, times = 1): NSurface {
  return fromRows(rows(s).map((c) => insertKnot(c, v, times)), s.pu, s.U);
}

/** Raise the U degree by t (exact shape, A5.9 per column). */
export function surfaceElevateU(s: NSurface, t: number): NSurface {
  if (t <= 0) return cloneNSurface(s);
  return fromColumns(columns(s).map((c) => elevateDegree(c, t)), s.pv, s.V);
}

/** Raise the V degree by t (exact shape, A5.9 per row). */
export function surfaceElevateV(s: NSurface, t: number): NSurface {
  if (t <= 0) return cloneNSurface(s);
  return fromRows(rows(s).map((c) => elevateDegree(c, t)), s.pu, s.U);
}

/**
 * Rebuild: re-approximate with a countU×countV net of degrees (pu, pv) by
 * sampling a dense grid and tensor-interpolating (curve interpolation across
 * rows, then across the resulting control columns — the standard A9.4 scheme).
 * Weights reset to 1 (non-rational), knots averaged.
 */
export function rebuildSurface(s: NSurface, countU: number, countV: number, pu: number, pv: number): NSurface {
  const nu = Math.max(pu + 1, countU);
  const nv = Math.max(pv + 1, countV);
  const [ul, uh, vl, vh] = surfaceDomain(s);
  // Sample grid points at uniform parameters.
  const grid: Vec3[][] = [];
  for (let i = 0; i < nu; i++) {
    const u = ul + ((uh - ul) * i) / (nu - 1);
    const row: Vec3[] = [];
    for (let j = 0; j < nv; j++) {
      const v = vl + ((vh - vl) * j) / (nv - 1);
      row.push(surfacePoint(s, u, v));
    }
    grid.push(row);
  }
  // Interpolate each row (V direction): nu curves with nv control points.
  const rowCurves = grid.map((row) => interpolateCurve(row, pv));
  const V = rowCurves[0].U;
  // Interpolate control columns (U direction).
  const colCurves: NCurve[] = [];
  for (let j = 0; j < nv; j++) {
    const col: Vec3[] = rowCurves.map((rc) => {
      const q = rc.Pw[j];
      return new Vec3(q[0], q[1], q[2]); // non-rational: w = 1
    });
    colCurves.push(interpolateCurve(col, pu));
  }
  const U = colCurves[0].U;
  const Pw: number[][] = new Array(nu * nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const q = colCurves[j].Pw[i];
      Pw[i * nv + j] = [q[0], q[1], q[2], 1];
    }
  }
  return { pu: Math.min(pu, nu - 1), pv: Math.min(pv, nv - 1), nu, nv, U, V, Pw };
}

// --- Isoparametric curves --------------------------------------------------------

/**
 * Extract the isoparametric curve at a fixed parameter (exact): dir 'u' fixes
 * u=t (the curve runs along V), dir 'v' fixes v=t (runs along U). Implemented
 * by knot-inserting t to full multiplicity, where a control row lies exactly
 * on the surface.
 */
export function isoCurve(s: NSurface, dir: 'u' | 'v', t: number): NCurve {
  if (dir === 'u') {
    const [ul, uh] = knotDomain(s.nu, s.pu, s.U);
    const tt = Math.min(uh, Math.max(ul, t));
    // Domain ends: the boundary row is already a control row.
    if (tt <= ul + 1e-12 || tt >= uh - 1e-12) {
      const iu = tt <= ul + 1e-12 ? 0 : s.nu - 1;
      const Pw: number[][] = [];
      for (let iv = 0; iv < s.nv; iv++) Pw.push([...s.Pw[iu * s.nv + iv]]);
      return { p: s.pv, U: [...s.V], Pw };
    }
    let mult = 0;
    for (const k of s.U) if (Math.abs(k - tt) < 1e-12) mult++;
    const refined = mult >= s.pu ? s : surfaceInsertKnotU(s, tt, s.pu - mult);
    const span = findSpan(refined.nu, refined.pu, tt, refined.U);
    const iu = span - refined.pu;
    const Pw: number[][] = [];
    for (let iv = 0; iv < refined.nv; iv++) Pw.push([...refined.Pw[iu * refined.nv + iv]]);
    return { p: refined.pv, U: [...refined.V], Pw };
  }
  const [vl, vh] = knotDomain(s.nv, s.pv, s.V);
  const tt = Math.min(vh, Math.max(vl, t));
  if (tt <= vl + 1e-12 || tt >= vh - 1e-12) {
    const iv = tt <= vl + 1e-12 ? 0 : s.nv - 1;
    const Pw: number[][] = [];
    for (let iu = 0; iu < s.nu; iu++) Pw.push([...s.Pw[iu * s.nv + iv]]);
    return { p: s.pu, U: [...s.U], Pw };
  }
  let mult = 0;
  for (const k of s.V) if (Math.abs(k - tt) < 1e-12) mult++;
  const refined = mult >= s.pv ? s : surfaceInsertKnotV(s, tt, s.pv - mult);
  const span = findSpan(refined.nv, refined.pv, tt, refined.V);
  const iv = span - refined.pv;
  const Pw: number[][] = [];
  for (let iu = 0; iu < refined.nu; iu++) Pw.push([...refined.Pw[iu * refined.nv + iv]]);
  return { p: refined.pu, U: [...refined.U], Pw };
}

// --- Closest point ---------------------------------------------------------------

/**
 * Closest point on the surface to P: coarse grid multi-start + 2D Newton on
 * r·Su = r·Sv = 0 (Piegl 6.6), domain-clamped. The workhorse of projection
 * and trimming (NB-C2/C3).
 */
export function projectPointToSurface(s: NSurface, P: Vec3): { u: number; v: number; point: Vec3; dist: number } {
  const [ul, uh, vl, vh] = surfaceDomain(s);
  const GU = Math.max(16, s.nu * 3);
  const GV = Math.max(16, s.nv * 3);
  let bu = ul, bv = vl, bd = Infinity;
  for (let i = 0; i <= GU; i++) {
    const u = ul + ((uh - ul) * i) / GU;
    for (let j = 0; j <= GV; j++) {
      const v = vl + ((vh - vl) * j) / GV;
      const d = surfacePoint(s, u, v).distanceTo(P);
      if (d < bd) { bd = d; bu = u; bv = v; }
    }
  }
  let u = bu, v = bv;
  for (let it = 0; it < 30; it++) {
    const D = surfaceDerivs(s, u, v, 2);
    const S = D[0][0], Su = D[1][0], Sv = D[0][1];
    const Suu = D[2][0], Suv = D[1][1], Svv = D[0][2];
    const r = S.sub(P);
    const f = r.dot(Su);
    const g = r.dot(Sv);
    const J00 = Su.dot(Su) + r.dot(Suu);
    const J01 = Su.dot(Sv) + r.dot(Suv);
    const J11 = Sv.dot(Sv) + r.dot(Svv);
    const det = J00 * J11 - J01 * J01;
    if (Math.abs(det) < 1e-16) break;
    const du = (-f * J11 + g * J01) / det;
    const dv = (-g * J00 + f * J01) / det;
    let un = u + du, vn = v + dv;
    if (un < ul) un = ul; if (un > uh) un = uh;
    if (vn < vl) vn = vl; if (vn > vh) vn = vh;
    if (Math.abs(un - u) < 1e-12 && Math.abs(vn - v) < 1e-12) { u = un; v = vn; break; }
    u = un; v = vn;
  }
  const point = surfacePoint(s, u, v);
  const dist = point.distanceTo(P);
  if (dist <= bd) return { u, v, point, dist };
  return { u: bu, v: bv, point: surfacePoint(s, bu, bv), dist: bd };
}
