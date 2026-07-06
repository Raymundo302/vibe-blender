import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import { Transform } from '../../math/transform';
import { makeCube } from '../primitives';
import { appendBaked } from './join';

describe('appendBaked', () => {
  it('bakes a moved+scaled cube into a target cube (16 verts / 12 faces)', () => {
    // Active cube sits at the origin (identity model) → bake matrix is just the
    // source's own model. Source cube: translated (3,0,0), uniform scale 2.
    const target = makeCube();
    const source = makeCube();
    const srcModel = new Transform(new Vec3(3, 0, 0), undefined, new Vec3(2, 2, 2)).matrix();
    const activeInv = new Transform().matrix().invert(); // identity

    const map = appendBaked(target, source, activeInv.mul(srcModel));

    expect(target.verts.size).toBe(16);
    expect(target.faces.size).toBe(12);
    expect(map.size).toBe(8);

    // Hand-computed world position of the source's (1,1,1) corner:
    // world = (3,0,0) + 2 * (1,1,1) = (5,2,2). Find its baked twin.
    const cornerOld = [...source.verts.values()].find(
      (v) => v.co.x === 1 && v.co.y === 1 && v.co.z === 1,
    )!;
    const baked = target.verts.get(map.get(cornerOld.id)!)!;
    expect(baked.co.x).toBeCloseTo(5, 10);
    expect(baked.co.y).toBeCloseTo(2, 10);
    expect(baked.co.z).toBeCloseTo(2, 10);
  });

  it('mints fresh ids (no collision with the target) and keeps each shell manifold', () => {
    const target = makeCube();
    const source = makeCube();
    const targetVertIds = new Set(target.verts.keys());

    const map = appendBaked(target, source, new Transform(new Vec3(5, 0, 0)).matrix());

    // Every appended vert id is new relative to the pre-append target.
    for (const newId of map.values()) expect(targetVertIds.has(newId)).toBe(false);

    // Both cube shells: every edge is shared by exactly 2 faces (per-shell manifold).
    const edges = target.edges();
    expect(edges.size).toBe(24); // 12 edges per cube, two disjoint shells
    for (const e of edges.values()) expect(e.faces.length).toBe(2);
  });

  it('does not mutate the source mesh', () => {
    const source = makeCube();
    const before = source.version;
    const target = new EditableMesh();
    appendBaked(target, source, new Transform().matrix());
    expect(source.version).toBe(before);
    expect(source.verts.size).toBe(8);
  });
});
