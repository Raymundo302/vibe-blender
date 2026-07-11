import { describe, it, expect } from 'vitest';
import { Scene } from './Scene';
import { makeCube } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';
import { buildSnapshot } from '../../renderEngine/snapshot';
import { OrbitCamera } from '../../camera/OrbitCamera';

/** Extract the world-space forward (-Z), right (X) and up (Y) axes from a
 *  column-major camera world matrix. */
function basis(m: Float32Array) {
  return {
    right: new Vec3(m[0], m[1], m[2]),
    up: new Vec3(m[4], m[5], m[6]),
    forward: new Vec3(-m[8], -m[9], -m[10]),
    position: new Vec3(m[12], m[13], m[14]),
  };
}

describe('empty objects (UR5-7)', () => {
  it('addEmpty creates an empty-kind object with an empty mesh + displaySize', () => {
    const scene = new Scene();
    const e = scene.addEmpty('Empty');
    expect(e.kind).toBe('empty');
    expect(e.empty!.displaySize).toBe(1);
    expect(e.mesh.verts.size).toBe(0);
  });

  it('refuses edit mode on an empty', () => {
    const scene = new Scene();
    const e = scene.addEmpty('Empty');
    scene.selectOnly(e.id);
    expect(scene.enterEditMode()).toBe(false);
  });

  it('duplicate copies the empty payload independently', () => {
    const scene = new Scene();
    const e = scene.addEmpty('Empty');
    e.empty!.displaySize = 3;
    const dup = scene.duplicate(e, 'Empty.001');
    expect(dup.kind).toBe('empty');
    expect(dup.empty!.displaySize).toBe(3);
    dup.empty!.displaySize = 7;
    expect(e.empty!.displaySize).toBe(3); // no shared reference
  });
});

describe('camera Look At basis (UR5-7)', () => {
  it('aims -Z at the target world origin, up = world +Z', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new Vec3(0, 0, 0));
    const target = scene.addEmpty('Target');
    target.transform = target.transform.withPosition(new Vec3(5, 0, 0)); // +X of the camera
    cam.camera!.lookAtId = target.id;

    const b = basis(scene.cameraWorldMatrix(cam).m);
    // Forward points toward the target (+X).
    expect(b.forward.x).toBeCloseTo(1, 5);
    expect(b.forward.y).toBeCloseTo(0, 5);
    expect(b.forward.z).toBeCloseTo(0, 5);
    // Up biased toward world +Z.
    expect(b.up.z).toBeGreaterThan(0.9);
    // Orthonormal basis.
    expect(b.right.dot(b.up)).toBeCloseTo(0, 5);
    expect(b.forward.dot(b.up)).toBeCloseTo(0, 5);
    expect(b.right.length()).toBeCloseTo(1, 5);
  });

  it('stays defined (finite, orthonormal) when aiming straight down — degenerate up', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new Vec3(0, 0, 10));
    const target = scene.addEmpty('Target');
    target.transform = target.transform.withPosition(new Vec3(0, 0, 0)); // straight down -Z world
    cam.camera!.lookAtId = target.id;

    const b = basis(scene.cameraWorldMatrix(cam).m);
    expect(b.forward.z).toBeCloseTo(-1, 5); // looking down
    for (const v of [b.right, b.up, b.forward]) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      expect(v.length()).toBeCloseTo(1, 5); // no NaN collapse
    }
    expect(b.right.dot(b.up)).toBeCloseTo(0, 5);
  });

  it('position comes from the transform, unaffected by the aim', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new Vec3(2, 3, 4));
    const target = scene.addEmpty('Target');
    target.transform = target.transform.withPosition(new Vec3(-1, -1, -1));
    cam.camera!.lookAtId = target.id;
    const b = basis(scene.cameraWorldMatrix(cam).m);
    expect(b.position.x).toBeCloseTo(2, 5);
    expect(b.position.y).toBeCloseTo(3, 5);
    expect(b.position.z).toBeCloseTo(4, 5);
  });

  it('falls back to the camera rotation when the target is deleted', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Camera');
    const target = scene.addEmpty('Target');
    cam.camera!.lookAtId = target.id;
    scene.remove(target.id);
    // Defensive: stale ref → no target, uses own (identity) rotation → forward -Z.
    expect(scene.cameraLookAtTarget(cam)).toBeNull();
    const b = basis(scene.cameraWorldMatrix(cam).m);
    expect(b.forward.z).toBeCloseTo(-1, 5);
  });

  it('ignores a lookAt at a descendant of the camera (cycle guard) + flags it', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Camera');
    const child = scene.addEmpty('Child');
    scene.setParentKeepTransform(child, cam); // child is under the camera
    cam.camera!.lookAtId = child.id;
    expect(scene.cameraLookAtTarget(cam)).toBeNull(); // ignored
    expect(scene.cameraLookAtIsCyclic(cam)).toBe(true); // surfaced as a warning
  });
});

describe('camera Focus Object distance (UR5-7)', () => {
  it('the tracer snapshot focuses on the target and tracks a moving target', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const cam = scene.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new Vec3(0, 0, 0));
    const target = scene.addEmpty('Focus');
    target.transform = target.transform.withPosition(new Vec3(0, 0, 6));
    cam.camera!.focusObjectId = target.id;
    const orbit = new OrbitCamera();

    const snapAt = (pos: Vec3) => {
      target.transform = target.transform.withPosition(pos);
      return buildSnapshot(scene, orbit).camera;
    };
    const s6 = snapAt(new Vec3(0, 0, 6));
    expect(s6.focusFromObject).toBe(true);
    expect(s6.focusDistance).toBeCloseTo(6, 5);
    const s12 = snapAt(new Vec3(0, 0, 12));
    expect(s12.focusDistance).toBeCloseTo(12, 5); // moved → refocuses per snapshot
  });

  it('leaves focus distance to the bounds seed (no lock) when no focus object', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const cam = scene.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new Vec3(0, 0, 6));
    const snap = buildSnapshot(scene, new OrbitCamera()).camera;
    expect(snap.focusFromObject).toBeUndefined();
  });
});
