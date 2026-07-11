import { describe, expect, it } from 'vitest';
import { cameraViewMatrix, cameraProjMatrix, cameraFrameProjMatrix } from './cameraFrustumPass';
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

describe('cameraFrameProjMatrix (UR5-5 letterbox)', () => {
  const cam = defaultCamera();

  // The through-camera projection scales a view-space point to NDC. For a point
  // on the forward axis at distance d, its clip.x/clip.y are 0. To probe the
  // horizontal/vertical scale we project a point offset in view X or Y.
  const clip = (proj: Mat4, x: number, y: number, z: number) => {
    const m = proj.m;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return { x: cx / cw, y: cy / cw };
  };

  it('a square render on a wide canvas: the frame projection matches the wide-canvas perspective inside the frame', () => {
    // renderAspect 1 (square), canvas 2:1 (wide) → pillarbox. Inside the frame the
    // vertical FOV is preserved and horizontal is squeezed into the centered square:
    // this equals perspective(fovY, canvasAspect).
    const frame = cameraFrameProjMatrix(cam, 1000, 1000, 2000, 1000);
    const wideCanvas = cameraProjMatrix(cam, 2000 / 1000);
    const p = new Vec3(0.3, 0.4, -5);
    const a = clip(frame, p.x, p.y, p.z);
    const b = clip(wideCanvas, p.x, p.y, p.z);
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
  });

  it('is NOT the same as the naive canvas-aspect projection for a square render (it must use the render aspect)', () => {
    // The old (buggy) behavior used the CANVAS aspect for the projection AND drew
    // full-canvas; here the frame projection differs from a naive square-canvas
    // perspective because it letterboxes into a wide canvas.
    const frame = cameraFrameProjMatrix(cam, 1000, 1000, 2000, 1000);
    const naiveSquare = cameraProjMatrix(cam, 1); // pretends canvas is square
    const p = new Vec3(0.3, 0, -5);
    expect(clip(frame, p.x, p.y, p.z).x).not.toBeCloseTo(clip(naiveSquare, p.x, p.y, p.z).x, 3);
  });

  it('a wide render on a square canvas letterboxes (vertical FOV shrinks)', () => {
    // renderAspect 2 (wide), canvas 1:1 (square) → letterbox top/bottom. The
    // horizontal scale keeps the render-aspect perspective; vertical is squeezed.
    const frame = cameraFrameProjMatrix(cam, 2000, 1000, 1000, 1000);
    const renderProj = cameraProjMatrix(cam, 2); // render-aspect perspective
    const p = new Vec3(0.3, 0.4, -5);
    // Horizontal scale unchanged (sx = 1).
    expect(clip(frame, p.x, p.y, p.z).x).toBeCloseTo(clip(renderProj, p.x, p.y, p.z).x, 5);
    // Vertical squeezed by canvasAspect/renderAspect = 0.5.
    expect(clip(frame, p.x, p.y, p.z).y).toBeCloseTo(clip(renderProj, p.x, p.y, p.z).y * 0.5, 5);
  });

  it('an object centered on the forward axis stays centered regardless of aspect', () => {
    const frame = cameraFrameProjMatrix(cam, 1000, 1000, 2000, 1000);
    const c = clip(frame, 0, 0, -5);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });
});
