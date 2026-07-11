import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { UndoStack } from '../core/undo/UndoStack';
import { Vec3 } from '../core/math/vec3';
import {
  basename,
  createImagePlane,
  makeImagePlaneMesh,
} from './imagePlane';

// A stubbed data URL — createImagePlane never decodes it (w/h are passed
// explicitly), and there is no DOM in the node test env, so the async tracer
// decode short-circuits to a no-op.
const DATA_URL = 'data:image/png;base64,AAAA';

describe('makeImagePlaneMesh', () => {
  it('keeps the image aspect: width 2·(w/h), height 2, normal +Z', () => {
    const mesh = makeImagePlaneMesh(400, 200); // aspect 2 → half-width 2
    const xs = [...mesh.verts.values()].map((v) => v.co.x);
    const ys = [...mesh.verts.values()].map((v) => v.co.y);
    expect(Math.max(...xs)).toBeCloseTo(2);
    expect(Math.min(...xs)).toBeCloseTo(-2);
    expect(Math.max(...ys)).toBeCloseTo(1);
    expect(Math.min(...ys)).toBeCloseTo(-1);
    // Single quad, fully UV-unwrapped 0..1.
    expect(mesh.faces.size).toBe(1);
    const faceId = [...mesh.faces.keys()][0];
    const uvs = mesh.uvs.get(faceId)!;
    expect(uvs).toHaveLength(4);
    const us = uvs.map(([u]) => u);
    const vs = uvs.map(([, v]) => v);
    expect(Math.min(...us)).toBe(0);
    expect(Math.max(...us)).toBe(1);
    expect(Math.min(...vs)).toBe(0);
    expect(Math.max(...vs)).toBe(1);
  });

  it('maps +Y to the image top (v=0) and +X to the image right (u=1)', () => {
    const mesh = makeImagePlaneMesh(100, 100);
    const faceId = [...mesh.faces.keys()][0];
    const face = mesh.faces.get(faceId)!;
    const uvs = mesh.uvs.get(faceId)!;
    for (let i = 0; i < face.verts.length; i++) {
      const v = mesh.verts.get(face.verts[i])!;
      const [u, vv] = uvs[i];
      // +Y corner → top of image (v=0); -Y → bottom (v=1).
      expect(vv).toBe(v.co.y > 0 ? 0 : 1);
      // +X corner → right of image (u=1); -X → left (u=0).
      expect(u).toBe(v.co.x > 0 ? 1 : 0);
    }
  });

  it('falls back to a unit square for degenerate dimensions', () => {
    const mesh = makeImagePlaneMesh(0, 0);
    const xs = [...mesh.verts.values()].map((v) => v.co.x);
    expect(Math.max(...xs)).toBeCloseTo(1);
    expect(xs.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('createImagePlane', () => {
  it('adds a diffuse plane: object named by basename, material wired', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const obj = createImagePlane(scene, undo, {
      dataUrl: DATA_URL, name: 'blueprint', w: 300, h: 150, mode: 'diffuse',
    });

    expect(scene.objects).toContain(obj);
    expect(obj.name).toBe('blueprint');
    expect(obj.kind).toBe('mesh');
    // Material added to the library and assigned.
    expect(scene.materials).toHaveLength(1);
    const mat = scene.materials[0];
    expect(obj.materialId).toBe(mat.id);
    expect(mat.name).toBe('blueprint');
    expect(mat.texKind).toBe('image');
    expect(mat.texDataUrl).toBe(DATA_URL);
    expect(mat.baseColor).toEqual([1, 1, 1]);
    expect(mat.roughness).toBe(1);
    expect(mat.metallic).toBe(0);
    expect(mat.shadeless).toBe(false);
    // Selected + spawned at the 3D cursor.
    expect(scene.activeId).toBe(obj.id);
    expect(obj.transform.position.x).toBeCloseTo(scene.cursor.x);
    // Aspect carried into the geometry (width 2·2 = 4 across).
    const xs = [...obj.mesh.verts.values()].map((v) => v.co.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4);
  });

  it('spawns at a non-origin 3D cursor', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    scene.cursor = new Vec3(3, -2, 5);
    const obj = createImagePlane(scene, undo, {
      dataUrl: DATA_URL, name: 'ref', w: 100, h: 100, mode: 'diffuse',
    });
    expect(obj.transform.position.x).toBeCloseTo(3);
    expect(obj.transform.position.y).toBeCloseTo(-2);
    expect(obj.transform.position.z).toBeCloseTo(5);
  });

  it('emit variant sets shadeless true', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    createImagePlane(scene, undo, {
      dataUrl: DATA_URL, name: 'emit', w: 100, h: 100, mode: 'emit',
    });
    expect(scene.materials[0].shadeless).toBe(true);
  });

  it('one undo removes BOTH the plane and its material; redo restores them', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    const obj = createImagePlane(scene, undo, {
      dataUrl: DATA_URL, name: 'plan', w: 200, h: 100, mode: 'diffuse',
    });
    const matId = scene.materials[0].id;
    expect(scene.objects).toHaveLength(1);
    expect(scene.materials).toHaveLength(1);

    undo.undo();
    expect(scene.objects).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);

    undo.redo();
    expect(scene.objects).toHaveLength(1);
    expect(scene.materials).toHaveLength(1);
    expect(scene.objects[0].id).toBe(obj.id);
    expect(scene.materials[0].id).toBe(matId);
    // Assignment restored.
    expect(scene.objects[0].materialId).toBe(matId);
  });

  it('restores the material at its original index on redo (serialize order stable)', () => {
    const scene = new Scene();
    const undo = new UndoStack();
    scene.addMaterial('First');
    scene.addMaterial('Second');
    createImagePlane(scene, undo, {
      dataUrl: DATA_URL, name: 'img', w: 100, h: 100, mode: 'diffuse',
    });
    expect(scene.materials.map((m) => m.name)).toEqual(['First', 'Second', 'img']);
    undo.undo();
    expect(scene.materials.map((m) => m.name)).toEqual(['First', 'Second']);
    undo.redo();
    expect(scene.materials.map((m) => m.name)).toEqual(['First', 'Second', 'img']);
  });
});

describe('basename', () => {
  it('strips directory and extension', () => {
    expect(basename('plan.png')).toBe('plan');
    expect(basename('refs/site/floor-1.JPEG')).toBe('floor-1');
    expect(basename('C:\\images\\wall.webp')).toBe('wall');
    expect(basename('noext')).toBe('noext');
    expect(basename('.hidden')).toBe('.hidden'); // no real extension to strip
  });
});
