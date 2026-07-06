import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import { bridgeLoops } from './bridge';

const key = EditableMesh.edgeKey;

/** All boundary-edge keys of every face — the full edge set of a two-quad mesh. */
function allEdgeKeys(mesh: EditableMesh): Set<string> {
  return new Set(mesh.edges().keys());
}

describe('bridgeLoops', () => {
  it('bridges two closed 4-edge square loops into 4 quads (edges become manifold)', () => {
    // Two detached quads, one offset +2 on Y. Their boundaries are the loops.
    const mesh = EditableMesh.fromData(
      [
        [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], // quad A (y=0)
        [0, 2, 0], [1, 2, 0], [1, 2, 1], [0, 2, 1], // quad B (y=2)
      ],
      [[0, 1, 2, 3], [4, 5, 6, 7]],
    );
    const boundary = allEdgeKeys(mesh);
    const facesBefore = mesh.faces.size;

    const res = bridgeLoops(mesh, boundary);
    expect('newFaceIds' in res).toBe(true);
    if (!('newFaceIds' in res)) return;
    expect(res.newFaceIds.length).toBe(4);
    expect(mesh.faces.size).toBe(facesBefore + 4);

    // Every previously-boundary edge of both loops is now shared by 2 faces.
    const edges = mesh.edges();
    for (const k of boundary) {
      expect(edges.get(k)!.faces.length).toBe(2);
    }
  });

  it('errors and does not mutate on mismatched edge counts (4 vs 3)', () => {
    const mesh = EditableMesh.fromData(
      [
        [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], // quad (4 edges)
        [0, 2, 0], [1, 2, 0], [1, 2, 1],            // triangle (3 edges)
      ],
      [[0, 1, 2, 3], [4, 5, 6]],
    );
    const before = mesh.clone();
    const res = bridgeLoops(mesh, allEdgeKeys(mesh));
    expect('error' in res).toBe(true);
    expect(mesh.verts.size).toBe(before.verts.size);
    expect(mesh.faces.size).toBe(before.faces.size);
  });

  it('errors when more than 2 loops are selected', () => {
    const mesh = EditableMesh.fromData(
      [
        [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
        [0, 2, 0], [1, 2, 0], [1, 2, 1], [0, 2, 1],
        [0, 4, 0], [1, 4, 0], [1, 4, 1], [0, 4, 1],
      ],
      [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]],
    );
    const res = bridgeLoops(mesh, allEdgeKeys(mesh));
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toContain('3');
  });

  it('bridges two open 2-edge paths into 2 quads', () => {
    // Bare verts + manually-specified open edge chains (no faces needed).
    const mesh = new EditableMesh();
    for (const p of [
      [0, 0, 0], [1, 0, 0], [2, 0, 0], // path A: verts 0,1,2
      [0, 2, 0], [1, 2, 0], [2, 2, 0], // path B: verts 3,4,5
    ]) mesh.addVert(new Vec3(p[0], p[1], p[2]));

    const edges = new Set([key(0, 1), key(1, 2), key(3, 4), key(4, 5)]);
    const res = bridgeLoops(mesh, edges);
    expect('newFaceIds' in res).toBe(true);
    if (!('newFaceIds' in res)) return;
    expect(res.newFaceIds.length).toBe(2);
    for (const fid of res.newFaceIds) {
      expect(mesh.faces.get(fid)!.verts.length).toBe(4);
    }
  });

  it('picks the non-twisted rotation for a diagonally-offset closed pair', () => {
    // Two 4x4 squares offset +2 on Y. Loop B is ordered so the naive index
    // pairing is the diagonal (twisted); the rotation search must untwist it.
    const mesh = EditableMesh.fromData(
      [
        [0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], // loop A: verts 0..3
        [4, 2, 4], [0, 2, 4], [0, 2, 0], [4, 2, 0], // loop B: verts 4..7 (rotated by 2)
      ],
      [[0, 1, 2, 3], [4, 5, 6, 7]],
    );
    const loopA = new Set([0, 1, 2, 3]);
    const loopB = new Set([4, 5, 6, 7]);
    const boundary = allEdgeKeys(mesh);
    const before = mesh.edges();
    const preExisting = new Set(before.keys());

    const res = bridgeLoops(mesh, boundary);
    expect('newFaceIds' in res).toBe(true);

    // Bridging edges connect a loop-A vert to a loop-B vert. With the correct
    // (untwisted) pairing each is the pure 2-unit Y offset; a twist would make
    // some diagonal (length 6). Assert none exceeds 1.5x the offset distance.
    const limit = 1.5 * 2;
    let bridgeEdges = 0;
    for (const [k, e] of mesh.edges()) {
      if (preExisting.has(k)) continue;
      const aSide = loopA.has(e.v0) || loopA.has(e.v1);
      const bSide = loopB.has(e.v0) || loopB.has(e.v1);
      if (aSide && bSide) {
        bridgeEdges++;
        const len = mesh.verts.get(e.v0)!.co.distanceTo(mesh.verts.get(e.v1)!.co);
        expect(len).toBeLessThanOrEqual(limit);
      }
    }
    expect(bridgeEdges).toBeGreaterThan(0);
  });
});
