import { Vec3 } from '../../math/vec3';
import { EditableMesh } from '../EditableMesh';

/** Result of an individual-face inset: the new inner faces and their verts. */
export interface InsetResult {
  /** Ids of the freshly created inner faces (one per input face). */
  readonly innerFaceIds: number[];
  /** Inner face id → its inner vert ids (same winding as the original face). */
  readonly innerVertsByFace: Map<number, number[]>;
}

/**
 * Individual-face inset (Blender's I): each selected face gets a smaller copy of
 * itself nested inside, joined to the original boundary by a ring of quads.
 *
 * Topology and geometry are kept separate: the new inner verts are created at the
 * SAME position as their corners here, and the modal operator (`tools/inset.ts`)
 * slides them toward each face's centroid via `co = lerp(cornerCo, centroid, t)`.
 * Faces are inset independently — no shared-edge region logic (unlike extrude).
 */
export function insetFaces(mesh: EditableMesh, faceIds: Set<number>): InsetResult {
  const faces = [...faceIds].filter((id) => mesh.faces.has(id));
  const innerFaceIds: number[] = [];
  const innerVertsByFace = new Map<number, number[]>();

  for (const fid of faces) {
    const oldVerts = [...mesh.faces.get(fid)!.verts];
    const n = oldVerts.length;

    // 1. New vert per corner at the SAME position — the modal phase moves them.
    const newVerts = oldVerts.map((v) => mesh.addVert(mesh.verts.get(v)!.co));

    // 2. Inner face, same winding as the original.
    const innerId = mesh.addFace(newVerts);
    innerFaceIds.push(innerId);
    innerVertsByFace.set(innerId, newVerts);

    // 3. Ring quads: each edge (vi, vi+1) → [vi, vi+1, newVi+1, newVi].
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      mesh.addFace([oldVerts[i], oldVerts[j], newVerts[j], newVerts[i]]);
    }

    // 4. The original face is replaced by the inner face + ring.
    mesh.deleteFaces([fid]);
  }

  return { innerFaceIds, innerVertsByFace };
}

/** Centroid of a face's current vert positions (local space). */
export function faceCentroid(mesh: EditableMesh, faceId: number): Vec3 {
  const f = mesh.faces.get(faceId);
  if (!f) throw new Error(`No face ${faceId}`);
  let c = Vec3.ZERO;
  for (const v of f.verts) c = c.add(mesh.verts.get(v)!.co);
  return c.scale(1 / f.verts.length);
}
