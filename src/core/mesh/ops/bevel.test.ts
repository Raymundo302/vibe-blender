import { describe, it, expect } from 'vitest';
import { makeCube } from '../primitives';
import { EditableMesh } from '../EditableMesh';
import { bevelEdges } from './bevel';

const key = EditableMesh.edgeKey;

/** Every edge borders exactly two faces (watertight, 2-manifold). */
function isManifold(mesh: EditableMesh): boolean {
  for (const e of mesh.edges().values()) if (e.faces.length !== 2) return false;
  return true;
}

/** V - E + F, which is 2 for a closed genus-0 surface. */
function euler(mesh: EditableMesh): number {
  return mesh.verts.size - mesh.edges().size + mesh.faces.size;
}

describe('bevelEdges', () => {
  it('bevels one cube edge: 10 verts, 7 faces, still a closed manifold', () => {
    const cube = makeCube();
    // Edge (5,6) is interior — shared by the +Z and +X faces.
    const res = bevelEdges(cube, [key(5, 6)], 0.25);
    expect('newFaceIds' in res).toBe(true);
    if (!('newFaceIds' in res)) return;

    expect(res.newFaceIds.length).toBe(1);       // one bevel quad
    expect(cube.verts.size).toBe(10);            // 8 − 2 endpoints + 4 slid verts
    expect(cube.faces.size).toBe(7);             // 6 reshaped originals + 1 quad
    expect(isManifold(cube)).toBe(true);
    expect(euler(cube)).toBe(2);
    // The two original endpoints are gone.
    expect(cube.verts.has(5)).toBe(false);
    expect(cube.verts.has(6)).toBe(false);
    // The bevel quad is a real 4-gon.
    expect(cube.faces.get(res.newFaceIds[0])!.verts.length).toBe(4);
  });

  it('bevels a 4-edge ring around the cube into 4 quads, still manifold', () => {
    const cube = makeCube();
    // The four "vertical" edges ring the cube; each vert touches only one, so
    // the four bevels are independent quads.
    const ring = [key(0, 4), key(1, 5), key(2, 6), key(3, 7)];
    const res = bevelEdges(cube, ring, 0.2);
    expect('newFaceIds' in res).toBe(true);
    if (!('newFaceIds' in res)) return;

    expect(res.newFaceIds.length).toBe(4);       // four bevel quads
    for (const fid of res.newFaceIds) expect(cube.faces.get(fid)!.verts.length).toBe(4);
    expect(cube.faces.size).toBe(10);            // 6 reshaped + 4 quads
    expect(cube.verts.size).toBe(16);            // 8 endpoints → 2 slid verts each
    expect(isManifold(cube)).toBe(true);
    expect(euler(cube)).toBe(2);
  });

  it('width 0 leaves every new vert sitting on an original corner', () => {
    const cube = makeCube();
    const originals = [...cube.verts.values()].map((v) => v.co);
    const res = bevelEdges(cube, [key(5, 6)], 0);
    expect('newFaceIds' in res).toBe(true);

    expect(cube.faces.size).toBe(7);             // topology still changes at w=0
    for (const v of cube.verts.values()) {
      const onOriginal = originals.some((o) => o.distanceTo(v.co) < 1e-9);
      expect(onOriginal).toBe(true);
    }
  });

  it('rejects a cube corner (a vert with 3 selected edges) and does not mutate', () => {
    const cube = makeCube();
    const before = cube.clone();
    // The three edges meeting at vert 0.
    const res = bevelEdges(cube, [key(0, 1), key(0, 3), key(0, 4)], 0.25);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toContain('unsupported');
    // Untouched.
    expect(cube.verts.size).toBe(before.verts.size);
    expect(cube.faces.size).toBe(before.faces.size);
    expect(cube.edges().size).toBe(before.edges().size);
  });

  it('rejects a boundary (non-interior) edge selection', () => {
    // A single open quad: all four edges are boundary (1 face each).
    const plane = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
      [[0, 1, 2, 3]],
    );
    const res = bevelEdges(plane, [key(0, 1)], 0.1);
    expect('error' in res).toBe(true);
    expect(plane.faces.size).toBe(1);
  });

  it('bevels a straight interior chain across a grid (chain-internal verts)', () => {
    // 3×2 grid of quads (4×3 verts). The middle horizontal row of verts is
    // degree-4; a straight chain along it has chain-internal verts whose two
    // edges share no face → a clean multi-quad bevel.
    const cols = 3, rows = 2; // quads
    const verts: [number, number, number][] = [];
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) verts.push([x, 0, y]);
    const vid = (x: number, y: number): number => y * (cols + 1) + x;
    const faces: number[][] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      faces.push([vid(x, y), vid(x + 1, y), vid(x + 1, y + 1), vid(x, y + 1)]);
    }
    const grid = EditableMesh.fromData(verts, faces);
    // Middle row (y=1) horizontal edges: (0,1)-(1,1)-(2,1)-(3,1).
    const chain = [
      key(vid(0, 1), vid(1, 1)),
      key(vid(1, 1), vid(2, 1)),
      key(vid(2, 1), vid(3, 1)),
    ];
    const res = bevelEdges(grid, chain, 0.2);
    expect('newFaceIds' in res).toBe(true);
    if (!('newFaceIds' in res)) return;
    // Three beveled edges → three new bevel quads.
    expect(res.newFaceIds.length).toBe(3);
    for (const fid of res.newFaceIds) expect(grid.faces.get(fid)!.verts.length).toBe(4);
    // Every interior edge stays shared by two faces (open grid keeps its border).
    for (const e of grid.edges().values()) expect(e.faces.length).toBeLessThanOrEqual(2);
  });
});
