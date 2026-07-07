import { describe, it, expect } from 'vitest';
import { Vec3 } from '../core/math/vec3';
import { Mat4 } from '../core/math/mat4';
import { cameraViewMatrix } from '../render/passes/cameraFrustumPass';
import { cameraTransformFromView } from './cameraToView';

/** Minimal SceneObject-shaped stub carrying just the transform cameraViewMatrix reads. */
function stub(transform: ReturnType<typeof cameraTransformFromView>) {
  return { transform } as unknown as Parameters<typeof cameraViewMatrix>[0];
}

function expectMatClose(a: Mat4, b: Mat4): void {
  for (let i = 0; i < 16; i++) expect(a.m[i]).toBeCloseTo(b.m[i], 4);
}

describe('cameraTransformFromView', () => {
  it('round-trips through cameraViewMatrix to the equivalent lookAt view', () => {
    const eye = new Vec3(4, 3, 5);
    const target = new Vec3(0, 0, 0);
    const forward = target.sub(eye).normalize();
    const up = Vec3.Y;

    const t = cameraTransformFromView(eye, forward, up);
    const view = cameraViewMatrix(stub(t));
    const expected = Mat4.lookAt(eye, target, up);
    expectMatClose(view, expected);
  });

  it('places the camera at eye and aims -Z along forward', () => {
    const eye = new Vec3(-2, 6, 1.5);
    const forward = new Vec3(1, -1, 0.5).normalize();
    const t = cameraTransformFromView(eye, forward, Vec3.Y);

    // Position is the eye.
    expect(t.position.x).toBeCloseTo(eye.x, 5);
    expect(t.position.y).toBeCloseTo(eye.y, 5);
    expect(t.position.z).toBeCloseTo(eye.z, 5);

    // The camera's world view maps `eye` to the origin and `eye+forward` onto -Z.
    const view = cameraViewMatrix(stub(t));
    const atEye = view.transformPoint(eye);
    expect(atEye.length()).toBeCloseTo(0, 4);
    const ahead = view.transformPoint(eye.add(forward));
    expect(ahead.x).toBeCloseTo(0, 4);
    expect(ahead.y).toBeCloseTo(0, 4);
    expect(ahead.z).toBeCloseTo(-1, 4); // one unit down -Z
  });
});
