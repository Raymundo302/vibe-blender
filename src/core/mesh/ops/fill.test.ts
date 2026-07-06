import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import { fillVerts, fillEdges } from './fill';

/** Unit cube (±1), faces CCW-outward (same winding as e2e's cube OBJ). */
function cube(): EditableMesh {
  return EditableMesh.fromData(
    [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], // 0..3
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],      // 4..7
    ],
    [
      [4, 5, 6, 7], // +Z
      [1, 0, 3, 2], // -Z
      [5, 1, 2, 6], // +X
      [0, 4, 7, 3], // -X
      [7, 6, 2, 3], // +Y (top) — id 4
      [0, 1, 5, 4], // -Y (bottom)
    ],
  );
}

/** Cube with the +Y top face removed. Returns the hole's boundary verts and the
 *  removed face's outward normal so tests can assert the fill matches it. */
function cubeMinusTop(): { mesh: EditableMesh; topVerts: number[]; topNormal: Vec3 } {
  const mesh = cube();
  const topNormal = mesh.faceNormal(4); // +Y face id
  const topVerts = [...mesh.faces.get(4)!.verts];
  mesh.deleteFaces([4]);
  return { mesh, topVerts, topNormal };
}

describe('fillVerts', () => {
  it('fills a cube hole from its 4 boundary verts → 6 faces, manifold, outward', () => {
    const { mesh, topVerts, topNormal } = cubeMinusTop();
    expect(mesh.faces.size).toBe(5);

    const res = fillVerts(mesh, topVerts);
    expect('faceId' in res).toBe(true);
    if (!('faceId' in res)) return;
    expect(mesh.faces.size).toBe(6);

    // Manifold: every edge now shared by exactly 2 faces.
    for (const e of mesh.edges().values()) expect(e.faces.length).toBe(2);

    // The new face normal points outward — same direction the removed face had.
    expect(mesh.faceNormal(res.faceId).dot(topNormal)).toBeGreaterThan(0.9);
  });

  it('rejects fewer than 3 verts', () => {
    const mesh = EditableMesh.fromData([[0, 0, 0], [1, 0, 0]], []);
    const res = fillVerts(mesh, [0, 1]);
    expect('error' in res).toBe(true);
  });

  it('rejects a fully-surrounded interior vert', () => {
    // A center vert (id 4) fanned by 4 tris covering it entirely: no boundary.
    const mesh = EditableMesh.fromData(
      [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [0, 0, 0]],
      [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
    );
    const before = mesh.faces.size;
    const res = fillVerts(mesh, [0, 1, 4]);
    expect('error' in res).toBe(true);
    expect(mesh.faces.size).toBe(before); // untouched
  });

  it('orders scrambled coplanar verts into a convex quad', () => {
    // Four corners of a square passed out of order.
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1]],
      [],
    );
    const res = fillVerts(mesh, [0, 1, 2, 3]);
    expect('faceId' in res).toBe(true);
    if (!('faceId' in res)) return;
    const path = mesh.faces.get(res.faceId)!.verts;
    // A convex quad walk never re-crosses: consecutive corners differ in exactly
    // one coordinate (they are square edges, length 1), never the diagonal (√2).
    for (let i = 0; i < 4; i++) {
      const a = mesh.verts.get(path[i])!.co;
      const b = mesh.verts.get(path[(i + 1) % 4])!.co;
      expect(a.distanceTo(b)).toBeCloseTo(1, 5);
    }
  });
});

describe('fillEdges', () => {
  it('fills the same cube hole from its 4 boundary edges → 6 faces, manifold, outward', () => {
    const { mesh, topVerts, topNormal } = cubeMinusTop();
    const key = EditableMesh.edgeKey;
    const [a, b, c, d] = topVerts;
    const boundary = [key(a, b), key(b, c), key(c, d), key(d, a)];

    const res = fillEdges(mesh, boundary);
    expect('faceId' in res).toBe(true);
    if (!('faceId' in res)) return;
    expect(mesh.faces.size).toBe(6);
    for (const e of mesh.edges().values()) expect(e.faces.length).toBe(2);
    expect(mesh.faceNormal(res.faceId).dot(topNormal)).toBeGreaterThan(0.9);
  });

  it('fills an open 3-edge chain into a quad (4 verts)', () => {
    // An open path of 3 edges over 4 verts (an L that closes into a quad).
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
      [],
    );
    const key = EditableMesh.edgeKey;
    const res = fillEdges(mesh, [key(0, 1), key(1, 2), key(2, 3)]);
    expect('faceId' in res).toBe(true);
    if (!('faceId' in res)) return;
    expect(mesh.faces.get(res.faceId)!.verts.length).toBe(4);
  });

  it('rejects a branching (non-chain) edge selection', () => {
    // A star: vert 0 links to 1, 2, 3 — degree 3, not a simple chain.
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1]],
      [],
    );
    const key = EditableMesh.edgeKey;
    const res = fillEdges(mesh, [key(0, 1), key(0, 2), key(0, 3)]);
    expect('error' in res).toBe(true);
  });

  it('rejects two disconnected chains', () => {
    const mesh = EditableMesh.fromData(
      [[0, 0, 0], [1, 0, 0], [5, 0, 0], [6, 0, 0]],
      [],
    );
    const key = EditableMesh.edgeKey;
    const res = fillEdges(mesh, [key(0, 1), key(2, 3)]);
    expect('error' in res).toBe(true);
  });
});
