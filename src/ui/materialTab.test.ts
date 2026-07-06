import { describe, it, expect } from 'vitest';
import { Scene } from '../core/scene/Scene';
import { makeCube } from '../core/mesh/primitives';
import {
  AssignMaterialCommand,
  MaterialEditCommand,
  NewMaterialCommand,
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
