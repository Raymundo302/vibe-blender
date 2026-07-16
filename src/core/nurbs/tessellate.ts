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
 * TRIMS: when data.trims is non-empty, cells are classified against the trim
 * loops in UV space — a v1 whole-cell classification (kept cells must have all
 * corners inside the kept region). NB-C3 replaces this with boundary-following
 * triangulation; the entry point + loop sampling here are its interface.
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

/** Resolve the tessellation grid for a payload (params → welded verts → faces),
 *  without allocating an EditableMesh. Returns null for degenerate payloads. */
function buildTessGrid(data: SurfaceData): TessGrid | null {
  const s = fromSurfaceData(data);
  if (!s) return null;
  const { us, vs } = tessParams(s, data);
  const [ul, uh, vl, vh] = [s.U[s.pu], s.U[s.nu], s.V[s.pv], s.V[s.nv]];
  const uSpanInv = uh - ul === 0 ? 1 : 1 / (uh - ul);
  const vSpanInv = vh - vl === 0 ? 1 : 1 / (vh - vl);

  // Trim loops sampled once (v1 cell classification; NB-C3 upgrades).
  const loops = (data.trims ?? []).map((t) => ({ pts: sampleUvLoop(t.curve), hole: t.hole }));

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
      if (loops.length) {
        // v1 trim: keep the cell only when all four corners are kept.
        const corners: [number, number][] = [
          [us[i], vs[j]], [us[i + 1], vs[j]], [us[i + 1], vs[j + 1]], [us[i], vs[j + 1]],
        ];
        if (!corners.every(([u, v]) => uvKept(u, v, loops))) continue;
      }
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
