import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Fill face (Blender's F): build a single new face from the current selection.
 *
 *  - Vert mode: 3+ selected verts, ordered by angle around their centroid on a
 *    best-fit plane (`fillVerts`).
 *  - Edge mode: the selected edges must form ONE open or closed chain; the face
 *    follows that chain's vert path (`fillEdges`).
 *
 * Both return `{ faceId }` on success or `{ error }` (mesh left untouched) so the
 * caller can drop a no-op undo command.
 *
 * ## Winding (deviation from the P5-4 spec, documented)
 * The spec asks to orient the new face's Newell normal to *oppose the average
 * normal of the faces adjacent to the boundary*. That average is degenerate for
 * a symmetric hole — e.g. a cube with one face removed: the four surrounding
 * side faces have normals ±X, ±Z which sum to zero, so it can't decide a winding
 * (and the acceptance test demands an outward normal there). Instead we orient
 * per-boundary-edge: for any polygon edge that already exists in the mesh as a
 * boundary edge (used by exactly one face), the new face must traverse it in the
 * OPPOSITE direction to that neighbour, which is exactly what makes the shared
 * edge manifold and both faces wind outward. With no adjacent faces we keep the
 * path order as-is (matches the spec's fallback).
 */

export type FillResult = { faceId: number } | { error: string };

/** True if face `f` traverses the directed edge a→b (a immediately before b, cyclic). */
function faceGoesForward(faceVerts: number[], a: number, b: number): boolean {
  const n = faceVerts.length;
  for (let i = 0; i < n; i++) {
    if (faceVerts[i] === a && faceVerts[(i + 1) % n] === b) return true;
  }
  return false;
}

/**
 * Reverse `path` in place if a boundary edge it walks is traversed the SAME way
 * by its single adjacent face (which would double the direction → non-manifold /
 * inward). Leaves the path untouched when the boundary has no adjacent faces.
 */
function orientPathOutward(mesh: EditableMesh, path: number[]): void {
  const edges = mesh.edges();
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[i], b = path[(i + 1) % n];
    const e = edges.get(EditableMesh.edgeKey(a, b));
    if (!e || e.faces.length !== 1) continue; // want a boundary edge with one neighbour
    const neighbour = mesh.faces.get(e.faces[0]);
    if (!neighbour) continue;
    // Neighbour goes a→b in the same direction as our path → our winding matches
    // its winding across the shared edge, which is wrong for a manifold seam.
    if (faceGoesForward(neighbour.verts, a, b)) path.reverse();
    return; // one shared boundary edge fixes the winding for the whole loop
  }
}

/** Newell normal of an ordered vertex path; near-zero (< eps) means degenerate. */
function newellNormal(mesh: EditableMesh, path: number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = mesh.verts.get(path[i])!.co;
    const b = mesh.verts.get(path[(i + 1) % n])!.co;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return new Vec3(nx, ny, nz);
}

/** A plane normal for an unordered coplanar point set, order-independent. */
function bestFitNormal(pts: Vec3[], centroid: Vec3): Vec3 {
  // Farthest point from the centroid, then the point with the largest component
  // perpendicular to (centroid→far): those two spread axes define the plane.
  let far = pts[0], farD = -1;
  for (const p of pts) {
    const d = p.distanceTo(centroid);
    if (d > farD) { farD = d; far = p; }
  }
  const axis = far.sub(centroid);
  let side = Vec3.ZERO, sideD = -1;
  for (const p of pts) {
    const rel = p.sub(centroid);
    const perp = rel.sub(axis.scale(rel.dot(axis) / Math.max(axis.lengthSq(), 1e-12)));
    if (perp.lengthSq() > sideD) { sideD = perp.lengthSq(); side = perp; }
  }
  return axis.cross(side).normalize();
}

/** Fill from a vert selection (3+ verts, angle-sorted on their best-fit plane). */
export function fillVerts(mesh: EditableMesh, vertIds: Iterable<number>): FillResult {
  const ids = [...new Set(vertIds)].filter((id) => mesh.verts.has(id));
  if (ids.length < 3) return { error: 'need 3 or more selected verts' };

  // Reject verts with no boundary: an interior vert whose every incident edge is
  // already shared by two faces is "fully surrounded" — filling would tear the
  // manifold. A free vert (no edges yet) is fine.
  const edges = mesh.edges();
  const incident = new Map<number, number[]>();
  for (const e of edges.values()) {
    if (ids.includes(e.v0)) (incident.get(e.v0) ?? incident.set(e.v0, []).get(e.v0)!).push(e.faces.length);
    if (ids.includes(e.v1)) (incident.get(e.v1) ?? incident.set(e.v1, []).get(e.v1)!).push(e.faces.length);
  }
  for (const id of ids) {
    const inc = incident.get(id);
    if (inc && inc.length > 0 && inc.every((c) => c >= 2)) {
      return { error: 'a selected vert is already fully surrounded' };
    }
  }

  const pts = ids.map((id) => mesh.verts.get(id)!.co);
  let centroid = Vec3.ZERO;
  for (const p of pts) centroid = centroid.add(p);
  centroid = centroid.scale(1 / pts.length);

  // Best-fit plane normal, then an in-plane basis (u, v) to measure angles.
  const normal = bestFitNormal(pts, centroid);
  const seed = Math.abs(normal.y) < 0.9 ? Vec3.Y : Vec3.X;
  const u = normal.cross(seed).normalize();
  const v = normal.cross(u);

  const ordered = ids
    .map((id) => {
      const rel = mesh.verts.get(id)!.co.sub(centroid);
      return { id, angle: Math.atan2(rel.dot(v), rel.dot(u)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((e) => e.id);

  orientPathOutward(mesh, ordered);
  return { faceId: mesh.addFace(ordered) };
}

/** Fill from an edge selection that forms ONE open or closed chain. */
export function fillEdges(mesh: EditableMesh, edgeKeys: Iterable<string>): FillResult {
  // Edge keys are canonical "min,max" vert-id pairs. Parse them directly rather
  // than via mesh.edges() — a selected edge on a still-open boundary belongs to
  // faces, but bare (face-less) edge chains do not appear in the edge cache.
  const keys = [...new Set(edgeKeys)];
  const pairs: [number, number][] = [];
  for (const k of keys) {
    const [a, b] = k.split(',').map(Number);
    if (!mesh.verts.has(a) || !mesh.verts.has(b)) continue;
    pairs.push([a, b]);
  }
  if (pairs.length < 2) return { error: 'select an edge chain (2+ edges)' };

  // Build a vertex adjacency graph from the selected edges.
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const [a, b] of pairs) {
    link(a, b);
    link(b, a);
  }

  // A single simple chain: every vert has degree 1 (an end) or 2 (interior).
  const ends: number[] = [];
  for (const [vid, nbrs] of adj) {
    if (nbrs.length === 1) ends.push(vid);
    else if (nbrs.length !== 2) return { error: 'edges do not form a single chain' };
  }
  const closed = ends.length === 0;
  if (!closed && ends.length !== 2) return { error: 'edges do not form a single chain' };

  // Walk the chain into an ordered vert path.
  const start = closed ? adj.keys().next().value! : ends[0];
  const path: number[] = [start];
  const visited = new Set<number>([start]);
  let prev = -1, cur = start;
  for (;;) {
    const next = (adj.get(cur) ?? []).find((n) => n !== prev && !visited.has(n));
    if (next === undefined) break;
    path.push(next);
    visited.add(next);
    prev = cur;
    cur = next;
  }
  // Every selected edge's vert must have been reached (one connected chain).
  if (visited.size !== adj.size) return { error: 'edges do not form a single chain' };
  if (path.length < 3) return { error: 'chain too short to fill' };

  orientPathOutward(mesh, path);
  // Guard against a fully-degenerate (collinear) chain producing a zero-area face.
  if (newellNormal(mesh, path).lengthSq() < 1e-18) return { error: 'chain is collinear' };
  return { faceId: mesh.addFace(path) };
}
