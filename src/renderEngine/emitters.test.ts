import { describe, it, expect } from 'vitest';
import { buildEmitters, sampleEmitters, mulberry32 } from './tracer';
import type { SnapMaterial } from './snapshot';

/**
 * Emissive mesh-light NEE (UR10-2 Part A). Verifies the emitter CDF build and
 * that one-sample estimator, averaged, matches the closed-form small-emitter
 * irradiance E ≈ ρ/π · Le · A · cosθ_s · cosθ_l / d² (the half-space irradiance
 * a point receives from a small Lambertian rectangle directly overhead).
 */

function emissiveMat(strength: number): SnapMaterial {
  return {
    baseColor: [1, 1, 1], metallic: 0, roughness: 1,
    emissive: [1, 1, 1], emissiveStrength: strength,
    subsurfaceWeight: 0, subsurfaceRadius: 0.05,
  };
}

/** A w×w emitter quad in the z = d plane, centred over the origin (two tris). */
function emitterQuad(halfW: number, d: number): { tris: Float32Array; triMat: Int32Array } {
  const a = [-halfW, -halfW, d], b = [halfW, -halfW, d], c = [halfW, halfW, d], e = [-halfW, halfW, d];
  const tris = new Float32Array([
    ...a, ...b, ...c,
    ...a, ...c, ...e,
  ]);
  return { tris, triMat: Int32Array.from([0, 0]) };
}

describe('buildEmitters', () => {
  it('collects emissive triangles into an area CDF ending at 1', () => {
    const { tris, triMat } = emitterQuad(0.5, 1); // 1×1 quad, area 1
    const em = buildEmitters(tris, triMat, [emissiveMat(3)]);
    expect(em).not.toBeNull();
    expect(em!.tris.length).toBe(2);
    expect(em!.totalArea).toBeCloseTo(1, 6);
    expect(em!.cdf[em!.cdf.length - 1]).toBeCloseTo(1, 6);
    // radiance = emissive × strength.
    expect([...em!.radiance.slice(0, 3)]).toEqual([3, 3, 3]);
  });

  it('returns null when no triangle is emissive (NEE stays off)', () => {
    const { tris, triMat } = emitterQuad(0.5, 1);
    const mat: SnapMaterial = { ...emissiveMat(0), emissive: [0, 0, 0], emissiveStrength: 0 };
    expect(buildEmitters(tris, triMat, [mat])).toBeNull();
  });

  it('excludes node-graph emissive materials (kept as bounce-found glow)', () => {
    const { tris, triMat } = emitterQuad(0.5, 1);
    const mat: SnapMaterial = { ...emissiveMat(5), nodeGraph: {} as never };
    expect(buildEmitters(tris, triMat, [mat])).toBeNull();
  });
});

describe('sampleEmitters vs analytic half-space irradiance', () => {
  it('averages to ρ/π · Le · A / d² for a small overhead emitter', () => {
    const halfW = 0.05, d = 1; // 0.1×0.1 emitter, area 0.01, at z=1
    const A = (halfW * 2) ** 2;
    const Le = 1; // emissive [1,1,1] × strength 1
    const { tris, triMat } = emitterQuad(halfW, d);
    const em = buildEmitters(tris, triMat, [emissiveMat(1)])!;
    const albedo: [number, number, number] = [1, 1, 1];
    const rng = mulberry32(12345);
    const out: [number, number, number] = [0, 0, 0];
    let sum = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) {
      out[0] = out[1] = out[2] = 0;
      // Surface point at the origin, normal +Z toward the emitter, no occluder.
      sampleEmitters(null, tris, em, 0, 0, 0, 0, 0, 1, albedo, rng, out);
      sum += out[0];
    }
    const mean = sum / N;
    const expected = (1 / Math.PI) * Le * A / (d * d); // cosθ_s ≈ cosθ_l ≈ 1
    expect(mean).toBeGreaterThan(expected * 0.95);
    expect(mean).toBeLessThan(expected * 1.05);
  });

  it('a shading point facing AWAY from the emitter receives nothing', () => {
    const { tris, triMat } = emitterQuad(0.05, 1);
    const em = buildEmitters(tris, triMat, [emissiveMat(1)])!;
    const rng = mulberry32(7);
    const out: [number, number, number] = [0, 0, 0];
    // Normal -Z (facing away from the overhead emitter) → cosθ_s ≤ 0.
    sampleEmitters(null, tris, em, 0, 0, 0, 0, 0, -1, [1, 1, 1], rng, out);
    expect(out).toEqual([0, 0, 0]);
  });
});
