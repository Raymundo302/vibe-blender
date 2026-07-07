import { Vec3 } from '../core/math/vec3';
import type { EditableMesh } from '../core/mesh/EditableMesh';

/**
 * Sculpt-lite brush math (P9-7) — pure, GL-free helpers shared by the sculpt
 * stroke operator (InputManager) and the unit tests. Two brushes: Inflate
 * (push verts along their own normal) and Grab (drag captured verts by a
 * screen-plane delta). Both weight their effect by a smooth radial falloff.
 *
 * NOTE ON THE MODE DECISION: sculpt is NOT a separate Scene mode. It lives as a
 * TOOL toggle inside Edit Mode (Blender's edit mesh is exactly the base mesh the
 * spec asks brushes to touch), gated by this module-level `sculptState`
 * singleton — the same pattern the codebase already uses for `proportional`,
 * `snapState` and `xrayState`. This keeps Scene.ts untouched (mode plumbing
 * would NOT have stayed tiny) while still being honest: the topbar chip reads
 * "Sculpt · inflate/grab" and LMB-drag brushes instead of selecting.
 */

export type SculptTool = 'none' | 'inflate' | 'grab';

export interface SculptSettings {
  /** Active brush, or 'none' when the sculpt tool is off. */
  tool: SculptTool;
  /** Brush radius in the edit object's LOCAL units (verts are local). */
  radius: number;
  /** Fixed brush strength (0..1) — max per-dab displacement fraction. */
  strength: number;
}
export const sculptState: SculptSettings = { tool: 'none', radius: 0.5, strength: 0.5 };

/**
 * Smooth radial falloff. `t = 1 − d/radius` clamped to [0,1]; weight = 3t²−2t³
 * (the same "Smooth" curve proportional editing uses). d=0 → 1 (max at center),
 * d=radius → 0, d=radius/2 → 0.5, beyond radius → 0. Monotone decreasing in d.
 */
export function sculptFalloff(d: number, radius: number): number {
  if (radius <= 0) return d <= 0 ? 1 : 0;
  const t = 1 - d / radius;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Falloff weight for every vert within `radius` (local-space distance) of
 * `center`. Verts at or beyond the radius (weight 0) are omitted so callers can
 * iterate only the affected set.
 */
export function brushWeights(mesh: EditableMesh, center: Vec3, radius: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, v] of mesh.verts) {
    const w = sculptFalloff(v.co.distanceTo(center), radius);
    if (w > 0) out.set(id, w);
  }
  return out;
}

/**
 * Per-vertex normals (area-weighted average of incident face normals) for the
 * requested verts. Isolated verts with no faces get ZERO.
 */
export function vertexNormals(mesh: EditableMesh, ids: Iterable<number>): Map<number, Vec3> {
  const want = new Set(ids);
  const acc = new Map<number, Vec3>();
  for (const id of want) acc.set(id, Vec3.ZERO);
  for (const f of mesh.faces.values()) {
    if (!f.verts.some((v) => want.has(v))) continue;
    const n = mesh.faceNormal(f.id); // Newell's method, already normalized
    for (const v of f.verts) if (want.has(v)) acc.set(v, acc.get(v)!.add(n));
  }
  const out = new Map<number, Vec3>();
  for (const [id, sum] of acc) {
    const len = sum.length();
    out.set(id, len > 1e-9 ? sum.scale(1 / len) : Vec3.ZERO);
  }
  return out;
}

/**
 * Inflate displacement per vert: OWN vertex normal × strength × falloff weight,
 * negated when `invert` (deflate). Pure — returns the deltas to add to each
 * vert's current position.
 */
export function inflateDeltas(
  mesh: EditableMesh,
  weights: Map<number, number>,
  strength: number,
  invert: boolean,
): Map<number, Vec3> {
  const normals = vertexNormals(mesh, weights.keys());
  const sign = invert ? -1 : 1;
  const out = new Map<number, Vec3>();
  for (const [id, w] of weights) out.set(id, normals.get(id)!.scale(strength * w * sign));
  return out;
}

/**
 * Grab: translate each captured vert from its stroke-start position by
 * `delta × weight`. Verts absent from `weights` (out of radius) are untouched.
 * Pure — returns the new positions.
 */
export function grabPositions(
  startCos: Map<number, Vec3>,
  weights: Map<number, number>,
  delta: Vec3,
): Map<number, Vec3> {
  const out = new Map<number, Vec3>();
  for (const [id, w] of weights) {
    const start = startCos.get(id);
    if (start) out.set(id, start.add(delta.scale(w)));
  }
  return out;
}

/** Möller–Trumbore ray/triangle: returns the ray parameter t (>0) or null. */
function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = b.sub(a);
  const e2 = c.sub(a);
  const p = d.cross(e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-9) return null; // parallel
  const inv = 1 / det;
  const tvec = o.sub(a);
  const u = tvec.dot(p) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const q = tvec.cross(e1);
  const v = d.dot(q) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = e2.dot(q) * inv;
  return t > 1e-6 ? t : null;
}

/**
 * Nearest ray hit against the mesh (fan-triangulated faces), in the mesh's
 * LOCAL space — the caller transforms the pointer ray into local first. Returns
 * the hit point + owning face id, or null on a miss.
 */
export function raycastMeshLocal(
  mesh: EditableMesh,
  origin: Vec3,
  dir: Vec3,
): { point: Vec3; faceId: number; dist: number } | null {
  let bestT = Infinity;
  let bestFace = -1;
  for (const f of mesh.faces.values()) {
    const vs = f.verts;
    if (vs.length < 3) continue;
    const a = mesh.verts.get(vs[0])!.co;
    for (let i = 1; i < vs.length - 1; i++) {
      const b = mesh.verts.get(vs[i])!.co;
      const c = mesh.verts.get(vs[i + 1])!.co;
      const t = rayTriangle(origin, dir, a, b, c);
      if (t !== null && t < bestT) { bestT = t; bestFace = f.id; }
    }
  }
  if (bestFace < 0) return null;
  return { point: origin.add(dir.scale(bestT)), faceId: bestFace, dist: bestT };
}

/**
 * Build the brush-cursor circle as a flat [x,y,z, x,y,z, ...] line-segment
 * buffer (for renderer.editPreviewLines), centered at `center`, in the plane
 * perpendicular to `forward` (all in the edit object's LOCAL space).
 */
export function buildBrushCircle(center: Vec3, radius: number, forward: Vec3, segments = 48): Float32Array {
  const f = forward.normalize();
  const ref = Math.abs(f.y) < 0.9 ? Vec3.Y : Vec3.X;
  const u = ref.cross(f).normalize();
  const v = f.cross(u).normalize();
  const out = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = center.add(u.scale(Math.cos(a0) * radius)).add(v.scale(Math.sin(a0) * radius));
    const p1 = center.add(u.scale(Math.cos(a1) * radius)).add(v.scale(Math.sin(a1) * radius));
    out.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
  }
  return out;
}
