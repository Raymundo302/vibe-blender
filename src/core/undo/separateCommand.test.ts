import { describe, it, expect } from 'vitest';
import { Scene } from '../scene/Scene';
import { makeCube } from '../mesh/primitives';
import { SeparateCommand } from './separateCommand';

/** Enter edit mode on a fresh cube in face mode, returning [scene, source]. */
function editCube() {
  const scene = new Scene();
  const source = scene.add('Cube', makeCube());
  scene.selectOnly(source.id);
  scene.enterEditMode();
  scene.editMode!.elementMode = 'face';
  return { scene, source };
}

describe('SeparateCommand.perform guards (return null, no-op)', () => {
  it('refuses to separate the WHOLE mesh: returns null, source intact, no new object', () => {
    const { scene, source } = editCube();
    for (const id of source.mesh.faces.keys()) scene.editMode!.faces.add(id);

    const before = source.mesh.faces.size; // 6
    const cmd = SeparateCommand.perform('Separate', scene);

    expect(cmd).toBeNull();
    expect(scene.objects.length).toBe(1); // no `.sep` object created
    expect(source.mesh.faces.size).toBe(before); // mesh untouched
    expect(source.mesh.verts.size).toBe(8);
  });

  it('refuses an EMPTY selection: returns null, no new object', () => {
    const { scene } = editCube();
    // no faces selected
    expect(SeparateCommand.perform('Separate', scene)).toBeNull();
    expect(scene.objects.length).toBe(1);
  });

  it('refuses when NOT in face mode: returns null', () => {
    const { scene, source } = editCube();
    scene.editMode!.elementMode = 'vert';
    scene.editMode!.faces.add([...source.mesh.faces.keys()][0]);
    expect(SeparateCommand.perform('Separate', scene)).toBeNull();
    expect(scene.objects.length).toBe(1);
  });

  it('refuses when NOT in edit mode: returns null', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    expect(SeparateCommand.perform('Separate', scene)).toBeNull();
  });
});

describe('SeparateCommand.perform (happy path + undo/redo)', () => {
  it('separates one face into a `<name>.sep` object and undo/redo restores both sides', () => {
    const { scene, source } = editCube();
    const faceId = [...source.mesh.faces.keys()][0];
    scene.editMode!.faces.add(faceId);

    const cmd = SeparateCommand.perform('Separate', scene)!;
    expect(cmd).not.toBeNull();

    // Source drops the face; a new object appears with the extracted shell.
    expect(scene.objects.length).toBe(2);
    expect(source.mesh.faces.size).toBe(5);
    expect(source.mesh.verts.size).toBe(8); // seam verts kept
    const created = scene.objects[1];
    expect(created.name).toBe('Cube.sep');
    expect(created.mesh.faces.size).toBe(1);
    expect(created.mesh.verts.size).toBe(4);
    // Inherits source transform/color/shadeSmooth.
    expect(created.color).toEqual(source.color);
    expect(created.shadeSmooth).toBe(source.shadeSmooth);
    // Still editing the source.
    expect(scene.editObject).toBe(source);

    cmd.undo();
    expect(scene.objects.length).toBe(1);
    expect(source.mesh.faces.size).toBe(6);

    cmd.redo();
    expect(scene.objects.length).toBe(2);
    expect(source.mesh.faces.size).toBe(5);
  });
});
