import { evaluateGraph } from './evaluate';
import type { Material } from '../scene/objectData';
import type { EvalContext } from './nodeGraph';
import './builtins';

/**
 * Bake a material's node graph to textures for the Rendered viewport (A14:
 * one evaluator, two consumers — the tracer evaluates per hit, the raster
 * path samples these bakes through the existing F13-1 map plumbing).
 *
 * Bakes over the UV unit square at SIZE² (128 keeps a graph edit under a few
 * ms): base color as an sRGB-encoded PNG data URL, roughness + metallic as
 * grayscale PNGs. The Renderer substitutes them via an "effective material"
 * (baseColor/rough/metal forced to 1 so multiply == replace).
 *
 * Browser-only (canvas); the pure evaluator stays test-friendly in
 * evaluate.ts. Idempotent per (material, nodeGraphVersion) — cheap to call
 * every frame.
 */
const SIZE = 128;

export function ensureBaked(mat: Material, images?: EvalContext['images']): void {
  if (!mat.useNodes || !mat.nodeGraph) return;
  const version = mat.nodeGraphVersion ?? 0;
  if (mat.baked && mat.baked.version === version) return;
  if (typeof document === 'undefined') return; // tests / worker: tracer path only

  const base = document.createElement('canvas');
  const roughC = document.createElement('canvas');
  const metalC = document.createElement('canvas');
  for (const c of [base, roughC, metalC]) { c.width = SIZE; c.height = SIZE; }
  const bctx = base.getContext('2d')!;
  const rctx = roughC.getContext('2d')!;
  const mctx = metalC.getContext('2d')!;
  const bimg = bctx.createImageData(SIZE, SIZE);
  const rimg = rctx.createImageData(SIZE, SIZE);
  const mimg = mctx.createImageData(SIZE, SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Canvas row 0 = top; UV v=1 = top (the F13-1 image convention).
      const u = (x + 0.5) / SIZE;
      const v = 1 - (y + 0.5) / SIZE;
      const s = evaluateGraph(mat.nodeGraph, { u, v, images });
      const i = (y * SIZE + x) * 4;
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
    baseUrl: base.toDataURL('image/png'),
    roughUrl: roughC.toDataURL('image/png'),
    metalUrl: metalC.toDataURL('image/png'),
  };
}

function linearToSrgb255(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
