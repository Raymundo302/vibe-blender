import { describe, expect, it } from 'vitest';
import { fromSurfaceData, surfaceDomain, surfacePoint } from './surface';
import { surfCone, surfCylinder, surfPatch, surfSphere, surfTorus } from './primitives';
import type { SurfaceData } from '../scene/objectData';

/** Evaluate a builder's surface on an (n+1)×(n+1) uniform parameter grid. */
function sampleGrid(data: SurfaceData, n = 16): { u: number; v: number; p: import('../math/vec3').Vec3 }[] {
  const s = fromSurfaceData(data)!;
  const [ul, uh, vl, vh] = surfaceDomain(s);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = ul + ((uh - ul) * i) / n;
    for (let j = 0; j <= n; j++) {
      const v = vl + ((vh - vl) * j) / n;
      out.push({ u, v, p: surfacePoint(s, u, v) });
    }
  }
  return out;
}

describe('nurbs surface primitives', () => {
  it('patch is flat and spans ±size/2', () => {
    for (const size of [2, 3.5]) {
      const data = surfPatch(size);
      expect(data.pointsU).toBe(4);
      expect(data.pointsV).toBe(4);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const { p } of sampleGrid(data, 12)) {
        expect(p.z).toBeCloseTo(0, 12); // flat
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      // Control net corners are the surface corners (clamped-uniform endpoints).
      expect(minX).toBeCloseTo(-size / 2, 9);
      expect(maxX).toBeCloseTo(size / 2, 9);
      expect(minY).toBeCloseTo(-size / 2, 9);
      expect(maxY).toBeCloseTo(size / 2, 9);
    }
  });

  it('sphere: every sample at distance radius from origin', () => {
    for (const radius of [1, 2.5]) {
      for (const { p } of sampleGrid(surfSphere(radius), 16)) {
        expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(radius, 9);
      }
    }
  });

  it('cylinder: every sample at horizontal radius, within depth', () => {
    for (const [radius, depth] of [[1, 2], [0.8, 3]]) {
      for (const { p } of sampleGrid(surfCylinder(radius, depth), 16)) {
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(radius, 9);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(depth / 2 + 1e-9);
      }
    }
  });

  it('cone: samples on straight rim→apex lines (radius shrinks linearly with z)', () => {
    for (const [radius, depth] of [[1, 2], [1.5, 2.5]]) {
      for (const { p } of sampleGrid(surfCone(radius, depth), 16)) {
        expect(Math.abs(p.z)).toBeLessThanOrEqual(depth / 2 + 1e-9);
        // Linear interpolation z=-depth/2 (r=radius) → z=+depth/2 (r=0).
        const t = (p.z + depth / 2) / depth; // 0 at rim, 1 at apex
        const expectedR = radius * (1 - t);
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(expectedR, 9);
      }
    }
  });

  it('torus: every sample at distance minor from the major ring', () => {
    for (const [major, minor] of [[1, 0.25], [2, 0.6]]) {
      for (const { p } of sampleGrid(surfTorus(major, minor), 16)) {
        const ring = Math.hypot(Math.hypot(p.x, p.y) - major, p.z);
        expect(ring).toBeCloseTo(minor, 9);
      }
    }
  });
});
