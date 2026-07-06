import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { duplicateFaces } from './duplicateFaces';

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

describe('duplicateFaces', () => {
  it('duplicates one cube face → 12 verts / 7 faces, disjoint from the shell', () => {
    const mesh = cube();
    const res = duplicateFaces(mesh, [0]);

    expect(mesh.verts.size).toBe(12); // 8 + 4 copies
    expect(mesh.faces.size).toBe(7); // 6 + 1 copy
    expect(res.newVertIds.length).toBe(4);
    expect(res.newFaceIds.length).toBe(1);

    // The original shell is verts 0..7; the copy must share NONE of them.
    const original = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    const copyVerts = mesh.faces.get(res.newFaceIds[0])!.verts;
    expect(copyVerts.length).toBe(4);
    for (const v of copyVerts) expect(original.has(v)).toBe(false);
    for (const v of copyVerts) expect(res.newVertIds).toContain(v);

    // Winding is preserved: same corner order, remapped through the vert map.
    const src = mesh.faces.get(0)!.verts;
    expect(copyVerts).toEqual(src.map((v) => res.vertMap.get(v)));
  });

  it('two adjacent faces share their seam verts WITH EACH OTHER (6 new verts, not 8)', () => {
    const mesh = cube();
    // f0 (bottom [0,3,2,1]) and f2 (-Z [0,1,5,4]) share verts 0 and 1.
    const res = duplicateFaces(mesh, [0, 2]);

    // Union of the two faces' verts = {0,1,2,3,4,5} = 6 distinct → 6 copies.
    expect(res.newVertIds.length).toBe(6);
    expect(mesh.verts.size).toBe(14); // 8 + 6
    expect(mesh.faces.size).toBe(8); // 6 + 2
    expect(res.newFaceIds.length).toBe(2);

    const copyA = new Set(mesh.faces.get(res.newFaceIds[0])!.verts);
    const copyB = new Set(mesh.faces.get(res.newFaceIds[1])!.verts);
    // The two copies share exactly the two seam-vert copies (originals 0 and 1).
    const shared = [...copyA].filter((v) => copyB.has(v));
    expect(shared.length).toBe(2);
    expect(new Set(shared)).toEqual(new Set([res.vertMap.get(0), res.vertMap.get(1)]));

    // ...but neither copy shares any vert with the original shell.
    const original = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const v of [...copyA, ...copyB]) expect(original.has(v)).toBe(false);
  });

  it('ignores ids that are not faces and returns empty for an empty selection', () => {
    const mesh = cube();
    const res = duplicateFaces(mesh, [999]);
    expect(res.newVertIds.length).toBe(0);
    expect(res.newFaceIds.length).toBe(0);
    expect(mesh.verts.size).toBe(8);
    expect(mesh.faces.size).toBe(6);
  });
});
