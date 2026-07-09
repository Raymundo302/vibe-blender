import { describe, expect, it } from 'vitest';
import { sunShadowMatrix, spotShadowMatrix, SHADOW_SLOTS } from './shadowPass';
import { shadowCasterIndices, MAX_LIGHTS, type LightSet } from './renderedPass';
import { Vec3 } from '../../core/math/vec3';

function ndcOf(m: ReturnType<typeof sunShadowMatrix>, p: Vec3): Vec3 {
  const v = m.m;
  const x = v[0] * p.x + v[4] * p.y + v[8] * p.z + v[12];
  const y = v[1] * p.x + v[5] * p.y + v[9] * p.z + v[13];
  const z = v[2] * p.x + v[6] * p.y + v[10] * p.z + v[14];
  const w = v[3] * p.x + v[7] * p.y + v[11] * p.z + v[15];
  return new Vec3(x / w, y / w, z / w);
}

function lightSet(types: number[]): LightSet {
  return {
    count: types.length,
    positions: new Float32Array(MAX_LIGHTS * 3),
    directions: new Float32Array(MAX_LIGHTS * 3),
    energies: new Float32Array(MAX_LIGHTS * 3),
    types: new Float32Array(Object.assign(new Array(MAX_LIGHTS).fill(0), types)),
    spots: new Float32Array(MAX_LIGHTS * 2),
  };
}

describe('sunShadowMatrix', () => {
  it('maps the framed bounding sphere inside NDC', () => {
    const center = new Vec3(1, 2, 3);
    const m = sunShadowMatrix(new Vec3(0, -1, 0), center, 2);
    // Center lands mid-frustum, sphere-surface points stay inside ±1.
    const c = ndcOf(m, center);
    expect(Math.abs(c.x)).toBeLessThan(1e-4);
    expect(Math.abs(c.y)).toBeLessThan(1e-4);
    expect(Math.abs(c.z)).toBeLessThan(1);
    for (const off of [new Vec3(2, 0, 0), new Vec3(0, 2, 0), new Vec3(0, 0, 2), new Vec3(-2, 0, 0)]) {
      const p = ndcOf(m, center.add(off));
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1 + 1e-4);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1 + 1e-4);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1 + 1e-4);
    }
  });

  it('handles a straight-down sun (dir parallel to Y up)', () => {
    const m = sunShadowMatrix(new Vec3(0, -1, 0), Vec3.ZERO, 1);
    const c = ndcOf(m, Vec3.ZERO);
    expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)).toBe(true);
  });
});

describe('spotShadowMatrix', () => {
  it('keeps points inside the cone inside NDC, apex-forward', () => {
    const pos = new Vec3(0, 5, 0);
    const dir = new Vec3(0, -1, 0); // straight down
    const m = spotShadowMatrix(pos, dir, Math.PI / 2, 10);
    // 3 units below the apex, slightly off-axis (inside a 90° cone).
    const p = ndcOf(m, new Vec3(0.5, 2, 0.5));
    expect(Math.abs(p.x)).toBeLessThan(1);
    expect(Math.abs(p.y)).toBeLessThan(1);
    expect(p.z).toBeGreaterThan(-1);
    expect(p.z).toBeLessThan(1);
    // A point BEHIND the apex projects behind the near plane (w < 0 → z flips).
    const behind = ndcOf(m, new Vec3(0, 7, 0));
    expect(Math.abs(behind.z)).toBeGreaterThan(1);
  });
});

describe('shadowCasterIndices', () => {
  it('picks suns and spots in order, skipping points', () => {
    // types: point, sun, spot, point, sun
    expect(shadowCasterIndices(lightSet([0, 1, 2, 0, 1]), SHADOW_SLOTS)).toEqual([1, 2, 4]);
  });

  it('caps at the slot count', () => {
    expect(shadowCasterIndices(lightSet([1, 2, 1, 2, 1, 2]), 4)).toEqual([0, 1, 2, 3]);
  });

  it('returns empty for point-only scenes', () => {
    expect(shadowCasterIndices(lightSet([0, 0]), SHADOW_SLOTS)).toEqual([]);
  });
});
