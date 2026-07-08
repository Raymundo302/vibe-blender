import { describe, it, expect } from 'vitest';
import { Scene } from './Scene';
import { makeCube } from '../mesh/primitives';
import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import { Transform } from '../math/transform';
import { SetParentCommand, DeleteObjectsCommand } from '../undo/objectCommands';
import { serializeScene, applySceneJson } from '../../io/sceneJson';
import { OrbitCamera } from '../../camera/OrbitCamera';

const close = (a: Vec3, b: Vec3, eps = 1e-5): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps);
};

describe('Transform.fromMat4', () => {
  it('round-trips a TRS transform', () => {
    const t = new Transform(
      new Vec3(1, -2, 3),
      Quat.fromEulerXYZ(0.4, -0.8, 1.2),
      new Vec3(2, 0.5, 3),
    );
    const back = Transform.fromMat4(t.matrix());
    close(back.position, t.position);
    close(back.scale, t.scale);
    // Quats are double-cover: q and -q are the same rotation.
    const d = Math.abs(
      back.rotation.x * t.rotation.x + back.rotation.y * t.rotation.y +
      back.rotation.z * t.rotation.z + back.rotation.w * t.rotation.w,
    );
    expect(d).toBeGreaterThan(0.99999);
  });
});

describe('Scene parenting', () => {
  it('composes world matrices through the parent chain', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(10, 0, 0));
    child.transform = new Transform(new Vec3(0, 5, 0));
    child.parentId = parent.id;
    close(scene.worldTransformOf(child).position, new Vec3(10, 5, 0));
  });

  it('parent rotation carries children around', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(Vec3.ZERO, Quat.fromAxisAngle(Vec3.Z, Math.PI / 2));
    child.transform = new Transform(new Vec3(1, 0, 0));
    child.parentId = parent.id;
    close(scene.worldTransformOf(child).position, new Vec3(0, 1, 0));
  });

  it('setParentKeepTransform keeps the world position on parent AND clear', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(3, 2, 1), Quat.fromAxisAngle(Vec3.Y, 0.7), new Vec3(2, 2, 2));
    child.transform = new Transform(new Vec3(-4, 0, 6));

    expect(scene.setParentKeepTransform(child, parent)).toBe(true);
    expect(child.parentId).toBe(parent.id);
    close(scene.worldTransformOf(child).position, new Vec3(-4, 0, 6));

    expect(scene.setParentKeepTransform(child, null)).toBe(true);
    expect(child.parentId).toBeNull();
    close(child.transform.position, new Vec3(-4, 0, 6));
  });

  it('refuses cycles (parenting an ancestor to its descendant)', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    const c = scene.add('C', makeCube());
    scene.setParentKeepTransform(b, a);
    scene.setParentKeepTransform(c, b);
    expect(scene.setParentKeepTransform(a, c)).toBe(false);
    expect(a.parentId).toBeNull();
    expect(scene.setParentKeepTransform(a, a)).toBe(false);
  });

  it('removing a parent reparents children to the grandparent, keeping world', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    const c = scene.add('C', makeCube());
    a.transform = new Transform(new Vec3(1, 0, 0));
    scene.setParentKeepTransform(b, a);
    b.transform = new Transform(new Vec3(0, 2, 0)); // world (1,2,0)
    scene.setParentKeepTransform(c, b);
    c.transform = new Transform(new Vec3(0, 0, 3)); // world (1,2,3)

    scene.remove(b.id);
    expect(c.parentId).toBe(a.id);
    close(scene.worldTransformOf(c).position, new Vec3(1, 2, 3));
  });

  it('duplicate keeps the parent link', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    scene.setParentKeepTransform(child, parent);
    const dup = scene.duplicate(child, 'C.001');
    expect(dup.parentId).toBe(parent.id);
  });

  it('SetParentCommand undoes and redoes the exact hierarchy + locals', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(5, 0, 0));
    child.transform = new Transform(new Vec3(1, 1, 1));
    const beforeLocal = child.transform;

    const cmd = SetParentCommand.perform('Parent', scene, [child], parent);
    expect(cmd).not.toBeNull();
    expect(child.parentId).toBe(parent.id);

    cmd!.undo();
    expect(child.parentId).toBeNull();
    expect(child.transform).toBe(beforeLocal);

    cmd!.redo();
    expect(child.parentId).toBe(parent.id);
    close(scene.worldTransformOf(child).position, new Vec3(1, 1, 1));
  });

  it('deleting a parent is undoable: children return to it with old locals', () => {
    const scene = new Scene();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    parent.transform = new Transform(new Vec3(2, 0, 0));
    scene.setParentKeepTransform(child, parent);
    const localBefore = child.transform;

    const cmd = DeleteObjectsCommand.perform('Delete', scene, [parent.id]);
    expect(child.parentId).toBeNull();

    cmd.undo();
    expect(child.parentId).toBe(parent.id);
    expect(child.transform).toBe(localBefore);

    cmd.redo();
    expect(child.parentId).toBeNull();
  });
});

describe('sceneJson v4 parenting + cursor', () => {
  it('round-trips parent links, cursor and pivotMode byte-identically', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    const parent = scene.add('P', makeCube());
    const child = scene.add('C', makeCube());
    scene.setParentKeepTransform(child, parent);
    scene.cursor = new Vec3(1.5, 2.5, -3);
    scene.pivotMode = 'cursor';

    const json = serializeScene(scene, cam);
    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    expect(scene2.objects[1].parentId).toBe(scene2.objects[0].id);
    close(scene2.cursor, new Vec3(1.5, 2.5, -3));
    expect(scene2.pivotMode).toBe('cursor');
    expect(serializeScene(scene2, cam)).toBe(json);
  });

  it('rejects a parent cycle in the file before mutating the scene', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    scene.add('A', makeCube());
    scene.add('B', makeCube());
    const data = JSON.parse(serializeScene(scene, cam));
    data.objects[0].parent = 1;
    data.objects[1].parent = 0;
    const target = new Scene();
    target.add('Keep', makeCube());
    expect(() => applySceneJson(JSON.stringify(data), target, new OrbitCamera())).toThrow(/cycle/);
    expect(target.objects.length).toBe(1); // untouched
  });

  it('loads a pre-v4 file with no parent/cursor keys', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    scene.add('A', makeCube());
    const data = JSON.parse(serializeScene(scene, cam));
    data.version = 3;
    delete data.cursor;
    delete data.pivotMode;
    for (const o of data.objects) delete o.parent;
    const scene2 = new Scene();
    applySceneJson(JSON.stringify(data), scene2, new OrbitCamera());
    expect(scene2.objects[0].parentId).toBeNull();
    close(scene2.cursor, Vec3.ZERO);
    expect(scene2.pivotMode).toBe('median');
  });
});

describe('sceneJson v5 material map slots (F13-1)', () => {
  it('round-trips normal/rough/metal map fields byte-identically', async () => {
    const { Scene } = await import('./Scene');
    const scene = new Scene();
    const cam = new OrbitCamera();
    scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Mapped');
    mat.normalDataUrl = 'data:image/png;base64,AAA';
    mat.normalIsBump = true;
    mat.normalStrength = 1.5;
    mat.roughDataUrl = 'data:image/png;base64,BBB';
    mat.metalDataUrl = null;
    const json = serializeScene(scene, cam);
    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    const m2 = scene2.materials[0];
    expect(m2.normalDataUrl).toBe('data:image/png;base64,AAA');
    expect(m2.normalIsBump).toBe(true);
    expect(m2.normalStrength).toBe(1.5);
    expect(m2.roughDataUrl).toBe('data:image/png;base64,BBB');
    expect(m2.metalDataUrl).toBeNull();
    expect(serializeScene(scene2, cam)).toBe(json);
  });

  it('loads a v4 file with no map keys as maps-off defaults', () => {
    const scene = new Scene();
    const cam = new OrbitCamera();
    scene.add('Cube', makeCube());
    scene.addMaterial('Plain');
    const data = JSON.parse(serializeScene(scene, cam));
    data.version = 4;
    for (const m of data.materials) {
      delete m.normalDataUrl; delete m.normalIsBump; delete m.normalStrength;
      delete m.roughDataUrl; delete m.metalDataUrl;
    }
    const scene2 = new Scene();
    applySceneJson(JSON.stringify(data), scene2, new OrbitCamera());
    const m2 = scene2.materials[0];
    expect(m2.normalDataUrl).toBeNull();
    expect(m2.normalIsBump).toBe(false);
    expect(m2.normalStrength).toBe(1);
  });
});
