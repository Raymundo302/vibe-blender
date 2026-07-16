import { describe, expect, it } from 'vitest';
import { Vec3 } from '../math/vec3';
import type { CurveData } from '../scene/objectData';
import { curveDerivs, curveDomain, curvePoint, fromCurveData, type NCurve } from './curve';
import { matchCurveEnd, type CurveEnd, type MatchLevel } from './matching';

// --- Test fixtures ------------------------------------------------------------

/** A degree-3 open NURBS through wavy 3D control points (non-planar → real
 *  torsion, so G3 exercises the binormal component of dK/ds). */
function cubic(points: [number, number, number][]): CurveData {
  return {
    kind: 'nurbs',
    cyclic: false,
    resolution: 12,
    order: 4,
    points: points.map((co) => ({ co })),
  };
}

const SRC = cubic([
  [0, 0, 0], [1, 1, 0.2], [2, -0.5, 0.5], [3, 0.8, -0.3],
  [4, -0.6, 0.4], [5, 0.5, 0.1], [6, 0, 0.6],
]);
const TARGET = cubic([
  [10, 0, 0], [11, 1.2, 0.3], [12, -0.4, 0.6], [13, 0.9, -0.2],
  [14, -0.5, 0.5], [15, 0.3, 0.2],
]);

// --- Geometric probes (independent of matching.ts internals) ------------------

function endU(c: NCurve, end: CurveEnd): number {
  const [lo, hi] = curveDomain(c);
  return end === 'end' ? hi : lo;
}

/** Unit tangent at an end. */
function tangent(cd: CurveData, end: CurveEnd): Vec3 {
  const c = fromCurveData(cd)!;
  const [, d1] = curveDerivs(c, endU(c, end), 1);
  return d1.scale(1 / d1.length());
}

/** Arc-length second derivative (curvature vector κN̂) at an end. */
function curvatureVec(cd: CurveData, end: CurveEnd): Vec3 {
  const c = fromCurveData(cd)!;
  const [, d1, d2] = curveDerivs(c, endU(c, end), 2);
  const s1 = d1.length();
  const t = d1.scale(1 / s1);
  const s2 = t.dot(d2);
  return d2.sub(t.scale(s2)).scale(1 / (s1 * s1));
}

/**
 * dK/ds in the FORWARD (increasing-u) direction at an end, by a 3-point one-
 * sided finite difference of the curvature vector mapped through ds = |C'|du
 * (the referee scheme). O(h²) so both sides land on the endpoint value.
 */
function dKdsForward(cd: CurveData, end: CurveEnd): Vec3 {
  const c = fromCurveData(cd)!;
  const [lo, hi] = curveDomain(c);
  const width = hi - lo;
  const h = 1e-3 * width;
  const u0 = end === 'end' ? hi : lo;
  const step = end === 'end' ? -h : h; // step INTO the domain
  const u1 = u0 + step, u2 = u0 + 2 * step;
  const kAt = (u: number): Vec3 => {
    const [, d1, d2] = curveDerivs(c, u, 2);
    const s1 = d1.length();
    const t = d1.scale(1 / s1);
    return d2.sub(t.scale(t.dot(d2))).scale(1 / (s1 * s1));
  };
  const K0 = kAt(u0), K1 = kAt(u1), K2 = kAt(u2);
  // One-sided 3-point derivative w.r.t. u at u0 (nodes u0, u0+step, u0+2step).
  const dKdu = K0.scale(-3).add(K1.scale(4)).sub(K2).scale(1 / (2 * step));
  const speed = curveDerivs(c, u0, 1)[1].length();
  return dKdu.scale(1 / speed); // ds = speed·du, forward (increasing u)
}

/** Signed flow factor ε = −σ_src·σ_tgt (see matching.ts). */
function eps(srcEnd: CurveEnd, targetEnd: CurveEnd): number {
  const s = srcEnd === 'end' ? 1 : -1;
  const t = targetEnd === 'end' ? 1 : -1;
  return -s * t;
}

// --- Tests --------------------------------------------------------------------

describe('matchCurveEnd — G0/G1/G2/G3 continuity (src end → target start)', () => {
  const srcEnd: CurveEnd = 'end';
  const tgtEnd: CurveEnd = 'start';
  const e = eps(srcEnd, tgtEnd);
  const qTarget = curvePoint(fromCurveData(TARGET)!, endU(fromCurveData(TARGET)!, tgtEnd));

  for (const level of [0, 1, 2, 3] as MatchLevel[]) {
    it(`level G${level} satisfies G0..G${level}`, () => {
      const out = matchCurveEnd(SRC, srcEnd, TARGET, tgtEnd, level);

      // G0 — endpoint coincident (holds at every level).
      const srcPt = curvePoint(fromCurveData(out)!, endU(fromCurveData(out)!, srcEnd));
      expect(srcPt.distanceTo(qTarget)).toBeLessThan(1e-9);

      if (level >= 1) {
        // G1 — flow-oriented unit tangents aligned.
        const ts = tangent(out, srcEnd);
        const tt = tangent(TARGET, tgtEnd).scale(e);
        expect(ts.dot(tt)).toBeGreaterThan(1 - 1e-9);
      }
      if (level >= 2) {
        // G2 — curvature vectors match (invariant, no ε).
        const ks = curvatureVec(out, srcEnd);
        const kt = curvatureVec(TARGET, tgtEnd);
        expect(ks.sub(kt).length()).toBeLessThan(1e-6 * Math.max(1, kt.length()));
      }
      if (level >= 3) {
        // G3 — dK/ds match under the same FD scheme, ε-oriented.
        const ws = dKdsForward(out, srcEnd);
        const wt = dKdsForward(TARGET, tgtEnd).scale(e);
        expect(ws.sub(wt).length()).toBeLessThan(1e-3 * Math.max(1, wt.length()));
      }

      // The far end (opposite the join) is unchanged — only near CPs moved.
      // Probe the region provably outside every modified control point's knot
      // support (u < U[n−level]); for this 7-CP cubic that is u < 1 (f < 0.25),
      // even after the G3 degree-elevation, so f ≤ 0.2 is safe at every level.
      const orig = fromCurveData(SRC)!;
      const res = fromCurveData(out)!;
      const [lo, hi] = curveDomain(orig);
      for (let f = 0; f <= 0.2; f += 0.05) {
        const u = lo + f * (hi - lo);
        expect(curvePoint(res, u).distanceTo(curvePoint(orig, u))).toBeLessThan(1e-9);
      }
    });
  }
});

describe('matchCurveEnd — every end-pair orientation flows across the join', () => {
  for (const srcEnd of ['start', 'end'] as CurveEnd[]) {
    for (const tgtEnd of ['start', 'end'] as CurveEnd[]) {
      it(`src '${srcEnd}' → target '${tgtEnd}' (G3)`, () => {
        const e = eps(srcEnd, tgtEnd);
        const out = matchCurveEnd(SRC, srcEnd, TARGET, tgtEnd, 3);
        const tc = fromCurveData(TARGET)!;
        const q = curvePoint(tc, endU(tc, tgtEnd));

        // G0
        expect(curvePoint(fromCurveData(out)!, endU(fromCurveData(out)!, srcEnd)).distanceTo(q))
          .toBeLessThan(1e-9);
        // G1 flow-oriented
        expect(tangent(out, srcEnd).dot(tangent(TARGET, tgtEnd).scale(e))).toBeGreaterThan(1 - 1e-9);
        // G2
        const kt = curvatureVec(TARGET, tgtEnd);
        expect(curvatureVec(out, srcEnd).sub(kt).length()).toBeLessThan(1e-6 * Math.max(1, kt.length()));
        // G3
        const wt = dKdsForward(TARGET, tgtEnd).scale(e);
        expect(dKdsForward(out, srcEnd).sub(wt).length()).toBeLessThan(1e-3 * Math.max(1, wt.length()));
      });
    }
  }
});

describe('matchCurveEnd — source variety', () => {
  it('matches a bezier source through the documented conversion', () => {
    const bez: CurveData = {
      kind: 'bezier',
      cyclic: false,
      resolution: 12,
      points: [
        { co: [0, 0, 0], hr: [0.5, 1, 0] },
        { co: [2, 0, 0], hl: [1.5, 1, 0], hr: [2.5, -1, 0] },
        { co: [4, 0, 0.5], hl: [3.5, -1, 0.5] },
      ],
    };
    const out = matchCurveEnd(bez, 'end', TARGET, 'start', 1);
    const q = curvePoint(fromCurveData(TARGET)!, curveDomain(fromCurveData(TARGET)!)[0]);
    // G0 + G1
    expect(curvePoint(fromCurveData(out)!, curveDomain(fromCurveData(out)!)[1]).distanceTo(q))
      .toBeLessThan(1e-9);
    const e = eps('end', 'start');
    expect(tangent(out, 'end').dot(tangent(TARGET, 'start').scale(e))).toBeGreaterThan(1 - 1e-9);
  });

  it('rebuilds a rational source to non-rational before matching (G2)', () => {
    // A weighted (rational) NURBS — the guard rebuilds it to unit weights.
    const rat: CurveData = {
      kind: 'nurbs',
      cyclic: false,
      resolution: 12,
      order: 4,
      points: [
        { co: [0, 0, 0] }, { co: [1, 1.5, 0], w: 2.5 }, { co: [2, -1, 0.3] },
        { co: [3, 1, 0], w: 0.4 }, { co: [4, -0.5, 0.5] }, { co: [5, 0.2, 0.2] },
      ],
    };
    const out = matchCurveEnd(rat, 'end', TARGET, 'start', 2);
    // Result is non-rational (all weights 1 / absent).
    expect(out.points.every((p) => (p.w ?? 1) === 1)).toBe(true);
    const q = curvePoint(fromCurveData(TARGET)!, curveDomain(fromCurveData(TARGET)!)[0]);
    expect(curvePoint(fromCurveData(out)!, curveDomain(fromCurveData(out)!)[1]).distanceTo(q))
      .toBeLessThan(1e-9);
    const kt = curvatureVec(TARGET, 'start');
    expect(curvatureVec(out, 'end').sub(kt).length()).toBeLessThan(1e-6 * Math.max(1, kt.length()));
  });

  it('degree-elevates a source below level+1 (quadratic source, G2)', () => {
    const quad: CurveData = {
      kind: 'nurbs', cyclic: false, resolution: 12, order: 3, // degree 2
      points: [[0, 0, 0], [1, 1, 0], [2, -0.5, 0.4], [3, 0.6, 0], [4, -0.3, 0.2]].map((co) => ({ co: co as [number, number, number] })),
    };
    const out = matchCurveEnd(quad, 'end', TARGET, 'start', 2);
    expect((out.order ?? 4) - 1).toBeGreaterThanOrEqual(3); // elevated to degree ≥ 3
    const kt = curvatureVec(TARGET, 'start');
    expect(curvatureVec(out, 'end').sub(kt).length()).toBeLessThan(1e-6 * Math.max(1, kt.length()));
  });

  it('does not mutate the input payloads', () => {
    const srcSnapshot = JSON.stringify(SRC);
    const tgtSnapshot = JSON.stringify(TARGET);
    matchCurveEnd(SRC, 'end', TARGET, 'start', 3);
    expect(JSON.stringify(SRC)).toBe(srcSnapshot);
    expect(JSON.stringify(TARGET)).toBe(tgtSnapshot);
  });
});
