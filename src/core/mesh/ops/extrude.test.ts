import { describe, it, expect } from 'vitest';
import { makeCube } from '../primitives';
import { extrudeFaces } from './extrude';

describe('extrudeFaces (region extrude)', () => {
  it('extruding one cube face yields a closed manifold (12 v, 10 f, 20 e)', () => {
    const cube = makeCube();
    const topFace = [...cube.faces.keys()][0];
    const { capFaceIds } = extrudeFaces(cube, new Set([topFace]));

    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10);
    expect(cube.edges().size).toBe(20);
    // Cap keeps the original face id (remapped in place, not recreated).
    expect(capFaceIds).toEqual([topFace]);
    // Still watertight: every edge borders exactly two faces.
    for (const edge of cube.edges().values()) expect(edge.faces.length).toBe(2);
  });

  it('treats two adjacent faces as a region — the shared edge gets no side quad', () => {
    const cube = makeCube();
    // +Z ([4,5,6,7]) and +X ([5,1,2,6]) share edge 5-6.
    const faceIds = [...cube.faces.keys()];
    const region = new Set([faceIds[0], faceIds[2]]);
    extrudeFaces(cube, region);

    // Per-face would add 8 side quads (6 + 8 = 14 faces); region shares one edge,
    // so only 6 side quads are added (6 + 6 = 12 faces).
    expect(cube.faces.size).toBe(12);
    // The shared original edge (5,6) is now interior to the cap wall region and
    // must NOT appear as a side quad, i.e. its cap-vert copy is unused as a wall.
    let sideQuadsOnSharedEdge = 0;
    for (const f of cube.faces.values()) {
      if (f.verts.length === 4 && f.verts.includes(5) && f.verts.includes(6)) {
        // A side quad references two originals + two caps; a cap face references
        // only cap verts. Count walls still touching the original shared edge.
        sideQuadsOnSharedEdge++;
      }
    }
    expect(sideQuadsOnSharedEdge).toBe(0);
  });

  it('cancel path: copyFrom(before) restores the original counts', () => {
    const cube = makeCube();
    const before = cube.clone();
    extrudeFaces(cube, new Set([[...cube.faces.keys()][0]]));
    expect(cube.verts.size).toBe(12);

    cube.copyFrom(before);
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(6);
    expect(cube.edges().size).toBe(12);
  });
});
