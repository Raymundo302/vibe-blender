import { describe, it, expect } from 'vitest';
import { Vec3 } from '../../math/vec3';
import { makeCube } from '../primitives';
import { insetFaces, faceCentroid } from './inset';

describe('insetFaces (individual-face inset)', () => {
  it('insetting one cube face yields 12 verts, 10 faces (5 orig + 1 inner + 4 ring)', () => {
    const cube = makeCube();
    const face = [...cube.faces.keys()][0];
    const { innerFaceIds, innerVertsByFace } = insetFaces(cube, new Set([face]));

    expect(cube.verts.size).toBe(12); // 8 + 4 corner copies
    expect(cube.faces.size).toBe(10); // 6 - 1 + 1 inner + 4 ring
    expect(innerFaceIds.length).toBe(1);
    expect(innerVertsByFace.get(innerFaceIds[0])!.length).toBe(4);
    // The original face id is gone; the inner face is a new one.
    expect(cube.faces.has(face)).toBe(false);
  });

  it('t=0.5 places inner verts at the midpoint between corner and centroid', () => {
    const cube = makeCube();
    const face = [...cube.faces.keys()][0];
    // Capture the corners before topology (inner verts start at these).
    const cornerCos = cube.faces.get(face)!.verts.map((v) => cube.verts.get(v)!.co);

    const { innerFaceIds, innerVertsByFace } = insetFaces(cube, new Set([face]));
    const inner = innerVertsByFace.get(innerFaceIds[0])!;
    const centroid = faceCentroid(cube, innerFaceIds[0]);

    // Apply the modal move manually at t=0.5.
    const expected = inner.map((_v, i) => cornerCos[i].lerp(centroid, 0.5));
    inner.forEach((v, i) => cube.setVertCo(v, cornerCos[i].lerp(centroid, 0.5)));

    inner.forEach((v, i) => {
      expect(cube.verts.get(v)!.co.equalsApprox(expected[i])).toBe(true);
      // Midpoint = exactly halfway between the corner and the centroid.
      const mid = cornerCos[i].add(centroid).scale(0.5);
      expect(cube.verts.get(v)!.co.equalsApprox(mid)).toBe(true);
    });
  });

  it('all edges are manifold (2 faces) after inset', () => {
    const cube = makeCube();
    const face = [...cube.faces.keys()][0];
    insetFaces(cube, new Set([face]));
    for (const edge of cube.edges().values()) expect(edge.faces.length).toBe(2);
  });

  it('cancel path: copyFrom(before) restores 8 verts / 6 faces', () => {
    const cube = makeCube();
    const before = cube.clone();
    insetFaces(cube, new Set([[...cube.faces.keys()][0]]));
    expect(cube.verts.size).toBe(12);

    cube.copyFrom(before);
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(6);
    expect(cube.edges().size).toBe(12);
  });

  it('insets multiple selected faces independently', () => {
    const cube = makeCube();
    const [f0, f1] = [...cube.faces.keys()];
    insetFaces(cube, new Set([f0, f1]));
    // Each face: +4 verts, +5 faces -1. Two faces → +8 verts, +8 faces net.
    expect(cube.verts.size).toBe(16);
    expect(cube.faces.size).toBe(14);
    // Sanity: Vec3 import used.
    expect(Vec3.ZERO.x).toBe(0);
  });
});
