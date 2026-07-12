import { describe, it, expect } from 'vitest';
import './builtins'; // side-effect: registers 'pipe'
import { createModifier, type ModifierContext } from './Modifier';
import { buildPipe } from './pipe';
import { EditableMesh } from '../mesh/EditableMesh';
import { Mat4 } from '../math/mat4';
import { Vec3 } from '../math/vec3';
import type { CurveData } from '../scene/objectData';

/** Straight open bezier along +X: 2 anchors, `res` segments per span. */
function straightCurve(res = 12): CurveData {
  return { kind: 'bezier', cyclic: false, resolution: res, points: [{ co: [0, 0, 0] }, { co: [2, 0, 0] }] };
}

/** Cyclic bezier circle-ish loop (4 anchors), `res` segments per span. */
function cyclicCurve(res = 8): CurveData {
  return {
    kind: 'bezier',
    cyclic: true,
    resolution: res,
    points: [{ co: [1, 0, 0] }, { co: [0, 1, 0] }, { co: [-1, 0, 0] }, { co: [0, -1, 0] }],
  };
}

/** A ModifierContext exposing a host curve (the only field Pipe reads). */
function curveCtx(curve: CurveData): ModifierContext {
  return { hostMatrix: Mat4.identity(), target: () => null, hostCurve: curve };
}

function faceCorners(mesh: EditableMesh, fid: number): Vec3[] {
  return mesh.faces.get(fid)!.verts.map((vid) => mesh.verts.get(vid)!.co);
}

/** Newell (area-weighted) normal of a face from its winding. */
function newellNormal(mesh: EditableMesh, fid: number): Vec3 {
  const cs = faceCorners(mesh, fid);
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return new Vec3(nx, ny, nz).normalize();
}

/** Count edges used by exactly one face (open boundary). */
function boundaryEdges(mesh: EditableMesh): number {
  let n = 0;
  for (const e of mesh.edges().values()) if (e.faces.length === 1) n++;
  return n;
}

describe('Pipe — open curve ring/quad counts', () => {
  it('open curve, no caps: rings = res+1, one quad band per gap', () => {
    const res = 12, sides = 10;
    const mesh = buildPipe(straightCurve(res), 0.1, sides, false, 0.1);
    const ringCount = res + 1; // evaluateCurve emits res points + final anchor
    expect(mesh.verts.size).toBe(ringCount * sides);
    expect(mesh.faces.size).toBe((ringCount - 1) * sides); // quads only
    // Every side face is a quad.
    for (const f of mesh.faces.values()) expect(f.verts.length).toBe(4);
    // Uncapped tube has two open ends.
    expect(boundaryEdges(mesh)).toBe(2 * sides);
  });

  it('caps add a triangle fan per end (open only)', () => {
    const res = 12, sides = 10;
    const capped = buildPipe(straightCurve(res), 0.1, sides, true, 0.1);
    const ringCount = res + 1;
    expect(capped.verts.size).toBe(ringCount * sides + 2); // +2 fan centers
    expect(capped.faces.size).toBe((ringCount - 1) * sides + 2 * sides); // quads + 2 fans
    const tris = [...capped.faces.values()].filter((f) => f.verts.length === 3);
    expect(tris.length).toBe(2 * sides); // fan triangles
    expect(boundaryEdges(capped)).toBe(0); // caps close both ends
  });
});

describe('Pipe — cyclic weld (no caps)', () => {
  it('cyclic curve welds the seam: no duplicate ring, closed surface', () => {
    const res = 8, sides = 12;
    const mesh = buildPipe(cyclicCurve(res), 0.1, sides, true /*capEnds ignored*/, 0.1);
    const ringCount = 4 * res; // 4 spans × res, closing duplicate dropped
    expect(mesh.verts.size).toBe(ringCount * sides); // welded — no seam duplicate
    expect(mesh.faces.size).toBe(ringCount * sides); // one band per ring incl. closing
    for (const f of mesh.faces.values()) expect(f.verts.length).toBe(4); // no caps
    expect(boundaryEdges(mesh)).toBe(0); // closed loop, watertight
  });
});

describe('Pipe — taper', () => {
  it('radiusEnd tapers the radius linearly by arclength (open)', () => {
    const res = 12, sides = 16;
    const rStart = 0.3, rEnd = 0.05;
    const mesh = buildPipe(straightCurve(res), rStart, sides, false, rEnd);
    const ringCount = res + 1;
    // Ring ri verts are exactly `r` from the ring's centerline point (poly[ri]).
    const ringRadius = (ri: number): number => {
      const c = mesh.verts.get(ri * sides)!.co; // any vert in the ring
      // The centerline x of ring ri: straight curve → x runs 0..2 linearly.
      const cx = (2 * ri) / (ringCount - 1);
      return Math.hypot(c.y - 0, c.z - 0) + Math.abs(c.x - cx) * 0; // radial in YZ
    };
    expect(ringRadius(0)).toBeCloseTo(rStart, 5);
    expect(ringRadius(ringCount - 1)).toBeCloseTo(rEnd, 5);
    // Midpoint ~ halfway between.
    const mid = ringRadius((ringCount - 1) >> 1);
    expect(mid).toBeGreaterThan(rEnd);
    expect(mid).toBeLessThan(rStart);
  });

  it('no radiusEnd → uniform radius (both ends equal)', () => {
    const mesh = createModifier('pipe', { radius: 0.2, sides: 8 }).apply(new EditableMesh(), curveCtx(straightCurve(6)));
    const first = mesh.verts.get(0)!.co;
    const ringCount = 7;
    const lastRingStart = (ringCount - 1) * 8;
    const last = mesh.verts.get(lastRingStart)!.co;
    expect(Math.hypot(first.y, first.z)).toBeCloseTo(0.2, 5);
    expect(Math.hypot(last.y, last.z)).toBeCloseTo(0.2, 5);
  });
});

describe('Pipe — UVs', () => {
  it('u spans [0,1] around the profile; v spans [0,1] along the length', () => {
    const mesh = buildPipe(straightCurve(12), 0.1, 10, false, 0.1);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const uvs of mesh.uvs.values()) {
      for (const [u, v] of uvs) {
        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      }
    }
    expect(uMin).toBeCloseTo(0, 6);
    expect(uMax).toBeCloseTo(1, 6);
    expect(vMin).toBeCloseTo(0, 6);
    expect(vMax).toBeCloseTo(1, 6);
    // Every side face carries UVs.
    expect(mesh.uvs.size).toBe(mesh.faces.size);
  });
});

describe('Pipe — outward-facing normals', () => {
  it('side-quad winding yields radially outward normals', () => {
    const res = 6, sides = 12, r = 0.2;
    const mesh = buildPipe(straightCurve(res), r, sides, false, r);
    let checked = 0;
    for (const f of mesh.faces.values()) {
      if (f.verts.length !== 4) continue;
      const cs = faceCorners(mesh, f.id);
      const centroid = cs.reduce((a, c) => a.add(c), new Vec3()).scale(1 / cs.length);
      // Centerline for the straight curve is the X axis → radial = (0, y, z).
      const radial = new Vec3(0, centroid.y, centroid.z).normalize();
      const n = newellNormal(mesh, f.id);
      expect(n.dot(radial)).toBeGreaterThan(0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('Pipe — params + no-op guards', () => {
  it('sides clamps to 3..64', () => {
    const lo = createModifier('pipe', { sides: 2 });
    const hi = createModifier('pipe', { sides: 500 });
    expect(lo.params().sides).toBe(3);
    expect(hi.params().sides).toBe(64);
  });

  it('params round-trip through createModifier', () => {
    const m = createModifier('pipe', { radius: 0.25, sides: 20, capEnds: false, radiusEnd: 0.05 });
    const p = m.params();
    expect(p.radius).toBe(0.25);
    expect(p.sides).toBe(20);
    expect(p.capEnds).toBe(false);
    expect(p.radiusEnd).toBe(0.05);
    // A second modifier built from the first's params is geometrically identical.
    const clone = createModifier('pipe', m.params());
    const a = m.apply(new EditableMesh(), curveCtx(straightCurve(8)));
    const b = clone.apply(new EditableMesh(), curveCtx(straightCurve(8)));
    expect(a.verts.size).toBe(b.verts.size);
    expect(a.faces.size).toBe(b.faces.size);
  });

  it('no-op (returns the input mesh) when the context has no host curve', () => {
    const base = new EditableMesh();
    const out = createModifier('pipe').apply(base, { hostMatrix: Mat4.identity(), target: () => null });
    expect(out).toBe(base);
  });

  it('no-op with no context at all (bare-mesh unit context)', () => {
    const base = new EditableMesh();
    expect(createModifier('pipe').apply(base)).toBe(base);
  });

  it('depVersion changes when the curve changes (live-update cache key)', () => {
    const m = createModifier('pipe');
    const v1 = m.depVersion!(curveCtx(straightCurve(8)));
    const moved = straightCurve(8);
    moved.points[1].co = [3, 1, 0];
    const v2 = m.depVersion!(curveCtx(moved));
    expect(v1).not.toBe(v2);
  });
});
