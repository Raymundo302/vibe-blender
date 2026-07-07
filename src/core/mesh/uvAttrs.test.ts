import { describe, expect, it } from 'vitest';
import { makeCube } from './primitives';
import { meshToRenderData } from './meshToGpu';
import { Scene } from '../scene/Scene';
import { OrbitCamera } from '../../camera/OrbitCamera';
import { serializeScene, applySceneJson } from '../../io/sceneJson';

describe('UV + seam attributes (P11 core)', () => {
  it('setFaceUVs validates corner count, clones, and clears', () => {
    const mesh = makeCube();
    const faceId = [...mesh.faces.keys()][0];
    expect(() => mesh.setFaceUVs(faceId, [[0, 0]])).toThrow(/corners/);
    const quad: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    mesh.setFaceUVs(faceId, quad);
    expect(mesh.clone().uvs.get(faceId)).toEqual(quad);
    quad[0][0] = 9; // caller mutation must not leak in
    expect(mesh.uvs.get(faceId)![0][0]).toBe(0);
    mesh.setFaceUVs(faceId, null);
    expect(mesh.uvs.size).toBe(0);
  });

  it('seams survive clone/copyFrom and setSeam toggles', () => {
    const mesh = makeCube();
    const [a, b] = [...mesh.verts.keys()];
    mesh.setSeam(a, b, true);
    expect(mesh.isSeam(a, b)).toBe(true);
    expect(mesh.clone().isSeam(a, b)).toBe(true);
    mesh.setSeam(a, b, false);
    expect(mesh.seams.size).toBe(0);
  });

  it('UVs land in the GPU corner stream (0,0 for un-uvd faces)', () => {
    const mesh = makeCube();
    const faceId = [...mesh.faces.keys()][0];
    mesh.setFaceUVs(faceId, [[0.25, 0.5], [1, 0], [1, 1], [0, 1]]);
    const data = meshToRenderData(mesh);
    expect(data.triangleUVs.length).toBe(data.triangleCount * 6);
    expect(data.triangleUVs[0]).toBe(0.25);
    expect(data.triangleUVs[1]).toBe(0.5);
    expect(data.triangleUVs[data.triangleUVs.length - 1]).toBe(0);
  });

  it('UVs, seams, and material textures round-trip byte-identically', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    const obj = scene.add('Cube', makeCube());
    const faceId = [...obj.mesh.faces.keys()][2];
    obj.mesh.setFaceUVs(faceId, [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]);
    const [a, b] = [...obj.mesh.verts.keys()];
    obj.mesh.setSeam(a, b, true);
    const mat = scene.addMaterial('Checkered');
    mat.texKind = 'checker';
    obj.materialId = mat.id;
    const img = scene.addMaterial('Pic');
    img.texKind = 'image';
    img.texDataUrl = 'data:image/png;base64,AAAA';

    const s1 = serializeScene(scene, camera);
    applySceneJson(s1, scene, camera);
    expect(serializeScene(scene, camera)).toBe(s1);
    const obj2 = scene.objects[0];
    expect(obj2.mesh.uvs.size).toBe(1);
    expect(obj2.mesh.seams.size).toBe(1);
    expect(scene.materials[0].texKind).toBe('checker');
    expect(scene.materials[1].texDataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('rejects a uv entry with the wrong pair count', () => {
    const scene = new Scene();
    scene.add('Keep', makeCube());
    const bad = JSON.stringify({
      format: 'vibe-blender-scene', version: 3,
      camera: { target: [0, 0, 0], distance: 8, yaw: 0, pitch: 0 },
      activeCamera: null, collections: [], materials: [],
      objects: [{
        name: 'X', kind: 'mesh', visible: true, shadeSmooth: false,
        color: [0.69, 0.69, 0.69], materialId: null, collection: null,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { verts: [[0, 0, 0, 0], [1, 1, 0, 0], [2, 0, 1, 0]], faces: [[0, [0, 1, 2]]], uvs: [[0, 0.1, 0.2]] },
        modifiers: [],
      }],
    });
    expect(() => applySceneJson(bad, scene, new OrbitCamera())).toThrow(/uv pairs/i);
    expect(scene.objects.map((o) => o.name)).toEqual(['Keep']);
  });
});
