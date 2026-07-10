import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'displace'
import { createModifier } from './Modifier';
import { EditableMesh } from '../mesh/EditableMesh';
import { makeCube, makePlane } from '../mesh/primitives';

/** An n×n grid of quads in the XY plane (z = 0), face normals +Z, centered. */
function subdividedPlane(n: number): EditableMesh {
  const verts: [number, number, number][] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      verts.push([i / n - 0.5, j / n - 0.5, 0]);
    }
  }
  const idx = (i: number, j: number) => j * (n + 1) + i;
  const faces: number[][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    }
  }
  return EditableMesh.fromData(verts, faces);
}

describe('Displace modifier — strength 0', () => {
  it('strength 0 → positions unchanged', () => {
    const cube = makeCube(1);
    const out = createModifier('displace', { strength: 0 }).apply(cube);
    for (const v of cube.verts.values()) {
      expect(out.verts.get(v.id)!.co.equalsApprox(v.co)).toBe(true);
    }
  });
});

describe('Displace modifier — texture none (uniform inflate)', () => {
  it("texture 'none', midlevel 0 → every vert moves outward by exactly strength along its normal", () => {
    const strength = 0.25;
    const cube = makeCube(1);
    const out = createModifier('displace', {
      texture: 'none',
      midlevel: 0,
      strength,
    }).apply(cube);
    for (const v of cube.verts.values()) {
      const moved = out.verts.get(v.id)!.co;
      const delta = moved.sub(v.co);
      // Moved by exactly `strength` (unit normal · strength).
      expect(delta.length()).toBeCloseTo(strength, 6);
      // Cube is centered on the origin, so outward = same side as the vertex.
      expect(moved.length()).toBeGreaterThan(v.co.length());
    }
  });

  it('negative strength deflates (verts move inward)', () => {
    const cube = makeCube(1);
    const out = createModifier('displace', {
      texture: 'none',
      midlevel: 0,
      strength: -0.2,
    }).apply(cube);
    for (const v of cube.verts.values()) {
      expect(out.verts.get(v.id)!.co.length()).toBeLessThan(v.co.length());
    }
  });
});

describe('Displace modifier — noise', () => {
  it('noise on a subdivided plane makes it non-planar (z varies)', () => {
    const out = createModifier('displace', { texture: 'noise', strength: 0.5, scale: 4 })
      .apply(subdividedPlane(16));
    const zs = [...out.verts.values()].map((v) => v.co.z);
    const min = Math.min(...zs), max = Math.max(...zs);
    expect(max - min).toBeGreaterThan(0.05);
  });

  it('is deterministic — two applies give identical positions', () => {
    const p = () => createModifier('displace', { texture: 'noise', strength: 0.4, scale: 3, seed: 7 })
      .apply(subdividedPlane(8));
    const a = p(), b = p();
    for (const id of a.verts.keys()) {
      expect(a.verts.get(id)!.co.equalsApprox(b.verts.get(id)!.co)).toBe(true);
    }
  });

  it('a different seed gives a different result', () => {
    const mk = (seed: number) =>
      createModifier('displace', { texture: 'noise', strength: 0.4, scale: 3, seed }).apply(subdividedPlane(8));
    const a = mk(0), b = mk(1);
    let anyDiff = false;
    for (const id of a.verts.keys()) {
      if (!a.verts.get(id)!.co.equalsApprox(b.verts.get(id)!.co)) { anyDiff = true; break; }
    }
    expect(anyDiff).toBe(true);
  });

  it('midlevel 0.5 noise is roughly zero-mean over many verts', () => {
    const strength = 0.6;
    const mesh = subdividedPlane(20);
    const out = createModifier('displace', { texture: 'noise', strength, midlevel: 0.5, scale: 5 })
      .apply(mesh);
    // Displacement is along +Z here, so the vert z IS the signed displacement.
    let sum = 0, count = 0;
    for (const v of out.verts.values()) { sum += v.co.z; count++; }
    const mean = sum / count;
    expect(Math.abs(mean)).toBeLessThan(0.2 * strength);
  });
});

describe('Displace modifier — attribute preservation', () => {
  const uvPlane = () => {
    const p = makePlane(2);
    p.setFaceUVs(0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    p.setCrease(0, 1, 0.5);
    p.setSeam(1, 2, true);
    p.faceTints.set(0, [0.2, 0.4, 0.6]);
    return p;
  };

  it('topology (verts/faces/ids) is unchanged', () => {
    const cube = makeCube(1);
    const out = createModifier('displace', { texture: 'noise', strength: 0.3 }).apply(cube);
    expect([...out.verts.keys()]).toEqual([...cube.verts.keys()]);
    expect([...out.faces.keys()]).toEqual([...cube.faces.keys()]);
    expect([...out.faces.values()].map((f) => f.verts)).toEqual(
      [...cube.faces.values()].map((f) => f.verts),
    );
  });

  it('UVs, seams, creases and faceTints survive', () => {
    const out = createModifier('displace', { texture: 'noise', strength: 0.3 }).apply(uvPlane());
    expect(out.uvs.get(0)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(out.crease(0, 1)).toBe(0.5);
    expect(out.isSeam(1, 2)).toBe(true);
    expect(out.faceTints.get(0)).toEqual([0.2, 0.4, 0.6]);
  });

  it('is pure — the input mesh is untouched', () => {
    const cube = makeCube(1);
    const before = [...cube.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
    const ver = cube.version;
    createModifier('displace', { texture: 'noise', strength: 0.5 }).apply(cube);
    const after = [...cube.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
    expect(after).toEqual(before);
    expect(cube.version).toBe(ver);
  });
});

describe('Displace modifier — params round-trip', () => {
  it('params() reconstructs an identical modifier through createModifier', () => {
    const src = createModifier('displace', {
      texture: 'none',
      strength: -0.42,
      midlevel: 0.3,
      scale: 2.5,
      detail: 6,
      seed: 9,
    });
    const round = createModifier('displace', src.params());
    expect(round.params()).toEqual(src.params());
    expect(round.params()).toEqual({
      texture: 'none',
      strength: -0.42,
      midlevel: 0.3,
      scale: 2.5,
      detail: 6,
      seed: 9,
    });
  });

  it('defaults are strength 0.3 / midlevel 0.5 / scale 1 / detail 4 / seed 0 / noise', () => {
    expect(createModifier('displace').params()).toEqual({
      strength: 0.3,
      midlevel: 0.5,
      scale: 1,
      detail: 4,
      seed: 0,
      texture: 'noise',
    });
  });

  it('clamps midlevel to 0..1 and detail to 1..8', () => {
    const m = createModifier('displace', { midlevel: 5, detail: 99 });
    expect(m.params().midlevel).toBe(1);
    expect(m.params().detail).toBe(8);
  });
});
