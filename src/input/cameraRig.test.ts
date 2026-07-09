import { describe, it, expect } from 'vitest';
import { configureRigFromCamera, cameraPoseFromRig, poseChanged } from './InputManager';
import { cameraTransformFromView } from '../tools/cameraToView';
import { OrbitCamera } from '../camera/OrbitCamera';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { Transform } from '../core/math/transform';

/**
 * Pure Lock-Camera-to-View rig math (P10-2). The rig is a private OrbitCamera
 * seeded from a camera pose; nav mutates the rig and the pose is written back.
 */

const EPS = 1e-6;

/** A roll-free camera pose (built the way cameraToView builds it → up = +Z). */
function poseLookingAt(eye: Vec3, target: Vec3): Transform {
  return cameraTransformFromView(eye, target.sub(eye).normalize(), Vec3.Z);
}

describe('configureRigFromCamera → cameraPoseFromRig round-trip', () => {
  it('reproduces the original camera pose within epsilon', () => {
    const cases: Array<[Vec3, Vec3]> = [
      [new Vec3(0, -6, 0), new Vec3(0, 0, 0)],
      [new Vec3(4, 8, 3), new Vec3(0, 0, 0)],
      [new Vec3(-5, -3, 2), new Vec3(0, 0, 0)],
      [new Vec3(2, 2, 6), new Vec3(1, -1, 0)],
    ];
    for (const [eye, target] of cases) {
      const pose = poseLookingAt(eye, target);
      const rig = new OrbitCamera();
      configureRigFromCamera(rig, pose);
      const out = cameraPoseFromRig(rig);
      expect(out.position.distanceTo(pose.position)).toBeLessThan(1e-5);
      // Rotation identity: same rotation ⇒ |quat dot| ≈ 1.
      const d = out.rotation.x * pose.rotation.x + out.rotation.y * pose.rotation.y +
        out.rotation.z * pose.rotation.z + out.rotation.w * pose.rotation.w;
      expect(Math.abs(d)).toBeGreaterThan(1 - 1e-5);
    }
  });

  it('clamps the orbit target distance into 1..50', () => {
    // Camera 100 units in front of the origin → target distance clamps to 50.
    const far = poseLookingAt(new Vec3(0, 0, 100), new Vec3(0, 0, 0));
    const rigFar = new OrbitCamera();
    configureRigFromCamera(rigFar, far);
    expect(rigFar.distance).toBeCloseTo(50, 6);

    // Camera 0.2 units in front → clamps up to the 1.0 floor.
    const near = poseLookingAt(new Vec3(0, 0, 0.2), new Vec3(0, 0, 0));
    const rigNear = new OrbitCamera();
    configureRigFromCamera(rigNear, near);
    expect(rigNear.distance).toBeCloseTo(1, 6);
  });

  it('adopts the preferred (viewport) distance for the pivot, still reproducing the pose', () => {
    // Camera aimed AWAY from the origin: the origin projection would clamp the
    // pivot to a too-close 1.0 (the old teleporty framing). With a preferred
    // viewport distance the rig pivots at THAT depth instead — no lurch on the
    // first orbit — while the reconstructed eye stays exactly on the camera.
    const pose = poseLookingAt(new Vec3(12, 0, 0), new Vec3(13, 0, 0)); // forward = +X
    const rig = new OrbitCamera();
    configureRigFromCamera(rig, pose, 8);
    expect(rig.distance).toBeCloseTo(8, 6);
    const out = cameraPoseFromRig(rig);
    expect(out.position.distanceTo(pose.position)).toBeLessThan(1e-5);

    // Non-finite / non-positive preferred distances fall back to the projection.
    const rigNaN = new OrbitCamera();
    configureRigFromCamera(rigNaN, pose, Number.NaN);
    expect(rigNaN.distance).toBeCloseTo(1, 6); // origin projection here clamps to 1
  });
});

describe('rig orbit keeps the target fixed', () => {
  it('orbiting mutates yaw/pitch but not the dolly target or distance', () => {
    const pose = poseLookingAt(new Vec3(3, 2, 7), new Vec3(0, 0, 0));
    const rig = new OrbitCamera();
    configureRigFromCamera(rig, pose);
    const target0 = rig.target;
    const dist0 = rig.distance;
    rig.orbit(40, 20);
    expect(rig.target.distanceTo(target0)).toBeLessThan(EPS);
    expect(Math.abs(rig.distance - dist0)).toBeLessThan(EPS);
    // The written-back pose actually moved (the camera flew).
    const moved = cameraPoseFromRig(rig);
    expect(poseChanged(pose, moved)).toBe(true);
  });
});

describe('poseChanged', () => {
  it('is false for an identical pose and true after a real move', () => {
    const a = poseLookingAt(new Vec3(0, 0, 6), new Vec3(0, 0, 0));
    const b = new Transform(a.position, a.rotation, a.scale);
    expect(poseChanged(a, b)).toBe(false);
    const moved = a.withPosition(a.position.add(new Vec3(0.01, 0, 0)));
    expect(poseChanged(a, moved)).toBe(true);
    // Negated quaternion is the SAME rotation — must not read as changed.
    const q = a.rotation;
    const negQuatSameRot = a.withRotation(new Quat(-q.x, -q.y, -q.z, -q.w));
    expect(poseChanged(a, negQuatSameRot)).toBe(false);
  });
});
