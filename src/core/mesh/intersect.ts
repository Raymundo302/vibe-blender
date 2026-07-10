/**
 * Mesh–mesh intersection curves: where two triangle soups pass through each
 * other. Pure geometry — no GL, no DOM, unit-testable. The viewport draws the
 * returned segments as light grey lines so you can see geometry passing through
 * geometry (a plane scaled through a cube, etc.).
 *
 * Triangle–triangle test is Möller '97's interval method: reject early with the
 * signed distances to each other's plane, then overlap the two triangles'
 * intervals along the intersection line D = nA × nB. Coplanar pairs (|D| ~ 0)
 * are skipped — there is no single stable curve to draw for two faces lying in
 * the same plane.
 */

// Scratch Vec3-likes are plain [x,y,z] tuples to stay allocation-light in the
// per-triangle inner loop (meshIntersectionSegments runs this on every
// AABB-overlapping pair).
type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }

/** Read one triangle's 3 verts (9 floats) from a flat array at `off`. */
function readTri(src: Float32Array | number[], off: number): [V3, V3, V3] {
  return [
    [src[off], src[off + 1], src[off + 2]],
    [src[off + 3], src[off + 4], src[off + 5]],
    [src[off + 6], src[off + 7], src[off + 8]],
  ];
}

/**
 * Segment where a triangle crosses a plane, given its three verts and their
 * signed distances (already epsilon-snapped: exact-zero = on the plane).
 * Returns the two crossing points, or null if the triangle only touches the
 * plane at a single point / not at all (no drawable segment for this triangle).
 */
function triPlaneSegment(
  v0: V3, v1: V3, v2: V3, d0: number, d1: number, d2: number,
): [V3, V3] | null {
  const pts: V3[] = [];
  const edges: [V3, V3, number, number][] = [
    [v0, v1, d0, d1],
    [v1, v2, d1, d2],
    [v2, v0, d2, d0],
  ];
  for (const [va, vb, da, db] of edges) {
    // Strict sign change → the edge crosses the plane between its endpoints.
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da / (da - db);
      pts.push([
        va[0] + (vb[0] - va[0]) * t,
        va[1] + (vb[1] - va[1]) * t,
        va[2] + (vb[2] - va[2]) * t,
      ]);
    }
  }
  // Verts lying exactly on the plane are crossing points too (vertex-touch,
  // or a whole edge flush on the plane → both its verts land here).
  if (d0 === 0) pts.push(v0);
  if (d1 === 0) pts.push(v1);
  if (d2 === 0) pts.push(v2);

  // Dedupe coincident points (a zero vertex can appear via two incident edges).
  const uniq: V3[] = [];
  for (const p of pts) {
    if (!uniq.some((q) => Math.abs(q[0] - p[0]) < 1e-12
      && Math.abs(q[1] - p[1]) < 1e-12 && Math.abs(q[2] - p[2]) < 1e-12)) {
      uniq.push(p);
    }
  }
  if (uniq.length < 2) return null;
  if (uniq.length === 2) return [uniq[0], uniq[1]];
  // Degenerate over-collection: return the farthest-apart pair.
  let bi = 0, bj = 1, best = -1;
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const dsq = len(sub(uniq[i], uniq[j]));
      if (dsq > best) { best = dsq; bi = i; bj = j; }
    }
  }
  return [uniq[bi], uniq[bj]];
}

/**
 * Intersection segment of two triangles (flat arrays of 9 floats each, at the
 * given offsets), or false. Writes [x1,y1,z1,x2,y2,z2] into `out` and returns
 * true when a segment exists. Coplanar pairs return false (no stable curve).
 */
export function triTriIntersection(
  a: Float32Array | number[], aOff: number,
  b: Float32Array | number[], bOff: number,
  out: number[],
): boolean {
  const [a0, a1, a2] = readTri(a, aOff);
  const [b0, b1, b2] = readTri(b, bOff);

  const nB = cross(sub(b1, b0), sub(b2, b0));
  const nA = cross(sub(a1, a0), sub(a2, a0));
  const nAlen = len(nA);
  const nBlen = len(nB);
  // Degenerate (zero-area) triangle: no well-defined plane.
  if (nAlen < 1e-20 || nBlen < 1e-20) return false;

  // Characteristic scale for the epsilon: largest coordinate magnitude across
  // both triangles (min 1). Distances are compared as true geometric distance
  // (signed distance / |n|), so the snap epsilon is a length.
  let scale = 1;
  for (const v of [a0, a1, a2, b0, b1, b2]) {
    scale = Math.max(scale, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  }
  const eps = 1e-9 * scale;

  // Signed distances of A's verts to B's plane (geometric, then snapped).
  const snap = (d: number): number => (Math.abs(d) < eps ? 0 : d);
  const da0 = snap(dot(nB, sub(a0, b0)) / nBlen);
  const da1 = snap(dot(nB, sub(a1, b0)) / nBlen);
  const da2 = snap(dot(nB, sub(a2, b0)) / nBlen);
  // All strictly on the same side → A is entirely off B's plane.
  if ((da0 > 0 && da1 > 0 && da2 > 0) || (da0 < 0 && da1 < 0 && da2 < 0)) return false;

  const db0 = snap(dot(nA, sub(b0, a0)) / nAlen);
  const db1 = snap(dot(nA, sub(b1, a0)) / nAlen);
  const db2 = snap(dot(nA, sub(b2, a0)) / nAlen);
  if ((db0 > 0 && db1 > 0 && db2 > 0) || (db0 < 0 && db1 < 0 && db2 < 0)) return false;

  // Intersection-line direction. Near-zero → the planes are (anti)parallel:
  // coplanar or parallel-disjoint (the distance tests above already caught the
  // disjoint case), so bail — no single curve to draw.
  const D = cross(nA, nB);
  if (len(D) <= 1e-9 * nAlen * nBlen) return false;

  const segA = triPlaneSegment(a0, a1, a2, da0, da1, da2);
  const segB = triPlaneSegment(b0, b1, b2, db0, db1, db2);
  if (!segA || !segB) return false;

  // Both segments lie on the intersection line; parametrize each by t = P·D.
  const ta0 = dot(segA[0], D), ta1 = dot(segA[1], D);
  const tb0 = dot(segB[0], D), tb1 = dot(segB[1], D);
  const aMin = Math.min(ta0, ta1), aMax = Math.max(ta0, ta1);
  const bMin = Math.min(tb0, tb1), bMax = Math.max(tb0, tb1);
  const lo = Math.max(aMin, bMin);
  const hi = Math.min(aMax, bMax);
  if (lo > hi) return false; // intervals do not overlap

  // Map an overlap param back to 3D via segA's own parametrization.
  const span = ta1 - ta0;
  const pointAt = (t: number): V3 => {
    const f = Math.abs(span) < 1e-30 ? 0 : (t - ta0) / span;
    return [
      segA[0][0] + (segA[1][0] - segA[0][0]) * f,
      segA[0][1] + (segA[1][1] - segA[0][1]) * f,
      segA[0][2] + (segA[1][2] - segA[0][2]) * f,
    ];
  };
  const p0 = pointAt(lo);
  const p1 = pointAt(hi);
  // Reject a degenerate (point-like) overlap.
  if (len(sub(p1, p0)) < 1e-6) return false;

  out[0] = p0[0]; out[1] = p0[1]; out[2] = p0[2];
  out[3] = p1[0]; out[4] = p1[1]; out[5] = p1[2];
  return true;
}

/** Axis-aligned bounds of one triangle (9 floats at `off`). */
function triAabb(src: Float32Array, off: number): { min: V3; max: V3 } {
  const min: V3 = [src[off], src[off + 1], src[off + 2]];
  const max: V3 = [src[off], src[off + 1], src[off + 2]];
  for (let c = 1; c < 3; c++) {
    const o = off + c * 3;
    for (let a = 0; a < 3; a++) {
      const v = src[o + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

function aabbOverlap(aMin: V3, aMax: V3, bMin: V3, bMax: V3): boolean {
  return aMin[0] <= bMax[0] && aMax[0] >= bMin[0]
    && aMin[1] <= bMax[1] && aMax[1] >= bMin[1]
    && aMin[2] <= bMax[2] && aMax[2] >= bMin[2];
}

/**
 * All intersection segments between two world-space triangle soups (Float32Array,
 * xyz per vertex, 9 floats per triangle). Returns a flat Float32Array of segment
 * endpoints (6 floats per segment).
 *
 * Broad phase: a uniform spatial-hash grid over B's triangle AABBs, queried with
 * each of A's triangle AABBs — the narrow triTriIntersection only runs on
 * AABB-overlapping candidate pairs (deduped per query). Early-out when the two
 * soups' overall AABBs are disjoint.
 */
export function meshIntersectionSegments(trisA: Float32Array, trisB: Float32Array): Float32Array {
  const nA = (trisA.length / 9) | 0;
  const nB = (trisB.length / 9) | 0;
  if (nA === 0 || nB === 0) return new Float32Array(0);

  // Overall AABBs + early-out on disjoint soups.
  const soupAabb = (src: Float32Array, n: number): { min: V3; max: V3 } => {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n * 9; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = src[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    return { min, max };
  };
  const bA = soupAabb(trisA, nA);
  const bB = soupAabb(trisB, nB);
  if (!aabbOverlap(bA.min, bA.max, bB.min, bB.max)) return new Float32Array(0);

  // Uniform grid over B's overall bounds. Resolution ~ cbrt(nB) per axis so the
  // average cell holds a handful of triangles; clamped so tiny/huge meshes stay
  // sane. Cell size falls back to the extent when an axis is flat (a plane).
  const dim = Math.max(1, Math.min(64, Math.round(Math.cbrt(nB))));
  const ext: V3 = [
    Math.max(bB.max[0] - bB.min[0], 1e-6),
    Math.max(bB.max[1] - bB.min[1], 1e-6),
    Math.max(bB.max[2] - bB.min[2], 1e-6),
  ];
  const cell: V3 = [ext[0] / dim, ext[1] / dim, ext[2] / dim];
  const clampIdx = (i: number): number => (i < 0 ? 0 : i >= dim ? dim - 1 : i);
  const cellOf = (x: number, axis: number): number =>
    clampIdx(Math.floor((x - bB.min[axis]) / cell[axis]));
  const key = (ix: number, iy: number, iz: number): number => (ix * dim + iy) * dim + iz;

  // Bucket every B triangle into all cells its AABB spans.
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < nB; t++) {
    const { min, max } = triAabb(trisB, t * 9);
    const ix0 = cellOf(min[0], 0), ix1 = cellOf(max[0], 0);
    const iy0 = cellOf(min[1], 1), iy1 = cellOf(max[1], 1);
    const iz0 = cellOf(min[2], 2), iz1 = cellOf(max[2], 2);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = key(ix, iy, iz);
          const list = buckets.get(k);
          if (list) list.push(t); else buckets.set(k, [t]);
        }
      }
    }
  }

  // Per-query dedupe of candidate B triangles via a generation stamp (a B tri
  // can sit in several cells that one A tri's AABB overlaps).
  const seen = new Int32Array(nB).fill(-1);
  const out: number[] = [];
  const seg: number[] = [0, 0, 0, 0, 0, 0];

  for (let ta = 0; ta < nA; ta++) {
    const { min, max } = triAabb(trisA, ta * 9);
    if (!aabbOverlap(min, max, bB.min, bB.max)) continue;
    const ix0 = cellOf(min[0], 0), ix1 = cellOf(max[0], 0);
    const iy0 = cellOf(min[1], 1), iy1 = cellOf(max[1], 1);
    const iz0 = cellOf(min[2], 2), iz1 = cellOf(max[2], 2);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = buckets.get(key(ix, iy, iz));
          if (!list) continue;
          for (const tb of list) {
            if (seen[tb] === ta) continue; // already tested this pair this query
            seen[tb] = ta;
            const bAabb = triAabb(trisB, tb * 9);
            if (!aabbOverlap(min, max, bAabb.min, bAabb.max)) continue;
            if (triTriIntersection(trisA, ta * 9, trisB, tb * 9, seg)) {
              out.push(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5]);
            }
          }
        }
      }
    }
  }

  return new Float32Array(out);
}
