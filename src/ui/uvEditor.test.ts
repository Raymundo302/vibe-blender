import { describe, expect, it } from 'vitest';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';
import {
  computeUVIslands,
  pointInPolygon,
  pickUVIsland,
  facesCentroid,
  translateUV,
  scaleUV,
  rotateUV,
  transformFaceUVs,
  type UV,
} from './uvEditor';

/** Build a mesh whose faces carry the given UV quads (geometry is irrelevant). */
function meshWithUVs(quads: UV[][]): { mesh: EditableMesh; faceIds: number[] } {
  const mesh = new EditableMesh();
  const faceIds: number[] = [];
  for (const quad of quads) {
    const vs = quad.map((_, i) => mesh.addVert(new Vec3(i, 0, 0)));
    const f = mesh.addFace(vs);
    mesh.setFaceUVs(f, quad.map(([u, v]) => [u, v] as UV));
    faceIds.push(f);
  }
  return { mesh, faceIds };
}

describe('computeUVIslands', () => {
  it('two spatially separate quads → 2 islands', () => {
    const { mesh } = meshWithUVs([
      [[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]],
      [[0.6, 0.6], [0.8, 0.6], [0.8, 0.8], [0.6, 0.8]],
    ]);
    expect(computeUVIslands(mesh)).toHaveLength(2);
  });

  it('quads sharing a corner within epsilon merge into 1 island', () => {
    const { mesh } = meshWithUVs([
      [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]],
      // shares the (0.5,0.5) corner (offset well under UV_EPSILON)
      [[0.5, 0.5], [1, 0.5], [1, 1], [0.5 + 1e-6, 0.5 + 1e-6]],
    ]);
    const islands = computeUVIslands(mesh);
    expect(islands).toHaveLength(1);
    expect(islands[0]).toHaveLength(2);
  });

  it('a corner difference above epsilon does NOT merge', () => {
    const { mesh } = meshWithUVs([
      [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]],
      [[0.51, 0.51], [1, 0.5], [1, 1], [0.51, 1]],
    ]);
    expect(computeUVIslands(mesh)).toHaveLength(2);
  });

  it('faces without UVs are ignored', () => {
    const mesh = new EditableMesh();
    const vs = [0, 1, 2, 3].map((i) => mesh.addVert(new Vec3(i, 0, 0)));
    mesh.addFace(vs); // no UVs
    expect(computeUVIslands(mesh)).toHaveLength(0);
  });
});

describe('pointInPolygon / pickUVIsland', () => {
  const quad: UV[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('detects inside vs outside', () => {
    expect(pointInPolygon(quad, [0.5, 0.5])).toBe(true);
    expect(pointInPolygon(quad, [1.5, 0.5])).toBe(false);
    expect(pointInPolygon(quad, [-0.1, 0.5])).toBe(false);
  });

  it('picks the island containing the point, -1 when none', () => {
    const { mesh } = meshWithUVs([
      [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]],
      [[0.6, 0.6], [1, 0.6], [1, 1], [0.6, 1]],
    ]);
    const islands = computeUVIslands(mesh);
    expect(pickUVIsland(mesh, islands, [0.2, 0.2])).toBe(0);
    expect(pickUVIsland(mesh, islands, [0.8, 0.8])).toBe(1);
    expect(pickUVIsland(mesh, islands, [0.5, 0.5])).toBe(-1);
  });
});

describe('transform math', () => {
  it('translateUV shifts a point', () => {
    const [x, y] = translateUV(0.1, -0.2)([0.5, 0.5]);
    expect(x).toBeCloseTo(0.6, 12);
    expect(y).toBeCloseTo(0.3, 12);
  });

  it('scaleUV scales around a pivot', () => {
    const [x, y] = scaleUV(2, [0.5, 0.5])([0.6, 0.5]);
    expect(x).toBeCloseTo(0.7, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('rotateUV by 90° about pivot', () => {
    const [x, y] = rotateUV(Math.PI / 2, [0, 0])([1, 0]);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('facesCentroid averages every corner', () => {
    const { mesh } = meshWithUVs([[[0, 0], [1, 0], [1, 1], [0, 1]]]);
    const [cx, cy] = facesCentroid(mesh, mesh.uvs.keys());
    expect(cx).toBeCloseTo(0.5, 12);
    expect(cy).toBeCloseTo(0.5, 12);
  });

  it('G translate moves ONLY the picked island’s corners', () => {
    const { mesh, faceIds } = meshWithUVs([
      [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4]], // island 0
      [[0.6, 0.6], [1, 0.6], [1, 1], [0.6, 1]], // island 1
    ]);
    const islands = computeUVIslands(mesh);
    const picked = pickUVIsland(mesh, islands, [0.2, 0.2]); // island 0
    const pickedFaces = islands[picked];

    // Snapshot originals, then apply an absolute translate to the picked faces.
    const orig = new Map<number, UV[]>();
    for (const f of pickedFaces) orig.set(f, mesh.uvs.get(f)!.map(([u, v]) => [u, v] as UV));
    const before1 = mesh.uvs.get(faceIds[1])!.map(([u, v]) => [u, v] as UV);

    for (const [f, poly] of transformFaceUVs(pickedFaces, orig, translateUV(0.1, 0.05))) {
      mesh.setFaceUVs(f, poly);
    }

    // Island 0 moved by (0.1, 0.05)…
    expect(mesh.uvs.get(faceIds[0])).toEqual([[0.1, 0.05], [0.5, 0.05], [0.5, 0.45], [0.1, 0.45]]);
    // …island 1 is byte-identical.
    expect(mesh.uvs.get(faceIds[1])).toEqual(before1);
  });
});
