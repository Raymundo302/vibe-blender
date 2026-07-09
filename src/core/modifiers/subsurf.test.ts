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
    // edge point equals its endpoint midpoint — check the (-1,1,0)-(1,1,0)
    // edge midpoint (0,1,0) is present among the edge points.
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    const edgePts: Vec3[] = [];
    for (let id = 4; id < 8; id++) edgePts.push(out.verts.get(id)!.co);
    const hasMidpoint = edgePts.some((p) => p.equalsApprox(new Vec3(0, 1, 0)));
    expect(hasMidpoint).toBe(true);
  });

  it('boundary edges of the result stay boundary (1 face)', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    let boundary = 0;
    for (const e of out.edges().values()) if (e.faces.length === 1) boundary++;
    expect(boundary).toBe(8); // the outer ring of the subdivided plane
  });
});

/** Does the mesh have any vert at (approximately) `target`? */
function hasVertAt(mesh: EditableMesh, target: Vec3): boolean {
  for (const v of mesh.verts.values()) if (v.co.equalsApprox(target)) return true;
  return false;
}

describe('Subdivision Surface modifier — edge creases', () => {
  // Cube edge 0↔1 spans (-1,-1,-1)→(1,-1,-1). Its LINEAR midpoint is (0,-1,-1);
  // its uncreased SMOOTH edge point (verified) is (0,-0.75,-0.75).
  const linearMid = new Vec3(0, -1, -1);
  const smoothPt = new Vec3(0, -0.75, -0.75);

  it('an uncreased edge’s point is the smoothed (not linear) midpoint', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makeCube());
    expect(hasVertAt(out, smoothPt)).toBe(true);
    expect(hasVertAt(out, linearMid)).toBe(false);
  });

  it('crease 1.0 → the edge point equals the linear midpoint (stays sharp)', () => {
    const cube = makeCube();
    cube.setCrease(0, 1, 1);
    const out = createModifier('subsurf', { levels: 1 }).apply(cube);
    expect(hasVertAt(out, linearMid)).toBe(true);
    expect(hasVertAt(out, smoothPt)).toBe(false);
  });

  it('crease 0.5 lands strictly between the w=0 and w=1 positions', () => {
    const cube = makeCube();
    cube.setCrease(0, 1, 0.5);
    const out = createModifier('subsurf', { levels: 1 }).apply(cube);
    const mid = smoothPt.lerp(linearMid, 0.5); // (0, -0.875, -0.875)
    expect(hasVertAt(out, mid)).toBe(true);
    // strictly between: y is below the smooth y and above the sharp y
    expect(mid.y).toBeLessThan(smoothPt.y);
    expect(mid.y).toBeGreaterThan(linearMid.y);
  });

  it('child edges inherit the parent crease so it survives further subdivision', () => {
    const cube = makeCube();
    cube.setCrease(0, 1, 1);
    const out = createModifier('subsurf', { levels: 1 }).apply(cube);
    // The creased parent split into two fully-creased child edges.
    let full = 0;
    for (const w of out.creases.values()) if (w === 1) full++;
    expect(full).toBe(2);
    // The crease keeps propagating: level 2 still carries full-weight creases.
    const out2 = createModifier('subsurf', { levels: 2 }).apply(cube);
    let full2 = 0;
    for (const w of out2.creases.values()) if (w === 1) full2++;
    expect(full2).toBe(4); // each of the 2 child edges split again

    // …and near the creased edge the surface stays sharper (closer to the
    // original corner y=-1) than the uncreased cube at the same level.
    const plain2 = createModifier('subsurf', { levels: 2 }).apply(makeCube());
    const minYNearEdge = (m: EditableMesh): number => {
      let y = Infinity;
      for (const v of m.verts.values()) {
        if (Math.abs(v.co.x) < 1e-6 && Math.abs(v.co.z + 1) < 0.3) y = Math.min(y, v.co.y);
      }
      return y;
    };
    expect(minYNearEdge(out2)).toBeLessThan(minYNearEdge(plain2));
  });

  it('tint carries to every child face', () => {
    const cube = makeCube();
    cube.faceTints.set(0, [0.2, 0.4, 0.6]);
    const out = createModifier('subsurf', { levels: 1 }).apply(cube);
    // Face 0 (a quad) subdivides into the first 4 output faces, all tinted.
    expect(out.faceTints.size).toBe(4);
    for (let id = 0; id < 4; id++) {
      expect(out.faceTints.get(id)).toEqual([0.2, 0.4, 0.6]);
    }
  });
});

/** Deterministic string form of a mesh including per-corner UVs. */
function serializeMesh(m: EditableMesh): string {
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const verts = [...m.verts.values()].sort((a, b) => a.id - b.id)
    .map((v) => [v.id, r(v.co.x), r(v.co.y), r(v.co.z)]);
  const faces = [...m.faces.values()].sort((a, b) => a.id - b.id).map((f) => [f.id, f.verts]);
  const uvs = [...m.uvs.entries()].sort((a, b) => a[0] - b[0])
    .map(([id, us]) => [id, us.map(([u, v]) => [r(u), r(v)])]);
  return JSON.stringify({ verts, faces, uvs });
}

describe('Subdivision Surface modifier — UVs (P11-5)', () => {
  // makePlane's single face is [0,3,2,1]; give its 4 corners the unit square.
  const uvPlane = (): EditableMesh => {
    const p = makePlane(2);
    p.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    return p;
  };

  it('level 1 → 4 child quads with the exact bilinear-subdivision corner UVs', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(uvPlane());
    // Child faces are ids 0..3, one per parent corner. Face-average uv=(0.5,0.5).
    expect(out.uvs.get(0)).toEqual([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]);
    expect(out.uvs.get(1)).toEqual([[1, 0], [1, 0.5], [0.5, 0.5], [0.5, 0]]);
    expect(out.uvs.get(2)).toEqual([[1, 1], [0.5, 1], [0.5, 0.5], [1, 0.5]]);
    expect(out.uvs.get(3)).toEqual([[0, 1], [0, 0.5], [0.5, 0.5], [0.5, 1]]);
  });

  it('level 2 keeps every corner UV inside the original [0,1] span', () => {
    const out = createModifier('subsurf', { levels: 2 }).apply(uvPlane());
    expect(out.uvs.size).toBe(16); // 4 child quads each split into 4
    for (const us of out.uvs.values()) {
      for (const [u, v] of us) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a face without UVs stays without UVs', () => {
    const out = createModifier('subsurf', { levels: 1 }).apply(makePlane(2));
    expect(out.uvs.size).toBe(0);
  });

  it('is deterministic — apply twice → byte-equal serialize (UVs included)', () => {
    const a = createModifier('subsurf', { levels: 2 }).apply(uvPlane());
    const b = createModifier('subsurf', { levels: 2 }).apply(uvPlane());
    expect(serializeMesh(a)).toBe(serializeMesh(b));
  });

  it('is pure — the input mesh UVs are untouched', () => {
    const p = uvPlane();
    createModifier('subsurf', { levels: 2 }).apply(p);
    expect(p.uvs.get(0)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(p.uvs.size).toBe(1);
  });
});
