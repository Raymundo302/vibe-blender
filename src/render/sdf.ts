import type { EditableMesh } from '../core/mesh/EditableMesh';

/**
 * CPU voxel signed-distance-field builder for the Object AO mode (Ray's
 * AO-Prototype technique: AO marched against a world-space distance field of
 * the scene instead of the screen-space depth buffer).
 *
 * Each object gets one SDF built in its LOCAL space from the evaluated mesh —
 * moving / rotating / (uniformly) scaling the object never rebuilds, only mesh
 * or modifier edits do. Build strategy:
 *
 *   1. narrow band — exact point-to-triangle distances for every voxel within
 *      2 cells of a triangle (per-triangle voxel-AABB rasterization),
 *   2. chamfer sweep — two-pass 26-neighbour distance transform propagates
 *      approximate distances to the rest of the grid (fine for AO: only the
 *      near band drives contact shadows),
 *   3. sign — flood fill from the grid border through voxels not blocked by
 *      the surface; unreached voxels are inside and get negated. Open meshes
 *      (a floor plane) simply stay all-positive: distance-to-surface still
 *      occludes correctly from both sides.
 *
 * Distances are encoded to R8: byte = (d / R) * 0.5 + 0.5 with R = maxDist,
 * so 0.5 is the surface. The grid's data points sit ON the padded box corners
 * (point k at boxMin + k * boxSize/(res-1)) matching the shader's
 * voxel-center sampling of uvw in [0,1].
 */

export const SDF_RES = 48;

export interface MeshSdf {
  /** res³ bytes, x fastest then y then z (texImage3D order). */
  data: Uint8Array;
  boxMin: [number, number, number];
  /** Padded box extent per axis (local units). */
  boxSize: [number, number, number];
  /** Encoding half-range R: byte 0 ↔ -R, byte 255 ↔ +R (local units). */
  maxDist: number;
}

/** Exact squared distance from point p to triangle (a, b, c) — Ericson 5.1.5. */
function triDistSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const denom = d1 - d3;
    const v = denom > 0 ? d1 / denom : 0;
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const denom = d2 - d6;
    const w = denom > 0 ? d2 / denom : 0;
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const denom = (d4 - d3) + (d5 - d6);
    const w = denom > 0 ? (d4 - d3) / denom : 0;
    const dx = bpx + w * (cx - bx), dy = bpy + w * (cy - by), dz = bpz + w * (cz - bz);
    return dx * dx + dy * dy + dz * dz;
  }

  // Inside the face region: distance to the plane.
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const nn = nx * nx + ny * ny + nz * nz;
  if (nn < 1e-24) {
    // Degenerate sliver: fall back to the closest edge point already excluded
    // above — nearest vertex distance is a safe upper bound.
    return Math.min(
      apx * apx + apy * apy + apz * apz,
      bpx * bpx + bpy * bpy + bpz * bpz,
      cpx * cpx + cpy * cpy + cpz * cpz,
    );
  }
  const dist = (apx * nx + apy * ny + apz * nz);
  return (dist * dist) / nn;
}

/** Build the local-space SDF for a mesh. Returns null for meshes with no faces. */
export function buildMeshSdf(mesh: EditableMesh, res = SDF_RES): MeshSdf | null {
  // Fan-triangulate the polygon faces into a flat soup.
  const tris: number[] = [];
  for (const face of mesh.faces.values()) {
    const vs = face.verts;
    const a = mesh.verts.get(vs[0])!.co;
    for (let i = 1; i + 1 < vs.length; i++) {
      const b = mesh.verts.get(vs[i])!.co;
      const c = mesh.verts.get(vs[i + 1])!.co;
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  if (tris.length === 0) return null;

  // Sparse-geometry guard: an object whose triangles cover almost none of its
  // bounding box (the Scatter modifier's sprinkle cloud: dozens of sub-voxel
  // islands across the whole donut) cannot be represented at this grid
  // resolution — its "field" is a box of noisy near-zero distances that
  // blackens the object and splatters phantom occlusion far outside it.
  // Engines exclude such objects from distance-field AO (they still RECEIVE
  // AO; they just don't cast it). Solid and thin-but-continuous meshes
  // (planes, plates, tubes) score far above the threshold.
  let triArea = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    triArea += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }

  // Padded local AABB. Padding keeps the border voxels safely outside the
  // surface (they seed the outside flood fill AND read positive at the box
  // boundary so the shader's clamp-and-add-outside-distance estimate is sane).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
    if (tris[i + 2] < minZ) minZ = tris[i + 2];
    if (tris[i + 2] > maxZ) maxZ = tris[i + 2];
  }
  {
    const bx = Math.max(maxX - minX, 1e-6), by = Math.max(maxY - minY, 1e-6), bz = Math.max(maxZ - minZ, 1e-6);
    const boxArea = 2 * (bx * by + by * bz + bz * bx);
    if (triArea / boxArea < 0.05) return null;   // sparse cloud → not an occluder
  }

  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
  const pad = ext * 0.51 * (4 / (res - 1)) + 1e-4;   // ~2 cells of the final grid
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  const cx = sx / (res - 1), cy = sy / (res - 1), cz = sz / (res - 1);
  const cellMax = Math.max(cx, cy, cz);
  const n = res * res * res;

  const dist = new Float32Array(n).fill(Infinity);
  const blocked = new Uint8Array(n);   // voxel within ~half a cell of the surface
  const idx = (i: number, j: number, k: number) => i + res * (j + res * k);

  // 1. Narrow band: exact distances within BAND cells of each triangle.
  const BAND = 2;
  const blockR2 = (0.75 * cellMax) * (0.75 * cellMax);
  for (let t = 0; t < tris.length; t += 9) {
    const tMinX = Math.min(tris[t], tris[t + 3], tris[t + 6]);
    const tMaxX = Math.max(tris[t], tris[t + 3], tris[t + 6]);
    const tMinY = Math.min(tris[t + 1], tris[t + 4], tris[t + 7]);
    const tMaxY = Math.max(tris[t + 1], tris[t + 4], tris[t + 7]);
    const tMinZ = Math.min(tris[t + 2], tris[t + 5], tris[t + 8]);
    const tMaxZ = Math.max(tris[t + 2], tris[t + 5], tris[t + 8]);
    const i0 = Math.max(0, Math.floor((tMinX - minX) / cx) - BAND);
    const i1 = Math.min(res - 1, Math.ceil((tMaxX - minX) / cx) + BAND);
    const j0 = Math.max(0, Math.floor((tMinY - minY) / cy) - BAND);
    const j1 = Math.min(res - 1, Math.ceil((tMaxY - minY) / cy) + BAND);
    const k0 = Math.max(0, Math.floor((tMinZ - minZ) / cz) - BAND);
    const k1 = Math.min(res - 1, Math.ceil((tMaxZ - minZ) / cz) + BAND);
    for (let k = k0; k <= k1; k++) {
      const pz = minZ + k * cz;
      for (let j = j0; j <= j1; j++) {
        const py = minY + j * cy;
        for (let i = i0; i <= i1; i++) {
          const px = minX + i * cx;
          const d2 = triDistSq(px, py, pz,
            tris[t], tris[t + 1], tris[t + 2],
            tris[t + 3], tris[t + 4], tris[t + 5],
            tris[t + 6], tris[t + 7], tris[t + 8]);
          const id = idx(i, j, k);
          if (d2 < dist[id] * dist[id]) dist[id] = Math.sqrt(d2);
          if (d2 < blockR2) blocked[id] = 1;
        }
      }
    }
  }

  // 2. Chamfer sweep: propagate approximate distances outward (26-neighbour,
  // anisotropic weights). Forward then backward pass.
  const offs: [number, number, number, number][] = [];
  for (let dk = -1; dk <= 1; dk++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0 && dk === 0) continue;
        offs.push([di, dj, dk, Math.hypot(di * cx, dj * cy, dk * cz)]);
      }
    }
  }
  const fwd = offs.filter(([di, dj, dk]) => dk < 0 || (dk === 0 && (dj < 0 || (dj === 0 && di < 0))));
  const bwd = offs.filter((o) => !fwd.includes(o));
  const sweep = (list: typeof offs, reverse: boolean) => {
    const start = reverse ? res - 1 : 0;
    const end = reverse ? -1 : res;
    const step = reverse ? -1 : 1;
    for (let k = start; k !== end; k += step) {
      for (let j = start; j !== end; j += step) {
        for (let i = start; i !== end; i += step) {
          const id = idx(i, j, k);
          let d = dist[id];
          for (const [di, dj, dk, w] of list) {
            const ii = i + di, jj = j + dj, kk = k + dk;
            if (ii < 0 || jj < 0 || kk < 0 || ii >= res || jj >= res || kk >= res) continue;
            const nd = dist[idx(ii, jj, kk)] + w;
            if (nd < d) d = nd;
          }
          dist[id] = d;
        }
      }
    }
  };
  sweep(fwd, false);
  sweep(bwd, true);

  // 3. Sign via outside flood fill (6-connected through unblocked voxels).
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0, qTail = 0;
  const push = (id: number) => { outside[id] = 1; queue[qTail++] = id; };
  for (let k = 0; k < res; k++) {
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        if ((i === 0 || j === 0 || k === 0 || i === res - 1 || j === res - 1 || k === res - 1)) {
          const id = idx(i, j, k);
          if (!blocked[id] && !outside[id]) push(id);
        }
      }
    }
  }
  const rr = res * res;
  while (qHead < qTail) {
    const id = queue[qHead++];
    const i = id % res, j = ((id / res) | 0) % res, k = (id / rr) | 0;
    if (i > 0 && !blocked[id - 1] && !outside[id - 1]) push(id - 1);
    if (i < res - 1 && !blocked[id + 1] && !outside[id + 1]) push(id + 1);
    if (j > 0 && !blocked[id - res] && !outside[id - res]) push(id - res);
    if (j < res - 1 && !blocked[id + res] && !outside[id + res]) push(id + res);
    if (k > 0 && !blocked[id - rr] && !outside[id - rr]) push(id - rr);
    if (k < res - 1 && !blocked[id + rr] && !outside[id + rr]) push(id + rr);
  }

  // Encode. R covers half the box diagonal — plenty of range for AO reach,
  // and 2R/255 quantization stays far below contact-shadow scale.
  const maxDist = 0.5 * Math.hypot(sx, sy, sz);
  const data = new Uint8Array(n);
  for (let id = 0; id < n; id++) {
    let d = dist[id];
    if (!outside[id] && !blocked[id]) d = -d;   // enclosed → inside
    const enc = (d / maxDist) * 0.5 + 0.5;
    data[id] = Math.max(0, Math.min(255, Math.round(enc * 255)));
  }

  return {
    data,
    boxMin: [minX, minY, minZ],
    boxSize: [sx, sy, sz],
    maxDist,
  };
}
