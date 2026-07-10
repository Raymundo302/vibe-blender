import { describe, it, expect } from 'vitest';
import { triTriIntersection, meshIntersectionSegments } from './intersect';
import { makeCube, makePlane } from './primitives';
import { meshToRenderData } from './meshToGpu';

/** World-space triangle soup (9 floats/tri) for a mesh, verts offset by (dx,dy,dz)
 *  and uniformly scaled by s about the origin. */
function soup(
  mesh: ReturnType<typeof makeCube>,
  s = 1, dx = 0, dy = 0, dz = 0,
): Float32Array {
  const src = meshToRenderData(mesh).trianglePositions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i] * s + dx;
    out[i + 1] = src[i + 1] * s + dy;
    out[i + 2] = src[i + 2] * s + dz;
  }
  return out;
}

function segLen(seg: Float32Array, i: number): number {
  return Math.hypot(
    seg[i + 3] - seg[i], seg[i + 4] - seg[i + 1], seg[i + 5] - seg[i + 2],
  );
}

describe('triTriIntersection', () => {
  it('two crossing triangles produce a segment on both planes', () => {
    // Triangle A in the XY plane (z=0).
    const a = [0, 0, 0, 4, 0, 0, 0, 4, 0];
    // Triangle B upright in the XZ plane (y=0), straddling A across z.
    const b = [1, 0, -1, 3, 0, -1, 2, 0, 2];
    const out: number[] = [];
    expect(triTriIntersection(a, 0, b, 0, out)).toBe(true);
    // Both endpoints lie on plane A (z=0) and plane B (y=0).
    expect(Math.abs(out[2])).toBeLessThan(1e-6); // p0.z
    expect(Math.abs(out[5])).toBeLessThan(1e-6); // p1.z
    expect(Math.abs(out[1])).toBeLessThan(1e-6); // p0.y
    expect(Math.abs(out[4])).toBeLessThan(1e-6); // p1.y
    // Non-degenerate segment.
    expect(Math.hypot(out[3] - out[0], out[4] - out[1], out[5] - out[2]))
      .toBeGreaterThan(1e-3);
  });

  it('returns false for non-crossing triangles (disjoint in z)', () => {
    const a = [0, 0, 0, 4, 0, 0, 0, 4, 0];   // z = 0
    const b = [0, 0, 5, 4, 0, 5, 0, 4, 5];   // z = 5, parallel above
    const out: number[] = [];
    expect(triTriIntersection(a, 0, b, 0, out)).toBe(false);
  });

  it('returns false for coplanar triangles', () => {
    const a = [0, 0, 0, 4, 0, 0, 0, 4, 0];
    const b = [1, 1, 0, 5, 1, 0, 1, 5, 0]; // same z=0 plane, overlapping
    const out: number[] = [];
    expect(triTriIntersection(a, 0, b, 0, out)).toBe(false);
  });

  it('respects the aOff / bOff offsets', () => {
    const a = [999, 999, 999, 0, 0, 0, 4, 0, 0, 0, 4, 0]; // real tri at offset 3
    const b = [7, 7, 7, 1, 0, -1, 3, 0, -1, 2, 0, 2];     // real tri at offset 3
    const out: number[] = [];
    expect(triTriIntersection(a, 3, b, 3, out)).toBe(true);
  });
});

describe('meshIntersectionSegments — plane through a cube', () => {
  // A large horizontal plane (XY, normal +Z) at z = 0.3 slicing the default
  // cube (spans [-1,1] on every axis). The cross-section is the 2×2 square at
  // z = 0.3, so the intersection curve is that square's perimeter (8 units).
  const cube = soup(makeCube(1));
  const plane = soup(makePlane(1), 6, 0, 0, 0.3); // 6-unit plane at z = 0.3

  it('produces a closed square cross-section of perimeter ≈ 8', () => {
    const segs = meshIntersectionSegments(plane, cube);
    expect(segs.length).toBeGreaterThan(0);
    let total = 0;
    for (let i = 0; i < segs.length; i += 6) total += segLen(segs, i);
    expect(total).toBeCloseTo(8, 3);
  });

  it('all endpoints lie on the plane (z = 0.3) and on the cube surface', () => {
    const segs = meshIntersectionSegments(plane, cube);
    expect(segs.length).toBeGreaterThan(0);
    for (let i = 0; i < segs.length; i += 3) {
      const x = segs[i], y = segs[i + 1], z = segs[i + 2];
      // On the cutting plane.
      expect(Math.abs(z - 0.3)).toBeLessThan(1e-5);
      // On the cube surface: at least one of |x|,|y| is at the cube face (1).
      const onFace = Math.abs(Math.abs(x) - 1) < 1e-5 || Math.abs(Math.abs(y) - 1) < 1e-5;
      expect(onFace).toBe(true);
      // And inside the cube's other extent.
      expect(Math.abs(x)).toBeLessThan(1 + 1e-5);
      expect(Math.abs(y)).toBeLessThan(1 + 1e-5);
    }
  });

  it('argument order is symmetric (cube,plane vs plane,cube) in total length', () => {
    const ab = meshIntersectionSegments(plane, cube);
    const ba = meshIntersectionSegments(cube, plane);
    const total = (s: Float32Array) => {
      let t = 0; for (let i = 0; i < s.length; i += 6) t += segLen(s, i); return t;
    };
    expect(total(ab)).toBeCloseTo(total(ba), 3);
  });
});

describe('meshIntersectionSegments — non-intersecting cases', () => {
  it('disjoint meshes → empty result', () => {
    const cubeA = soup(makeCube(1));
    const cubeB = soup(makeCube(1), 1, 10, 0, 0); // far away in +x
    expect(meshIntersectionSegments(cubeA, cubeB).length).toBe(0);
  });

  it('a plane lying flush within a cube face (touching, not crossing) → empty', () => {
    // A small plane (spans ±0.5) resting flush ON the cube's top face (z = 1),
    // fully inside it: its only contact is coplanar with the top face (skipped),
    // and it never reaches the cube's side planes — so no crossing curve.
    const cube = soup(makeCube(1));
    const plane = soup(makePlane(1), 1, 0, 0, 1); // z = 1, x,y ∈ [-0.5, 0.5]
    const segs = meshIntersectionSegments(plane, cube);
    // No near-zero-length junk, and in fact nothing at all.
    for (let i = 0; i < segs.length; i += 6) expect(segLen(segs, i)).toBeLessThan(1e-3);
    expect(segs.length).toBe(0);
  });

  it('empty soup → empty result', () => {
    expect(meshIntersectionSegments(new Float32Array(0), soup(makeCube(1))).length).toBe(0);
  });
});

describe('meshIntersectionSegments — two crossing cubes', () => {
  it('two overlapping cubes produce a closed intersection loop', () => {
    const cubeA = soup(makeCube(1));
    const cubeB = soup(makeCube(1), 1, 1, 1, 0); // overlaps the +x+y corner region
    const segs = meshIntersectionSegments(cubeA, cubeB);
    expect(segs.length).toBeGreaterThan(0);
    // Every segment endpoint sits on one of the two cubes' surfaces.
    for (let i = 0; i < segs.length; i += 3) {
      const p = [segs[i], segs[i + 1], segs[i + 2]];
      const onA = p.some((c) => Math.abs(Math.abs(c) - 1) < 1e-4);
      const onB = [p[0] - 1, p[1] - 1, p[2]].some((c) => Math.abs(Math.abs(c) - 1) < 1e-4);
      expect(onA || onB).toBe(true);
    }
  });
});
