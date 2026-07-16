import { describe, expect, it } from 'vitest';
import type { CurveData, SurfaceData } from '../scene/objectData';
import { defaultSurfaceData } from '../scene/objectData';
import { sampleUvLoop, tessellateSurface } from './tessellate';

/**
 * NB-C3 v2 trimmed-tessellation tests: untrimmed bit-identity (a golden
 * serialization captured against the pre-v2 code), a circular hole (no face in
 * the hole, snapped edge smoothness, kept-area accuracy), a keep-inside loop,
 * two non-interacting holes, and the out-of-domain degenerate guard.
 */

// --- Fixtures -------------------------------------------------------------------

/** A flat 4×4 bicubic patch in the XY plane, knot domain [0,1]² (so UV trim
 *  coords align 1:1 with the normalized mesh UVs). */
function flatPatch(segs = 8): SurfaceData {
  const points = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      points.push({ co: [-1 + (2 * i) / 3, -1 + (2 * j) / 3, 0] as [number, number, number] });
    }
  }
  return { degreeU: 3, degreeV: 3, pointsU: 4, pointsV: 4, points, tess: { mode: 'spans', segsU: segs, segsV: segs, tol: 0.01 } };
}

function saddle(): SurfaceData {
  const d = defaultSurfaceData();
  const pts = d.points;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = -1 + (2 * i) / 3, y = -1 + (2 * j) / 3;
      pts[i * 4 + j] = { co: [x, y, 0.5 * (x * x - y * y)] };
    }
  }
  return d;
}

/** An exact rational UV circle (classic 9-point degree-2 four-arc) centered at
 *  (cu,cv) with radius r, as a closed CurveData in UV space. */
function uvCircle(cu: number, cv: number, r: number): CurveData {
  const s = Math.SQRT1_2;
  const base: [number, number, number][] = [
    [1, 0, 1], [1, 1, s], [0, 1, 1], [-1, 1, s], [-1, 0, 1],
    [-1, -1, s], [0, -1, 1], [1, -1, s], [1, 0, 1],
  ];
  return {
    kind: 'nurbs', cyclic: false, resolution: 12, order: 3,
    knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
    points: base.map(([x, y, w]) => ({ co: [cu + x * r, cv + y * r, 0] as [number, number, number], w })),
  };
}

/** Total unsigned UV area of the tessellated faces (shoelace per face). */
function meshUvArea(data: SurfaceData): number {
  const { mesh } = tessellateSurface(data);
  let total = 0;
  for (const f of mesh.faces.values()) {
    const uvs = mesh.uvs.get(f.id)!;
    let a = 0;
    for (let k = 0; k < uvs.length; k++) {
      const [x1, y1] = uvs[k], [x2, y2] = uvs[(k + 1) % uvs.length];
      a += x1 * y2 - x2 * y1;
    }
    total += Math.abs(a) / 2;
  }
  return total;
}

function serialize(data: SurfaceData): string {
  const { mesh, us, vs } = tessellateSurface(data);
  const verts = [...mesh.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
  const faces = [...mesh.faces.values()].map((f) => ({ v: f.verts, uv: mesh.uvs.get(f.id) }));
  return JSON.stringify({ us, vs, verts, faces });
}
/** FNV-1a 32-bit hex — a dependency-free stable digest of the serialization. */
function sha(s: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// --- Untrimmed bit-identity ------------------------------------------------------

describe('untrimmed tessellation is byte-identical (v2 must not touch it)', () => {
  // Golden hashes captured from the pre-v2 (v1) tessellate.ts before the trimmed
  // path was rewritten. Any drift here means the untrimmed path changed.
  const golden: [string, SurfaceData, string][] = [
    ['default', defaultSurfaceData(), '24f8556b'],
    ['saddle spans 4×4', (() => { const d = saddle(); d.tess = { mode: 'spans', segsU: 4, segsV: 4, tol: 0.01 }; return d; })(), '8416b7dc'],
    ['saddle adaptive', (() => { const d = saddle(); d.tess = { mode: 'adaptive', segsU: 2, segsV: 2, tol: 0.002 }; return d; })(), 'eb039a6d'],
  ];
  it.each(golden)('%s serializes to the golden hash', (_label, data, hash) => {
    expect(sha(serialize(data))).toBe(hash);
  });
});

// --- Circle hole -----------------------------------------------------------------

describe('circular hole trim', () => {
  const cu = 0.5, cv = 0.5, r = 0.25;
  // Cell size = domain(1)/8 = 0.125; sub-cell = cell/8; sub-cell diagonal:
  const subDiag = Math.hypot(0.125 / 8, 0.125 / 8);

  const holed = (): SurfaceData => {
    const d = flatPatch();
    d.trims = [{ hole: true, curve: uvCircle(cu, cv, r) }];
    return d;
  };

  it('(a) no face center lands inside the hole', () => {
    const { mesh } = tessellateSurface(holed());
    let inside = 0;
    for (const f of mesh.faces.values()) {
      const uvs = mesh.uvs.get(f.id)!;
      const fu = uvs.reduce((a, [u]) => a + u, 0) / uvs.length;
      const fv = uvs.reduce((a, [, v]) => a + v, 0) / uvs.length;
      if (Math.hypot(fu - cu, fv - cv) < r) inside++;
    }
    expect(inside).toBe(0);
  });

  it('(b) hole edge is smooth — every loop point has a mesh vert within 1.5 sub-cell diagonals', () => {
    const { mesh } = tessellateSurface(holed());
    const cornerUVs: [number, number][] = [];
    for (const f of mesh.faces.values()) for (const uv of mesh.uvs.get(f.id)!) cornerUVs.push(uv);
    const loop = sampleUvLoop(uvCircle(cu, cv, r), 128);
    let maxNear = 0;
    for (const [lu, lv] of loop) {
      let near = Infinity;
      for (const [u, v] of cornerUVs) near = Math.min(near, Math.hypot(u - lu, v - lv));
      maxNear = Math.max(maxNear, near);
    }
    // Snapping engaged if boundary verts hug the loop (and it must actually be
    // closer than the unsnapped grid would give — half a cell = ~5.7 sub-diag).
    expect(maxNear).toBeLessThanOrEqual(1.5 * subDiag);
    expect(maxNear).toBeGreaterThan(0);
  });

  it('(c) total kept UV area is within 3% of (domain − circle)', () => {
    const area = meshUvArea(holed());
    const expected = 1 - Math.PI * r * r; // domain area 1 minus the disc
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.03);
  });
});

// --- Keep-inside (outer) loop ----------------------------------------------------

describe('keep-inside loop trim', () => {
  it('kept area is within 3% of the circle area', () => {
    const r = 0.25;
    const d = flatPatch();
    d.trims = [{ hole: false, curve: uvCircle(0.5, 0.5, r) }];
    const area = meshUvArea(d);
    const circle = Math.PI * r * r;
    expect(Math.abs(area - circle) / circle).toBeLessThan(0.03);
  });
});

// --- Two holes don't interact ----------------------------------------------------

describe('two holes are additive', () => {
  it('two disjoint holes remove ~both disc areas (within tolerance)', () => {
    const r = 0.12;
    const d = flatPatch();
    d.trims = [
      { hole: true, curve: uvCircle(0.3, 0.3, r) },
      { hole: true, curve: uvCircle(0.7, 0.7, r) },
    ];
    const area = meshUvArea(d);
    const expected = 1 - 2 * Math.PI * r * r;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.03);

    // Removing each hole alone must remove ~half the deficit — additive, no interaction.
    const one = flatPatch(); one.trims = [{ hole: true, curve: uvCircle(0.3, 0.3, r) }];
    const areaOne = meshUvArea(one);
    const deficitOne = 1 - areaOne;
    const deficitTwo = 1 - area;
    expect(Math.abs(deficitTwo - 2 * deficitOne) / deficitTwo).toBeLessThan(0.05);
  });
});

// --- Degenerate guard ------------------------------------------------------------

describe('out-of-domain hole is a no-op', () => {
  it('a hole entirely outside the UV domain changes nothing', () => {
    const full = tessellateSurface(flatPatch());
    const d = flatPatch();
    d.trims = [{ hole: true, curve: uvCircle(5, 5, 0.2) }];
    const trimmed = tessellateSurface(d);
    expect(trimmed.mesh.faces.size).toBe(full.mesh.faces.size);
    expect(trimmed.mesh.verts.size).toBe(full.mesh.verts.size);
    // Geometrically identical: the same vertex position cloud (the trimmed
    // builder welds verts in cell order, so raw ids differ — compare sorted).
    const posOf = (m: typeof full.mesh) => [...m.verts.values()]
      .map((v) => `${v.co.x.toFixed(9)},${v.co.y.toFixed(9)},${v.co.z.toFixed(9)}`).sort();
    expect(posOf(trimmed.mesh)).toEqual(posOf(full.mesh));
  });
});

// --- Determinism -----------------------------------------------------------------

describe('trimmed tessellation is deterministic', () => {
  it('same trimmed payload → identical mesh across runs', () => {
    const mk = () => { const d = flatPatch(); d.trims = [{ hole: true, curve: uvCircle(0.5, 0.5, 0.25) }]; return d; };
    expect(sha(serialize(mk()))).toBe(sha(serialize(mk())));
  });
});
