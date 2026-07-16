import { describe, expect, it } from 'vitest';
import type { SurfaceData } from '../scene/objectData';
import { defaultSurfaceData } from '../scene/objectData';
import { fromSurfaceData, surfaceNormal, surfacePoint } from './surface';
import { tessellateSurface, tessStats } from './tessellate';

/**
 * NB-B3 adaptive-tessellation + tessStats tests. Complements nurbs.test.ts's
 * baseline tessellation coverage with the upgraded adaptive scheme (all-cross-
 * param probing + normal-deviation splitting) and the shared-grid tessStats.
 */

// --- Fixtures -------------------------------------------------------------------

/** A 7×7 bicubic patch flat in the XY plane except one tall, sharp control-point
 *  spike in the UPPER-RIGHT quadrant (control (5,5) of 0..6). Its parametric
 *  influence sits at u,v ≈ 3.67 on the [0,4]² domain (Greville of index 5). The
 *  old center-only probe scheme would miss an off-center feature like this. */
function offCenterBump(): SurfaceData {
  const N = 7;
  const points = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -1 + (2 * i) / (N - 1);
      const y = -1 + (2 * j) / (N - 1);
      const z = i === 5 && j === 5 ? 2 : 0;
      points.push({ co: [x, y, z] as [number, number, number] });
    }
  }
  return {
    degreeU: 3, degreeV: 3, pointsU: N, pointsV: N, points,
    tess: { mode: 'spans', segsU: 1, segsV: 1, tol: 0.05 },
  };
}

/** A thin S-fold strip: a degree-3 ripple along U (one full sine period), only
 *  2 control rows in V. World displacement is modest (chord deviation stays
 *  small) but the surface normal swings hard across the fold — the case
 *  normal-deviation splitting exists to catch. */
function sFold(amp: number): SurfaceData {
  const NU = 6, NV = 2;
  const points = [];
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const x = -1 + (2 * i) / (NU - 1);
      const y = -1 + (2 * j) / (NV - 1);
      const z = amp * Math.sin((i / (NU - 1)) * Math.PI * 2);
      points.push({ co: [x, y, z] as [number, number, number] });
    }
  }
  return {
    degreeU: 3, degreeV: 1, pointsU: NU, pointsV: NV, points,
    tess: { mode: 'spans', segsU: 1, segsV: 1, tol: 0.01 },
  };
}

/** A degenerate "cone" (top control row collapsed to the apex) — pole cells
 *  weld to triangles, exercising tessStats vs mesh agreement on non-quad output. */
function cone(): SurfaceData {
  const points = [];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1) points.push({ co: [0, 0, 1] as [number, number, number] });
      else points.push({ co: [j - 1, (j % 2) - 0.5, 0] as [number, number, number] });
    }
  }
  return {
    degreeU: 1, degreeV: 1, pointsU: 2, pointsV: 3, points,
    tess: { mode: 'spans', segsU: 1, segsV: 1, tol: 0.01 },
  };
}

/** Count grid cells per parameter quadrant (relative to the domain midpoints).
 *  For an untrimmed, non-degenerate surface every cell is a face, so this is the
 *  face distribution. Returns [lowU_lowV, lowU_hiV, hiU_lowV, hiU_hiV]. */
function quadrantCounts(us: number[], vs: number[], uMid: number, vMid: number): number[] {
  const c = [0, 0, 0, 0];
  for (let i = 0; i < us.length - 1; i++) {
    const uHi = (us[i] + us[i + 1]) / 2 > uMid ? 1 : 0;
    for (let j = 0; j < vs.length - 1; j++) {
      const vHi = (vs[j] + vs[j + 1]) / 2 > vMid ? 1 : 0;
      c[uHi * 2 + vHi]++;
    }
  }
  return c;
}

// --- Adaptive: off-center feature -----------------------------------------------

describe('adaptive tessellation — off-center probing', () => {
  it('a localized off-center bump refines beyond the floor and concentrates near the bump', () => {
    const spansData = offCenterBump();
    const floor = tessellateSurface(spansData);

    const adaptiveData: SurfaceData = {
      ...offCenterBump(),
      tess: { mode: 'adaptive', segsU: 1, segsV: 1, tol: 0.05 },
    };
    const fine = tessellateSurface(adaptiveData);

    // (1) Adaptive refines beyond the spans-floor mesh.
    expect(fine.mesh.faces.size).toBeGreaterThan(floor.mesh.faces.size);

    // (2) Refinement concentrates in the bump's (upper-right, u>2 & v>2) quadrant.
    const [lowlow, lowhi, hilow, hihi] = quadrantCounts(fine.us, fine.vs, 2, 2);
    expect(hihi).toBeGreaterThan(lowlow);
    expect(hihi).toBeGreaterThan(lowhi);
    expect(hihi).toBeGreaterThan(hilow);
  });
});

// --- Adaptive: normal-deviation splitting ----------------------------------------

describe('adaptive tessellation — normal-deviation splitting', () => {
  it('a high-curvature S-fold refines from normal deviation even when the chord test is satisfied', () => {
    const amp = 0.5;
    const spansData = sFold(amp);
    const s = fromSurfaceData(spansData)!;
    const floor = tessellateSurface(spansData);
    const us = floor.us, vs = floor.vs;

    // Measure the floor grid the way refineParams does: chord deviation at each
    // interval midpoint, and the normal-dot between interval ends — across ALL
    // cross probes (a conservative superset of the ≤9 the refiner samples).
    let maxChord = 0;
    let minDot = 1;
    // U intervals probed across every V.
    for (let i = 0; i < us.length - 1; i++) {
      const a = us[i], b = us[i + 1], mid = (a + b) / 2;
      for (const v of vs) {
        const chordMid = surfacePoint(s, a, v).add(surfacePoint(s, b, v)).scale(0.5);
        maxChord = Math.max(maxChord, chordMid.distanceTo(surfacePoint(s, mid, v)));
        minDot = Math.min(minDot, surfaceNormal(s, a, v).dot(surfaceNormal(s, b, v)));
      }
    }
    // V intervals probed across every U.
    for (let j = 0; j < vs.length - 1; j++) {
      const a = vs[j], b = vs[j + 1], mid = (a + b) / 2;
      for (const u of us) {
        const chordMid = surfacePoint(s, u, a).add(surfacePoint(s, u, b)).scale(0.5);
        maxChord = Math.max(maxChord, chordMid.distanceTo(surfacePoint(s, u, mid)));
        minDot = Math.min(minDot, surfaceNormal(s, u, a).dot(surfaceNormal(s, u, b)));
      }
    }

    // The normals swing past 15° somewhere (cos < 0.966) — the trigger exists...
    expect(minDot).toBeLessThan(0.966);

    // ...and we choose a tolerance strictly above every floor chord deviation, so
    // the chord test can NEVER fire (subdivision only shrinks chord deviation).
    const tol = maxChord * 4 + 1e-2;
    const adaptiveData: SurfaceData = { ...sFold(amp), tess: { mode: 'adaptive', segsU: 1, segsV: 1, tol } };
    const fine = tessellateSurface(adaptiveData);

    // Any refinement here must come from the normal-deviation test alone.
    expect(fine.mesh.faces.size).toBeGreaterThan(floor.mesh.faces.size);
  });
});

// --- tessStats agreement ---------------------------------------------------------

describe('tessStats matches tessellateSurface', () => {
  const cases: [string, SurfaceData][] = [
    ['default spans', defaultSurfaceData()],
    ['off-center adaptive', { ...offCenterBump(), tess: { mode: 'adaptive', segsU: 2, segsV: 2, tol: 0.02 } }],
    ['S-fold adaptive', { ...sFold(0.5), tess: { mode: 'adaptive', segsU: 1, segsV: 1, tol: 0.01 } }],
    ['degenerate cone', cone()],
  ];

  it.each(cases)('%s: stats == real mesh counts', (_label, data) => {
    const { mesh, us, vs } = tessellateSurface(data);
    const stats = tessStats(data);
    expect(stats.verts).toBe(mesh.verts.size);
    expect(stats.faces).toBe(mesh.faces.size);
    expect(stats.us).toBe(us.length);
    expect(stats.vs).toBe(vs.length);
  });

  it('matches under trim classification (fewer faces than untrimmed)', () => {
    const data = defaultSurfaceData();
    data.tess = { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 };
    data.trims = [{
      hole: true,
      curve: {
        kind: 'nurbs', cyclic: false, resolution: 4, order: 2,
        points: [
          { co: [0.3, 0.3, 0] }, { co: [0.7, 0.3, 0] }, { co: [0.7, 0.7, 0] },
          { co: [0.3, 0.7, 0] }, { co: [0.3, 0.3, 0] },
        ],
      },
    }];
    const { mesh } = tessellateSurface(data);
    const stats = tessStats(data);
    expect(stats.faces).toBe(mesh.faces.size);
    expect(stats.verts).toBe(mesh.verts.size);
  });

  it('degenerate payload reports all zeros', () => {
    const bad: SurfaceData = {
      degreeU: 1, degreeV: 1, pointsU: 1, pointsV: 1,
      points: [{ co: [0, 0, 0] }], tess: { mode: 'spans', segsU: 1, segsV: 1, tol: 0.01 },
    };
    expect(tessStats(bad)).toEqual({ verts: 0, faces: 0, us: 0, vs: 0 });
  });
});

// --- Determinism -----------------------------------------------------------------

describe('adaptive tessellation is deterministic', () => {
  it('two runs of the same adaptive payload produce identical grids', () => {
    const data: SurfaceData = {
      ...offCenterBump(),
      tess: { mode: 'adaptive', segsU: 2, segsV: 2, tol: 0.02 },
    };
    const a = tessellateSurface(data);
    const b = tessellateSurface(data);
    expect(a.us).toEqual(b.us);
    expect(a.vs).toEqual(b.vs);
    expect(a.mesh.faces.size).toBe(b.mesh.faces.size);
    expect(a.mesh.verts.size).toBe(b.mesh.verts.size);

    const posA = [...a.mesh.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
    const posB = [...b.mesh.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
    expect(posA).toEqual(posB);

    // tessStats agrees with itself across runs too.
    expect(tessStats(data)).toEqual(tessStats(data));
  });
});
