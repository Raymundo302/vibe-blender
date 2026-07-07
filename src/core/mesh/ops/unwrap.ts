import { EditableMesh } from '../EditableMesh';
import { Vec3 } from '../../math/vec3';
import type { Mat4 } from '../../math/mat4';

/**
 * UV unwrapping (P11-1). Three Blender-flavoured operators, all PURE with
 * respect to topology — they only assign per-face-corner UVs through
 * `mesh.setFaceUVs`, so a MeshEditCommand snapshot around the call is a
 * complete, correct undo (seams + uvs live on the mesh):
 *
 *  - `unwrapIslands`  — seam-split islands → boundary-circle Tutte embed →
 *                       uniform-Laplacian relaxation → texel-density scale →
 *                       shelf pack. The honest "real unwrap" (A14).
 *  - `smartUvProject` — cluster faces into 6 axis buckets, planar-project each,
 *                       pack. The robust fallback for ugly topology.
 *  - `projectFromView`— planar-project the faces through a view/proj matrix and
 *                       normalise into [0,1]² preserving screen aspect.
 *
 * DETERMINISTIC: every loop count is fixed, every iteration order is sorted, no
 * RNG. Two runs on the same mesh serialise byte-identically.
 *
 * SELECTION POLICY (documented choice, matches the U-menu wiring): the caller
 * decides the face domain — Blender operates on the current selection, and we
 * fall back to ALL faces when nothing is selected. These functions just take the
 * face ids they are handed.
 */

type UV = [number, number];

/** A packable UV island: its faces + per-corner UVs (parallel to face.verts). */
interface Island {
  faceIds: number[];
  /** faceId → one UV per corner, in local (un-packed) coordinates. */
  cornerUVs: Map<number, UV[]>;
}

// Small gap left between islands and around the [0,1]² border after packing.
const MARGIN = 0.02;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** 3D area of a polygon face (Newell's vector magnitude / 2). */
function faceArea3D(mesh: EditableMesh, faceId: number): number {
  const vs = mesh.faces.get(faceId)!.verts;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = mesh.verts.get(vs[i])!.co;
    const b = mesh.verts.get(vs[(i + 1) % vs.length])!.co;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

/** Area of a UV polygon (fan triangulation, always positive). */
function polyUVArea(uvs: UV[]): number {
  let a = 0;
  for (let i = 1; i < uvs.length - 1; i++) {
    const [x0, y0] = uvs[0], [x1, y1] = uvs[i], [x2, y2] = uvs[i + 1];
    a += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Seam-split island partitioning
// ---------------------------------------------------------------------------

/**
 * Partition `faceIds` into islands by walking face adjacency WITHOUT crossing
 * seam edges, boundary edges, or non-manifold edges. Deterministic: faces are
 * seeded in ascending id order and each island is returned sorted.
 *
 * Exported for unit testing (island counts).
 */
export function seamIslands(mesh: EditableMesh, faceIds: Iterable<number>): number[][] {
  const domain = [...faceIds].filter((f) => mesh.faces.has(f)).sort((a, b) => a - b);
  const inDomain = new Set(domain);

  // edgeKey → the domain faces that use it.
  const edgeFaces = new Map<string, number[]>();
  for (const fid of domain) {
    const vs = mesh.faces.get(fid)!.verts;
    for (let i = 0; i < vs.length; i++) {
      const k = EditableMesh.edgeKey(vs[i], vs[(i + 1) % vs.length]);
      let list = edgeFaces.get(k);
      if (!list) { list = []; edgeFaces.set(k, list); }
      list.push(fid);
    }
  }

  // Face adjacency: connect two faces sharing a manifold, non-seam edge.
  const adj = new Map<number, number[]>();
  for (const fid of domain) adj.set(fid, []);
  for (const [k, fs] of edgeFaces) {
    if (mesh.seams.has(k)) continue;   // seam: an island boundary
    if (fs.length !== 2) continue;     // boundary / non-manifold: don't cross
    const [a, b] = fs;
    if (a === b || !inDomain.has(a) || !inDomain.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const seen = new Set<number>();
  const islands: number[][] = [];
  for (const seed of domain) {
    if (seen.has(seed)) continue;
    const comp: number[] = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj.get(cur)!) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    comp.sort((a, b) => a - b);
    islands.push(comp);
  }
  return islands;
}

// ---------------------------------------------------------------------------
// Per-island Tutte embedding
// ---------------------------------------------------------------------------

/** Extract closed boundary loops from a boundary-vert adjacency map. */
function extractLoops(bAdj: Map<number, number[]>): number[][] {
  const loops: number[][] = [];
  const usedEdge = new Set<string>();
  const starts = [...bAdj.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    // Follow any unused boundary edge out of `start` to trace a loop.
    for (;;) {
      const first = (bAdj.get(start) ?? []).find(
        (n) => !usedEdge.has(EditableMesh.edgeKey(start, n)),
      );
      if (first === undefined) break;
      const loop: number[] = [start];
      usedEdge.add(EditableMesh.edgeKey(start, first));
      let prev = start;
      let cur = first;
      while (cur !== start) {
        loop.push(cur);
        const next = (bAdj.get(cur) ?? []).find(
          (n) => n !== prev && !usedEdge.has(EditableMesh.edgeKey(cur, n)),
        );
        if (next === undefined) break; // open chain — bail out gracefully
        usedEdge.add(EditableMesh.edgeKey(cur, next));
        prev = cur;
        cur = next;
      }
      if (loop.length >= 3 && cur === start) loops.push(loop);
    }
  }
  return loops;
}

/** Fill `out` with a planar projection of the island's verts along its average normal. */
function planarProjectVerts(mesh: EditableMesh, faceIds: number[], out: Map<number, UV>): void {
  let n = Vec3.ZERO;
  for (const fid of faceIds) n = n.add(mesh.faceNormal(fid));
  n = n.normalize();
  if (n.lengthSq() < EPS) n = Vec3.Z;
  // Build an orthonormal basis (tangent, bitangent) around n.
  const helper = Math.abs(n.y) < 0.99 ? Vec3.Y : Vec3.X;
  const t = helper.cross(n).normalize();
  const b = n.cross(t).normalize();
  const verts = new Set<number>();
  for (const fid of faceIds) for (const v of mesh.faces.get(fid)!.verts) verts.add(v);
  for (const v of verts) {
    const co = mesh.verts.get(v)!.co;
    out.set(v, [co.dot(t), co.dot(b)]);
  }
}

/**
 * Embed one seam-split island into UV space: map its (longest) boundary loop to
 * a unit circle by arc length, then relax interior verts with ~100 uniform-
 * Laplacian (Gauss-Seidel) iterations — the classic Tutte barycentric embedding,
 * which is guaranteed non-degenerate for a disk with a convex fixed boundary.
 * Islands with no usable boundary loop fall back to a planar projection.
 */
function embedIsland(mesh: EditableMesh, faceIds: number[]): Island {
  const verts = new Set<number>();
  const vertAdj = new Map<number, Set<number>>();
  const edgeCount = new Map<string, number>();
  const edgePair = new Map<string, [number, number]>();

  for (const fid of faceIds) {
    const vs = mesh.faces.get(fid)!.verts;
    for (const v of vs) {
      verts.add(v);
      if (!vertAdj.has(v)) vertAdj.set(v, new Set());
    }
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      const k = EditableMesh.edgeKey(a, b);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      if (!edgePair.has(k)) edgePair.set(k, [a, b]);
      vertAdj.get(a)!.add(b);
      vertAdj.get(b)!.add(a);
    }
  }

  // Boundary of the island = edges used by exactly one island face.
  const bAdj = new Map<number, number[]>();
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    const [a, b] = edgePair.get(k)!;
    (bAdj.get(a) ?? bAdj.set(a, []).get(a)!).push(b);
    (bAdj.get(b) ?? bAdj.set(b, []).get(b)!).push(a);
  }

  const loops = extractLoops(bAdj);
  const vertUV = new Map<number, UV>();

  // Pin the longest loop (by 3D perimeter) to a circle; other verts relax.
  let best: number[] | null = null;
  let bestPerim = -1;
  for (const loop of loops) {
    let p = 0;
    for (let i = 0; i < loop.length; i++) {
      p += mesh.verts.get(loop[i])!.co.distanceTo(mesh.verts.get(loop[(i + 1) % loop.length])!.co);
    }
    if (p > bestPerim) { bestPerim = p; best = loop; }
  }

  if (best && best.length >= 3 && bestPerim > EPS) {
    const seg: number[] = [];
    for (let i = 0; i < best.length; i++) {
      seg.push(mesh.verts.get(best[i])!.co.distanceTo(mesh.verts.get(best[(i + 1) % best.length])!.co));
    }
    let acc = 0;
    for (let i = 0; i < best.length; i++) {
      const ang = (2 * Math.PI * acc) / bestPerim;
      vertUV.set(best[i], [0.5 + 0.5 * Math.cos(ang), 0.5 + 0.5 * Math.sin(ang)]);
      acc += seg[i];
    }
    const pinned = new Set(best);
    const interior = [...verts].filter((v) => !pinned.has(v)).sort((a, b) => a - b);
    for (const v of interior) vertUV.set(v, [0.5, 0.5]);
    // Gauss-Seidel relaxation: each interior vert → mean of its neighbours.
    for (let iter = 0; iter < 100; iter++) {
      for (const v of interior) {
        let sx = 0, sy = 0, n = 0;
        for (const w of vertAdj.get(v)!) {
          const uw = vertUV.get(w);
          if (uw) { sx += uw[0]; sy += uw[1]; n++; }
        }
        if (n > 0) vertUV.set(v, [sx / n, sy / n]);
      }
    }
  } else {
    // No disk boundary (degenerate / closed island slice) — planar fallback.
    planarProjectVerts(mesh, faceIds, vertUV);
  }

  const cornerUVs = new Map<number, UV[]>();
  for (const fid of faceIds) {
    const vs = mesh.faces.get(fid)!.verts;
    cornerUVs.set(fid, vs.map((v) => {
      const uv = vertUV.get(v) ?? [0.5, 0.5];
      return [uv[0], uv[1]] as UV;
    }));
  }
  return { faceIds, cornerUVs };
}

// ---------------------------------------------------------------------------
// Packing: equalise texel density, shelf-pack into [0,1]²
// ---------------------------------------------------------------------------

/**
 * Scale each island so its UV area is proportional to its 3D area (uniform texel
 * density), shelf-pack the boxes, then uniformly fit the whole layout into
 * [MARGIN, 1-MARGIN]² and write the final per-corner UVs onto the mesh.
 */
function packIslands(mesh: EditableMesh, islands: Island[]): void {
  interface Placed {
    island: Island;
    ds: number;      // texel-density scale
    minx: number; miny: number;
    w: number; h: number;
    ox: number; oy: number; // shelf offset
    index: number;
  }
  const placed: Placed[] = islands.map((island, index) => {
    let area3D = 0, areaUV = 0;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const fid of island.faceIds) {
      area3D += faceArea3D(mesh, fid);
      const uvs = island.cornerUVs.get(fid)!;
      areaUV += polyUVArea(uvs);
      for (const [u, v] of uvs) {
        if (u < minx) minx = u; if (u > maxx) maxx = u;
        if (v < miny) miny = v; if (v > maxy) maxy = v;
      }
    }
    const ds = Math.sqrt(Math.max(area3D, EPS) / Math.max(areaUV, EPS));
    return {
      island, ds, minx, miny,
      w: Math.max((maxx - minx) * ds, EPS),
      h: Math.max((maxy - miny) * ds, EPS),
      ox: 0, oy: 0, index,
    };
  });

  // Shelf pack: tallest first (id tie-break), rows grow to the right until they
  // pass a squarish width limit, then a new shelf starts above.
  const order = [...placed].sort((a, b) => (b.h - a.h) || (a.index - b.index));
  let totalArea = 0;
  for (const p of placed) totalArea += p.w * p.h;
  const limit = Math.max(Math.sqrt(totalArea) * 1.1, ...placed.map((p) => p.w));
  let shelfX = 0, shelfY = 0, shelfH = 0, extentX = 0, extentY = 0;
  for (const p of order) {
    if (shelfX > 0 && shelfX + p.w > limit) {
      shelfY += shelfH + MARGIN; // new shelf
      shelfX = 0;
      shelfH = 0;
    }
    p.ox = shelfX;
    p.oy = shelfY;
    shelfX += p.w + MARGIN;
    shelfH = Math.max(shelfH, p.h);
    extentX = Math.max(extentX, shelfX - MARGIN);
    extentY = Math.max(extentY, shelfY + shelfH);
  }

  const fit = (1 - 2 * MARGIN) / Math.max(extentX, extentY, EPS);
  for (const p of placed) {
    for (const fid of p.island.faceIds) {
      const uvs = p.island.cornerUVs.get(fid)!;
      const out: UV[] = uvs.map(([u, v]) => {
        const su = MARGIN + fit * ((u - p.minx) * p.ds + p.ox);
        const sv = MARGIN + fit * ((v - p.miny) * p.ds + p.oy);
        return [
          Math.min(1, Math.max(0, su)),
          Math.min(1, Math.max(0, sv)),
        ] as UV;
      });
      mesh.setFaceUVs(fid, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Public operators
// ---------------------------------------------------------------------------

/** Seam-split Tutte unwrap over the given faces (see module header). */
export function unwrapIslands(mesh: EditableMesh, faceIds: Iterable<number>): void {
  const comps = seamIslands(mesh, faceIds);
  if (comps.length === 0) return;
  const islands = comps.map((comp) => embedIsland(mesh, comp));
  packIslands(mesh, islands);
}

/**
 * Smart UV Project: cluster faces into six axis buckets by dominant normal
 * (documented choice over an angle-threshold greedy pass — deterministic, and a
 * cube resolves to exactly 6 clusters), planar-project each bucket, then pack.
 */
export function smartUvProject(mesh: EditableMesh, faceIds: Iterable<number>): void {
  const domain = [...faceIds].filter((f) => mesh.faces.has(f)).sort((a, b) => a - b);
  if (domain.length === 0) return;

  // bucketKey = axis*2 + sign (0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z).
  const buckets = new Map<number, number[]>();
  for (const fid of domain) {
    const n = mesh.faceNormal(fid);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let axis: number, comp: number;
    if (ax >= ay && ax >= az) { axis = 0; comp = n.x; }
    else if (ay >= az) { axis = 1; comp = n.y; }
    else { axis = 2; comp = n.z; }
    const key = axis * 2 + (comp < 0 ? 1 : 0);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(fid);
  }

  const islands: Island[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const faces = buckets.get(key)!;
    const axis = Math.floor(key / 2);
    const cornerUVs = new Map<number, UV[]>();
    for (const fid of faces) {
      const vs = mesh.faces.get(fid)!.verts;
      cornerUVs.set(fid, vs.map((v) => {
        const co = mesh.verts.get(v)!.co;
        // Drop the dominant axis; the other two coords become (u, v).
        if (axis === 0) return [co.z, co.y] as UV;
        if (axis === 1) return [co.x, co.z] as UV;
        return [co.x, co.y] as UV;
      }));
    }
    islands.push({ faceIds: faces, cornerUVs });
  }
  packIslands(mesh, islands);
}

/**
 * Project From View: planar-project each face's corners through `mvp` (proj *
 * view * objectMatrix), converting NDC to screen-aspect space (u = ndcX*aspect,
 * v = ndcY), then uniformly normalise the whole projection into [0,1]² — so a
 * front-facing quad keeps its on-screen aspect ratio. Replaces the faces' UVs.
 */
export function projectFromView(
  mesh: EditableMesh,
  faceIds: Iterable<number>,
  mvp: Mat4,
  aspect: number,
): void {
  const domain = [...faceIds].filter((f) => mesh.faces.has(f)).sort((a, b) => a - b);
  if (domain.length === 0) return;

  const raw = new Map<number, UV[]>();
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const fid of domain) {
    const vs = mesh.faces.get(fid)!.verts;
    const uvs = vs.map((v) => {
      const p = mvp.transformPoint(mesh.verts.get(v)!.co);
      const u = p.x * aspect;   // un-squeeze NDC x back to screen-pixel proportions
      const w = -p.y;           // flip so +v points up on screen
      if (u < minx) minx = u; if (u > maxx) maxx = u;
      if (w < miny) miny = w; if (w > maxy) maxy = w;
      return [u, w] as UV;
    });
    raw.set(fid, uvs);
  }

  const span = Math.max(maxx - minx, maxy - miny, EPS);
  // Centre within [0,1]² and scale uniformly (aspect-preserving).
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  for (const fid of domain) {
    const out: UV[] = raw.get(fid)!.map(([u, v]) => [
      Math.min(1, Math.max(0, 0.5 + (u - cx) / span)),
      Math.min(1, Math.max(0, 0.5 + (v - cy) / span)),
    ] as UV);
    mesh.setFaceUVs(fid, out);
  }
}
