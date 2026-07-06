import { EditableMesh } from '../EditableMesh';

/**
 * Duplicate selected faces INSIDE the same mesh (Blender's edit-mode Shift+D).
 *
 * Every vert used by the selected faces is copied ONCE — even verts shared by
 * two selected faces get a single shared copy, so the duplicated region stays a
 * seam-free island (its own faces stitch to each other) yet shares NO vert with
 * the original shell. New faces reuse the parent winding order.
 *
 * Pure: the only mutation is appending new verts + faces to `mesh`. Deterministic
 * — verts are created in first-encountered order across the given faces, then the
 * new faces in the given order.
 */

export interface DuplicateFacesResult {
  /** Ids of the duplicated verts (creation order). */
  newVertIds: number[];
  /** Ids of the duplicated faces (parallel to the input face order). */
  newFaceIds: number[];
  /** Original vert id → its duplicate's id (only for verts in the selection). */
  vertMap: Map<number, number>;
}

export function duplicateFaces(mesh: EditableMesh, faceIds: Iterable<number>): DuplicateFacesResult {
  const faces = [...new Set(faceIds)].filter((id) => mesh.faces.has(id));

  // One copied vert per distinct original vert across the whole selection, so
  // two selected faces sharing an edge share that edge's copies with EACH OTHER.
  const vertMap = new Map<number, number>();
  const newVertIds: number[] = [];
  for (const fid of faces) {
    for (const v of mesh.faces.get(fid)!.verts) {
      if (!vertMap.has(v)) {
        // Vec3 is immutable, so sharing the coordinate reference is safe.
        const nid = mesh.addVert(mesh.verts.get(v)!.co);
        vertMap.set(v, nid);
        newVertIds.push(nid);
      }
    }
  }

  const newFaceIds: number[] = [];
  for (const fid of faces) {
    const verts = mesh.faces.get(fid)!.verts.map((v) => vertMap.get(v)!);
    newFaceIds.push(mesh.addFace(verts));
  }

  return { newVertIds, newFaceIds, vertMap };
}
