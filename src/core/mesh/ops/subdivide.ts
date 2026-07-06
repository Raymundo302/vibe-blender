import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Subdivide selected faces (Blender's Subdivide, 1 cut):
 *  - each quad → 4 quads via edge midpoints + a center vert;
 *  - each triangle → 4 triangles via edge midpoints (no center vert).
 *
 * Each edge's midpoint vert is computed ONCE (keyed by edge key) so two selected
 * faces sharing an edge share the midpoint — no duplicate verts along the seam.
 *
 * ## T-junction policy (documented, same as loop cut)
 * A selected face adjacent to an UNSELECTED face still splits its shared edge,
 * but the unselected neighbour keeps the original (un-split) edge. This leaves a
 * T-junction on that seam — matching P2-7 loop cut's policy of only editing the
 * selected region. Subdivide a closed region (or the whole mesh) to avoid it.
 *
 * Winding is preserved: every child face is emitted in the parent's orientation.
 */

export interface SubdivideResult {
  /** Midpoint + center verts created. */
  newVertIds: number[];
  /** Ids of the child faces (the originals are deleted). */
  newFaceIds: number[];
}

export function subdivideFaces(mesh: EditableMesh, faceIds: Iterable<number>): SubdivideResult {
  const faces = [...new Set(faceIds)].filter((id) => mesh.faces.has(id));

  // 1. One midpoint per distinct edge across the whole selection.
  const midByEdge = new Map<string, number>();
  const edgeMid = (a: number, b: number): number => {
    const key = EditableMesh.edgeKey(a, b);
    let m = midByEdge.get(key);
    if (m === undefined) {
      const pa = mesh.verts.get(a)!.co;
      const pb = mesh.verts.get(b)!.co;
      m = mesh.addVert(pa.lerp(pb, 0.5));
      midByEdge.set(key, m);
    }
    return m;
  };

  const newVertIds: number[] = [];
  const newFaceIds: number[] = [];

  for (const fid of faces) {
    const verts = mesh.faces.get(fid)!.verts;

    if (verts.length === 4) {
      const [v0, v1, v2, v3] = verts;
      const m01 = edgeMid(v0, v1);
      const m12 = edgeMid(v1, v2);
      const m23 = edgeMid(v2, v3);
      const m30 = edgeMid(v3, v0);
      let c = Vec3.ZERO;
      for (const vid of verts) c = c.add(mesh.verts.get(vid)!.co);
      const center = mesh.addVert(c.scale(0.25));
      newVertIds.push(center);
      // Four corner quads, each keeping the parent winding v0→v1→v2→v3.
      newFaceIds.push(
        mesh.addFace([v0, m01, center, m30]),
        mesh.addFace([m01, v1, m12, center]),
        mesh.addFace([center, m12, v2, m23]),
        mesh.addFace([m30, center, m23, v3]),
      );
    } else if (verts.length === 3) {
      const [v0, v1, v2] = verts;
      const m01 = edgeMid(v0, v1);
      const m12 = edgeMid(v1, v2);
      const m20 = edgeMid(v2, v0);
      // Three corner tris + the center tri, all in parent winding order.
      newFaceIds.push(
        mesh.addFace([v0, m01, m20]),
        mesh.addFace([m01, v1, m12]),
        mesh.addFace([m20, m12, v2]),
        mesh.addFace([m01, m12, m20]),
      );
    } else {
      // n-gons (n > 4) are not subdivided in v1: fan them via a center vert into
      // triangles-of-midpoints would change the look; skip and keep the original.
      continue;
    }
  }

  newVertIds.unshift(...midByEdge.values());
  // Delete the originals only for faces we actually split (quads/tris).
  const splittable = faces.filter((fid) => {
    const n = mesh.faces.get(fid)?.verts.length ?? 0;
    return n === 3 || n === 4;
  });
  mesh.deleteFaces(splittable);

  return { newVertIds, newFaceIds };
}
