import { registerNodeDef, type NodeValue } from './nodeGraph';

/**
 * The architect-shipped core node set (F14-1): the Principled output plus the
 * trivial value sources. Texture/utility nodes (Checker, Noise, Image, Mix,
 * ColorRamp, …) are P14 worker tasks — they register from their own files via
 * this same registerNodeDef, imported for side effects like modifiers.
 */

registerNodeDef({
  type: 'principled',
  label: 'Principled BSDF',
  inputs: [
    { key: 'baseColor', label: 'Base Color', type: 'color', default: [0.8, 0.8, 0.8] },
    { key: 'metallic', label: 'Metallic', type: 'float', default: 0 },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.5 },
    { key: 'emissive', label: 'Emission', type: 'color', default: [0, 0, 0] },
    { key: 'emissiveStrength', label: 'Emission Strength', type: 'float', default: 0 },
  ],
  outputs: [],
  params: [],
  // The output node: its resolved inputs ARE the shading result — echo them
  // so evaluateGraph can read them off the eval record.
  eval: (inputs) => ({ ...inputs }),
});

registerNodeDef({
  type: 'value',
  label: 'Value',
  inputs: [],
  outputs: [{ key: 'value', label: 'Value', type: 'float', default: 0 }],
  params: [{ key: 'value', label: 'Value', kind: 'float', min: 0, max: 1, default: 0.5 }],
  eval: (_i, params) => ({ value: typeof params.value === 'number' ? params.value : 0.5 }),
});

registerNodeDef({
  type: 'rgb',
  label: 'RGB',
  inputs: [],
  outputs: [{ key: 'color', label: 'Color', type: 'color', default: [1, 1, 1] }],
  params: [{ key: 'color', label: 'Color', kind: 'color', default: [1, 1, 1] }],
  eval: (_i, params) => {
    const c = params.color;
    const ok = Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === 'number');
    return { color: (ok ? [c[0], c[1], c[2]] : [1, 1, 1]) as NodeValue };
  },
});

registerNodeDef({
  type: 'uv',
  label: 'UV',
  inputs: [],
  outputs: [
    { key: 'uv', label: 'UV', type: 'vector', default: [0, 0, 0] },
    { key: 'u', label: 'U', type: 'float', default: 0 },
    { key: 'v', label: 'V', type: 'float', default: 0 },
  ],
  params: [],
  eval: (_i, _p, ctx) => ({ uv: [ctx.u, ctx.v, 0] as NodeValue, u: ctx.u, v: ctx.v }),
});
