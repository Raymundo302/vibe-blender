import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { mergeByDistance } from './mergeByDistance';

/** Two quads side by side whose shared seam verts are DUPLICATED (doubled). */
function twoQuadsDoubledSeam(): EditableMesh {
  return EditableMesh.fromData(
    [
      [0, 0, 0], // 0
      [1, 0, 0], // 1  (seam)
      [1, 0, 1], // 2  (seam)
      [0, 0, 1], // 3
      [1, 0, 0], // 4  coincident with 1
      [2, 0, 0], // 5
      [2, 0, 1], // 6
      [1, 0, 1], // 7  coincident with 2
    ],
    [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  );
}

describe('mergeByDistance', () => {
  it('merges two coincident clusters, reports the removed count', () => {
    const mesh = twoQuadsDoubledSeam();
    const removed = mergeByDistance(mesh, [...mesh.verts.keys()]);
    expect(removed).toBe(2); // {1,4} and {2,7} each drop one vert
    expect(mesh.verts.size).toBe(6);
  });

  it('lowest id survives and faces remap onto it', () => {
    const mesh = twoQuadsDoubledSeam();
    mergeByDistance(mesh, [...mesh.verts.keys()]);
    // Survivors are the lowest ids (1 and 2); 4 and 7 are gone.
    expect(mesh.verts.has(4)).toBe(false);
    expect(mesh.verts.has(7)).toBe(false);
    expect(mesh.verts.has(1)).toBe(true);
    expect(mesh.verts.has(2)).toBe(true);
    // The second quad now references the survivors.
    const faceB = [...mesh.faces.values()][1];
    expect(faceB.verts).toContain(1);
    expect(faceB.verts).toContain(2);
    expect(faceB.verts).not.toContain(4);
    expect(faceB.verts).not.toContain(7);
    expect(mesh.faces.size).toBe(2); // neither face degenerated
  });

  it('verts farther than the threshold survive', () => {
    const mesh = EditableMesh.fromData(
      [
        [0, 0, 0],
        [0.01, 0, 0], // 0.01 apart — beyond the default 0.0001 threshold
        [1, 0, 0],
        [1, 0, 1],
      ],
      [[0, 1, 2, 3]],
    );
    const removed = mergeByDistance(mesh, [...mesh.verts.keys()]);
    expect(removed).toBe(0);
    expect(mesh.verts.size).toBe(4);
  });

  it('respects a custom threshold', () => {
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [0.01, 0, 0], [1, 0, 0], [1, 0, 1]],
      [[0, 1, 2, 3]],
    );
    const removed = mergeByDistance(mesh, [...mesh.verts.keys()], 0.05);
    expect(removed).toBe(1);
    expect(mesh.verts.size).toBe(3);
  });

  it('fewer than two verts → no-op returning 0', () => {
    const mesh = twoQuadsDoubledSeam();
    expect(mergeByDistance(mesh, [0])).toBe(0);
    expect(mergeByDistance(mesh, [])).toBe(0);
    expect(mesh.verts.size).toBe(8);
  });
});
