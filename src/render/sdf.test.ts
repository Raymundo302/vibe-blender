import { describe, it, expect } from 'vitest';
import { buildMeshSdf, SDF_RES } from './sdf';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';

/** Axis-aligned closed cube from -1..1 (side 2). */
function cubeMesh(): EditableMesh {
  const m = new EditableMesh();
  const ids: number[] = [];
  for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
    ids.push(m.addVert(new Vec3(x, y, z)));
  }
  // idx bits: x = bit0, y = bit1, z = bit2 (from loop order above)
  const q = (a: number, b: number, c: number, d: number) => m.addFace([ids[a], ids[b], ids[c], ids[d]]);
  q(0, 2, 3, 1); // -z
  q(4, 5, 7, 6); // +z
  q(0, 1, 5, 4); // -y
  q(2, 6, 7, 3); // +y
  q(0, 4, 6, 2); // -x
  q(1, 3, 7, 5); // +x
  return m;
}

/** Decode the SDF at the grid point nearest a local-space position. */
function sampleSdf(sdf: NonNullable<ReturnType<typeof buildMeshSdf>>, p: [number, number, number]): number {
  const r = SDF_RES;
  const ijk = p.map((v, a) =>
    Math.max(0, Math.min(r - 1, Math.round((v - sdf.boxMin[a]) / sdf.boxSize[a] * (r - 1)))));
  const byte = sdf.data[ijk[0] + r * (ijk[1] + r * ijk[2])];
  return (byte / 255 - 0.5) * 2 * sdf.maxDist;
}

describe('buildMeshSdf', () => {
  it('returns null for an empty mesh', () => {
    expect(buildMeshSdf(new EditableMesh())).toBeNull();
  });

  it('pads the box around the geometry', () => {
    const sdf = buildMeshSdf(cubeMesh())!;
    expect(sdf.boxMin[0]).toBeLessThan(-1);
    expect(sdf.boxMin[0] + sdf.boxSize[0]).toBeGreaterThan(1);
  });

  it('is negative inside, ~zero at the surface, positive outside', () => {
    const sdf = buildMeshSdf(cubeMesh())!;
    expect(sampleSdf(sdf, [0, 0, 0])).toBeLessThan(-0.5);        // deep inside
    expect(Math.abs(sampleSdf(sdf, [1, 0, 0]))).toBeLessThan(0.2); // on a face
    // Box corner: true distance is the pad width × √3 (diagonal to the cube
    // corner) — assert it reads clearly positive at that scale.
    const pad = -1 - sdf.boxMin[0];
    const corner = sdf.boxMin.map((v) => v + 0.01) as [number, number, number];
    expect(sampleSdf(sdf, corner)).toBeGreaterThan(pad);
  });

  it('measures distance to the surface outside', () => {
    const sdf = buildMeshSdf(cubeMesh())!;
    // Straight out from face center, halfway between the face and the box
    // edge (must stay INSIDE the grid box): true distance = x - 1. Grid
    // quantization + chamfer approximation allow a loose tolerance.
    const boxMax = sdf.boxMin[0] + sdf.boxSize[0];
    const probe = 1 + (boxMax - 1) * 0.5;
    const d = sampleSdf(sdf, [probe, 0, 0]);
    expect(d).toBeGreaterThan((probe - 1) * 0.5);
    expect(d).toBeLessThan((probe - 1) * 1.6);
  });

  it('rejects a sparse island cloud (sub-voxel scatter geometry)', () => {
    // ~Scatter output: tiny disjoint triangles sprinkled across a big volume.
    const m = new EditableMesh();
    for (let i = 0; i < 40; i++) {
      const x = (i % 7) - 3, y = ((i * 3) % 7) - 3, z = ((i * 5) % 7) - 3;
      const a = m.addVert(new Vec3(x, y, z));
      const b = m.addVert(new Vec3(x + 0.03, y, z));
      const c = m.addVert(new Vec3(x, y + 0.03, z));
      m.addFace([a, b, c]);
    }
    expect(buildMeshSdf(m)).toBeNull();
  });

  it('keeps an open mesh (flat plane) all-positive with near-zero at the surface', () => {
    const m = new EditableMesh();
    const a = m.addVert(new Vec3(-1, -1, 0));
    const b = m.addVert(new Vec3(1, -1, 0));
    const c = m.addVert(new Vec3(1, 1, 0));
    const d = m.addVert(new Vec3(-1, 1, 0));
    m.addFace([a, b, c, d]);
    const sdf = buildMeshSdf(m)!;
    expect(Math.abs(sampleSdf(sdf, [0, 0, 0]))).toBeLessThan(0.15);
    // Off the plane on both sides: positive and roughly symmetric.
    const off = sdf.boxSize[2] * 0.3;
    expect(sampleSdf(sdf, [0, 0, off])).toBeGreaterThan(0.05);
    expect(sampleSdf(sdf, [0, 0, -off])).toBeGreaterThan(0.05);
  });
});
