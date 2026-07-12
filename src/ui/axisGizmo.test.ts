import { describe, it, expect } from 'vitest';
import { axisToYawPitch } from './axisGizmo';
import { Vec3 } from '../core/math/vec3';

/** OrbitCamera's eye-side direction for a given yaw/pitch (see OrbitCamera.eye). */
function eyeDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return new Vec3(Math.sin(yaw) * cp, -Math.cos(yaw) * cp, Math.sin(pitch));
}

describe('axisToYawPitch', () => {
  const PITCH_LIMIT = Math.PI / 2 - 0.001;

  it('front (−Y) → yaw 0, pitch 0', () => {
    const { yaw, pitch } = axisToYawPitch(new Vec3(0, -1, 0), 1.23);
    expect(eyeDir(yaw, pitch).equalsApprox(new Vec3(0, -1, 0), 1e-6)).toBe(true);
  });

  it('right (+X) → looks from +X', () => {
    const { yaw, pitch } = axisToYawPitch(Vec3.X, 1.23);
    expect(eyeDir(yaw, pitch).equalsApprox(Vec3.X, 1e-6)).toBe(true);
    expect(pitch).toBeCloseTo(0);
  });

  it('left (−X), back (+Y) round-trip', () => {
    for (const a of [new Vec3(-1, 0, 0), new Vec3(0, 1, 0)]) {
      const { yaw, pitch } = axisToYawPitch(a, 0.4);
      expect(eyeDir(yaw, pitch).equalsApprox(a, 1e-6)).toBe(true);
    }
  });

  it('top (+Z) clamps pitch below the pole and keeps current yaw', () => {
    const { yaw, pitch } = axisToYawPitch(Vec3.Z, 0.77);
    expect(yaw).toBeCloseTo(0.77);
    expect(pitch).toBeCloseTo(PITCH_LIMIT);
    // Eye is essentially straight up.
    expect(eyeDir(yaw, pitch).z).toBeGreaterThan(0.999);
  });

  it('bottom (−Z) clamps to the lower limit', () => {
    const { pitch } = axisToYawPitch(new Vec3(0, 0, -1), 0);
    expect(pitch).toBeCloseTo(-PITCH_LIMIT);
  });
});
