import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';

/**
 * Bevel edges (Blender's Ctrl+B, 1 segment): each selected edge slides apart
 * into two edges with a new flat quad between them. Endpoints of beveled edges
 * are "opened up" — a chain-END vert splits into one new vert per adjacent face
 * wing, a chain-INTERNAL vert shares one new vert between its two edges on each
 * outer side.
 *
 * v1 scope (enforced, not extrapolated):
 *  - every selected edge must be INTERIOR (exactly 2 faces);
 *  - every vert may touch at most 2 selected edges (disjoint simple chains/rings);
 *  - no face may have BOTH of its edges at a shared vert selected (this "closed
 *    corner", e.g. beveling a whole face boundary on a cube, needs multi-segment
 *    corner geometry we don't build in v1);
 *  - every wing edge referenced while re-stitching a face must exist (holds for
 *    degree-3 corners like a cube; exotic high-valence corners are rejected).
 * Anything outside this returns `{ error }` with the mesh left UNTOUCHED, so the
 * caller can drop the no-op command. Uniform width, no clamping against face
 * size (documented — an over-wide bevel can self-intersect).
 *
 * Pure geometry over the mesh's public API; the modal tool wraps it for undo and
 * REBUILDS from a pre-bevel snapshot on every width change (never slides).
 */

/** The wing neighbour of `v` inside face `f` — the vert across the non-selected
 *  edge at `v` (the edge that is NOT the beveled edge `v–other`). */
function wingNeighbour(faceVerts: number[], v: number, other: number): number | null {
  const n = faceVerts.length;
  const i = faceVerts.indexOf(v);
  if (i < 0) return null;
  const prev = faceVerts[(i - 1 + n) % n];
  const next = faceVerts[(i + 1) % n];
  if (prev === other) return next;
  if (next === other) return prev;
  return null; // `other` not adjacent to `v` in this face — shouldn't happen
}

/** Newell normal of a polygon from its ordered vertex coordinates. */
function newellNormal(coords: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const a = coords[i], b = coords[(i + 1) % n];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return new Vec3(nx, ny, nz).normalize();
}

export function bevelEdges(
  mesh: EditableMesh,
  edgeKeys: Iterable<string>,
  width: number,
): { newFaceIds: number[] } | { error: string } {
  const edges = mesh.edges();
  const selKeys = [...new Set(edgeKeys)].filter((k) => edges.has(k));
  if (selKeys.length === 0) return { error: 'no edges selected' };
  const selSet = new Set(selKeys);
  const isSel = (a: number, b: number): boolean => selSet.has(EditableMesh.edgeKey(a, b));

  // --- validation: interior edges + at most 2 selected edges per vert ---
  const perVert = new Map<number, number>();
  for (const key of selKeys) {
    const e = edges.get(key)!;
    if (e.faces.length !== 2) return { error: 'unsupported selection (v1)' };
    for (const v of [e.v0, e.v1]) perVert.set(v, (perVert.get(v) ?? 0) + 1);
  }
  for (const c of perVert.values()) if (c > 2) return { error: 'unsupported selection (v1)' };
  const beveled = new Set(perVert.keys());

  // --- Phase A (read-only): plan slid verts, re-stitched faces, bevel quads ---
  // Slid verts are keyed `${v}:${wingU}` and shared across faces/edges.
  const slidPos = new Map<string, Vec3>();
  const wk = (v: number, u: number): string => `${v}:${u}`;
  const co = (id: number): Vec3 => mesh.verts.get(id)!.co;

  for (const key of selKeys) {
    const e = edges.get(key)!;
    for (const [v, other] of [[e.v0, e.v1], [e.v1, e.v0]] as const) {
      for (const fid of e.faces) {
        const wing = wingNeighbour(mesh.faces.get(fid)!.verts, v, other);
        if (wing === null) return { error: 'unsupported selection (v1)' };
        // A "closed corner": the wing edge is itself selected → out of scope.
        if (isSel(v, wing)) return { error: 'unsupported selection (v1)' };
        const k = wk(v, wing);
        if (!slidPos.has(k)) slidPos.set(k, co(v).add(co(wing).sub(co(v)).normalize().scale(width)));
      }
    }
  }

  // Re-stitch plan: for every face touching a beveled vert, the new vert list as
  // tokens (`number` = keep original vert, `string` = a slid-vert key).
  const facePlan = new Map<number, (number | string)[]>();
  for (const f of mesh.faces.values()) {
    if (!f.verts.some((v) => beveled.has(v))) continue;
    const verts = f.verts;
    const n = verts.length;
    const tokens: (number | string)[] = [];
    for (let i = 0; i < n; i++) {
      const v = verts[i];
      if (!beveled.has(v)) { tokens.push(v); continue; }
      const p = verts[(i - 1 + n) % n];
      const q = verts[(i + 1) % n];
      const selP = isSel(v, p), selQ = isSel(v, q);
      if (selP && selQ) return { error: 'unsupported selection (v1)' }; // closed corner
      if (selP) tokens.push(wk(v, q));          // face lies on q's side of edge v–p
      else if (selQ) tokens.push(wk(v, p));     // face lies on p's side of edge v–q
      else { tokens.push(wk(v, p)); tokens.push(wk(v, q)); } // corner: insert both wings
    }
    // Every referenced slid key must exist (rejects exotic high-valence corners).
    for (const tok of tokens) if (typeof tok === 'string' && !slidPos.has(tok)) {
      return { error: 'unsupported selection (v1)' };
    }
    facePlan.set(f.id, tokens);
  }

  // Bevel quads: one per selected edge, spanning its two adjacent faces. Winding
  // is flipped to face outward like the removed edge's average face normal.
  interface QuadPlan { keys: string[]; normal: Vec3; }
  const quadPlans: QuadPlan[] = [];
  for (const key of selKeys) {
    const e = edges.get(key)!;
    const [f0, f1] = e.faces;
    const a = e.v0, b = e.v1;
    const wA0 = wingNeighbour(mesh.faces.get(f0)!.verts, a, b)!;
    const wB0 = wingNeighbour(mesh.faces.get(f0)!.verts, b, a)!;
    const wA1 = wingNeighbour(mesh.faces.get(f1)!.verts, a, b)!;
    const wB1 = wingNeighbour(mesh.faces.get(f1)!.verts, b, a)!;
    const keys = [wk(a, wA0), wk(b, wB0), wk(b, wB1), wk(a, wA1)];
    const avg = mesh.faceNormal(f0).add(mesh.faceNormal(f1)).normalize();
    quadPlans.push({ keys, normal: avg });
  }

  // --- Phase B (mutate): create slid verts, re-stitch faces, add quads, cull ---
  const slidId = new Map<string, number>();
  for (const [k, pos] of slidPos) slidId.set(k, mesh.addVert(pos));
  const resolve = (tok: number | string): number => (typeof tok === 'number' ? tok : slidId.get(tok)!);

  for (const [fid, tokens] of facePlan) mesh.faces.get(fid)!.verts = tokens.map(resolve);

  const newFaceIds: number[] = [];
  for (const q of quadPlans) {
    const ids = q.keys.map((k) => slidId.get(k)!);
    const coords = ids.map(co);
    const outward = newellNormal(coords).dot(q.normal) < 0 ? [...ids].reverse() : ids;
    newFaceIds.push(mesh.addFace(outward));
  }

  // Original beveled verts are now referenced by nothing — remove them.
  mesh.deleteVerts([...beveled]);

  return { newFaceIds };
}
