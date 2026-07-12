import { describe, it, expect } from 'vitest';
import {
  makeMaterial,
  gradientT,
  evalGradientColor,
  evalGradientScalar,
  materialAlphaAt,
  shaderOverrides,
  getMaterialChannel,
  setMaterialChannel,
  channelsForShader,
  materialShader,
  type GradientInput,
} from '../core/scene/objectData';
import { prepareScene, renderSample } from './tracer';
import type { Snapshot, SnapMaterial, SnapCamera, SnapWorld } from './snapshot';

// UR16-1 — shader model v2: gradient closed-form, alpha semantics, shader
// overrides, channel socket round-trips, and the tracer's stochastic-alpha +
// object-space gradient rendering.

describe('gradient closed-form (UR16-1)', () => {
  const g: GradientInput = { kind: 'gradient', a: [1, 0, 0], b: [0, 0, 1], axis: 'x', offset: 0, scale: 1 };

  it('gradientT clamps p·scale + offset into 0..1', () => {
    expect(gradientT(g, -1, 0, 0)).toBe(0);   // clamp low
    expect(gradientT(g, 0, 0, 0)).toBe(0);
    expect(gradientT(g, 0.5, 0, 0)).toBeCloseTo(0.5, 6);
    expect(gradientT(g, 1, 0, 0)).toBe(1);
    expect(gradientT(g, 2, 0, 0)).toBe(1);     // clamp high
  });

  it('scale + offset shift/stretch the ramp', () => {
    const g2: GradientInput = { ...g, offset: 0.5, scale: 0.5 };
    expect(gradientT(g2, -1, 0, 0)).toBe(0);        // 0.5·-1+0.5 = 0
    expect(gradientT(g2, 0, 0, 0)).toBeCloseTo(0.5, 6);
    expect(gradientT(g2, 1, 0, 0)).toBe(1);         // 0.5·1+0.5 = 1
  });

  it('axis selects x/y/z', () => {
    const gy: GradientInput = { ...g, axis: 'y' };
    const gz: GradientInput = { ...g, axis: 'z' };
    expect(gradientT(gy, 9, 0.25, 9)).toBeCloseTo(0.25, 6);
    expect(gradientT(gz, 9, 9, 0.75)).toBeCloseTo(0.75, 6);
  });

  it('evalGradientColor lerps a→b at t', () => {
    expect(evalGradientColor(g, 0, 0, 0)).toEqual([1, 0, 0]);
    expect(evalGradientColor(g, 1, 0, 0)).toEqual([0, 0, 1]);
    const mid = evalGradientColor(g, 0.5, 0, 0);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[2]).toBeCloseTo(0.5, 6);
  });

  it('evalGradientScalar uses the RED component', () => {
    const gs: GradientInput = { kind: 'gradient', a: [0.2, 9, 9], b: [0.8, 9, 9], axis: 'z', offset: 0, scale: 1 };
    expect(evalGradientScalar(gs, 0, 0, 0)).toBeCloseTo(0.2, 6);
    expect(evalGradientScalar(gs, 0, 0, 1)).toBeCloseTo(0.8, 6);
    expect(evalGradientScalar(gs, 0, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('alpha 0/0.5/1 semantics (UR16-1)', () => {
  it('materialAlphaAt returns the value for a value channel, clamped', () => {
    expect(materialAlphaAt({ alpha: { kind: 'value', value: 0 } }, 0, 0, 0)).toBe(0);
    expect(materialAlphaAt({ alpha: { kind: 'value', value: 0.5 } }, 0, 0, 0)).toBe(0.5);
    expect(materialAlphaAt({ alpha: { kind: 'value', value: 1 } }, 0, 0, 0)).toBe(1);
    expect(materialAlphaAt({ alpha: { kind: 'value', value: 2 } }, 0, 0, 0)).toBe(1);
    expect(materialAlphaAt({ alpha: undefined }, 0, 0, 0)).toBe(1); // default opaque
  });

  it('materialAlphaAt evaluates a gradient alpha at the local position', () => {
    const alpha: GradientInput = { kind: 'gradient', a: [0, 0, 0], b: [1, 0, 0], axis: 'x', offset: 0, scale: 1 };
    expect(materialAlphaAt({ alpha }, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(materialAlphaAt({ alpha }, 1, 0, 0)).toBeCloseTo(1, 6);
    expect(materialAlphaAt({ alpha }, 0.5, 0, 0)).toBeCloseTo(0.5, 6);
  });
});

describe('named-shader BRDF overrides (UR16-1)', () => {
  it('maps each shader to its BRDF forcing (metal/glass/emit force; others honor)', () => {
    expect(shaderOverrides({ shader: 'metal', transmission: 0 })).toEqual({ metallic: 1 });
    expect(shaderOverrides({ shader: 'glass', transmission: 0 })).toEqual({ metallic: 0, transmission: 1 });
    expect(shaderOverrides({ shader: 'emit', transmission: 0 })).toEqual({ shadeless: true });
    expect(shaderOverrides({ shader: 'diffuse', transmission: 0 })).toEqual({});
    expect(shaderOverrides({ shader: 'super', transmission: 0.3 })).toEqual({});
    // Absent shader → 'super' (everything honored, no forcing).
    expect(shaderOverrides({ shader: undefined, transmission: 0.3 })).toEqual({});
  });

  it('channelsForShader exposes the right rows', () => {
    expect(channelsForShader('diffuse')).toEqual(['color', 'roughness', 'alpha']);
    expect(channelsForShader('emit')).toEqual(['color', 'alpha']);
    expect(channelsForShader('super')).toContain('metallic');
  });

  it('materialShader defaults absent → super', () => {
    expect(materialShader({ shader: undefined })).toBe('super');
    expect(materialShader({ shader: 'metal' })).toBe('metal');
  });
});

describe('channel socket get/set round-trip (UR16-1)', () => {
  it('a fresh diffuse material reads value channels', () => {
    const m = makeMaterial(1, 'M');
    expect(m.shader).toBe('diffuse');
    expect(getMaterialChannel(m, 'color')).toEqual({ kind: 'value', value: [0.8, 0.8, 0.8] });
    expect(getMaterialChannel(m, 'alpha')).toEqual({ kind: 'value', value: 1 });
  });

  it('setMaterialChannel image → getMaterialChannel image (color)', () => {
    const m = makeMaterial(1, 'M');
    setMaterialChannel(m, 'color', { kind: 'image', dataUrl: 'data:img' });
    expect(m.texKind).toBe('image');
    expect(m.texDataUrl).toBe('data:img');
    expect(getMaterialChannel(m, 'color')).toEqual({ kind: 'image', dataUrl: 'data:img' });
  });

  it('setMaterialChannel gradient wins over value/image on every channel', () => {
    const m = makeMaterial(1, 'M');
    const g: GradientInput = { kind: 'gradient', a: [1, 0, 0], b: [0, 1, 0], axis: 'z', offset: 0, scale: 1 };
    setMaterialChannel(m, 'color', g);
    setMaterialChannel(m, 'roughness', g);
    setMaterialChannel(m, 'metallic', g);
    setMaterialChannel(m, 'alpha', g);
    expect(getMaterialChannel(m, 'color')).toBe(m.colorGradient);
    expect(getMaterialChannel(m, 'roughness')).toBe(m.roughGradient);
    expect(getMaterialChannel(m, 'metallic')).toBe(m.metalGradient);
    expect(getMaterialChannel(m, 'alpha')).toBe(m.alpha);
  });

  it('switching a gradient channel back to value clears the gradient', () => {
    const m = makeMaterial(1, 'M');
    const g: GradientInput = { kind: 'gradient', a: [1, 0, 0], b: [0, 1, 0], axis: 'z', offset: 0, scale: 1 };
    setMaterialChannel(m, 'roughness', g);
    expect(m.roughGradient).toBeDefined();
    setMaterialChannel(m, 'roughness', { kind: 'value', value: 0.3 });
    expect(m.roughGradient).toBeUndefined();
    expect(m.roughness).toBe(0.3);
  });
});

// --- Tracer integration: stochastic alpha + object-space gradient ------------

const FLAT_BLUE: SnapWorld = { mode: 0, color: [0, 0, 1], horizon: [0, 0, 1], zenith: [0, 0, 1], strength: 1, hdri: null };
const CAM: SnapCamera = { position: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], fovY: Math.PI / 3 };

/** A big quad at z=-2 covering the view, two triangles. Corner order per tri
 *  matches tris/triLocal (A,B,C). Returns { tris, local }. */
function quad(): { tris: number[]; local: number[] } {
  const t = [
    -3, -3, -2, 3, -3, -2, 3, 3, -2,
    -3, -3, -2, 3, 3, -2, -3, 3, -2,
  ];
  return { tris: t, local: [...t] }; // no transform → local == world here
}

function shadelessMat(over: Partial<SnapMaterial>): SnapMaterial {
  return {
    baseColor: [1, 0, 0], metallic: 0, roughness: 0.5, emissive: [0, 0, 0], emissiveStrength: 0,
    subsurfaceWeight: 0, subsurfaceRadius: 0.05, shadeless: true, ...over,
  };
}

function avgColor(mat: SnapMaterial, w = 12, h = 12, passes = 120): [number, number, number] {
  const q = quad();
  const snap: Snapshot = {
    tris: new Float32Array(q.tris),
    triMat: Int32Array.from([0, 0]),
    triLocal: new Float32Array(q.local),
    materials: [mat],
    lights: [],
    camera: CAM,
    world: FLAT_BLUE,
  };
  const scene = prepareScene(snap);
  const acc = new Float32Array(w * h * 3);
  for (let s = 0; s < passes; s++) renderSample(scene, acc, w, h, s, 0x1234567);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < acc.length; i += 3) { r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; }
  const n = w * h * passes;
  return [r / n, g / n, b / n];
}

describe('tracer stochastic alpha (UR16-1)', () => {
  it('alpha 1 = fully opaque red plane (no blue sky bleeds through)', () => {
    const [r, , b] = avgColor(shadelessMat({ baseColor: [1, 0, 0], alpha: 1 }));
    expect(r).toBeGreaterThan(0.95);
    expect(b).toBeLessThan(0.05);
  });

  it('alpha 0 = fully transparent (only the blue sky shows)', () => {
    const [r, , b] = avgColor(shadelessMat({ baseColor: [1, 0, 0], alpha: 0 }));
    expect(r).toBeLessThan(0.05);
    expect(b).toBeGreaterThan(0.95);
  });

  it('alpha 0.5 = half red / half blue (stochastic pass-through)', () => {
    const [r, , b] = avgColor(shadelessMat({ baseColor: [1, 0, 0], alpha: 0.5 }));
    expect(r).toBeGreaterThan(0.4);
    expect(r).toBeLessThan(0.6);
    expect(b).toBeGreaterThan(0.4);
    expect(b).toBeLessThan(0.6);
  });
});

describe('tracer object-space color gradient (UR16-1)', () => {
  it('left of the plane reads endpoint a, right reads endpoint b', () => {
    // Gradient along x: red at x≈-10 → green at x≈+10. A large plane (±50) so every
    // ray in view hits it. t = x/20 + 0.5.
    const grad: GradientInput = { kind: 'gradient', a: [1, 0, 0], b: [0, 1, 0], axis: 'x', offset: 0.5, scale: 1 / 20 };
    const mat = shadelessMat({ colorGradient: grad, alpha: 1 });
    const big = [
      -50, -50, -2, 50, -50, -2, 50, 50, -2,
      -50, -50, -2, 50, 50, -2, -50, 50, -2,
    ];
    const w = 16, h = 8, passes = 4;
    const snap: Snapshot = {
      tris: new Float32Array(big), triMat: Int32Array.from([0, 0]),
      triLocal: new Float32Array(big), materials: [mat], lights: [], camera: CAM, world: FLAT_BLUE,
    };
    const scene = prepareScene(snap);
    const acc = new Float32Array(w * h * 3);
    for (let s = 0; s < passes; s++) renderSample(scene, acc, w, h, s, 0x1234567);
    // Sample an inner-left column pixel and an inner-right pixel (row middle).
    const px = (x: number) => { const i = ((h >> 1) * w + x) * 3; return [acc[i] / passes, acc[i + 1] / passes, acc[i + 2] / passes]; };
    const left = px(2), right = px(w - 3);
    expect(left[0]).toBeGreaterThan(left[1]);   // inner-left is redder
    expect(right[1]).toBeGreaterThan(right[0]);  // inner-right is greener
  });
});
