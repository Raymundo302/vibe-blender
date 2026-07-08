import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { makeCube } from '../core/mesh/primitives';
import { srgbToLinear } from '../core/scene/worldData';
import {
  AssignMaterialCommand,
  MaterialEditCommand,
  NewMaterialCommand,
  MapImageEditCommand,
  MapParamEditCommand,
  decodeRawTextureDataUrl,
  hexToRgb,
  rgbToHex,
} from './materialTab';

function sceneWithCube(): { scene: Scene; obj: ReturnType<Scene['add']> } {
  const scene = new Scene();
  const obj = scene.add('Cube', makeCube());
  scene.selectOnly(obj.id);
  return { scene, obj };
}

describe('color helpers', () => {
  it('round-trips a color through hex', () => {
    expect(rgbToHex([1, 0, 0])).toBe('#ff0000');
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(rgbToHex([0, 0, 0])).toBe('#000000');
  });
});

describe('NewMaterialCommand', () => {
  it('creates + assigns in one step, and round-trips under undo/redo keeping the SAME id', () => {
    const { scene, obj } = sceneWithCube();
    expect(obj.materialId).toBeNull();
    expect(scene.materials.length).toBe(0);

    const cmd = NewMaterialCommand.perform(scene, obj);
    const id = cmd.material.id;
    expect(scene.materials.length).toBe(1);
    expect(obj.materialId).toBe(id);
    expect(scene.getMaterial(id)).toBeDefined();

    cmd.undo();
    expect(scene.materials.length).toBe(0);
    expect(scene.getMaterial(id)).toBeUndefined();
    expect(obj.materialId).toBeNull();

    cmd.redo();
    expect(scene.materials.length).toBe(1);
    // id stability: the redone material carries the very same id.
    expect(scene.materials[0].id).toBe(id);
    expect(scene.getMaterial(id)).toBeDefined();
    expect(obj.materialId).toBe(id);
  });

  it('restores a prior assignment on undo (not always null)', () => {
    const { scene, obj } = sceneWithCube();
    const first = scene.addMaterial('First');
    obj.materialId = first.id;

    const cmd = NewMaterialCommand.perform(scene, obj);
    expect(obj.materialId).toBe(cmd.material.id);
    cmd.undo();
    expect(obj.materialId).toBe(first.id); // prior assignment restored
    cmd.redo();
    expect(obj.materialId).toBe(cmd.material.id);
  });

  it('does not double-insert the material on a second redo', () => {
    const { scene, obj } = sceneWithCube();
    const cmd = NewMaterialCommand.perform(scene, obj);
    cmd.undo();
    cmd.redo();
    cmd.undo();
    cmd.redo();
    expect(scene.materials.filter((m) => m.id === cmd.material.id).length).toBe(1);
  });
});

describe('AssignMaterialCommand', () => {
  it('round-trips a slot assignment under undo/redo', () => {
    const { scene, obj } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const before = obj.materialId; // null
    obj.materialId = mat.id;
    const cmd = new AssignMaterialCommand(obj, before, mat.id);

    cmd.undo();
    expect(obj.materialId).toBeNull();
    cmd.redo();
    expect(obj.materialId).toBe(mat.id);
  });

  it('round-trips clearing a slot to (None)', () => {
    const { scene, obj } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    obj.materialId = mat.id;
    const cmd = new AssignMaterialCommand(obj, mat.id, null);
    obj.materialId = null;

    cmd.undo();
    expect(obj.materialId).toBe(mat.id);
    cmd.redo();
    expect(obj.materialId).toBeNull();
  });
});

describe('MaterialEditCommand', () => {
  it('round-trips a scalar field (roughness)', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const before = mat.roughness;
    mat.roughness = 0.2;
    const cmd = new MaterialEditCommand(mat, 'roughness', before, 0.2);
    cmd.undo();
    expect(mat.roughness).toBe(before);
    cmd.redo();
    expect(mat.roughness).toBe(0.2);
  });

  it('round-trips a color field without aliasing snapshots', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const before: [number, number, number] = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
    const after: [number, number, number] = [1, 0, 0];
    mat.baseColor = [after[0], after[1], after[2]];
    const cmd = new MaterialEditCommand(mat, 'baseColor', before, after);

    cmd.undo();
    expect(mat.baseColor).toEqual(before);
    // Mutating the material must not corrupt the stored snapshots.
    mat.baseColor[0] = 0.123;
    cmd.redo();
    expect(mat.baseColor).toEqual([1, 0, 0]);
  });

  it('round-trips the name field', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Old');
    mat.name = 'New';
    const cmd = new MaterialEditCommand(mat, 'name', 'Old', 'New');
    cmd.undo();
    expect(mat.name).toBe('Old');
    cmd.redo();
    expect(mat.name).toBe('New');
  });
});

// -------------------------------------------------------------- P13 map slots --

/** Install minimal Image + document stubs so decodeRawTextureDataUrl can run in
 * the node test env. Every decoded pixel is the byte `value` in all channels. */
function stubDecode(value: number, w = 1, h = 1): void {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
  }
  class MockImage {
    naturalWidth = w;
    naturalHeight = h;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) { this.onload?.(); }
  }
  const doc = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data }),
      }),
    }),
  };
  vi.stubGlobal('Image', MockImage);
  vi.stubGlobal('document', doc);
}

describe('decodeRawTextureDataUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces UNconverted 0..1 values (byte 128 → ≈0.502, not sRGB 0.216)', async () => {
    stubDecode(128);
    const img = await decodeRawTextureDataUrl('data:image/png;base64,xxx');
    expect(img.width).toBe(1);
    expect(img.height).toBe(1);
    // Raw: 128/255 ≈ 0.50196.
    expect(img.pixels[0]).toBeCloseTo(0.502, 3);
    // And explicitly NOT the sRGB-linearized value the base-color decoder uses.
    expect(srgbToLinear(128 / 255)).toBeCloseTo(0.216, 3);
    expect(img.pixels[0]).not.toBeCloseTo(0.216, 2);
  });
});

describe('MapImageEditCommand', () => {
  it('round-trips a normal-map set (dataUrl + decoded cache together)', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const image = { width: 1, height: 1, pixels: new Float32Array([0.5, 0.5, 1]) };
    const before = { dataUrl: mat.normalDataUrl, image: mat.normalImage };
    mat.normalDataUrl = 'data:normal';
    mat.normalImage = image;
    const after = { dataUrl: mat.normalDataUrl, image: mat.normalImage };
    const cmd = new MapImageEditCommand(mat, 'normal', before, after);

    cmd.undo();
    expect(mat.normalDataUrl).toBeNull();
    expect(mat.normalImage).toBeUndefined();
    cmd.redo();
    expect(mat.normalDataUrl).toBe('data:normal');
    expect(mat.normalImage).toBe(image);
  });

  it('round-trips a roughness-map clear', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const image = { width: 1, height: 1, pixels: new Float32Array([0.3, 0.3, 0.3]) };
    mat.roughDataUrl = 'data:rough';
    mat.roughImage = image;
    const before = { dataUrl: mat.roughDataUrl, image: mat.roughImage };
    mat.roughDataUrl = null;
    mat.roughImage = undefined;
    const cmd = new MapImageEditCommand(mat, 'rough', before, { dataUrl: null, image: undefined });

    cmd.undo();
    expect(mat.roughDataUrl).toBe('data:rough');
    expect(mat.roughImage).toBe(image);
    cmd.redo();
    expect(mat.roughDataUrl).toBeNull();
    expect(mat.roughImage).toBeUndefined();
  });
});

describe('MapParamEditCommand', () => {
  it('round-trips the normalStrength slider', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    const before = mat.normalStrength; // 1
    mat.normalStrength = 1.75;
    const cmd = new MapParamEditCommand(mat, 'normalStrength', before, 1.75);
    cmd.undo();
    expect(mat.normalStrength).toBe(before);
    cmd.redo();
    expect(mat.normalStrength).toBe(1.75);
  });

  it('round-trips the normalIsBump toggle', () => {
    const { scene } = sceneWithCube();
    const mat = scene.addMaterial('Mat');
    expect(mat.normalIsBump).toBe(false);
    mat.normalIsBump = true;
    const cmd = new MapParamEditCommand(mat, 'normalIsBump', false, true);
    cmd.undo();
    expect(mat.normalIsBump).toBe(false);
    cmd.redo();
    expect(mat.normalIsBump).toBe(true);
  });
});
