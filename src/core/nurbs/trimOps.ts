import type { CurveData, SurfaceData } from '../scene/objectData';
import { cloneCurveData, cloneSurfaceData } from '../scene/objectData';
import { curveDomain, curvePoint, fromCurveData } from './curve';

/**
 * Trim-loop payload operations (NB-CORE glue for batch C): converting a
 * curve-on-surface into a trim loop and back. Pure payload transforms — the
 * tessellator consumes `trims`; the surface driver re-tessellates on change.
 * UV convention: control points [u, v, 0] (see TrimLoop in objectData).
 */

/** Is a UV curve CLOSED (cyclic, or endpoints coincide within eps)? Trim loops
 *  must be closed; open curves can't partition the domain. */
export function isClosedUvCurve(curve: CurveData, eps = 1e-6): boolean {
  if (curve.cyclic) return curve.points.length >= 3;
  const c = fromCurveData(curve);
  if (!c) return false;
  const [lo, hi] = curveDomain(c);
  return curvePoint(c, lo).distanceTo(curvePoint(c, hi)) < eps;
}

/**
 * Promote the surface curve at `index` into a trim loop (hole = cut it out,
 * !hole = keep only its inside). The curve is REMOVED from surfaceCurves and
 * a deep copy appended to trims. Returns a new payload, or null when the
 * index is bad or the curve isn't closed.
 */
export function addTrimFromSurfaceCurve(data: SurfaceData, index: number, hole: boolean): SurfaceData | null {
  const sc = data.surfaceCurves?.[index];
  if (!sc || !isClosedUvCurve(sc.curve)) return null;
  const out = cloneSurfaceData(data);
  out.surfaceCurves!.splice(index, 1);
  if (out.surfaceCurves!.length === 0) delete out.surfaceCurves;
  const trims = out.trims ?? [];
  trims.push({ hole, curve: cloneCurveData(sc.curve) });
  out.trims = trims;
  return out;
}

/** Demote the trim at `index` back to a surface curve (undo-a-trim UX).
 *  Returns a new payload, or null on a bad index. */
export function removeTrim(data: SurfaceData, index: number, name = `Untrim.${index}`): SurfaceData | null {
  if (!data.trims || index < 0 || index >= data.trims.length) return null;
  const out = cloneSurfaceData(data);
  const [loop] = out.trims!.splice(index, 1);
  if (out.trims!.length === 0) delete out.trims;
  const scs = out.surfaceCurves ?? [];
  scs.push({ name, curve: loop.curve });
  out.surfaceCurves = scs;
  return out;
}

/** Drop every trim loop (curves are discarded, not recovered). */
export function clearTrims(data: SurfaceData): SurfaceData {
  const out = cloneSurfaceData(data);
  delete out.trims;
  return out;
}
