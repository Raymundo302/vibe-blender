import { Vec3 } from '../math/vec3';
import { EditableMesh } from '../mesh/EditableMesh';
import type { SurfaceData } from '../scene/objectData';
import { clampSurfaceSegs } from '../scene/objectData';
import { interiorKnots, knotDomain } from './basis';
import { curveDomain, curvePoint, fromCurveData } from './curve';
import { fromSurfaceData, surfaceNormal, surfacePoint, type NSurface } from './surface';

/**
 * NURBS surface tessellation (NB-CORE): SurfaceData → EditableMesh, the derived
 * geometry the surface driver assigns to the object (the TextData/buildTextMesh
 * pattern). Pure — no GL, no DOM.
 *
 * Modes (SurfaceTess):
 *  - 'spans':    segsU/segsV subdivisions per knot span per direction.
 *  - 'adaptive': starts from the span grid at the segs floor and bisects any
 *    parameter interval whose mid-point chord deviation exceeds `tol` world
 *    units (probed along several cross-parameters), depth-capped.
 *
 * Output: a quad-grid mesh with per-corner UVs normalized to [0,1]² over the
 * parameter domain. Degenerate quads (collapsed sphere-pole rows) emit as
 * triangles; fully-degenerate cells are skipped. Shade Smooth on the object
 * gives the near-analytic normals (meshToGpu vertex averaging over the grid).
 *
 * TRIMS (NB-C3 v2): when data.trims is non-empty the untrimmed grid is
 * classified against the trim loops in UV space, then REFINED at the boundary.
 * Each grid cell is classified by its 4 corners + center via `uvKept`:
 *  - all 5 kept                → emit the whole quad (as the untrimmed path);
 *  - all 5 discarded, no loop
 *    segment crossing the cell  → skip;
 *  - otherwise (BOUNDARY)       → uniformly subdivide the cell into an 8×8 grid
 *    of sub-cells (depth-3 2×2 recursion), keep each sub-cell whose CENTER is
 *    kept, then SNAP every kept sub-cell corner that lies within one sub-cell
 *    diagonal of a loop polyline onto the nearest point of that polyline. The
 *    snap is done in UV (memoized per UV node so shared corners weld and the
 *    result is deterministic) and 3D positions are evaluated AFTER snapping, so
 *    the mesh edge rides the true trim curve instead of stair-stepping. A snap
 *    that inverts / degenerates a sub-cell's UV area drops that face (like the
 *    pole-dedup drops collapsed cells).
 * The untrimmed path is byte-for-byte unchanged from v1.
 */

/** One direction's tessellation parameters: the sorted list of u values. */
export function paramList(
  count: number,
  degree: number,
  knots: number[],
  segsPerSpan: number,
): number[] {
  const [lo, hi] = knotDomain(count, degree, knots);
  // Distinct span boundaries: domain ends + interior knot values.
  const bounds = [lo, ...interiorKnots(count, degree, knots).map((k) => k.u), hi];
  const out: number[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const a = bounds[s], b = bounds[s + 1];
    for (let i = 0; i < segsPerSpan; i++) out.push(a + ((b - a) * i) / segsPerSpan);
  }
  out.push(hi);
  return out;
}

/** Refinement depth cap (matches the original bisection budget). */
const ADAPT_MAX_DEPTH = 5;
/** cos(15°): below this the surface normals at an interval's ends have turned
 *  enough to warrant a split even when the chord test is satisfied. */
const NORMAL_COS_TOL = 0.966;
/** Hard cap on cross-direction probe count (evenly chosen from the current
 *  cross params) — bounds the O(probes × intervals × depth) evaluation cost. */
const MAX_PROBES = 9;

/** Up to `cap` evenly-spaced entries from `list` (endpoints always included).
 *  Deterministic; returns `list` unchanged when it already fits. */
function pickProbes(list: number[], cap: number): number[] {
  if (list.length <= cap) return list;
  const out: number[] = [];
  let last = -1;
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * (list.length - 1)) / (cap - 1));
    if (idx !== last) { out.push(list[idx]); last = idx; }
  }
  return out;
}

/**
 * Midpoint-refine a parameter list. An interval [a,b] splits when EITHER
 *  - the true midpoint deviates from the chord by more than `tol` world units
 *    at any cross-direction probe (feature localized off-center still fires,
 *    because we probe ALL current cross params, capped), OR
 *  - the surface normals at the interval's ends deviate by more than ~15°
 *    (cos < NORMAL_COS_TOL) at any probe — catches high-curvature ridges whose
 *    chord deviation is tiny.
 * `pointAt(t, c)` / `normalAt(t, c)` evaluate at the varying param `t` and the
 * cross-direction param `c`.
 */
function refineParams(
  params: number[],
  probes: number[],
  pointAt: (t: number, cross: number) => Vec3,
  normalAt: (t: number, cross: number) => Vec3,
  tol: number,
  maxDepth: number,
): number[] {
  let list = [...params];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: number[] = [list[0]];
    let split = false;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const mid = (a + b) / 2;
      let need = false;
      for (const c of probes) {
        const pa = pointAt(a, c), pb = pointAt(b, c), pm = pointAt(mid, c);
        const chordMid = pa.add(pb).scale(0.5);
        if (chordMid.distanceTo(pm) > tol) { need = true; break; }
        const na = normalAt(a, c), nb = normalAt(b, c);
        if (na.dot(nb) < NORMAL_COS_TOL) { need = true; break; }
      }
      if (need) { next.push(mid); split = true; }
      next.push(b);
    }
    list = next;
    if (!split) break;
  }
  return list;
}

/** The tessellation grid parameters (us, vs) for a surface + options. */
export function tessParams(s: NSurface, data: SurfaceData): { us: number[]; vs: number[] } {
  const segsU = clampSurfaceSegs(data.tess.segsU);
  const segsV = clampSurfaceSegs(data.tess.segsV);
  let us = paramList(s.nu, s.pu, s.U, segsU);
  let vs = paramList(s.nv, s.pv, s.V, segsV);
  if (data.tess.mode === 'adaptive') {
    const tol = Math.max(1e-5, data.tess.tol);
    // Probe at ALL current cross-direction params (capped, evenly chosen) so a
    // feature localized off-center still triggers refinement. The floor grids
    // are the probe sets (captured before either direction refines) — keeps the
    // two directions independent and the result deterministic.
    const uProbes = pickProbes(us, MAX_PROBES);
    const vProbes = pickProbes(vs, MAX_PROBES);
    us = refineParams(
      us, vProbes,
      (u, v) => surfacePoint(s, u, v),
      (u, v) => surfaceNormal(s, u, v),
      tol, ADAPT_MAX_DEPTH,
    );
    vs = refineParams(
      vs, uProbes,
      (v, u) => surfacePoint(s, u, v),
      (v, u) => surfaceNormal(s, u, v),
      tol, ADAPT_MAX_DEPTH,
    );
  }
  return { us, vs };
}

/** Sample the UV polyline of a trim/surface curve payload (UV control points).
 *  Returns [u,v] pairs; closed loops repeat the first point at the end. */
export function sampleUvLoop(curve: import('../scene/objectData').CurveData, segs = 64): [number, number][] {
  // Trim curves store UV in co[0]/co[1]; evaluate through the curve engine.
  const c = fromCurveData(curve);
  if (!c) return curve.points.map((p) => [p.co[0], p.co[1]] as [number, number]);
  const [lo, hi] = curveDomain(c);
  const out: [number, number][] = [];
  for (let i = 0; i <= segs; i++) {
    const p = curvePoint(c, lo + ((hi - lo) * i) / segs);
    out.push([p.x, p.y]);
  }
  return out;
}

/** Even-odd point-in-polygon in UV space. */
export function pointInLoop(u: number, v: number, loop: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is a UV point kept by the trim set? Outer loops keep their inside; holes
 *  discard theirs. No outer loop → the whole domain minus holes. */
export function uvKept(u: number, v: number, loops: { pts: [number, number][]; hole: boolean }[]): boolean {
  let hasOuter = false;
  let inOuter = false;
  for (const l of loops) {
    if (l.hole) {
      if (pointInLoop(u, v, l.pts)) return false;
    } else {
      hasOuter = true;
      if (pointInLoop(u, v, l.pts)) inOuter = true;
    }
  }
  return hasOuter ? inOuter : true;
}

export interface SurfaceTessResult {
  mesh: EditableMesh;
  /** Grid dimensions actually used (vert grid is (us.length)×(vs.length)). */
  us: number[];
  vs: number[];
}

/** The tessellation grid, resolved once: welded vertex positions + the face
 *  list (dedup'd, trim-classified). Shared by tessellateSurface (which builds
 *  the EditableMesh) and tessStats (which only counts) so neither recomputes
 *  the other's work and both agree exactly. */
interface TessGrid {
  us: number[];
  vs: number[];
  /** Unique welded vertex positions, in first-seen order (== addVert order). */
  positions: Vec3[];
  /** Faces as welded-position indices + their per-corner UVs. */
  faces: { ids: number[]; uvs: [number, number][] }[];
}

/** A sampled trim loop in UV: closed polyline + hole flag. */
interface TrimLoopUv { pts: [number, number][]; hole: boolean }

/** Dense loop sampling for the v2 boundary classifier + snapper. */
const TRIM_LOOP_SEGS = 256;
/** Boundary-cell subdivision (depth-3 2×2 recursion → 8×8 sub-cells). */
const TRIM_SUBDIV = 8;

/** Nearest point on segment (ax,ay)-(bx,by) to (u,v): [px, py, dist]. */
function nearestOnSeg(
  u: number, v: number, ax: number, ay: number, bx: number, by: number,
): [number, number, number] {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((u - ax) * dx + (v - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * dx, py = ay + t * dy;
  return [px, py, Math.hypot(u - px, v - py)];
}

/** Nearest point on ANY loop polyline to (u,v). */
function nearestOnLoops(u: number, v: number, loops: TrimLoopUv[]): { pu: number; pv: number; dist: number } {
  let best = Infinity, bu = u, bv = v;
  for (const l of loops) {
    const pts = l.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [px, py, d] = nearestOnSeg(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < best) { best = d; bu = px; bv = py; }
    }
  }
  return { pu: bu, pv: bv, dist: best };
}

/** Do segments p1-p2 and p3-p4 intersect (proper or touching)? */
function segsIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(x3, y3, x4, y4, x1, y1);
  const d2 = d(x3, y3, x4, y4, x2, y2);
  const d3 = d(x1, y1, x2, y2, x3, y3);
  const d4 = d(x1, y1, x2, y2, x4, y4);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  // Collinear-touch cases are handled by the endpoint-in-rect test upstream.
  return false;
}

/** Does any loop segment cross/touch the axis-aligned cell [u0,u1]×[v0,v1]? */
function loopCrossesCell(loops: TrimLoopUv[], u0: number, u1: number, v0: number, v1: number): boolean {
  for (const l of loops) {
    const pts = l.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
      // Endpoint inside the cell.
      if (ax >= u0 && ax <= u1 && ay >= v0 && ay <= v1) return true;
      if (bx >= u0 && bx <= u1 && by >= v0 && by <= v1) return true;
      // Segment cuts any cell edge.
      if (segsIntersect(ax, ay, bx, by, u0, v0, u1, v0)) return true;
      if (segsIntersect(ax, ay, bx, by, u1, v0, u1, v1)) return true;
      if (segsIntersect(ax, ay, bx, by, u1, v1, u0, v1)) return true;
      if (segsIntersect(ax, ay, bx, by, u0, v1, u0, v0)) return true;
    }
  }
  return false;
}

/** Untrimmed grid build — byte-identical to the v1 output (no trim branch). */
function buildUntrimmedGrid(
  s: NSurface, us: number[], vs: number[],
  ul: number, vl: number, uSpanInv: number, vSpanInv: number,
): TessGrid {
  // Vertex grid, welded exactly: identical positions (collapsed pole rows)
  // share one vert so the mesh is manifold at poles.
  const keyOf = (p: Vec3) => `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}`;
  const weld = new Map<string, number>();
  const positions: Vec3[] = [];
  const grid: number[][] = [];
  for (let i = 0; i < us.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < vs.length; j++) {
      const p = surfacePoint(s, us[i], vs[j]);
      const key = keyOf(p);
      let id = weld.get(key);
      if (id === undefined) {
        id = positions.length;
        positions.push(p);
        weld.set(key, id);
      }
      row.push(id);
    }
    grid.push(row);
  }

  const faces: { ids: number[]; uvs: [number, number][] }[] = [];
  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < vs.length - 1; j++) {
      const ids = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
      const uvs: [number, number][] = [
        [(us[i] - ul) * uSpanInv, (vs[j] - vl) * vSpanInv],
        [(us[i + 1] - ul) * uSpanInv, (vs[j] - vl) * vSpanInv],
        [(us[i + 1] - ul) * uSpanInv, (vs[j + 1] - vl) * vSpanInv],
        [(us[i] - ul) * uSpanInv, (vs[j + 1] - vl) * vSpanInv],
      ];
      // Collapse consecutive duplicate verts (pole cells → triangles).
      const dedupIds: number[] = [];
      const dedupUvs: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        if (ids[k] !== ids[(k + 1) % 4]) {
          dedupIds.push(ids[k]);
          dedupUvs.push(uvs[k]);
        }
      }
      if (new Set(dedupIds).size < 3) continue;
      faces.push({ ids: dedupIds, uvs: dedupUvs });
    }
  }
  return { us, vs, positions, faces };
}

/**
 * Trimmed grid build (NB-C3 v2): full quads for interior cells, refined +
 * edge-snapped sub-cells along the boundary. Verts are welded on demand (by
 * exact 3D position), so no orphan interior verts survive. UVs = normalized
 * domain coords of the POST-SNAP UV position.
 */
function buildTrimmedGrid(
  s: NSurface, us: number[], vs: number[],
  ul: number, vl: number, uSpanInv: number, vSpanInv: number,
  loops: TrimLoopUv[],
): TessGrid {
  const keyOf = (p: Vec3) => `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}`;
  const weld = new Map<string, number>();
  const positions: Vec3[] = [];
  const uvId = (u: number, v: number): number => {
    const p = surfacePoint(s, u, v);
    const key = keyOf(p);
    let id = weld.get(key);
    if (id === undefined) { id = positions.length; positions.push(p); weld.set(key, id); }
    return id;
  };
  const normUV = (u: number, v: number): [number, number] => [(u - ul) * uSpanInv, (v - vl) * vSpanInv];

  // Snap memo, keyed by UV node — guarantees a shared sub-cell corner welds
  // (same snapped UV → same 3D position) and makes the whole build deterministic.
  // Only DISCARD-side corners (a corner poking into the trimmed-away region) are
  // pulled OUT onto the loop; keep-side corners never move inward. This rides the
  // true trim curve without chord-sagging a kept face's centroid across the loop.
  const snapMemo = new Map<string, [number, number]>();
  const snapCorner = (u: number, v: number, diag: number): [number, number] => {
    const key = `${u.toFixed(9)},${v.toFixed(9)}`;
    const hit = snapMemo.get(key);
    if (hit) return hit;
    let res: [number, number] = [u, v];
    if (!uvKept(u, v, loops)) {
      const { pu, pv, dist } = nearestOnLoops(u, v, loops);
      if (dist <= diag) res = [pu, pv];
    }
    snapMemo.set(key, res);
    return res;
  };

  const faces: { ids: number[]; uvs: [number, number][] }[] = [];
  const emit = (corners: [number, number][]): void => {
    // UV signed-area guard: drop inverted / degenerate faces (the snap guard).
    let area2 = 0;
    let cUsum = 0, cVsum = 0;
    for (let k = 0; k < corners.length; k++) {
      const [x1, y1] = corners[k], [x2, y2] = corners[(k + 1) % corners.length];
      area2 += x1 * y2 - x2 * y1;
      cUsum += x1; cVsum += y1;
    }
    if (area2 <= 1e-12) return;
    // Snapping can pull a boundary sub-cell's POST-SNAP centroid a hair across
    // the trim curve; drop any face whose centroid isn't kept so no face lands
    // inside a hole / outside an outer loop.
    if (!uvKept(cUsum / corners.length, cVsum / corners.length, loops)) return;
    const ids = corners.map(([u, v]) => uvId(u, v));
    const uvs = corners.map(([u, v]) => normUV(u, v));
    const dedupIds: number[] = [];
    const dedupUvs: [number, number][] = [];
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] !== ids[(k + 1) % ids.length]) { dedupIds.push(ids[k]); dedupUvs.push(uvs[k]); }
    }
    if (new Set(dedupIds).size < 3) return;
    faces.push({ ids: dedupIds, uvs: dedupUvs });
  };

  for (let i = 0; i < us.length - 1; i++) {
    for (let j = 0; j < vs.length - 1; j++) {
      const u0 = us[i], u1 = us[i + 1], v0 = vs[j], v1 = vs[j + 1];
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const corners: [number, number][] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const keptCorners = corners.map(([u, v]) => uvKept(u, v, loops));
      const keptCenter = uvKept(cu, cv, loops);
      const allKept = keptCenter && keptCorners.every((k) => k);
      const noneKept = !keptCenter && keptCorners.every((k) => !k);

      if (allKept) {
        emit(corners); // whole quad, unsnapped
        continue;
      }
      if (noneKept && !loopCrossesCell(loops, u0, u1, v0, v1)) {
        continue; // fully discarded, loop misses the cell entirely
      }
      // BOUNDARY: uniform 8×8 subdivision; keep sub-cells by center; snap corners.
      const du = (u1 - u0) / TRIM_SUBDIV, dv = (v1 - v0) / TRIM_SUBDIV;
      const diag = Math.hypot(du, dv);
      for (let a = 0; a < TRIM_SUBDIV; a++) {
        for (let b = 0; b < TRIM_SUBDIV; b++) {
          const scu = u0 + (a + 0.5) * du, scv = v0 + (b + 0.5) * dv;
          if (!uvKept(scu, scv, loops)) continue;
          const sc: [number, number][] = [
            snapCorner(u0 + a * du, v0 + b * dv, diag),
            snapCorner(u0 + (a + 1) * du, v0 + b * dv, diag),
            snapCorner(u0 + (a + 1) * du, v0 + (b + 1) * dv, diag),
            snapCorner(u0 + a * du, v0 + (b + 1) * dv, diag),
          ];
          emit(sc);
        }
      }
    }
  }
  return { us, vs, positions, faces };
}

/** Resolve the tessellation grid for a payload (params → welded verts → faces),
 *  without allocating an EditableMesh. Returns null for degenerate payloads. */
function buildTessGrid(data: SurfaceData): TessGrid | null {
  const s = fromSurfaceData(data);
  if (!s) return null;
  const { us, vs } = tessParams(s, data);
  const [ul, uh, vl, vh] = [s.U[s.pu], s.U[s.nu], s.V[s.pv], s.V[s.nv]];
  const uSpanInv = uh - ul === 0 ? 1 : 1 / (uh - ul);
  const vSpanInv = vh - vl === 0 ? 1 : 1 / (vh - vl);

  const trims = data.trims ?? [];
  if (trims.length === 0) {
    return buildUntrimmedGrid(s, us, vs, ul, vl, uSpanInv, vSpanInv);
  }
  const loops: TrimLoopUv[] = trims.map((t) => ({ pts: sampleUvLoop(t.curve, TRIM_LOOP_SEGS), hole: t.hole }));
  return buildTrimmedGrid(s, us, vs, ul, vl, uSpanInv, vSpanInv, loops);
}

/**
 * Tessellate a surface payload to an EditableMesh (quads, per-corner UVs
 * normalized over the domain). Returns an empty mesh for degenerate payloads.
 */
export function tessellateSurface(data: SurfaceData): SurfaceTessResult {
  const mesh = new EditableMesh();
  const grid = buildTessGrid(data);
  if (!grid) return { mesh, us: [], vs: [] };
  // addVert in first-seen order so vertIds line up 1:1 with grid.positions.
  const ids = grid.positions.map((p) => mesh.addVert(p));
  for (const face of grid.faces) {
    const f = mesh.addFace(face.ids.map((i) => ids[i]));
    mesh.setFaceUVs(f, face.uvs);
  }
  return { mesh, us: grid.us, vs: grid.vs };
}

/**
 * Tessellation counts WITHOUT building an EditableMesh: shares buildTessGrid's
 * grid step with tessellateSurface, so `verts`/`faces` match its output exactly.
 * Feeds the Surface tab's live info row. Degenerate payloads report all zeros.
 */
export function tessStats(data: SurfaceData): { verts: number; faces: number; us: number; vs: number } {
  const grid = buildTessGrid(data);
  if (!grid) return { verts: 0, faces: 0, us: 0, vs: 0 };
  return { verts: grid.positions.length, faces: grid.faces.length, us: grid.us.length, vs: grid.vs.length };
}
