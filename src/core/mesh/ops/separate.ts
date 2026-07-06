import { EditableMesh } from '../EditableMesh';

/**
 * Split a set of faces out of `mesh` into a fresh EditableMesh (Blender's
 * Separate → Selection). PURE with respect to `mesh` — it never mutates the
 * input; the caller applies the returned deletions to the source.
 *
 * Semantics (matches Blender):
 * - Every vert used by a selected face is COPIED into the new mesh. Verts on the
 *   seam (also used by an unselected face) stay in the source too — the seam
 *   duplicates. Verts used ONLY by selected faces are reported in
 *   `orphanVertIds` so the caller can drop them from the source.
 * - The new mesh's vert ids restart from 0 (fresh addVert/addFace). Within the
 *   new shell each old vert maps to exactly one new vert, so faces that shared an
 *   edge in the source still share it here (the seam stays manifold).
 *
 * Deterministic: faces are walked in ascending id order and each face's verts in
 * their stored order, so the new ids and insertion order depend only on inputs.
 */
export interface SeparateResult {
  /** The extracted geometry as a standalone mesh (vert ids restart at 0). */
  removed: EditableMesh;
  /**
   * Source vert ids used ONLY by the separated faces. The caller deletes these
   * from the source (the selected faces themselves are deleted separately).
   */
  orphanVertIds: number[];
}

export function extractFaces(mesh: EditableMesh, faceIds: Iterable<number>): SeparateResult {
  const selected = [...new Set(faceIds)]
    .filter((id) => mesh.faces.has(id))
    .sort((a, b) => a - b);

  const removed = new EditableMesh();
  const vertMap = new Map<number, number>(); // source vert id → new vert id

  for (const fid of selected) {
    const face = mesh.faces.get(fid)!;
    for (const old of face.verts) {
      if (!vertMap.has(old)) vertMap.set(old, removed.addVert(mesh.verts.get(old)!.co));
    }
    removed.addFace(face.verts.map((old) => vertMap.get(old)!));
  }

  // A source vert is orphaned when no UNSELECTED face still uses it.
  const selectedSet = new Set(selected);
  const keptVerts = new Set<number>();
  for (const f of mesh.faces.values()) {
    if (selectedSet.has(f.id)) continue;
    for (const v of f.verts) keptVerts.add(v);
  }
  const orphanVertIds = [...vertMap.keys()]
    .filter((old) => !keptVerts.has(old))
    .sort((a, b) => a - b);

  return { removed, orphanVertIds };
}
