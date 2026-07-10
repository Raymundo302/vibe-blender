import { describe, it, expect } from 'vitest';
import { exportObj, parseObj } from './obj';
import { Scene } from '../core/scene/Scene';
import { makeCube } from '../core/mesh/primitives';
import { Transform } from '../core/math/transform';
import { Vec3 } from '../core/math/vec3';

/** Lines of a given record type (e.g. 'v', 'f') in an exported .obj. */
function linesOf(obj: string, key: string): string[] {
  return obj.split('\n').filter((l) => l.startsWith(`${key} `));
}

describe('exportObj', () => {
  it('exports a cube to 8 v + 6 f lines with correct indices', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    const obj = exportObj(scene);

    expect(obj.startsWith('# Vibe Blender')).toBe(true);
    expect(obj).toContain('o Cube');
    expect(linesOf(obj, 'v')).toHaveLength(8);

    const faces = linesOf(obj, 'f');
    expect(faces).toHaveLength(6);
    // Every face index is global 1-based, within 1..8 for a single cube.
    for (const f of faces) {
      const idx = f.slice(2).split(' ').map(Number);
      expect(idx).toHaveLength(4);
      for (const i of idx) expect(i).toBeGreaterThanOrEqual(1), expect(i).toBeLessThanOrEqual(8);
    }
    // First cube face is +Z = verts [4,5,6,7] → 1-based [5,6,7,8].
    expect(faces[0]).toBe('f 5 6 7 8');
  });

  it('skips non-mesh objects (lights/cameras emit no geometry)', () => {
    const scene = new Scene();
    scene.add('Cube', makeCube());
    scene.addLight('Point', 'point');
    scene.addCamera('Camera');
    const obj = exportObj(scene);

    // Only the cube is exported: 8 verts, one `o` block, and no light/camera names.
    expect(linesOf(obj, 'v')).toHaveLength(8);
    expect(linesOf(obj, 'o')).toEqual(['o Cube']);
    expect(obj).not.toContain('Point');
    expect(obj).not.toContain('Camera');
  });

  it('bakes the transform into world-space vertices', () => {
    const scene = new Scene();
    const o = scene.add('Cube', makeCube());
    o.transform = new Transform(new Vec3(10, 0, 0)); // translate +X by 10
    const obj = exportObj(scene);
    // Cube half-extent 1 → x ranges 9..11 after the offset (X is axis-invariant).
    const xs = linesOf(obj, 'v').map((l) => Number(l.split(' ')[1]));
    expect(Math.min(...xs)).toBeCloseTo(9, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
  });

  it('converts Z-up world → Y-up OBJ (cube on the ground)', () => {
    // A unit cube (half-extent 1) sitting ON the ground: its base at z=0, top at
    // z=2 in the Z-up world. After export it must be Y-up: y in 0..2, z centered.
    const scene = new Scene();
    const o = scene.add('Cube', makeCube());
    o.transform = new Transform(new Vec3(0, 0, 1)); // lift so z spans 0..2
    const obj = exportObj(scene);
    const vs = linesOf(obj, 'v').map((l) => l.split(' ').slice(1).map(Number));
    const ys = vs.map((v) => v[1]);
    const zs = vs.map((v) => v[2]);
    // "Up" is now OBJ Y, spanning the same 0..2 the world Z did.
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(2, 6);
    // World Y (now OBJ -Z) was centered at 0 → OBJ z stays centered at 0.
    expect(Math.min(...zs)).toBeCloseTo(-1, 6);
    expect(Math.max(...zs)).toBeCloseTo(1, 6);
  });

  it('offsets the second object\'s face indices by the first\'s vert count', () => {
    const scene = new Scene();
    scene.add('A', makeCube());
    scene.add('B', makeCube());
    const obj = exportObj(scene);
    expect(linesOf(obj, 'v')).toHaveLength(16);
    const faces = linesOf(obj, 'f');
    expect(faces).toHaveLength(12);
    // Every index in the first 6 faces is 1..8; the last 6 are 9..16.
    const idxs = faces.map((f) => f.slice(2).split(' ').map(Number));
    expect(idxs.slice(0, 6).flat().every((i) => i >= 1 && i <= 8)).toBe(true);
    expect(idxs.slice(6).flat().every((i) => i >= 9 && i <= 16)).toBe(true);
  });

  it('skips invisible objects', () => {
    const scene = new Scene();
    scene.add('A', makeCube());
    const b = scene.add('B', makeCube());
    b.visible = false;
    const obj = exportObj(scene);
    expect(obj).toContain('o A');
    expect(obj).not.toContain('o B');
    expect(linesOf(obj, 'v')).toHaveLength(8);
  });
});

describe('parseObj', () => {
  it('round-trips our own export back to the original Z-up positions (identity)', () => {
    // Use an asymmetric placement (cube lifted onto the ground) so the axis
    // conversion is actually exercised — a symmetric cube would pass trivially.
    const scene = new Scene();
    const o = scene.add('Cube', makeCube());
    o.transform = new Transform(new Vec3(0, 0, 1)); // base at z=0, top at z=2
    const obj = exportObj(scene);
    const parsed = parseObj(obj);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Cube');
    expect(parsed[0].positions).toHaveLength(8);
    expect(parsed[0].faces).toHaveLength(6);

    // Export→import must reproduce the ORIGINAL Z-up world coordinates exactly.
    const key = (p: number[]) => p.map((n) => n.toFixed(3)).join(',');
    const mesh = o.mesh;
    const worldV = [...mesh.verts.values()].map((v) => {
      const w = scene.worldMatrix(o).transformPoint(v.co);
      return key([w.x, w.y, w.z]);
    });
    expect(parsed[0].positions.map(key).sort()).toEqual(worldV.sort());
  });

  it('round-trips a two-object export into two objects', () => {
    const scene = new Scene();
    scene.add('A', makeCube());
    scene.add('B', makeCube());
    const parsed = parseObj(exportObj(scene));
    expect(parsed.map((o) => o.name)).toEqual(['A', 'B']);
    // Each object's faces are remapped to its own 0..7 local verts.
    for (const o of parsed) {
      expect(o.positions).toHaveLength(8);
      expect(o.faces.flat().every((i) => i >= 0 && i < 8)).toBe(true);
    }
  });

  it('imports a known Y-up OBJ upright (Y-up → Z-up, tallest axis becomes Z)', () => {
    // A thin pillar standing along OBJ Y (Y-up "up"): after import its height
    // must live on world Z (Z-up "up"), landing upright rather than lying down.
    const text = [
      'o Pillar',
      'v 0 0 0', 'v 1 0 0', 'v 1 10 0', 'v 0 10 0', // a wall rising along +Y
      'f 1 2 3 4',
    ].join('\n');
    const parsed = parseObj(text);
    expect(parsed).toHaveLength(1);
    const zs = parsed[0].positions.map((p) => p[2]); // world Z (up)
    const ys = parsed[0].positions.map((p) => p[1]); // world Y (depth)
    // The 0..10 extent moved onto world Z (up); world Y stays flat at 0.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(10, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0, 6);
  });

  it('parses the a/b/c face form (takes the vertex index)', () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3\n';
    const parsed = parseObj(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('imported');
    expect(parsed[0].faces[0]).toEqual([0, 1, 2]);
  });

  it('parses negative (relative) indices', () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n';
    const parsed = parseObj(text);
    expect(parsed[0].faces[0]).toEqual([0, 1, 2]);
  });

  it('splits objects on o/g and skips vt/vn/usemtl lines', () => {
    const text = [
      'o First',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'vt 0 0', 'vn 0 1 0', 'usemtl red', 's 1',
      'f 1 2 3',
      'g Second',
      'v 2 0 0', 'v 3 0 0', 'v 2 1 0',
      'f 4 5 6',
    ].join('\n');
    const parsed = parseObj(text);
    expect(parsed.map((o) => o.name)).toEqual(['First', 'Second']);
    // Second object's global indices 4,5,6 remap to local 0,1,2.
    expect(parsed[1].faces[0]).toEqual([0, 1, 2]);
    // OBJ `v 2 0 0` (Y-up) imports to Z-up (x, -z, y) = (2, 0, 0). Normalize -0.
    expect(parsed[1].positions[0].map((n) => n + 0)).toEqual([2, 0, 0]);
  });

  it('throws on garbage input (no vertices)', () => {
    expect(() => parseObj('this is not an obj file at all')).toThrow();
    expect(() => parseObj('{ not json either')).toThrow();
  });

  it('throws on a face index out of range', () => {
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n')).toThrow(/out of range/);
  });

  it('throws on a malformed vertex line', () => {
    expect(() => parseObj('v 0 zzz 0\nf 1 1 1\n')).toThrow();
  });
});
