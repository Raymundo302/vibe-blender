import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'mirror' + 'array'
import { createModifier } from './Modifier';
import { makeCube, makePlane } from '../mesh/primitives';
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

describe('Mirror / Array modifiers — UVs (P11-5)', () => {
  it('Mirror: original keeps UVs; mirrored face copies them (reversed with winding)', () => {
    const tri = EditableMesh.fromData([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 1, 2]]);
    tri.setFaceUVs(0, [[0, 0], [1, 0], [0, 1]]);
    const out = createModifier('mirror', { axis: 'x' }).apply(tri);
    // Original face 0 unchanged; mirrored face 1 has reversed verts [2,1,0]→
    // (mirrored ids [5,4,3]) so its UVs are the source UVs reversed.
    expect(out.uvs.get(0)).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(out.uvs.get(1)).toEqual([[0, 1], [1, 0], [0, 0]]);
  });

  it('Mirror: a face without UVs yields no UVs on either copy', () => {
    const m = makeCube(); m.uvs.clear(); // primitives now ship UVs; test the UV-less path
    const out = createModifier('mirror', { axis: 'x' }).apply(m);
    expect(out.uvs.size).toBe(0);
  });

  it('Array: every copy carries the source face UVs verbatim', () => {
    const plane = makePlane(2);
    plane.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const out = createModifier('array', { count: 3, offsetX: 3 }).apply(plane);
    // Copy 0 (clone) = face 0, copies 1/2 = faces 1/2, all identical UVs.
    for (let id = 0; id < 3; id++) {
      expect(out.uvs.get(id)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    expect(out.uvs.size).toBe(3);
  });

  it('Array: deterministic — apply twice → identical UVs', () => {
    const plane = makePlane(2);
    plane.setFaceUVs(0, [[0.1, 0.2], [0.8, 0.1], [0.9, 0.9], [0.2, 0.7]]);
    const a = createModifier('array', { count: 4 }).apply(plane);
    const b = createModifier('array', { count: 4 }).apply(plane);
    expect([...a.uvs.entries()]).toEqual([...b.uvs.entries()]);
  });
});
