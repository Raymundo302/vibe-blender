import { EditableMesh } from '../EditableMesh';

/** Result of a region extrude — the vert remap and the (unchanged-id) cap faces. */
export interface ExtrudeResult {
  /** Original vert id → its freshly duplicated cap vert id. */
  readonly newVertByOld: Map<number, number>;
  /** Ids of the cap faces (same ids as the input faces — remapped in place). */
  readonly capFaceIds: number[];
}

/**
 * Region extrude (Blender's E on a face selection): lift the selected faces off
 * the mesh as a connected cap, walled by side quads along the region boundary.
 *
 * The selected faces are treated as ONE region — an edge shared by two selected
 * faces is interior and gets no side quad, so the extrusion stays watertight.
 * The caller then translates the cap verts (see `tools/extrude.ts`).
 */
export function extrudeFaces(mesh: EditableMesh, faceIds: Set<number>): ExtrudeResult {
  const faces = [...faceIds].filter((id) => mesh.faces.has(id));

  // 1. Duplicate every vert used by a selected face, at the same coordinate.
  const newVertByOld = new Map<number, number>();
  for (const fid of faces) {
    for (const v of mesh.faces.get(fid)!.verts) {
      if (!newVertByOld.has(v)) newVertByOld.set(v, mesh.addVert(mesh.verts.get(v)!.co));
    }
  }

  // 2. Boundary edges = edges used by exactly ONE selected face. Count selected
  //    faces per undirected edge, then add a side quad for each directed boundary
  //    edge (a, b) as its owning face traverses it. Winding [a, b, b', a'] keeps
  //    the wall facing outward once the cap slides along the outward normal.
  const selCount = new Map<string, number>();
  for (const fid of faces) {
    const f = mesh.faces.get(fid)!;
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const key = EditableMesh.edgeKey(f.verts[i], f.verts[(i + 1) % n]);
      selCount.set(key, (selCount.get(key) ?? 0) + 1);
    }
  }
  for (const fid of faces) {
    const f = mesh.faces.get(fid)!;
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % n];
      if (selCount.get(EditableMesh.edgeKey(a, b)) === 1) {
        mesh.addFace([a, b, newVertByOld.get(b)!, newVertByOld.get(a)!]);
      }
    }
  }

  // 3. Remap each selected face's corners to the duplicated verts — these become
  //    the caps (same face ids, so the selection carries over cleanly).
  for (const fid of faces) {
    const f = mesh.faces.get(fid)!;
    f.verts = f.verts.map((v) => newVertByOld.get(v)!);
  }

  // 4. Delete original verts that no interior/side face references anymore
  //    (region interior verts). Boundary verts survive on their side quads.
  const orphans: number[] = [];
  for (const oldId of newVertByOld.keys()) {
    if (mesh.facesOfVert(oldId).length === 0) orphans.push(oldId);
  }
  mesh.deleteVerts(orphans);

  return { newVertByOld, capFaceIds: faces };
}
