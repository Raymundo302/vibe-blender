import { describe, it, expect } from 'vitest';
import { Vec3 } from './vec3';
import { Mat4 } from './mat4';
import { Quat } from './quat';
import { Transform } from './transform';
import { rayFromNdc, rayPlane } from './ray';

function expectVec(v: Vec3, x: number, y: number, z: number, eps = 1e-5) {
  expect(Math.abs(v.x - x)).toBeLessThan(eps);
  expect(Math.abs(v.y - y)).toBeLessThan(eps);
  expect(Math.abs(v.z - z)).toBeLessThan(eps);
}

describe('Vec3', () => {
  it('cross follows right-hand rule', () => {
    expectVec(Vec3.X.cross(Vec3.Y), 0, 0, 1);
    expectVec(Vec3.Y.cross(Vec3.Z), 1, 0, 0);
  });
  it('normalize gives unit length', () => {
    expect(new Vec3(3, 4, 0).normalize().length()).toBeCloseTo(1);
  });
});

describe('Mat4', () => {
  it('identity leaves points unchanged', () => {
    expectVec(Mat4.identity().transformPoint(new Vec3(1, 2, 3)), 1, 2, 3);
  });
  it('translation moves points but not directions', () => {
    const t = Mat4.translation(new Vec3(5, 0, 0));
    expectVec(t.transformPoint(new Vec3(1, 2, 3)), 6, 2, 3);
    expectVec(t.transformDir(new Vec3(1, 2, 3)), 1, 2, 3);
  });
  it('mul applies right matrix first', () => {
    const t = Mat4.translation(new Vec3(10, 0, 0));
    const s = Mat4.scaling(new Vec3(2, 2, 2));
    // T*S: scale then translate → (1,0,0) → (2,0,0) → (12,0,0)
    expectVec(t.mul(s).transformPoint(new Vec3(1, 0, 0)), 12, 0, 0);
    // S*T: translate then scale → (1,0,0) → (11,0,0) → (22,0,0)
    expectVec(s.mul(t).transformPoint(new Vec3(1, 0, 0)), 22, 0, 0);
  });
  it('invert round-trips', () => {
    const m = Mat4.translation(new Vec3(1, 2, 3))
      .mul(Mat4.fromQuat(Quat.fromAxisAngle(Vec3.Y, 0.7)))
      .mul(Mat4.scaling(new Vec3(2, 3, 4)));
    const p = new Vec3(5, -2, 1);
    expectVec(m.invert().transformPoint(m.transformPoint(p)), p.x, p.y, p.z, 1e-4);
  });
  it('lookAt maps eye to origin looking down -Z', () => {
    const view = Mat4.lookAt(new Vec3(0, 0, 5), Vec3.ZERO, Vec3.Y);
    expectVec(view.transformPoint(new Vec3(0, 0, 5)), 0, 0, 0);
    expectVec(view.transformPoint(Vec3.ZERO), 0, 0, -5);
  });
  it('perspective maps near plane center to z=-1 NDC', () => {
    const proj = Mat4.perspective(Math.PI / 2, 1, 0.1, 100);
    const ndc = proj.transformPoint(new Vec3(0, 0, -0.1));
    expect(ndc.z).toBeCloseTo(-1, 4);
  });
});

describe('Quat', () => {
  it('90° around Y maps X to -Z', () => {
    const q = Quat.fromAxisAngle(Vec3.Y, Math.PI / 2);
    expectVec(q.rotate(Vec3.X), 0, 0, -1);
  });
  it('matches its matrix form', () => {
    const q = Quat.fromAxisAngle(new Vec3(1, 2, 3), 1.1);
    const v = new Vec3(4, -5, 6);
    const a = q.rotate(v);
    const b = Mat4.fromQuat(q).transformPoint(v);
    expectVec(a, b.x, b.y, b.z, 1e-4);
  });
});

describe('Transform', () => {
  it('composes T*R*S', () => {
    const tr = new Transform(
      new Vec3(10, 0, 0),
      Quat.fromAxisAngle(Vec3.Y, Math.PI / 2),
      new Vec3(2, 2, 2),
    );
    // (1,0,0) → scale (2,0,0) → rotY90 (0,0,-2) → translate (10,0,-2)
    expectVec(tr.matrix().transformPoint(Vec3.X), 10, 0, -2, 1e-4);
  });
});

describe('Ray', () => {
  it('center-screen ray points along camera forward', () => {
    const view = Mat4.lookAt(new Vec3(0, 0, 5), Vec3.ZERO, Vec3.Y);
    const proj = Mat4.perspective(Math.PI / 4, 1, 0.1, 100);
    const inv = proj.mul(view).invert();
    const ray = rayFromNdc(0, 0, inv);
    expectVec(ray.dir, 0, 0, -1, 1e-4);
  });
  it('rayPlane hits the ground where expected', () => {
    const hit = rayPlane(
      { origin: new Vec3(0, 5, 5), dir: new Vec3(0, -1, -1).normalize() },
      Vec3.ZERO,
      Vec3.Y,
    );
    expect(hit).not.toBeNull();
    expectVec(hit!, 0, 0, 0, 1e-4);
  });
});
