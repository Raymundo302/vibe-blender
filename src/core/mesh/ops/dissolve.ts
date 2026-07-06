import { EditableMesh } from '../EditableMesh';

/**
 * Dissolve edges (P5-1): remove an edge while MERGING the two faces that share
 * it into a single n-gon, instead of deleting the faces and leaving a hole
 * (which is what `deleteEdges` does). This is Blender's "Dissolve Edges".
 *
 * Only manifold interior edges dissolve — an edge with exactly two DISTINCT
 * faces. Boundary edges (1 face) and wire edges (0 faces) are skipped, so a
 * selection of only boundary edges is a no-op.
 *
 * Verts are kept (Blender keeps them; a dissolved edge's endpoints simply sit
 * inside the merged n-gon, which renders fine via fan triangulation).
 */

/** Directed orientation of undirected edge {p,q} as `face` traverses it, or null. */
function directedEdge(face: number[], p: number, q: number): [number, number] | null {
  const n = face.length;
  for (let i = 0; i < n; i++) {
    const a = face[i], b = face[(i + 1) % n];
    if (a === p && b === q) return [p, q];
    if (a === q && b === p) return [q, p];
  }
  return null;
}

/**
 * Merge faces A and B across their shared edge {p,q} into one vert loop,
 * preserving A's winding. Returns null if the edge isn't found in A.
 *
 * A traverses the edge as u→v. The merged loop starts at v and walks A's full
 * loop back to u (that keeps every A corner in A's order), then splices in B's
 * corners strictly between u and v (B traverses v→u, so walking forward from u
 * collects B's far side up to — but not including — v). The two shared corners
 * u and v appear once each, from A.
 */
function mergeAcrossEdge(faceA: number[], faceB: number[], p: number, q: number): number[] | null {
  const dir = directedEdge(faceA, p, q);
  if (!dir) return null;
  const [u, v] = dir;

  const nA = faceA.length;
  const iv = faceA.indexOf(v);
  const loopA: number[] = [];
  for (let k = 0; k < nA; k++) loopA.push(faceA[(iv + k) % nA]); // [v, ..., u]

  const nB = faceB.length;
  const iu = faceB.indexOf(u);
  const midB: number[] = [];
  for (let k = 1; k < nB; k++) {
    const w = faceB[(iu + k) % nB];
    if (w === v) break; // reached the shared edge — stop before v
    midB.push(w);
  }

  return [...loopA, ...midB];
}

/**
 * Dissolve every dissolvable edge in `edgeKeys`. Edges are processed one at a
 * time, re-querying the mesh's faces before each merge so CHAINS collapse
 * correctly: dissolving edge 1 fuses faces A+B into AB, and if edge 2 sat
 * between B and C it is now between AB and C — the re-query sees two faces and
 * merges again. Degenerate merges (fewer than 3 distinct verts) are dropped.
 */
export function dissolveEdges(mesh: EditableMesh, edgeKeys: Set<string>): void {
  for (const key of edgeKeys) {
    const e = mesh.edges().get(key);
    if (!e) continue; // stale key (verts gone) or wire edge with no face
    const faceIds = [...new Set(e.faces)];
    if (faceIds.length !== 2) continue; // boundary / non-manifold — skip
    const fA = mesh.faces.get(faceIds[0]);
    const fB = mesh.faces.get(faceIds[1]);
    if (!fA || !fB) continue;

    const merged = mergeAcrossEdge(fA.verts, fB.verts, e.v0, e.v1);
    if (!merged || new Set(merged).size < 3) continue; // drop degenerate result

    mesh.deleteFaces([fA.id, fB.id]);
    mesh.addFace(merged);
  }
}
