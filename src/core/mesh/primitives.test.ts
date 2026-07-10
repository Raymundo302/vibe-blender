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

  it('face normal is +Z (up)', () => {
    const faceId = [...plane.faces.keys()][0];
    const n = plane.faceNormal(faceId);
    expect(n.equalsApprox(Vec3.Z)).toBe(true);
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
      const u = Math.atan2(c.y, c.x);
      const ringPoint = new Vec3(majorR * Math.cos(u), majorR * Math.sin(u), 0);
      expect(torus.faceNormal(f).dot(c.sub(ringPoint))).toBeGreaterThan(0);
    }
  });

  it('all verts lie at minorRadius from the ring circle', () => {
    for (const v of torus.verts.values()) {
      const u = Math.atan2(v.co.y, v.co.x);
      const ringPoint = new Vec3(majorR * Math.cos(u), majorR * Math.sin(u), 0);
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

  it('face normal is +Z (matches the plane)', () => {
    const c = makeCircle();
    const f = [...c.faces.keys()][0];
    expect(c.faceNormal(f).equalsApprox(Vec3.Z)).toBe(true);
  });

  it('without fill: `vertices` verts and NO face', () => {
    const c = makeCircle(1, 20, false);
    expect(c.verts.size).toBe(20);
    expect(c.faces.size).toBe(0);
  });
});

describe('primitive UV unwraps', () => {
  const EPS = 1e-6;

  /** UVs cover every face and every corner is within [0, 1+ε] (Blender-conventional). */
  function expectFullUnwrap(mesh: EditableMesh, maxU = 1) {
    expect(mesh.uvs.size).toBe(mesh.faces.size);
    for (const [fid, uvs] of mesh.uvs) {
      const face = mesh.faces.get(fid)!;
      expect(uvs.length).toBe(face.verts.length); // one uv per corner
      for (const [u, v] of uvs) {
        expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true);
        expect(u).toBeGreaterThanOrEqual(-EPS);
        expect(u).toBeLessThanOrEqual(maxU + EPS);
        expect(v).toBeGreaterThanOrEqual(-EPS);
        expect(v).toBeLessThanOrEqual(1 + EPS);
      }
    }
  }

  it('makePlane: single quad maps to the unit square in vert winding order', () => {
    const plane = makePlane();
    expectFullUnwrap(plane);
    const fid = [...plane.faces.keys()][0];
    expect(plane.uvs.get(fid)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('makeCube: cross layout, all 6 faces mapped, strip edges pixel-exact', () => {
    const cube = makeCube();
    expectFullUnwrap(cube);
    const ids = [...cube.faces.keys()]; // insertion order: +Z,-Z,+X,-X,+Y,-Y
    const front = cube.uvs.get(ids[5])!; // -Y front, column 0
    const right = cube.uvs.get(ids[2])!; // +X right, column 1
    // Front occupies the middle row of column 0 (u 0..0.25, v 1/3..2/3).
    expect(front).toEqual([[0, 1 / 3], [0.25, 1 / 3], [0.25, 2 / 3], [0, 2 / 3]]);
    // Front's right edge (u=0.25) is byte-identical to right's left edge (u=0.25).
    expect(right[0][0]).toBe(0.25); // right face left-top corner
    expect(right[1][0]).toBe(0.25); // right face left-bottom corner
    expect(front[1][0]).toBe(0.25); // front face right-bottom corner
    expect(front[2][0]).toBe(0.25); // front face right-top corner
    // Top (+Z) sits above the front column (v 2/3..1); bottom (-Z) below (v 0..1/3).
    for (const [, v] of cube.uvs.get(ids[0])!) expect(v).toBeGreaterThanOrEqual(2 / 3 - EPS);
    for (const [, v] of cube.uvs.get(ids[1])!) expect(v).toBeLessThanOrEqual(1 / 3 + EPS);
  });

  it('makeUvSphere: equirectangular, equator v=0.5, poles v=0/1, seam u=1', () => {
    const segments = 32, rings = 16;
    const sphere = makeUvSphere(1, segments, rings);
    expectFullUnwrap(sphere);
    // Some corner sits exactly on the equator (ring 8 → v = (16-8)/16 = 0.5).
    let sawEquator = false, sawTop = false, sawBottom = false, sawSeamU1 = false;
    for (const uvs of sphere.uvs.values()) {
      for (const [u, v] of uvs) {
        if (Math.abs(v - 0.5) < EPS) sawEquator = true;
        if (Math.abs(v - 1) < EPS) sawTop = true;   // north pole corners
        if (Math.abs(v - 0) < EPS) sawBottom = true; // south pole corners
        if (Math.abs(u - 1) < EPS) sawSeamU1 = true; // wrap seam right edge
      }
    }
    expect(sawEquator).toBe(true);
    expect(sawTop).toBe(true);
    expect(sawBottom).toBe(true);
    expect(sawSeamU1).toBe(true);
  });

  it('makeCylinder: sides in the top half, seam u 0.96875→1, caps as circles', () => {
    const segments = 32;
    const cyl = makeCylinder(1, 2, segments);
    expectFullUnwrap(cyl);
    const ids = [...cyl.faces.keys()]; // 0..segments-1 sides, then top cap, bottom cap
    // Every side-face corner lives in the top half (v 0.5..1).
    for (let j = 0; j < segments; j++)
      for (const [, v] of cyl.uvs.get(ids[j])!) expect(v).toBeGreaterThanOrEqual(0.5 - EPS);
    // The last side face wraps to u=1 on its right corners, NOT back to 0.
    const seam = cyl.uvs.get(ids[segments - 1])!;
    expect(seam[0][0]).toBeCloseTo(31 / 32, 12); // 0.96875
    expect(seam[1][0]).toBe(1);
    expect(seam[2][0]).toBe(1);
    // Caps live in the bottom half, centered at (0.25,0.25) / (0.75,0.25), r=0.2.
    for (const [u, v] of cyl.uvs.get(ids[segments])!) { // top cap
      expect(v).toBeLessThanOrEqual(0.45 + EPS);
      expect(Math.hypot(u - 0.25, v - 0.25)).toBeCloseTo(0.2, 6);
    }
    for (const [u, v] of cyl.uvs.get(ids[segments + 1])!) // bottom cap
      expect(Math.hypot(u - 0.75, v - 0.25)).toBeCloseTo(0.2, 6);
  });

  it('makeTorus: grid unwrap with seam u=1 and v=1 at both wraps', () => {
    const majorSeg = 48, minorSeg = 12;
    const torus = makeTorus(1, 0.25, majorSeg, minorSeg);
    expectFullUnwrap(torus);
    let sawU1 = false, sawV1 = false;
    for (const uvs of torus.uvs.values())
      for (const [u, v] of uvs) {
        if (Math.abs(u - 1) < EPS) sawU1 = true;
        if (Math.abs(v - 1) < EPS) sawV1 = true;
      }
    expect(sawU1).toBe(true); // last major segment's far edge
    expect(sawV1).toBe(true); // last minor segment's far edge
  });

  it('makeIcoSphere: per-face spherical projection (wrap fix may push u past 1, ≤2)', () => {
    const ico = makeIcoSphere(1, 2);
    // NOTE: the seam wrap fix intentionally adds 1.0 to a face's small-u corners,
    // so u can exceed 1 by design (display clamps later). Assert ≤ 2.
    expectFullUnwrap(ico, 2);
    // v spans the sphere (some corner near the top, some near the bottom).
    let minV = 1, maxV = 0;
    for (const uvs of ico.uvs.values())
      for (const [, v] of uvs) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    expect(minV).toBeLessThan(0.2);
    expect(maxV).toBeGreaterThan(0.8);
  });

  it('makeCircle: planar map centered at (0.5,0.5); no face → no UVs', () => {
    const c = makeCircle(1, 24, true);
    expectFullUnwrap(c);
    const fid = [...c.faces.keys()][0];
    // The vert at angle 0 sits at x=r → u=1, v=0.5; the map is centered.
    for (const [u, v] of c.uvs.get(fid)!) {
      expect(Math.hypot(u - 0.5, v - 0.5)).toBeCloseTo(0.5, 6); // on the unit circle's edge
    }
    // No fill face → nothing to map.
    const empty = makeCircle(1, 24, false);
    expect(empty.uvs.size).toBe(0);
  });

  it('every registry primitive default ships a full unwrap', () => {
    for (const def of PRIMITIVES) {
      const mesh = def.make();
      // Ico's wrap fix can exceed 1; everyone else stays in the unit square.
      const maxU = def.name === 'Ico Sphere' ? 2 : 1;
      expect(mesh.uvs.size).toBe(mesh.faces.size);
      for (const [fid, uvs] of mesh.uvs) {
        expect(uvs.length).toBe(mesh.faces.get(fid)!.verts.length);
        for (const [u, v] of uvs) {
          expect(u).toBeGreaterThanOrEqual(-EPS);
          expect(u).toBeLessThanOrEqual(maxU + EPS);
          expect(v).toBeGreaterThanOrEqual(-EPS);
          expect(v).toBeLessThanOrEqual(1 + EPS);
        }
      }
    }
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
