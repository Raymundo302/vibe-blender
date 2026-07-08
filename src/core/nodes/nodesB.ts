import { registerNodeDef, type EvalContext, type NodeValue } from './nodeGraph';

/**
 * P14-3 — Node set B: Image Texture, ColorRamp, Math. Pure, deterministic
 * eval()s registered into the same registry as the core nodes (imported for
 * side effects by builtins.ts). No GL, no DOM: images arrive pre-decoded in
 * ctx.images (raw 0..1 RGB, row 0 = top — the F13-1 convention), the caller
 * fills that map (shader editor / tracer snapshot); tests build it directly.
 */

// The uv input socket carries a NaN sentinel default so eval can tell an
// UNCONNECTED socket (→ fall back to ctx.u/ctx.v) from a connected upstream
// value (always real numbers). The evaluator passes socket.default straight
// through coerce() for vector sockets, so the NaN survives to eval untouched.
const UV_UNCONNECTED: NodeValue = [NaN, NaN, NaN];

/** Resolve the sample UV: the connected uv socket if present, else ctx.u/ctx.v. */
function sampleUV(uvIn: NodeValue | undefined, ctx: EvalContext): [number, number] {
  if (Array.isArray(uvIn) && !Number.isNaN(uvIn[0]) && !Number.isNaN(uvIn[1])) {
    return [uvIn[0], uvIn[1]];
  }
  return [ctx.u, ctx.v];
}

/**
 * Bilinear, clamp-to-edge sample of a decoded image (raw 0..1 RGB, row 0 =
 * top). Reimplemented locally from tracer.ts's sampleImageBilinear so core
 * never imports render code — same idiom, same results.
 */
function bilinear(
  img: { width: number; height: number; pixels: Float32Array },
  u: number,
  v: number,
): [number, number, number] {
  const { width: w, height: h, pixels } = img;
  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cx = (x: number) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  const at = (x: number, y: number, k: number) => pixels[(cy(y) * w + cx(x)) * 3 + k];
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx;
    const b = at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx;
    out[k] = a * (1 - ty) + b * ty;
  }
  return out;
}

registerNodeDef({
  type: 'imageTexture',
  label: 'Image Texture',
  inputs: [{ key: 'uv', label: 'UV', type: 'vector', default: UV_UNCONNECTED }],
  outputs: [{ key: 'color', label: 'Color', type: 'color', default: [1, 1, 1] }],
  params: [{ key: 'image', label: 'Image', kind: 'image', default: null }],
  eval: (inputs, params, ctx) => {
    const url = params.image;
    if (typeof url !== 'string' || !url) return { color: [1, 1, 1] };
    const img = ctx.images?.get(url);
    // Not decoded / missing → neutral white so the material shows unchanged.
    if (!img || img.width <= 0 || img.height <= 0) return { color: [1, 1, 1] };
    const [u, v] = sampleUV(inputs.uv, ctx);
    // App-wide image convention (tracer sampleImageBilinear, renderedPass GLSL
    // with UNPACK_FLIP_Y=false, P13 map slots): v = 0 samples the TOP row —
    // raw v, no flip. The same data URL must look identical through an Image
    // Texture node and the Material-tab texture slot.
    return { color: bilinear(img, u, v) };
  },
});

// --- ColorRamp -------------------------------------------------------------

interface RampStop { pos: number; color: [number, number, number] }
const DEFAULT_RAMP: { stops: RampStop[] } = {
  stops: [
    { pos: 0, color: [0, 0, 0] },
    { pos: 1, color: [1, 1, 1] },
  ],
};

/** Parse a (possibly malformed) ramp param into sorted, valid stops. */
function rampStops(param: unknown): RampStop[] {
  const raw = (param as { stops?: unknown } | null)?.stops;
  const stops: RampStop[] = [];
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const pos = (s as { pos?: unknown })?.pos;
      const col = (s as { color?: unknown })?.color;
      if (
        typeof pos === 'number' && Number.isFinite(pos) &&
        Array.isArray(col) && col.length === 3 &&
        col.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        stops.push({ pos, color: [col[0], col[1], col[2]] });
      }
    }
  }
  if (stops.length === 0) return DEFAULT_RAMP.stops.map((s) => ({ pos: s.pos, color: [...s.color] as [number, number, number] }));
  stops.sort((a, b) => a.pos - b.pos);
  return stops;
}

registerNodeDef({
  type: 'colorRamp',
  label: 'ColorRamp',
  inputs: [{ key: 'fac', label: 'Fac', type: 'float', default: 0.5 }],
  outputs: [{ key: 'color', label: 'Color', type: 'color', default: [0, 0, 0] }],
  params: [{ key: 'ramp', label: 'Ramp', kind: 'ramp', default: DEFAULT_RAMP }],
  eval: (inputs, params) => {
    const stops = rampStops(params.ramp);
    const first = stops[0];
    const last = stops[stops.length - 1];
    let fac = typeof inputs.fac === 'number' ? inputs.fac : 0.5;
    // Clamp to the ramp's own range (Blender's default "clip" extrapolation).
    if (fac <= first.pos) return { color: [...first.color] as NodeValue };
    if (fac >= last.pos) return { color: [...last.color] as NodeValue };
    // Find the bracketing pair and lerp.
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (fac >= a.pos && fac <= b.pos) {
        const span = b.pos - a.pos;
        const t = span > 1e-12 ? (fac - a.pos) / span : 0;
        return {
          color: [
            a.color[0] + (b.color[0] - a.color[0]) * t,
            a.color[1] + (b.color[1] - a.color[1]) * t,
            a.color[2] + (b.color[2] - a.color[2]) * t,
          ] as NodeValue,
        };
      }
    }
    return { color: [...last.color] as NodeValue };
  },
});

// --- Math ------------------------------------------------------------------

const MATH_OPS = ['add', 'subtract', 'multiply', 'divide', 'power', 'minimum', 'maximum'] as const;

registerNodeDef({
  type: 'math',
  label: 'Math',
  inputs: [
    { key: 'a', label: 'A', type: 'float', default: 0.5 },
    { key: 'b', label: 'B', type: 'float', default: 0.5 },
  ],
  outputs: [{ key: 'value', label: 'Value', type: 'float', default: 0 }],
  params: [{ key: 'op', label: 'Operation', kind: 'select', options: [...MATH_OPS], default: 'multiply' }],
  eval: (inputs, params) => {
    const a = typeof inputs.a === 'number' ? inputs.a : 0.5;
    const b = typeof inputs.b === 'number' ? inputs.b : 0.5;
    const op = typeof params.op === 'string' ? params.op : 'multiply';
    let value: number;
    switch (op) {
      case 'add': value = a + b; break;
      case 'subtract': value = a - b; break;
      case 'divide':
        // Guard divide-by-(near-)zero → 0 (Blender leaves it 0 too).
        value = Math.abs(b) < 1e-9 ? 0 : a / b;
        break;
      case 'power':
        // A negative base with a fractional exponent has no real result → 0.
        value = a < 0 && !Number.isInteger(b) ? 0 : Math.pow(a, b);
        break;
      case 'minimum': value = Math.min(a, b); break;
      case 'maximum': value = Math.max(a, b); break;
      case 'multiply':
      default: value = a * b; break;
    }
    if (!Number.isFinite(value)) value = 0;
    return { value };
  },
});
