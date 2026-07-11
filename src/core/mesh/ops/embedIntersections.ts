import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import type { Mat4 } from '../../math/mat4';

/**
 * Embed mesh–mesh intersection curves into the meshes (the "Intersect" tool).
 *
 * Where the "Intersections" shading overlay (`core/mesh/intersect.ts`) only DRAWS
 * the curve where two objects' geometry passes through each other, this op makes
 * those crossings REAL topology: new verts on the edges that pierce the other
 * mesh, and new edges splitting the crossed faces — on EVERY input mesh, in the
 * SAME local space each already lives in. The objects stay separate meshes (this
 * is NOT a boolean union — no material assignment, no interior removal).
 *
 * ## Algorithm (v1 — edge-piercing based, mirrors `ops/knife.ts`'s machinery)
 * All input meshes are transformed to WORLD space (each by its own world matrix)
 * so meshes at different transforms line up. Then, for each mesh A:
 *  1. **Edge piercings.** Every canonical edge of A (shared by two faces = ONE
 *     edge, so it gets ONE shared vert per hit — exactly like knife) is tested as
 *     a world-space segment against every OTHER mesh's world triangles
 *     (segment–triangle, Möller–Trumbore). Hits at parameter t ∈ (0,1) split the
 *     edge at t. Hits within 1e-6 (world units) of an edge endpoint or of an
 *     earlier hit on the same edge are dropped (dedupe).
 *  2. **Face splits.** Any face that received exactly TWO new verts on its
 *     boundary is chord-split between them, preserving winding (same rule as
 *     knife). A face with 1 or >2 new verts just keeps the boundary verts
 *     (manifold, no split) — a wiggly crossing that re-enters one face is not
 *     fully resolved in v1.
 *  3. New verts get positions in the mesh's LOCAL space: the crossing parameter t
 *     is affine-invariant, so the local position is simply lerp(v0.co, v1.co, t)
 *     — no world→local round-trip error.
 *
 * knife's edge-split / chord-split logic is inlined in `knifeCut` (keyed by
 * screen-space crossings, one vert per edge) rather than exported, so we
 * re-implement the SAME rules here (generalized to multiple verts per edge)
 * rather than refactor knife and risk its tests. The winding/chord math below is
 * a faithful copy of knifeCut's — keep the two in sync if either changes.
 *
 * ## Known v1 limitations (documented, not solved — matches the spec)
 *  - **Interior-only crossings gain nothing.** A face crossed only through its
 *    INTERIOR — no edge of that face pierces the other mesh, e.g. a large plane
 *    passing through a small cube: the plane's single big face — gets no new
 *    geometry (embedding an interior loop needs face-with-hole topology we don't
 *    have). In that scene the CUBE still gains the full loop (its 4 vertical edges
 *    pierce the plane). Workaround for users: subdivide the big face first.
 *  - **Straight chords.** On a non-planar n-gon the chord is a straight segment,
 *    approximating the true (curved) intersection.
 *  - **UVs are dropped on modified faces**, matching knife/subdivide — new faces
 *    carry no UV entry (they sample (0,0)); stale UV entries for deleted faces are
 *    left as harmless orphans (never re-keyed), exactly as knife leaves them.
 *  - **Self-intersection of a single mesh is out of scope** (matches the overlay:
 *    only distinct pairs are considered — a mesh is never tested against itself).
 */

/** One mesh plus the world matrix (local → world) it is placed by. */
export interface IntersectItem {
  mesh: EditableMesh;
  /** Local → world (parent chain × local TRS — the same matrix the renderer/join use). */
  world: Mat4;
}

/** Per-mesh outcome (parallel to the input array). */
export interface EmbedResult {
  /** New vertices inserted on this mesh's edges. */
  verts: number;
  /** Faces of this mesh that were chord-split. */
  splits: number;
}

/**
 * Segment (p0→p1) vs triangle (a,b,c), Möller–Trumbore adapted to a finite
 * segment. Returns the segment parameter t ∈ [0,1] of the crossing, or null when
 * the segment misses the triangle / is parallel to its plane.
 */
function segmentTriangle(
  p0: Vec3, p1: Vec3, a: Vec3, b: Vec3, c: Vec3,
): number | null {
  const dir = p1.sub(p0);
  const e1 = b.sub(a);
  const e2 = c.sub(a);
  const pvec = dir.cross(e2);
  const det = e1.dot(pvec);
  if (Math.abs(det) < 1e-12) return null; // segment parallel to the triangle plane
  const inv = 1 / det;
  const tvec = p0.sub(a);
  const u = tvec.dot(pvec) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qvec = tvec.cross(e1);
  const v = dir.dot(qvec) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = e2.dot(qvec) * inv;
  if (t < 0 || t > 1) return null;
  return t;
}

/** World-space triangles (fan-triangulated, matching the renderer) of a mesh. */
function worldTriangles(mesh: EditableMesh, world: Mat4): [Vec3, Vec3, Vec3][] {
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (const f of mesh.faces.values()) {
    const w = f.verts.map((id) => world.transformPoint(mesh.verts.get(id)!.co));
    for (let i = 1; i < w.length - 1; i++) tris.push([w[0], w[i], w[i + 1]]);
  }
  return tris;
}

/**
 * Embed the pairwise intersection curves of the given placed meshes into those
 * meshes. Mutates each mesh in place (bumping its `version`) and returns a
 * per-mesh count of new verts + chord splits. Meshes that gain nothing are left
 * byte-identical (version unchanged).
 */
export function embedIntersections(items: IntersectItem[]): EmbedResult[] {
  const n = items.length;
  const results: EmbedResult[] = items.map(() => ({ verts: 0, splits: 0 }));
  if (n < 2) return results;

  // World triangles per mesh (from the BASE mesh — we edit real topology).
  const worldTris = items.map((it) => worldTriangles(it.mesh, it.world));

  for (let a = 0; a < n; a++) {
    const { mesh, world } = items[a];

    // Every OTHER mesh's world triangles — A's edges are tested against these.
    const others: [Vec3, Vec3, Vec3][] = [];
    for (let b = 0; b < n; b++) if (b !== a) for (const t of worldTris[b]) others.push(t);
    if (others.length === 0) continue;

    // Phase 1 (read-only): crossing parameters per canonical edge, in canonical
    // orientation (t runs from the min-id vert to the max-id vert). Read-only so
    // the edge cache stays valid — verts are created in phase 2.
    const edgeHits = new Map<string, number[]>();
    for (const e of mesh.edges().values()) {
      const l0 = mesh.verts.get(e.v0)!.co; // e.v0 = min id, e.v1 = max id
      const l1 = mesh.verts.get(e.v1)!.co;
      const w0 = world.transformPoint(l0);
      const w1 = world.transformPoint(l1);
      const edgeLen = w1.sub(w0).length();
      if (edgeLen < 1e-12) continue;

      const ts: number[] = [];
      for (const [ta, tb, tc] of others) {
        const t = segmentTriangle(w0, w1, ta, tb, tc);
        if (t === null) continue;
        // Drop hits sitting on an endpoint (would duplicate an existing vert).
        if (t * edgeLen < 1e-6 || (1 - t) * edgeLen < 1e-6) continue;
        ts.push(t);
      }
      if (ts.length === 0) continue;
      ts.sort((x, y) => x - y);
      // Dedupe hits closer than 1e-6 world units to the previous kept hit.
      const dedup: number[] = [];
      for (const t of ts) {
        if (dedup.length && (t - dedup[dedup.length - 1]) * edgeLen < 1e-6) continue;
        dedup.push(t);
      }
      edgeHits.set(e.key, dedup);
    }
    if (edgeHits.size === 0) continue;

    // Phase 2: create the new verts (canonical order along min→max), recording
    // them per edge for the face rebuild.
    const newVertByEdge = new Map<string, number[]>();
    for (const [key, ts] of edgeHits) {
      const comma = key.indexOf(',');
      const vaId = Number(key.slice(0, comma)); // min id
      const vbId = Number(key.slice(comma + 1)); // max id
      const ca = mesh.verts.get(vaId)!.co;
      const cb = mesh.verts.get(vbId)!.co;
      const vids = ts.map((t) => mesh.addVert(ca.lerp(cb, t)));
      newVertByEdge.set(key, vids);
      results[a].verts += vids.length;
    }

    // Phase 3: rebuild every face touched by a cut edge. A face with exactly two
    // new boundary verts splits along the chord (winding preserved); anything
    // else keeps its loop whole (just carrying the new boundary verts).
    const facesToDelete: number[] = [];
    const facesToAdd: number[][] = [];
    for (const [fid, face] of mesh.faces) {
      const vs = face.verts;
      const m = vs.length;
      const aug: number[] = [];
      const augNew: number[] = []; // new vids, in loop order
      for (let i = 0; i < m; i++) {
        const v0 = vs[i];
        const v1 = vs[(i + 1) % m];
        aug.push(v0);
        const list = newVertByEdge.get(EditableMesh.edgeKey(v0, v1));
        if (list && list.length) {
          // Stored min→max; if the loop walks this edge max→min, reverse so the
          // new verts land in geometric order along v0→v1.
          const seq = v0 > v1 ? [...list].reverse() : list;
          for (const vid of seq) { aug.push(vid); augNew.push(vid); }
        }
      }
      if (augNew.length === 0) continue;

      facesToDelete.push(fid);
      if (augNew.length === 2) {
        // Chord between the two new verts splits the augmented loop in two.
        const va = augNew[0];
        const vb = augNew[1];
        let pa = aug.indexOf(va);
        let pb = aug.indexOf(vb);
        if (pa > pb) [pa, pb] = [pb, pa];
        facesToAdd.push(aug.slice(pa, pb + 1)); // va … vb
        facesToAdd.push([...aug.slice(pb), ...aug.slice(0, pa + 1)]); // vb … wrap … va
        results[a].splits++;
      } else {
        facesToAdd.push(aug); // insert-only: keep the face whole, stay manifold
      }
    }

    mesh.deleteFaces(facesToDelete);
    for (const loop of facesToAdd) if (loop.length >= 3) mesh.addFace(loop);
  }

  return results;
}
