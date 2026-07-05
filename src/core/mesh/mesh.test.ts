import { describe, it, expect } from 'vitest';
import { makeCube } from './primitives';
import { meshToRenderData } from './meshToGpu';
import { Vec3 } from '../math/vec3';

describe('EditableMesh (cube)', () => {
  it('has Euler-correct topology: 8 verts, 12 edges, 6 faces', () => {
    const cube = makeCube();
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(6);
    expect(cube.edges().size).toBe(12);
  });

  it('is manifold: every edge borders exactly 2 faces', () => {
    for (const edge of makeCube().edges().values()) {
      expect(edge.faces.length).toBe(2);
    }
  });

  it('face normals point outward', () => {
    const cube = makeCube();
    for (const face of cube.faces.values()) {
      const n = cube.faceNormal(face.id);
      // centroid of a centered cube face lies along its outward normal
      let cx = 0, cy = 0, cz = 0;
      for (const vid of face.verts) {
        const co = cube.verts.get(vid)!.co;
        cx += co.x; cy += co.y; cz += co.z;
      }
      const centroid = new Vec3(cx, cy, cz).scale(1 / face.verts.length);
      expect(n.dot(centroid)).toBeGreaterThan(0.9);
    }
  });

  it('renders to 12 triangles and 12 edge segments', () => {
    const data = meshToRenderData(makeCube());
    expect(data.triangleCount).toBe(12);
    expect(data.edgeCount).toBe(12);
    expect(data.trianglePositions.length).toBe(12 * 9);
  });

  it('clone is deep and version-bumps on edit', () => {
    const cube = makeCube();
    const snapshot = cube.clone();
    const v0 = cube.verts.get(0)!;
    const before = cube.version;
    cube.setVertCo(0, v0.co.add(new Vec3(1, 0, 0)));
    expect(cube.version).toBeGreaterThan(before);
    expect(snapshot.verts.get(0)!.co.x).not.toBe(cube.verts.get(0)!.co.x);
    cube.copyFrom(snapshot);
    expect(cube.verts.get(0)!.co.x).toBe(snapshot.verts.get(0)!.co.x);
  });
});
