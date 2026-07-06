import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { subdivideFaces } from './subdivide';

/** Unit cube (±1). Face ids are the add order below: f0 bottom .. f5 -X. */
function cube(): EditableMesh {
  return EditableMesh.fromData(
    [
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], // 0..3 bottom
      [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],      // 4..7 top
    ],
    [
      [0, 3, 2, 1], // f0 -Y (bottom)
      [4, 5, 6, 7], // f1 +Y (top)
      [0, 1, 5, 4], // f2 -Z
      [2, 3, 7, 6], // f3 +Z
      [1, 2, 6, 5], // f4 +X
      [3, 0, 4, 7], // f5 -X
    ],
  );
}

/** Euler characteristic V - E + F for a closed manifold should be 2. */
function euler(mesh: EditableMesh): number {
  return mesh.verts.size - mesh.edges().size + mesh.faces.size;
}

describe('subdivideFaces', () => {
  it('splits one cube quad → 4 quads (8→13 verts, 6→9 faces)', () => {
    const mesh = cube();
    const res = subdivideFaces(mesh, [0]);

    // 4 edge midpoints + 1 center = 5 new verts.
    expect(mesh.verts.size).toBe(13);
    expect(mesh.faces.size).toBe(9);
    expect(res.newFaceIds.length).toBe(4);
    for (const fid of res.newFaceIds) expect(mesh.faces.get(fid)!.verts.length).toBe(4);
    // The original face is gone.
    expect(mesh.faces.has(0)).toBe(false);
  });

  it('shares the seam midpoint when subdividing two ADJACENT faces (17 verts, not 19)', () => {
    const mesh = cube();
    // f0 (bottom) and f2 (-Z) share edge (0,1) → that midpoint is made once.
    subdivideFaces(mesh, [0, 2]);
    // 7 distinct edges across the two quads → 7 midpoints + 2 centers = 9 new.
    expect(mesh.verts.size).toBe(8 + 7 + 2);
    expect(mesh.verts.size).toBe(17);
    expect(mesh.faces.size).toBe(6 - 2 + 8);
    expect(mesh.faces.size).toBe(12);
  });

  it('subdividing the whole cube stays a closed 2-manifold', () => {
    const mesh = cube();
    subdivideFaces(mesh, [0, 1, 2, 3, 4, 5]);
    // 12 edges → 12 midpoints, 6 faces → 6 centers: 8 + 12 + 6 = 26 verts.
    expect(mesh.verts.size).toBe(26);
    expect(mesh.faces.size).toBe(24);
    // Every edge shared by exactly two faces (manifold), Euler = 2.
    for (const e of mesh.edges().values()) expect(e.faces.length).toBe(2);
    expect(euler(mesh)).toBe(2);
  });

  it('splits a triangle → 4 triangles with no center vert (3→6 verts)', () => {
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [2, 0, 0], [0, 0, 2]],
      [[0, 1, 2]],
    );
    const res = subdivideFaces(mesh, [0]);
    expect(mesh.verts.size).toBe(6); // 3 midpoints, no center
    expect(mesh.faces.size).toBe(4);
    expect(res.newFaceIds.length).toBe(4);
    for (const fid of res.newFaceIds) expect(mesh.faces.get(fid)!.verts.length).toBe(3);
  });
});
