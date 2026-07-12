/**
 * UR12-1 — scene → Float32 texture packing for the WebGL2 fragment-shader path
 * tracer.
 *
 * Everything here is PURE: it consumes the EXISTING tracer Snapshot (snapshot.ts)
 * and the EXISTING CPU BVH (tracer.ts buildBVH) and lays the data out as RGBA32F
 * texel payloads the GLSL kernel (kernel.ts) can `texelFetch`. There is NO second
 * scene walker — the CPU snapshot + BVH are reused verbatim, only re-serialized.
 *
 * A "payload" is a run of RGBA texels (4 floats each) stored row-major in a
 * `width × height` texture. Item `i`, texel `j` lives at linear texel index
 *   L = i * texelsPerItem + j
 * whose pixel coordinate is (L % width, L / width). The kernel is handed `width`
 * as a uniform and reconstructs the same coordinate. The `read*` helpers below
 * are the round-trip readers the unit tests use to prove the layout.
 */

import type { Snapshot, SnapMaterial, SnapLight } from '../snapshot';
import type { BVHNode, EmitterList } from '../tracer';

/** A packed RGBA32F texture payload. `data.length === width * height * 4`. */
export interface Payload {
  data: Float32Array;
  width: number;
  height: number;
  /** Texels consumed per logical item (triangle / material / light / node). */
  texelsPerItem: number;
  /** Number of logical items packed (0 when the source is empty). */
  count: number;
}

/** Max texture row width; height grows to fit. Well under the WebGL2 minimum
 *  (2048) so any GL context can allocate the row. */
export const TEX_MAX_WIDTH = 2048;

// --- Texel layouts (SHARED with kernel.ts — keep in lock-step) --------------

/** Triangle: 3 texels. t0 = a.xyz + materialIndex(w); t1 = b.xyz; t2 = c.xyz. */
export const TRI_TEXELS = 3;
/** Material: 4 texels (UR12-2 extended the layout). t0 = baseColor.rgb +
 *  roughness(w); t1 = metallic, transmission, ior, emissiveStrength;
 *  t2 = emissive.rgb + texKind(w: 0 none | 1 checker | 2 image);
 *  t3 = shadeless(0|1), subsurfaceWeight, subsurfaceRadius, alphaBlend(0|1). */
export const MAT_TEXELS = 4;
/** UV: 2 texels/tri. t0 = uv0.xy, uv1.xy; t1 = uv2.xy, 0, 0. */
export const UV_TEXELS = 2;
/** Emitter: 2 texels/emitter (UR10-2 mesh-light NEE). t0 = triIndex, cdf, 0, 0;
 *  t1 = radiance.rgb, 0. */
export const EMIT_TEXELS = 2;
/** Light: 6 texels (covers all 4 types incl. area axes).
 *  t0 = position.xyz + type(w); t1 = direction.xyz + radius(w);
 *  t2 = energy.rgb + cosInner(w); t3 = cosOuter, width, height, 0;
 *  t4 = uAxis.xyz; t5 = vAxis.xyz. */
export const LIGHT_TEXELS = 6;
/** BVH node: 3 texels. t0 = min.xyz + isLeaf(w:1|0);
 *  t1 = max.xyz; t2 = (leaf ? triOffset,triCount : leftIdx,rightIdx), 0, 0. */
export const NODE_TEXELS = 3;
/** Triangle indices are packed 4-per-texel (RGBA), as flat floats. */
export const TRIIDX_PER_TEXEL = 4;

// --- Generic payload builder ------------------------------------------------

/**
 * Assemble `texels` (an array of length-4 tuples, one entry per RGBA texel) into
 * a row-major `width × height` payload. Always allocates at least a 1×1 texture
 * so an empty scene still yields a bindable sampler.
 */
function buildPayload(texels: number[][], texelsPerItem: number, count: number): Payload {
  const total = Math.max(1, texels.length);
  const width = Math.min(TEX_MAX_WIDTH, total);
  const height = Math.ceil(total / width);
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < texels.length; i++) {
    const t = texels[i];
    const o = i * 4;
    data[o] = t[0]; data[o + 1] = t[1]; data[o + 2] = t[2]; data[o + 3] = t[3];
  }
  return { data, width, height, texelsPerItem, count };
}

/** Pixel base offset (into `data`) of texel `j` of item `i`. */
function texelBase(p: Payload, item: number, texel: number): number {
  return (item * p.texelsPerItem + texel) * 4;
}

// --- Triangles --------------------------------------------------------------

/**
 * Pack world-space triangle positions (9 floats/tri, from snap.tris) plus the
 * per-triangle material index (snap.triMat) into the w-channel of the first
 * texel — so the shader gets geometry + material lookup from one texture.
 */
export function packTriangles(tris: Float32Array, triMat: Int32Array): Payload {
  const count = (tris.length / 9) | 0;
  const texels: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 9;
    const mat = i < triMat.length ? triMat[i] : 0;
    texels.push([tris[o], tris[o + 1], tris[o + 2], mat]);
    texels.push([tris[o + 3], tris[o + 4], tris[o + 5], 0]);
    texels.push([tris[o + 6], tris[o + 7], tris[o + 8], 0]);
  }
  return buildPayload(texels, TRI_TEXELS, count);
}

export interface TriRead {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  material: number;
}

export function readTriangle(p: Payload, i: number): TriRead {
  const b0 = texelBase(p, i, 0), b1 = texelBase(p, i, 1), b2 = texelBase(p, i, 2);
  const d = p.data;
  return {
    a: [d[b0], d[b0 + 1], d[b0 + 2]],
    b: [d[b1], d[b1 + 1], d[b1 + 2]],
    c: [d[b2], d[b2 + 1], d[b2 + 2]],
    material: d[b0 + 3],
  };
}

// --- Materials --------------------------------------------------------------

/** texKind → shader code. Image maps to 2 but the kernel falls back to white
 *  (no atlas upload in v1 — documented cut in kernel.ts). */
function texKindCode(m: SnapMaterial): number {
  return m.texKind === 'checker' ? 1 : m.texKind === 'image' ? 2 : 0;
}

export function packMaterials(materials: SnapMaterial[]): Payload {
  const texels: number[][] = [];
  for (const m of materials) {
    texels.push([m.baseColor[0], m.baseColor[1], m.baseColor[2], m.roughness]);
    texels.push([m.metallic, m.transmission ?? 0, m.ior ?? 1.45, m.emissiveStrength]);
    texels.push([m.emissive[0], m.emissive[1], m.emissive[2], texKindCode(m)]);
    texels.push([
      m.shadeless ? 1 : 0,
      m.subsurfaceWeight ?? 0,
      m.subsurfaceRadius ?? 0.05,
      m.alphaBlend ? 1 : 0,
    ]);
  }
  return buildPayload(texels, MAT_TEXELS, materials.length);
}

export interface MatRead {
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  transmission: number;
  ior: number;
  emissiveStrength: number;
  emissive: [number, number, number];
  texKind: number;
  shadeless: number;
  subsurfaceWeight: number;
  subsurfaceRadius: number;
  alphaBlend: number;
}

export function readMaterial(p: Payload, i: number): MatRead {
  const b0 = texelBase(p, i, 0), b1 = texelBase(p, i, 1), b2 = texelBase(p, i, 2);
  const b3 = texelBase(p, i, 3);
  const d = p.data;
  return {
    baseColor: [d[b0], d[b0 + 1], d[b0 + 2]],
    roughness: d[b0 + 3],
    metallic: d[b1],
    transmission: d[b1 + 1],
    ior: d[b1 + 2],
    emissiveStrength: d[b1 + 3],
    emissive: [d[b2], d[b2 + 1], d[b2 + 2]],
    texKind: d[b2 + 3],
    shadeless: d[b3],
    subsurfaceWeight: d[b3 + 1],
    subsurfaceRadius: d[b3 + 2],
    alphaBlend: d[b3 + 3],
  };
}

// --- UVs --------------------------------------------------------------------

/**
 * Pack per-corner UVs (2 texels/tri) so the kernel can barycentric-interpolate
 * the hit UV (corner order A,B,C = tris/triUV push order). Missing/short input
 * packs (0,0) — an untextured hit then samples UV (0,0), matching the CPU path.
 */
export function packUVs(triUV: Float32Array | null | undefined, triCount: number): Payload {
  const texels: number[][] = [];
  for (let i = 0; i < triCount; i++) {
    const o = i * 6;
    const g = (k: number) => (triUV && o + k < triUV.length ? triUV[o + k] : 0);
    texels.push([g(0), g(1), g(2), g(3)]);
    texels.push([g(4), g(5), 0, 0]);
  }
  return buildPayload(texels, UV_TEXELS, triCount);
}

export function readUV(p: Payload, i: number): {
  a: [number, number]; b: [number, number]; c: [number, number];
} {
  const b0 = texelBase(p, i, 0), b1 = texelBase(p, i, 1);
  const d = p.data;
  return { a: [d[b0], d[b0 + 1]], b: [d[b0 + 2], d[b0 + 3]], c: [d[b1], d[b1 + 1]] };
}

// --- Emitters (mesh-light NEE, UR10-2) --------------------------------------

/** Packed emitter CDF payload plus the scalars the kernel needs as uniforms. */
export interface PackedEmitters {
  data: Payload;
  count: number;
  totalArea: number;
}

/** Flatten the CPU EmitterList into a 2-texel/emitter payload. null → an empty
 *  (count 0) payload so the sampler still binds. */
export function packEmitters(emitters: EmitterList | null): PackedEmitters {
  const texels: number[][] = [];
  if (emitters) {
    for (let i = 0; i < emitters.tris.length; i++) {
      texels.push([emitters.tris[i], emitters.cdf[i], 0, 0]);
      const r = i * 3;
      texels.push([emitters.radiance[r], emitters.radiance[r + 1], emitters.radiance[r + 2], 0]);
    }
  }
  return {
    data: buildPayload(texels, EMIT_TEXELS, emitters ? emitters.tris.length : 0),
    count: emitters ? emitters.tris.length : 0,
    totalArea: emitters ? emitters.totalArea : 0,
  };
}

// --- Lights -----------------------------------------------------------------

export function packLights(lights: SnapLight[]): Payload {
  const texels: number[][] = [];
  for (const l of lights) {
    texels.push([l.position[0], l.position[1], l.position[2], l.type]);
    texels.push([l.direction[0], l.direction[1], l.direction[2], l.radius ?? 0]);
    texels.push([l.energy[0], l.energy[1], l.energy[2], l.cosInner]);
    texels.push([l.cosOuter, l.width ?? 0, l.height ?? 0, 0]);
    texels.push([l.uAxis?.[0] ?? 1, l.uAxis?.[1] ?? 0, l.uAxis?.[2] ?? 0, 0]);
    texels.push([l.vAxis?.[0] ?? 0, l.vAxis?.[1] ?? 1, l.vAxis?.[2] ?? 0, 0]);
  }
  return buildPayload(texels, LIGHT_TEXELS, lights.length);
}

export interface LightRead {
  type: number;
  position: [number, number, number];
  direction: [number, number, number];
  radius: number;
  energy: [number, number, number];
  cosInner: number;
  cosOuter: number;
  width: number;
  height: number;
  uAxis: [number, number, number];
  vAxis: [number, number, number];
}

export function readLight(p: Payload, i: number): LightRead {
  const d = p.data;
  const b = (j: number) => texelBase(p, i, j);
  const b0 = b(0), b1 = b(1), b2 = b(2), b3 = b(3), b4 = b(4), b5 = b(5);
  return {
    position: [d[b0], d[b0 + 1], d[b0 + 2]],
    type: d[b0 + 3],
    direction: [d[b1], d[b1 + 1], d[b1 + 2]],
    radius: d[b1 + 3],
    energy: [d[b2], d[b2 + 1], d[b2 + 2]],
    cosInner: d[b2 + 3],
    cosOuter: d[b3],
    width: d[b3 + 1],
    height: d[b3 + 2],
    uAxis: [d[b4], d[b4 + 1], d[b4 + 2]],
    vAxis: [d[b5], d[b5 + 1], d[b5 + 2]],
  };
}

// --- BVH --------------------------------------------------------------------

/**
 * The pointer-based CPU BVH (tracer.ts) flattened to an INDEXED array the GPU
 * can walk with an explicit stack. Nodes are laid out pre-order; each internal
 * node stores its two child node indices, each leaf stores an [offset,count)
 * range into `triIndices` (the concatenated leaf triangle lists).
 */
export interface FlatBVH {
  nodes: Payload;
  /** 4-per-texel float payload of triangle indices (into the triangle texture). */
  triIndices: Payload;
  nodeCount: number;
  triIndexCount: number;
}

export function flattenBVH(root: BVHNode | null): FlatBVH {
  const nodeTexels: number[][] = [];
  const triIdx: number[] = [];
  let nodeCount = 0;

  /** Reserve a node slot (3 texels) and return its index. */
  function alloc(): number {
    const idx = nodeCount++;
    nodeTexels.push([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    return idx;
  }

  function writeLeaf(idx: number, node: BVHNode): void {
    const o = idx * NODE_TEXELS;
    const list = node.tris ?? [];
    const offset = triIdx.length;
    for (const ti of list) triIdx.push(ti);
    nodeTexels[o] = [node.min[0], node.min[1], node.min[2], 1];
    nodeTexels[o + 1] = [node.max[0], node.max[1], node.max[2], 0];
    nodeTexels[o + 2] = [offset, list.length, 0, 0];
  }

  function build(node: BVHNode): number {
    const idx = alloc();
    if (node.tris) {
      writeLeaf(idx, node);
      return idx;
    }
    // Internal: recurse (children get their own indices), then backfill.
    const left = node.left ? build(node.left) : -1;
    const right = node.right ? build(node.right) : -1;
    const o = idx * NODE_TEXELS;
    nodeTexels[o] = [node.min[0], node.min[1], node.min[2], 0];
    nodeTexels[o + 1] = [node.max[0], node.max[1], node.max[2], 0];
    nodeTexels[o + 2] = [left, right, 0, 0];
    return idx;
  }

  if (root) build(root);

  // triIndices packed 4-per-texel.
  const idxTexels: number[][] = [];
  for (let i = 0; i < triIdx.length; i += TRIIDX_PER_TEXEL) {
    idxTexels.push([
      triIdx[i] ?? 0,
      triIdx[i + 1] ?? 0,
      triIdx[i + 2] ?? 0,
      triIdx[i + 3] ?? 0,
    ]);
  }

  return {
    nodes: buildPayload(nodeTexels, NODE_TEXELS, nodeCount),
    triIndices: buildPayload(idxTexels, 1, triIdx.length),
    nodeCount,
    triIndexCount: triIdx.length,
  };
}

export interface NodeRead {
  min: [number, number, number];
  max: [number, number, number];
  isLeaf: boolean;
  /** Internal only. */
  left: number;
  right: number;
  /** Leaf only. */
  triOffset: number;
  triCount: number;
}

export function readNode(p: Payload, i: number): NodeRead {
  const d = p.data;
  const b0 = texelBase(p, i, 0), b1 = texelBase(p, i, 1), b2 = texelBase(p, i, 2);
  const isLeaf = d[b0 + 3] > 0.5;
  return {
    min: [d[b0], d[b0 + 1], d[b0 + 2]],
    max: [d[b1], d[b1 + 1], d[b1 + 2]],
    isLeaf,
    left: isLeaf ? -1 : d[b2],
    right: isLeaf ? -1 : d[b2 + 1],
    triOffset: isLeaf ? d[b2] : -1,
    triCount: isLeaf ? d[b2 + 1] : -1,
  };
}

/** Read triangle index `k` (0..triIndexCount) back out of the packed payload. */
export function readTriIndex(p: Payload, k: number): number {
  const lin = (k / TRIIDX_PER_TEXEL) | 0;
  const comp = k % TRIIDX_PER_TEXEL;
  return p.data[lin * 4 + comp];
}

/** Convenience: pack an entire snapshot into every payload the kernel needs. */
export interface PackedScene {
  triangles: Payload;
  materials: Payload;
  lights: Payload;
  uvs: Payload;
  emitters: PackedEmitters;
  bvh: FlatBVH;
}

export function packScene(
  snap: Snapshot,
  bvh: BVHNode | null,
  emitters: EmitterList | null,
): PackedScene {
  const triCount = (snap.tris.length / 9) | 0;
  return {
    triangles: packTriangles(snap.tris, snap.triMat),
    materials: packMaterials(snap.materials),
    lights: packLights(snap.lights),
    uvs: packUVs(snap.triUV, triCount),
    emitters: packEmitters(emitters),
    bvh: flattenBVH(bvh),
  };
}
