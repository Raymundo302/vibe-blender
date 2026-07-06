import { describe, it, expect } from 'vitest';
import { Vec3 } from '../core/math/vec3';
import { gizmoScreenScale, gizmoModelMatrix } from '../render/passes/gizmoPass';

/**
 * The gizmo's screen-scale + axis-placement math is pure (no GL), so it is the
 * one piece worth unit-testing: a wrong scale makes handles the wrong size and
 * a wrong rotation sends a handle down the wrong world axis.
 */
describe('gizmo screen scale', () => {
  it('grows linearly with camera distance', () => {
    const origin = Vec3.ZERO;
    const near = gizmoScreenScale(new Vec3(0, 0, 5), origin, Math.PI / 4);
    const far = gizmoScreenScale(new Vec3(0, 0, 10), origin, Math.PI / 4);
    expect(far).toBeCloseTo(2 * near, 6);
  });

  it('matches distance * tan(fovY/2) * K', () => {
    const eye = new Vec3(3, 4, 0); // distance 5 from origin
    const fovY = (50 * Math.PI) / 180;
    const s = gizmoScreenScale(eye, Vec3.ZERO, fovY);
    expect(s).toBeCloseTo(5 * Math.tan(fovY / 2) * 0.18, 6);
  });
});

describe('gizmo model matrix', () => {
  const origin = new Vec3(2, -1, 3);
  const scale = 1.5;
  // A unit-length point along local +X maps to `origin + worldAxis * scale`.
  const unitX = new Vec3(1, 0, 0);

  it('sends the X handle down world +X', () => {
    const p = gizmoModelMatrix(origin, scale, 'x').transformPoint(unitX);
    expect(p.equalsApprox(origin.add(Vec3.X.scale(scale)))).toBe(true);
  });

  it('sends the Y handle down world +Y', () => {
    const p = gizmoModelMatrix(origin, scale, 'y').transformPoint(unitX);
    expect(p.equalsApprox(origin.add(Vec3.Y.scale(scale)))).toBe(true);
  });

  it('sends the Z handle down world +Z', () => {
    const p = gizmoModelMatrix(origin, scale, 'z').transformPoint(unitX);
    expect(p.equalsApprox(origin.add(Vec3.Z.scale(scale)))).toBe(true);
  });
});
