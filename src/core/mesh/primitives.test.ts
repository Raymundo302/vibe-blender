import { describe, it, expect } from 'vitest';
import { Vec3 } from '../math/vec3';
import { EditableMesh } from './EditableMesh';
import {
  makePlane,
  makeUvSphere,
  makeCylinder,
  makeTorus,
  makeIcoSphere,
  PRIMITIVES,
} from './primitives';

/** Area-weighted centroid substitute: plain average of a face's verts. */
function faceCentroid(mesh: EditableMesh, faceId: number): Vec3 {
  const face = mesh.faces.get(faceId)!;
  let c = Vec3.ZERO;
  for (const vid of face.verts) c = c.add(mesh.verts.get(vid)!.co);
  return c.scale(1 / face.verts.length);
}

describe('makePlane', () => {
  const plane = makePlane();

  it('is one quad: 4 verts, 1 face', () => {
    expect(plane.verts.size).toBe(4);
    expect(plane.faces.size).toBe(1);
  });

  it('every edge is a boundary (1 face)', () => {
    const edges = [...plane.edges().values()];
    expect(edges.length).toBe(4);
    for (const e of edges) expect(e.faces.length).toBe(1);
  });

  it('face normal is +Y', () => {
    const faceId = [...plane.faces.keys()][0];
    const n = plane.faceNormal(faceId);
    expect(n.equalsApprox(Vec3.Y)).toBe(true);
  });
});

describe('makeUvSphere (defaults)', () => {
  const segments = 32, rings = 16, radius = 1;
  const sphere = makeUvSphere(radius, segments, rings);

  it('has segments*(rings-1)+2 verts and segments*rings faces', () => {
    expect(sphere.verts.size).toBe(segments * (rings - 1) + 2);
    expect(sphere.faces.size).toBe(segments * rings);
  });

  it('is manifold: every edge borders 2 faces', () => {
    for (const e of sphere.edges().values()) expect(e.faces.length).toBe(2);
  });

  it('normals point outward (dot with centroid - origin > 0)', () => {
    for (const f of sphere.faces.keys()) {
      const c = faceCentroid(sphere, f);
      expect(sphere.faceNormal(f).dot(c)).toBeGreaterThan(0);
    }
  });

  it('all verts lie at |co| ≈ radius', () => {
    for (const v of sphere.verts.values()) {
      expect(Math.abs(v.co.length() - radius)).toBeLessThan(1e-6);
    }
  });
});

describe('makeCylinder (defaults)', () => {
  const segments = 32, radius = 1, depth = 2;
  const cyl = makeCylinder(radius, depth, segments);

  it('has 2*segments verts and segments+2 faces', () => {
    expect(cyl.verts.size).toBe(2 * segments);
    expect(cyl.faces.size).toBe(segments + 2);
  });

  it('has two n-gon cap faces', () => {
    const nGon = [...cyl.faces.values()].filter((f) => f.verts.length === segments);
    expect(nGon.length).toBe(2);
  });

  it('is manifold: every edge borders 2 faces', () => {
    for (const e of cyl.edges().values()) expect(e.faces.length).toBe(2);
  });

  it('normals point outward (dot with centroid - origin > 0)', () => {
    // Origin is the natural reference: side centroids are radial (y=0), and cap
    // centroids sit on the axis at (0, ±hy, 0) with ±Y normals — both give > 0.
    // A per-face nearest-Y-axis-point is degenerate for the caps (centroid on axis).
    for (const f of cyl.faces.keys()) {
      const c = faceCentroid(cyl, f);
      expect(cyl.faceNormal(f).dot(c)).toBeGreaterThan(0);
    }
  });
});

describe('makeTorus (defaults)', () => {
  const majorR = 1, minorR = 0.25, majorSeg = 48, minorSeg = 12;
  const torus = makeTorus(majorR, minorR, majorSeg, minorSeg);

  it('has majorSeg*minorSeg verts and faces', () => {
    expect(torus.verts.size).toBe(majorSeg * minorSeg);
    expect(torus.faces.size).toBe(majorSeg * minorSeg);
  });

  it('is manifold: every edge borders 2 faces', () => {
    for (const e of torus.edges().values()) expect(e.faces.length).toBe(2);
  });

  it('normals point outward (dot with centroid - nearest ring-circle point > 0)', () => {
    for (const f of torus.faces.keys()) {
      const c = faceCentroid(torus, f);
      const u = Math.atan2(c.z, c.x);
      const ringPoint = new Vec3(majorR * Math.cos(u), 0, majorR * Math.sin(u));
      expect(torus.faceNormal(f).dot(c.sub(ringPoint))).toBeGreaterThan(0);
    }
  });

  it('all verts lie at minorRadius from the ring circle', () => {
    for (const v of torus.verts.values()) {
      const u = Math.atan2(v.co.z, v.co.x);
      const ringPoint = new Vec3(majorR * Math.cos(u), 0, majorR * Math.sin(u));
      expect(Math.abs(v.co.distanceTo(ringPoint) - minorR)).toBeLessThan(1e-6);
    }
  });
});

describe('makeIcoSphere', () => {
  it('has 42 verts / 80 faces at subdivisions = 1', () => {
    const ico = makeIcoSphere(1, 1);
    expect(ico.verts.size).toBe(42);
    expect(ico.faces.size).toBe(80);
  });

  it('has 162 verts / 320 faces at default subdivisions = 2', () => {
    const ico = makeIcoSphere();
    expect(ico.verts.size).toBe(162);
    expect(ico.faces.size).toBe(320);
  });

  it('is manifold and outward-facing with verts on the sphere', () => {
    const radius = 1;
    const ico = makeIcoSphere(radius, 2);
    for (const e of ico.edges().values()) expect(e.faces.length).toBe(2);
    for (const f of ico.faces.keys()) {
      const c = faceCentroid(ico, f);
      expect(ico.faceNormal(f).dot(c)).toBeGreaterThan(0);
    }
    for (const v of ico.verts.values()) {
      expect(Math.abs(v.co.length() - radius)).toBeLessThan(1e-6);
    }
  });
});

describe('PRIMITIVES registry', () => {
  it('has 6 entries in Blender Add > Mesh order', () => {
    expect(PRIMITIVES.map((p) => p.name)).toEqual([
      'Plane', 'Cube', 'UV Sphere', 'Ico Sphere', 'Cylinder', 'Torus',
    ]);
  });

  it('every make() returns a fresh, non-empty mesh', () => {
    for (const def of PRIMITIVES) {
      const a = def.make();
      const b = def.make();
      expect(a).not.toBe(b);
      expect(a.verts.size).toBeGreaterThan(0);
      expect(a.faces.size).toBeGreaterThan(0);
    }
  });
});
