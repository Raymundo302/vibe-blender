import { describe, expect, it } from 'vitest';
import { Scene } from './Scene';
import {
  CAMERA_SPAWN_ROTATION,
  DEFAULT_MATERIAL,
  cameraFovY,
  defaultCamera,
  defaultLight,
  objectForward,
} from './objectData';
import { makeCube } from '../mesh/primitives';
import { Transform } from '../math/transform';
import { Quat } from '../math/quat';
import { Vec3 } from '../math/vec3';
import { collectLights } from '../../render/passes/renderedPass';

describe('object kinds', () => {
  it('mesh objects keep kind "mesh"; lights/cameras carry payloads + empty meshes', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const light = scene.addLight('Point', 'point');
    const cam = scene.addCamera('Camera');
    expect(cube.kind).toBe('mesh');
    expect(light.kind).toBe('light');
    expect(light.light?.type).toBe('point');
    expect(light.mesh.verts.size).toBe(0);
    expect(cam.kind).toBe('camera');
    expect(cam.camera?.focalLength).toBe(50);
    const empty = scene.addEmpty('Empty');
    expect(empty.kind).toBe('empty');
    expect(empty.empty?.displaySize).toBe(1);
    expect(empty.mesh.verts.size).toBe(0);
  });

  it('refuses edit mode on lights and cameras', () => {
    const scene = new Scene();
    const light = scene.addLight('Sun', 'sun');
    scene.selectOnly(light.id);
    expect(scene.enterEditMode()).toBe(false);
    expect(scene.editMode).toBeNull();
  });

  it('first camera becomes active; deleting it promotes the next one', () => {
    const scene = new Scene();
    const a = scene.addCamera('Cam A');
    const b = scene.addCamera('Cam B');
    expect(scene.activeCameraId).toBe(a.id);
    scene.remove(a.id);
    expect(scene.activeCameraId).toBe(b.id);
    scene.remove(b.id);
    expect(scene.activeCameraId).toBeNull();
  });

  it('re-inserting a camera into a camera-less scene reactivates it (undo)', () => {
    const scene = new Scene();
    const cam = scene.addCamera('Cam');
    scene.remove(cam.id);
    scene.insertAt(cam, 0);
    expect(scene.activeCameraId).toBe(cam.id);
  });
});

describe('materials', () => {
  it('addMaterial assigns unique ids and default names', () => {
    const scene = new Scene();
    const m1 = scene.addMaterial();
    const m2 = scene.addMaterial('Gold');
    expect(m1.id).not.toBe(m2.id);
    expect(m1.name).toBe('Material.001');
    expect(m2.name).toBe('Gold');
  });

  it('materialOf resolves assignment and falls back to the default', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    expect(scene.materialOf(obj)).toBe(DEFAULT_MATERIAL);
    const mat = scene.addMaterial('Red');
    obj.materialId = mat.id;
    expect(scene.materialOf(obj)).toBe(mat);
  });

  it('removeMaterial unassigns it from every object', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const mat = scene.addMaterial();
    obj.materialId = mat.id;
    scene.removeMaterial(mat.id);
    expect(obj.materialId).toBeNull();
    expect(scene.materialOf(obj)).toBe(DEFAULT_MATERIAL);
  });
});

describe('light math', () => {
  it('objectForward is local -Z rotated by the object rotation', () => {
    const identity = objectForward(new Transform());
    expect(identity.x).toBeCloseTo(0);
    expect(identity.z).toBeCloseTo(-1);
    // Rotate -90° about X: -Z aims straight down (sun pointing at the floor).
    const down = objectForward(
      new Transform(Vec3.ZERO, Quat.fromAxisAngle(Vec3.X, -Math.PI / 2)),
    );
    expect(down.y).toBeCloseTo(-1);
    expect(down.z).toBeCloseTo(0);
  });

  it('collectLights premultiplies energy and skips hidden/mesh objects', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.addLight('Sun', 'sun');
    scene.addLight('Point', 'point');
    const hidden = scene.addLight('Hidden', 'point');
    hidden.visible = false;

    const set = collectLights(scene);
    expect(set.count).toBe(2);
    // sun: energy = color * power (no 1/4π)
    expect(set.energies[0]).toBeCloseTo(defaultLight('sun').power);
    expect(set.types[0]).toBe(1);
    // point: energy = color * power / 4π
    expect(set.energies[3]).toBeCloseTo(defaultLight('point').power / (4 * Math.PI));
    expect(set.types[1]).toBe(0);
  });

  it('spot cone cosines: inner ≥ outer, blend widens the soft edge', () => {
    const scene = new Scene();
    const spot = scene.addLight('Spot', 'spot');
    spot.light!.spotAngle = Math.PI / 2;
    spot.light!.spotBlend = 0.5;
    const set = collectLights(scene);
    const cosInner = set.spots[0];
    const cosOuter = set.spots[1];
    expect(cosOuter).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(cosInner).toBeCloseTo(Math.cos(Math.PI / 8));
    expect(cosInner).toBeGreaterThan(cosOuter);
  });
});

describe('camera math', () => {
  it('cameraFovY: 50mm on a 24mm-tall sensor ≈ 27°', () => {
    const fov = cameraFovY(defaultCamera());
    expect((fov * 180) / Math.PI).toBeCloseTo(27, 0);
  });
});

describe('CAMERA_SPAWN_ROTATION (UR5-5 Part B)', () => {
  it('re-aims local -Z toward world +Y (the horizon), not the floor', () => {
    const localForward = new Vec3(0, 0, -1); // camera looks along local -Z
    const aimed = CAMERA_SPAWN_ROTATION.rotate(localForward);
    expect(aimed.equalsApprox(new Vec3(0, 1, 0))).toBe(true);
  });

  it('keeps local +Y along world +Z (up stays up)', () => {
    const up = CAMERA_SPAWN_ROTATION.rotate(new Vec3(0, 1, 0));
    expect(up.equalsApprox(new Vec3(0, 0, 1))).toBe(true);
  });

  it('objectForward of a spawn-rotated transform points at +Y', () => {
    const t = new Transform(Vec3.ZERO, CAMERA_SPAWN_ROTATION);
    expect(objectForward(t).equalsApprox(new Vec3(0, 1, 0))).toBe(true);
  });
});
