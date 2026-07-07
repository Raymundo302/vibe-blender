import { Vec3 } from '../../math/vec3';
import { EditableMesh } from '../EditableMesh';

/**
 * Recalculate face normals (Shift+N) — make winding consistent across each
 * connected island, then orient the island outward. Pure mutation on the mesh
 * (reverses face vert order in place); wrap it in MeshEditCommand.capture for
 * undo. Operates on the given face set (Blender recalculates the selection).
 *
 * Two stages, per island:
 *  1. Consistency: BFS from the largest-area face. When a neighbor shares an
 *     edge traversed in the SAME direction as the already-oriented current face,
 *     the two disagree, so the neighbor is flipped.
 *  2. Outward: the island's signed volume about its own centroid. Negative means
 *     the (now consistent) normals point inward, so flip the whole island.
 */

/** Twice the Newell area vector's length → polygon area. */
function faceArea(mesh: EditableMesh, faceId: number): number {
  const vs = mesh.faces.get(faceId)!.verts;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = mesh.verts.get(vs[i])!.co;
    const b = mesh.verts.get(vs[(i + 1) % vs.length])!.co;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

/** True if `faceId` winds through the directed edge a→b. */
function hasDirectedEdge(mesh: EditableMesh, faceId: number, a: number, b: number): boolean {
  const vs = mesh.faces.get(faceId)!.verts;
  for (let i = 0; i < vs.length; i++) {
    if (vs[i] === a && vs[(i + 1) % vs.length] === b) return true;
  }
  return false;
}

/** Signed volume of a face fan about origin-shifted point C (×6). */
function faceSignedVolume6(mesh: EditableMesh, faceId: number, c: Vec3): number {
  const vs = mesh.faces.get(faceId)!.verts;
  const p0 = mesh.verts.get(vs[0])!.co.sub(c);
  let vol = 0;
  for (let i = 1; i < vs.length - 1; i++) {
    const pi = mesh.verts.get(vs[i])!.co.sub(c);
    const pj = mesh.verts.get(vs[i + 1])!.co.sub(c);
    vol += p0.cross(pi).dot(pj);
  }
  return vol;
}

/**
 * Make the winding of `faceIds` consistent per island and orient each outward.
 * Returns the number of faces whose winding was flipped.
 */
export function recalcNormals(mesh: EditableMesh, faceIds: Iterable<number>): number {
  const domain = [...new Set(faceIds)].filter((id) => mesh.faces.has(id));
  if (domain.length === 0) return 0;
  const domainSet = new Set(domain);

  // edgeKey → the domain faces sharing it (adjacency for the flood fill).
  const edgeFaces = new Map<string, number[]>();
  for (const fid of domain) {
    const vs = mesh.faces.get(fid)!.verts;
    for (let i = 0; i < vs.length; i++) {
      const k = EditableMesh.edgeKey(vs[i], vs[(i + 1) % vs.length]);
      const list = edgeFaces.get(k) ?? [];
      list.push(fid);
      edgeFaces.set(k, list);
    }
  }

  const flip = (fid: number): void => { mesh.faces.get(fid)!.verts.reverse(); };
  const visited = new Set<number>();
  let flipped = 0;

  while (visited.size < domain.length) {
    // Seed each island with its largest-area unvisited face (a stable, robust
    // reference orientation).
    let seed = -1;
    let bestArea = -1;
    for (const fid of domain) {
      if (visited.has(fid)) continue;
      const a = faceArea(mesh, fid);
      if (a > bestArea) { bestArea = a; seed = fid; }
    }

    const island: number[] = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      island.push(cur);
      const vs = mesh.faces.get(cur)!.verts;
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i];
        const b = vs[(i + 1) % vs.length];
        const k = EditableMesh.edgeKey(a, b);
        for (const nb of edgeFaces.get(k) ?? []) {
          if (nb === cur || !domainSet.has(nb) || visited.has(nb)) continue;
          // `cur` (oriented) uses directed edge a→b. A consistent neighbor uses
          // b→a; if it also uses a→b the two disagree, so flip it.
          if (hasDirectedEdge(mesh, nb, a, b)) { flip(nb); flipped++; }
          visited.add(nb);
          queue.push(nb);
        }
      }
    }

    // Orient the island outward: centroid of its verts, then signed volume.
    const vids = new Set<number>();
    for (const fid of island) for (const v of mesh.faces.get(fid)!.verts) vids.add(v);
    let c = Vec3.ZERO;
    for (const v of vids) c = c.add(mesh.verts.get(v)!.co);
    c = c.scale(1 / Math.max(1, vids.size));
    let vol = 0;
    for (const fid of island) vol += faceSignedVolume6(mesh, fid, c);
    if (vol < 0) { for (const fid of island) { flip(fid); flipped++; } }
  }

  // Reversing face.verts in place doesn't route through a version-bumping mesh
  // method, so nudge the version (self-assign one vert's coord) to invalidate
  // the GPU/eval caches keyed on it. No geometry changes.
  if (flipped > 0) {
    const first = mesh.verts.values().next().value;
    if (first) mesh.setVertCo(first.id, first.co);
  }
  return flipped;
}
