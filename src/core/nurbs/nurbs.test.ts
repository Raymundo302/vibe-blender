import { describe, expect, it } from 'vitest';
import { Vec3 } from '../math/vec3';
import type { CurveData, SurfaceData } from '../scene/objectData';
import { defaultSurfaceData, defaultSurfaceTess } from '../scene/objectData';
import {
  basisFuns,
  binomial,
  clampedUniformKnots,
  dersBasisFuns,
  findSpan,
  interiorKnots,
  knotDomain,
  validKnots,
} from './basis';
import {
  chordParams,
  curvatureAt,
  curveDerivs,
  curveDomain,
  curvePoint,
  elevateDegree,
  fromCurveData,
  insertKnot,
  interpolateCurve,
  projectPointToCurve,
  rebuildCurve,
  toCurveData,
  type NCurve,
} from './curve';
import {
  fromSurfaceData,
  isoCurve,
  projectPointToSurface,
  rebuildSurface,
  surfaceDerivs,
  surfaceDomain,
  surfaceElevateU,
  surfaceElevateV,
  surfaceInsertKnotU,
  surfaceInsertKnotV,
  surfaceNormal,
  surfacePoint,
  toSurfaceFields,
} from './surface';
import { pointInLoop, tessellateSurface, uvKept } from './tessellate';

// --- Fixtures -------------------------------------------------------------------

/** Exact rational unit circle in XY: 9 control points, degree 2 (the classic
 *  four-arc construction). Every point on it must sit at radius 1. */
function rationalCircle(): NCurve {
  const s = Math.SQRT1_2;
  const pts: [number, number, number][] = [
    [1, 0, 1], [1, 1, s], [0, 1, 1], [-1, 1, s], [-1, 0, 1],
    [-1, -1, s], [0, -1, 1], [1, -1, s], [1, 0, 1],
  ];
  return {
    p: 2,
    U: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
    Pw: pts.map(([x, y, w]) => [x * w, y * w, 0, w]),
  };
}

/** A wavy open cubic NURBS payload (order 4, 6 points, no explicit knots). */
function wavyData(): CurveData {
  return {
    kind: 'nurbs',
    cyclic: false,
    resolution: 12,
    order: 4,
    points: [
      { co: [-2, 0, 0] },
      { co: [-1.2, 0.9, 0.3] },
      { co: [-0.3, -0.4, 0.1] },
      { co: [0.6, 0.7, -0.2] },
      { co: [1.4, -0.5, 0.4] },
      { co: [2.2, 0.2, 0] },
    ],
  };
}

/** Sample a curve at k+1 uniform domain parameters. */
function sampleCurve(c: NCurve, k = 100): Vec3[] {
  const [lo, hi] = curveDomain(c);
  const out: Vec3[] = [];
  for (let i = 0; i <= k; i++) out.push(curvePoint(c, lo + ((hi - lo) * i) / k));
  return out;
}

function maxDist(a: Vec3[], b: Vec3[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i].distanceTo(b[i]));
  return m;
}

// --- basis ------------------------------------------------------------------------

describe('nurbs basis', () => {
  it('binomials', () => {
    expect(binomial(5, 2)).toBe(10);
    expect(binomial(7, 0)).toBe(1);
    expect(binomial(7, 7)).toBe(1);
    expect(binomial(4, 5)).toBe(0);
    expect(binomial(10, 3)).toBe(120);
  });

  it('clamped-uniform knots match the legacy convention', () => {
    expect(clampedUniformKnots(5, 3)).toEqual([0, 0, 0, 0, 1, 2, 2, 2, 2]);
    expect(validKnots(5, 3, clampedUniformKnots(5, 3))).toBe(true);
    expect(validKnots(5, 3, [0, 0, 0, 0, 1])).toBe(false); // wrong length
    expect(validKnots(4, 3, [0, 0, 0, 0, 1, 1, 1, 1])).toBe(true); // bezier segment
  });

  it('findSpan brackets the parameter', () => {
    const U = clampedUniformKnots(6, 3); // domain [0,3]
    for (const u of [0, 0.4, 1, 1.5, 2.9, 3]) {
      const s = findSpan(6, 3, u, U);
      expect(U[s]).toBeLessThanOrEqual(u === 3 ? 2.999 : u + 1e-12); // last span at end
      expect(u).toBeLessThanOrEqual(U[s + 1] + 1e-12);
    }
    expect(findSpan(6, 3, 3, U)).toBe(5); // n = count-1
  });

  it('partition of unity at many parameters', () => {
    const U = clampedUniformKnots(7, 3);
    const [lo, hi] = knotDomain(7, 3, U);
    for (let i = 0; i <= 50; i++) {
      const u = lo + ((hi - lo) * i) / 50;
      const span = findSpan(7, 3, u, U);
      const N = basisFuns(span, u, 3, U);
      const sum = N.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('basis derivatives match finite differences', () => {
    const U = clampedUniformKnots(6, 3);
    const u = 1.3;
    const h = 1e-6;
    const span = findSpan(6, 3, u, U);
    const ders = dersBasisFuns(span, u, 3, 2, U);
    const Np = basisFuns(findSpan(6, 3, u + h, U), u + h, 3, U);
    const Nm = basisFuns(findSpan(6, 3, u - h, U), u - h, 3, U);
    // Same span at u±h for an interior non-knot u.
    for (let j = 0; j <= 3; j++) {
      const fd = (Np[j] - Nm[j]) / (2 * h);
      expect(ders[1][j]).toBeCloseTo(fd, 5);
    }
    // 0th row IS the basis.
    const N = basisFuns(span, u, 3, U);
    for (let j = 0; j <= 3; j++) expect(ders[0][j]).toBeCloseTo(N[j], 12);
  });

  it('interiorKnots reports values and multiplicities', () => {
    const U = [0, 0, 0, 1, 2, 2, 3, 3, 3];
    expect(interiorKnots(6, 2, U)).toEqual([{ u: 1, mult: 1 }, { u: 2, mult: 2 }]);
  });
});

// --- curve ------------------------------------------------------------------------

describe('nurbs curve', () => {
  it('rational circle: every sample at radius 1', () => {
    const c = rationalCircle();
    for (const p of sampleCurve(c, 200)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 10);
      expect(p.z).toBeCloseTo(0, 12);
    }
  });

  it('derivatives match finite differences (rational)', () => {
    const c = rationalCircle();
    const h = 1e-6;
    for (const u of [0.1, 0.3, 0.62, 0.9]) {
      const [, d1, d2] = curveDerivs(c, u, 2);
      const pp = curvePoint(c, u + h);
      const pm = curvePoint(c, u - h);
      const p0 = curvePoint(c, u);
      const fd1 = pp.sub(pm).scale(1 / (2 * h));
      const fd2 = pp.add(pm).sub(p0.scale(2)).scale(1 / (h * h));
      expect(d1.distanceTo(fd1)).toBeLessThan(1e-4);
      expect(d2.distanceTo(fd2)).toBeLessThan(1e-2);
    }
  });

  it('circle curvature is exactly 1 everywhere', () => {
    const c = rationalCircle();
    for (const u of [0.05, 0.2, 0.45, 0.7, 0.95]) {
      const k = curvatureAt(c, u);
      expect(k.kappa).toBeCloseTo(1, 8);
      // Principal normal points toward the center (origin).
      const toCenter = k.point.scale(-1).normalize();
      expect(k.normal.dot(toCenter)).toBeCloseTo(1, 8);
    }
  });

  it('fromCurveData(bezier) reproduces the cubic evaluator', () => {
    const data: CurveData = {
      kind: 'bezier',
      cyclic: false,
      resolution: 12,
      points: [
        { co: [-1, 0, 0], hl: [-1.4, -0.6, 0], hr: [-0.4, 0.6, 0] },
        { co: [1, 0, 0], hl: [0.4, -0.6, 0], hr: [1.4, 0.6, 0] },
      ],
    };
    const c = fromCurveData(data)!;
    expect(c.p).toBe(3);
    // Span 0..1 must equal the closed-form cubic on (co0, hr0, hl1, co1).
    const p0 = new Vec3(-1, 0, 0), p1 = new Vec3(-0.4, 0.6, 0), p2 = new Vec3(0.4, -0.6, 0), p3 = new Vec3(1, 0, 0);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const u = 1 - t;
      const ref = new Vec3(
        u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        0,
      );
      expect(curvePoint(c, t).distanceTo(ref)).toBeLessThan(1e-12);
    }
  });

  it('knot insertion preserves shape exactly', () => {
    const c = fromCurveData(wavyData())!;
    const before = sampleCurve(c);
    let after = insertKnot(c, 1.2, 1);
    after = insertKnot(after, 0.5, 2);
    expect(after.Pw.length).toBe(c.Pw.length + 3);
    expect(maxDist(before, sampleCurve(after))).toBeLessThan(1e-10);
  });

  it('knot insertion on the rational circle preserves the radius', () => {
    const c = insertKnot(rationalCircle(), 0.4, 2);
    for (const p of sampleCurve(c, 100)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
  });

  it('degree elevation preserves shape exactly (+1 and +2)', () => {
    const c = fromCurveData(wavyData())!;
    const before = sampleCurve(c);
    const e1 = elevateDegree(c, 1);
    expect(e1.p).toBe(c.p + 1);
    expect(maxDist(before, sampleCurve(e1))).toBeLessThan(1e-9);
    const e2 = elevateDegree(c, 2);
    expect(e2.p).toBe(c.p + 2);
    expect(maxDist(before, sampleCurve(e2))).toBeLessThan(1e-9);
    // Interior multiplicities went up by t.
    const beforeInt = interiorKnots(c.Pw.length, c.p, c.U);
    const afterInt = interiorKnots(e1.Pw.length, e1.p, e1.U);
    expect(afterInt.length).toBe(beforeInt.length);
    for (let i = 0; i < beforeInt.length; i++) {
      expect(afterInt[i].mult).toBe(beforeInt[i].mult + 1);
    }
  });

  it('degree elevation preserves the rational circle', () => {
    const c = rationalCircle();
    const e = elevateDegree(c, 1);
    expect(e.p).toBe(3);
    for (const p of sampleCurve(e, 150)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
  });

  it('interpolation passes through its points', () => {
    const Q = [
      new Vec3(0, 0, 0), new Vec3(1, 1, 0), new Vec3(2, 0.5, 1), new Vec3(3, -0.5, 0.5), new Vec3(4, 0, 0),
    ];
    const c = interpolateCurve(Q, 3);
    const t = chordParams(Q);
    for (let i = 0; i < Q.length; i++) {
      expect(curvePoint(c, t[i]).distanceTo(Q[i])).toBeLessThan(1e-9);
    }
  });

  it('rebuild approximates the original within tolerance', () => {
    const c = fromCurveData(wavyData())!;
    const r = rebuildCurve(c, 12, 3);
    expect(r.Pw.length).toBe(12);
    expect(r.p).toBe(3);
    // Compare via closest-point distance (parameterizations differ).
    for (const p of sampleCurve(c, 40)) {
      expect(projectPointToCurve(r, p).dist).toBeLessThan(0.02);
    }
  });

  it('closest-point projection recovers on-curve points', () => {
    const c = fromCurveData(wavyData())!;
    for (const u of [0.3, 1.1, 2.4]) {
      const target = curvePoint(c, u);
      const hit = projectPointToCurve(c, target);
      expect(hit.dist).toBeLessThan(1e-8);
    }
    // Off-curve: circle projection lands on the radius-1 rim.
    const circle = rationalCircle();
    const hit = projectPointToCurve(circle, new Vec3(2, 2, 0));
    expect(Math.hypot(hit.point.x, hit.point.y)).toBeCloseTo(1, 8);
    expect(hit.point.x).toBeCloseTo(Math.SQRT1_2, 4);
    expect(hit.point.y).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('toCurveData round-trips through fromCurveData', () => {
    const c = insertKnot(fromCurveData(wavyData())!, 1.5, 1);
    const data = toCurveData(c);
    expect(data.knots).toBeDefined();
    const c2 = fromCurveData(data)!;
    expect(maxDist(sampleCurve(c), sampleCurve(c2))).toBeLessThan(1e-12);
  });

  it('explicit knots in CurveData are honored', () => {
    const data = wavyData();
    const base = fromCurveData(data)!;
    const inserted = insertKnot(base, 0.8, 1);
    const dataWithKnots = toCurveData(inserted);
    const back = fromCurveData(dataWithKnots)!;
    expect(back.U).toEqual(inserted.U);
  });
});

// --- surface -----------------------------------------------------------------------

/** A saddle-ish bicubic test surface (non-rational). */
function saddle(): SurfaceData {
  const d = defaultSurfaceData();
  // Reshape the bump into a saddle: corners up, mid-edges down.
  const pts = d.points;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = -1 + (2 * i) / 3;
      const y = -1 + (2 * j) / 3;
      pts[i * 4 + j] = { co: [x, y, 0.5 * (x * x - y * y)] };
    }
  }
  return d;
}

describe('nurbs surface', () => {
  it('bilinear patch evaluates exactly', () => {
    const data: SurfaceData = {
      degreeU: 1, degreeV: 1, pointsU: 2, pointsV: 2,
      points: [
        { co: [0, 0, 0] }, { co: [0, 2, 0] },
        { co: [2, 0, 0] }, { co: [2, 2, 4] },
      ],
      tess: defaultSurfaceTess(),
    };
    const s = fromSurfaceData(data)!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    expect(surfacePoint(s, ul, vl).distanceTo(new Vec3(0, 0, 0))).toBeLessThan(1e-12);
    expect(surfacePoint(s, uh, vh).distanceTo(new Vec3(2, 2, 4))).toBeLessThan(1e-12);
    const mid = surfacePoint(s, (ul + uh) / 2, (vl + vh) / 2);
    expect(mid.distanceTo(new Vec3(1, 1, 1))).toBeLessThan(1e-12);
  });

  it('surface derivatives match finite differences', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    const u = ul + (uh - ul) * 0.37;
    const v = vl + (vh - vl) * 0.61;
    const h = 1e-5;
    const D = surfaceDerivs(s, u, v, 2);
    const fdU = surfacePoint(s, u + h, v).sub(surfacePoint(s, u - h, v)).scale(1 / (2 * h));
    const fdV = surfacePoint(s, u, v + h).sub(surfacePoint(s, u, v - h)).scale(1 / (2 * h));
    expect(D[1][0].distanceTo(fdU)).toBeLessThan(1e-4);
    expect(D[0][1].distanceTo(fdV)).toBeLessThan(1e-4);
    // Mixed partial via 4-point stencil.
    const fUV = surfacePoint(s, u + h, v + h).sub(surfacePoint(s, u + h, v - h))
      .sub(surfacePoint(s, u - h, v + h)).add(surfacePoint(s, u - h, v - h)).scale(1 / (4 * h * h));
    expect(D[1][1].distanceTo(fUV)).toBeLessThan(1e-2);
  });

  it('normals are unit and consistent with derivatives', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    for (const [fu, fv] of [[0.2, 0.3], [0.5, 0.5], [0.8, 0.9]]) {
      const u = ul + (uh - ul) * fu;
      const v = vl + (vh - vl) * fv;
      const n = surfaceNormal(s, u, v);
      expect(n.length()).toBeCloseTo(1, 10);
      const D = surfaceDerivs(s, u, v, 1);
      expect(Math.abs(n.dot(D[1][0].normalize()))).toBeLessThan(1e-8);
      expect(Math.abs(n.dot(D[0][1].normalize()))).toBeLessThan(1e-8);
    }
  });

  it('knot insertion (U and V) preserves shape exactly', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    const su = surfaceInsertKnotU(s, (ul + uh) / 2, 1);
    const sv = surfaceInsertKnotV(su, vl + (vh - vl) * 0.3, 2);
    expect(su.nu).toBe(s.nu + 1);
    expect(sv.nv).toBe(s.nv + 2);
    for (const [fu, fv] of [[0, 0], [0.25, 0.75], [0.5, 0.5], [1, 1], [0.9, 0.1]]) {
      const u = ul + (uh - ul) * fu;
      const v = vl + (vh - vl) * fv;
      expect(surfacePoint(sv, u, v).distanceTo(surfacePoint(s, u, v))).toBeLessThan(1e-10);
    }
  });

  it('degree elevation (U and V) preserves shape exactly', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    const eu = surfaceElevateU(s, 1);
    const ev = surfaceElevateV(eu, 1);
    expect(eu.pu).toBe(s.pu + 1);
    expect(ev.pv).toBe(s.pv + 1);
    for (const [fu, fv] of [[0, 0], [0.33, 0.67], [0.5, 0.5], [1, 1]]) {
      const u = ul + (uh - ul) * fu;
      const v = vl + (vh - vl) * fv;
      expect(surfacePoint(ev, u, v).distanceTo(surfacePoint(s, u, v))).toBeLessThan(1e-9);
    }
  });

  it('rebuild approximates the original', () => {
    const s = fromSurfaceData(saddle())!;
    const r = rebuildSurface(s, 8, 8, 3, 3);
    expect(r.nu).toBe(8);
    expect(r.nv).toBe(8);
    const [ul, uh, vl, vh] = surfaceDomain(s);
    for (const [fu, fv] of [[0.1, 0.2], [0.5, 0.5], [0.85, 0.4]]) {
      const p = surfacePoint(s, ul + (uh - ul) * fu, vl + (vh - vl) * fv);
      expect(projectPointToSurface(r, p).dist).toBeLessThan(0.02);
    }
  });

  it('isoparm curves lie exactly on the surface', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    const u0 = ul + (uh - ul) * 0.4;
    const iso = isoCurve(s, 'u', u0);
    const [lo, hi] = curveDomain(iso);
    expect(lo).toBeCloseTo(vl, 12);
    expect(hi).toBeCloseTo(vh, 12);
    for (let i = 0; i <= 20; i++) {
      const v = vl + ((vh - vl) * i) / 20;
      expect(curvePoint(iso, v).distanceTo(surfacePoint(s, u0, v))).toBeLessThan(1e-10);
    }
    // Boundary isoparm (v = vh) too.
    const isoV = isoCurve(s, 'v', vh);
    for (let i = 0; i <= 10; i++) {
      const u = ul + ((uh - ul) * i) / 10;
      expect(curvePoint(isoV, u).distanceTo(surfacePoint(s, u, vh))).toBeLessThan(1e-10);
    }
  });

  it('closest-point projection recovers on-surface points', () => {
    const s = fromSurfaceData(saddle())!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    for (const [fu, fv] of [[0.2, 0.7], [0.55, 0.35]]) {
      const u = ul + (uh - ul) * fu;
      const v = vl + (vh - vl) * fv;
      const target = surfacePoint(s, u, v);
      const hit = projectPointToSurface(s, target);
      expect(hit.dist).toBeLessThan(1e-7);
    }
    // Interior point offset along its own normal must project straight back
    // (an off-surface probe whose closest point is NOT on the domain boundary —
    // boundary hits clamp and legitimately break orthogonality).
    const u0 = ul + (uh - ul) * 0.45;
    const v0 = vl + (vh - vl) * 0.55;
    const base = surfacePoint(s, u0, v0);
    const P = base.add(surfaceNormal(s, u0, v0).scale(0.3));
    const hit = projectPointToSurface(s, P);
    expect(hit.point.distanceTo(base)).toBeLessThan(1e-6);
    expect(hit.dist).toBeCloseTo(0.3, 6);
  });

  it('toSurfaceFields round-trips through fromSurfaceData', () => {
    const s = fromSurfaceData(saddle())!;
    const fields = toSurfaceFields(surfaceInsertKnotU(s, 0.5, 1));
    const data: SurfaceData = { ...fields, tess: defaultSurfaceTess() };
    const s2 = fromSurfaceData(data)!;
    const [ul, uh, vl, vh] = surfaceDomain(s);
    for (const [fu, fv] of [[0.1, 0.9], [0.6, 0.2]]) {
      const u = ul + (uh - ul) * fu;
      const v = vl + (vh - vl) * fv;
      expect(surfacePoint(s2, u, v).distanceTo(surfacePoint(s, u, v))).toBeLessThan(1e-10);
    }
  });
});

// --- tessellation ---------------------------------------------------------------

describe('surface tessellation', () => {
  it('spans mode produces the expected grid and UVs', () => {
    const data = saddle();
    data.tess = { mode: 'spans', segsU: 4, segsV: 4, tol: 0.01 };
    const { mesh, us, vs } = tessellateSurface(data);
    // 4×4 bicubic clamped-uniform: 1 span per direction → 5×5 verts, 16 quads.
    expect(us.length).toBe(5);
    expect(vs.length).toBe(5);
    expect(mesh.verts.size).toBe(25);
    expect(mesh.faces.size).toBe(16);
    // Every face has UVs in [0,1].
    for (const f of mesh.faces.values()) {
      const uvs = mesh.uvs.get(f.id)!;
      expect(uvs).toBeDefined();
      for (const [u, v] of uvs) {
        expect(u).toBeGreaterThanOrEqual(-1e-9);
        expect(u).toBeLessThanOrEqual(1 + 1e-9);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // Vert positions lie on the surface.
    const s = fromSurfaceData(data)!;
    for (const vert of mesh.verts.values()) {
      expect(projectPointToSurface(s, vert.co).dist).toBeLessThan(1e-9);
    }
  });

  it('adaptive mode refines curved regions beyond the floor', () => {
    const data = saddle();
    data.tess = { mode: 'spans', segsU: 2, segsV: 2, tol: 0.01 };
    const coarse = tessellateSurface(data);
    data.tess = { mode: 'adaptive', segsU: 2, segsV: 2, tol: 0.002 };
    const fine = tessellateSurface(data);
    expect(fine.mesh.faces.size).toBeGreaterThan(coarse.mesh.faces.size);
  });

  it('collapsed rows weld into triangles (degenerate pole cells)', () => {
    // A "cone": top row of control points all at the apex.
    const points = [];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 1) points.push({ co: [0, 0, 1] as [number, number, number] });
        else points.push({ co: [j - 1, (j % 2) - 0.5, 0] as [number, number, number] });
      }
    }
    const data: SurfaceData = {
      degreeU: 1, degreeV: 1, pointsU: 2, pointsV: 3, points,
      tess: { mode: 'spans', segsU: 1, segsV: 1, tol: 0.01 },
    };
    const { mesh } = tessellateSurface(data);
    // Apex welds: the top row is ONE vert; both cells are triangles.
    for (const f of mesh.faces.values()) expect(f.verts.length).toBe(3);
    expect(mesh.faces.size).toBe(2);
  });

  it('trim loops discard cells (v1 corner classification)', () => {
    const data = saddle();
    data.tess = { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 };
    const full = tessellateSurface(data).mesh.faces.size;
    // A centered UV hole loop (square, closed polyline as degree-1 nurbs).
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
    const trimmed = tessellateSurface(data).mesh.faces.size;
    expect(trimmed).toBeLessThan(full);
    expect(trimmed).toBeGreaterThan(0);
  });

  it('uv point-in-loop helpers', () => {
    const square: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(pointInLoop(0.5, 0.5, square)).toBe(true);
    expect(pointInLoop(1.5, 0.5, square)).toBe(false);
    expect(uvKept(0.5, 0.5, [{ pts: square, hole: true }])).toBe(false);
    expect(uvKept(2, 2, [{ pts: square, hole: true }])).toBe(true);
    expect(uvKept(0.5, 0.5, [{ pts: square, hole: false }])).toBe(true);
    expect(uvKept(2, 2, [{ pts: square, hole: false }])).toBe(false);
  });
});
