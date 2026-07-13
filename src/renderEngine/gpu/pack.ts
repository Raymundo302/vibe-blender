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
/** Material: 8 texels (UR16-1 color gradient + alpha; UR16-4 emit + image atlas).
 *  t0 = baseColor.rgb + roughness(w); t1 = metallic, transmission, ior,
 *  emissiveStrength; t2 = emissive.rgb + texKind(w: 0 none | 1 checker | 2 image);
 *  t3 = shadeless(0|1), subsurfaceWeight, subsurfaceRadius, alphaBlend(0|1);
 *  t4 = colorGradEnabled(0|1), axis(0 x|1 y|2 z), offset, scale;
 *  t5 = colorGradA.rgb, alphaValue(w);  t6 = colorGradB.rgb, 0;
 *  t7 = emitScale(UR16-4), imageAtlasLayer(-1 = none), 0, 0.
 *  (GPU cut, documented in kernel.ts: alpha gradient/image and roughness/metallic
 *  gradients fall back to their value — only the COLOR gradient + alpha VALUE are
 *  ported; the CPU tracer supports all, the parity harness uses only these.) */
export const MAT_TEXELS = 8;
/** Object-LOCAL triangle positions (UR16-1 gradient eval): 3 texels/tri, parallel
 *  to the triangle texture. t0 = localA.xyz; t1 = localB.xyz; t2 = localC.xyz. */
export const LOCAL_TEXELS = 3;
/** Per-corner WORLD-space SHADING normals (UR16-5 smooth shading): 3 texels/tri,
 *  parallel to the triangle texture. t0 = nA.xyz; t1 = nB.xyz; t2 = nC.xyz. A zero
 *  triple = a FLAT triangle (the kernel keeps its geometric normal). */
export const NORMAL_TEXELS = 3;
/** UV: 2 texels/tri. t0 = uv0.xy, uv1.xy; t1 = uv2.xy, 0, 0. */
export const UV_TEXELS = 2;
/** Emitter: 2 texels/emitter (UR10-2 mesh-light NEE). t0 = triIndex, cdf,
 *  materialIndex (UR16-4, for per-point emit color eval), 0; t1 = radiance.rgb, 0. */
export const EMIT_TEXELS = 2;

/** GPU image atlas (UR16-4): every 'image' material with decoded pixels is
 *  resampled into one fixed-size layer of a TEXTURE_2D_ARRAY, up to MAX_TEX_LAYERS;
 *  the kernel samples it for texKind 2 (was a white fallback in the v1 cut). */
export const ATLAS_SIZE = 256;
export const MAX_TEX_LAYERS = 16;
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

/** Deterministic atlas-layer assignment (UR16-4): each 'image' material with
 *  decoded pixels claims the next layer 0..MAX_TEX_LAYERS-1 in material order;
 *  everything else (and overflow past the cap) → -1 (kernel white fallback). Pure
 *  function of the materials array so packMaterials and packImageAtlas agree, and
 *  the materials signature (which drives incremental re-pack) is stable. */
export function imageLayers(materials: SnapMaterial[]): Int32Array {
  const out = new Int32Array(materials.length).fill(-1);
  let layer = 0;
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    if (m.texKind === 'image' && m.texImage && layer < MAX_TEX_LAYERS) out[i] = layer++;
  }
  return out;
}

export function packMaterials(materials: SnapMaterial[]): Payload {
  const layerOf = imageLayers(materials);
  const texels: number[][] = [];
  for (let mi = 0; mi < materials.length; mi++) {
    const m = materials[mi];
    texels.push([m.baseColor[0], m.baseColor[1], m.baseColor[2], m.roughness]);
    texels.push([m.metallic, m.transmission ?? 0, m.ior ?? 1.45, m.emissiveStrength]);
    texels.push([m.emissive[0], m.emissive[1], m.emissive[2], texKindCode(m)]);
    texels.push([
      m.shadeless ? 1 : 0,
      m.subsurfaceWeight ?? 0,
      m.subsurfaceRadius ?? 0.05,
      m.alphaBlend ? 1 : 0,
    ]);
    // UR16-1 color gradient + alpha value (t4..t6).
    const cg = m.colorGradient ?? null;
    const axis = cg ? (cg.axis === 'x' ? 0 : cg.axis === 'y' ? 1 : 2) : 0;
    texels.push([cg ? 1 : 0, axis, cg ? cg.offset : 0, cg ? cg.scale : 0]);
    texels.push([cg ? cg.a[0] : 0, cg ? cg.a[1] : 0, cg ? cg.a[2] : 0, m.alpha ?? 1]);
    texels.push([cg ? cg.b[0] : 0, cg ? cg.b[1] : 0, cg ? cg.b[2] : 0, 0]);
    // t7 (UR16-4): emit light strength + the image-atlas layer (-1 = none).
    texels.push([m.emitScale ?? 1, layerOf[mi], 0, 0]);
  }
  return buildPayload(texels, MAT_TEXELS, materials.length);
}

/** Resample every image material into a fixed-size RGBA8 TEXTURE_2D_ARRAY (UR16-4).
 *  Values are the CPU texImage's LINEAR RGB (row 0 = top) bilinear-resampled to
 *  ATLAS_SIZE² and quantized to 8-bit — the kernel samples it LINEAR-filtered as
 *  the color socket for emit/diffuse image planes (the GPU's v1 white fallback is
 *  gone). Returns { data, layers, size }; `layers ≥ 1` always so a bindable array
 *  texture exists even with no image materials.
 *
 *  UR16-6: the ALPHA channel is now packed too (was hardcoded 255), so the GPU
 *  kernel can cut out transparent texels of alphaBlend image planes exactly like
 *  the CPU tracer. To kill BLACK FRINGING at cutout edges, RGB is resampled with
 *  ALPHA-WEIGHTED bilinear (straight-alpha edge bleed): a transparent source
 *  texel (RGB≈0, α=0) contributes NOTHING to a neighbour's colour, so opaque
 *  edge texels keep their real colour instead of averaging toward black. Alpha
 *  itself is plain bilinear. Where a whole neighbourhood is transparent, RGB
 *  falls back to unweighted bilinear (value irrelevant — those texels cut out). */
export interface ImageAtlas { data: Uint8Array; layers: number; size: number; }
export function packImageAtlas(materials: SnapMaterial[]): ImageAtlas {
  const layerOf = imageLayers(materials);
  let layers = 0;
  for (const l of layerOf) if (l >= 0 && l + 1 > layers) layers = l + 1;
  const size = ATLAS_SIZE;
  const data = new Uint8Array(size * size * 4 * Math.max(1, layers));
  const q = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let i = 0; i < materials.length; i++) {
    const l = layerOf[i];
    if (l < 0) continue;
    const img = materials[i].texImage!;
    const iw = img.width, ih = img.height, px = img.pixels;
    const alpha = img.alpha; // per-texel straight alpha (undefined → fully opaque)
    const cx = (x: number) => (x < 0 ? 0 : x > iw - 1 ? iw - 1 : x);
    const cy = (y: number) => (y < 0 ? 0 : y > ih - 1 ? ih - 1 : y);
    const base = l * size * size * 4;
    for (let y = 0; y < size; y++) {
      // Match sampleImageBilinear's half-texel convention (u*w-0.5) so the GPU and
      // CPU sample the source identically; row 0 = image top in both.
      const fy = ((y + 0.5) / size) * ih - 0.5;
      const y0 = Math.floor(fy), ty = fy - y0;
      for (let x = 0; x < size; x++) {
        const fx = ((x + 0.5) / size) * iw - 0.5;
        const x0 = Math.floor(fx), tx = fx - x0;
        const o = base + (y * size + x) * 4;
        // The four source taps + their bilinear weights.
        const i00 = cy(y0) * iw + cx(x0), i10 = cy(y0) * iw + cx(x0 + 1);
        const i01 = cy(y0 + 1) * iw + cx(x0), i11 = cy(y0 + 1) * iw + cx(x0 + 1);
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        const a00 = alpha ? alpha[i00] : 1, a10 = alpha ? alpha[i10] : 1;
        const a01 = alpha ? alpha[i01] : 1, a11 = alpha ? alpha[i11] : 1;
        // Straight alpha = plain bilinear of the alpha channel.
        data[o + 3] = q(w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11);
        // Alpha-weighted RGB (premultiply → bilinear → unpremultiply) so colour
        // bleeds OUT of opaque texels and never averages toward transparent black.
        const aw = w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11;
        for (let k = 0; k < 3; k++) {
          if (aw > 1e-6) {
            const c = w00 * a00 * px[i00 * 3 + k] + w10 * a10 * px[i10 * 3 + k]
              + w01 * a01 * px[i01 * 3 + k] + w11 * a11 * px[i11 * 3 + k];
            data[o + k] = q(c / aw);
          } else {
            // Fully transparent neighbourhood — plain bilinear (value cut out anyway).
            data[o + k] = q(w00 * px[i00 * 3 + k] + w10 * px[i10 * 3 + k]
              + w01 * px[i01 * 3 + k] + w11 * px[i11 * 3 + k]);
          }
        }
      }
    }
  }
  return { data, layers: Math.max(1, layers), size };
}

/** Pack per-corner OBJECT-LOCAL triangle positions (UR16-1 gradients). Missing/
 *  short input packs (0,0,0). */
export function packLocals(triLocal: Float32Array | null | undefined, triCount: number): Payload {
  const texels: number[][] = [];
  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const g = (k: number) => (triLocal && o + k < triLocal.length ? triLocal[o + k] : 0);
    texels.push([g(0), g(1), g(2), 0]);
    texels.push([g(3), g(4), g(5), 0]);
    texels.push([g(6), g(7), g(8), 0]);
  }
  return buildPayload(texels, LOCAL_TEXELS, triCount);
}

/** Pack per-corner WORLD-space SHADING normals (UR16-5). Missing/short input (no
 *  shade-smooth object, or a flat triangle) packs a ZERO triple → the kernel keeps
 *  the geometric normal for that hit. Parallel to the triangle texture. */
export function packNormals(triNormal: Float32Array | null | undefined, triCount: number): Payload {
  const texels: number[][] = [];
  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const g = (k: number) => (triNormal && o + k < triNormal.length ? triNormal[o + k] : 0);
    texels.push([g(0), g(1), g(2), 0]);
    texels.push([g(3), g(4), g(5), 0]);
    texels.push([g(6), g(7), g(8), 0]);
  }
  return buildPayload(texels, NORMAL_TEXELS, triCount);
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
  /** UR16-1 color gradient + alpha value. */
  colorGradEnabled: number;
  gradAxis: number;
  gradOffset: number;
  gradScale: number;
  gradA: [number, number, number];
  gradB: [number, number, number];
  alpha: number;
  emitScale: number;
  imageLayer: number;
}

export function readMaterial(p: Payload, i: number): MatRead {
  const b0 = texelBase(p, i, 0), b1 = texelBase(p, i, 1), b2 = texelBase(p, i, 2);
  const b3 = texelBase(p, i, 3), b4 = texelBase(p, i, 4), b5 = texelBase(p, i, 5), b6 = texelBase(p, i, 6);
  const b7 = texelBase(p, i, 7);
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
    colorGradEnabled: d[b4],
    gradAxis: d[b4 + 1],
    gradOffset: d[b4 + 2],
    gradScale: d[b4 + 3],
    gradA: [d[b5], d[b5 + 1], d[b5 + 2]],
    alpha: d[b5 + 3],
    gradB: [d[b6], d[b6 + 1], d[b6 + 2]],
    emitScale: d[b7],
    imageLayer: d[b7 + 1],
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
      texels.push([emitters.tris[i], emitters.cdf[i], emitters.matIdx[i], 0]);
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
  /** Per-corner object-local positions (UR16-1 gradients). */
  locals: Payload;
  /** Per-corner world-space shading normals (UR16-5 smooth shading). */
  normals: Payload;
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
    locals: packLocals(snap.triLocal, triCount),
    normals: packNormals(snap.triNormal, triCount),
    emitters: packEmitters(emitters),
    bvh: flattenBVH(bvh),
  };
}
