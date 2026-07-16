import { describe, expect, it } from 'vitest';
import { Vec3 } from '../math/vec3';
import type { CurveData, SurfaceData } from '../scene/objectData';
import { surfPatch, surfSphere } from './primitives';
import { fromSurfaceData, surfaceDomain, surfacePoint, projectPointToSurface } from './surface';
import { fromCurveData, curveDomain, curvePoint } from './curve';
import { addTrimFromSurfaceCurve, removeTrim } from './trimOps';
import { evalSurfaceCurve3D, isoparmSurfaceCurve, extractSurfaceCurveToCurveData } from './cos';

/** Sample a standalone 3D CurveData at n+1 params → 3D points. */
function sampleCurve3D(cd: CurveData, n: number): Vec3[] {
  const c = fromCurveData(cd)!;
  const [lo, hi] = curveDomain(c);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(curvePoint(c, lo + ((hi - lo) * i) / n));
  return out;
}

describe('curves-on-surface (NB-C1)', () => {
  it('isoparm SurfaceCurve maps through evalSurfaceCurve3D onto exact surface samples', () => {
    const data = surfSphere(1);
    const s = fromSurfaceData(data)!;
    const [ul, uh, vl, vh] = surfaceDomain(s);

    // dir 'u': u = t fixed, v runs the domain.
    const t = ul + 0.37 * (uh - ul);
    const sc = isoparmSurfaceCurve(data, 'u', t);
    const segs = 96;
    const poly = evalSurfaceCurve3D(data, sc.curve, segs);
    expect(poly.length).toBe(segs + 1);
    for (let i = 0; i <= segs; i++) {
      const v = vl + ((vh - vl) * i) / segs;
      const truth = surfacePoint(s, t, v);
      expect(poly[i].distanceTo(truth)).toBeLessThanOrEqual(1e-9);
    }

    // dir 'v': v = t fixed, u runs the domain.
    const tv = vl + 0.62 * (vh - vl);
    const scv = isoparmSurfaceCurve(data, 'v', tv);
    const polyv = evalSurfaceCurve3D(data, scv.curve, segs);
    for (let i = 0; i <= segs; i++) {
      const u = ul + ((uh - ul) * i) / segs;
      const truth = surfacePoint(s, u, tv);
      expect(polyv[i].distanceTo(truth)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('extract of an exact isoparm equals the surface samples (≤ 1e-9)', () => {
    const data = surfSphere(1);
    const s = fromSurfaceData(data)!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    const t = ul + 0.42 * (uh - ul);
    const sc = isoparmSurfaceCurve(data, 'u', t);
    const extracted = extractSurfaceCurveToCurveData(data, sc.curve);
    // The extracted curve runs along V; sample it and compare to surfacePoint(s, t, v).
    const n = 80;
    const pts = sampleCurve3D(extracted, n);
    for (let i = 0; i <= n; i++) {
      const v = vl + ((vh - vl) * i) / n;
      const truth = surfacePoint(s, t, v);
      expect(pts[i].distanceTo(truth)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('extract of a general diagonal UV curve stays on the surface (< 1e-3)', () => {
    // A wavy patch so the diagonal genuinely leaves flat.
    const data = surfPatch(2);
    const s = fromSurfaceData(data)!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    // A degree-1 diagonal UV curve from (ul,vl) to (uh,vh) — neither const-u nor -v.
    const diag: CurveData = {
      kind: 'nurbs', cyclic: false, resolution: 12, order: 2,
      points: [{ co: [ul, vl, 0] }, { co: [uh, vh, 0] }],
    };
    const extracted = extractSurfaceCurveToCurveData(data, diag);
    // Every point of the extracted 3D curve must lie ON the surface.
    const pts = sampleCurve3D(extracted, 120);
    let maxDist = 0;
    for (const p of pts) {
      maxDist = Math.max(maxDist, projectPointToSurface(s, p).dist);
    }
    expect(maxDist).toBeLessThan(1e-3);
  });

  it('trims round-trip through add/remove (payload equality)', () => {
    // A closed UV circle surface-curve on a patch.
    const circle: CurveData = {
      kind: 'nurbs', cyclic: true, resolution: 12, order: 3,
      points: [
        { co: [0.3, 0.5, 0] }, { co: [0.5, 0.7, 0] },
        { co: [0.7, 0.5, 0] }, { co: [0.5, 0.3, 0] },
      ],
    };
    const base: SurfaceData = { ...surfPatch(2), surfaceCurves: [{ name: 'Loop', curve: circle }] };

    const trimmed = addTrimFromSurfaceCurve(base, 0, true)!;
    expect(trimmed).not.toBeNull();
    expect(trimmed.trims?.length).toBe(1);
    expect(trimmed.trims![0].hole).toBe(true);
    // The trim's UV curve is the same payload the surface curve carried.
    expect(trimmed.trims![0].curve).toEqual(circle);
    // The surface curve was consumed.
    expect(trimmed.surfaceCurves).toBeUndefined();

    const untrimmed = removeTrim(trimmed, 0, 'Loop')!;
    expect(untrimmed.trims).toBeUndefined();
    expect(untrimmed.surfaceCurves?.length).toBe(1);
    expect(untrimmed.surfaceCurves![0].curve).toEqual(circle);
  });
});
