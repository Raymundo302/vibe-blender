import { describe, it, expect } from 'vitest';
import { EditableMesh } from '../core/mesh/EditableMesh';
import { Vec3 } from '../core/math/vec3';
import {
  sculptFalloff,
  brushWeights,
  vertexNormals,
  inflateDeltas,
  grabPositions,
  raycastMeshLocal,
  buildBrushCircle,
} from './sculptBrushes';

/**
 * A flat 2×2 grid of quads on the y=0 plane (z spanning -1..1, x spanning
 * -1..1), so the center vert (0,0,0) is shared by all four quads and its
 * averaged normal is exactly +Y. Corner verts sit at the extremes.
 */
function grid(): { mesh: EditableMesh; center: number; corners: number[] } {
  const mesh = new EditableMesh();
  const id: number[][] = [];
  for (let iz = 0; iz < 3; iz++) {
    id[iz] = [];
    for (let ix = 0; ix < 3; ix++) {
      id[iz][ix] = mesh.addVert(new Vec3(ix - 1, 0, iz - 1));
    }
  }
  // CCW seen from +Y so face normals point up.
  for (let iz = 0; iz < 2; iz++) {
    for (let ix = 0; ix < 2; ix++) {
      mesh.addFace([id[iz][ix], id[iz + 1][ix], id[iz + 1][ix + 1], id[iz][ix + 1]]);
    }
  }
  return { mesh, center: id[1][1], corners: [id[0][0], id[0][2], id[2][0], id[2][2]] };
}

describe('sculptFalloff', () => {
  it('is max (1) at the center', () => {
    expect(sculptFalloff(0, 2)).toBeCloseTo(1, 6);
  });
  it('is 0 at and beyond the radius', () => {
    expect(sculptFalloff(2, 2)).toBe(0);
    expect(sculptFalloff(3, 2)).toBe(0);
  });
  it('is 0.5 at half the radius', () => {
    expect(sculptFalloff(1, 2)).toBeCloseTo(0.5, 6);
  });
  it('is monotonically decreasing across the radius', () => {
    let prev = Infinity;
    for (let d = 0; d <= 2; d += 0.1) {
      const w = sculptFalloff(d, 2);
      expect(w).toBeLessThanOrEqual(prev + 1e-9);
      prev = w;
    }
  });
  it('degenerate radius: only the exact center weighs', () => {
    expect(sculptFalloff(0, 0)).toBe(1);
    expect(sculptFalloff(0.1, 0)).toBe(0);
  });
});

describe('vertexNormals', () => {
  it('averages incident face normals — grid center points +Y', () => {
    const { mesh, center } = grid();
    const n = vertexNormals(mesh, [center]).get(center)!;
    expect(n.equalsApprox(new Vec3(0, 1, 0), 1e-6)).toBe(true);
  });
});

describe('inflate brush', () => {
  it('pushes the grid center vert outward along its own (+Y) normal', () => {
    const { mesh, center } = grid();
    const weights = brushWeights(mesh, new Vec3(0, 0, 0), 0.9);
    const deltas = inflateDeltas(mesh, weights, 0.5, false);
    const d = deltas.get(center)!;
    expect(d.y).toBeGreaterThan(0);
    expect(Math.abs(d.x)).toBeLessThan(1e-9);
    expect(Math.abs(d.z)).toBeLessThan(1e-9);
    // Center is at falloff weight 1 → full strength.
    expect(d.y).toBeCloseTo(0.5, 6);
  });

  it('only affects verts within the radius; center weighs most', () => {
    const { mesh, center, corners } = grid();
    const weights = brushWeights(mesh, new Vec3(0, 0, 0), 0.9);
    expect(weights.get(center)).toBeCloseTo(1, 6);
    // Corners are at distance sqrt(2) ≈ 1.414 > 0.9 → out of radius, untouched.
    for (const c of corners) expect(weights.has(c)).toBe(false);
    const deltas = inflateDeltas(mesh, weights, 0.5, false);
    for (const c of corners) expect(deltas.has(c)).toBe(false);
  });

  it('Ctrl inverts (deflate) — displacement flips sign', () => {
    const { mesh, center } = grid();
    const weights = brushWeights(mesh, new Vec3(0, 0, 0), 0.9);
    const up = inflateDeltas(mesh, weights, 0.5, false).get(center)!;
    const down = inflateDeltas(mesh, weights, 0.5, true).get(center)!;
    expect(down.y).toBeCloseTo(-up.y, 6);
  });
});

describe('grab brush', () => {
  it('moves captured verts by delta × falloff, leaves out-of-radius verts alone', () => {
    const { mesh, center, corners } = grid();
    // Radius 1.2: center (d=0) + the 4 edge-midpoint verts (d=1) are captured;
    // the 4 corners (d=√2≈1.414) fall outside and are left alone.
    const weights = brushWeights(mesh, new Vec3(0, 0, 0), 1.2);
    const starts = new Map<number, Vec3>();
    for (const id of mesh.verts.keys()) starts.set(id, mesh.verts.get(id)!.co);
    const delta = new Vec3(2, 0, 0);
    const moved = grabPositions(starts, weights, delta);

    // Center (weight 1) moves the full delta.
    expect(moved.get(center)!.equalsApprox(new Vec3(2, 0, 0), 1e-6)).toBe(true);
    // Corners were never captured → not in the result map, positions unchanged.
    for (const c of corners) {
      expect(moved.has(c)).toBe(false);
      expect(mesh.verts.get(c)!.co.equalsApprox(starts.get(c)!, 1e-9)).toBe(true);
    }
    // An in-radius, non-center vert moves by delta × its (partial) falloff weight.
    const inside = [...weights].find(([id]) => id !== center)!;
    const [id, w] = inside;
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    expect(moved.get(id)!.equalsApprox(starts.get(id)!.add(delta.scale(w)), 1e-6)).toBe(true);
  });
});

describe('raycastMeshLocal', () => {
  it('hits the flat grid from above and returns the surface point', () => {
    const { mesh } = grid();
    const hit = raycastMeshLocal(mesh, new Vec3(0.2, 5, -0.3), new Vec3(0, -1, 0));
    expect(hit).not.toBeNull();
    expect(hit!.point.equalsApprox(new Vec3(0.2, 0, -0.3), 1e-6)).toBe(true);
  });
  it('misses when the ray points away from the mesh', () => {
    const { mesh } = grid();
    expect(raycastMeshLocal(mesh, new Vec3(0, 5, 0), new Vec3(0, 1, 0))).toBeNull();
  });
});

describe('buildBrushCircle', () => {
  it('emits a closed loop of segment endpoints at the given radius', () => {
    const buf = buildBrushCircle(new Vec3(0, 0, 0), 2, new Vec3(0, 1, 0), 16);
    expect(buf.length).toBe(16 * 6);
    // Every emitted point lies on the circle of the given radius about center.
    for (let i = 0; i < buf.length; i += 3) {
      const r = Math.hypot(buf[i], buf[i + 1], buf[i + 2]);
      expect(r).toBeCloseTo(2, 5);
    }
  });
});
