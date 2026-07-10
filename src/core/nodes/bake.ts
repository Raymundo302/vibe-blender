import { evaluateGraph } from './evaluate';
import type { Material } from '../scene/objectData';
import type { EvalContext, NodeGraph } from './nodeGraph';
import type { EditableMesh } from '../mesh/EditableMesh';
import './builtins';

/**
 * Bake a material's node graph to textures for the Rendered viewport (A14:
 * one evaluator, two consumers — the tracer evaluates per hit, the raster
 * path samples these bakes through the existing F13-1 map plumbing).
 *
 * Bakes over the UV unit square at `bakeRes`² (default 128 keeps a graph edit
 * under a few ms): base color as an sRGB-encoded PNG data URL, roughness +
 * metallic as grayscale PNGs. The Renderer substitutes them via an "effective
 * material" (baseColor/rough/metal forced to 1 so multiply == replace).
 *
 * GENERATED coords (P16-2): a Texture Coordinate node's `generated` output
 * needs the surface point's normalized object-space position (ctx.gen), which
 * the tracer fills per hit from triGen but the UV-space bake has no direct
 * access to. When the graph consumes generated coords AND the object's
 * evaluated mesh carries UVs, we CPU-rasterize the mesh's per-corner generated
 * coordinates into UV space (barycentric over each UV triangle) and feed the
 * covered texel's generated coord into the evaluator — so the bake matches the
 * tracer's notion instead of collapsing to UV. Meshes with NO UVs (or texels
 * outside every UV triangle) fall back to the prior (u, v, 0) behavior;
 * overlapping UV islands resolve last-writer-wins.
 *
 * Browser-only (canvas); the pure evaluator stays test-friendly in
 * evaluate.ts. Idempotent per (material, nodeGraphVersion [, mesh version when
 * generated coords are used]) — cheap to call every frame.
 */
const SIZE = 128;
const ALLOWED_RES = [128, 256, 512, 1024];

/** Resolve a material's bake resolution: one of ALLOWED_RES, default SIZE. */
export function bakeResolution(mat: Pick<Material, 'bakeRes'>): number {
  const r = mat.bakeRes;
  return typeof r === 'number' && ALLOWED_RES.includes(r) ? r : SIZE;
}

export function ensureBaked(
  mat: Material,
  images?: EvalContext['images'],
  meshProvider?: () => EditableMesh,
): void {
  if (!mat.useNodes || !mat.nodeGraph) return;
  const version = mat.nodeGraphVersion ?? 0;
  const size = bakeResolution(mat);

  // Generated coords need the mesh; only rasterize when the graph asks for them
  // and a mesh is available. The provider is lazy so the hot (cache-hit) path
  // never evaluates a modifier stack.
  const usesGen = graphUsesGenerated(mat.nodeGraph);
  let genRaster: { gen: Float32Array; covered: Uint8Array } | null = null;
  let meshVersion = -1;
  if (usesGen && meshProvider) {
    const mesh = meshProvider();
    meshVersion = mesh.version;
    // Reuse the cached bake unless the graph OR the mesh geometry changed.
    if (mat.baked && mat.baked.version === version && mat.baked.meshVersion === meshVersion
        && mat.baked.size === size) return;
    genRaster = rasterizeGenerated(mesh, size);
  } else {
    if (mat.baked && mat.baked.version === version && mat.baked.meshVersion === undefined
        && mat.baked.size === size) return;
  }
  if (typeof document === 'undefined') return; // tests / worker: tracer path only

  const base = document.createElement('canvas');
  const roughC = document.createElement('canvas');
  const metalC = document.createElement('canvas');
  for (const c of [base, roughC, metalC]) { c.width = size; c.height = size; }
  const bctx = base.getContext('2d')!;
  const rctx = roughC.getContext('2d')!;
  const mctx = metalC.getContext('2d')!;
  const bimg = bctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  const mimg = mctx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Canvas row 0 = top AND uv v=0 = top — the app-wide image convention
      // (tracer + GLSL sample with raw v). A v-driven graph must bake to the
      // same orientation the tracer shades directly.
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const t = y * size + x;
      let gen: [number, number, number] | undefined;
      if (genRaster && genRaster.covered[t]) {
        const gi = t * 3;
        gen = [genRaster.gen[gi], genRaster.gen[gi + 1], genRaster.gen[gi + 2]];
      }
      const s = evaluateGraph(mat.nodeGraph, { u, v, images, gen });
      const i = t * 4;
      const bc = s?.baseColor ?? [0.8, 0.8, 0.8];
      bimg.data[i] = linearToSrgb255(bc[0]);
      bimg.data[i + 1] = linearToSrgb255(bc[1]);
      bimg.data[i + 2] = linearToSrgb255(bc[2]);
      bimg.data[i + 3] = 255;
      const rv = Math.round((s?.roughness ?? 0.5) * 255);
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = rv;
      rimg.data[i + 3] = 255;
      const mv = Math.round((s?.metallic ?? 0) * 255);
      mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = mv;
      mimg.data[i + 3] = 255;
    }
  }
  bctx.putImageData(bimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  mctx.putImageData(mimg, 0, 0);
  mat.baked = {
    version,
    size,
    meshVersion: genRaster ? meshVersion : undefined,
    baseUrl: base.toDataURL('image/png'),
    roughUrl: roughC.toDataURL('image/png'),
    metalUrl: metalC.toDataURL('image/png'),
  };
}

/**
 * True when the graph feeds a Texture Coordinate node's `generated` output into
 * anything — the only case that needs the mesh's generated coords baked.
 */
export function graphUsesGenerated(graph: NodeGraph): boolean {
  for (const link of graph.links) {
    if (link.fromSocket !== 'generated') continue;
    const from = graph.nodes.find((n) => n.id === link.fromNode);
    if (from?.type === 'texCoord') return true;
  }
  return false;
}

/**
 * CPU-rasterize a mesh's per-corner GENERATED coordinates into UV space at
 * `size`². For each UV triangle (fan-triangulated faces), barycentric-
 * interpolate the three corners' generated coords across the covered texels.
 * Generated coord = local vert position normalized to the evaluated mesh's
 * local AABB, 0..1 per axis (degenerate axis → 0.5) — identical to the tracer's
 * triGen (snapshot.ts). Returns null when the mesh carries NO UVs (caller then
 * falls back to plain UV baking).
 */
export function rasterizeGenerated(
  mesh: EditableMesh,
  size: number,
): { gen: Float32Array; covered: Uint8Array } | null {
  if (mesh.uvs.size === 0) return null;

  // Per-vert generated coord from the local AABB.
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const vert of mesh.verts.values()) {
    const c = vert.co;
    if (c.x < mnx) mnx = c.x; if (c.x > mxx) mxx = c.x;
    if (c.y < mny) mny = c.y; if (c.y > mxy) mxy = c.y;
    if (c.z < mnz) mnz = c.z; if (c.z > mxz) mxz = c.z;
  }
  const sx = mxx - mnx, sy = mxy - mny, sz = mxz - mnz;
  const vertGen = new Map<number, [number, number, number]>();
  for (const vert of mesh.verts.values()) {
    const c = vert.co;
    vertGen.set(vert.id, [
      sx > 1e-12 ? (c.x - mnx) / sx : 0.5,
      sy > 1e-12 ? (c.y - mny) / sy : 0.5,
      sz > 1e-12 ? (c.z - mnz) / sz : 0.5,
    ]);
  }

  const gen = new Float32Array(size * size * 3);
  const covered = new Uint8Array(size * size);

  for (const face of mesh.faces.values()) {
    const faceUVs = mesh.uvs.get(face.id);
    if (!faceUVs) continue;
    const vs = face.verts;
    for (let i = 1; i + 1 < vs.length; i++) {
      const corners = [0, i, i + 1];
      const uvA = faceUVs[corners[0]], uvB = faceUVs[corners[1]], uvC = faceUVs[corners[2]];
      const gA = vertGen.get(vs[corners[0]]);
      const gB = vertGen.get(vs[corners[1]]);
      const gC = vertGen.get(vs[corners[2]]);
      if (!uvA || !uvB || !uvC || !gA || !gB || !gC) continue;
      rasterTri(uvA, uvB, uvC, gA, gB, gC, size, gen, covered);
    }
  }
  return { gen, covered };
}

/** Rasterize one UV-space triangle, writing barycentric-interpolated gen coords
 *  into covered texels. Texel center (x+0.5, y+0.5) maps to uv ((x+.5)/size,…). */
function rasterTri(
  uvA: [number, number], uvB: [number, number], uvC: [number, number],
  gA: [number, number, number], gB: [number, number, number], gC: [number, number, number],
  size: number, gen: Float32Array, covered: Uint8Array,
): void {
  // Corner positions in pixel space (uv * size).
  const ax = uvA[0] * size, ay = uvA[1] * size;
  const bx = uvB[0] * size, by = uvB[1] * size;
  const cx = uvC[0] * size, cy = uvC[1] * size;
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < 1e-9) return; // degenerate UV triangle
  const inv = 1 / area;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      // Barycentric weights via edge functions (sign-normalized by area).
      let wA = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv;
      let wB = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv;
      const wC = 1 - wA - wB;
      // Small epsilon so shared edges don't leave seams of uncovered texels.
      const e = -1e-6;
      if (wA < e || wB < e || wC < e) continue;
      const cwA = wA < 0 ? 0 : wA;
      const cwB = wB < 0 ? 0 : wB;
      const cwC = wC < 0 ? 0 : wC;
      const t = y * size + x;
      const gi = t * 3;
      gen[gi] = gA[0] * cwA + gB[0] * cwB + gC[0] * cwC;
      gen[gi + 1] = gA[1] * cwA + gB[1] * cwB + gC[1] * cwC;
      gen[gi + 2] = gA[2] * cwA + gB[2] * cwB + gC[2] * cwC;
      covered[t] = 1;
    }
  }
}

function linearToSrgb255(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
