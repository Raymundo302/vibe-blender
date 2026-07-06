import { describe, it, expect } from 'vitest';
import { Vec3 } from './vec3';
import { Quat } from './quat';

/** Compare two orientations by their action on a basis (quats double-cover). */
function expectSameRotation(a: Quat, b: Quat, eps = 1e-5): void {
  for (const v of [Vec3.X, Vec3.Y, Vec3.Z]) {
    const av = a.rotate(v);
    const bv = b.rotate(v);
    expect(av.equalsApprox(bv, eps)).toBe(true);
  }
}

describe('Quat euler XYZ', () => {
  it('fromEulerXYZ(0,0,0) is identity', () => {
    const q = Quat.fromEulerXYZ(0, 0, 0);
    expect(q.x).toBeCloseTo(0);
    expect(q.y).toBeCloseTo(0);
    expect(q.z).toBeCloseTo(0);
    expect(q.w).toBeCloseTo(1);
  });

  it('rotates X by (0,0,π/2) to Y', () => {
    const r = Quat.fromEulerXYZ(0, 0, Math.PI / 2).rotate(Vec3.X);
    expect(r.equalsApprox(Vec3.Y)).toBe(true);
  });

  it('fromEuler -> toEuler roundtrips across an angle grid (away from singularity)', () => {
    const angles = [-2.5, -1.2, -0.4, 0, 0.3, 0.9, 1.4, 2.0, 3.0];
    // Keep pitch (y) comfortably clear of ±π/2 so the decomposition is unique.
    const pitches = [-1.3, -0.7, 0, 0.5, 1.3];
    for (const x of angles) {
      for (const y of pitches) {
        for (const z of angles) {
          const q = Quat.fromEulerXYZ(x, y, z);
          const e = q.toEulerXYZ();
          const q2 = Quat.fromEulerXYZ(e.x, e.y, e.z);
          // The decomposed angles must reconstruct the same orientation.
          expectSameRotation(q, q2);
        }
      }
    }
  });

  it('handles the gimbal singularity (pitch = +π/2)', () => {
    const q = Quat.fromEulerXYZ(0.4, Math.PI / 2, 0.7);
    const e = q.toEulerXYZ();
    expect(e.y).toBeCloseTo(Math.PI / 2);
    // Reconstructing from the pinned angles yields the same rotation.
    expectSameRotation(Quat.fromEulerXYZ(e.x, e.y, e.z), q);
  });

  it('handles the gimbal singularity (pitch = -π/2)', () => {
    const q = Quat.fromEulerXYZ(-0.9, -Math.PI / 2, 0.2);
    const e = q.toEulerXYZ();
    expect(e.y).toBeCloseTo(-Math.PI / 2);
    expectSameRotation(Quat.fromEulerXYZ(e.x, e.y, e.z), q);
  });
});
