import { describe, it, expect } from 'vitest';
import { bakeResolution, graphUsesGenerated, rasterizeGenerated } from './bake';
import { emptyGraph, addNode, addLink, type NodeGraph } from './nodeGraph';
import './builtins';
import { EditableMesh } from '../mesh/EditableMesh';
import { Vec3 } from '../math/vec3';
import { makeCube } from '../mesh/primitives';

// ------------------------------------------------------------- bakeResolution --

describe('bakeResolution', () => {
  it('defaults to 128 when bakeRes is absent', () => {
    expect(bakeResolution({ bakeRes: undefined })).toBe(128);
  });
  it('honors the allowed resolutions', () => {
    expect(bakeResolution({ bakeRes: 128 })).toBe(128);
    expect(bakeResolution({ bakeRes: 256 })).toBe(256);
    expect(bakeResolution({ bakeRes: 512 })).toBe(512);
    expect(bakeResolution({ bakeRes: 1024 })).toBe(1024);
  });
  it('falls back to 128 for a disallowed value', () => {
    expect(bakeResolution({ bakeRes: 333 })).toBe(128);
    expect(bakeResolution({ bakeRes: 0 })).toBe(128);
  });
});

// ---------------------------------------------------------- graphUsesGenerated --

/** texCoord.<socket> → noise.uv → principled.baseColor. */
function graphFrom(socket: 'generated' | 'uv'): NodeGraph {
  const g = emptyGraph();
  const tc = addNode(g, 'texCoord', 0, 0);
  const noise = addNode(g, 'noise', 0, 0);
  const out = g.nodes.find((n) => n.type === 'principled')!;
  expect(addLink(g, tc.id, socket, noise.id, 'uv')).toBe(true);
  expect(addLink(g, noise.id, 'value', out.id, 'baseColor')).toBe(true);
  return g;
}

describe('graphUsesGenerated', () => {
  it('true when a texCoord generated output is linked', () => {
    expect(graphUsesGenerated(graphFrom('generated'))).toBe(true);
  });
  it('false when only the uv output is used', () => {
    expect(graphUsesGenerated(graphFrom('uv'))).toBe(false);
  });
  it('false for a graph with no texCoord node', () => {
    const g = emptyGraph();
    const noise = addNode(g, 'noise', 0, 0);
    const out = g.nodes.find((n) => n.type === 'principled')!;
    addLink(g, noise.id, 'value', out.id, 'baseColor');
    expect(graphUsesGenerated(g)).toBe(false);
  });
});

// --------------------------------------------------------- rasterizeGenerated --

/** A single 2×2 quad in the XY plane, fully UV-unwrapped to the [0,1] square.
 *  Local positions span 0..2 in x/y, flat in z → generated coord = (u, v, 0.5)
 *  at every surface point (gen.x tracks position.x tracks UV.u; z axis is
 *  degenerate → 0.5). This is exactly the tracer's triGen definition, so a
 *  rasterized texel must reproduce it analytically. */
function unitQuad(): EditableMesh {
  const m = new EditableMesh();
  const a = m.addVert(new Vec3(0, 0, 0));
  const b = m.addVert(new Vec3(2, 0, 0));
  const c = m.addVert(new Vec3(2, 2, 0));
  const d = m.addVert(new Vec3(0, 2, 0));
  const f = m.addFace([a, b, c, d]);
  m.setFaceUVs(f, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  return m;
}

describe('rasterizeGenerated', () => {
  it('returns null for a mesh with no UVs (fall back to plain UV bake)', () => {
    const cube = makeCube(1);
    cube.uvs.clear();
    expect(rasterizeGenerated(cube, 16)).toBeNull();
  });

  it('covers the whole UV square for a full-square unwrap', () => {
    const r = rasterizeGenerated(unitQuad(), 8);
    expect(r).not.toBeNull();
    // Every texel is inside the [0,1] UV quad → all covered.
    for (let i = 0; i < r!.covered.length; i++) expect(r!.covered[i]).toBe(1);
  });

  it('matches the tracer generated-coord definition at each texel', () => {
    const size = 8;
    const r = rasterizeGenerated(unitQuad(), size)!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = y * size + x;
        const u = (x + 0.5) / size;
        const v = (y + 0.5) / size;
        const gi = t * 3;
        expect(r.gen[gi]).toBeCloseTo(u, 5);      // gen.x == UV.u
        expect(r.gen[gi + 1]).toBeCloseTo(v, 5);  // gen.y == UV.v
        expect(r.gen[gi + 2]).toBeCloseTo(0.5, 5); // degenerate z → 0.5
      }
    }
  });

  it('produces texels that VARY (not the uniform UV fallback)', () => {
    const size = 8;
    const r = rasterizeGenerated(unitQuad(), size)!;
    const first = r.gen[0];
    const last = r.gen[(size * size - 1) * 3];
    // Opposite corners differ substantially on gen.x.
    expect(Math.abs(first - last)).toBeGreaterThan(0.5);
  });

  it('a UV-unwrapped cube fills covered texels with a spread of gen coords', () => {
    // makeCube ships a default cross unwrap → non-empty UVs.
    const cube = makeCube(1);
    expect(cube.uvs.size).toBeGreaterThan(0);
    const r = rasterizeGenerated(cube, 32)!;
    let covered = 0, min = Infinity, max = -Infinity;
    for (let t = 0; t < r.covered.length; t++) {
      if (!r.covered[t]) continue;
      covered++;
      const gx = r.gen[t * 3];
      if (gx < min) min = gx;
      if (gx > max) max = gx;
    }
    expect(covered).toBeGreaterThan(0);
    // Generated coords span the normalized cube (0..1 range reached).
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(0.9);
  });
});
