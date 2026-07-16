import { cloneSurfaceData, type SurfaceData } from '../scene/objectData';
import {
  fromSurfaceData,
  rebuildSurface,
  surfaceDomain,
  surfaceElevateU,
  surfaceElevateV,
  surfaceInsertKnotU,
  surfaceInsertKnotV,
  toSurfaceFields,
  type NSurface,
} from './surface';

/**
 * Pure SurfaceData payload transforms for the Surface properties tab (NB-A3).
 * No DOM, no GL — each takes and returns a SurfaceData, so the tab wraps them in
 * a SurfaceCommand.capture and the surface driver re-tessellates on the signature
 * change. Geometry comes from the NURBS ops in surface.ts (toSurfaceFields); the
 * display/tess/trim fields ride through untouched via cloneSurfaceData.
 *
 * Degree bounds: a degree p needs p+1 control points, so 1 ≤ p ≤ count-1, and
 * the toolset caps it at 5 (bi-quintic covers every practical patch).
 */

export const SURFACE_DEGREE_MAX = 5;

/** Clamp a degree into [1, min(count-1, 5)]. */
export function clampSurfaceDegree(degree: number, count: number): number {
  const hi = Math.min(count - 1, SURFACE_DEGREE_MAX);
  const d = Math.round(degree);
  if (!Number.isFinite(d)) return Math.max(1, Math.min(1, hi));
  return Math.max(1, Math.min(d, Math.max(1, hi)));
}

/** Replace only the geometry fields of `data` with an NSurface's, preserving
 *  tess / trims / surfaceCurves / showNet (deep-copied by cloneSurfaceData). */
function mergeGeometry(data: SurfaceData, s: NSurface): SurfaceData {
  const out = cloneSurfaceData(data);
  const g = toSurfaceFields(s);
  out.degreeU = g.degreeU;
  out.degreeV = g.degreeV;
  out.pointsU = g.pointsU;
  out.pointsV = g.pointsV;
  out.points = g.points;
  out.knotsU = g.knotsU;
  out.knotsV = g.knotsV;
  return out;
}

/**
 * Set the degree in one direction.
 *  - increase → EXACT degree elevation (surfaceElevateU/V): shape and weights
 *    are preserved, the control net grows.
 *  - decrease → rebuild at the CURRENT control-point counts with the new degree
 *    (surface re-approximation). This is APPROXIMATE and, because rebuildSurface
 *    is non-rational, RESETS all weights to 1.
 * Degree is clamped to [1, min(count-1, 5)]. Returns a fresh SurfaceData.
 */
export function setSurfaceDegree(data: SurfaceData, dir: 'u' | 'v', degree: number): SurfaceData {
  const s = fromSurfaceData(data);
  if (!s) return cloneSurfaceData(data);
  const count = dir === 'u' ? s.nu : s.nv;
  const current = dir === 'u' ? s.pu : s.pv;
  const target = clampSurfaceDegree(degree, count);
  if (target === current) return cloneSurfaceData(data);
  if (target > current) {
    const raised = dir === 'u' ? surfaceElevateU(s, target - current) : surfaceElevateV(s, target - current);
    return mergeGeometry(data, raised);
  }
  // Decrease: rebuild at the same net size, only this direction's degree changes.
  const pu = dir === 'u' ? target : s.pu;
  const pv = dir === 'v' ? target : s.pv;
  return mergeGeometry(data, rebuildSurface(s, s.nu, s.nv, pu, pv));
}

/**
 * Rebuild the surface with a fresh countU×countV net of degrees (degreeU,
 * degreeV) — a re-approximation of the current shape (weights reset to 1).
 * Passthrough to rebuildSurface; counts clamp to ≥2, degrees to [1, 5] (the
 * count guard lives in rebuildSurface, which bumps a count up to degree+1).
 */
export function rebuildSurfaceData(
  data: SurfaceData,
  pointsU: number,
  pointsV: number,
  degreeU: number,
  degreeV: number,
): SurfaceData {
  const s = fromSurfaceData(data);
  if (!s) return cloneSurfaceData(data);
  const nu = Math.max(2, Math.round(pointsU));
  const nv = Math.max(2, Math.round(pointsV));
  const pu = Math.max(1, Math.min(Math.round(degreeU), SURFACE_DEGREE_MAX));
  const pv = Math.max(1, Math.min(Math.round(degreeV), SURFACE_DEGREE_MAX));
  return mergeGeometry(data, rebuildSurface(s, nu, nv, pu, pv));
}

/**
 * Exact knot insertion at parameter `t` in one direction: adds one control row
 * (surfaceInsertKnotU/V) WITHOUT changing the shape. `t` is clamped into the
 * open parameter domain so the insert always lands on a real span. Returns a
 * fresh SurfaceData.
 */
export function insertSurfaceKnotAt(data: SurfaceData, dir: 'u' | 'v', t: number): SurfaceData {
  const s = fromSurfaceData(data);
  if (!s) return cloneSurfaceData(data);
  const [ul, uh, vl, vh] = surfaceDomain(s);
  const [lo, hi] = dir === 'u' ? [ul, uh] : [vl, vh];
  const span = hi - lo;
  // Nudge strictly inside the domain — inserting at an endpoint is a no-op that
  // only raises boundary multiplicity.
  const tt = Math.max(lo + span * 1e-6, Math.min(hi - span * 1e-6, t));
  const inserted = dir === 'u' ? surfaceInsertKnotU(s, tt) : surfaceInsertKnotV(s, tt);
  return mergeGeometry(data, inserted);
}
