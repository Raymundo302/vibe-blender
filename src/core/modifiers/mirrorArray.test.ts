import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'mirror' + 'array'
import { createModifier } from './Modifier';
import { makeCube } from '../mesh/primitives';
import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';

/** faceNormal · direction-to-centroid > 0.9 for every face of a centered mesh. */
function normalsPointOutward(mesh: EditableMesh): boolean {
  for (const face of mesh.faces.values()) {
    const n = mesh.faceNormal(face.id);
    let c = new Vec3();
    for (const vid of face.verts) c = c.add(mesh.verts.get(vid)!.co);
    const centroid = c.scale(1 / face.verts.length);
    if (n.dot(centroid.normalize()) <= 0.9) return false;
  }
  return true;
}

describe('Mirror modifier', () => {
  it('cube + Mirror → 16 verts / 12 faces', () => {
    const out = createModifier('mirror').apply(makeCube());
    expect(out.verts.size).toBe(16);
    expect(out.faces.size).toBe(12);
  });

  it('mirrored face normals still point outward', () => {
    const out = createModifier('mirror').apply(makeCube());
    expect(normalsPointOutward(out)).toBe(true);
  });

  it('is pure — the input mesh is untouched', () => {
    const cube = makeCube();
    const beforeV = cube.verts.size, beforeF = cube.faces.size, beforeVer = cube.version;
    createModifier('mirror').apply(cube);
    expect(cube.verts.size).toBe(beforeV);
    expect(cube.faces.size).toBe(beforeF);
    expect(cube.version).toBe(beforeVer);
  });

  it('verts on the mirror plane duplicate (no merge in v1)', () => {
    // A triangle with one vert sitting exactly on the x=0 plane.
    const tri = EditableMesh.fromData([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
    const out = createModifier('mirror', { axis: 'x' }).apply(tri);
    expect(out.verts.size).toBe(6); // 3 original + 3 mirrored, seam vert NOT merged
    expect(out.faces.size).toBe(2);
  });

  it('axis param is respected (only the chosen coord is negated)', () => {
    const src = EditableMesh.fromData([[1, 2, 3], [4, 0, 0], [0, 4, 0]], [[0, 1, 2]]);
    const out = createModifier('mirror', { axis: 'y' }).apply(src);
    // First mirrored vert (id 3) is the reflection of original id 0 = (1,2,3).
    expect(out.verts.get(3)!.co.equalsApprox(new Vec3(1, -2, 3))).toBe(true);
  });

  it('reflected winding is reversed relative to the original', () => {
    const src = EditableMesh.fromData([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
    const out = createModifier('mirror', { axis: 'x' }).apply(src);
    const mirroredFace = [...out.faces.values()][1];
    // originals map [0,1,2] → [3,4,5]; reversed → [5,4,3]
    expect(mirroredFace.verts).toEqual([5, 4, 3]);
  });
});

describe('Array modifier', () => {
  it('cube + Array count 3 → 24 verts / 18 faces at the right offsets', () => {
    const cube = makeCube();
    const out = createModifier('array', { count: 3, offsetX: 2, offsetY: 0, offsetZ: 0 }).apply(cube);
    expect(out.verts.size).toBe(24);
    expect(out.faces.size).toBe(18);
    // copy 1 verts (ids 8..15) = original + (2,0,0); copy 2 (ids 16..23) = +(4,0,0).
    const base0 = cube.verts.get(0)!.co;
    expect(out.verts.get(8)!.co.equalsApprox(base0.add(new Vec3(2, 0, 0)))).toBe(true);
    expect(out.verts.get(16)!.co.equalsApprox(base0.add(new Vec3(4, 0, 0)))).toBe(true);
  });

  it('count 1 → same counts as the input (unchanged clone)', () => {
    const out = createModifier('array', { count: 1 }).apply(makeCube());
    expect(out.verts.size).toBe(8);
    expect(out.faces.size).toBe(6);
  });

  it('offset param is respected on all axes', () => {
    const cube = makeCube();
    const out = createModifier('array', { count: 2, offsetX: 0, offsetY: 5, offsetZ: -3 }).apply(cube);
    const base0 = cube.verts.get(0)!.co;
    expect(out.verts.get(8)!.co.equalsApprox(base0.add(new Vec3(0, 5, -3)))).toBe(true);
  });

  it('count is clamped to 1..10', () => {
    expect(createModifier('array', { count: 99 }).apply(makeCube()).verts.size).toBe(10 * 8);
    expect(createModifier('array', { count: 0 }).apply(makeCube()).verts.size).toBe(8);
  });

  it('is pure — the input mesh is untouched', () => {
    const cube = makeCube();
    const beforeV = cube.verts.size, beforeF = cube.faces.size, beforeVer = cube.version;
    createModifier('array', { count: 4 }).apply(cube);
    expect(cube.verts.size).toBe(beforeV);
    expect(cube.faces.size).toBe(beforeF);
    expect(cube.version).toBe(beforeVer);
  });
});
