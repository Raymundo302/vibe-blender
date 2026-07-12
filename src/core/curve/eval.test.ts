import { describe, it, expect } from 'vitest';
import { Vec3 } from '../math/vec3';
import {
  evaluateCurve,
  curveLength,
  frames,
  cubicBezier,
  nurbsBasis,
  clampedKnots,
} from './eval';
import { bezierPreset, circlePreset, nurbsPreset } from './presets';
import type { CurveData } from '../scene/objectData';

describe('bezier evaluation', () => {
  it('passes through the anchor endpoints exactly', () => {
    const c: CurveData = {
      kind: 'bezier', cyclic: false, resolution: 12,
      points: [
        { co: [-1, 0, 0], hr: [-0.5, 1, 0] },
        { co: [1, 0, 0], hl: [0.5, -1, 0] },
      ],
    };
    const pts = evaluateCurve(c);
    expect(pts[0].equalsApprox(new Vec3(-1, 0, 0))).toBe(true);
    expect(pts[pts.length - 1].equalsApprox(new Vec3(1, 0, 0))).toBe(true);
  });

  it('midpoint matches the closed-form cubic Bezier', () => {
    const p0 = new Vec3(-1, 0, 0);
    const p1 = new Vec3(-0.5, 1, 0);
    const p2 = new Vec3(0.5, -1, 0);
    const p3 = new Vec3(1, 0, 0);
    const c: CurveData = {
      kind: 'bezier', cyclic: false, resolution: 12,
      points: [
        { co: [p0.x, p0.y, p0.z], hr: [p1.x, p1.y, p1.z] },
        { co: [p3.x, p3.y, p3.z], hl: [p2.x, p2.y, p2.z] },
      ],
    };
    const pts = evaluateCurve(c);
    // resolution 12, one span → index 6 is t = 0.5.
    const mid = pts[6];
    const expected = cubicBezier(p0, p1, p2, p3, 0.5);
    expect(mid.equalsApprox(expected, 1e-9)).toBe(true);
  });

  it('auto-mirrors an absent handle about the anchor', () => {
    // Point with only hl → its hr must be the mirror (straight-through tangent).
    const c: CurveData = {
      kind: 'bezier', cyclic: false, resolution: 4,
      points: [
        { co: [0, 0, 0], hl: [-1, -1, 0] }, // hr mirrors to (1, 1, 0)
        { co: [2, 0, 0], hl: [1, 1, 0] },
      ],
    };
    const straight: CurveData = {
      ...c,
      points: [
        { co: [0, 0, 0], hr: [1, 1, 0] },
        { co: [2, 0, 0], hl: [1, 1, 0] },
      ],
    };
    const a = evaluateCurve(c);
    const b = evaluateCurve(straight);
    for (let i = 0; i < a.length; i++) expect(a[i].equalsApprox(b[i], 1e-9)).toBe(true);
  });
});

describe('bezier circle preset', () => {
  it('samples stay near radius 1', () => {
    const pts = evaluateCurve(circlePreset());
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y);
      expect(Math.abs(r - 1)).toBeLessThan(0.01); // 4-point bezier circle error
      expect(Math.abs(p.z)).toBeLessThan(1e-9);
    }
  });

  it('cyclic closes the loop (last == first)', () => {
    const pts = evaluateCurve(circlePreset());
    expect(pts[0].equalsApprox(pts[pts.length - 1], 1e-9)).toBe(true);
  });
});

describe('nurbs evaluation', () => {
  it('clamped curve passes through the first and last control points', () => {
    const pts = evaluateCurve(nurbsPreset());
    expect(pts[0].equalsApprox(new Vec3(-2, 0, 0), 1e-6)).toBe(true);
    expect(pts[pts.length - 1].equalsApprox(new Vec3(2, 0, 0), 1e-6)).toBe(true);
  });

  it('rational quadratic weights make an exact quarter circle', () => {
    const w = Math.SQRT1_2; // cos(45°) → exact unit circle
    const c: CurveData = {
      kind: 'nurbs', cyclic: false, resolution: 20, order: 3,
      points: [
        { co: [1, 0, 0], w: 1 },
        { co: [1, 1, 0], w },
        { co: [0, 1, 0], w: 1 },
      ],
    };
    const pts = evaluateCurve(c);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y);
      expect(Math.abs(r - 1)).toBeLessThan(1e-6);
    }
  });

  it('partition of unity: basis functions sum to 1', () => {
    const n = 5;
    const p = 3;
    const knots = clampedKnots(n, p);
    for (let s = 0; s <= 20; s++) {
      const u = (n - p) * (s / 20);
      const N = nurbsBasis(n, p, knots, u);
      const sum = N.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    }
  });

  it('cyclic nurbs closes the loop', () => {
    const c: CurveData = {
      kind: 'nurbs', cyclic: true, resolution: 8, order: 3,
      points: [
        { co: [1, 0, 0] }, { co: [0, 1, 0] }, { co: [-1, 0, 0] }, { co: [0, -1, 0] },
      ],
    };
    const pts = evaluateCurve(c);
    expect(pts[0].equalsApprox(pts[pts.length - 1], 1e-6)).toBe(true);
  });
});

describe('curveLength', () => {
  it('measures a straight bezier as its endpoint distance', () => {
    const c: CurveData = {
      kind: 'bezier', cyclic: false, resolution: 16,
      points: [
        { co: [0, 0, 0], hr: [1, 0, 0] },
        { co: [3, 0, 0], hl: [2, 0, 0] },
      ],
    };
    expect(curveLength(evaluateCurve(c))).toBeCloseTo(3, 6);
  });
});

describe('parallel-transport frames', () => {
  it('no normal flips along a helix', () => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI * 6;
      pts.push(new Vec3(Math.cos(t), Math.sin(t), t * 0.15));
    }
    const fr = frames(pts);
    for (let i = 1; i < fr.length; i++) {
      // Rotation-minimizing frames never spin about the tangent → consecutive
      // normals stay closely aligned (no sudden flip).
      expect(fr[i].normal.dot(fr[i - 1].normal)).toBeGreaterThan(0.9);
      // Frame stays orthonormal.
      expect(Math.abs(fr[i].tangent.dot(fr[i].normal))).toBeLessThan(1e-6);
      expect(Math.abs(fr[i].normal.length() - 1)).toBeLessThan(1e-6);
    }
  });
});

describe('presets are well-formed', () => {
  it('every preset produces a non-empty polyline', () => {
    for (const c of [bezierPreset(), circlePreset(), nurbsPreset()]) {
      expect(evaluateCurve(c).length).toBeGreaterThan(2);
    }
  });
});
