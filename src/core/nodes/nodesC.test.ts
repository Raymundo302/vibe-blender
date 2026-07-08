import { describe, it, expect } from 'vitest';
import './coreNodes';
import './nodesA';
import './nodesC';
import { getNodeDef, type EvalContext, type NodeValue } from './nodeGraph';
import { buildSnapshot } from '../../renderEngine/snapshot';
import { Scene } from '../scene/Scene';
import { OrbitCamera } from '../../camera/OrbitCamera';
import { makeCube } from '../mesh/primitives';

/** Eval a registered node def with explicit inputs/params and a full ctx. */
function evalNode(
  type: string,
  inputs: Record<string, NodeValue>,
  params: Record<string, unknown>,
  ctx: EvalContext,
): Record<string, NodeValue> {
  const def = getNodeDef(type)!;
  const merged: Record<string, unknown> = {};
  for (const p of def.params) merged[p.key] = p.key in params ? params[p.key] : p.default;
  return def.eval(inputs, merged, ctx);
}

describe('texCoord node', () => {
  it('registers generated + uv vector outputs, no inputs/params', () => {
    const d = getNodeDef('texCoord')!;
    expect(d.inputs).toEqual([]);
    expect(d.params).toEqual([]);
    expect(d.outputs.map((s) => s.key)).toEqual(['generated', 'uv']);
  });

  it('uv output is (u, v, 0)', () => {
    const out = evalNode('texCoord', {}, {}, { u: 0.3, v: 0.7 });
    expect(out.uv).toEqual([0.3, 0.7, 0]);
  });

  it('generated falls back to (u, v, 0) when ctx.gen is absent (bake path)', () => {
    const out = evalNode('texCoord', {}, {}, { u: 0.3, v: 0.7 });
    expect(out.generated).toEqual([0.3, 0.7, 0]);
  });

  it('generated passes ctx.gen through when present (tracer path)', () => {
    const out = evalNode('texCoord', {}, {}, { u: 0.3, v: 0.7, gen: [0.1, 0.2, 0.9] });
    expect(out.generated).toEqual([0.1, 0.2, 0.9]);
    // uv is unaffected by gen.
    expect(out.uv).toEqual([0.3, 0.7, 0]);
  });
});

describe('mapRange node', () => {
  const mr = (value: number, params: Record<string, unknown>) =>
    evalNode('mapRange', { value }, params, { u: 0, v: 0 }).value as number;

  it('remaps [0,1] → [0,10] linearly', () => {
    expect(mr(0, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10 })).toBe(0);
    expect(mr(0.5, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10 })).toBe(5);
    expect(mr(1, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10 })).toBe(10);
  });

  it('remaps an arbitrary input range', () => {
    // [2,4] → [0,1]: value 3 = midpoint → 0.5.
    expect(mr(3, { fromMin: 2, fromMax: 4, toMin: 0, toMax: 1 })).toBe(0.5);
  });

  it('clamps to the output range by default', () => {
    // value below fromMin → below toMin → clamped to toMin.
    expect(mr(-1, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10 })).toBe(0);
    expect(mr(2, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10 })).toBe(10);
  });

  it('clamp works for an inverted output range', () => {
    // to [10,0]: value 2 (past fromMax) maps to -10, clamps to min(10,0)=0.
    expect(mr(2, { fromMin: 0, fromMax: 1, toMin: 10, toMax: 0, clamp: 'yes' })).toBe(0);
  });

  it('clamp = no lets values escape the output range', () => {
    expect(mr(2, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10, clamp: 'no' })).toBe(20);
    expect(mr(-1, { fromMin: 0, fromMax: 1, toMin: 0, toMax: 10, clamp: 'no' })).toBe(-10);
  });

  it('degenerate input range (fromMin == fromMax) outputs toMin', () => {
    expect(mr(0.7, { fromMin: 0.5, fromMax: 0.5, toMin: 3, toMax: 9 })).toBe(3);
    expect(mr(0.7, { fromMin: 0.5, fromMax: 0.5, toMin: 3, toMax: 9, clamp: 'no' })).toBe(3);
  });

  it('default params pass a 0..1 value through unchanged', () => {
    expect(mr(0.42, {})).toBe(0.42);
  });
});

describe('noise contrast (P16-2)', () => {
  const noiseVal = (u: number, v: number, contrast: number) =>
    evalNode('noise', {}, { scale: 5, octaves: 3, contrast }, { u, v }).value as number;

  it('contrast 0 is BIT-IDENTICAL to contrast omitted (default)', () => {
    for (let i = 0; i < 40; i++) {
      const u = (i * 0.137) % 1;
      const v = (i * 0.311) % 1;
      const omitted = evalNode('noise', {}, { scale: 5, octaves: 3 }, { u, v }).value as number;
      const zero = noiseVal(u, v, 0);
      expect(zero).toBe(omitted);
    }
  });

  it('pushes values away from 0.5 monotonically as contrast rises', () => {
    // Find sample points on each side of 0.5, then verify the push direction.
    let above = -1, below = -1;
    for (let i = 0; i < 200 && (above < 0 || below < 0); i++) {
      const u = (i * 0.073) % 1;
      const v = (i * 0.191) % 1;
      const raw = noiseVal(u, v, 0);
      if (raw > 0.55 && above < 0) above = i;
      if (raw < 0.45 && below < 0) below = i;
    }
    expect(above).toBeGreaterThanOrEqual(0);
    expect(below).toBeGreaterThanOrEqual(0);
    const uv = (i: number) => [(i * 0.073) % 1, (i * 0.191) % 1] as const;

    // Above 0.5: rising contrast pushes UP (toward 1), and monotonically.
    const [ua, va] = uv(above);
    const a0 = noiseVal(ua, va, 0);
    const a5 = noiseVal(ua, va, 0.5);
    const a10 = noiseVal(ua, va, 1);
    expect(a5).toBeGreaterThan(a0);
    expect(a10).toBeGreaterThan(a5);

    // Below 0.5: rising contrast pushes DOWN (toward 0), monotonically.
    const [ub, vb] = uv(below);
    const b0 = noiseVal(ub, vb, 0);
    const b5 = noiseVal(ub, vb, 0.5);
    const b10 = noiseVal(ub, vb, 1);
    expect(b5).toBeLessThan(b0);
    expect(b10).toBeLessThan(b5);
  });

  it('output stays in 0..1', () => {
    for (let i = 0; i < 40; i++) {
      const u = (i * 0.137) % 1;
      const v = (i * 0.311) % 1;
      const n = noiseVal(u, v, 1);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});

describe('triGen normalization (P16-2)', () => {
  it('a unit cube maps every corner to 0 or 1 on each axis', () => {
    const scene = new Scene();
    const camera = new OrbitCamera();
    scene.add('Cube', makeCube(1)); // verts in [-1, 1] per axis
    const snap = buildSnapshot(scene, camera);
    expect(snap.triGen).toBeDefined();
    const g = snap.triGen!;
    // Same corner count as UV (3 floats per corner vs 2).
    expect(g.length).toBe((snap.triUV!.length / 2) * 3);
    // Every generated component is exactly 0 or 1 (cube corners hit the AABB
    // extremes on all three axes).
    let seen0 = false, seen1 = false;
    for (let i = 0; i < g.length; i++) {
      expect(g[i] === 0 || g[i] === 1).toBe(true);
      if (g[i] === 0) seen0 = true;
      if (g[i] === 1) seen1 = true;
    }
    expect(seen0 && seen1).toBe(true);
  });
});
