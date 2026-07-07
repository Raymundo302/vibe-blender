import { describe, it, expect } from 'vitest';
import { makeCube } from '../primitives';
import { Vec3 } from '../../math/vec3';
import { recalcNormals } from './recalcNormals';

/** Mesh center (average of all verts). */
function meshCenter(mesh: ReturnType<typeof makeCube>): Vec3 {
  let c = Vec3.ZERO;
  for (const v of mesh.verts.values()) c = c.add(v.co);
  return c.scale(1 / mesh.verts.size);
}

/** Face centroid. */
function faceCentroid(mesh: ReturnType<typeof makeCube>, faceId: number): Vec3 {
  const vs = mesh.faces.get(faceId)!.verts;
  let c = Vec3.ZERO;
  for (const v of vs) c = c.add(mesh.verts.get(v)!.co);
  return c.scale(1 / vs.length);
}

describe('recalcNormals', () => {
  it('fixes one deliberately flipped face on a cube (all normals outward)', () => {
    const mesh = makeCube();
    // Deliberately reverse one face's winding so its normal points inward.
    const badId = [...mesh.faces.keys()][0];
    mesh.faces.get(badId)!.verts.reverse();

    const center = meshCenter(mesh);
    // Sanity: the flipped face now points inward before the fix.
    expect(mesh.faceNormal(badId).dot(faceCentroid(mesh, badId).sub(center))).toBeLessThan(0);

    recalcNormals(mesh, [...mesh.faces.keys()]);

    // Every face now points outward.
    for (const fid of mesh.faces.keys()) {
      const outward = mesh.faceNormal(fid).dot(faceCentroid(mesh, fid).sub(center));
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('flips an entire inward-wound cube outward via the signed-volume stage', () => {
    const mesh = makeCube();
    // Reverse EVERY face → consistent but inward.
    for (const f of mesh.faces.values()) f.verts.reverse();
    const center = meshCenter(mesh);
    recalcNormals(mesh, [...mesh.faces.keys()]);
    for (const fid of mesh.faces.keys()) {
      expect(mesh.faceNormal(fid).dot(faceCentroid(mesh, fid).sub(center))).toBeGreaterThan(0);
    }
  });

  it('leaves an already-correct cube unchanged (0 flips) and bumps no version', () => {
    const mesh = makeCube();
    const v0 = mesh.version;
    const flips = recalcNormals(mesh, [...mesh.faces.keys()]);
    expect(flips).toBe(0);
    expect(mesh.version).toBe(v0);
  });
});
