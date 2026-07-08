import { registerNodeDef, type EvalContext, type NodeValue } from './nodeGraph';

/**
 * P16-2 — Node set C: Texture Coordinate + Map Range. Pure, deterministic
 * eval()s registered into the shared registry (imported for side effects via
 * builtins.ts). No GL, no DOM.
 *
 * HONEST LIMITATION (documented in the spec + Result): the `generated`
 * coordinate needs the surface's LOCAL mesh position, which only the path
 * tracer supplies (ctx.gen, per hit — see snapshot.ts triGen / tracer.ts).
 * The Rendered viewport bakes the graph over a flat UV grid (bake.ts) with NO
 * surface positions, so ctx.gen is undefined there and `generated` falls back
 * to (u, v, 0) — the same as the `uv` output. A generated-driven material
 * therefore looks correct in F12 but reads as plain UV in the Rendered bake.
 */

function asFloat(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

// --- Texture Coordinate ------------------------------------------------------
// Outputs the two coordinate systems procedural textures sample against.
//  generated: object-space GENERATED coords (ctx.gen) — local position
//    normalized to the object's base evaluated-mesh AABB, 0..1 per axis. When
//    the consumer can't supply them (bake path), falls back to (u, v, 0).
//  uv: the surface UV as a vector (u, v, 0).

registerNodeDef({
  type: 'texCoord',
  label: 'Texture Coordinate',
  inputs: [],
  outputs: [
    { key: 'generated', label: 'Generated', type: 'vector', default: [0, 0, 0] },
    { key: 'uv', label: 'UV', type: 'vector', default: [0, 0, 0] },
  ],
  params: [],
  eval: (_inputs, _params, ctx: EvalContext) => {
    const uv: NodeValue = [ctx.u, ctx.v, 0];
    const generated: NodeValue = ctx.gen ? [ctx.gen[0], ctx.gen[1], ctx.gen[2]] : [ctx.u, ctx.v, 0];
    return { generated, uv };
  },
});

// --- Map Range ---------------------------------------------------------------
// Linear remap of `value` from [fromMin, fromMax] to [toMin, toMax], optionally
// clamped to the output range. Degenerate input range (fromMin == fromMax) has
// no defined slope → outputs toMin (matches Blender's Map Range).

registerNodeDef({
  type: 'mapRange',
  label: 'Map Range',
  inputs: [{ key: 'value', label: 'Value', type: 'float', default: 0.5 }],
  outputs: [{ key: 'value', label: 'Result', type: 'float', default: 0 }],
  params: [
    { key: 'fromMin', label: 'From Min', kind: 'float', default: 0 },
    { key: 'fromMax', label: 'From Max', kind: 'float', default: 1 },
    { key: 'toMin', label: 'To Min', kind: 'float', default: 0 },
    { key: 'toMax', label: 'To Max', kind: 'float', default: 1 },
    { key: 'clamp', label: 'Clamp', kind: 'select', options: ['yes', 'no'], default: 'yes' },
  ],
  eval: (inputs, params) => {
    const v = typeof inputs.value === 'number' ? inputs.value : 0.5;
    const fromMin = asFloat(params.fromMin, 0);
    const fromMax = asFloat(params.fromMax, 1);
    const toMin = asFloat(params.toMin, 0);
    const toMax = asFloat(params.toMax, 1);
    const span = fromMax - fromMin;
    // Degenerate range → toMin (no slope to interpolate along).
    let out = Math.abs(span) < 1e-12 ? toMin : toMin + ((v - fromMin) / span) * (toMax - toMin);
    if (params.clamp !== 'no') {
      const lo = Math.min(toMin, toMax);
      const hi = Math.max(toMin, toMax);
      out = out < lo ? lo : out > hi ? hi : out;
    }
    if (!Number.isFinite(out)) out = toMin;
    return { value: out };
  },
});
