import type { Snapshot, SnapMaterial, SnapLight, SnapCamera } from './snapshot';

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
): [number, number, number] {
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (const l of lights) {
    const radius = l.radius ?? 0;
    const soft = rng !== undefined && radius > 0;
    let lx: number, ly: number, lz: number, dist: number;
    let rr: number, rg: number, rb: number;
    if (l.type === 1) {
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
    if (root && occluded(root, tris, px + nx * EPS, py + ny * EPS, pz + nz * EPS, lx, ly, lz, dist)) {
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

/** Vertical sky gradient: dark grey ground → blue-grey up. */
export function sky(dy: number, out: [number, number, number]): void {
  const t = Math.min(1, Math.max(0, dy * 0.5 + 0.5));
  out[0] = 0.05 + (0.11 - 0.05) * t;
  out[1] = 0.05 + (0.13 - 0.05) * t;
  out[2] = 0.05 + (0.16 - 0.05) * t;
}

// ---------------------------------------------------------------------------
// Prepared scene + full path trace.
// ---------------------------------------------------------------------------

export interface TraceScene {
  tris: Float32Array;
  triMat: Int32Array;
  materials: SnapMaterial[];
  lights: SnapLight[];
  camera: SnapCamera;
  /** null when the scene has no geometry (sky-only render). */
  bvh: BVHNode | null;
}

export function prepareScene(snap: Snapshot): TraceScene {
  return {
    tris: snap.tris,
    triMat: snap.triMat,
    materials: snap.materials,
    lights: snap.lights,
    camera: snap.camera,
    bvh: snap.tris.length >= 9 ? buildBVH(snap.tris) : null,
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
 * Trace a single camera ray and return its radiance. `out` receives [r,g,b].
 * Deterministic given `rng`.
 */
export function traceRay(
  scene: TraceScene,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  rng: Rng,
  out: [number, number, number],
): void {
  let tr = 1, tg = 1, tb = 1; // throughput
  let rr = 0, rg = 0, rb = 0; // radiance
  const direct: [number, number, number] = [0, 0, 0];
  const bounceDir: [number, number, number] = [0, 0, 0];
  const skyC: [number, number, number] = [0, 0, 0];

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const hit = scene.bvh
      ? intersectBVH(scene.bvh, scene.tris, ox, oy, oz, dx, dy, dz)
      : null;
    if (!hit) {
      sky(dy, skyC);
      rr += tr * skyC[0]; rg += tg * skyC[1]; rb += tb * skyC[2];
      break;
    }
    const mat = scene.materials[scene.triMat[hit.tri]] ?? scene.materials[0];
    // Emission.
    const es = mat.emissiveStrength;
    if (es > 0) {
      rr += tr * mat.emissive[0] * es;
      rg += tg * mat.emissive[1] * es;
      rb += tb * mat.emissive[2] * es;
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
      mat.baseColor, scene.lights, direct, rng, isSSS ? 1 : 0,
    );
    rr += tr * direct[0]; rg += tg * direct[1]; rb += tb * direct[2];

    // Russian roulette after a couple of bounces.
    if (depth >= 2) {
      const p = Math.max(tr, tg, tb, 0.05);
      if (rng() > p) break;
      tr /= p; tg /= p; tb /= p;
    }

    // Bounce: glossy (metal) with probability = metallic, else diffuse / SSS.
    if (rng() < mat.metallic) {
      // Roughness-jittered mirror reflection (documented GGX-ish approximation).
      const dot = dx * nx + dy * ny + dz * nz;
      let bx = dx - 2 * dot * nx, by = dy - 2 * dot * ny, bz = dz - 2 * dot * nz;
      const j = mat.roughness * mat.roughness;
      if (j > 0) {
        bx += (rng() * 2 - 1) * j; by += (rng() * 2 - 1) * j; bz += (rng() * 2 - 1) * j;
      }
      const inv = 1 / Math.max(1e-6, Math.hypot(bx, by, bz));
      dx = bx * inv; dy = by * inv; dz = bz * inv;
      // Keep the reflection in the upper hemisphere.
      if (dx * nx + dy * ny + dz * nz < 0) { dx = -dx; dy = -dy; dz = -dz; }
      tr *= mat.baseColor[0]; tg *= mat.baseColor[1]; tb *= mat.baseColor[2];
      ox = hx + nx * EPS; oy = hy + ny * EPS; oz = hz + nz * EPS;
    } else if (isSSS) {
      // Dip the continuation origin below the surface by a random distance ~
      // subsurfaceRadius, then re-emerge with a cosine-weighted direction.
      // Tint (clamped ≤ 1) so throughput never grows → energy conserved.
      const dScatter = (mat.subsurfaceRadius ?? 0) * rng();
      cosineHemisphere(nx, ny, nz, rng, bounceDir);
      dx = bounceDir[0]; dy = bounceDir[1]; dz = bounceDir[2];
      tr *= Math.min(1, mat.baseColor[0]);
      tg *= Math.min(1, mat.baseColor[1]);
      tb *= Math.min(1, mat.baseColor[2]);
      ox = hx - nx * dScatter + dx * EPS;
      oy = hy - ny * dScatter + dy * EPS;
      oz = hz - nz * dScatter + dz * EPS;
    } else {
      cosineHemisphere(nx, ny, nz, rng, bounceDir);
      dx = bounceDir[0]; dy = bounceDir[1]; dz = bounceDir[2];
      // Cosine-weighted pdf cancels the cosine term → throughput *= albedo.
      tr *= mat.baseColor[0]; tg *= mat.baseColor[1]; tb *= mat.baseColor[2];
      ox = hx + nx * EPS; oy = hy + ny * EPS; oz = hz + nz * EPS;
    }
  }
  out[0] = rr; out[1] = rg; out[2] = rb;
}

/**
 * Render one full sample pass into `accum` (length w*h*3, added in place).
 * `sampleIndex` seeds per-pixel RNG so each pass is independent yet
 * deterministic. Pixel (0,0) is top-left.
 */
export function renderSample(
  scene: TraceScene,
  accum: Float32Array,
  w: number,
  h: number,
  sampleIndex: number,
  seed: number,
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
  const out: [number, number, number] = [0, 0, 0];
  let i = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++, i += 3) {
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
    }
  }
}
