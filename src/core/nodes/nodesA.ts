import { registerNodeDef, type NodeValue } from './nodeGraph';
import type { EvalContext } from './nodeGraph';

/**
 * Node set A (P14-2): Checker, Noise, Mix Color. All deterministic — same
 * (inputs, params, ctx) → identical output. No Math.random (a seeded integer
 * hash drives the noise lattice). Registered for side effects via builtins.ts.
 *
 * UV convention (shared with P14-3's Image node): the `uv` INPUT socket
 * defaults to [0,0,0], which we read as "unconnected — use the surface UV from
 * ctx". When the socket IS connected (an upstream vector), we take its .xy as
 * the sampling coordinate instead. `uvCoord()` centralises that rule.
 */

/** Resolve (u,v) for a texture node: connected uv input (.xy) wins over ctx. */
function uvCoord(inputs: Record<string, NodeValue>, ctx: EvalContext): [number, number] {
  const uv = inputs.uv;
  // Unconnected socket resolves to its default [0,0,0]; treat exact zero vector
  // as "not connected" and fall back to the surface UV (ctx.u/ctx.v).
  if (Array.isArray(uv) && (uv[0] !== 0 || uv[1] !== 0 || uv[2] !== 0)) {
    return [uv[0], uv[1]];
  }
  return [ctx.u, ctx.v];
}

function asColor(v: unknown, d: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number')
    ? [v[0], v[1], v[2]]
    : d;
}

function asFloat(v: unknown, d: number): number {
  return typeof v === 'number' ? v : d;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --- Checker -----------------------------------------------------------------
// Parity of floor(u·scale) + floor(v·scale) picks colorA (even) or colorB
// (odd). At scale 8 with the default greys this matches the built-in texKind
// 'checker' in renderedPass.ts / tracer.ts (8×8 parity, 0.2 grey vs 1.0 white).

registerNodeDef({
  type: 'checker',
  label: 'Checker Texture',
  inputs: [{ key: 'uv', label: 'Vector', type: 'vector', default: [0, 0, 0] }],
  outputs: [{ key: 'color', label: 'Color', type: 'color', default: [0, 0, 0] }],
  params: [
    { key: 'scale', label: 'Scale', kind: 'float', min: 0, max: 64, default: 8 },
    { key: 'colorA', label: 'Color 1', kind: 'color', default: [0.2, 0.2, 0.2] },
    { key: 'colorB', label: 'Color 2', kind: 'color', default: [1, 1, 1] },
  ],
  eval: (inputs, params, ctx) => {
    const [u, v] = uvCoord(inputs, ctx);
    const scale = asFloat(params.scale, 8);
    const sum = Math.floor(u * scale) + Math.floor(v * scale);
    const even = (((sum % 2) + 2) % 2) === 0;
    const a = asColor(params.colorA, [0.2, 0.2, 0.2]);
    const b = asColor(params.colorB, [1, 1, 1]);
    return { color: (even ? a : b) as NodeValue };
  },
});

// --- Noise -------------------------------------------------------------------
// fbm value noise: sum of `octaves` layers of smoothed value noise at doubling
// frequency / halving amplitude, normalised to 0..1. Lattice values come from a
// deterministic integer hash (mulberry32 mixing idiom, same as the Scatter
// modifier) — no Math.random, so the same (u,v,params) always match.

/** Integer hash → float in [0,1). Deterministic; mulberry32 mixing idiom. */
function hash2(ix: number, iy: number, seed: number): number {
  let a = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ (seed | 0)) >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smooth (fade) interpolant, Perlin's 6t^5-15t^4+10t^3. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Bilinearly-interpolated value noise at (x,y). Range 0..1. */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

const NOISE_SEED = 0x1a2b3c4d;

/** fbm value noise, `octaves` layers. Returns 0..1. */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  const oct = Math.max(1, Math.floor(octaves));
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise(x * freq, y * freq, NOISE_SEED + i);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

registerNodeDef({
  type: 'noise',
  label: 'Noise Texture',
  inputs: [{ key: 'uv', label: 'Vector', type: 'vector', default: [0, 0, 0] }],
  outputs: [
    { key: 'value', label: 'Fac', type: 'float', default: 0 },
    { key: 'color', label: 'Color', type: 'color', default: [0, 0, 0] },
  ],
  params: [
    { key: 'scale', label: 'Scale', kind: 'float', min: 0, max: 64, default: 5 },
    { key: 'octaves', label: 'Detail', kind: 'float', min: 1, max: 8, default: 3 },
  ],
  eval: (inputs, params, ctx) => {
    const [u, v] = uvCoord(inputs, ctx);
    const scale = asFloat(params.scale, 5);
    const octaves = asFloat(params.octaves, 3);
    const n = clamp01(fbm(u * scale, v * scale, octaves));
    return { value: n, color: [n, n, n] as NodeValue };
  },
});

// --- Mix Color ---------------------------------------------------------------
// Linear blend a·(1−fac) + b·fac, fac clamped 0..1.

registerNodeDef({
  type: 'mixColor',
  label: 'Mix Color',
  inputs: [
    { key: 'a', label: 'A', type: 'color', default: [0, 0, 0] },
    { key: 'b', label: 'B', type: 'color', default: [1, 1, 1] },
    { key: 'fac', label: 'Factor', type: 'float', default: 0.5 },
  ],
  outputs: [{ key: 'color', label: 'Color', type: 'color', default: [0, 0, 0] }],
  params: [],
  eval: (inputs) => {
    const a = asColor(inputs.a, [0, 0, 0]);
    const b = asColor(inputs.b, [1, 1, 1]);
    const fac = clamp01(asFloat(inputs.fac, 0.5));
    const inv = 1 - fac;
    return {
      color: [a[0] * inv + b[0] * fac, a[1] * inv + b[1] * fac, a[2] * inv + b[2] * fac] as NodeValue,
    };
  },
});
