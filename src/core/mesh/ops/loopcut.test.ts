import { describe, it, expect } from 'vitest';
import { makeCube } from '../primitives';
import { EditableMesh } from '../EditableMesh';
import { loopFromEdge, cutLoop, loopPreviewSegments } from './loopcut';

const key = EditableMesh.edgeKey;

describe('loopFromEdge', () => {
  it('finds a closed 4-edge ring around the cube', () => {
    const cube = makeCube();
    const loop = loopFromEdge(cube, key(0, 1));
    expect(loop).not.toBeNull();
    expect(loop!.closed).toBe(true);
    expect(loop!.edgeKeys.length).toBe(4);
    expect(loop!.edgeKeys).toContain(key(0, 1));
    // A ring's edges are disjoint: 8 distinct verts on a cube ring of 4 edges
    const verts = new Set(loop!.edgeKeys.flatMap((k) => k.split(',').map(Number)));
    expect(verts.size).toBe(8);
  });

  it('stops at non-quad faces (open strip)', () => {
    const cube = makeCube();
    // The ring from X-aligned edge (0,1) runs through the ±Z and ±Y faces.
    // Triangulate one of THOSE (+Z) so the walk has to stop there.
    const sideFace = [...cube.faces.values()].find((f) => {
      const n = cube.faceNormal(f.id);
      return Math.abs(n.z - 1) < 1e-6;
    })!;
    const [a, b, c, d] = sideFace.verts;
    cube.deleteFaces([sideFace.id]);
    cube.addFace([a, b, c]);
    cube.addFace([a, c, d]);

    const loop = loopFromEdge(cube, key(0, 1));
    expect(loop).not.toBeNull();
    expect(loop!.closed).toBe(false);
    // All 4 ring edges are still crossed — but as an open strip (3 quads),
    // since the walk cannot pass through the triangles.
    expect(loop!.edgeKeys.length).toBe(4);
    const { newEdgeKeys } = cutLoop(cube, loop!);
    expect(newEdgeKeys.length).toBe(3); // one segment per strip quad
  });

  it('returns null for a nonexistent edge', () => {
    expect(loopFromEdge(makeCube(), 'nope')).toBeNull();
  });
});

describe('cutLoop', () => {
  it('cuts a closed cube ring: V+4, F+4, Euler characteristic 2 preserved', () => {
    const cube = makeCube();
    const loop = loopFromEdge(cube, key(0, 1))!;
    const { newVertIds, newEdgeKeys } = cutLoop(cube, loop);

    expect(newVertIds.length).toBe(4);
    expect(newEdgeKeys.length).toBe(4);
    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10); // 4 strip quads became 8; 2 caps untouched
    const E = cube.edges().size;
    expect(cube.verts.size - E + cube.faces.size).toBe(2); // still a sphere
    for (const e of cube.edges().values()) expect(e.faces.length).toBe(2); // manifold
  });

  it('t=0.5 puts new verts at edge midpoints and the new loop is walkable', () => {
    const cube = makeCube();
    const loop = loopFromEdge(cube, key(0, 1))!;
    const { newVertIds, newEdgeKeys } = cutLoop(cube, loop);
    for (const id of newVertIds) {
      const co = cube.verts.get(id)!.co;
      // Midpoints of the cut ring lie on the cube surface with one zero coord
      expect(Math.min(Math.abs(co.x), Math.abs(co.y), Math.abs(co.z))).toBeLessThan(1e-6);
    }
    // The new loop is itself loop-cuttable (a real ring in the topology)
    const again = loopFromEdge(cube, newEdgeKeys[0]);
    expect(again).not.toBeNull();
  });

  it('preview segments match the loop size', () => {
    const cube = makeCube();
    const loop = loopFromEdge(cube, key(0, 1))!;
    const segs = loopPreviewSegments(cube, loop);
    expect(segs.length).toBe(4 * 6); // closed ring: one segment per edge
  });
});
