import { describe, it, expect } from 'vitest';
import {
  moellerTrumbore,
  buildBVH,
  intersectBVH,
  intersectBruteForce,
  directLighting,
  mulberry32,
} from './tracer';
import type { SnapLight } from './snapshot';

describe('Möller–Trumbore', () => {
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [1, 0, 0];
  const c: [number, number, number] = [0, 1, 0];

  it('hits a triangle straight on', () => {
    const hit = moellerTrumbore([0.25, 0.25, 1], [0, 0, -1], a, b, c);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1, 6);
    expect(hit!.u).toBeCloseTo(0.25, 6);
    expect(hit!.v).toBeCloseTo(0.25, 6);
  });

  it('misses when the ray passes outside the triangle', () => {
    expect(moellerTrumbore([2, 2, 1], [0, 0, -1], a, b, c)).toBeNull();
  });

  it('misses parallel rays', () => {
    expect(moellerTrumbore([0.25, 0.25, 1], [1, 0, 0], a, b, c)).toBeNull();
  });

  it('honors backface culling', () => {
    // Ray coming from behind (-Z side going +Z) hits the back face.
    const origin: [number, number, number] = [0.25, 0.25, -1];
    const dir: [number, number, number] = [0, 0, 1];
    expect(moellerTrumbore(origin, dir, a, b, c, false)).not.toBeNull();
    expect(moellerTrumbore(origin, dir, a, b, c, true)).toBeNull();
  });
});

describe('BVH vs brute force', () => {
  it('returns identical nearest hits on a 100-tri random soup', () => {
    const rng = mulberry32(12345);
    const N = 100;
    const tris = new Float32Array(N * 9);
    for (let i = 0; i < N * 9; i++) tris[i] = (rng() * 2 - 1) * 5;
    const bvh = buildBVH(tris);

    let compared = 0;
    let hits = 0;
    for (let r = 0; r < 500; r++) {
      const ox = (rng() * 2 - 1) * 8, oy = (rng() * 2 - 1) * 8, oz = (rng() * 2 - 1) * 8;
      let dx = rng() * 2 - 1, dy = rng() * 2 - 1, dz = rng() * 2 - 1;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv; dy *= inv; dz *= inv;
      const a = intersectBVH(bvh, tris, ox, oy, oz, dx, dy, dz);
      const b = intersectBruteForce(tris, ox, oy, oz, dx, dy, dz);
      compared++;
      if (a === null || b === null) {
        expect(a === null).toBe(b === null);
      } else {
        expect(a.tri).toBe(b.tri);
        expect(a.t).toBeCloseTo(b.t, 5);
        hits++;
      }
    }
    expect(compared).toBe(500);
    expect(hits).toBeGreaterThan(0); // sanity: the soup actually gets hit
  });
});

describe('direct lighting', () => {
  const white: [number, number, number] = [1, 1, 1];
  const point = (power: number): SnapLight => ({
    type: 0,
    position: [0, 2, 0],
    direction: [0, -1, 0],
    energy: [power / (4 * Math.PI), power / (4 * Math.PI), power / (4 * Math.PI)],
    cosInner: 1,
    cosOuter: 1,
  });

  it('point light lights the point beneath it ∝ power/4π/d²·NdotL', () => {
    const out = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [point(100)]);
    // albedo/π * (power/4π)/d² * NdotL, d=2, NdotL=1.
    const expected = (1 / Math.PI) * (100 / (4 * Math.PI)) / 4;
    expect(out[0]).toBeCloseTo(expected, 6);
    expect(out[1]).toBeCloseTo(expected, 6);
    expect(out[2]).toBeCloseTo(expected, 6);
  });

  it('doubling power doubles irradiance', () => {
    const a = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [point(100)]);
    const b = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [point(200)]);
    expect(b[0]).toBeCloseTo(a[0] * 2, 6);
  });

  it('obeys inverse-square falloff', () => {
    // Same geometry but move the light to d=4 (twice as far) → quarter intensity.
    const near = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [point(100)]);
    const far = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [
      { ...point(100), position: [0, 4, 0] },
    ]);
    expect(far[0]).toBeCloseTo(near[0] / 4, 6);
  });

  it('a NdotL of zero (grazing) gives no light', () => {
    const out = directLighting(null, new Float32Array(0), 0, 0, 0, 1, 0, 0, white, [point(100)]);
    expect(out[0]).toBe(0);
  });

  it('a shadow ray blocked by an occluder → black', () => {
    // Occluder triangle at y=1, between the floor point (0,0,0) and light (0,2,0).
    const occ = new Float32Array([
      -1, 1, -1, 1, 1, -1, 0, 1, 2,
    ]);
    const bvh = buildBVH(occ);
    const lit = directLighting(bvh, occ, 0, 0, 0, 0, 1, 0, white, [point(100)]);
    expect(lit[0]).toBe(0);
    // With the occluder removed (no BVH) the same point IS lit.
    const unshadowed = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, white, [point(100)]);
    expect(unshadowed[0]).toBeGreaterThan(0);
  });

  it('sun direction is honored (no falloff, NdotL from direction)', () => {
    const sun: SnapLight = {
      type: 1,
      position: [0, 0, 0],
      direction: [0, -1, 0], // light travels downward → L points up
      energy: [3, 3, 3],
      cosInner: 1,
      cosOuter: 1,
    };
    // Surface facing up: fully lit, radiance = energy (no 1/d²).
    const up = directLighting(null, new Float32Array(0), 5, 5, 5, 0, 1, 0, white, [sun]);
    expect(up[0]).toBeCloseTo((1 / Math.PI) * 3 * 1, 6);
    // Surface facing sideways: NdotL = 0.
    const side = directLighting(null, new Float32Array(0), 5, 5, 5, 1, 0, 0, white, [sun]);
    expect(side[0]).toBe(0);
    // Surface facing down (away from the sun): NdotL < 0 → dark.
    const away = directLighting(null, new Float32Array(0), 5, 5, 5, 0, -1, 0, white, [sun]);
    expect(away[0]).toBe(0);
  });
});
