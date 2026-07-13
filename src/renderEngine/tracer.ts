import type { Snapshot, SnapMaterial, SnapLight, SnapCamera, SnapWorld } from './snapshot';
import { defaultSnapWorld } from './snapshot';
import { sampleEquirect } from '../core/scene/worldData';
import { gradientT, type GradientInput } from '../core/scene/objectData';
import { evaluateGraph } from '../core/nodes/evaluate';
// Register all node defs so the graph evaluates inside the tracer WORKER bundle.
import '../core/nodes/builtins';

/**
 * Pure progressive path tracer (P8-4) — "Cycles-lite". No DOM, no GL: importable
 * in Node for unit tests. Given a plain Snapshot it renders one Monte-Carlo
 * sample per pixel; the Worker accumulates many samples over time.
 *
 * Pipeline per camera ray:
 *   - Möller–Trumbore ray/triangle, traversed through a median-split BVH.
 *   - At each hit: add emission, sample every light directly (shadow rays),
 *     then bounce — cosine-weighted diffuse, or a roughness-jittered mirror
 *     reflection with probability = metallic (documented approximation of a
 *     GGX glossy lobe).
 *   - Glass (UR10-3): a material with transmission > 0 traces a DIELECTRIC BSDF
 *     with probability = transmission. At the hit it picks reflect vs refract by
 *     the real-IOR Fresnel (Schlick), refracts across the interface via Snell
 *     (inside/outside tracked by the geometric-normal flip), handles total
 *     internal reflection, and TINTS transmitted rays by baseColor (Beer-lite:
 *     one multiply per pass-through, NO distance attenuation in v1). Rough glass
 *     (roughness > 0) jitters the chosen direction with the same GGX-ish lobe as
 *     metal — a cheap frosted look, documented as an approximation. The diffuse
 *     direct-light + emitter-NEE contribution is weighted by (1 − transmission)
 *     so full glass shows no diffuse sheen. GLASS BLOCKS SHADOW RAYS LIKE AN
 *     OPAQUE surface (its tris stay in the BVH) — a standard cheap v1 choice; no
 *     transparent shadows / caustics yet (revisit with NEE-aware transmission).
 *   - Max depth 4, Russian roulette after depth 2.
 *   - Misses return the sky gradient so unlit scenes aren't a void.
 *
 * Determinism: all randomness comes from a seeded mulberry32 RNG. Same snapshot
 * + seed → identical image (no Math.random anywhere).
 */

const MAX_DEPTH = 4;
const EPS = 1e-4;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — fast, deterministic, good enough for MC sampling.
// ---------------------------------------------------------------------------
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Ray / triangle — Möller–Trumbore.
// ---------------------------------------------------------------------------

/** Scratch hit record filled by intersectTri (avoids per-hit allocation). */
interface TriHit {
  t: number;
  u: number;
  v: number;
  /** Geometric normal = normalize(e1 × e2) (unnormalized cross's direction). */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Core Möller–Trumbore. Returns hit distance t (> 0) or -1 on miss, filling
 * `out` with barycentrics + geometric normal. When `cull` is true, triangles
 * whose front face points away from the ray (back faces) miss.
 */
function intersectTri(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  cull: boolean,
  out: TriHit,
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  // p = d × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (cull) {
    if (det < 1e-12) return -1;
  } else if (det > -1e-12 && det < 1e-12) {
    return -1;
  }
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  // q = t × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= EPS) return -1;
  out.t = t;
  out.u = u;
  out.v = v;
  out.nx = e1y * e2z - e1z * e2y;
  out.ny = e1z * e2x - e1x * e2z;
  out.nz = e1x * e2y - e1y * e2x;
  return t;
}

/** Vec3-friendly Möller–Trumbore for unit tests. Returns null on miss. */
export function moellerTrumbore(
  orig: readonly [number, number, number],
  dir: readonly [number, number, number],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  cull = false,
): { t: number; u: number; v: number } | null {
  const out: TriHit = { t: 0, u: 0, v: 0, nx: 0, ny: 0, nz: 0 };
  const t = intersectTri(
    orig[0], orig[1], orig[2], dir[0], dir[1], dir[2],
    a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], cull, out,
  );
  return t < 0 ? null : { t: out.t, u: out.u, v: out.v };
}

// ---------------------------------------------------------------------------
// BVH — median split on centroid along the widest axis, leaf ≤ 4 tris.
// ---------------------------------------------------------------------------

export interface BVHNode {
  min: [number, number, number];
  max: [number, number, number];
  left: BVHNode | null;
  right: BVHNode | null;
  /** Triangle indices (into the tris array) — non-null only for leaves. */
  tris: number[] | null;
}

const LEAF_SIZE = 4;

export function buildBVH(tris: Float32Array): BVHNode {
  const count = (tris.length / 9) | 0;
  const indices: number[] = new Array(count);
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = i;
    const o = i * 9;
    cx[i] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3;
    cy[i] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3;
    cz[i] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
  }

  function bounds(idx: number[]): { min: [number, number, number]; max: [number, number, number] } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const i of idx) {
      const o = i * 9;
      for (let k = 0; k < 3; k++) {
        const x = tris[o + k * 3], y = tris[o + k * 3 + 1], z = tris[o + k * 3 + 2];
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      }
    }
    return { min, max };
  }

  function build(idx: number[]): BVHNode {
    const { min, max } = bounds(idx);
    if (idx.length <= LEAF_SIZE) {
      return { min, max, left: null, right: null, tris: idx };
    }
    // Widest centroid axis.
    let cmin: [number, number, number] = [Infinity, Infinity, Infinity];
    let cmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const i of idx) {
      const c = [cx[i], cy[i], cz[i]];
      for (let k = 0; k < 3; k++) {
        if (c[k] < cmin[k]) cmin[k] = c[k];
        if (c[k] > cmax[k]) cmax[k] = c[k];
      }
    }
    let axis = 0;
    const ext = [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]];
    if (ext[1] > ext[axis]) axis = 1;
    if (ext[2] > ext[axis]) axis = 2;
    const c = axis === 0 ? cx : axis === 1 ? cy : cz;
    const sorted = idx.slice().sort((p, q) => c[p] - c[q]);
    const mid = sorted.length >> 1;
    let leftIdx = sorted.slice(0, mid);
    let rightIdx = sorted.slice(mid);
    // Degenerate split (all centroids coincident) → force a leaf.
    if (leftIdx.length === 0 || rightIdx.length === 0) {
      return { min, max, left: null, right: null, tris: idx };
    }
    return { min, max, left: build(leftIdx), right: build(rightIdx), tris: null };
  }

  return build(indices);
}

/** Slab test: does the ray hit the AABB before tMax? */
function hitAABB(
  node: BVHNode,
  ox: number, oy: number, oz: number,
  idx: number, idy: number, idz: number,
  tMax: number,
): boolean {
  let t0 = EPS, t1 = tMax;
  let a = (node.min[0] - ox) * idx, b = (node.max[0] - ox) * idx;
  if (a > b) { const s = a; a = b; b = s; }
  if (a > t0) t0 = a; if (b < t1) t1 = b;
  a = (node.min[1] - oy) * idy; b = (node.max[1] - oy) * idy;
  if (a > b) { const s = a; a = b; b = s; }
  if (a > t0) t0 = a; if (b < t1) t1 = b;
  a = (node.min[2] - oz) * idz; b = (node.max[2] - oz) * idz;
  if (a > b) { const s = a; a = b; b = s; }
  if (a > t0) t0 = a; if (b < t1) t1 = b;
  return t0 <= t1;
}

/** Nearest-hit result for a full-scene intersection. */
export interface SceneHit {
  t: number;
  tri: number;
  u: number;
  v: number;
  /** Geometric normal (normalized). */
  nx: number;
  ny: number;
  nz: number;
}

const _scratch: TriHit = { t: 0, u: 0, v: 0, nx: 0, ny: 0, nz: 0 };

/** Nearest hit via BVH traversal. Returns null on miss. */
export function intersectBVH(
  root: BVHNode,
  tris: Float32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax = Infinity,
): SceneHit | null {
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let best = tMax;
  let hit: SceneHit | null = null;
  const stack: BVHNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!hitAABB(node, ox, oy, oz, idx, idy, idz, best)) continue;
    if (node.tris) {
      for (const i of node.tris) {
        const o = i * 9;
        const t = intersectTri(
          ox, oy, oz, dx, dy, dz,
          tris[o], tris[o + 1], tris[o + 2],
          tris[o + 3], tris[o + 4], tris[o + 5],
          tris[o + 6], tris[o + 7], tris[o + 8],
          false, _scratch,
        );
        if (t > 0 && t < best) {
          best = t;
          const inv = 1 / Math.hypot(_scratch.nx, _scratch.ny, _scratch.nz);
          hit = {
            t, tri: i, u: _scratch.u, v: _scratch.v,
            nx: _scratch.nx * inv, ny: _scratch.ny * inv, nz: _scratch.nz * inv,
          };
        }
      }
    } else {
      if (node.left) stack.push(node.left);
      if (node.right) stack.push(node.right);
    }
  }
  return hit;
}

/** Brute-force nearest hit — reference for the BVH-equivalence unit test. */
export function intersectBruteForce(
  tris: Float32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax = Infinity,
): SceneHit | null {
  const count = (tris.length / 9) | 0;
  let best = tMax;
  let hit: SceneHit | null = null;
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const t = intersectTri(
      ox, oy, oz, dx, dy, dz,
      tris[o], tris[o + 1], tris[o + 2],
      tris[o + 3], tris[o + 4], tris[o + 5],
      tris[o + 6], tris[o + 7], tris[o + 8],
      false, _scratch,
    );
    if (t > 0 && t < best) {
      best = t;
      const inv = 1 / Math.hypot(_scratch.nx, _scratch.ny, _scratch.nz);
      hit = {
        t, tri: i, u: _scratch.u, v: _scratch.v,
        nx: _scratch.nx * inv, ny: _scratch.ny * inv, nz: _scratch.nz * inv,
      };
    }
  }
  return hit;
}

/** Any-hit shadow test: is something within [EPS, maxDist) along the ray? */
export function occluded(
  root: BVHNode,
  tris: Float32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): boolean {
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  const stack: BVHNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!hitAABB(node, ox, oy, oz, idx, idy, idz, maxDist)) continue;
    if (node.tris) {
      for (const i of node.tris) {
        const o = i * 9;
        const t = intersectTri(
          ox, oy, oz, dx, dy, dz,
          tris[o], tris[o + 1], tris[o + 2],
          tris[o + 3], tris[o + 4], tris[o + 5],
          tris[o + 6], tris[o + 7], tris[o + 8],
          false, _scratch,
        );
        if (t > EPS && t < maxDist - EPS) return true;
      }
    } else {
      if (node.left) stack.push(node.left);
      if (node.right) stack.push(node.right);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shading.
// ---------------------------------------------------------------------------

/** Build an orthonormal basis (t1, t2) around a unit vector n (Duff et al.). */
function onbBasis(
  nx: number, ny: number, nz: number,
  t1: [number, number, number],
  t2: [number, number, number],
): void {
  const sign = nz >= 0 ? 1 : -1;
  const aa = -1 / (sign + nz);
  const bb = nx * ny * aa;
  t1[0] = 1 + sign * nx * nx * aa; t1[1] = sign * bb; t1[2] = -sign * nx;
  t2[0] = bb; t2[1] = sign + ny * ny * aa; t2[2] = -ny;
}

const _b1: [number, number, number] = [0, 0, 0];
const _b2: [number, number, number] = [0, 0, 0];

/**
 * Direct lighting at a surface point with normal N and diffuse albedo. Mirrors
 * renderedPass: point/spot radiance = energy/d² (× spot cone), sun radiance =
 * energy; diffuse BRDF = albedo/π; shadow rays gate every light.
 *
 * Soft shadows (P9-4): when `rng` is supplied AND a light has radius > 0, the
 * shadow ray targets a random point on the emitter instead of its center —
 * point/spot sample a sphere of that radius, the sun jitters its direction
 * within a cone of that angular radius. With radius 0 (or no rng) NO random
 * numbers are drawn and the center is used, so the result is byte-identical to
 * the hard-shadow path.
 *
 * Area lights (type 3, UR10-1): a rectangle emitter sampled at a uniform-random
 * point per shadow ray (its center when no rng); one-sided along the aim face
 * normal; received radiance = energy·cosθ_light/d² (see the area branch).
 *
 * `wrap` (0..1) softens the NdotL term toward (NdotL+1)/2 — the cheap wrapped-
 * diffuse used for the subsurface approximation. It is energy-normalized:
 * nl = max(0, (NdotL + wrap) / (1 + wrap)).
 *
 * Exported for the unit tests (point-light falloff, sun direction, occlusion →
 * black, penumbra).
 */
export function directLighting(
  root: BVHNode | null,
  tris: Float32Array,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  albedo: readonly [number, number, number],
  lights: SnapLight[],
  out: [number, number, number] = [0, 0, 0],
  rng?: Rng,
  wrap = 0,
  /** Normal used only to offset the shadow-ray origin (self-shadow bias). When
   * the shading normal is map-perturbed the caller passes the GEOMETRIC normal
   * here so bias stays stable; omitted → the shading normal (bit-identical to
   * the pre-P13 path and to every existing caller/test). */
  offN?: readonly [number, number, number],
): [number, number, number] {
  out[0] = 0; out[1] = 0; out[2] = 0;
  const onx = offN ? offN[0] : nx;
  const ony = offN ? offN[1] : ny;
  const onz = offN ? offN[2] : nz;
  for (const l of lights) {
    const radius = l.radius ?? 0;
    const soft = rng !== undefined && radius > 0;
    let lx: number, ly: number, lz: number, dist: number;
    let rr: number, rg: number, rb: number;
    if (l.type === 3) {
      // Area light (UR10-1): a rectangle emitter in the light's local XY plane,
      // emitting along its face normal = the aim direction (local -Z). Sample a
      // uniform-random point on the rect per shadow ray (center when no rng, so
      // the result stays deterministic for tests) — progressive spp accumulates
      // many samples → soft penumbrae for free.
      const dx = l.direction[0], dy = l.direction[1], dz = l.direction[2];
      let ex = l.position[0], ey = l.position[1], ez = l.position[2];
      if (rng !== undefined) {
        const ux = l.uAxis?.[0] ?? 1, uy = l.uAxis?.[1] ?? 0, uz = l.uAxis?.[2] ?? 0;
        const vx = l.vAxis?.[0] ?? 0, vy = l.vAxis?.[1] ?? 1, vz = l.vAxis?.[2] ?? 0;
        const su = (rng() - 0.5) * (l.width ?? 1);
        const sv = (rng() - 0.5) * (l.height ?? 1);
        ex += ux * su + vx * sv;
        ey += uy * su + vy * sv;
        ez += uz * su + vz * sv;
      }
      lx = ex - px; ly = ey - py; lz = ez - pz;
      const d2 = lx * lx + ly * ly + lz * lz;
      dist = Math.sqrt(d2);
      const inv = 1 / dist;
      lx *= inv; ly *= inv; lz *= inv;
      // One-sided emission: the rect lights only the half-space in front of its
      // -Z face. cosθ_light = dot(emitter→surface, face normal) = -(L·direction).
      // A shading point behind the face (cosLight ≤ 0) gets zero contribution.
      const cosLight = -(lx * dx + ly * dy + lz * dz);
      if (cosLight <= 0) continue;
      // Solid-angle / pdf weighting: sampling a point uniformly on the rect
      // (pdf = 1/A) turns the emitted radiance Le = energy/(w·h) into a received
      // radiance Le·A·cosθ_light/d² — the area A cancels, leaving
      // energy·cosθ_light/d² (energy already = color·power/4π, matching a point
      // light's premultiply so an area light of the same power reads at a similar
      // brightness). Bigger rects only soften shadows, not overall brightness.
      const f = cosLight / Math.max(d2, 1e-6);
      rr = l.energy[0] * f; rg = l.energy[1] * f; rb = l.energy[2] * f;
    } else if (l.type === 1) {
      // sun: L points toward the light = -direction, no falloff.
      lx = -l.direction[0]; ly = -l.direction[1]; lz = -l.direction[2];
      const inv = 1 / Math.hypot(lx, ly, lz);
      lx *= inv; ly *= inv; lz *= inv;
      if (soft) {
        // Jitter within a cone of angular radius `radius` about L.
        const cosMax = Math.cos(radius);
        const cosT = 1 - rng!() * (1 - cosMax);
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi = 2 * Math.PI * rng!();
        onbBasis(lx, ly, lz, _b1, _b2);
        const cx = Math.cos(phi) * sinT, cy = Math.sin(phi) * sinT;
        lx = cx * _b1[0] + cy * _b2[0] + cosT * lx;
        ly = cx * _b1[1] + cy * _b2[1] + cosT * ly;
        lz = cx * _b1[2] + cy * _b2[2] + cosT * lz;
      }
      dist = Infinity;
      rr = l.energy[0]; rg = l.energy[1]; rb = l.energy[2];
    } else {
      // Emitter point: center, or a random point on its sphere when soft.
      let ex = l.position[0], ey = l.position[1], ez = l.position[2];
      if (soft) {
        const z = 2 * rng!() - 1;
        const rp = Math.sqrt(Math.max(0, 1 - z * z));
        const phi = 2 * Math.PI * rng!();
        ex += radius * rp * Math.cos(phi);
        ey += radius * rp * Math.sin(phi);
        ez += radius * z;
      }
      lx = ex - px; ly = ey - py; lz = ez - pz;
      const d2 = lx * lx + ly * ly + lz * lz;
      dist = Math.sqrt(d2);
      const inv = 1 / dist;
      lx *= inv; ly *= inv; lz *= inv;
      const f = 1 / Math.max(d2, 1e-6);
      rr = l.energy[0] * f; rg = l.energy[1] * f; rb = l.energy[2] * f;
      if (l.type === 2) {
        // spot cone: cos of angle between -L and aim direction.
        const cd = -(lx * l.direction[0] + ly * l.direction[1] + lz * l.direction[2]);
        const s = smoothstep(l.cosOuter, l.cosInner, cd);
        rr *= s; rg *= s; rb *= s;
      }
    }
    const ndotl = nx * lx + ny * ly + nz * lz;
    const nl = wrap > 0 ? Math.max(0, (ndotl + wrap) / (1 + wrap)) : ndotl;
    if (nl <= 0) continue;
    // Shadow ray from just above the surface toward the sampled emitter point.
    if (root && occluded(root, tris, px + onx * EPS, py + ony * EPS, pz + onz * EPS, lx, ly, lz, dist)) {
      continue;
    }
    const k = nl / Math.PI;
    out[0] += albedo[0] * rr * k;
    out[1] += albedo[1] * rg * k;
    out[2] += albedo[2] * rb * k;
  }
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Legacy vertical sky gradient: dark grey ground → blue-grey up. Kept as the
 * reference the default-world regression test pins against; the live tracer now
 * calls worldSky() (which, for the default gradient world, is byte-identical).
 */
export function sky(dy: number, out: [number, number, number]): void {
  const t = Math.min(1, Math.max(0, dy * 0.5 + 0.5));
  out[0] = 0.05 + (0.11 - 0.05) * t;
  out[1] = 0.05 + (0.13 - 0.05) * t;
  out[2] = 0.05 + (0.16 - 0.05) * t;
}

/**
 * World/environment color for a ray that missed all geometry, along direction
 * (dx,dy,dz) (need not be normalized). Multiplied by world.strength.
 *
 *   flat     → the flat color.
 *   gradient → horizon→zenith lerp on t = clamp(dz*0.5+0.5) — with the DEFAULT
 *              world this exactly reproduces the old sky() (regression bar).
 *   hdri     → equirect lookup; falls back to the gradient if pixels are absent.
 */
export function worldSky(
  world: SnapWorld,
  dx: number, dy: number, dz: number,
  out: [number, number, number],
): void {
  const s = world.strength;
  if (world.mode === 0) {
    out[0] = world.color[0] * s;
    out[1] = world.color[1] * s;
    out[2] = world.color[2] * s;
    return;
  }
  if (world.mode === 2 && world.hdri) {
    sampleEquirect(world.hdri, dx, dy, dz, out);
    out[0] *= s; out[1] *= s; out[2] *= s;
    return;
  }
  // gradient (also the hdri-without-pixels fallback). traceRay passes a unit
  // direction; elevation = dz in the Z-up world.
  const t = Math.min(1, Math.max(0, dz * 0.5 + 0.5));
  out[0] = (world.horizon[0] + (world.zenith[0] - world.horizon[0]) * t) * s;
  out[1] = (world.horizon[1] + (world.zenith[1] - world.horizon[1]) * t) * s;
  out[2] = (world.horizon[2] + (world.zenith[2] - world.horizon[2]) * t) * s;
}

// ---------------------------------------------------------------------------
// Base-color textures (P11) — sampled through per-corner UVs, multiplied into
// the material's albedo. Deterministic, no RNG. Mirrors the renderedPass GLSL:
// checker = 8×8 parity (even → 0.2 dark, odd → 1.0 light); image = bilinear.
// ---------------------------------------------------------------------------

/** Bilinear, clamp-to-edge sample of a decoded image into `out` (linear RGB). */
export function sampleImageBilinear(
  img: { width: number; height: number; pixels: Float32Array },
  u: number, v: number,
  out: [number, number, number],
): void {
  const { width: w, height: h, pixels } = img;
  const fx = u * w - 0.5, fy = v * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const cx = (x: number) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  const at = (x: number, y: number, k: number) => pixels[(cy(y) * w + cx(x)) * 3 + k];
  for (let k = 0; k < 3; k++) {
    const a = at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx;
    const b = at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx;
    out[k] = a * (1 - ty) + b * ty;
  }
}

/**
 * Bilinear, clamp-to-edge sample of an image's ALPHA channel (UR8-3 cutout).
 * Returns 1 (opaque) when the image has no decoded alpha array. Pure.
 */
export function sampleImageAlphaBilinear(
  img: { width: number; height: number; alpha?: Float32Array },
  u: number, v: number,
): number {
  const a = img.alpha;
  if (!a) return 1;
  const { width: w, height: h } = img;
  const fx = u * w - 0.5, fy = v * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const cx = (x: number) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  const at = (x: number, y: number) => a[cy(y) * w + cx(x)];
  const t = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return t * (1 - ty) + b * ty;
}

/**
 * Texture multiplier for a material at UV (u,v): [1,1,1] for 'none' (or an image
 * material with no decoded pixels). Exported for the unit tests.
 */
export function sampleMaterialTexture(
  mat: SnapMaterial,
  u: number, v: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  if (mat.texKind === 'checker') {
    const sum = Math.floor(u * 8) + Math.floor(v * 8);
    const s = ((sum % 2) + 2) % 2 === 0 ? 0.2 : 1.0;
    out[0] = s; out[1] = s; out[2] = s;
  } else if (mat.texKind === 'image' && mat.texImage) {
    sampleImageBilinear(mat.texImage, u, v, out);
  } else {
    out[0] = 1; out[1] = 1; out[2] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normal / bump + roughness / metallic maps (P13-1). Data maps: the decoded
// pixels are RAW 0..1 (NOT sRGB), sampled bilinearly like the base-color path.
// The math mirrors renderedPass.ts's GLSL so the tracer visually agrees with
// the Rendered viewport: tangent-space normal maps (xy scaled by strength),
// bump = height map via central-difference gradient (× strength × 4), rough /
// metal maps MULTIPLY the scalar params (rough clamped to ≥ 0.04).
// ---------------------------------------------------------------------------

/**
 * Per-triangle tangent frame at a hit. Builds the tangent T from the triangle's
 * edge vectors and per-corner UV deltas, orthonormalizes it against the shading
 * normal N, and sets the bitangent B = N × T (matching the GLSL). Returns false
 * (perturbation skipped) when the UV mapping is degenerate (|det| < 1e-12) or T
 * collapses after orthonormalization. p0/p1/p2 are the corner positions,
 * uv0/uv1/uv2 their UVs, in the tris/triUV corner order.
 */
export function tangentFrame(
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
  uv0: readonly [number, number],
  uv1: readonly [number, number],
  uv2: readonly [number, number],
  N: readonly [number, number, number],
  outT: [number, number, number],
  outB: [number, number, number],
): boolean {
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
  const du1 = uv1[0] - uv0[0], dv1 = uv1[1] - uv0[1];
  const du2 = uv2[0] - uv0[0], dv2 = uv2[1] - uv0[1];
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  let tx = (e1x * dv2 - e2x * dv1) * inv;
  let ty = (e1y * dv2 - e2y * dv1) * inv;
  let tz = (e1z * dv2 - e2z * dv1) * inv;
  // Orthonormalize T against N (Gram–Schmidt).
  const d = tx * N[0] + ty * N[1] + tz * N[2];
  tx -= N[0] * d; ty -= N[1] * d; tz -= N[2] * d;
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-12) return false;
  const tinv = 1 / tl;
  tx *= tinv; ty *= tinv; tz *= tinv;
  outT[0] = tx; outT[1] = ty; outT[2] = tz;
  // B = N × T.
  outB[0] = N[1] * tz - N[2] * ty;
  outB[1] = N[2] * tx - N[0] * tz;
  outB[2] = N[0] * ty - N[1] * tx;
  return true;
}

/**
 * Tangent-space normal map: decode sample (raw 0..1 RGB) to [-1,1], scale xy by
 * strength, clamp z to ≥ 0.05, transform into world by the TBN frame, normalize.
 * Writes the perturbed shading normal into `out`.
 */
export function applyNormalMap(
  sample: readonly [number, number, number],
  strength: number,
  T: readonly [number, number, number],
  B: readonly [number, number, number],
  N: readonly [number, number, number],
  out: [number, number, number],
): void {
  const nx = (sample[0] * 2 - 1) * strength;
  const ny = (sample[1] * 2 - 1) * strength;
  const nz = Math.max(sample[2] * 2 - 1, 0.05);
  const rx = T[0] * nx + B[0] * ny + N[0] * nz;
  const ry = T[1] * nx + B[1] * ny + N[1] * nz;
  const rz = T[2] * nx + B[2] * ny + N[2] * nz;
  const inv = 1 / Math.max(1e-12, Math.hypot(rx, ry, rz));
  out[0] = rx * inv; out[1] = ry * inv; out[2] = rz * inv;
}

/**
 * Bump (height) map: the caller supplies the central-difference height gradient
 * (gx = hR - hL, gy = hU - hD). We scale it by strength × 4 and tilt N along
 * -T*gx - B*gy, then normalize — exactly the GLSL bump branch. Writes `out`.
 */
export function applyBumpMap(
  gx: number,
  gy: number,
  strength: number,
  T: readonly [number, number, number],
  B: readonly [number, number, number],
  N: readonly [number, number, number],
  out: [number, number, number],
): void {
  const sx = gx * strength * 4;
  const sy = gy * strength * 4;
  const rx = N[0] - T[0] * sx - B[0] * sy;
  const ry = N[1] - T[1] * sx - B[1] * sy;
  const rz = N[2] - T[2] * sx - B[2] * sy;
  const inv = 1 / Math.max(1e-12, Math.hypot(rx, ry, rz));
  out[0] = rx * inv; out[1] = ry * inv; out[2] = rz * inv;
}

// ---------------------------------------------------------------------------
// Emissive mesh lights (UR10-2 Part A) — next-event estimation.
//
// Every triangle whose material has emissiveStrength > 0 (flat emissive only —
// node-graph emission keeps the old bounce-found glow, documented) becomes a
// SAMPLED area light: an area-weighted CDF over the emitter triangles is built
// once at prepareScene time, and at each diffuse shading point one emitter point
// is sampled directly (shadow-ray gated) so a glowing plane converges to a soft,
// room-filling illumination instead of relying on a lucky diffuse bounce.
//
// Double-count avoidance uses the classic "skip emitter radiance on NEE-sampled
// bounces" bookkeeping (NOT full MIS): emission is added on a bounce hit only
// when the previous bounce was specular/mirror (where NEE could not sample the
// light) or on the camera ray; after a diffuse/SSS bounce the emission is already
// accounted for by the NEE at that vertex, so it is not added again.
// ---------------------------------------------------------------------------

/** Prebuilt emitter list for NEE: triangle indices, an area CDF, and per-emitter
 *  radiance (emissive × strength). null when the scene has no emissive geometry. */
export interface EmitterList {
  /** Triangle indices (into TraceScene.tris) of the emitter triangles. */
  tris: Int32Array;
  /** Cumulative NORMALIZED area, ascending, last entry = 1. Parallel to `tris`. */
  cdf: Float32Array;
  /** Emitted radiance per emitter (3 floats each), parallel to `tris`. For flat
   *  emissive materials this is emissive × strength; for emit (shadeless) surfaces
   *  it is baseColor × strength (a REPRESENTATIVE constant — sampleEmitters
   *  overrides it with the per-point color socket eval when texUV/materials are
   *  supplied, so a TEXTURED emit surface tints the room per pixel). */
  radiance: Float32Array;
  /** Material index (into TraceScene.materials) per emitter, parallel to `tris`.
   *  Lets sampleEmitters evaluate a textured/gradient emit surface's color socket
   *  at the sampled point (UR16-4). */
  matIdx: Int32Array;
  /** Sum of all emitter triangle areas (world units²). */
  totalArea: number;
}

/**
 * Build the emitter CDF from the scene triangles + materials. Returns null when
 * no triangle carries flat emission (so the tracer's NEE + emission-gating stay
 * completely off and non-emissive renders are byte-identical). Exported for the
 * emitter-sampling unit test.
 */
export function buildEmitters(
  tris: Float32Array,
  triMat: Int32Array,
  materials: SnapMaterial[],
): EmitterList | null {
  const idx: number[] = [];
  const areas: number[] = [];
  const rad: number[] = [];
  const mats: number[] = [];
  const count = (tris.length / 9) | 0;
  let total = 0;
  for (let t = 0; t < count; t++) {
    const mi = triMat[t];
    const m = materials[mi] ?? materials[0];
    // Node-graph emission is per-hit-evaluated → not an analytic mesh light.
    if (!m || m.nodeGraph) continue;
    let er: number, eg: number, eb: number;
    if (m.shadeless) {
      // UR16-4: an emit (shadeless) surface is a mesh light. Its representative
      // radiance is baseColor × strength; a textured/gradient emit surface's actual
      // per-point color is evaluated in sampleEmitters (this constant only sets the
      // CDF magnitude + the flat-color fallback). An image emit plane has baseColor
      // [1,1,1] here, so it is never area-culled to zero.
      const es = m.emitScale ?? 1;
      if (es <= 0) continue;
      er = m.baseColor[0] * es; eg = m.baseColor[1] * es; eb = m.baseColor[2] * es;
      // Gradient/textured emit: keep it in the list even if baseColor is dark.
      if (er <= 0 && eg <= 0 && eb <= 0 && !m.colorGradient && (m.texKind ?? 'none') === 'none') continue;
    } else {
      if (m.emissiveStrength <= 0) continue;
      er = m.emissive[0] * m.emissiveStrength;
      eg = m.emissive[1] * m.emissiveStrength;
      eb = m.emissive[2] * m.emissiveStrength;
      if (er <= 0 && eg <= 0 && eb <= 0) continue;
    }
    const o = t * 9;
    const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
    const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.hypot(cx, cy, cz);
    if (!(area > 0)) continue;
    idx.push(t);
    areas.push(area);
    rad.push(er, eg, eb);
    mats.push(mi);
    total += area;
  }
  if (idx.length === 0 || total <= 0) return null;
  const cdf = new Float32Array(idx.length);
  let acc = 0;
  for (let i = 0; i < idx.length; i++) {
    acc += areas[i];
    cdf[i] = acc / total;
  }
  cdf[cdf.length - 1] = 1; // guard float drift
  return {
    tris: Int32Array.from(idx),
    cdf,
    radiance: Float32Array.from(rad),
    matIdx: Int32Array.from(mats),
    totalArea: total,
  };
}

/**
 * One NEE sample of the emitter set at surface point (px,py,pz) with normal
 * (nx,ny,nz) and diffuse albedo. Picks an emitter triangle proportional to area,
 * samples a uniform point on it, and adds the shadow-ray-gated direct
 * contribution into `out` (accumulated, NOT reset). Two-sided emission (matches
 * the emission-on-hit term). Draws exactly 3 rng values, so callers must guard on
 * a non-null emitter list to keep non-emissive scenes' RNG stream identical.
 *
 * Estimator (uniform area pdf = 1/totalArea): contribution =
 *   albedo/π · Le · cosθ_surf · cosθ_light · totalArea / dist².
 * Exported for the emitter unit test.
 */
export function sampleEmitters(
  root: BVHNode | null,
  tris: Float32Array,
  emitters: EmitterList,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  albedo: readonly [number, number, number],
  rng: Rng,
  out: [number, number, number],
  offN?: readonly [number, number, number],
  /** UR16-4: per-point emit color eval. When supplied, a TEXTURED / gradient emit
   *  (shadeless) emitter's radiance is evaluated at the SAMPLED point (its UV /
   *  object-local pos) instead of the constant emitters.radiance — so a screen
   *  showing a half-red/half-blue image tints the room red on one side, blue on the
   *  other. Omitted (unit tests / callers without UVs) → the constant radiance. */
  ptCtx?: { triUV: Float32Array | null; triLocal: Float32Array | null; materials: SnapMaterial[] },
): void {
  // Select an emitter triangle via the area CDF (linear scan — emitter counts are
  // small at demo scale; a binary search is a drop-in if that changes).
  const u = rng();
  const cdf = emitters.cdf;
  let e = 0;
  while (e < cdf.length - 1 && u > cdf[e]) e++;
  const tri = emitters.tris[e];
  const o = tri * 9;
  const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
  const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
  const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
  // Uniform barycentric point on the triangle.
  const r1 = rng(), r2 = rng();
  const su = Math.sqrt(r1);
  const w0 = 1 - su, w1 = su * (1 - r2), w2 = su * r2;
  const sx = ax * w0 + bx * w1 + cx * w2;
  const sy = ay * w0 + by * w1 + cy * w2;
  const sz = az * w0 + bz * w1 + cz * w2;
  // Emitter geometric normal.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let enx = e1y * e2z - e1z * e2y;
  let eny = e1z * e2x - e1x * e2z;
  let enz = e1x * e2y - e1y * e2x;
  const eninv = 1 / Math.max(1e-12, Math.hypot(enx, eny, enz));
  enx *= eninv; eny *= eninv; enz *= eninv;
  // Direction to the sampled point.
  let lx = sx - px, ly = sy - py, lz = sz - pz;
  const d2 = lx * lx + ly * ly + lz * lz;
  const dist = Math.sqrt(d2);
  if (dist < 1e-6) return;
  const inv = 1 / dist;
  lx *= inv; ly *= inv; lz *= inv;
  const cosSurf = nx * lx + ny * ly + nz * lz;
  if (cosSurf <= 0) return;
  // Two-sided emitter: |cos| so a plane lights both half-spaces (matches the
  // emission-on-hit term, which is orientation-agnostic).
  const cosLight = Math.abs(-(lx * enx + ly * eny + lz * enz));
  if (cosLight <= 0) return;
  const onx = offN ? offN[0] : nx;
  const ony = offN ? offN[1] : ny;
  const onz = offN ? offN[2] : nz;
  // Shadow ray toward the point. The ray ORIGIN is offset by EPS along the
  // normal, so its maxDist must be measured FROM THAT OFFSET ORIGIN — using the
  // un-offset `dist` puts the emitter triangle at t ≈ dist − offset·L, which
  // (amplified by 1/cosθ at grazing) drops just inside occluded()'s (maxDist −
  // EPS) margin and falsely self-shadows EVERY emitter-NEE sample (killed all
  // direct emitter lighting). Measuring from the offset origin keeps the emitter
  // exactly at t = occDist so the −EPS margin excludes it, while real occluders
  // in between are still caught. The ESTIMATOR (dist, d2, cosSurf, k) is left
  // computed from the true point P, so lit samples are numerically unchanged.
  const sox = px + onx * EPS, soy = py + ony * EPS, soz = pz + onz * EPS;
  const occDist = Math.hypot(sx - sox, sy - soy, sz - soz);
  if (root && occluded(root, tris, sox, soy, soz, lx, ly, lz, occDist)) {
    return;
  }
  const ro = e * 3;
  const G = (cosSurf * cosLight) / Math.max(d2, 1e-6);
  const k = (G * emitters.totalArea) / Math.PI;
  // Emitter radiance at the sampled point: the constant emitters.radiance, OR — for
  // a TEXTURED / gradient emit surface with per-point context — the color socket
  // evaluated at (w0,w1,w2) on this triangle (UR16-4).
  emitLe[0] = emitters.radiance[ro]; emitLe[1] = emitters.radiance[ro + 1]; emitLe[2] = emitters.radiance[ro + 2];
  const mat = ptCtx ? ptCtx.materials[emitters.matIdx[e]] : undefined;
  if (mat && mat.shadeless) {
    let su = 0, sv = 0, lx = 0, ly = 0, lz = 0;
    if (ptCtx!.triUV) {
      const U = ptCtx!.triUV, uo = tri * 6;
      su = U[uo] * w0 + U[uo + 2] * w1 + U[uo + 4] * w2;
      sv = U[uo + 1] * w0 + U[uo + 3] * w1 + U[uo + 5] * w2;
    }
    if (ptCtx!.triLocal) {
      const L = ptCtx!.triLocal, lo = tri * 9;
      lx = L[lo] * w0 + L[lo + 3] * w1 + L[lo + 6] * w2;
      ly = L[lo + 1] * w0 + L[lo + 4] * w1 + L[lo + 7] * w2;
      lz = L[lo + 2] * w0 + L[lo + 5] * w1 + L[lo + 8] * w2;
    }
    emitColorAtPoint(mat, su, sv, lx, ly, lz, emitLe);
  }
  out[0] += albedo[0] * emitLe[0] * k;
  out[1] += albedo[1] * emitLe[1] * k;
  out[2] += albedo[2] * emitLe[2] * k;
}
/** Scratch for the emit color-socket eval in sampleEmitters (no per-call alloc). */
const emitLe: [number, number, number] = [0, 0, 0];
const emitTexC: [number, number, number] = [0, 0, 0];

/**
 * Emitted radiance of an emit (shadeless) material at a surface point (UR16-4):
 * the COLOR SOCKET evaluated there × the emit strength. Color = the object-space
 * gradient at the local position, else the image/checker texture at (u,v) times
 * baseColor, else the flat baseColor. Writes into `out` and returns it. This is
 * the per-point radiance a TEXTURED emit surface (a screen) contributes to the
 * room — a half-red/half-blue image emits red where u < 0.5 and blue where
 * u ≥ 0.5. Pure; exported for the radiance-at-point unit test.
 */
export function emitColorAtPoint(
  mat: SnapMaterial,
  u: number, v: number,
  lx: number, ly: number, lz: number,
  out: [number, number, number],
): [number, number, number] {
  const es = mat.emitScale ?? 1;
  let cr = mat.baseColor[0], cg = mat.baseColor[1], cb = mat.baseColor[2];
  if (mat.colorGradient) {
    const g = mat.colorGradient;
    const gt = gradientT(g, lx, ly, lz);
    cr = g.a[0] + (g.b[0] - g.a[0]) * gt;
    cg = g.a[1] + (g.b[1] - g.a[1]) * gt;
    cb = g.a[2] + (g.b[2] - g.a[2]) * gt;
  } else if (mat.texKind && mat.texKind !== 'none') {
    sampleMaterialTexture(mat, u, v, emitTexC);
    cr *= emitTexC[0]; cg *= emitTexC[1]; cb *= emitTexC[2];
  }
  out[0] = cr * es; out[1] = cg * es; out[2] = cb * es;
  return out;
}

// ---------------------------------------------------------------------------
// Prepared scene + full path trace.
// ---------------------------------------------------------------------------

export interface TraceScene {
  tris: Float32Array;
  triMat: Int32Array;
  /** Per-corner UVs (2 floats × 3 corners per tri), parallel to tris. null when
   * the snapshot carried none — every hit then samples UV (0,0). */
  triUV: Float32Array | null;
  /** Per-corner GENERATED coords (3 floats × 3 corners per tri), parallel to
   * tris (P16-2). null → the Texture Coordinate node's generated output falls
   * back to (u, v, 0). */
  triGen: Float32Array | null;
  /** Per-corner OBJECT-LOCAL positions (3 floats × 3 corners per tri), parallel
   * to tris (UR16-1). null → object-space gradients fall back to the world hit
   * position. */
  triLocal: Float32Array | null;
  /** Per-corner WORLD-space SHADING normals (3 floats × 3 corners per tri),
   * parallel to tris (UR16-5). null → flat shading (geometric normal everywhere).
   * A zero triple on a triangle = a flat object's corner (keep the geometric
   * normal for that hit). */
  triNormal: Float32Array | null;
  materials: SnapMaterial[];
  lights: SnapLight[];
  camera: SnapCamera;
  world: SnapWorld;
  /** null when the scene has no geometry (sky-only render). */
  bvh: BVHNode | null;
  /** Emissive mesh lights (UR10-2 Part A) — null when no emissive geometry, so
   *  the NEE + emission-gating stay off and non-emissive renders are unchanged. */
  emitters: EmitterList | null;
  /** Transparent film (UR16-3): skip the world backdrop for the PRIMARY ray. */
  transparent: boolean;
}

export function prepareScene(snap: Snapshot): TraceScene {
  return {
    tris: snap.tris,
    triMat: snap.triMat,
    triUV: snap.triUV ?? null,
    triGen: snap.triGen ?? null,
    triLocal: snap.triLocal ?? null,
    triNormal: snap.triNormal ?? null,
    materials: snap.materials,
    lights: snap.lights,
    camera: snap.camera,
    // Absent world (older snapshots) → the default sky, so their images are
    // byte-identical to the pre-P10-4 tracer.
    world: snap.world ?? defaultSnapWorld(),
    bvh: snap.tris.length >= 9 ? buildBVH(snap.tris) : null,
    emitters: buildEmitters(snap.tris, snap.triMat, snap.materials),
    transparent: snap.transparent ?? false,
  };
}

/** Cosine-weighted hemisphere direction around (nx,ny,nz). Writes to `out`. */
function cosineHemisphere(
  nx: number, ny: number, nz: number,
  rng: Rng,
  out: [number, number, number],
): void {
  const r1 = rng(), r2 = rng();
  const phi = 2 * Math.PI * r1;
  const r = Math.sqrt(r2);
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - r2));
  // Build an orthonormal basis around N.
  const sign = nz >= 0 ? 1 : -1;
  const aa = -1 / (sign + nz);
  const bb = nx * ny * aa;
  const t1x = 1 + sign * nx * nx * aa, t1y = sign * bb, t1z = -sign * nx;
  const t2x = bb, t2y = sign + ny * ny * aa, t2z = -ny;
  out[0] = x * t1x + y * t2x + z * nx;
  out[1] = x * t1y + y * t2y + z * ny;
  out[2] = x * t1z + y * t2z + z * nz;
}

/**
 * Dielectric (glass) scatter (UR10-3). Given the incoming ray direction `d`
 * (normalized) and the RAW geometric normal `ng` (as stored), plus whether the
 * ray is ENTERING the surface (frontFace: geometric normal opposes the ray),
 * choose reflect vs refract at a smooth interface of index `ior` using the
 * real-IOR Schlick Fresnel, and write the outgoing direction to `out`.
 *
 * `u` ∈ [0,1) selects reflect (u < Fresnel reflectance) vs refract. Snell's law
 * is applied across the interface (eta = 1/ior entering, ior exiting); total
 * internal reflection (no transmitted ray) is detected and reflects instead.
 *
 * Returns `refracted` (true when the ray transmitted through — the caller tints
 * it by baseColor) and `tir` (true when the choice was forced by total internal
 * reflection). Pure + deterministic — exported for the fresnel/snell unit tests.
 */
export function dielectricScatter(
  dx: number, dy: number, dz: number,
  ngx: number, ngy: number, ngz: number,
  frontFace: boolean,
  ior: number,
  u: number,
  out: [number, number, number],
): { refracted: boolean; tir: boolean } {
  // nl = geometric normal oriented AGAINST the ray. ddn = d·nl ≤ 0.
  const nlx = frontFace ? ngx : -ngx;
  const nly = frontFace ? ngy : -ngy;
  const nlz = frontFace ? ngz : -ngz;
  const nnt = frontFace ? 1 / ior : ior;
  const ddn = dx * nlx + dy * nly + dz * nlz;
  const cos2t = 1 - nnt * nnt * (1 - ddn * ddn);
  if (cos2t < 0) {
    out[0] = dx - 2 * ddn * nlx; out[1] = dy - 2 * ddn * nly; out[2] = dz - 2 * ddn * nlz;
    return { refracted: false, tir: true };
  }
  const a = ior - 1, b = ior + 1;
  const R0 = (a * a) / (b * b);
  const sq = Math.sqrt(cos2t);
  const sign = frontFace ? 1 : -1;
  let tdx = dx * nnt - ngx * (sign * (ddn * nnt + sq));
  let tdy = dy * nnt - ngy * (sign * (ddn * nnt + sq));
  let tdz = dz * nnt - ngz * (sign * (ddn * nnt + sq));
  const tinv = 1 / Math.max(1e-6, Math.hypot(tdx, tdy, tdz));
  tdx *= tinv; tdy *= tinv; tdz *= tinv;
  const cf = 1 - (frontFace ? -ddn : tdx * ngx + tdy * ngy + tdz * ngz);
  const Re = R0 + (1 - R0) * cf * cf * cf * cf * cf;
  if (u < Re) {
    out[0] = dx - 2 * ddn * nlx; out[1] = dy - 2 * ddn * nly; out[2] = dz - 2 * ddn * nlz;
    return { refracted: false, tir: false };
  }
  out[0] = tdx; out[1] = tdy; out[2] = tdz;
  return { refracted: true, tir: false };
}

/** Interpolate the OBJECT-LOCAL hit position from a scene's triLocal (barycentric
 *  A=1−u−v, B=u, C=v). Falls back to the world hit position when the snapshot
 *  carried no local coords. Writes [x,y,z] into `out` (UR16-1 gradient eval). */
function localAtHit(
  triLocal: Float32Array | null, tri: number, u: number, v: number,
  wx: number, wy: number, wz: number, out: [number, number, number],
): void {
  if (!triLocal) { out[0] = wx; out[1] = wy; out[2] = wz; return; }
  const o = tri * 9;
  const w0 = 1 - u - v;
  out[0] = triLocal[o] * w0 + triLocal[o + 3] * u + triLocal[o + 6] * v;
  out[1] = triLocal[o + 1] * w0 + triLocal[o + 4] * u + triLocal[o + 7] * v;
  out[2] = triLocal[o + 2] * w0 + triLocal[o + 5] * u + triLocal[o + 8] * v;
}

/**
 * Barycentric-interpolated SHADING normal at a hit (UR16-5 smooth shading). Reads
 * `triNormal` (world-space per-corner normals; barycentric A=1−u−v, B=u, C=v) and
 * writes the UNIT shading normal into `out`, already clamped into the geometric
 * hemisphere (dot(out, Ng) ≥ 0 — flip guard for the classic shadow-terminator
 * black-splotch). Returns false — leaving the caller on the flat GEOMETRIC normal —
 * when the snapshot carried no normals, when the triangle is a FLAT sentinel (a
 * zero corner triple → interpolant length ≈ 0), or the interpolant degenerates.
 * (gx,gy,gz) is the geometric normal already oriented against the ray.
 */
export function shadingNormalAtHit(
  triNormal: Float32Array | null, tri: number, u: number, v: number,
  gx: number, gy: number, gz: number, out: [number, number, number],
): boolean {
  if (!triNormal) return false;
  const o = tri * 9;
  const w0 = 1 - u - v;
  let nx = triNormal[o] * w0 + triNormal[o + 3] * u + triNormal[o + 6] * v;
  let ny = triNormal[o + 1] * w0 + triNormal[o + 4] * u + triNormal[o + 7] * v;
  let nz = triNormal[o + 2] * w0 + triNormal[o + 5] * u + triNormal[o + 8] * v;
  const len2 = nx * nx + ny * ny + nz * nz;
  // Flat sentinel (zeros) or a degenerate interpolant → keep the geometric normal.
  // Real unit corner normals interpolate to |n| in [~0.5, 1]; 0.25 cleanly excludes
  // the zero triple while accepting even a 60° corner spread.
  if (len2 < 0.25) return false;
  const inv = 1 / Math.sqrt(len2);
  nx *= inv; ny *= inv; nz *= inv;
  // Clamp into the geometric hemisphere: a smooth normal that dips below the
  // geometric horizon (grazing corner) would drive NdotL negative → a black
  // terminator splotch. Flipping it back is the documented cheap guard.
  if (nx * gx + ny * gy + nz * gz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return true;
}

/** The material's alpha at a hit (UR16-1): the value passthrough, or the scalar
 *  gradient evaluated at the object-local position (loc). 1 when opaque. */
function alphaAtHit(mat: SnapMaterial, loc: [number, number, number]): number {
  const g = mat.alphaGradient;
  let a: number;
  if (g) a = g.a[0] + (g.b[0] - g.a[0]) * gradientT(g as GradientInput, loc[0], loc[1], loc[2]);
  else a = mat.alpha ?? 1;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/**
 * Trace a single camera ray and return its radiance. `out` receives [r,g,b].
 * When `out` has a 4th slot it receives COVERAGE (UR16-3): 1 if the PRIMARY ray
 * hit geometry, 0 if it escaped to the world — the transparent-film alpha.
 * Deterministic given `rng`.
 */
export function traceRay(
  scene: TraceScene,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  rng: Rng,
  out: number[],
): void {
  let tr = 1, tg = 1, tb = 1; // throughput
  let rr = 0, rg = 0, rb = 0; // radiance
  const direct: [number, number, number] = [0, 0, 0];
  const bounceDir: [number, number, number] = [0, 0, 0];
  const skyC: [number, number, number] = [0, 0, 0];
  const texC: [number, number, number] = [1, 1, 1];
  const alb: [number, number, number] = [0, 0, 0];
  // P13 map scratch (reused per bounce; no allocation in the hot loop).
  const gN: [number, number, number] = [0, 0, 0]; // geometric shading normal (offsets)
  const sN: [number, number, number] = [0, 0, 0]; // map-perturbed shading normal
  const shN: [number, number, number] = [0, 0, 0]; // UR16-5 smooth shading base normal
  const mT: [number, number, number] = [0, 0, 0];
  const mB: [number, number, number] = [0, 0, 0];
  const mapSamp: [number, number, number] = [0, 0, 0];
  const p0: [number, number, number] = [0, 0, 0];
  const p1: [number, number, number] = [0, 0, 0];
  const p2: [number, number, number] = [0, 0, 0];
  const uv0: [number, number] = [0, 0];
  const uv1: [number, number] = [0, 0];
  const uv2: [number, number] = [0, 0];
  const genV: [number, number, number] = [0, 0, 0]; // interpolated GENERATED coord
  const loc: [number, number, number] = [0, 0, 0]; // interpolated OBJECT-LOCAL pos (UR16-1 gradients)
  const emit: [number, number, number] = [0, 0, 0]; // emitter NEE contribution
  // Emission-on-hit is counted only on the camera ray or after a SPECULAR bounce
  // (NEE cannot sample a mirror direction); after a diffuse/SSS bounce the mesh
  // emission is already gathered by the NEE at that vertex, so skip it to avoid
  // double counting. Irrelevant when there are no emitters (flag never consulted).
  let countEmission = true;
  // Transparent-film coverage (UR16-3): 1 once the PRIMARY ray lands on geometry.
  let coverage = 0;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let hit = scene.bvh
      ? intersectBVH(scene.bvh, scene.tris, ox, oy, oz, dx, dy, dz)
      : null;
    // UR8-3 B — alpha cutout: an alphaBlend hit whose texture alpha < 0.5 is
    // SKIPPED (the ray passes straight through, continuing to whatever is behind
    // it); alpha ≥ 0.5 is opaque as usual. UR16-1 — the material ALPHA channel:
    // a hit whose effective alpha < 1 passes through STOCHASTICALLY with
    // probability (1 − alpha) (matches the raster blend + GPU kernel; opaque
    // alpha 1 draws no rng, so pre-UR16 renders are byte-identical). Bounded guard
    // against a ray grazing an endless run of near-coplanar cutouts.
    for (let pt = 0; hit && pt < 64; pt++) {
      const m = scene.materials[scene.triMat[hit.tri]] ?? scene.materials[0];
      let passThrough = false;
      // Texture-alpha cutout (UR8-3): alpha < 0.5 → pass through.
      if (m.alphaBlend && m.texImage && m.texImage.alpha && scene.triUV) {
        const o = hit.tri * 6;
        const w0 = 1 - hit.u - hit.v;
        const cu = scene.triUV[o] * w0 + scene.triUV[o + 2] * hit.u + scene.triUV[o + 4] * hit.v;
        const cv = scene.triUV[o + 1] * w0 + scene.triUV[o + 3] * hit.u + scene.triUV[o + 5] * hit.v;
        if (sampleImageAlphaBilinear(m.texImage, cu, cv) < 0.5) passThrough = true;
      }
      // Material alpha channel (UR16-1): stochastic pass-through. Only draws rng
      // when the material can be transparent (value < 1 or a gradient), so opaque
      // materials keep the exact pre-UR16 RNG stream.
      if (!passThrough && ((m.alpha !== undefined && m.alpha < 1) || m.alphaGradient)) {
        const hx = ox + dx * hit.t, hy = oy + dy * hit.t, hz = oz + dz * hit.t;
        localAtHit(scene.triLocal, hit.tri, hit.u, hit.v, hx, hy, hz, loc);
        if (rng() >= alphaAtHit(m, loc)) passThrough = true;
      }
      if (!passThrough) break;
      // Pass through: advance the ray origin just past the hit and re-intersect.
      const hx = ox + dx * hit.t, hy = oy + dy * hit.t, hz = oz + dz * hit.t;
      ox = hx + dx * EPS; oy = hy + dy * EPS; oz = hz + dz * EPS;
      hit = scene.bvh
        ? intersectBVH(scene.bvh, scene.tris, ox, oy, oz, dx, dy, dz)
        : null;
    }
    if (!hit) {
      // Transparent film (UR16-3): the PRIMARY (depth-0) ray that escapes to the
      // world contributes NO backdrop radiance and leaves coverage 0 (→ alpha 0).
      // Deeper bounces still gather world lighting (world illuminates objects).
      if (!(depth === 0 && scene.transparent)) {
        worldSky(scene.world, dx, dy, dz, skyC);
        rr += tr * skyC[0]; rg += tg * skyC[1]; rb += tb * skyC[2];
      }
      break;
    }
    // Primary ray hit real geometry → this pixel sample is covered (alpha 1).
    if (depth === 0) coverage = 1;
    const mat = scene.materials[scene.triMat[hit.tri]] ?? scene.materials[0];
    // Effective albedo = baseColor × texture, sampled through the interpolated
    // per-corner UV (barycentric: A weight = 1-u-v, B = u, C = v — the corner
    // order tris/triUV were pushed in). 'none' materials multiply by [1,1,1], so
    // an untextured hit is byte-identical to the pre-P11 path.
    alb[0] = mat.baseColor[0]; alb[1] = mat.baseColor[1]; alb[2] = mat.baseColor[2];
    // P14 shader nodes: when a material carries a node graph it is the WHOLE
    // truth (Blender semantics) — the base-texture AND all P13 map-slot paths
    // are SKIPPED and the graph output overrides baseColor / metallic /
    // roughness / emission below. Materials WITHOUT a graph keep the exact
    // pre-P14 code path (every flag below folds to its old value), so
    // tracer.test.ts renders stay bit-identical.
    const useNodes = mat.nodeGraph != null;
    // Interpolate the hit UV once when the base-color texture OR any P13 data map
    // needs it (barycentric: A weight = 1-u-v, B = u, C = v). With no UVs OR no
    // texture/map, none of this runs and the hit stays byte-identical to pre-P13.
    // UR16-1: object-space GRADIENT on the color channel wins over baseColor/tex.
    // Compute the interpolated object-local hit position once when any gradient
    // channel is active (color/rough/metal), then evaluate closed-form.
    const hasColorGrad = !useNodes && mat.colorGradient != null;
    const hasRoughGrad = !useNodes && mat.roughGradient != null;
    const hasMetalGrad = !useNodes && mat.metalGradient != null;
    if (hasColorGrad || hasRoughGrad || hasMetalGrad) {
      const hx = ox + dx * hit.t, hy = oy + dy * hit.t, hz = oz + dz * hit.t;
      localAtHit(scene.triLocal, hit.tri, hit.u, hit.v, hx, hy, hz, loc);
    }
    if (hasColorGrad) {
      const g = mat.colorGradient!;
      const t = gradientT(g, loc[0], loc[1], loc[2]);
      alb[0] = g.a[0] + (g.b[0] - g.a[0]) * t;
      alb[1] = g.a[1] + (g.b[1] - g.a[1]) * t;
      alb[2] = g.a[2] + (g.b[2] - g.a[2]) * t;
    }
    const hasTex = !useNodes && !hasColorGrad && !!mat.texKind && mat.texKind !== 'none';
    const hasNormalMap = !useNodes && mat.normalImage != null;
    const hasRoughMap = !useNodes && !hasRoughGrad && mat.roughImage != null;
    const hasMetalMap = !useNodes && !hasMetalGrad && mat.metalImage != null;
    let uu = 0, vv = 0;
    if (scene.triUV && (useNodes || hasTex || hasNormalMap || hasRoughMap || hasMetalMap)) {
      const o = hit.tri * 6;
      const w0 = 1 - hit.u - hit.v;
      uu = scene.triUV[o] * w0 + scene.triUV[o + 2] * hit.u + scene.triUV[o + 4] * hit.v;
      vv = scene.triUV[o + 1] * w0 + scene.triUV[o + 3] * hit.u + scene.triUV[o + 5] * hit.v;
    }
    if (hasTex && scene.triUV) {
      sampleMaterialTexture(mat, uu, vv, texC);
      alb[0] *= texC[0]; alb[1] *= texC[1]; alb[2] *= texC[2];
    }
    // Shadeless (UR4-3): the base×texture color is emitted directly and the ray
    // terminates — no lights, no shadows, no further bounces gathered (Blender's
    // "Emit"/image-plane look). Non-shadeless materials skip this entirely, so
    // the pre-UR4-3 bounce is byte-identical.
    if (mat.shadeless) {
      // UR16-4: emit radiance = colorSocket(alb) × strength. At strength 1 this is
      // the pre-UR16 shadeless "exact pixels". Emit surfaces are also emitter-NEE
      // lights (buildEmitters), so gate the on-hit emission by countEmission (skip
      // after a diffuse NEE bounce) to avoid double counting — the camera ray and
      // specular bounces (countEmission true) always see the full emission.
      const es = mat.emitScale ?? 1;
      const isMeshLight = scene.emitters !== null && es > 0;
      if (!isMeshLight || countEmission) {
        rr += tr * alb[0] * es; rg += tg * alb[1] * es; rb += tb * alb[2] * es;
      }
      break;
    }
    // Roughness / metallic maps MULTIPLY the scalar params (red channel), matching
    // the GLSL: rough = clamp(rough * r, 0.04, 1); metal *= r. Only when present,
    // so the no-map bounce below is byte-identical.
    let matRough = mat.roughness;
    let matMetal = mat.metallic;
    // UR16-1 scalar gradients override the roughness/metallic value (a/b RED comps
    // lerped at the object-local t). loc was interpolated above when any grad set.
    if (hasRoughGrad) {
      const g = mat.roughGradient!;
      matRough = g.a[0] + (g.b[0] - g.a[0]) * gradientT(g, loc[0], loc[1], loc[2]);
    }
    if (hasMetalGrad) {
      const g = mat.metalGradient!;
      matMetal = g.a[0] + (g.b[0] - g.a[0]) * gradientT(g, loc[0], loc[1], loc[2]);
    }
    // Glass (UR10-3): transmission drives the dielectric BSDF probability below;
    // its diffuse-weight (1 − transmission) fades out the surface's diffuse
    // direct-light + emitter NEE so full glass shows no milky sheen. Nodes don't
    // override transmission (v1). Non-glass materials (transmission 0) leave dw=1
    // and never draw the dielectric RNG, so their render is byte-identical.
    const transmission = mat.transmission ?? 0;
    const dw = 1 - transmission;
    if (hasRoughMap && scene.triUV) {
      sampleImageBilinear(mat.roughImage!, uu, vv, mapSamp);
      matRough = Math.min(1, Math.max(0.04, matRough * mapSamp[0]));
    }
    if (hasMetalMap && scene.triUV) {
      sampleImageBilinear(mat.metalImage!, uu, vv, mapSamp);
      matMetal = matMetal * mapSamp[0];
    }
    // Interpolate the per-corner GENERATED coord (P16-2) the same way as UV
    // (barycentric A=1-u-v, B=u, C=v). Only when a node graph will consume it,
    // so the non-node path stays byte-identical.
    let gen: [number, number, number] | undefined;
    if (useNodes && scene.triGen) {
      const g = hit.tri * 9;
      const w0 = 1 - hit.u - hit.v;
      genV[0] = scene.triGen[g] * w0 + scene.triGen[g + 3] * hit.u + scene.triGen[g + 6] * hit.v;
      genV[1] = scene.triGen[g + 1] * w0 + scene.triGen[g + 4] * hit.u + scene.triGen[g + 7] * hit.v;
      genV[2] = scene.triGen[g + 2] * w0 + scene.triGen[g + 5] * hit.u + scene.triGen[g + 8] * hit.v;
      gen = genV;
    }
    // Evaluate the node graph at the interpolated hit UV and OVERRIDE the
    // shading params. evaluateGraph allocates per call (fine at demo scale).
    const nodeSample = useNodes
      ? evaluateGraph(mat.nodeGraph!, { u: uu, v: vv, images: mat.nodeImages ?? undefined, gen })
      : null;
    if (nodeSample) {
      alb[0] = nodeSample.baseColor[0]; alb[1] = nodeSample.baseColor[1]; alb[2] = nodeSample.baseColor[2];
      matRough = nodeSample.roughness;
      matMetal = nodeSample.metallic;
    }
    // Emission (graph output overrides the flat emissive × strength when set).
    let emR = mat.emissive[0], emG = mat.emissive[1], emB = mat.emissive[2];
    let es = mat.emissiveStrength;
    if (nodeSample) {
      emR = nodeSample.emissive[0]; emG = nodeSample.emissive[1]; emB = nodeSample.emissive[2];
      es = nodeSample.emissiveStrength;
    }
    // A flat-emissive material that is in the emitter list (UR10-2 Part A) is
    // NEE-sampled, so its emission-on-hit is gated by countEmission to avoid
    // double counting. Node-emissive materials (not in the list) and scenes with
    // no emitters always add emission — byte-identical to the pre-UR10-2 path.
    const emissiveIsMeshLight = !useNodes && scene.emitters !== null && es > 0;
    if (es > 0 && (!emissiveIsMeshLight || countEmission)) {
      rr += tr * emR * es;
      rg += tg * emG * es;
      rb += tb * emB * es;
    }
    // Front face = the ray is entering the surface from outside (geometric
    // normal opposes the ray). Subsurface scattering only happens on entry;
    // interior/exit hits bounce diffusely so the ray leaves the medium instead
    // of ping-ponging and re-collecting direct light (which would gain energy).
    const frontFace = hit.nx * dx + hit.ny * dy + hit.nz * dz < 0;
    // Shading normal faces the incoming ray.
    let nx = hit.nx, ny = hit.ny, nz = hit.nz;
    if (!frontFace) { nx = -nx; ny = -ny; nz = -nz; }
    const hx = ox + dx * hit.t, hy = oy + dy * hit.t, hz = oz + dz * hit.t;

    // Keep the (flipped) GEOMETRIC normal for ray-offset bias / interior dip —
    // the normal map perturbs the SHADING normal only (matches the GLSL, which
    // keeps offsets stable). With no map, sN === gN so this is byte-identical.
    gN[0] = nx; gN[1] = ny; gN[2] = nz;
    // UR16-5 smooth shading: replace the flat geometric normal with the
    // barycentric-interpolated corner normal for shade-smooth objects. gN stays
    // geometric (ray offsets / glass / hemisphere clamp); only the SHADING normal
    // (nx,ny,nz — BRDF, NEE cosines, bounce hemisphere) changes. shN is the base
    // the normal map (if any) perturbs; for flat/undefined it equals gN, so the
    // no-smooth + normal-map path stays byte-identical.
    shN[0] = gN[0]; shN[1] = gN[1]; shN[2] = gN[2];
    if (shadingNormalAtHit(scene.triNormal, hit.tri, hit.u, hit.v, gN[0], gN[1], gN[2], shN)) {
      nx = shN[0]; ny = shN[1]; nz = shN[2];
    }
    if (hasNormalMap && scene.triUV) {
      const o9 = hit.tri * 9;
      p0[0] = scene.tris[o9]; p0[1] = scene.tris[o9 + 1]; p0[2] = scene.tris[o9 + 2];
      p1[0] = scene.tris[o9 + 3]; p1[1] = scene.tris[o9 + 4]; p1[2] = scene.tris[o9 + 5];
      p2[0] = scene.tris[o9 + 6]; p2[1] = scene.tris[o9 + 7]; p2[2] = scene.tris[o9 + 8];
      const o6 = hit.tri * 6;
      uv0[0] = scene.triUV[o6]; uv0[1] = scene.triUV[o6 + 1];
      uv1[0] = scene.triUV[o6 + 2]; uv1[1] = scene.triUV[o6 + 3];
      uv2[0] = scene.triUV[o6 + 4]; uv2[1] = scene.triUV[o6 + 5];
      // Perturb the SHADING base normal shN (= smooth interp, or gN when flat) so a
      // normal/bump map layers on TOP of smooth shading; shN === gN when the object
      // is flat, keeping the pre-UR16-5 map path byte-identical.
      if (tangentFrame(p0, p1, p2, uv0, uv1, uv2, shN, mT, mB)) {
        const strength = mat.normalStrength ?? 1;
        const img = mat.normalImage!;
        if (mat.normalIsBump) {
          // Central-difference height gradient (texel step = 1/size, bilinear).
          const tx = 1 / img.width, ty = 1 / img.height;
          sampleImageBilinear(img, uu - tx, vv, mapSamp); const hL = mapSamp[0];
          sampleImageBilinear(img, uu + tx, vv, mapSamp); const hR = mapSamp[0];
          sampleImageBilinear(img, uu, vv - ty, mapSamp); const hD = mapSamp[0];
          sampleImageBilinear(img, uu, vv + ty, mapSamp); const hU = mapSamp[0];
          applyBumpMap(hR - hL, hU - hD, strength, mT, mB, shN, sN);
        } else {
          sampleImageBilinear(img, uu, vv, mapSamp);
          applyNormalMap(mapSamp, strength, mT, mB, shN, sN);
        }
        nx = sN[0]; ny = sN[1]; nz = sN[2];
      }
    }

    // Subsurface decision (P9-4): honest cheap approximation. On a front-face
    // hit, with probability = subsurfaceWeight this bounce is treated as SSS —
    // the direct light gets a wrapped NdotL (light bleeds around the terminator,
    // tinted by baseColor) and the continuation dips below the surface and
    // re-emerges diffusely, a single-scatter dipole-ish. rng is only drawn when
    // the weight is > 0, so a weight-0 material is byte-identical to the plain
    // diffuse path.
    const ssw = mat.subsurfaceWeight ?? 0;
    const isSSS = frontFace && ssw > 0 && rng() < ssw;

    // Direct lighting (soft shadows via rng; wrapped diffuse when SSS).
    directLighting(
      scene.bvh, scene.tris, hx, hy, hz, nx, ny, nz,
      alb, scene.lights, direct, rng, isSSS ? 1 : 0, gN,
    );
    // Glass fades the diffuse surface response (dw = 1 for every opaque material,
    // so this multiply is a no-op there — byte-identical).
    rr += tr * direct[0] * dw; rg += tg * direct[1] * dw; rb += tb * direct[2] * dw;

    // Emissive mesh lights (UR10-2 Part A) — one NEE sample of the emitter set,
    // alongside the analytic lights. Guarded so non-emissive scenes draw no RNG.
    if (scene.emitters) {
      emit[0] = 0; emit[1] = 0; emit[2] = 0;
      sampleEmitters(
        scene.bvh, scene.tris, scene.emitters, hx, hy, hz, nx, ny, nz,
        alb, rng, emit, gN,
        { triUV: scene.triUV, triLocal: scene.triLocal, materials: scene.materials },
      );
      rr += tr * emit[0] * dw; rg += tg * emit[1] * dw; rb += tb * emit[2] * dw;
    }

    // Russian roulette after a couple of bounces.
    if (depth >= 2) {
      const p = Math.max(tr, tg, tb, 0.05);
      if (rng() > p) break;
      tr /= p; tg /= p; tb /= p;
    }

    // Bounce: glass (dielectric) with probability = transmission, else glossy
    // (metal) with probability = metallic, else diffuse / SSS. transmission 0
    // short-circuits BEFORE the RNG draw, so opaque materials keep the exact
    // pre-UR10-3 RNG stream (byte-identical). matMetal/matRough fold in the
    // metal/rough maps. Ray-offset origins bias along the GEOMETRIC normal gN.
    if (transmission > 0 && rng() < transmission) {
      // Dielectric glass BSDF (UR10-3): reflect vs refract by the real-IOR Schlick
      // Fresnel, Snell refraction, TIR-aware. inside/outside tracked by frontFace.
      const ior = mat.ior ?? 1.45;
      const { refracted } = dielectricScatter(
        dx, dy, dz, hit.nx, hit.ny, hit.nz, frontFace, ior, rng(), bounceDir,
      );
      let ndx = bounceDir[0], ndy = bounceDir[1], ndz = bounceDir[2];
      // Rough glass: perturb the chosen direction with the same GGX-ish jitter as
      // the metal lobe (documented cheap frosted-glass approximation).
      const j = matRough * matRough;
      if (j > 0) {
        ndx += (rng() * 2 - 1) * j; ndy += (rng() * 2 - 1) * j; ndz += (rng() * 2 - 1) * j;
      }
      const inv = 1 / Math.max(1e-6, Math.hypot(ndx, ndy, ndz));
      dx = ndx * inv; dy = ndy * inv; dz = ndz * inv;
      // Beer-lite tint: transmitted rays pick up baseColor (one multiply per
      // pass-through, no distance attenuation in v1). Reflections stay uncolored.
      if (refracted) { tr *= alb[0]; tg *= alb[1]; tb *= alb[2]; }
      // Offset the new origin onto the side the ray now travels (reflection stays
      // outside, refraction crosses to the far side).
      const os = dx * gN[0] + dy * gN[1] + dz * gN[2] >= 0 ? EPS : -EPS;
      ox = hx + gN[0] * os; oy = hy + gN[1] * os; oz = hz + gN[2] * os;
      // Specular event: NEE can't sample this direction, so the next hit must
      // count emitter radiance directly.
      countEmission = true;
    } else if (rng() < matMetal) {
      // Roughness-jittered mirror reflection (documented GGX-ish approximation).
      const dot = dx * nx + dy * ny + dz * nz;
      let bx = dx - 2 * dot * nx, by = dy - 2 * dot * ny, bz = dz - 2 * dot * nz;
      const j = matRough * matRough;
      if (j > 0) {
        bx += (rng() * 2 - 1) * j; by += (rng() * 2 - 1) * j; bz += (rng() * 2 - 1) * j;
      }
      const inv = 1 / Math.max(1e-6, Math.hypot(bx, by, bz));
      dx = bx * inv; dy = by * inv; dz = bz * inv;
      // Keep the reflection in the upper hemisphere.
      if (dx * nx + dy * ny + dz * nz < 0) { dx = -dx; dy = -dy; dz = -dz; }
      tr *= alb[0]; tg *= alb[1]; tb *= alb[2];
      ox = hx + gN[0] * EPS; oy = hy + gN[1] * EPS; oz = hz + gN[2] * EPS;
      // Specular/mirror bounce: NEE cannot sample this direction, so the next hit
      // must count the emitter's radiance directly.
      countEmission = true;
    } else if (isSSS) {
      // Dip the continuation origin below the surface by a random distance ~
      // subsurfaceRadius, then re-emerge with a cosine-weighted direction.
      // Tint (clamped ≤ 1) so throughput never grows → energy conserved.
      const dScatter = (mat.subsurfaceRadius ?? 0) * rng();
      cosineHemisphere(nx, ny, nz, rng, bounceDir);
      dx = bounceDir[0]; dy = bounceDir[1]; dz = bounceDir[2];
      tr *= Math.min(1, alb[0]);
      tg *= Math.min(1, alb[1]);
      tb *= Math.min(1, alb[2]);
      ox = hx - gN[0] * dScatter + dx * EPS;
      oy = hy - gN[1] * dScatter + dy * EPS;
      oz = hz - gN[2] * dScatter + dz * EPS;
      // Diffuse-like continuation: emitter radiance is covered by this vertex's
      // NEE, so don't re-add it on the next hit.
      countEmission = false;
    } else {
      cosineHemisphere(nx, ny, nz, rng, bounceDir);
      dx = bounceDir[0]; dy = bounceDir[1]; dz = bounceDir[2];
      // Cosine-weighted pdf cancels the cosine term → throughput *= albedo.
      tr *= alb[0]; tg *= alb[1]; tb *= alb[2];
      ox = hx + gN[0] * EPS; oy = hy + gN[1] * EPS; oz = hz + gN[2] * EPS;
      // Diffuse bounce: NEE at this vertex already gathered the emitter light.
      countEmission = false;
    }
  }
  out[0] = rr; out[1] = rg; out[2] = rb;
  if (out.length > 3) out[3] = coverage;
}

/**
 * Render one full sample pass into `accum` (length w*h*3, added in place).
 * `sampleIndex` seeds per-pixel RNG so each pass is independent yet
 * deterministic. Pixel (0,0) is top-left.
 *
 * `coverageAccum` (UR16-3, length w*h) — when supplied, receives the summed
 * transparent-film coverage per pixel (primary-ray hit fraction). Omit it (the
 * default) for the opaque path: no coverage slot is written and the render is
 * byte-identical to the pre-UR16-3 tracer.
 */
export function renderSample(
  scene: TraceScene,
  accum: Float32Array,
  w: number,
  h: number,
  sampleIndex: number,
  seed: number,
  coverageAccum?: Float32Array,
): void {
  const cam = scene.camera;
  const aspect = w / h;
  const th = Math.tan(cam.fovY / 2);
  const [fx, fy, fz] = cam.forward;
  const [rx, ry, rz] = cam.right;
  const [ux, uy, uz] = cam.up;
  const [ex, ey, ez] = cam.position;
  // Thin-lens depth of field. aperture 0 = pinhole: no lens RNG is drawn, so the
  // RNG stream (and therefore the image) is byte-identical to the old tracer.
  const aperture = cam.aperture ?? 0;
  const focus = cam.focusDistance ?? 5;
  // 4-slot out so traceRay can report coverage (out[3]) when transparent film is
  // wanted; the extra slot is ignored on the opaque path.
  const out: number[] = [0, 0, 0, 0];
  let i = 0;
  let p = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++, i += 3, p++) {
      const rng = mulberry32((seed ^ (i * 9781) ^ (sampleIndex * 0x9e3779b1)) >>> 0);
      // Jittered sub-pixel sample.
      const sx = ((px + rng()) / w) * 2 - 1;
      const sy = 1 - ((py + rng()) / h) * 2;
      const ndcx = sx * aspect * th;
      const ndcy = sy * th;
      let dx = fx + rx * ndcx + ux * ndcy;
      let dy = fy + ry * ndcx + uy * ndcy;
      let dz = fz + rz * ndcx + uz * ndcy;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv; dy *= inv; dz *= inv;
      if (aperture > 0) {
        // Focal point = where this pinhole ray crosses the focus plane.
        const cosF = dx * fx + dy * fy + dz * fz;
        const ft = focus / Math.max(1e-4, cosF);
        const fpx = ex + dx * ft, fpy = ey + dy * ft, fpz = ez + dz * ft;
        // Jitter the origin on the lens disk (right/up plane).
        const lr = aperture * Math.sqrt(rng());
        const la = 2 * Math.PI * rng();
        const lu = lr * Math.cos(la), lv = lr * Math.sin(la);
        const oxL = ex + rx * lu + ux * lv;
        const oyL = ey + ry * lu + uy * lv;
        const ozL = ez + rz * lu + uz * lv;
        let ndx = fpx - oxL, ndy = fpy - oyL, ndz = fpz - ozL;
        const ninv = 1 / Math.hypot(ndx, ndy, ndz);
        ndx *= ninv; ndy *= ninv; ndz *= ninv;
        traceRay(scene, oxL, oyL, ozL, ndx, ndy, ndz, rng, out);
      } else {
        traceRay(scene, ex, ey, ez, dx, dy, dz, rng, out);
      }
      accum[i] += out[0];
      accum[i + 1] += out[1];
      accum[i + 2] += out[2];
      if (coverageAccum) coverageAccum[p] += out[3];
    }
  }
}

/**
 * UR12-1 DEBUG EXPORT — binary primary-ray hit mask (row 0 = top). For each
 * pixel a CENTER (unjittered) pinhole ray is cast through the same camera model
 * as renderSample; the mask is 1 where it hits scene geometry, 0 on a miss. This
 * is the CPU reference the GPU tracer's renderHitMask() is compared against to
 * prove traversal parity (e2e/gpu-tracer-1.mjs). Aperture/DoF is ignored here
 * (pinhole centers only) so the mask is deterministic. NOT used by the app.
 */
export function renderHitMask(scene: TraceScene, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (!scene.bvh) return mask;
  const cam = scene.camera;
  const aspect = w / h;
  const th = Math.tan(cam.fovY / 2);
  const [fx, fy, fz] = cam.forward;
  const [rx, ry, rz] = cam.right;
  const [ux, uy, uz] = cam.up;
  const [ex, ey, ez] = cam.position;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = ((px + 0.5) / w) * 2 - 1;
      const sy = 1 - ((py + 0.5) / h) * 2;
      const ndcx = sx * aspect * th;
      const ndcy = sy * th;
      let dx = fx + rx * ndcx + ux * ndcy;
      let dy = fy + ry * ndcx + uy * ndcy;
      let dz = fz + rz * ndcx + uz * ndcy;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv; dy *= inv; dz *= inv;
      const hit = intersectBVH(scene.bvh, scene.tris, ex, ey, ez, dx, dy, dz);
      mask[py * w + px] = hit ? 1 : 0;
    }
  }
  return mask;
}
