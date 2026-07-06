import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'subsurf' (+ mirror/array)
import { createModifier } from './Modifier';
import { makeCube, makePlane } from '../mesh/primitives';
import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';

/** faceNormal · direction-to-centroid > 0 for every face of a centered mesh. */
function normalsPointOutward(mesh: EditableMesh): boolean {
  for (const face of mesh.faces.values()) {
    const n = mesh.faceNormal(face.id);
    let c = new Vec3();
    for (const vid of face.verts) c = c.add(mesh.verts.get(vid)!.co);
    const centroid = c.scale(1 / face.verts.length);
    if (n.dot(centroid.normalize()) <= 0) return false;
  }
  return true;
}

function allQuads(mesh: EditableMesh): boolean {
  for (const f of mesh.faces.values()) if (f.verts.length !== 4) return false;
  return true;
}

function everyEdgeManifold(mesh: EditableMesh): boolean {
  for (const e of mesh.edges().values()) if (e.faces.length !== 2) return false;
  return true;
}

describe('Subdivision Surface modifier — cube', () => {
  it('level 1 → 26 verts / 24 faces / 48 edges (Euler V−E+F = 2)', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makeCube());
    expect(out.verts.size).toBe(26); // 8 vert + 12 edge + 6 face points
    expect(out.faces.size).toBe(24);
    expect(out.edges().size).toBe(48);
    expect(out.verts.size - out.edges().size + out.faces.size).toBe(2);
  });

  it('every edge is manifold and every face is a quad', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makeCube());
    expect(everyEdgeManifold(out)).toBe(true);
    expect(allQuads(out)).toBe(true);
  });

  it('shrinks toward a sphere: 0.9 < |co| < √3 for every vert', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makeCube());
    const root3 = Math.sqrt(3);
    for (const v of out.verts.values()) {
      const len = v.co.length();
      expect(len).toBeGreaterThan(0.9);
      expect(len).toBeLessThan(root3);
    }
  });

  it('face normals point outward', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makeCube());
    expect(normalsPointOutward(out)).toBe(true);
  });

  it('level 2 → 98 verts / 96 faces', () => {
    const out = createModifier('subsurf', { levels: 2 }).apply(makeCube());
    expect(out.verts.size).toBe(98);
    expect(out.faces.size).toBe(96);
  });

  it('is pure — the input mesh is untouched', () => {
    const cube = makeCube();
    const beforeV = cube.verts.size, beforeF = cube.faces.size, beforeVer = cube.version;
    createModifier('subsurf', { levels: 3 }).apply(cube);
    expect(cube.verts.size).toBe(beforeV);
    expect(cube.faces.size).toBe(beforeF);
    expect(cube.version).toBe(beforeVer);
  });

  it('levels is clamped to 1..3', () => {
    // level 0 clamps to 1 → 26 verts; level 99 clamps to 3.
    expect(createModifier('subsurf', { levels: 0 }).apply(makeCube()).verts.size).toBe(26);
    const lvl3 = createModifier('subsurf', { levels: 99 }).apply(makeCube()).verts.size;
    const lvl3b = createModifier('subsurf', { levels: 3 }).apply(makeCube()).verts.size;
    expect(lvl3).toBe(lvl3b);
  });

  it('is deterministic — identical output vert coords across two runs', () => {
    const a = createModifier('subsurf', { levels: 2 }).apply(makeCube());
    const b = createModifier('subsurf', { levels: 2 }).apply(makeCube());
    expect([...a.verts.keys()]).toEqual([...b.verts.keys()]);
    for (const id of a.verts.keys()) {
      expect(a.verts.get(id)!.co.equalsApprox(b.verts.get(id)!.co)).toBe(true);
    }
  });
});

describe('Subdivision Surface modifier — boundary (plane)', () => {
  it('single quad, level 1 → 9 verts / 4 faces', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    expect(out.verts.size).toBe(9); // 4 vert + 4 edge + 1 face points
    expect(out.faces.size).toBe(4);
  });

  it('corner verts stay INSIDE the original square (boundary rule pulls them in)', () => {
    // Plane spans (±1, 0, ±1). Vert points are ids 0..3 (original corners).
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    for (let id = 0; id < 4; id++) {
      const co = out.verts.get(id)!.co;
      expect(Math.abs(co.x)).toBeLessThan(1);
      expect(Math.abs(co.z)).toBeLessThan(1);
    }
  });

  it('edge-point verts sit at the boundary edge midpoints', () => {
    // Edge points are ids 4..7 (added after the 4 vert points). Each boundary
    // edge point equals its endpoint midpoint — check the (-1,0,-1)-(1,0,-1)
    // edge midpoint (0,0,-1) is present among the edge points.
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    const edgePts: Vec3[] = [];
    for (let id = 4; id < 8; id++) edgePts.push(out.verts.get(id)!.co);
    const hasMidpoint = edgePts.some((p) => p.equalsApprox(new Vec3(0, 0, -1)));
    expect(hasMidpoint).toBe(true);
  });

  it('boundary edges of the result stay boundary (1 face)', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    let boundary = 0;
    for (const e of out.edges().values()) if (e.faces.length === 1) boundary++;
    expect(boundary).toBe(8); // the outer ring of the subdivided plane
  });
});
