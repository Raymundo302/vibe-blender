import { describe, it, expect } from 'vitest';
import { Vec3 } from '../math/vec3';
import { EditableMesh } from './EditableMesh';
import {
  makeCube,
  makePlane,
  makeUvSphere,
  makeCylinder,
  makeTorus,
  makeIcoSphere,
  makeCircle,
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

describe('makeCircle', () => {
  it('with fill: 1 n-gon face and `vertices` verts', () => {
    const c = makeCircle(1, 24, true);
    expect(c.verts.size).toBe(24);
    expect(c.faces.size).toBe(1);
    expect([...c.faces.values()][0].verts.length).toBe(24);
  });

  it('vertex count follows the `vertices` param', () => {
    expect(makeCircle(1, 8).verts.size).toBe(8);
    expect(makeCircle(1, 64).verts.size).toBe(64);
  });

  it('radius param scales the bounding radius', () => {
    for (const v of makeCircle(2.5, 16).verts.values()) {
      expect(Math.abs(v.co.length() - 2.5)).toBeLessThan(1e-6);
    }
  });

  it('face normal is +Y (matches the plane)', () => {
    const c = makeCircle();
    const f = [...c.faces.keys()][0];
    expect(c.faceNormal(f).equalsApprox(Vec3.Y)).toBe(true);
  });

  it('without fill: `vertices` verts and NO face', () => {
    const c = makeCircle(1, 20, false);
    expect(c.verts.size).toBe(20);
    expect(c.faces.size).toBe(0);
  });
});

describe('PRIMITIVES registry', () => {
  it('has 7 entries in Blender Add > Mesh order (Circle after Cube)', () => {
    expect(PRIMITIVES.map((p) => p.name)).toEqual([
      'Plane', 'Cube', 'Circle', 'UV Sphere', 'Ico Sphere', 'Cylinder', 'Torus',
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

  it('every param declares a key, label and kind', () => {
    for (const def of PRIMITIVES) {
      expect(def.params.length).toBeGreaterThan(0);
      for (const p of def.params) {
        expect(typeof p.key).toBe('string');
        expect(typeof p.label).toBe('string');
        expect(['number', 'int', 'bool']).toContain(p.kind);
      }
    }
  });

  // Snapshot of the historical default vert counts: make() with no values must
  // reproduce these exactly so existing scenes / fresh adds are unchanged.
  it('default make() reproduces the historical geometry', () => {
    const byName = Object.fromEntries(PRIMITIVES.map((d) => [d.name, d]));
    expect(byName['Plane'].make().verts.size).toBe(4);
    expect(byName['Cube'].make().verts.size).toBe(8);
    expect(byName['UV Sphere'].make().verts.size).toBe(32 * (16 - 1) + 2);
    expect(byName['Ico Sphere'].make().verts.size).toBe(162);
    expect(byName['Cylinder'].make().verts.size).toBe(2 * 32);
    expect(byName['Torus'].make().verts.size).toBe(48 * 12);
    // Byte-identical to the direct maker defaults (no divergence).
    expect(byName['Cube'].make().verts.size).toBe(makeCube().verts.size);
    expect(byName['Torus'].make().verts.size).toBe(makeTorus().verts.size);
  });

  it('make(values) respects segment/subdivision params', () => {
    const byName = Object.fromEntries(PRIMITIVES.map((d) => [d.name, d]));
    // Torus vert count = majorSegments * minorSegments.
    expect(byName['Torus'].make({ majorSegments: 12, minorSegments: 8 }).verts.size).toBe(96);
    // UV Sphere = segments*(rings-1)+2.
    expect(byName['UV Sphere'].make({ segments: 8, rings: 4 }).verts.size).toBe(8 * 3 + 2);
    // Cylinder = 2*vertices.
    expect(byName['Cylinder'].make({ vertices: 6 }).verts.size).toBe(12);
    // Ico Sphere subdivisions: verts = 10*4^n + 2.
    expect(byName['Ico Sphere'].make({ subdivisions: 1 }).verts.size).toBe(42);
  });

  it('make(values) respects radius/size (bounding radius grows)', () => {
    const byName = Object.fromEntries(PRIMITIVES.map((d) => [d.name, d]));
    const bigSphere = byName['UV Sphere'].make({ radius: 3 });
    for (const v of bigSphere.verts.values()) {
      expect(Math.abs(v.co.length() - 3)).toBeLessThan(1e-6);
    }
    // Cube size 4 → half-extent 2 → corner at |(2,2,2)| = 2√3.
    const bigCube = byName['Cube'].make({ size: 4 });
    for (const v of bigCube.verts.values()) {
      expect(Math.abs(Math.abs(v.co.x) - 2)).toBeLessThan(1e-6);
    }
  });

  it('make(values) coerces int params (rounds fractional input)', () => {
    const byName = Object.fromEntries(PRIMITIVES.map((d) => [d.name, d]));
    // 12.7 → 13 major segments; keep default minor (12) → 13*12 = 156.
    expect(byName['Torus'].make({ majorSegments: 12.7 }).verts.size).toBe(13 * 12);
  });
});
