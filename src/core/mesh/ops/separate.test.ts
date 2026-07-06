import { describe, it, expect } from 'vitest';
import { makeCube } from '../primitives';
import { Vec3 } from '../../math/vec3';
import { extractFaces } from './separate';

const co = (x: number, y: number, z: number): Vec3 => new Vec3(x, y, z);

describe('extractFaces', () => {
  it('separates one cube face: source keeps 8 verts / 5 faces, new mesh 4 verts / 1 face', () => {
    const mesh = makeCube();
    const faceId = [...mesh.faces.keys()][0];

    const { removed, orphanVertIds } = extractFaces(mesh, [faceId]);

    // Every corner of a cube face is shared with two neighbours, so nothing is
    // orphaned — the whole seam duplicates and the source keeps all its verts.
    expect(orphanVertIds).toEqual([]);
    expect(removed.verts.size).toBe(4);
    expect(removed.faces.size).toBe(1);

    // Pure: the input mesh is untouched (the caller applies the deletion).
    expect(mesh.verts.size).toBe(8);
    expect(mesh.faces.size).toBe(6);

    // Applying the split to the source: drop the face (no orphans to drop).
    mesh.deleteFaces([faceId]);
    mesh.deleteVerts(orphanVertIds);
    expect(mesh.verts.size).toBe(8);
    expect(mesh.faces.size).toBe(5);
  });

  it('separates two adjacent faces: new mesh 6 verts / 2 faces sharing a manifold seam edge', () => {
    const mesh = makeCube();
    // Faces 0 (+Z, [4,5,6,7]) and 2 (+X, [5,1,2,6]) share edge 5–6.
    const { removed } = extractFaces(mesh, [0, 2]);

    expect(removed.verts.size).toBe(6);
    expect(removed.faces.size).toBe(2);

    // The shared edge lives inside the new shell used by exactly two faces —
    // the two extracted faces still share it (seam stays manifold).
    const edges = removed.edges();
    const interior = [...edges.values()].filter((e) => e.faces.length === 2);
    expect(interior.length).toBe(1);
    expect(interior[0].faces.length).toBe(2);
  });

  it('is deterministic: new vert ids restart at 0 in first-appearance order', () => {
    const mesh = makeCube();
    const { removed } = extractFaces(mesh, [0]);
    // Face 0 is [4,5,6,7]; walking it mints new ids 0,1,2,3 for the one face.
    expect([...removed.verts.keys()]).toEqual([0, 1, 2, 3]);
    expect([...removed.faces.values()][0].verts).toEqual([0, 1, 2, 3]);
  });

  it('reports orphan verts when a separated face owns interior-only verts', () => {
    // A pyramid: a quad base (verts 0..3) + apex (vert 4) with four side faces.
    const mesh = makeCube(); // reuse only its class; rebuild from data
    mesh.verts.clear();
    mesh.faces.clear();
    // Build fresh: square base + apex.
    const b0 = mesh.addVert(co(-1, 0, -1));
    const b1 = mesh.addVert(co(1, 0, -1));
    const b2 = mesh.addVert(co(1, 0, 1));
    const b3 = mesh.addVert(co(-1, 0, 1));
    const apex = mesh.addVert(co(0, 2, 0));
    const base = mesh.addFace([b0, b1, b2, b3]);
    mesh.addFace([b0, b1, apex]);
    mesh.addFace([b1, b2, apex]);
    mesh.addFace([b2, b3, apex]);
    mesh.addFace([b3, b0, apex]);

    // Separate the base quad. Its 4 verts are all shared with the side faces, so
    // no orphans — the apex is not part of the base.
    const r1 = extractFaces(mesh, [base]);
    expect(r1.orphanVertIds).toEqual([]);
    expect(r1.removed.verts.size).toBe(4);

    // Separate ALL four side faces: the apex is used ONLY by them → orphaned.
    const sideIds = [...mesh.faces.keys()].filter((id) => id !== base);
    const r2 = extractFaces(mesh, sideIds);
    expect(r2.orphanVertIds).toEqual([apex]);
  });
});
