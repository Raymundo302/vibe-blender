import { describe, it, expect } from 'vitest';
import {
  tangentFrame,
  applyNormalMap,
  applyBumpMap,
  prepareScene,
  renderSample,
} from './tracer';
import type { SnapLight, SnapMaterial, SnapCamera, Snapshot } from './snapshot';

// ---------------------------------------------------------------------------
// Tangent frame — a known quad with known UVs → expected T/B.
// ---------------------------------------------------------------------------

describe('tangentFrame (P13-1)', () => {
  it('recovers axis-aligned T/B for a canonical XY quad', () => {
    // Triangle in the XY plane, N = +Z. UVs map U→+X, V→+Y.
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    const uv0: [number, number] = [0, 0];
    const uv1: [number, number] = [1, 0];
    const uv2: [number, number] = [0, 1];
    const N: [number, number, number] = [0, 0, 1];
    const T: [number, number, number] = [0, 0, 0];
    const B: [number, number, number] = [0, 0, 0];
    const ok = tangentFrame(p0, p1, p2, uv0, uv1, uv2, N, T, B);
    expect(ok).toBe(true);
    // U increases along +X → T = +X; B = N×T = Z×X = +Y.
    expect(T[0]).toBeCloseTo(1, 6);
    expect(T[1]).toBeCloseTo(0, 6);
    expect(T[2]).toBeCloseTo(0, 6);
    expect(B[0]).toBeCloseTo(0, 6);
    expect(B[1]).toBeCloseTo(1, 6);
    expect(B[2]).toBeCloseTo(0, 6);
  });

  it('flips T when U runs along -X', () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    // U DEcreases along +X (uv1.u < uv0.u).
    const uv0: [number, number] = [1, 0];
    const uv1: [number, number] = [0, 0];
    const uv2: [number, number] = [1, 1];
    const N: [number, number, number] = [0, 0, 1];
    const T: [number, number, number] = [0, 0, 0];
    const B: [number, number, number] = [0, 0, 0];
    tangentFrame(p0, p1, p2, uv0, uv1, uv2, N, T, B);
    expect(T[0]).toBeCloseTo(-1, 6);
  });

  it('returns a UNIT tangent orthogonal to N even for a skewed UV', () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [2, 0, 0];
    const p2: [number, number, number] = [0, 3, 0];
    const uv0: [number, number] = [0, 0];
    const uv1: [number, number] = [0.7, 0.2];
    const uv2: [number, number] = [0.1, 0.9];
    const N: [number, number, number] = [0, 0, 1];
    const T: [number, number, number] = [0, 0, 0];
    const B: [number, number, number] = [0, 0, 0];
    expect(tangentFrame(p0, p1, p2, uv0, uv1, uv2, N, T, B)).toBe(true);
    expect(Math.hypot(T[0], T[1], T[2])).toBeCloseTo(1, 6);
    expect(T[0] * N[0] + T[1] * N[1] + T[2] * N[2]).toBeCloseTo(0, 6);
    // B = N × T is a unit vector perpendicular to both.
    expect(Math.hypot(B[0], B[1], B[2])).toBeCloseTo(1, 6);
    expect(B[0] * N[0] + B[1] * N[1] + B[2] * N[2]).toBeCloseTo(0, 6);
  });

  it('reports degenerate UVs (zero det) → false, no perturbation', () => {
    const p0: [number, number, number] = [0, 0, 0];
    const p1: [number, number, number] = [1, 0, 0];
    const p2: [number, number, number] = [0, 1, 0];
    // All UVs equal → det = 0.
    const uv: [number, number] = [0.5, 0.5];
    const N: [number, number, number] = [0, 0, 1];
    const T: [number, number, number] = [0, 0, 0];
    const B: [number, number, number] = [0, 0, 0];
    expect(tangentFrame(p0, p1, p2, uv, uv, uv, N, T, B)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normal / bump perturbation math.
// ---------------------------------------------------------------------------

describe('applyNormalMap (P13-1)', () => {
  const T: [number, number, number] = [1, 0, 0];
  const B: [number, number, number] = [0, 1, 0];
  const N: [number, number, number] = [0, 0, 1];

  it('a flat +Z normal (0.5,0.5,1) leaves N unchanged', () => {
    const out: [number, number, number] = [0, 0, 0];
    applyNormalMap([0.5, 0.5, 1], 1, T, B, N, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('tilts toward +T for a +X-leaning sample', () => {
    const out: [number, number, number] = [0, 0, 0];
    applyNormalMap([1, 0.5, 1], 1, T, B, N, out);
    // sample.x = 1 → +1 along T; result should have a positive X component.
    expect(out[0]).toBeGreaterThan(0.5);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
  });

  it('strength scales the xy tilt (stronger → more tilt)', () => {
    const weak: [number, number, number] = [0, 0, 0];
    const strong: [number, number, number] = [0, 0, 0];
    applyNormalMap([1, 0.5, 1], 0.5, T, B, N, weak);
    applyNormalMap([1, 0.5, 1], 2, T, B, N, strong);
    expect(strong[0]).toBeGreaterThan(weak[0]);
  });
});

describe('applyBumpMap (P13-1)', () => {
  const T: [number, number, number] = [1, 0, 0];
  const B: [number, number, number] = [0, 1, 0];
  const N: [number, number, number] = [0, 0, 1];

  it('zero gradient leaves N unchanged', () => {
    const out: [number, number, number] = [0, 0, 0];
    applyBumpMap(0, 0, 1, T, B, N, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('a +X height gradient tilts the normal toward -T', () => {
    const out: [number, number, number] = [0, 0, 0];
    // grad.x > 0 → N - T*grad → negative X component.
    applyBumpMap(0.1, 0, 1, T, B, N, out);
    expect(out[0]).toBeLessThan(0);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
  });

  it('strength amplifies the tilt (× strength × 4)', () => {
    const weak: [number, number, number] = [0, 0, 0];
    const strong: [number, number, number] = [0, 0, 0];
    applyBumpMap(0.05, 0, 0.5, T, B, N, weak);
    applyBumpMap(0.05, 0, 2, T, B, N, strong);
    expect(Math.abs(strong[0])).toBeGreaterThan(Math.abs(weak[0]));
  });
});

// ---------------------------------------------------------------------------
// Tiny tracer renders (seeded, low spp) — feature-level checks.
// ---------------------------------------------------------------------------

function snapMat(over: Partial<SnapMaterial> = {}): SnapMaterial {
  return {
    baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5,
    emissive: [0, 0, 0], emissiveStrength: 0,
    subsurfaceWeight: 0, subsurfaceRadius: 0.05, ...over,
  };
}

/** Floor quad in the XZ plane at y=0 spanning [-h,h]^2, normal +Y, with UVs
 * mapped so the full 0..1 square covers the quad. */
function floorTris(h: number): number[] {
  return [
    -h, h, 0, h, -h, 0, h, h, 0,
    -h, h, 0, -h, -h, 0, h, -h, 0,
  ];
}
function floorUV(): number[] {
  // Per-corner UVs matching floorTris corner order (u from X, v from -Y).
  return [
    0, 0, 1, 1, 1, 0,
    0, 0, 0, 1, 1, 1,
  ];
}

function makeSnapshot(
  tris: number[], triUV: number[] | null, triMat: number[], materials: SnapMaterial[],
  lights: SnapLight[], camera: SnapCamera,
): Snapshot {
  return {
    tris: new Float32Array(tris),
    triUV: triUV ? new Float32Array(triUV) : undefined,
    triMat: Int32Array.from(triMat),
    materials, lights, camera,
  };
}

/** width*height*3 image, all pixels = a flat +Z tangent-space normal: stored
 * RAW (0.5, 0.5, 1) which decodes (×2-1) to (0, 0, 1) → no perturbation. */
function flatNormalImage(w: number, h: number) {
  const pixels = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 3] = 0.5; pixels[i * 3 + 1] = 0.5; pixels[i * 3 + 2] = 1;
  }
  return { width: w, height: h, pixels };
}

/** An asymmetric normal map: left half leans -X, right half leans +X. */
function asymNormalImage(w: number, h: number) {
  const pixels = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const nx = x < w / 2 ? 0.0 : 1.0; // decoded → -1 or +1 along T
      pixels[i] = nx; pixels[i + 1] = 0.5; pixels[i + 2] = 1;
    }
  }
  return { width: w, height: h, pixels };
}

/** Constant single-value grayscale data map (for rough/metal maps). */
function constImage(w: number, h: number, v: number) {
  const pixels = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 3] = v; pixels[i * 3 + 1] = v; pixels[i * 3 + 2] = v;
  }
  return { width: w, height: h, pixels };
}

const SEED = 0x1234567;
const overhead: SnapLight = {
  type: 0, position: [0, 0, 6], direction: [0, 0, -1],
  energy: [400, 400, 400], cosInner: 1, cosOuter: 1, radius: 0,
};
const camDown: SnapCamera = {
  position: [0, -0.001, 6], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
  fovY: Math.PI / 3,
};

function renderImg(mat: SnapMaterial, lights: SnapLight[], w: number, h: number, passes: number, withUV = true): Float32Array {
  const scene = prepareScene(makeSnapshot(
    floorTris(3), withUV ? floorUV() : null, [0, 0], [mat], lights, camDown,
  ));
  const acc = new Float32Array(w * h * 3);
  for (let s = 0; s < passes; s++) renderSample(scene, acc, w, h, s, SEED);
  return acc;
}

function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

describe('tracer normal maps (P13-1)', () => {
  const w = 20, h = 20, passes = 12;

  it('a flat +Z normal map produces the SAME image as no map', () => {
    const noMap = renderImg(snapMat({ baseColor: [0.8, 0.6, 0.5] }), [overhead], w, h, passes);
    const flat = renderImg(
      snapMat({ baseColor: [0.8, 0.6, 0.5], normalImage: flatNormalImage(8, 8), normalStrength: 1 }),
      [overhead], w, h, passes,
    );
    expect(Array.from(flat)).toEqual(Array.from(noMap));
  });

  it('an asymmetric normal map CHANGES the image', () => {
    // A grazing sun so tilted normals visibly change NdotL across the surface.
    const grazeSun: SnapLight = {
      type: 1, position: [0, 0, 0], direction: [-0.9, 0, -0.4],
      energy: [3, 3, 3], cosInner: 1, cosOuter: 1, radius: 0,
    };
    const noMap = renderImg(snapMat({ baseColor: [0.8, 0.8, 0.8] }), [grazeSun], w, h, passes);
    const mapped = renderImg(
      snapMat({ baseColor: [0.8, 0.8, 0.8], normalImage: asymNormalImage(16, 16), normalStrength: 1.5 }),
      [grazeSun], w, h, passes,
    );
    expect(meanAbsDiff(noMap, mapped)).toBeGreaterThan(1e-3);
  });

  it('a bump (height) map also changes the image', () => {
    const grazeSun: SnapLight = {
      type: 1, position: [0, 0, 0], direction: [-0.9, 0, -0.4],
      energy: [3, 3, 3], cosInner: 1, cosOuter: 1, radius: 0,
    };
    // Height ramp across U → non-zero central-difference gradient.
    const w2 = 16, h2 = 16;
    const pixels = new Float32Array(w2 * h2 * 3);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = (y * w2 + x) * 3; const v = x / (w2 - 1);
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v;
    }
    const noMap = renderImg(snapMat({ baseColor: [0.8, 0.8, 0.8] }), [grazeSun], w, h, passes);
    const bumped = renderImg(
      snapMat({ baseColor: [0.8, 0.8, 0.8], normalImage: { width: w2, height: h2, pixels }, normalIsBump: true, normalStrength: 2 }),
      [grazeSun], w, h, passes,
    );
    expect(meanAbsDiff(noMap, bumped)).toBeGreaterThan(1e-4);
  });
});

describe('tracer rough / metal maps (P13-1)', () => {
  const w = 24, h = 24, passes = 60;

  const peak = (a: Float32Array): number => {
    let m = 0;
    for (let i = 0; i < a.length; i += 3) {
      const L = (a[i] + a[i + 1] + a[i + 2]) / 3 / passes;
      if (L > m) m = L;
    }
    return m;
  };

  it('a rough map value=1 is byte-identical to no map (multiplier is 1)', () => {
    const glossy = snapMat({ baseColor: [0.9, 0.9, 0.9], metallic: 1, roughness: 0.05 });
    const noMap = renderImg(glossy, [overhead], w, h, passes);
    const mapped = renderImg({ ...glossy, roughImage: constImage(4, 4, 1) }, [overhead], w, h, passes);
    expect(Array.from(mapped)).toEqual(Array.from(noMap));
  });

  it('a rough map that raises roughness blurs/dulls the specular peak', () => {
    // Very-smooth metal → tight bright highlight (high peak). Rough base with a
    // full-value rough map keeps roughness=1 → the lobe spreads (lower peak).
    const smooth = renderImg(snapMat({ baseColor: [0.9, 0.9, 0.9], metallic: 1, roughness: 0.04 }), [overhead], w, h, passes);
    const blurred = renderImg(
      snapMat({ baseColor: [0.9, 0.9, 0.9], metallic: 1, roughness: 1, roughImage: constImage(4, 4, 1) }),
      [overhead], w, h, passes,
    );
    expect(peak(blurred)).toBeLessThan(peak(smooth));
  });

  it('a metal map=0 kills metallic reflection (diffuse instead)', () => {
    // metallic base 1, but metal map red=0 → metal *= 0 → fully diffuse.
    const metalNoMap = renderImg(snapMat({ baseColor: [0.2, 0.5, 0.9], metallic: 1, roughness: 0.3 }), [overhead], w, h, passes);
    const metalZeroed = renderImg(
      snapMat({ baseColor: [0.2, 0.5, 0.9], metallic: 1, roughness: 0.3, metalImage: constImage(4, 4, 0) }),
      [overhead], w, h, passes,
    );
    expect(meanAbsDiff(metalNoMap, metalZeroed)).toBeGreaterThan(1e-3);
  });

  it('a rough/metal map with NO UVs leaves the render byte-identical to no map', () => {
    const base = snapMat({ baseColor: [0.7, 0.7, 0.7], metallic: 0.5, roughness: 0.5 });
    const noMap = renderImg(base, [overhead], w, h, passes, false);
    const withMaps = renderImg(
      { ...base, roughImage: constImage(4, 4, 0.5), metalImage: constImage(4, 4, 0.5), normalImage: asymNormalImage(8, 8) },
      [overhead], w, h, passes, false,
    );
    expect(Array.from(withMaps)).toEqual(Array.from(noMap));
  });
});
