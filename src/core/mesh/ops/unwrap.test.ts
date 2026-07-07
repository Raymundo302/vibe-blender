import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { makeCube } from '../primitives';
import { Vec3 } from '../../math/vec3';
import { Mat4 } from '../../math/mat4';
import { seamIslands, unwrapIslands, smartUvProject, projectFromView } from './unwrap';

/** Every UV of every face lies inside [0,1]² (no NaNs). */
function allUVsInUnitSquare(mesh: EditableMesh): boolean {
  for (const uvs of mesh.uvs.values()) {
    for (const [u, v] of uvs) {
      if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) return false;
    }
  }
  return true;
}

/** Deterministic serialization of the whole UV map (sorted by face id). */
function serializeUVs(mesh: EditableMesh): string {
  return JSON.stringify([...mesh.uvs.entries()].sort((a, b) => a[0] - b[0]));
}

interface Torus {
  mesh: EditableMesh;
  major: number;
  minor: number;
  idx: (i: number, j: number) => number;
}

/** A radius-major/minor torus as a wrapped quad grid (all quads). */
function makeTorus(major = 6, minor = 5, R = 1.6, r = 0.6): Torus {
  const m = new EditableMesh();
  const ids: number[] = [];
  for (let i = 0; i < major; i++) {
    const u = (2 * Math.PI * i) / major;
    for (let j = 0; j < minor; j++) {
      const v = (2 * Math.PI * j) / minor;
      const rad = R + r * Math.cos(v);
      ids.push(m.addVert(new Vec3(rad * Math.cos(u), r * Math.sin(v), rad * Math.sin(u))));
    }
  }
  const idx = (i: number, j: number) => ids[(i % major) * minor + (j % minor)];
  for (let i = 0; i < major; i++)
    for (let j = 0; j < minor; j++)
      m.addFace([idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)]);
  return { mesh: m, major, minor, idx };
}

describe('seamIslands', () => {
  it('a cube with the +Y face ringed by seams splits into 2 islands', () => {
    const mesh = makeCube();
    // +Y face is [7,6,2,3]; mark all four of its edges as seams to isolate it.
    const ring = [[7, 6], [6, 2], [2, 3], [3, 7]] as const;
    for (const [a, b] of ring) mesh.setSeam(a, b, true);
    const islands = seamIslands(mesh, mesh.faces.keys());
    expect(islands.length).toBe(2);
    // One island is the lone top face; the other is the remaining five.
    const sizes = islands.map((i) => i.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 5]);
  });

  it('a seamless cube is a single island', () => {
    const mesh = makeCube();
    expect(seamIslands(mesh, mesh.faces.keys()).length).toBe(1);
  });
});

describe('unwrapIslands (Tutte)', () => {
  it('populates UVs for every face, all inside [0,1]², no NaNs', () => {
    const mesh = makeCube();
    unwrapIslands(mesh, mesh.faces.keys());
    expect(mesh.uvs.size).toBe(mesh.faces.size);
    expect(allUVsInUnitSquare(mesh)).toBe(true);
  });

  it('a plane-ish island: boundary maps to a circle, interior stays inside it', () => {
    // A 3×3 grid quad patch — one disk island with a clear interior vertex.
    const mesh = new EditableMesh();
    const N = 3;
    const id: number[][] = [];
    for (let i = 0; i <= N; i++) {
      id[i] = [];
      for (let j = 0; j <= N; j++) id[i][j] = mesh.addVert(new Vec3(i, 0, j));
    }
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        mesh.addFace([id[i][j], id[i][j + 1], id[i + 1][j + 1], id[i + 1][j]]);

    unwrapIslands(mesh, mesh.faces.keys());
    expect(allUVsInUnitSquare(mesh)).toBe(true);

    // Interior vert id[1][1] appears in 4 faces; gather one of its UVs.
    const interiorVert = id[1][1];
    let interiorUV: [number, number] | null = null;
    const boundaryUVs: [number, number][] = [];
    for (const [fid, uvs] of mesh.uvs) {
      const vs = mesh.faces.get(fid)!.verts;
      vs.forEach((v, k) => {
        if (v === interiorVert) interiorUV = uvs[k];
        // corner verts of the patch are on the boundary
        if (v === id[0][0] || v === id[0][N] || v === id[N][0] || v === id[N][N]) {
          boundaryUVs.push(uvs[k]);
        }
      });
    }
    expect(interiorUV).not.toBeNull();
    // The interior UV sits within the boundary bbox (strictly, with slack).
    const bx = boundaryUVs.map((p) => p[0]);
    const by = boundaryUVs.map((p) => p[1]);
    const [iu, iv] = interiorUV!;
    expect(iu).toBeGreaterThan(Math.min(...bx) - 1e-6);
    expect(iu).toBeLessThan(Math.max(...bx) + 1e-6);
    expect(iv).toBeGreaterThan(Math.min(...by) - 1e-6);
    expect(iv).toBeLessThan(Math.max(...by) + 1e-6);
  });

  it('a torus with two seam loops unwraps to one island of sane aspect', () => {
    const { mesh, major, minor, idx } = makeTorus();
    // Seam one meridian (i=0 column) and one longitude (j=0 row) to open the torus.
    for (let j = 0; j < minor; j++) mesh.setSeam(idx(0, j), idx(0, j + 1), true);
    for (let i = 0; i < major; i++) mesh.setSeam(idx(i, 0), idx(i + 1, 0), true);

    const islands = seamIslands(mesh, mesh.faces.keys());
    expect(islands.length).toBe(1);

    unwrapIslands(mesh, mesh.faces.keys());
    expect(allUVsInUnitSquare(mesh)).toBe(true);

    // Aspect sanity: the packed island's bbox is neither degenerate nor a sliver.
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const uvs of mesh.uvs.values()) for (const [u, v] of uvs) {
      minx = Math.min(minx, u); maxx = Math.max(maxx, u);
      miny = Math.min(miny, v); maxy = Math.max(maxy, v);
    }
    const aspect = (maxx - minx) / (maxy - miny);
    expect(aspect).toBeGreaterThan(0.25);
    expect(aspect).toBeLessThan(4);
  });

  it('is deterministic (two runs serialize byte-equal)', () => {
    const a = makeCube();
    const b = makeCube();
    unwrapIslands(a, a.faces.keys());
    unwrapIslands(b, b.faces.keys());
    expect(serializeUVs(a)).toBe(serializeUVs(b));
  });
});

describe('smartUvProject', () => {
  it('a cube resolves to 6 separated islands, all UVs in [0,1]²', () => {
    const mesh = makeCube();
    smartUvProject(mesh, mesh.faces.keys());
    expect(mesh.uvs.size).toBe(6);
    expect(allUVsInUnitSquare(mesh)).toBe(true);
    // Each of the 6 faces packs to its own bbox center → 6 distinct centers.
    const centers = new Set<string>();
    for (const uvs of mesh.uvs.values()) {
      let cx = 0, cy = 0;
      for (const [u, v] of uvs) { cx += u; cy += v; }
      cx /= uvs.length; cy /= uvs.length;
      centers.add(`${cx.toFixed(3)},${cy.toFixed(3)}`);
    }
    expect(centers.size).toBe(6);
  });

  it('is deterministic', () => {
    const a = makeCube();
    const b = makeCube();
    smartUvProject(a, a.faces.keys());
    smartUvProject(b, b.faces.keys());
    expect(serializeUVs(a)).toBe(serializeUVs(b));
  });
});

describe('projectFromView', () => {
  it('maps a front-facing 2×1 quad to its screen-space aspect (~2:1)', () => {
    // Quad in the XY plane (2 wide, 1 tall), facing +Z toward the camera.
    const mesh = new EditableMesh();
    const v0 = mesh.addVert(new Vec3(-1, -0.5, 0));
    const v1 = mesh.addVert(new Vec3(1, -0.5, 0));
    const v2 = mesh.addVert(new Vec3(1, 0.5, 0));
    const v3 = mesh.addVert(new Vec3(-1, 0.5, 0));
    const fid = mesh.addFace([v0, v1, v2, v3]);

    const aspect = 16 / 9;
    const proj = Mat4.perspective((50 * Math.PI) / 180, aspect, 0.1, 100);
    const view = Mat4.lookAt(new Vec3(0, 0, 6), Vec3.ZERO, Vec3.Y);
    const mvp = proj.mul(view);

    projectFromView(mesh, [fid], mvp, aspect);
    const uvs = mesh.uvs.get(fid)!;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [u, v] of uvs) {
      minx = Math.min(minx, u); maxx = Math.max(maxx, u);
      miny = Math.min(miny, v); maxy = Math.max(maxy, v);
    }
    const uvAspect = (maxx - minx) / (maxy - miny);
    expect(uvAspect).toBeGreaterThan(1.8);
    expect(uvAspect).toBeLessThan(2.2);
    // Normalised into the unit square.
    expect(minx).toBeGreaterThanOrEqual(-1e-6);
    expect(maxx).toBeLessThanOrEqual(1 + 1e-6);
  });
});
