import { describe, expect, it } from 'vitest';
import { Scene } from './Scene';
import { makeCube } from '../mesh/primitives';
import { OrbitCamera } from '../../camera/OrbitCamera';
import { serializeScene, applySceneJson } from '../../io/sceneJson';

describe('collections (P10 core)', () => {
  it('add/remove: members drop to the scene root on removal', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const col = scene.addCollection('Props');
    obj.collectionId = col.id;
    expect(scene.getCollection(col.id)?.name).toBe('Props');
    scene.removeCollection(col.id);
    expect(obj.collectionId).toBeNull();
    expect(scene.collections.length).toBe(0);
  });

  it('effectiveVisible honors object AND collection visibility', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    expect(scene.effectiveVisible(obj)).toBe(true);
    const col = scene.addCollection();
    obj.collectionId = col.id;
    expect(scene.effectiveVisible(obj)).toBe(true);
    col.visible = false;
    expect(scene.effectiveVisible(obj)).toBe(false);
    col.visible = true;
    obj.visible = false;
    expect(scene.effectiveVisible(obj)).toBe(false);
  });

  it('duplicate keeps the collection assignment', () => {
    const scene = new Scene();
    const obj = scene.add('Cube', makeCube());
    const col = scene.addCollection();
    obj.collectionId = col.id;
    expect(scene.duplicate(obj, 'Cube.001').collectionId).toBe(col.id);
  });

  it('serializes as indices and round-trips byte-identically with id gaps', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    const doomed = scene.addCollection('Doomed');
    const props = scene.addCollection('Props');
    scene.removeCollection(doomed.id); // leave an id gap (ids 0 gone, 1 alive)
    const a = scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    a.collectionId = props.id;
    props.visible = false;
    void b;

    const s1 = serializeScene(scene, camera);
    expect(JSON.parse(s1).collections).toEqual([{ name: 'Props', visible: false }]);
    expect(JSON.parse(s1).objects[0].collection).toBe(0);
    expect(JSON.parse(s1).objects[1].collection).toBeNull();

    applySceneJson(s1, scene, camera);
    const s2 = serializeScene(scene, camera);
    expect(s2).toBe(s1);
    // Membership + visibility survived the rebuild.
    const a2 = scene.objects.find((o) => o.name === 'A')!;
    expect(scene.getCollection(a2.collectionId!)?.name).toBe('Props');
    expect(scene.effectiveVisible(a2)).toBe(false);
  });

  it('rejects an out-of-range collection index without mutating the scene', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCamera: null, collections: [], materials: [],
      objects: [{
        name: 'X', kind: 'mesh', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null, collection: 2,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 0, 1, 0]], faces: [[0, [0, 1, 2]]] },
        modifiers: [],
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/out of range/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });
});
