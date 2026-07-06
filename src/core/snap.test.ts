import { describe, it, expect } from 'vitest';
import { Vec3 } from './math/vec3';
import { snapVec, snapActive, snapState, SNAP_STEP } from './snap';

describe('snapVec', () => {
  it('rounds each component down when below the halfway point', () => {
    expect(snapVec(new Vec3(1.24, 0, 0), 0.5).equalsApprox(new Vec3(1.0, 0, 0))).toBe(true);
  });
  it('rounds each component up when at/above the halfway point', () => {
    expect(snapVec(new Vec3(1.26, 0, 0), 0.5).equalsApprox(new Vec3(1.5, 0, 0))).toBe(true);
  });
  it('snaps all three components independently', () => {
    expect(snapVec(new Vec3(1.26, 2.74, -0.1), 0.5).equalsApprox(new Vec3(1.5, 2.5, 0))).toBe(true);
  });
  it('snaps negatives', () => {
    expect(snapVec(new Vec3(-1.24, -1.26, -2.8), 0.5).equalsApprox(new Vec3(-1.0, -1.5, -3.0))).toBe(true);
  });
  it('leaves exact multiples untouched', () => {
    expect(snapVec(new Vec3(2, -3, 0.5), 0.5).equalsApprox(new Vec3(2, -3, 0.5))).toBe(true);
  });
  it('is a no-op for a non-positive step', () => {
    const v = new Vec3(1.23, 4.56, -7.89);
    expect(snapVec(v, 0).equalsApprox(v)).toBe(true);
  });
  it('uses the default 0.5 SNAP_STEP', () => {
    expect(SNAP_STEP).toBe(0.5);
  });
});

describe('snapActive (Ctrl inverts the persistent state)', () => {
  it('is the XOR of the persistent state and the Ctrl-held flag', () => {
    const restore = snapState.enabled;
    try {
      snapState.enabled = false;
      expect(snapActive(false)).toBe(false); // off, no Ctrl → no snap
      expect(snapActive(true)).toBe(true); // off, Ctrl → snaps
      snapState.enabled = true;
      expect(snapActive(false)).toBe(true); // on, no Ctrl → snaps
      expect(snapActive(true)).toBe(false); // on, Ctrl → disabled
    } finally {
      snapState.enabled = restore;
    }
  });
});
