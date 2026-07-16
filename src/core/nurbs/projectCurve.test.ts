import { describe, expect, it } from 'vitest';
import { Vec3 } from '../math/vec3';
import { Quat } from '../math/quat';
import { Transform } from '../math/transform';
import { Scene } from '../scene/Scene';
import type { CurveData } from '../scene/objectData';
import { defaultSurfaceTess } from '../scene/objectData';
import { surfPatch, surfSphere } from './primitives';
import { curveDomain, curvePoint, fromCurveData } from './curve';
import { fromSurfaceData, surfaceDomain, surfacePoint, type NSurface } from './surface';
import { projectCurveObjectToSurface, projectCurveToSurfaceUV } from './projectCurve';

/** Sample a UV CurveData at `n` params → surface 3D points. */
function surface3DFromUV(cd: CurveData, surf: NSurface, n: number): Vec3[] {
  const c = fromCurveData(cd)!;
  const [lo, hi] = curveDomain(c);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const uv = curvePoint(c, lo + ((hi - lo) * i) / n);
    out.push(surfacePoint(surf, uv.x, uv.y));
  }
  return out;
}

/** Straight 3D line as a NURBS CurveData (degree 1). */
function lineCurve(a: Vec3, b: Vec3): CurveData {
  return {
    kind: 'nurbs', cyclic: false, resolution: 12, order: 2,
    points: [{ co: [a.x, a.y, a.z] }, { co: [b.x, b.y, b.z] }],
  };
}

/** Perpendicular distance from p to the infinite line through a→b. */
function distToLine(p: Vec3, a: Vec3, b: Vec3): number {
  const d = b.sub(a).normalize();
  const r = p.sub(a);
  return r.sub(d.scale(r.dot(d))).length();
}

describe('projectCurveToSurfaceUV — closest mode', () => {
  it('a line hovering over the flat patch maps back onto its vertical projection', () => {
    const surf = fromSurfaceData(surfPatch())!;
    const a = new Vec3(-0.3, -0.2, 0.7);
    const b = new Vec3(0.3, 0.2, 0.7);
    const poly: Vec3[] = [];
    for (let i = 0; i <= 40; i++) poly.push(a.lerp(b, i / 40));

    const cd = projectCurveToSurfaceUV(poly, surf, { mode: 'closest' });
    expect(cd).not.toBeNull();

    const pts = surface3DFromUV(cd!, surf, 50);
    for (const p of pts) {
      // On the plane z = 0 (the vertical projection) and on the source line's
      // XY footprint.
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1e-6);
      expect(distToLine(new Vec3(p.x, p.y, 0), new Vec3(a.x, a.y, 0), new Vec3(b.x, b.y, 0)))
        .toBeLessThanOrEqual(1e-6);
    }
  });
});

describe('projectCurveToSurfaceUV — direction mode', () => {
  it('straight-down (−Z) onto a sphere from above lands on the upper hemisphere', () => {
    const surf = fromSurfaceData(surfSphere(1))!;
    const a = new Vec3(-0.4, -0.3, 2);
    const b = new Vec3(0.4, 0.3, 2);
    const poly: Vec3[] = [];
    for (let i = 0; i <= 60; i++) poly.push(a.lerp(b, i / 60));

    const cd = projectCurveToSurfaceUV(poly, surf, { mode: 'direction', dir: new Vec3(0, 0, -1) });
    expect(cd).not.toBeNull();

    const pts = surface3DFromUV(cd!, surf, 60);
    for (const p of pts) {
      // On the sphere, upper hemisphere, and its (x,y) is the −Z shadow of the
      // source line (perpendicular offset from the XY footprint ~0).
      expect(Math.abs(p.length() - 1)).toBeLessThanOrEqual(1e-4);
      expect(p.z).toBeGreaterThan(0);
      expect(distToLine(new Vec3(p.x, p.y, 0), new Vec3(a.x, a.y, 0), new Vec3(b.x, b.y, 0)))
        .toBeLessThanOrEqual(1e-4);
    }
  });

  it('a line half past the sphere edge yields the on-surface contiguous segment', () => {
    const surf = fromSurfaceData(surfSphere(1))!;
    const dom = surfaceDomain(surf);
    // Starts over the sphere (hits), ends well past the +Y edge (misses).
    const a = new Vec3(0, -0.2, 2);
    const b = new Vec3(0, 1.6, 2);
    const poly: Vec3[] = [];
    for (let i = 0; i <= 80; i++) poly.push(a.lerp(b, i / 80));

    const cd = projectCurveToSurfaceUV(poly, surf, { mode: 'direction', dir: new Vec3(0, 0, -1) });
    expect(cd).not.toBeNull();

    // No NaNs; every control point inside the UV domain.
    for (const pt of cd!.points) {
      expect(Number.isFinite(pt.co[0])).toBe(true);
      expect(Number.isFinite(pt.co[1])).toBe(true);
      expect(pt.co[0]).toBeGreaterThanOrEqual(dom[0] - 1e-9);
      expect(pt.co[0]).toBeLessThanOrEqual(dom[1] + 1e-9);
      expect(pt.co[1]).toBeGreaterThanOrEqual(dom[2] - 1e-9);
      expect(pt.co[1]).toBeLessThanOrEqual(dom[3] + 1e-9);
    }
    // Endpoints land on the sphere (the on-surface part).
    const pts = surface3DFromUV(cd!, surf, 40);
    expect(Math.abs(pts[0].length() - 1)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(pts[pts.length - 1].length() - 1)).toBeLessThanOrEqual(1e-4);
    for (const p of pts) expect(p.z).toBeGreaterThan(0);
  });

  it('a fully-missing projection returns null', () => {
    const surf = fromSurfaceData(surfSphere(1))!;
    // Line far to the side, projecting straight down — never meets the sphere.
    const a = new Vec3(3, -1, 2);
    const b = new Vec3(3, 1, 2);
    const poly: Vec3[] = [];
    for (let i = 0; i <= 40; i++) poly.push(a.lerp(b, i / 40));

    const cd = projectCurveToSurfaceUV(poly, surf, { mode: 'direction', dir: new Vec3(0, 0, -1) });
    expect(cd).toBeNull();
  });
});

describe('projectCurveObjectToSurface — world transforms', () => {
  it('a 90°-rotated surface still projects onto the same UV spot', () => {
    const line = lineCurve(new Vec3(-0.3, -0.2, 0.7), new Vec3(0.3, 0.2, 0.7));

    // Case A: identity surface + identity curve.
    const sceneA = new Scene();
    const surfA = sceneA.addSurface('S', { ...surfPatch(), tess: defaultSurfaceTess() });
    const curveA = sceneA.addCurve('C', line);
    const scA = projectCurveObjectToSurface(sceneA, curveA, surfA, { mode: 'closest' });
    expect(scA).not.toBeNull();
    expect(scA!.name).toBe('Proj.001');

    // Case B: BOTH the surface and the curve rotated 90° about X — the curve's
    // geometry in the surface's local frame is unchanged, so the UV must match.
    const rot = Quat.fromAxisAngle(Vec3.X, Math.PI / 2);
    const sceneB = new Scene();
    const surfB = sceneB.addSurface('S', { ...surfPatch(), tess: defaultSurfaceTess() });
    surfB.transform = new Transform(new Vec3(1, 2, 3), rot);
    const curveB = sceneB.addCurve('C', line);
    curveB.transform = new Transform(new Vec3(1, 2, 3), rot);
    const scB = projectCurveObjectToSurface(sceneB, curveB, surfB, { mode: 'closest' });
    expect(scB).not.toBeNull();

    const surf = fromSurfaceData(surfPatch())!;
    const ptsA = surface3DFromUV(scA!.curve, surf, 40);
    const ptsB = surface3DFromUV(scB!.curve, surf, 40);
    for (let i = 0; i < ptsA.length; i++) {
      expect(ptsA[i].distanceTo(ptsB[i])).toBeLessThanOrEqual(1e-6);
    }
  });

  it('names each projection with the next free Proj.NNN', () => {
    const scene = new Scene();
    const surf = scene.addSurface('S', { ...surfPatch(), tess: defaultSurfaceTess() });
    const curve = scene.addCurve('C', lineCurve(new Vec3(-0.3, 0, 0.7), new Vec3(0.3, 0, 0.7)));
    // Pre-existing surface curves occupying Proj.001.
    surf.surface!.surfaceCurves = [{ name: 'Proj.001', curve: lineCurve(new Vec3(0, 0, 0), new Vec3(1, 1, 0)) }];
    const sc = projectCurveObjectToSurface(scene, curve, surf, { mode: 'closest' });
    expect(sc!.name).toBe('Proj.002');
  });
});
