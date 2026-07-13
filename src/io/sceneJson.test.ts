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

describe('sceneJson v14 text objects', () => {
  function makeTextScene(): { scene: Scene; camera: OrbitCamera } {
    const scene = new Scene();
    const t = scene.addText('Hello', {
      content: 'Hi\nthere', font: 'Georgia', size: 0.4, wrap: true, wrapWidth: 8,
      align: 'center', style: 'both', faceColor: [0.9, 0.1, 0.2], outlineColor: [0, 0, 0.5],
      thickness: 0.2,
    });
    // Give it a small non-empty "generated" mesh so mesh round-trip is exercised.
    t.mesh = makeCube(0.5);
    scene.selectOnly(t.id);
    return { scene, camera: new OrbitCamera() };
  }

  it('round-trips the text payload (byte-identical serialize→apply→serialize)', () => {
    const src = makeTextScene();
    const s1 = serializeScene(src.scene, src.camera);
    const dst = new Scene();
    const dstCam = new OrbitCamera();
    applySceneJson(s1, dst, dstCam);
    const s2 = serializeScene(dst, dstCam);
    expect(s2).toBe(s1);

    const t = dst.objects[0];
    expect(t.kind).toBe('text');
    expect(t.text).toEqual(src.scene.objects[0].text);
    // The generated mesh survives verbatim (headless load keeps the stored mesh).
    expect([...t.mesh.faces.keys()]).toEqual([...src.scene.objects[0].mesh.faces.keys()]);
  });

  it('rejects a text object missing its payload', () => {
    const src = makeTextScene();
    const json = serializeScene(src.scene, src.camera);
    const broken = JSON.parse(json);
    delete broken.objects[0].text;
    expect(() => applySceneJson(JSON.stringify(broken), new Scene(), new OrbitCamera())).toThrow();
  });
});

describe('sceneJson v19 curve objects', () => {
  it('round-trips bezier + nurbs curves (byte-identical serialize→apply→serialize)', () => {
    const scene = new Scene();
    scene.addCurve('Bez', {
      kind: 'bezier', cyclic: true, resolution: 16,
      points: [
        { co: [1, 0, 0], hl: [1, -0.5, 0], hr: [1, 0.5, 0] },
        { co: [0, 1, 0], hl: [0.5, 1, 0], hr: [-0.5, 1, 0] },
      ],
    });
    scene.addCurve('Nur', {
      kind: 'nurbs', cyclic: false, resolution: 10, order: 3,
      points: [{ co: [-1, 0, 0], w: 1 }, { co: [0, 1, 0], w: 0.7 }, { co: [1, 0, 0], w: 1 }],
    });
    scene.selectOnly(scene.objects[0].id);
    const cam = new OrbitCamera();
    const s1 = serializeScene(scene, cam);
    const dst = new Scene();
    const dstCam = new OrbitCamera();
    applySceneJson(s1, dst, dstCam);
    const s2 = serializeScene(dst, dstCam);
    expect(s2).toBe(s1);

    expect(dst.objects[0].kind).toBe('curve');
    expect(dst.objects[0].curve).toEqual(scene.objects[0].curve);
    expect(dst.objects[1].curve).toEqual(scene.objects[1].curve);
  });

  it('rejects a curve object missing its payload', () => {
    const scene = new Scene();
    scene.addCurve('Bez', { kind: 'bezier', cyclic: false, resolution: 12, points: [{ co: [0, 0, 0] }, { co: [1, 0, 0] }] });
    const json = serializeScene(scene, new OrbitCamera());
    const broken = JSON.parse(json);
    delete broken.objects[0].curve;
    expect(() => applySceneJson(JSON.stringify(broken), new Scene(), new OrbitCamera())).toThrow();
  });
});

describe('sceneJson format v2 modifiers', () => {
  it('writes the current format version', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const parsed = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(parsed.version).toBe(20);
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

describe('sceneJson format v3 lights / cameras / materials', () => {
  /** A cube with an assigned material, two lights and a camera. */
  function makeLitScene(): Scene {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Red');
    mat.baseColor = [1, 0.1, 0.05];
    mat.metallic = 0.25;
    mat.roughness = 0.3;
    mat.emissive = [0.2, 0, 0];
    mat.emissiveStrength = 1.5;
    cube.materialId = mat.id;

    scene.addLight('Point', 'point'); // point defaults
    const spot = scene.addLight('Spot', 'spot');
    spot.light!.spotAngle = (60 * Math.PI) / 180;
    spot.light!.color = [0.2, 0.4, 0.9];
    spot.light!.power = 250;

    scene.addCamera('Camera'); // first camera → auto-active
    return scene;
  }

  it('round-trips a lit scene byte-identically and preserves kinds', () => {
    const src = makeLitScene();
    const s1 = serializeScene(src, new OrbitCamera());

    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    const s2 = serializeScene(dst, new OrbitCamera());
    expect(s2).toBe(s1);

    expect(dst.objects.map((o) => o.kind)).toEqual(['mesh', 'light', 'light', 'camera']);
    expect(dst.objects.map((o) => o.name)).toEqual(['Cube', 'Point', 'Spot', 'Camera']);
  });

  it('restores light payloads (defaults + custom spot)', () => {
    const src = makeLitScene();
    const dst = new Scene();
    applySceneJson(serializeScene(src, new OrbitCamera()), dst, new OrbitCamera());

    const point = dst.objects[1];
    expect(point.kind).toBe('light');
    expect(point.light!.type).toBe('point');
    expect(point.light!.power).toBe(100);
    expect(point.light!.color).toEqual([1, 1, 1]);

    const spot = dst.objects[2];
    expect(spot.light!.type).toBe('spot');
    expect(spot.light!.power).toBe(250);
    expect(spot.light!.color).toEqual([0.2, 0.4, 0.9]);
    expect(spot.light!.spotAngle).toBeCloseTo((60 * Math.PI) / 180, 6);
  });

  it('round-trips an area light (UR10-1) with custom width/height, incl. id gaps', () => {
    const src = new Scene();
    src.add('Cube', makeCube());
    const area = src.addLight('Area', 'area');
    area.light!.width = 2.5;
    area.light!.height = 0.75;
    area.light!.power = 300;
    // Introduce an id GAP: remove the cube so the only surviving object's id is
    // non-contiguous — exercises the index-based re-id path on load.
    const cube = src.objects.find((o) => o.kind === 'mesh')!;
    src.remove(cube.id);

    const s1 = serializeScene(src, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    const s2 = serializeScene(dst, new OrbitCamera());
    expect(s2).toBe(s1); // byte-identical round trip

    const loaded = dst.objects.find((o) => o.kind === 'light')!;
    expect(loaded.light!.type).toBe('area');
    expect(loaded.light!.width).toBeCloseTo(2.5, 6);
    expect(loaded.light!.height).toBeCloseTo(0.75, 6);
    expect(loaded.light!.power).toBe(300);
  });

  it('tolerant-loads an area light with missing width/height → 1×1', () => {
    const scene = new Scene();
    const raw = JSON.stringify({
      format: 'vibe-blender-scene', version: 16,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCameraId: null, materials: [],
      objects: [{
        id: 0, name: 'Area', kind: 'light', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [], faces: [] }, modifiers: [],
        light: { type: 'area', color: [1, 1, 1], power: 100, spotAngle: 0.5, spotBlend: 0.1 },
      }],
    });
    applySceneJson(raw, scene, new OrbitCamera());
    const l = scene.objects[0].light!;
    expect(l.type).toBe('area');
    expect(l.width).toBe(1);
    expect(l.height).toBe(1);
    // Area lights have no sphere radius.
    expect(l.radius).toBe(0);
  });

  it('restores camera payloads and remaps the active camera', () => {
    const src = makeLitScene();
    // The saved active camera is the object at index 3.
    const dst = new Scene();
    applySceneJson(serializeScene(src, new OrbitCamera()), dst, new OrbitCamera());

    const cam = dst.objects[3];
    expect(cam.kind).toBe('camera');
    expect(cam.camera!.focalLength).toBe(50);
    // activeCameraId points at the REBUILT camera's (regenerated) id.
    expect(dst.activeCameraId).toBe(cam.id);
    expect(dst.activeCamera).toBe(cam);
  });

  it('remaps active camera when a non-first camera is active', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const c1 = scene.addCamera('CamA'); // auto-active
    const c2 = scene.addCamera('CamB');
    scene.activeCameraId = c2.id; // switch active to the second camera
    expect(scene.activeCameraId).not.toBe(c1.id);

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    // objects: [Cube, CamA, CamB]; active should map to CamB at index 2.
    expect(dst.activeCamera!.name).toBe('CamB');
    expect(dst.activeCameraId).toBe(dst.objects[2].id);
  });

  it('round-trips empty objects (kind + displaySize) byte-identically', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const e = scene.addEmpty('Empty');
    e.empty!.displaySize = 2.5;
    e.transform = e.transform.withPosition(new Vec3(1, 2, 3));
    const s1 = serializeScene(scene, new OrbitCamera());

    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);

    const re = dst.objects[1];
    expect(re.kind).toBe('empty');
    expect(re.empty!.displaySize).toBe(2.5);
    expect(re.mesh.verts.size).toBe(0);
    expect(re.transform.position.x).toBe(1);
  });

  it('serializes camera focus/lookAt as OBJECT INDICES and remaps to ids on load', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());      // index 0
    const target = scene.addEmpty('Target');         // index 1
    const cam = scene.addCamera('Camera');           // index 2
    cam.camera!.focusObjectId = target.id;
    cam.camera!.lookAtId = cube.id;

    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    // Refs are the objects INDICES, not the (runtime) ids.
    expect(json.objects[2].camera.focusObject).toBe(1);
    expect(json.objects[2].camera.lookAt).toBe(0);

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    const rcam = dst.objects[2];
    expect(rcam.camera!.focusObjectId).toBe(dst.objects[1].id);
    expect(rcam.camera!.lookAtId).toBe(dst.objects[0].id);
  });

  it('omits camera focus/lookAt keys when unset (byte-identical to no-target file)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.addCamera('Camera');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('focusObject' in json.objects[1].camera).toBe(false);
    expect('lookAt' in json.objects[1].camera).toBe(false);
  });

  it('an id-gap scene with camera targets round-trips byte-identically', () => {
    const scene = new Scene();
    const a = scene.add('A', makeCube());
    const target = scene.addEmpty('Target');
    const b = scene.add('B', makeCube());
    const cam = scene.addCamera('Camera');
    cam.camera!.lookAtId = target.id;
    cam.camera!.focusObjectId = b.id;
    // Delete an early object to leave an id gap (ids no longer 0..n).
    scene.remove(a.id);

    const s1 = serializeScene(scene, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);
    // Refs still resolve after the remap.
    const rcam = dst.objects.find((o) => o.kind === 'camera')!;
    expect(dst.get(rcam.camera!.lookAtId!)!.name).toBe('Target');
    expect(dst.get(rcam.camera!.focusObjectId!)!.name).toBe('B');
  });

  it('restores the material library and keeps materialId verbatim', () => {
    const src = makeLitScene();
    const dst = new Scene();
    applySceneJson(serializeScene(src, new OrbitCamera()), dst, new OrbitCamera());

    expect(dst.materials.length).toBe(1);
    const mat = dst.materials[0];
    expect(mat.name).toBe('Red');
    expect(mat.baseColor).toEqual([1, 0.1, 0.05]);
    expect(mat.metallic).toBe(0.25);
    expect(mat.emissiveStrength).toBe(1.5);
    // The cube still references the same material id.
    expect(dst.objects[0].materialId).toBe(mat.id);
    expect(dst.materialOf(dst.objects[0])).toBe(mat);
  });

  it('restores the material id counter (addMaterial after load gets a fresh id)', () => {
    const src = makeLitScene();
    const savedId = src.materials[0].id;
    const dst = new Scene();
    applySceneJson(serializeScene(src, new OrbitCamera()), dst, new OrbitCamera());

    const fresh = dst.addMaterial('New');
    expect(fresh.id).not.toBe(savedId);
    expect(dst.getMaterial(fresh.id)).toBe(fresh);
    // And the restored material is still resolvable (no id collision clobbered it).
    expect(dst.getMaterial(savedId)!.name).toBe('Red');
  });

  it('loads a v2 fixture: kind defaults to mesh, no materials / active camera', () => {
    const v2 = JSON.stringify({
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
    applySceneJson(v2, dst, new OrbitCamera());
    expect(dst.objects[0].kind).toBe('mesh');
    expect(dst.objects[0].materialId).toBe(null);
    expect(dst.materials.length).toBe(0);
    expect(dst.activeCameraId).toBe(null);
  });

  it('rejects a malformed light type without mutating the scene', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCameraId: null, materials: [],
      objects: [{
        id: 0, name: 'BadLight', kind: 'light', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [], faces: [] }, modifiers: [],
        light: { type: 'laser', color: [1, 1, 1], power: 100, spotAngle: 0.5, spotBlend: 0.1 },
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/light\.type/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });

  it('rejects a negative light power without mutating the scene', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCameraId: null, materials: [],
      objects: [{
        id: 0, name: 'BadLight', kind: 'light', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [], faces: [] }, modifiers: [],
        light: { type: 'point', color: [1, 1, 1], power: -5, spotAngle: 0.5, spotBlend: 0.1 },
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/power/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });

  it('rejects a bad light color array without mutating the scene', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCameraId: null, materials: [],
      objects: [{
        id: 0, name: 'BadLight', kind: 'light', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [], faces: [] }, modifiers: [],
        light: { type: 'point', color: [1, 1], power: 100, spotAngle: 0.5, spotBlend: 0.1 },
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/light\.color/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
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

describe('determinism with id gaps (P8-5 fix)', () => {
  it('serialize→apply→serialize is byte-identical after a deletion leaves an id gap', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    scene.add('CubeA', makeCube());
    const light = scene.addLight('Doomed', 'point');
    scene.add('CubeC', makeCube());
    const cam = scene.addCamera('Cam');
    scene.activeCameraId = cam.id;
    scene.remove(light.id); // ids now 0, 2, 3 — a gap

    const s1 = serializeScene(scene, camera);
    applySceneJson(s1, scene, camera);
    const s2 = serializeScene(scene, camera);
    expect(s2).toBe(s1);
    // The active camera survives the dense renumbering (index-based remap).
    expect(scene.activeCamera?.name).toBe('Cam');
  });

  it('rejects an activeCamera index that is not a camera', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCamera: 0, materials: [],
      objects: [{
        name: 'JustACube', kind: 'mesh', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 0, 1, 0]], faces: [[0, [0, 1, 2]]] },
        modifiers: [],
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/not a camera/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });
});

describe('v8 migration: Y-up files load rotated into the Z-up world', () => {
  /** Serialize the current (v8) scene, then stamp an older version onto the
   *  JSON so the loader treats the content as Y-up authored. */
  function asV7(scene: Scene, mutate?: (root: Record<string, unknown>) => void): string {
    const root = JSON.parse(serializeScene(scene, new OrbitCamera()));
    root.version = 7;
    mutate?.(root);
    return JSON.stringify(root);
  }

  it('rotates a root object +90° about X (old +Y up → new +Z up)', () => {
    const src = new Scene();
    const cube = src.add('Cube', makeCube());
    cube.transform = cube.transform.withPosition(new Vec3(2, 5, -3));
    const scene = new Scene();
    applySceneJson(asV7(src), scene, new OrbitCamera());
    const t = scene.objects[0].transform;
    // Position: (x, y, z) → (x, -z, y).
    expect(t.position.equalsApprox(new Vec3(2, 3, 5))).toBe(true);
    // Rotation: identity → Rx(+90°).
    const q = Quat.fromAxisAngle(Vec3.X, Math.PI / 2);
    const d = t.rotation.x * q.x + t.rotation.y * q.y + t.rotation.z * q.z + t.rotation.w * q.w;
    expect(Math.abs(d)).toBeGreaterThan(1 - 1e-9);
  });

  it('does NOT touch children (they ride the parent frame)', () => {
    const src = new Scene();
    const parent = src.add('Parent', makeCube());
    const child = src.add('Child', makeCube());
    child.parentId = parent.id;
    child.transform = child.transform.withPosition(new Vec3(1, 2, 3));
    const scene = new Scene();
    applySceneJson(asV7(src), scene, new OrbitCamera());
    expect(scene.objects[1].transform.position.equalsApprox(new Vec3(1, 2, 3))).toBe(true);
  });

  it('remaps root location fcurves: old y → z verbatim, old z → y negated', () => {
    const src = new Scene();
    const cube = src.add('Cube', makeCube());
    cube.anim = {
      fcurves: [
        { channelPath: 'location.y', keys: [{ frame: 1, value: 4, interp: 'linear' as const }] },
        { channelPath: 'location.z', keys: [{ frame: 1, value: 7, interp: 'linear' as const }] },
      ],
    };
    const scene = new Scene();
    applySceneJson(asV7(src), scene, new OrbitCamera());
    const anim = scene.objects[0].anim!;
    const at = (p: string) => anim.fcurves.find((c) => c.channelPath === p)!.keys[0].value;
    expect(at('location.z')).toBeCloseTo(4, 9);  // old y, verbatim
    expect(at('location.y')).toBeCloseTo(-7, 9); // old z, negated
  });

  it('a v8 file loads without any rotation', () => {
    const src = new Scene();
    const cube = src.add('Cube', makeCube());
    cube.transform = cube.transform.withPosition(new Vec3(2, 5, -3));
    const scene = new Scene();
    applySceneJson(serializeScene(src, new OrbitCamera()), scene, new OrbitCamera());
    expect(scene.objects[0].transform.position.equalsApprox(new Vec3(2, 5, -3))).toBe(true);
  });

  it('v8 serialize→apply→serialize stays byte-identical (no double migration)', () => {
    const src = new Scene();
    const cube = src.add('Cube', makeCube());
    cube.transform = cube.transform.withPosition(new Vec3(1, 2, 3));
    const s1 = serializeScene(src, new OrbitCamera());
    const scene = new Scene();
    const cam = new OrbitCamera();
    applySceneJson(s1, scene, cam);
    expect(serializeScene(scene, cam)).toBe(s1);
  });
});

describe('v8 migration on a real historical file', () => {
  it('loads the frozen v3 donut fixture, roots rotated into Z-up', async () => {
    await import('../core/modifiers/builtins'); // register real modifier types
    await import('../core/modifiers/scatter');
    await import('../core/modifiers/shrinkwrap');
    // @ts-expect-error -- node:fs is untyped in this browser-target tsconfig
    // (no @types/node); vitest executes in Node where the import is real.
    const { readFileSync } = await import('node:fs');
    const json = readFileSync(
      new URL('../../e2e/fixtures/donut-p9-frozen.vibe.json', import.meta.url), 'utf8');
    const scene = new Scene();
    const cam = new OrbitCamera();
    applySceneJson(json, scene, cam);
    expect(scene.objects.length).toBe(9);
    // Every root object's rotation carries the Rx90 world rotation: the local
    // +Y axis (old up) must now map to world +Z (new up).
    for (const obj of scene.objects) {
      if (obj.parentId !== null) continue;
      const m = scene.worldMatrix(obj);
      const up = m.transformDir(new Vec3(0, 1, 0)).normalize();
      expect(up.z).toBeGreaterThan(0.5);
    }
  });
});

describe('v9 keyframe extras (easing + free handles)', () => {
  it('round-trips easing and free handles through serialize/load', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    obj.anim = {
      fcurves: [{
        channelPath: 'location.x',
        keys: [
          { frame: 1, value: 0, interp: 'bounce', easing: 'inout' },
          { frame: 10, value: 2, interp: 'bezier', handleMode: 'free', hl: [-2, 0.5], hr: [3, -0.25] },
          { frame: 20, value: 1, interp: 'elastic' }, // auto easing → no extras written
        ],
      }],
    };
    const json = serializeScene(scene, new OrbitCamera());
    const parsed = JSON.parse(json);
    const keys = parsed.objects[0].anim.fcurves[0].keys;
    expect(keys[0][3]).toEqual({ e: 'inout' });
    expect(keys[1][3]).toEqual({ hm: 'free', hl: [-2, 0.5], hr: [3, -0.25] });
    expect(keys[2].length).toBe(3); // auto easing stays compact

    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    const k2 = scene2.objects[0].anim!.fcurves[0].keys;
    expect(k2[0]).toMatchObject({ interp: 'bounce', easing: 'inout' });
    expect(k2[1]).toMatchObject({ handleMode: 'free', hl: [-2, 0.5], hr: [3, -0.25] });
    expect(k2[2].easing).toBeUndefined();
  });

  it('rejects an unknown interp with a readable error', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.objects[0].anim = { fcurves: [{ channelPath: 'location.x', keys: [[1, 0, 'zigzag']] }] };
    expect(() => applySceneJson(JSON.stringify(json), new Scene(), new OrbitCamera())).toThrow(/interp must be one of/);
  });
});

describe('sceneJson material bakeRes (P16 follow-up)', () => {
  it('round-trips a set bakeRes', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Nodes');
    mat.bakeRes = 512;
    cube.materialId = mat.id;

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.materials[0].bakeRes).toBe(512);
  });

  it('omits bakeRes from the file when unset (byte-identical / no format bump)', () => {
    const scene = new Scene();
    scene.addMaterial('Plain'); // bakeRes left undefined
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('bakeRes' in json.materials[0]).toBe(false);
  });

  it('tolerates absence (old files) → bakeRes stays undefined', () => {
    const scene = new Scene();
    scene.addMaterial('Old');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    // Simulate a pre-P16 file: no bakeRes key at all.
    delete json.materials[0].bakeRes;
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.materials[0].bakeRes).toBeUndefined();
  });

  it('ignores a disallowed bakeRes value on load', () => {
    const scene = new Scene();
    scene.addMaterial('Weird');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.materials[0].bakeRes = 333;
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.materials[0].bakeRes).toBeUndefined();
  });
});

describe('sceneJson material shadeless (v10 / UR4-3)', () => {
  it('writes the current format version', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(json.version).toBe(20);
  });

  it('round-trips a shadeless material', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Emit');
    mat.shadeless = true;
    cube.materialId = mat.id;

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.materials[0].shadeless).toBe(true);
  });

  it('omits shadeless from the file when false (byte-identical for non-shadeless)', () => {
    const scene = new Scene();
    scene.addMaterial('Lit'); // shadeless defaults to false
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('shadeless' in json.materials[0]).toBe(false);
  });

  it('tolerates absence (pre-v10 files) → shadeless false', () => {
    const scene = new Scene();
    scene.addMaterial('Old');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    delete json.materials[0].shadeless; // pre-v10 file has no such key
    json.version = 9;
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.materials[0].shadeless).toBe(false);
  });
});

describe('sceneJson transmission / IOR (v18 / UR10-3)', () => {
  it('round-trips a glass material', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Glass');
    mat.transmission = 1;
    mat.ior = 1.52;
    cube.materialId = mat.id;

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.materials[0].transmission).toBe(1);
    expect(dst.materials[0].ior).toBe(1.52);
  });

  it('omits transmission / ior from the file when opaque (byte-identical)', () => {
    const scene = new Scene();
    scene.addMaterial('Lit'); // transmission defaults to 0
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('transmission' in json.materials[0]).toBe(false);
    expect('ior' in json.materials[0]).toBe(false);
  });

  it('clamps a wild IOR on load', () => {
    const scene = new Scene();
    const mat = scene.addMaterial('Diamondish');
    mat.transmission = 0.5;
    mat.ior = 9; // written clamped to 2.5 by the serializer
    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.materials[0].ior).toBe(2.5);
  });

  it('tolerates absence (pre-v18 files) → transmission 0, ior 1.45', () => {
    const scene = new Scene();
    scene.addMaterial('Old');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    delete json.materials[0].transmission;
    delete json.materials[0].ior;
    json.version = 17;
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.materials[0].transmission).toBe(0);
    expect(dst.materials[0].ior).toBe(1.45);
  });
});

describe('sceneJson alphaBlend + alwaysTextured (v15 / UR8-3)', () => {
  it('round-trips both flags', () => {
    const scene = new Scene();
    const cube = scene.add('Cube', makeCube());
    const mat = scene.addMaterial('Plane');
    mat.alphaBlend = true;
    mat.alwaysTextured = true;
    cube.materialId = mat.id;

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.materials[0].alphaBlend).toBe(true);
    expect(dst.materials[0].alwaysTextured).toBe(true);
  });

  it('omits both flags from the file when false (byte-identical for opaque)', () => {
    const scene = new Scene();
    scene.addMaterial('Opaque'); // both default false
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('alphaBlend' in json.materials[0]).toBe(false);
    expect('alwaysTextured' in json.materials[0]).toBe(false);
  });

  it('tolerates absence (pre-v15 files) → both false', () => {
    const scene = new Scene();
    scene.addMaterial('Old');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    delete json.materials[0].alphaBlend;
    delete json.materials[0].alwaysTextured;
    json.version = 14;
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.materials[0].alphaBlend).toBe(false);
    expect(dst.materials[0].alwaysTextured).toBe(false);
  });
});

describe('sceneJson output resolution (v12 / UR5-5)', () => {
  it('defaults a new scene to 1920×1080 and serializes it', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(json.renderSettings).toEqual({ width: 1920, height: 1080, transparent: false });
  });

  it('round-trips a custom resolution', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.renderSettings = { width: 1000, height: 1000 };
    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.renderSettings).toEqual({ width: 1000, height: 1000, transparent: false });
  });

  it('a non-square resolution survives byte-identically', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.renderSettings = { width: 2560, height: 1080 };
    const s1 = serializeScene(scene, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);
  });

  it('loads an old file with no renderSettings key using the 1920×1080 default', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    delete json.renderSettings; // pre-v12 file
    json.version = 11;
    const dst = new Scene();
    dst.renderSettings = { width: 640, height: 480 }; // prove it is overwritten
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.renderSettings).toEqual({ width: 1920, height: 1080, transparent: false });
  });

  it('round-trips the transparent-film flag (UR16-3)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.renderSettings = { width: 800, height: 600, transparent: true };
    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.renderSettings).toEqual({ width: 800, height: 600, transparent: true });
  });

  it('old files without a transparent key default it to false (UR16-3)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    delete json.renderSettings.transparent; // pre-UR16-3 file
    const dst = new Scene();
    dst.renderSettings = { width: 1, height: 1, transparent: true }; // prove overwrite
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.renderSettings.transparent).toBe(false);
  });

  it('clamps sub-1 / non-integer dimensions on load', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.renderSettings = { width: 0, height: 720.7 };
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.renderSettings).toEqual({ width: 1, height: 720, transparent: false });
  });
});

describe('sceneJson HTML plane (v13 / UR7-1)', () => {
  it('round-trips an HTML-plane payload', () => {
    const scene = new Scene();
    const obj = scene.add('page', makeCube());
    obj.html = { kind: 'file', source: '<div>hi</div>', pageW: 800, pageH: 600, scrollY: 42, playing: true, fps: 12 };

    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(json.version).toBe(20);
    expect(json.objects[0].html).toEqual({
      kind: 'file', source: '<div>hi</div>', pageW: 800, pageH: 600, scrollY: 42, playing: true, fps: 12,
    });

    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.objects[0].html).toEqual({
      kind: 'file', source: '<div>hi</div>', pageW: 800, pageH: 600, scrollY: 42, playing: true, fps: 12,
    });
  });

  it('round-trips the UR8-3 transparent + autoCrop flags on an html plane', () => {
    const scene = new Scene();
    const obj = scene.add('frag', makeCube());
    obj.html = { kind: 'file', source: '<div>ball</div>', pageW: 204, pageH: 257, scrollY: 0, playing: false, fps: 8, transparent: true, autoCrop: true };
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(json.objects[0].html.transparent).toBe(true);
    expect(json.objects[0].html.autoCrop).toBe(true);
    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.objects[0].html!.transparent).toBe(true);
    expect(dst.objects[0].html!.autoCrop).toBe(true);
  });

  it('is byte-identical across serialize → apply → serialize', () => {
    const scene = new Scene();
    const obj = scene.add('page', makeCube());
    obj.html = { kind: 'file', source: '<p>x</p>', pageW: 1024, pageH: 768, scrollY: 0, playing: false, fps: 8 };
    const s1 = serializeScene(scene, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);
  });

  it('round-trips a URL-plane payload but LOADS it PAUSED (UR7-3: no surprise network on open)', () => {
    const scene = new Scene();
    const obj = scene.add('site', makeCube());
    obj.html = { kind: 'url', source: 'https://example.com', pageW: 1024, pageH: 768, scrollY: 0, playing: true, fps: 8 };

    // Serialization preserves the saved play state (round-trip fidelity of the file).
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect(json.objects[0].html.kind).toBe('url');
    expect(json.objects[0].html.source).toBe('https://example.com');
    expect(json.objects[0].html.playing).toBe(true);

    // …but on LOAD a URL plane comes up PAUSED regardless of the saved flag.
    const dst = new Scene();
    applySceneJson(serializeScene(scene, new OrbitCamera()), dst, new OrbitCamera());
    expect(dst.objects[0].html!.kind).toBe('url');
    expect(dst.objects[0].html!.source).toBe('https://example.com');
    expect(dst.objects[0].html!.playing).toBe(false);
  });

  it('omits html from the file for a plain object (unchanged for non-HTML planes)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    expect('html' in json.objects[0]).toBe(false);
  });

  it('tolerates a pre-v13 file (no html key) → object loads without a payload', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.version = 12; // pre-UR7 file
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    expect(dst.objects[0].html).toBeUndefined();
  });

  it('clamps a serialized fps out of range and defaults missing numeric fields', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.objects[0].html = { kind: 'file', source: '<i/>', fps: 999, playing: true };
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    const h = dst.objects[0].html!;
    expect(h.fps).toBe(15); // clamped 1..15
    expect(h.pageW).toBe(1024);
    expect(h.pageH).toBe(768);
    expect(h.scrollY).toBe(0);
    expect(h.playing).toBe(true);
  });

  it('rejects an html payload with a bad kind', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    json.objects[0].html = { kind: 'nope', source: '<i/>' };
    expect(() => applySceneJson(JSON.stringify(json), new Scene(), new OrbitCamera())).toThrow(/html\.kind/);
  });
});

describe('sceneJson camera DoF + Glare (v17 / UR10-2)', () => {
  it('round-trips fStop / dof and a glare payload', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const cam = scene.addCamera('Cam');
    cam.camera!.dof = true;
    cam.camera!.fStop = 5.6;
    cam.camera!.glare = { enabled: true, threshold: 1.2, strength: 0.75, radius: 0.08 };
    const s1 = serializeScene(scene, new OrbitCamera());
    const dst = new Scene();
    applySceneJson(s1, dst, new OrbitCamera());
    const rc = dst.objects.find((o) => o.kind === 'camera')!.camera!;
    expect(rc.dof).toBe(true);
    expect(rc.fStop).toBeCloseTo(5.6, 6);
    expect(rc.glare).toEqual({ enabled: true, threshold: 1.2, strength: 0.75, radius: 0.08 });
    // Byte-identical re-serialize.
    expect(serializeScene(dst, new OrbitCamera())).toBe(s1);
  });

  it('a camera with no glare serializes without a glare key (pre-UR10-2 shape)', () => {
    const scene = new Scene();
    scene.addCamera('Cam');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    const camObj = json.objects.find((o: { kind: string }) => o.kind === 'camera');
    expect(camObj.camera.glare).toBeUndefined();
    expect(camObj.camera.dof).toBe(false);
    expect(camObj.camera.fStop).toBeCloseTo(2.8, 6);
  });

  it('MIGRATION: a raw aperture loads as fStop = focal/(2000·aperture), DoF on', () => {
    const scene = new Scene();
    scene.addCamera('Cam');
    const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
    const camObj = json.objects.find((o: { kind: string }) => o.kind === 'camera');
    // Simulate an old save that stored a thin-lens aperture radius, no fStop/dof.
    delete camObj.camera.fStop;
    delete camObj.camera.dof;
    camObj.camera.aperture = 0.02; // focal 50 → fStop = 50/(2000·0.02) = 1.25
    const dst = new Scene();
    applySceneJson(JSON.stringify(json), dst, new OrbitCamera());
    const rc = dst.objects.find((o) => o.kind === 'camera')!.camera!;
    expect(rc.dof).toBe(true);
    expect(rc.fStop).toBeCloseTo(1.25, 6);
  });
});

// UR16-1 — shader model v2: legacy-material migration + v20 socket round-trips.
import { setMaterialChannel, materialShader, type GradientInput } from '../core/scene/objectData';

/** Build a v19 (legacy-format) scene JSON with a single cube + one legacy
 *  material, so we can prove migration to the shader model. */
function v19Scene(legacyMat: Record<string, unknown>): string {
  const scene = new Scene();
  scene.add('Cube', makeCube());
  const json = JSON.parse(serializeScene(scene, new OrbitCamera()));
  json.version = 19;
  json.materials = [{
    id: 0, name: 'M', baseColor: [0.4, 0.5, 0.6], metallic: 0.2, roughness: 0.7,
    emissive: [0, 0, 0], emissiveStrength: 0, subsurfaceWeight: 0, subsurfaceRadius: 0.05,
    texKind: 'none', texDataUrl: null, normalDataUrl: null, normalIsBump: false,
    normalStrength: 1, roughDataUrl: null, metalDataUrl: null, nodeGraph: null, useNodes: false,
    ...legacyMat,
  }];
  json.objects[0].materialId = 0;
  return JSON.stringify(json);
}

describe('sceneJson shader-model migration (v20 / UR16-1)', () => {
  const cases: { name: string; legacy: Record<string, unknown>; shader: string }[] = [
    { name: 'plain lit material → super', legacy: {}, shader: 'super' },
    { name: 'shadeless material → emit', legacy: { shadeless: true }, shader: 'emit' },
    { name: 'shadeless image plane → emit', legacy: { shadeless: true, texKind: 'image', texDataUrl: 'data:x', alwaysTextured: true }, shader: 'emit' },
    { name: 'diffuse-mode image plane → diffuse', legacy: { texKind: 'image', texDataUrl: 'data:x', alwaysTextured: true }, shader: 'diffuse' },
    { name: 'metallic material → super (fields honored)', legacy: { metallic: 1 }, shader: 'super' },
    { name: 'glass material → super (fields honored)', legacy: { transmission: 1, ior: 1.5 }, shader: 'super' },
  ];
  for (const c of cases) {
    it(`migrates ${c.name}`, () => {
      const scene = new Scene();
      applySceneJson(v19Scene(c.legacy), scene, new OrbitCamera());
      const m = scene.materials[0];
      expect(materialShader(m)).toBe(c.shader);
      // Migration is RENDER-NEUTRAL: the runtime fields are unchanged from legacy.
      expect(m.roughness).toBe(c.legacy.roughness ?? 0.7);
      expect(m.metallic).toBe(c.legacy.metallic ?? 0.2);
      expect(m.shadeless === true).toBe(c.legacy.shadeless === true);
      expect(m.alpha).toEqual({ kind: 'value', value: 1 }); // legacy materials are opaque
    });
  }

  it('migrated material re-serializes as v20 and round-trips byte-identically', () => {
    const scene = new Scene();
    applySceneJson(v19Scene({ shadeless: true, texKind: 'image', texDataUrl: 'data:x', alwaysTextured: true }), scene, new OrbitCamera());
    const a = serializeScene(scene, new OrbitCamera());
    expect(JSON.parse(a).version).toBe(20);
    const scene2 = new Scene();
    applySceneJson(a, scene2, new OrbitCamera());
    expect(serializeScene(scene2, new OrbitCamera())).toBe(a);
  });
});

describe('sceneJson v20 socket round-trip (UR16-1)', () => {
  it('color gradient + alpha value survive serialize→apply→serialize', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const mat = scene.addMaterial('G');
    scene.objects[0].materialId = mat.id;
    const grad: GradientInput = { kind: 'gradient', a: [1, 0, 0], b: [0, 0, 1], axis: 'z', offset: 0.25, scale: 0.5 };
    setMaterialChannel(mat, 'color', grad);
    setMaterialChannel(mat, 'alpha', { kind: 'value', value: 0.5 });
    const a = serializeScene(scene, new OrbitCamera());
    const scene2 = new Scene();
    applySceneJson(a, scene2, new OrbitCamera());
    const m2 = scene2.materials[0];
    expect(m2.colorGradient).toEqual(grad);
    expect(m2.alpha).toEqual({ kind: 'value', value: 0.5 });
    // Byte-identical round trip.
    expect(serializeScene(scene2, new OrbitCamera())).toBe(a);
  });

  it('gradient alpha channel survives round-trip', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const mat = scene.addMaterial('A');
    scene.objects[0].materialId = mat.id;
    const grad: GradientInput = { kind: 'gradient', a: [0, 0, 0], b: [1, 0, 0], axis: 'y', offset: 0, scale: 1 };
    setMaterialChannel(mat, 'alpha', grad);
    const a = serializeScene(scene, new OrbitCamera());
    const scene2 = new Scene();
    applySceneJson(a, scene2, new OrbitCamera());
    expect(scene2.materials[0].alpha).toEqual(grad);
    expect(serializeScene(scene2, new OrbitCamera())).toBe(a);
  });
});

describe('sceneJson v20 value-under-map survives round trip (UR16-1 verify catch)', () => {
  // Engines compute value × map — the socket format must carry BOTH. The
  // original v20 serializer dropped the value when a map was present
  // (baseColor tint → [1,1,1], metallic 0.9 → 0 on save→load).
  it('keeps baseColor tint under an image texture', () => {
    const scene = new Scene();
    scene.add('Tinted', makeCube(1));
    const mat = scene.addMaterial('Tinted');
    scene.objects[0].materialId = mat.id;
    mat.baseColor = [0.4, 0.5, 0.6];
    mat.texKind = 'image';
    mat.texDataUrl = 'data:image/png;base64,AAAA';
    const json = serializeScene(scene, new OrbitCamera());
    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    expect(scene2.materials[0].baseColor).toEqual([0.4, 0.5, 0.6]);
    expect(scene2.materials[0].texKind).toBe('image');
    expect(serializeScene(scene2, new OrbitCamera())).toBe(json);
  });

  it('keeps roughness/metallic values under their maps', () => {
    const scene = new Scene();
    scene.add('Mapped', makeCube(1));
    const mat = scene.addMaterial('Mapped');
    scene.objects[0].materialId = mat.id;
    mat.roughness = 0.3;
    mat.roughDataUrl = 'data:image/png;base64,BBBB';
    mat.metallic = 0.9;
    mat.metalDataUrl = 'data:image/png;base64,CCCC';
    const json = serializeScene(scene, new OrbitCamera());
    const scene2 = new Scene();
    applySceneJson(json, scene2, new OrbitCamera());
    expect(scene2.materials[0].roughness).toBeCloseTo(0.3);
    expect(scene2.materials[0].metallic).toBeCloseTo(0.9);
    expect(serializeScene(scene2, new OrbitCamera())).toBe(json);
  });
});
