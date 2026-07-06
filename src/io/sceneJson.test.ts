import { describe, it, expect, beforeAll } from 'vitest';
import { serializeScene, applySceneJson } from './sceneJson';
import { Scene } from '../core/scene/Scene';
import { OrbitCamera } from '../camera/OrbitCamera';
import { makeCube } from '../core/mesh/primitives';
import { Transform } from '../core/math/transform';
import { Vec3 } from '../core/math/vec3';
import { Quat } from '../core/math/quat';
import { registerModifier, createModifier, type Modifier } from '../core/modifiers/Modifier';
import type { EditableMesh } from '../core/mesh/EditableMesh';

/**
 * Test-local modifier exercising every param kind (number, bool, axis) so the
 * v2 round trip covers serialize/deserialize of all of them. Registered here —
 * we do NOT depend on P4-5's real modifiers existing yet.
 */
function makeStretch(params?: Record<string, number | boolean | string>): Modifier {
  let amount = typeof params?.amount === 'number' ? params.amount : 2;
  let flip = typeof params?.flip === 'boolean' ? params.flip : false;
  let axis = typeof params?.axis === 'string' ? params.axis : 'x';
  return {
    type: 'stretch',
    name: 'Stretch',
    enabled: true,
    apply(mesh: EditableMesh) { return mesh.clone(); },
    params: () => ({ amount, flip, axis }),
    setParam(key, value) {
      if (key === 'amount') amount = value as number;
      else if (key === 'flip') flip = value as boolean;
      else if (key === 'axis') axis = value as string;
    },
    fields: () => [
      { key: 'amount', label: 'Amount', kind: 'number' as const },
      { key: 'flip', label: 'Flip', kind: 'bool' as const },
      { key: 'axis', label: 'Axis', kind: 'axis' as const },
    ],
  };
}

beforeAll(() => registerModifier('stretch', 'Stretch (test)', makeStretch));

/**
 * Build a 2-object scene: a plain cube and a cube with a gap in its vert ids
 * (a vert deleted so ids are non-contiguous) — proving the round trip preserves
 * arbitrary ids and Map insertion order, not just naive 0..n-1 sequences.
 */
function makeScene(): { scene: Scene; camera: OrbitCamera } {
  const scene = new Scene();

  const a = scene.add('Cube', makeCube());
  a.transform = new Transform(
    new Vec3(1, 2, 3),
    Quat.fromEulerXYZ(0.3, -0.4, 0.5),
    new Vec3(2, 1, 0.5),
  );
  a.color = [1, 0, 0.5];

  const gappy = makeCube();
  gappy.deleteVerts([3]); // removes vert 3 and its faces → non-contiguous ids
  const b = scene.add('Gappy', gappy);
  b.visible = false;

  const camera = new OrbitCamera();
  camera.target = new Vec3(0.5, 1, -2);
  camera.distance = 12.5;
  camera.yaw = 1.1;
  camera.pitch = 0.4;
  return { scene, camera };
}

describe('sceneJson round trip', () => {
  it('serialize → apply → serialize produces identical strings', () => {
    const src = makeScene();
    const s1 = serializeScene(src.scene, src.camera);

    const dst = { scene: new Scene(), camera: new OrbitCamera() };
    applySceneJson(s1, dst.scene, dst.camera);
    const s2 = serializeScene(dst.scene, dst.camera);

    expect(s2).toBe(s1);
  });

  it('preserves vert/face ids and iteration order exactly', () => {
    const src = makeScene();
    const json = serializeScene(src.scene, src.camera);
    const dst = new Scene();
    applySceneJson(json, dst, new OrbitCamera());

    expect(dst.objects.map((o) => o.name)).toEqual(['Cube', 'Gappy']);

    for (let i = 0; i < src.scene.objects.length; i++) {
      const srcMesh = src.scene.objects[i].mesh;
      const dstMesh = dst.objects[i].mesh;
      expect([...dstMesh.verts.keys()]).toEqual([...srcMesh.verts.keys()]);
      expect([...dstMesh.faces.keys()]).toEqual([...srcMesh.faces.keys()]);
      for (const fid of srcMesh.faces.keys()) {
        expect(dstMesh.faces.get(fid)!.verts).toEqual(srcMesh.faces.get(fid)!.verts);
      }
    }

    // The gap (deleted vert 3) survives the trip.
    expect([...dst.objects[1].mesh.verts.keys()]).not.toContain(3);
  });

  it('restores transforms, visibility and camera', () => {
    const src = makeScene();
    const json = serializeScene(src.scene, src.camera);
    const dst = new Scene();
    const cam = new OrbitCamera();
    applySceneJson(json, dst, cam);

    const cube = dst.objects[0];
    expect(cube.transform.position.equalsApprox(new Vec3(1, 2, 3))).toBe(true);
    expect(cube.transform.scale.equalsApprox(new Vec3(2, 1, 0.5))).toBe(true);
    expect(cube.color).toEqual([1, 0, 0.5]);
    expect(dst.objects[1].visible).toBe(false);
    expect(cam.distance).toBeCloseTo(12.5, 6);
    expect(cam.target.equalsApprox(new Vec3(0.5, 1, -2))).toBe(true);
  });

  it('keeps ids editable after load (id counters restored)', () => {
    const src = makeScene();
    const json = serializeScene(src.scene, src.camera);
    const dst = new Scene();
    applySceneJson(json, dst, new OrbitCamera());

    const mesh = dst.objects[0].mesh;
    const before = new Set(mesh.verts.keys());
    const newId = mesh.addVert(new Vec3(9, 9, 9));
    expect(before.has(newId)).toBe(false); // no collision with a restored id
  });
});

describe('sceneJson format v2 modifiers', () => {
  it('writes version 2', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const parsed = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(parsed.version).toBe(2);
    expect(parsed.objects[0].modifiers).toEqual([]);
  });

  it('round-trips a 2-modifier stack with custom params/enabled', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const m0 = createModifier('stretch', { amount: 3.5, flip: true, axis: 'z' });
    m0.name = 'First';
    m0.enabled = false;
    const m1 = createModifier('stretch', { amount: -1.25, flip: false, axis: 'y' });
    m1.name = 'Second';
    obj.modifiers.push(m0, m1);
    obj.modifiersVersion++;

    const s1 = serializeScene(scene, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());

    const mods = dst.objects[0].modifiers;
    expect(mods.length).toBe(2);
    expect(mods[0].name).toBe('First');
    expect(mods[0].enabled).toBe(false);
    expect(mods[0].params()).toEqual({ amount: 3.5, flip: true, axis: 'z' });
    expect(mods[1].name).toBe('Second');
    expect(mods[1].enabled).toBe(true);
    expect(mods[1].params()).toEqual({ amount: -1.25, flip: false, axis: 'y' });

    // serialize → apply → serialize is byte-identical (deterministic).
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);
  });

  it('accepts a v1 file (no modifiers key) as an empty stack', () => {
    const v1 = JSON.stringify({
      format: 'vibe-blender-scene', version: 1,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      objects: [{
        name: 'Legacy', visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 1, 1, 0]], faces: [[0, [0, 1, 2]]] },
      }],
    });
    const dst = new Scene();
    applySceneJson(v1, dst, new OrbitCamera());
    expect(dst.objects[0].name).toBe('Legacy');
    expect(dst.objects[0].modifiers).toEqual([]);
  });

  it('throws on an unknown modifier type before mutating the scene', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 2,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      objects: [{
        name: 'Broken', visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 1, 1, 0]], faces: [[0, [0, 1, 2]]] },
        modifiers: [{ type: 'no-such-modifier', name: 'X', enabled: true, params: {} }],
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/unknown modifier type/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });
});

describe('sceneJson per-object color', () => {
  it('defaults a new object to neutral grey', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    expect(obj.color).toEqual([0.69, 0.69, 0.69]);
  });

  it('serializes color and round-trips it', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.color = [0.25, 0.5, 0.75];
    const parsed = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(parsed.objects[0].color).toEqual([0.25, 0.5, 0.75]);

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.objects[0].color).toEqual([0.25, 0.5, 0.75]);
  });

  it('loads an older file with no color key using the default', () => {
    const legacy = JSON.stringify({
      format: 'vibe-blender-scene', version: 2,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      objects: [{
        name: 'Legacy', visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 1, 1, 0]], faces: [[0, [0, 1, 2]]] },
        modifiers: [],
      }],
    });
    const dst = new Scene();
    applySceneJson(legacy, dst, new OrbitCamera());
    expect(dst.objects[0].color).toEqual([0.69, 0.69, 0.69]);
  });
});

describe('sceneJson error handling', () => {
  it('throws a readable error on malformed JSON and leaves the scene untouched', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const snapshot = scene.objects.map((o) => o.name);

    expect(() => applySceneJson('{ not json', scene, new OrbitCamera())).toThrow(/valid JSON|Invalid scene/i);
    expect(scene.objects.map((o) => o.name)).toEqual(snapshot);
  });

  it('throws on a wrong format tag and leaves the scene untouched', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const badFormat = JSON.stringify({ format: 'something-else', version: 1, camera: {}, objects: [] });

    expect(() => applySceneJson(badFormat, scene, new OrbitCamera())).toThrow(/format/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
    expect(scene.objects[0].mesh.verts.size).toBe(8);
  });

  it('throws when a face references a missing vert (no partial load)', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 1,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      objects: [{
        name: 'Broken', visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0]], faces: [[0, [0, 1, 99]]] },
      }],
    });

    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/missing vert/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });
});
