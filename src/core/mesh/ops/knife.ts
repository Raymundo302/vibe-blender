import { EditableMesh } from '../EditableMesh';
import type { Vec3 } from '../../math/vec3';

/**
 * Knife tool geometry (Blender's K) — pragmatic v1.
 *
 * Given the mesh, a screen-space polyline (the clicks the user placed), and a
 * projector that maps a mesh coordinate to screen pixels, this cuts the mesh
 * where the polyline crosses it:
 *  - every eligible mesh edge whose SCREEN projection crosses a polyline segment
 *    gets ONE new vertex, placed by interpolating that edge in 3D at the
 *    crossing parameter (edges are keyed canonically, so an edge shared by two
 *    faces gets a single shared vert);
 *  - each camera-facing (eligible) face crossed by exactly two edges is split in
 *    two by a new edge connecting its two new verts (the chord), preserving
 *    winding — the same split shape loop cut produces;
 *  - a face that merely touches one crossed edge just gains that vert on its
 *    boundary (no split), which also keeps faces that border a cut edge but are
 *    not themselves camera-facing (e.g. a cube's side faces) manifold.
 *
 * Camera-facing selection is the CALLER's responsibility via `opts.frontFacing`
 * (the interaction layer has the camera + world normals). When omitted, ALL
 * faces are eligible — which is what the unit tests want (they pass flat,
 * single-sided synthetic meshes).
 *
 * ## Out of scope (documented v1 limitations)
 *  - **No cut-through.** Only faces passing `frontFacing` are split; a true back
 *    face (whose edges border no camera-facing face) is left untouched. Side
 *    faces bordering a cut edge gain the vert (to stay manifold) but are not
 *    split.
 *  - **No mid-face isolated points.** A vert is only ever inserted where the
 *    polyline crosses an edge; the polyline never drops a lone point in a face
 *    interior.
 *  - **No angle snapping / no cutting the mesh anywhere but at edge crossings.**
 *  - **A face crossed more than twice** by the polyline only receives its verts
 *    (all of them, to stay manifold) but is NOT chord-split — a wiggly stroke
 *    that re-enters one face is not fully resolved in v1.
 *  - **UVs are dropped on modified faces**, matching the house subdivide op
 *    (`ops/subdivide.ts`), which likewise does not interpolate UVs. New faces
 *    carry no UV entry (they sample (0,0)).
 */

/** Screen point in CSS pixels. */
type Px = [number, number];

/** Projects a mesh coordinate to screen pixels, or null if it can't (behind the
 *  camera / clipped). */
export type ScreenProjector = (co: Vec3) => Px | null;

export interface KnifeResult {
  /** Number of mesh edges that received a new vertex. */
  cutEdges: number;
  /** Number of new vertices inserted (one per cut edge). */
  newVerts: number;
}

export interface KnifeOptions {
  /** Per-face predicate: true = camera-facing, eligible to be cut/split. When
   *  omitted every face is eligible. */
  frontFacing?: (faceId: number) => boolean;
}

/**
 * Intersect edge segment (a0→a1) with polyline segment (b0→b1) in 2D.
 * Returns the parameter `t` along the EDGE (0 at a0, 1 at a1) plus `u` along the
 * polyline segment, or null when they don't cross within both segments.
 */
function segIntersect(a0: Px, a1: Px, b0: Px, b1: Px): { t: number; u: number } | null {
  const rx = a1[0] - a0[0], ry = a1[1] - a0[1];
  const sx = b1[0] - b0[0], sy = b1[1] - b0[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallel / degenerate
  const qpx = b0[0] - a0[0], qpy = b0[1] - a0[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

export function knifeCut(
  mesh: EditableMesh,
  polylinePx: Px[],
  project: ScreenProjector,
  opts: KnifeOptions = {},
): KnifeResult {
  if (polylinePx.length < 2) return { cutEdges: 0, newVerts: 0 };

  // Screen positions of every vert (null when unprojectable).
  const screen = new Map<number, Px | null>();
  for (const [id, v] of mesh.verts) screen.set(id, project(v.co));

  const eligible = new Set<number>();
  for (const fid of mesh.faces.keys()) {
    if (!opts.frontFacing || opts.frontFacing(fid)) eligible.add(fid);
  }

  const edges = mesh.edges();

  // One new vert per crossed edge that borders at least one eligible face. We
  // keep the polyline parameter of the crossing so faces can order their new
  // verts along the stroke.
  const newVertByEdge = new Map<string, { vid: number; param: number }>();
  for (const [key, e] of edges) {
    if (!e.faces.some((f) => eligible.has(f))) continue;
    const s0 = screen.get(e.v0);
    const s1 = screen.get(e.v1);
    if (!s0 || !s1) continue;

    // First crossing along the stroke (smallest polyline parameter).
    let bestT = -1;
    let bestParam = Infinity;
    for (let i = 0; i < polylinePx.length - 1; i++) {
      const hit = segIntersect(s0, s1, polylinePx[i], polylinePx[i + 1]);
      if (!hit) continue;
      const param = i + hit.u;
      if (param < bestParam) {
        bestParam = param;
        bestT = hit.t;
      }
    }
    if (bestT < 0) continue;

    const a = mesh.verts.get(e.v0)!.co;
    const b = mesh.verts.get(e.v1)!.co;
    const vid = mesh.addVert(a.lerp(b, bestT));
    newVertByEdge.set(key, { vid, param: bestParam });
  }

  if (newVertByEdge.size === 0) return { cutEdges: 0, newVerts: 0 };

  // Rebuild every face touched by a cut edge: eligible faces with >=2 crossings
  // split along the chord; everything else just gains the vert(s) in its loop.
  const facesToDelete: number[] = [];
  const facesToAdd: number[][] = [];
  for (const [fid, face] of mesh.faces) {
    const verts = face.verts;
    const n = verts.length;

    // Crossings on this face, tagged by their corner index (edge verts[i]→i+1).
    const crossings: { cornerIndex: number; vid: number; param: number }[] = [];
    for (let i = 0; i < n; i++) {
      const nv = newVertByEdge.get(EditableMesh.edgeKey(verts[i], verts[(i + 1) % n]));
      if (nv) crossings.push({ cornerIndex: i, vid: nv.vid, param: nv.param });
    }
    if (crossings.length === 0) continue;

    // Augmented loop: insert each new vert right after its corner. Building in
    // corner order keeps the loop wound like the parent face.
    const aug: number[] = [];
    for (let i = 0; i < n; i++) {
      aug.push(verts[i]);
      const c = crossings.find((x) => x.cornerIndex === i);
      if (c) aug.push(c.vid);
    }

    facesToDelete.push(fid);
    const splittable = eligible.has(fid) && crossings.length === 2;
    if (splittable) {
      // Chord between the two new verts splits the augmented loop into two faces.
      const va = crossings[0].vid;
      const vb = crossings[1].vid;
      let pa = aug.indexOf(va);
      let pb = aug.indexOf(vb);
      if (pa > pb) [pa, pb] = [pb, pa];
      const loop1 = aug.slice(pa, pb + 1); // va … vb
      const loop2 = [...aug.slice(pb), ...aug.slice(0, pa + 1)]; // vb … wrap … va
      facesToAdd.push(loop1, loop2);
    } else {
      // Insert-only: keep the face whole, just carrying its new boundary vert(s).
      facesToAdd.push(aug);
    }
  }

  mesh.deleteFaces(facesToDelete);
  for (const loop of facesToAdd) if (loop.length >= 3) mesh.addFace(loop);

  return { cutEdges: newVertByEdge.size, newVerts: newVertByEdge.size };
}
