import { describe, expect, it } from 'vitest';
import { cameraViewMatrix, cameraProjMatrix } from './cameraFrustumPass';
import { Scene } from '../../core/scene/Scene';
import { cameraFovY, defaultCamera } from '../../core/scene/objectData';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';
import { Quat } from '../../core/math/quat';

/** Make a camera object posed at `pos` with rotation `rot` (and optional scale). */
function posedCamera(pos: Vec3, rot = Quat.identity(), scale = Vec3.ONE) {
  const scene = new Scene();
  const cam = scene.addCamera('Camera');
  cam.transform = cam.transform.withPosition(pos).withRotation(rot).withScale(scale);
  return cam;
}

describe('cameraViewMatrix', () => {
  it('maps the camera position to the view-space origin', () => {
    const cam = posedCamera(new Vec3(0, 2, 5));
    const p = cameraViewMatrix(cam).transformPoint(new Vec3(0, 2, 5));
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });

  it('a camera at (0,0,5) looking down -Z sees the origin at (0,0,-5)', () => {
    const cam = posedCamera(new Vec3(0, 0, 5));
    const p = cameraViewMatrix(cam).transformPoint(Vec3.ZERO);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(-5);
  });

  it('rotated case: a camera at (5,0,0) yawed to face -X sees the origin on -Z', () => {
    // +90° about Y rotates local -Z onto world -X, so this camera looks at the origin.
    const cam = posedCamera(new Vec3(5, 0, 0), Quat.fromAxisAngle(Vec3.Y, Math.PI / 2));
    const p = cameraViewMatrix(cam).transformPoint(Vec3.ZERO);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(-5);
  });

  it('ignores camera scale (a scaled camera produces the same view)', () => {
    const plain = posedCamera(new Vec3(0, 2, 5), Quat.fromAxisAngle(Vec3.X, -0.3));
    const scaled = posedCamera(new Vec3(0, 2, 5), Quat.fromAxisAngle(Vec3.X, -0.3), new Vec3(3, 0.5, 2));
    const a = cameraViewMatrix(plain).m;
    const b = cameraViewMatrix(scaled).m;
    for (let i = 0; i < 16; i++) expect(b[i]).toBeCloseTo(a[i]);
  });
});

describe('cameraProjMatrix', () => {
  it('matches Mat4.perspective of cameraFovY for the same data', () => {
    const data = defaultCamera();
    const aspect = 16 / 9;
    const proj = cameraProjMatrix(data, aspect);
    const expected = Mat4.perspective(cameraFovY(data), aspect, data.near, data.far);
    for (let i = 0; i < 16; i++) expect(proj.m[i]).toBeCloseTo(expected.m[i]);
  });

  it('a longer focal length yields a narrower (larger f) projection', () => {
    const aspect = 16 / 9;
    const wide = cameraProjMatrix({ focalLength: 24, near: 0.1, far: 500 }, aspect);
    const tele = cameraProjMatrix({ focalLength: 85, near: 0.1, far: 500 }, aspect);
    // m[5] = 1/tan(fovY/2): a narrower FOV (longer lens) makes it larger.
    expect(tele.m[5]).toBeGreaterThan(wide.m[5]);
  });
});
