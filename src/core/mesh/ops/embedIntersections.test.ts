import { describe, it, expect } from 'vitest';
import { Mat4 } from '../../math/mat4';
import { Vec3 } from '../../math/vec3';
import { Quat } from '../../math/quat';
import { Transform } from '../../math/transform';
import { makeCube, makePlane } from '../primitives';
import { embedIntersections, type IntersectItem } from './embedIntersections';
import { EmbedIntersectionsCommand } from '../../undo/intersectCommand';

/** Snapshot of a mesh's vert positions keyed by id (for exact-restore checks). */
function positions(mesh: { verts: Map<number, { co: Vec3 }> }): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  for (const [id, v] of mesh.verts) out.set(id, [v.co.x, v.co.y, v.co.z]);
  return out;
}

describe('embedIntersections', () => {
  it('a plane object crossing a cube pierces the 4 vertical edges → 4 verts, 4 side-face splits', () => {
    const cube = makeCube(1); // ±1 in every axis, 8 verts / 6 faces
    const plane = makePlane(4); // 4-wide quad at z=0, normal +Z — spans the cube in x/y
    const items: IntersectItem[] = [
      { mesh: cube, world: Mat4.identity() },
      { mesh: plane, world: Mat4.identity() },
    ];

    const res = embedIntersections(items);

    // Cube: 4 vertical edges cross z=0 → 4 new verts; each of the 4 side faces
    // gains its two vertical-edge verts → chord split. Top/bottom faces (no
    // vertical edges) are untouched.
    expect(res[0]).toEqual({ verts: 4, splits: 4 });
    expect(cube.verts.size).toBe(12); // 8 + 4
    expect(cube.faces.size).toBe(10); // 2 untouched top/bottom + 4 side faces each split in two

    // The plane's single big face is crossed only through its INTERIOR — no plane
    // edge pierces the cube — so it gains nothing (documented v1 limitation).
    expect(res[1]).toEqual({ verts: 0, splits: 0 });
    expect(plane.verts.size).toBe(4);
    expect(plane.faces.size).toBe(1);

    // Every new cube vert sits on a vertical edge at z=0, x/y = ±1.
    const news = [...cube.verts.values()].filter((v) => Math.abs(v.co.z) < 1e-9);
    expect(news.length).toBe(4);
    for (const v of news) {
      expect(Math.abs(Math.abs(v.co.x) - 1) < 1e-9).toBe(true);
      expect(Math.abs(Math.abs(v.co.y) - 1) < 1e-9).toBe(true);
    }
    // Result stays a valid mesh (no degenerate faces).
    for (const f of cube.faces.values()) expect(f.verts.length).toBeGreaterThanOrEqual(3);
  });

  it('respects object transforms: cube translated + rotated still gets 4 verts / 4 splits', () => {
    const cube = makeCube(1);
    const plane = makePlane(6); // wider so the rotated/translated cube stays inside
    // Cube pushed up +0.4 in z (still straddles z=0) and yawed 30° about Z (its
    // vertical edges stay vertical, so the plane at z=0 still cuts all four).
    const cubeWorld = new Transform(
      new Vec3(0, 0, 0.4),
      Quat.fromAxisAngle(new Vec3(0, 0, 1), Math.PI / 6),
      Vec3.ONE,
    ).matrix();

    const res = embedIntersections([
      { mesh: cube, world: cubeWorld },
      { mesh: plane, world: Mat4.identity() },
    ]);

    expect(res[0]).toEqual({ verts: 4, splits: 4 });
    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10);

    // New verts are in LOCAL space: each vertical edge (local x/y = ±1, z ∈ [-1,1])
    // crosses world z=0 → local z = -0.4. So every new vert has local z ≈ -0.4.
    const news = [...cube.verts.values()].filter((v) => v.co.z < -0.3 && v.co.z > -0.5);
    expect(news.length).toBe(4);
    for (const v of news) {
      expect(Math.abs(v.co.z + 0.4) < 1e-6).toBe(true);
      expect(Math.abs(Math.abs(v.co.x) - 1) < 1e-6).toBe(true);
      expect(Math.abs(Math.abs(v.co.y) - 1) < 1e-6).toBe(true);
    }
  });

  it('two interpenetrating cubes: BOTH meshes are edited', () => {
    const a = makeCube(1);
    const b = makeCube(1);
    // Generic offset — avoids coplanar/boundary-touch degeneracies, so edges of
    // each cube pierce faces of the other transversally.
    const bWorld = Mat4.translation(new Vec3(1.2, 0.5, 0.3));

    const res = embedIntersections([
      { mesh: a, world: Mat4.identity() },
      { mesh: b, world: bWorld },
    ]);

    expect(res[0].verts).toBeGreaterThan(0);
    expect(res[1].verts).toBeGreaterThan(0);
    expect(res[0].splits + res[1].splits).toBeGreaterThan(0);
    expect(a.verts.size).toBeGreaterThan(8);
    expect(b.verts.size).toBeGreaterThan(8);
    for (const f of a.faces.values()) expect(f.verts.length).toBeGreaterThanOrEqual(3);
    for (const f of b.faces.values()) expect(f.verts.length).toBeGreaterThanOrEqual(3);
  });

  it('no intersection → zero mutations, mesh version unchanged', () => {
    const a = makeCube(1);
    const b = makeCube(1);
    const vA = a.version;
    const vB = b.version;

    const res = embedIntersections([
      { mesh: a, world: Mat4.identity() },
      { mesh: b, world: Mat4.translation(new Vec3(10, 0, 0)) }, // far apart
    ]);

    expect(res).toEqual([{ verts: 0, splits: 0 }, { verts: 0, splits: 0 }]);
    expect(a.verts.size).toBe(8);
    expect(b.verts.size).toBe(8);
    expect(a.version).toBe(vA);
    expect(b.version).toBe(vB);
  });

  it('EmbedIntersectionsCommand undo/redo restores both meshes exactly', () => {
    const cube = makeCube(1);
    const plane = makePlane(4);
    const items: IntersectItem[] = [
      { mesh: cube, world: Mat4.identity() },
      { mesh: plane, world: Mat4.identity() },
    ];
    const beforeCubePos = positions(cube);
    const beforePlanePos = positions(plane);

    const before = items.map((it) => it.mesh.clone());
    embedIntersections(items);
    const after = items.map((it) => it.mesh.clone());
    expect(cube.verts.size).toBe(12);

    const cmd = new EmbedIntersectionsCommand([cube, plane], before, after);

    cmd.undo();
    expect(cube.verts.size).toBe(8);
    expect(cube.faces.size).toBe(6);
    expect(plane.verts.size).toBe(4);
    // Exact positions restored.
    expect(positions(cube)).toEqual(beforeCubePos);
    expect(positions(plane)).toEqual(beforePlanePos);

    cmd.redo();
    expect(cube.verts.size).toBe(12);
    expect(cube.faces.size).toBe(10);
  });
});
