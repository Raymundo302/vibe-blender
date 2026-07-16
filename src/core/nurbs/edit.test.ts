import { describe, it, expect } from 'vitest';
import {
  defaultSurfaceData,
  defaultSurfaceTess,
  type SurfaceData,
  type SurfacePoint,
} from '../scene/objectData';
import { fromSurfaceData, surfacePoint } from './surface';
import { setSurfaceDegree, rebuildSurfaceData, insertSurfaceKnotAt } from './edit';

/** A rational, non-trivial 4×5 patch so shape-preservation tests exercise real
 *  weights and an asymmetric net (not just the symmetric default). */
function makePatch(): SurfaceData {
  const nu = 4, nv = 5;
  const points: SurfacePoint[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const x = i - 1.5;
      const y = j - 2;
      const z = Math.sin(i * 0.7) * Math.cos(j * 0.5);
      // A couple of interior weights ≠ 1 → genuinely rational.
      const w = (i === 1 && j === 2) ? 2.3 : (i === 2 && j === 1) ? 0.6 : 1;
      points.push(w === 1 ? { co: [x, y, z] } : { co: [x, y, z], w });
    }
  }
  return { degreeU: 2, degreeV: 3, pointsU: nu, pointsV: nv, points, tess: defaultSurfaceTess() };
}

/** Sample a surface on an m×m parameter grid (fractional domain positions). */
function sampleGrid(data: SurfaceData, m = 7): number[][] {
  const s = fromSurfaceData(data)!;
  const [ul, uh, vl, vh] = [s.U[s.pu], s.U[s.nu], s.V[s.pv], s.V[s.nv]];
  const out: number[][] = [];
  for (let i = 0; i <= m; i++) {
    const u = ul + ((uh - ul) * i) / m;
    for (let j = 0; j <= m; j++) {
      const v = vl + ((vh - vl) * j) / m;
      const p = surfacePoint(s, u, v);
      out.push([p.x, p.y, p.z]);
    }
  }
  return out;
}

function maxDiff(a: number[][], b: number[][]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i][k] - b[i][k]));
  }
  return d;
}

describe('setSurfaceDegree — elevation preserves shape exactly', () => {
  it('elevating U leaves the sampled surface identical and grows the net', () => {
    const data = makePatch();
    const before = sampleGrid(data);
    const raised = setSurfaceDegree(data, 'u', data.degreeU + 1);
    expect(raised.degreeU).toBe(data.degreeU + 1);
    expect(raised.pointsU).toBeGreaterThan(data.pointsU);
    expect(raised.pointsV).toBe(data.pointsV);
    expect(maxDiff(before, sampleGrid(raised))).toBeLessThanOrEqual(1e-9);
  });

  it('elevating V leaves the sampled surface identical and grows the net', () => {
    const data = makePatch();
    const before = sampleGrid(data);
    const raised = setSurfaceDegree(data, 'v', data.degreeV + 1);
    expect(raised.degreeV).toBe(data.degreeV + 1);
    expect(raised.pointsV).toBeGreaterThan(data.pointsV);
    expect(raised.pointsU).toBe(data.pointsU);
    expect(maxDiff(before, sampleGrid(raised))).toBeLessThanOrEqual(1e-9);
  });

  it('clamps degree to [1, min(count-1, 5)]', () => {
    const data = makePatch(); // nu=4 → max U degree 3
    expect(setSurfaceDegree(data, 'u', 99).degreeU).toBe(3);
    expect(setSurfaceDegree(data, 'u', 0).degreeU).toBe(1);
  });

  it('decrease rebuilds at the same net size with the lower degree', () => {
    const data = makePatch();
    const lowered = setSurfaceDegree(data, 'v', 2);
    expect(lowered.degreeV).toBe(2);
    expect(lowered.pointsU).toBe(data.pointsU);
    expect(lowered.pointsV).toBe(data.pointsV);
  });
});

describe('insertSurfaceKnotAt — exact span insert', () => {
  it('adds one U control row without changing the shape', () => {
    const data = makePatch();
    const before = sampleGrid(data);
    const s = fromSurfaceData(data)!;
    const mid = (s.U[s.pu] + s.U[s.nu]) / 2;
    const out = insertSurfaceKnotAt(data, 'u', mid);
    expect(out.pointsU).toBe(data.pointsU + 1);
    expect(out.pointsV).toBe(data.pointsV);
    expect(maxDiff(before, sampleGrid(out))).toBeLessThanOrEqual(1e-9);
  });

  it('adds one V control row without changing the shape', () => {
    const data = makePatch();
    const before = sampleGrid(data);
    const s = fromSurfaceData(data)!;
    const mid = (s.V[s.pv] + s.V[s.nv]) / 2;
    const out = insertSurfaceKnotAt(data, 'v', mid);
    expect(out.pointsV).toBe(data.pointsV + 1);
    expect(out.pointsU).toBe(data.pointsU);
    expect(maxDiff(before, sampleGrid(out))).toBeLessThanOrEqual(1e-9);
  });
});

describe('rebuildSurfaceData — produces the requested counts/degrees', () => {
  it('rebuilds to an exact net size and degrees', () => {
    const data = defaultSurfaceData();
    const out = rebuildSurfaceData(data, 10, 6, 3, 3);
    expect(out.pointsU).toBe(10);
    expect(out.pointsV).toBe(6);
    expect(out.degreeU).toBe(3);
    expect(out.degreeV).toBe(3);
    expect(out.points.length).toBe(10 * 6);
  });

  it('bumps a count up to degree+1 when too small', () => {
    const data = defaultSurfaceData();
    const out = rebuildSurfaceData(data, 3, 3, 3, 3);
    expect(out.pointsU).toBeGreaterThanOrEqual(4); // degree 3 needs ≥4 points
    expect(out.pointsV).toBeGreaterThanOrEqual(4);
  });
});

describe('non-geometry fields survive every transform', () => {
  const enrich = (d: SurfaceData): SurfaceData => ({
    ...d,
    tess: { mode: 'adaptive', segsU: 12, segsV: 5, tol: 0.007 },
    showNet: true,
    trims: [{ curve: { kind: 'nurbs', cyclic: true, resolution: 12, points: [
      { co: [0.1, 0.1, 0] }, { co: [0.9, 0.1, 0] }, { co: [0.9, 0.9, 0] }, { co: [0.1, 0.9, 0] },
    ] }, hole: false }],
    surfaceCurves: [{ name: 'seam', curve: { kind: 'bezier', cyclic: false, resolution: 8, points: [
      { co: [0, 0, 0] }, { co: [1, 1, 0] },
    ] } }],
  });

  const assertPreserved = (out: SurfaceData): void => {
    expect(out.tess).toEqual({ mode: 'adaptive', segsU: 12, segsV: 5, tol: 0.007 });
    expect(out.showNet).toBe(true);
    expect(out.trims?.length).toBe(1);
    expect(out.trims?.[0].hole).toBe(false);
    expect(out.surfaceCurves?.[0].name).toBe('seam');
  };

  it('setSurfaceDegree (elevate) preserves tess/trims/showNet', () => {
    assertPreserved(setSurfaceDegree(enrich(makePatch()), 'u', 3));
  });
  it('setSurfaceDegree (decrease) preserves tess/trims/showNet', () => {
    assertPreserved(setSurfaceDegree(enrich(makePatch()), 'v', 2));
  });
  it('insertSurfaceKnotAt preserves tess/trims/showNet', () => {
    assertPreserved(insertSurfaceKnotAt(enrich(makePatch()), 'u', 0.5));
  });
  it('rebuildSurfaceData preserves tess/trims/showNet', () => {
    assertPreserved(rebuildSurfaceData(enrich(defaultSurfaceData()), 8, 8, 3, 3));
  });
});
