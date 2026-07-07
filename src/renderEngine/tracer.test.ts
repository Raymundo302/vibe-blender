import { describe, it, expect } from 'vitest';
import {
  moellerTrumbore,
  buildBVH,
  intersectBVH,
  intersectBruteForce,
  directLighting,
  mulberry32,
  prepareScene,
  renderSample,
} from './tracer';
import type { SnapLight, SnapMaterial, SnapCamera, Snapshot } from './snapshot';

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

// ---------------------------------------------------------------------------
// P9-4: soft shadows, subsurface, depth of field.
// ---------------------------------------------------------------------------

const WHITE: [number, number, number] = [1, 1, 1];

/** A point light with a soft-shadow sphere radius. */
function softPoint(radius: number): SnapLight {
  return {
    type: 0, position: [0, 3, 0], direction: [0, -1, 0],
    energy: [10, 10, 10], cosInner: 1, cosOuter: 1, radius,
  };
}

describe('soft shadows (P9-4)', () => {
  // Small occluder quad at y=1.5 spanning [-0.3,0.3]^2 — blocks the straight-up
  // center ray from the origin but not rays toward the edge of a radius-1 light.
  const occ = new Float32Array([
    -0.3, 1.5, -0.3, 0.3, 1.5, -0.3, 0.3, 1.5, 0.3,
    -0.3, 1.5, -0.3, 0.3, 1.5, 0.3, -0.3, 1.5, 0.3,
  ]);
  const bvh = buildBVH(occ);

  it('radius 0 keeps the hard shadow — center is fully dark', () => {
    const out = directLighting(bvh, occ, 0, 0, 0, 0, 1, 0, WHITE, [softPoint(0)], [0, 0, 0], mulberry32(1));
    expect(out[0]).toBe(0);
  });

  it('radius 0 draws no RNG → identical with or without an rng argument', () => {
    const withRng = directLighting(bvh, occ, 0, 0, 0, 0, 1, 0, WHITE, [softPoint(0)], [0, 0, 0], mulberry32(7));
    const without = directLighting(bvh, occ, 0, 0, 0, 0, 1, 0, WHITE, [softPoint(0)]);
    expect(withRng[0]).toBe(without[0]);
  });

  it('radius > 0 yields a penumbra: the once-black point gets intermediate light', () => {
    const rng = mulberry32(99);
    const N = 500;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const o: [number, number, number] = [0, 0, 0];
      directLighting(bvh, occ, 0, 0, 0, 0, 1, 0, WHITE, [softPoint(1)], o, rng);
      sum += o[0];
    }
    const mean = sum / N;
    // Unoccluded reference (no BVH) for the same point/normal/light center.
    const full = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, WHITE, [softPoint(0)])[0];
    expect(mean).toBeGreaterThan(0);   // no longer fully dark → penumbra
    expect(mean).toBeLessThan(full);   // still partially shadowed
  });
});

describe('subsurface wrapped diffuse (P9-4)', () => {
  // Sun almost at the horizon relative to an up-facing surface → tiny NdotL.
  const grazeSun: SnapLight = {
    type: 1, position: [0, 0, 0], direction: [-0.98, -0.2, 0],
    energy: [1, 1, 1], cosInner: 1, cosOuter: 1,
  };

  it('wrap (SSS) raises grazing illumination vs plain NdotL', () => {
    const plain = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, WHITE, [grazeSun], [0, 0, 0], undefined, 0)[0];
    const wrapped = directLighting(null, new Float32Array(0), 0, 0, 0, 0, 1, 0, WHITE, [grazeSun], [0, 0, 0], undefined, 1)[0];
    expect(plain).toBeGreaterThan(0);
    expect(wrapped).toBeGreaterThan(plain * 1.5);
  });
});

// --- renderSample scene helpers ---------------------------------------------

function snapMat(over: Partial<SnapMaterial> = {}): SnapMaterial {
  return {
    baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5,
    emissive: [0, 0, 0], emissiveStrength: 0,
    subsurfaceWeight: 0, subsurfaceRadius: 0.05, ...over,
  };
}

function makeSnapshot(
  tris: number[], triMat: number[], materials: SnapMaterial[],
  lights: SnapLight[], camera: SnapCamera,
): Snapshot {
  return {
    tris: new Float32Array(tris),
    triMat: Int32Array.from(triMat),
    materials, lights, camera,
  };
}

/** Floor quad in the XZ plane at y=0 spanning [-h,h]^2, two triangles, wound so
 * the geometric normal points UP (+Y) — the side the camera/light are on. */
function floorTris(h: number): number[] {
  return [
    -h, 0, -h, h, 0, h, h, 0, -h,
    -h, 0, -h, -h, 0, h, h, 0, h,
  ];
}

const SEED = 0x1234567;

describe('subsurface energy + grazing (P9-4)', () => {
  // Floor lit by a HIGH overhead point light (near-vertical everywhere) so a
  // weight-1 SSS material redistributes but does not gain energy.
  const light: SnapLight = {
    type: 0, position: [0, 20, 0], direction: [0, -1, 0],
    energy: [800, 800, 800], cosInner: 1, cosOuter: 1, radius: 0,
  };
  const camDown: SnapCamera = {
    position: [0, 6, 0.001], forward: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1],
    fovY: Math.PI / 3,
  };
  const w = 24, h = 24, passes = 40;

  function avgLum(weight: number): number {
    const scene = prepareScene(makeSnapshot(
      floorTris(3), new Array(2).fill(0),
      [snapMat({ baseColor: [0.85, 0.6, 0.5], subsurfaceWeight: weight, subsurfaceRadius: 0.4 })],
      [light], camDown,
    ));
    const acc = new Float32Array(w * h * 3);
    for (let s = 0; s < passes; s++) renderSample(scene, acc, w, h, s, SEED);
    let sum = 0;
    for (let i = 0; i < acc.length; i += 3) sum += (acc[i] + acc[i + 1] + acc[i + 2]) / 3;
    return sum / (w * h) / passes;
  }

  it('SSS on does not increase average luminance by more than ~5%', () => {
    const off = avgLum(0);
    const on = avgLum(1);
    expect(on).toBeLessThanOrEqual(off * 1.05);
  });

  it('SSS brightens grazing-lit pixels (weight 1 vs 0)', () => {
    // A near-horizontal SUN over the floor: NdotL is small everywhere (angular,
    // no falloff), so the wrapped-diffuse SSS lift is clearly visible.
    const grazeSun: SnapLight = {
      type: 1, position: [0, 0, 0], direction: [0, -0.25, -1],
      energy: [1, 1, 1], cosInner: 1, cosOuter: 1, radius: 0,
    };
    const cam: SnapCamera = {
      position: [0, 3, 4], forward: [0, -0.6, -0.8], right: [1, 0, 0], up: [0, 0.8, -0.6],
      fovY: Math.PI / 3,
    };
    const P = 60, iw = 24, ih = 24;
    function meanLum(weight: number): number {
      const scene = prepareScene(makeSnapshot(
        floorTris(3), new Array(2).fill(0),
        [snapMat({ baseColor: [0.9, 0.7, 0.6], subsurfaceWeight: weight, subsurfaceRadius: 0.3 })],
        [grazeSun], cam,
      ));
      const acc = new Float32Array(iw * ih * 3);
      for (let s = 0; s < P; s++) renderSample(scene, acc, iw, ih, s, SEED);
      let sum = 0, n = 0;
      for (let i = 0; i < acc.length; i += 3) {
        const L = (acc[i] + acc[i + 1] + acc[i + 2]) / 3 / P;
        if (L > 1e-4) { sum += L; n++; } // floor pixels only (skip pure sky)
      }
      return n > 0 ? sum / n : 0;
    }
    const off = meanLum(0);
    const on = meanLum(1);
    expect(on).toBeGreaterThan(off * 1.05);
  });
});

describe('depth of field (P9-4)', () => {
  // A bright emissive vertical bar at z=0; camera at z=5 looking -Z. The bar is
  // well in front of a far focus plane, so an open aperture blurs its edges.
  const bar = [
    -0.4, -3, 0, 0.4, -3, 0, 0.4, 3, 0,
    -0.4, -3, 0, 0.4, 3, 0, -0.4, 3, 0,
  ];
  const barMat = snapMat({ emissive: [1, 1, 1], emissiveStrength: 6 });
  const baseCam: SnapCamera = {
    position: [0, 0, 5], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
    fovY: Math.PI / 3,
  };
  const w = 48, h = 24;

  function scene(cam: SnapCamera): ReturnType<typeof prepareScene> {
    return prepareScene(makeSnapshot(bar, [0, 0], [barMat], [], cam));
  }

  it('aperture 0 is byte-identical to the pinhole path', () => {
    const pinhole = scene({ ...baseCam }); // no aperture field
    const explicit = scene({ ...baseCam, aperture: 0, focusDistance: 20 });
    const a = new Float32Array(w * h * 3);
    const b = new Float32Array(w * h * 3);
    renderSample(pinhole, a, w, h, 0, SEED);
    renderSample(explicit, b, w, h, 0, SEED);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('an open aperture blurs the off-focus bar silhouette', () => {
    const P = 80, row = (h / 2) | 0;
    function edgeSpread(cam: SnapCamera): number {
      const s = scene(cam);
      const acc = new Float32Array(w * h * 3);
      for (let p = 0; p < P; p++) renderSample(s, acc, w, h, p, SEED);
      // Per-pixel luminance along the center row; count "intermediate" pixels
      // (between 20% and 80% of the row max) — a soft edge has more of them.
      let max = 0;
      const lum: number[] = [];
      for (let x = 0; x < w; x++) {
        const i = (row * w + x) * 3;
        const L = (acc[i] + acc[i + 1] + acc[i + 2]) / 3 / P;
        lum.push(L);
        if (L > max) max = L;
      }
      let mid = 0;
      for (const L of lum) if (L > 0.2 * max && L < 0.8 * max) mid++;
      return mid;
    }
    const sharp = edgeSpread({ ...baseCam, aperture: 0, focusDistance: 20 });
    const blurred = edgeSpread({ ...baseCam, aperture: 0.7, focusDistance: 20 });
    expect(blurred).toBeGreaterThan(sharp);
  });
});
