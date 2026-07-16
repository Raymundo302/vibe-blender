import { Vec3 } from '../math/vec3';
import type { CurveData, SurfaceCurve } from '../scene/objectData';
import type { Scene, SceneObject } from '../scene/Scene';
import { evaluateCurve } from '../curve/eval';
import { interpolateCurve, rebuildCurve, toCurveData } from './curve';
import {
  fromSurfaceData,
  projectPointToSurface,
  surfaceDerivs,
  surfaceDomain,
  surfacePoint,
  type NSurface,
} from './surface';

/**
 * Curve projection onto NURBS surfaces (NB-C2). Two modes:
 *  - 'closest':   per source sample, the nearest surface point (Piegl closest-
 *                 point Newton). Naturally clamps into the domain.
 *  - 'direction': per source sample, solve S(u,v) = P + t·d (3 equations,
 *                 unknowns u,v,t) by Newton seeded from the closest-point
 *                 solution — a ray/surface intersection along `d`.
 *
 * The result is a light NURBS CurveData in the surface's UV parameter space
 * (z = 0, the SurfaceCurve/TrimLoop convention). Pure math — the scene-level
 * wrapper below moves the source curve through the world/local transforms and
 * names the output; nothing here mutates the scene.
 */

export interface ProjectCurveOpts {
  mode: 'closest' | 'direction';
  /**
   * Projection direction for 'direction' mode. In the CORE function
   * (projectCurveToSurfaceUV) this is in the SURFACE's local space; in the
   * scene WRAPPER (projectCurveObjectToSurface) it is WORLD space and gets
   * transformed to surface-local before the core runs. Ignored for 'closest'.
   */
  dir?: Vec3;
  /** Source-curve sample count (default 128). */
  samples?: number;
}

/** Max perpendicular offset of a directional hit from its ray before it counts
 *  as a MISS (the line clipped past the surface edge / diverged). */
const DIR_MISS_TOL = 1e-4;
/** Minimum hits for a usable projected segment. */
const MIN_HITS = 8;
/** UV thinning threshold (drop consecutive near-duplicate samples). */
const THIN_UV = 1e-6;

/**
 * Solve the 3×3 system [c0 | c1 | c2]·x = b by Cramer's rule (columns are the
 * three Jacobian vectors). Returns null on a (near-)singular system.
 */
function solve3(c0: Vec3, c1: Vec3, c2: Vec3, b: Vec3): Vec3 | null {
  const det = c0.dot(c1.cross(c2));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const x = b.dot(c1.cross(c2)) / det;
  const y = c0.dot(b.cross(c2)) / det;
  const z = c0.dot(c1.cross(b)) / det;
  return new Vec3(x, y, z);
}

/**
 * Resample a polyline to `n` points uniformly by arc length (monotone param
 * order preserved). Returns null for a degenerate (zero-length or <2-point)
 * input.
 */
function resamplePolyline(pts: Vec3[], n: number): Vec3[] | null {
  if (pts.length < 2 || n < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = cum[cum.length - 1];
  if (total < 1e-12) return null;
  const out: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < target) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg <= 1e-15 ? 0 : (target - cum[i]) / seg;
    out.push(pts[i].lerp(pts[i + 1], f));
  }
  return out;
}

/**
 * Directional projection of one point: solve S(u,v) = P + t·dhat by Newton,
 * seeded at (seedU, seedV) from the closest-point solution and clamped into the
 * domain. Returns the UV hit, or null when it diverges or the on-surface point
 * stays off the ray (edge clip / miss).
 */
function projectDirection(
  s: NSurface, P: Vec3, dhat: Vec3, seedU: number, seedV: number,
  dom: [number, number, number, number],
): { u: number; v: number } | null {
  const [ul, uh, vl, vh] = dom;
  let u = seedU, v = seedV;
  let t = surfacePoint(s, u, v).sub(P).dot(dhat);
  for (let it = 0; it < 30; it++) {
    const D = surfaceDerivs(s, u, v, 1);
    const S = D[0][0], Su = D[1][0], Sv = D[0][1];
    const F = S.sub(P).sub(dhat.scale(t)); // residual S − P − t·d
    if (F.length() < 1e-10) break;
    // Jacobian columns: ∂F/∂u = Su, ∂F/∂v = Sv, ∂F/∂t = −dhat. Solve J·Δ = −F.
    const delta = solve3(Su, Sv, dhat.negate(), F.negate());
    if (!delta || !Number.isFinite(delta.x) || !Number.isFinite(delta.y) || !Number.isFinite(delta.z)) return null;
    let un = u + delta.x, vn = v + delta.y;
    const tn = t + delta.z;
    if (un < ul) un = ul; if (un > uh) un = uh;
    if (vn < vl) vn = vl; if (vn > vh) vn = vh;
    const du = un - u, dv = vn - v, dt = tn - t;
    u = un; v = vn; t = tn;
    if (Math.abs(du) < 1e-12 && Math.abs(dv) < 1e-12 && Math.abs(dt) < 1e-12) break;
  }
  // Hit iff the on-surface point lies on the ray (perpendicular offset ~0). A
  // domain-clamped sample that clipped the edge fails this and counts as a miss.
  const S = surfacePoint(s, u, v);
  const r = S.sub(P);
  const perp = r.sub(dhat.scale(r.dot(dhat)));
  const pl = perp.length();
  if (!Number.isFinite(pl) || pl > DIR_MISS_TOL) return null;
  return { u, v };
}

/**
 * Project a 3D polyline (already in the surface's LOCAL space) onto `surface`,
 * returning a NURBS CurveData in UV parameter space (z = 0), or null when too
 * few samples land on the surface. See ProjectCurveOpts.
 */
export function projectCurveToSurfaceUV(
  points: Vec3[], surface: NSurface, opts: ProjectCurveOpts,
): CurveData | null {
  const n = opts.samples ?? 128;
  const samples = resamplePolyline(points, n);
  if (!samples) return null;
  const dom = surfaceDomain(surface);

  let dhat: Vec3 | null = null;
  if (opts.mode === 'direction') {
    if (!opts.dir || opts.dir.lengthSq() < 1e-18) return null;
    dhat = opts.dir.normalize();
  }

  // Per-sample UV (null = miss). Closest mode always hits (domain-clamped).
  const uv: (Vec3 | null)[] = samples.map((P) => {
    if (opts.mode === 'closest') {
      const r = projectPointToSurface(surface, P);
      return new Vec3(r.u, r.v, 0);
    }
    const seed = projectPointToSurface(surface, P);
    const hit = projectDirection(surface, P, dhat!, seed.u, seed.v, dom);
    return hit ? new Vec3(hit.u, hit.v, 0) : null;
  });

  // Longest contiguous run of hits (a projection that clips an edge keeps its
  // on-surface part).
  let bestStart = 0, bestLen = 0, curStart = 0, curLen = 0;
  for (let i = 0; i < uv.length; i++) {
    if (uv[i]) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curLen = 0;
    }
  }
  const hits = bestLen;
  if (hits < MIN_HITS) return null;
  const runUV = uv.slice(bestStart, bestStart + bestLen) as Vec3[];

  // Thin consecutive near-duplicates (in UV), keeping monotone param order.
  const thinned: Vec3[] = [];
  for (const p of runUV) {
    if (thinned.length === 0 || thinned[thinned.length - 1].distanceTo(p) >= THIN_UV) thinned.push(p);
  }
  if (thinned.length < 2) return null;

  // Fit a cubic through the UV samples, then rebuild to a light control net.
  const fit = interpolateCurve(thinned, 3);
  const count = Math.max(MIN_HITS, Math.ceil(hits / 8));
  const rebuilt = rebuildCurve(fit, count, 3);
  return toCurveData(rebuilt, 12);
}

/** Next free "Proj.NNN" name among a surface's existing curves-on-surface. */
function nextProjName(existing: readonly SurfaceCurve[] | undefined): string {
  let max = 0;
  for (const sc of existing ?? []) {
    const m = /^Proj\.(\d+)$/.exec(sc.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Proj.${String(max + 1).padStart(3, '0')}`;
}

/**
 * Scene-level wrapper (NB-C2): project a curve object onto a surface object,
 * returning a named SurfaceCurve in the surface's UV space — or null when the
 * projection produces nothing usable. Moves the curve's evaluated polyline
 * through curve-local → world → surface-local before the core projection;
 * `opts.dir` (direction mode) is WORLD space and is likewise mapped to
 * surface-local. DOES NOT mutate — the caller commits the returned SurfaceCurve
 * through SurfaceCommand.
 */
export function projectCurveObjectToSurface(
  scene: Scene, curveObj: SceneObject, surfObj: SceneObject, opts: ProjectCurveOpts,
): SurfaceCurve | null {
  if (!curveObj.curve || !surfObj.surface) return null;
  const surf = fromSurfaceData(surfObj.surface);
  if (!surf) return null;

  const localPoly = evaluateCurve(curveObj.curve);
  if (localPoly.length < 2) return null;

  const curveWorld = scene.worldMatrix(curveObj);
  const surfInv = scene.worldMatrix(surfObj).invert();
  const localToSurf = surfInv.mul(curveWorld); // curve-local → world → surf-local
  const pts = localPoly.map((p) => localToSurf.transformPoint(p));

  const coreOpts: ProjectCurveOpts = { mode: opts.mode, samples: opts.samples };
  if (opts.mode === 'direction' && opts.dir) coreOpts.dir = surfInv.transformDir(opts.dir);

  const cd = projectCurveToSurfaceUV(pts, surf, coreOpts);
  if (!cd) return null;
  return { name: nextProjName(surfObj.surface.surfaceCurves), curve: cd };
}
