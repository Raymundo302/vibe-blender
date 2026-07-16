import { describe, expect, it } from 'vitest';
import { Vec3 } from '../math/vec3';
import { evaluateCurve } from '../curve/eval';
import type { CurveData } from '../scene/objectData';
import { curveDataDegree, fromCurveData, projectPointToCurve } from './curve';
import {
  curveKnotInfo,
  insertCurveKnotAt,
  largestSpanMid,
  rebuildCurveData,
  setCurveDegree,
} from './curveOps';

/** A 5-point open NURBS strip (the Shift+A NURBS preset shape). */
function openNurbs(resolution = 12): CurveData {
  return {
    kind: 'nurbs',
    cyclic: false,
    resolution,
    order: 4,
    points: [
      { co: [-2, 0, 0] },
      { co: [-1, 0.4, 0] },
      { co: [0, 0, 0] },
      { co: [1, 0.4, 0] },
      { co: [2, 0, 0] },
    ],
  };
}

/** A 4-point cyclic bezier circle (radius 1, XY plane). */
function cyclicCircle(resolution = 12): CurveData {
  const k = 0.5522847498;
  return {
    kind: 'bezier',
    cyclic: true,
    resolution,
    points: [
      { co: [1, 0, 0], hl: [1, -k, 0], hr: [1, k, 0] },
      { co: [0, 1, 0], hl: [k, 1, 0], hr: [-k, 1, 0] },
      { co: [-1, 0, 0], hl: [-1, k, 0], hr: [-1, -k, 0] },
      { co: [0, -1, 0], hl: [-k, -1, 0], hr: [k, -1, 0] },
    ],
  };
}

const poly = (d: CurveData): Vec3[] => evaluateCurve(d).map((p) => new Vec3(p.x, p.y, p.z));

/**
 * Worst closest-point distance from the evaluated polyline of `sampled` onto the
 * ANALYTIC curve of `target` — the true shape distance (exact NURBS ops leave it
 * ~0). Compared against the analytic curve, not the other coarse polyline, so
 * the chord-approximation error of a low-resolution polyline doesn't masquerade
 * as a shape change when the two curves sample at different parameters.
 */
function shapeDist(sampled: CurveData, target: CurveData): number {
  const c = fromCurveData(target)!;
  let worst = 0;
  for (const p of poly(sampled)) {
    const d = projectPointToCurve(c, p).dist;
    if (d > worst) worst = d;
  }
  return worst;
}

describe('setCurveDegree', () => {
  it('elevating an open NURBS preserves shape exactly and raises the payload order', () => {
    const src = openNurbs();
    const out = setCurveDegree(src, 4); // 3 → 4

    expect(curveDataDegree(out)).toBe(4);
    expect(out.order).toBe(5);
    expect(out.knots).toBeDefined();
    expect(out.points.length).toBeGreaterThan(src.points.length); // elevation adds points

    // Exact degree elevation → each curve's samples lie on the other's analytic curve.
    expect(shapeDist(out, src)).toBeLessThanOrEqual(1e-6);
    expect(shapeDist(src, out)).toBeLessThanOrEqual(1e-6);
  });

  it('preserves resolution', () => {
    const out = setCurveDegree(openNurbs(31), 5);
    expect(out.resolution).toBe(31);
  });

  it('clamps degree to 1..5 and to points-1', () => {
    const three = { ...openNurbs(), points: openNurbs().points.slice(0, 3) };
    // 3 points → max degree 2, even if 5 is requested.
    const out = setCurveDegree(three, 5);
    expect(curveDataDegree(out)).toBeLessThanOrEqual(2);
  });

  it('leaves a cyclic curve cyclic (closed) at the new degree', () => {
    const out = setCurveDegree(cyclicCircle(), 3);
    expect(out.cyclic).toBe(true);
    expect(out.kind).toBe('nurbs');
    const p = poly(out);
    expect(p[0].distanceTo(p[p.length - 1])).toBeLessThanOrEqual(1e-6); // still closed
  });
});

describe('insertCurveKnotAt / largestSpanMid', () => {
  it('inserts at the widest span, adding one point and preserving shape exactly', () => {
    const src = openNurbs();
    const u = largestSpanMid(src);
    expect(u).not.toBeNull();

    const out = insertCurveKnotAt(src, u!);
    expect(out.points.length).toBe(src.points.length + 1); // +1 control point
    expect(out.knots).toBeDefined(); // explicit knots present

    // Exact A5.1 insertion → identical analytic curve.
    expect(shapeDist(out, src)).toBeLessThanOrEqual(1e-6);
    expect(shapeDist(src, out)).toBeLessThanOrEqual(1e-6);
    expect(out.resolution).toBe(src.resolution); // resolution preserved
  });

  it('largestSpanMid is null for bezier and cyclic curves', () => {
    expect(largestSpanMid(cyclicCircle())).toBeNull();
    const bez: CurveData = {
      kind: 'bezier', cyclic: false, resolution: 12,
      points: [{ co: [-1, 0, 0] }, { co: [1, 0, 0] }],
    };
    expect(largestSpanMid(bez)).toBeNull();
  });

  it('insertCurveKnotAt returns cyclic/bezier input unchanged', () => {
    const cyc = cyclicCircle();
    const out = insertCurveKnotAt(cyc, 0.5);
    expect(out.points.length).toBe(cyc.points.length);
    expect(out.cyclic).toBe(true);
  });
});

describe('rebuildCurveData', () => {
  it('hits the requested control-point count and degree', () => {
    const out = rebuildCurveData(openNurbs(), 12, 3);
    expect(out.points.length).toBe(12);
    expect(curveDataDegree(out)).toBe(3);
    expect(out.cyclic).toBe(false);
    expect(out.resolution).toBe(12); // resolution preserved
  });

  it('clamps count to at least degree+1', () => {
    const out = rebuildCurveData(openNurbs(), 2, 3);
    expect(out.points.length).toBe(4); // degree 3 needs >= 4 points
  });

  it('keeps a cyclic curve cyclic and closed at the requested count', () => {
    const src = cyclicCircle(20);
    const out = rebuildCurveData(src, 10, 3);
    expect(out.cyclic).toBe(true);
    expect(out.kind).toBe('nurbs');
    expect(out.points.length).toBe(10);
    expect(out.resolution).toBe(20); // resolution preserved
    const p = poly(out);
    expect(p[0].distanceTo(p[p.length - 1])).toBeLessThanOrEqual(1e-6); // closed
    // The rebuilt ring still traces (roughly) the unit circle.
    for (const q of out.points) {
      const r = Math.hypot(q.co[0], q.co[1]);
      expect(Math.abs(r - 1)).toBeLessThan(0.1);
    }
  });
});

describe('curveKnotInfo', () => {
  it('reports knot + span counts for an open NURBS', () => {
    const info = curveKnotInfo(openNurbs());
    expect(info).not.toBeNull();
    // 5 points, order 4 → knot vector length 9, 2 spans (domain [0,2]).
    expect(info!.knots).toBe(9);
    expect(info!.spans).toBe(2);
  });

  it('span count grows by one after a knot insert', () => {
    const src = openNurbs();
    const before = curveKnotInfo(src)!.spans;
    const out = insertCurveKnotAt(src, largestSpanMid(src)!);
    expect(curveKnotInfo(out)!.spans).toBe(before + 1);
  });
});
