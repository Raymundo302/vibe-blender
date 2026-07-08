import { describe, it, expect } from 'vitest';
import './coreNodes';
import './nodesA';
import { getNodeDef, type EvalContext, type NodeValue } from './nodeGraph';

/** Eval a registered node def directly with given inputs/params at (u,v). */
function evalNode(
  type: string,
  inputs: Record<string, NodeValue>,
  params: Record<string, unknown>,
  u: number,
  v: number,
): Record<string, NodeValue> {
  const def = getNodeDef(type)!;
  const merged: Record<string, unknown> = {};
  for (const p of def.params) merged[p.key] = p.key in params ? params[p.key] : p.default;
  const ctx: EvalContext = { u, v };
  return def.eval(inputs, merged, ctx);
}

describe('checker node', () => {
  it('matches the built-in 8×8 checker parity + colors at scale 8', () => {
    // Built-in: floor(u*8)+floor(v*8) even → 0.2 grey, odd → 1.0 white.
    for (const [u, v] of [[0.05, 0.05], [0.2, 0.7], [0.9, 0.3], [0.5, 0.5]] as const) {
      const sum = Math.floor(u * 8) + Math.floor(v * 8);
      const expected = sum % 2 === 0 ? 0.2 : 1.0;
      const out = evalNode('checker', {}, {}, u, v).color as [number, number, number];
      expect(out).toEqual([expected, expected, expected]);
    }
  });

  it('uses custom colorA / colorB', () => {
    const A: NodeValue = [1, 0, 0];
    const B: NodeValue = [0, 1, 0];
    const even = evalNode('checker', {}, { colorA: A, colorB: B }, 0.05, 0.05).color;
    const odd = evalNode('checker', {}, { colorA: A, colorB: B }, 0.2, 0.05).color;
    expect(even).toEqual([1, 0, 0]);
    expect(odd).toEqual([0, 1, 0]);
  });

  it('scale changes the tiling', () => {
    // At scale 1 the whole 0..1 square is one cell (floor 0 + floor 0 = even).
    const s1 = evalNode('checker', {}, { scale: 1 }, 0.9, 0.9).color as [number, number, number];
    expect(s1[0]).toBe(0.2);
    // At scale 16, (0.9,0.9) lands in a different parity than scale 8.
    const s16 = evalNode('checker', {}, { scale: 16 }, 0.1, 0.05).color as [number, number, number];
    const sum16 = Math.floor(0.1 * 16) + Math.floor(0.05 * 16);
    expect(s16[0]).toBe(sum16 % 2 === 0 ? 0.2 : 1.0);
  });

  it('uv input overrides ctx (convention)', () => {
    // ctx=(0.05,0.05) → even cell; but a connected uv of (0.2,0.05) → odd.
    const out = evalNode('checker', { uv: [0.2, 0.05, 0] }, {}, 0.05, 0.05).color as [number, number, number];
    expect(out).toEqual([1, 1, 1]);
    // Zero-vector uv is treated as unconnected → falls back to ctx.
    const fallback = evalNode('checker', { uv: [0, 0, 0] }, {}, 0.2, 0.05).color as [number, number, number];
    expect(fallback).toEqual([1, 1, 1]);
  });
});

describe('noise node', () => {
  it('is deterministic — two evals of the same point match', () => {
    const a = evalNode('noise', {}, {}, 0.31, 0.62).value as number;
    const b = evalNode('noise', {}, {}, 0.31, 0.62).value as number;
    expect(a).toBe(b);
  });

  it('different lattice cells differ', () => {
    const a = evalNode('noise', {}, { scale: 5 }, 0.1, 0.1).value as number;
    const b = evalNode('noise', {}, { scale: 5 }, 0.9, 0.9).value as number;
    expect(a).not.toBe(b);
  });

  it('output is in 0..1 and color mirrors value', () => {
    for (let i = 0; i < 40; i++) {
      const u = (i * 0.137) % 1;
      const v = (i * 0.311) % 1;
      const r = evalNode('noise', {}, { scale: 7 }, u, v);
      const value = r.value as number;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(r.color).toEqual([value, value, value]);
    }
  });

  it('octaves is floored (3.9 detail == 3 detail)', () => {
    const a = evalNode('noise', {}, { octaves: 3 }, 0.4, 0.7).value as number;
    const b = evalNode('noise', {}, { octaves: 3.9 }, 0.4, 0.7).value as number;
    expect(b).toBe(a);
    // A different integer octave count changes the result.
    const c = evalNode('noise', {}, { octaves: 1 }, 0.4, 0.7).value as number;
    expect(c).not.toBe(a);
  });

  it('uv input overrides ctx', () => {
    const viaCtx = evalNode('noise', {}, { scale: 5 }, 0.8, 0.2).value as number;
    const viaInput = evalNode('noise', { uv: [0.8, 0.2, 0] }, { scale: 5 }, 0.1, 0.1).value as number;
    expect(viaInput).toBe(viaCtx);
  });
});

describe('mixColor node', () => {
  it('lerps a→b by fac', () => {
    const a: NodeValue = [0, 0, 0];
    const b: NodeValue = [1, 1, 1];
    expect(evalNode('mixColor', { a, b, fac: 0 }, {}, 0, 0).color).toEqual([0, 0, 0]);
    expect(evalNode('mixColor', { a, b, fac: 1 }, {}, 0, 0).color).toEqual([1, 1, 1]);
    expect(evalNode('mixColor', { a, b, fac: 0.25 }, {}, 0, 0).color).toEqual([0.25, 0.25, 0.25]);
  });

  it('clamps fac to 0..1', () => {
    const a: NodeValue = [0, 0, 0];
    const b: NodeValue = [1, 1, 1];
    expect(evalNode('mixColor', { a, b, fac: -2 }, {}, 0, 0).color).toEqual([0, 0, 0]);
    expect(evalNode('mixColor', { a, b, fac: 3 }, {}, 0, 0).color).toEqual([1, 1, 1]);
  });

  it('mixes per channel', () => {
    const a: NodeValue = [1, 0, 0];
    const b: NodeValue = [0, 0, 1];
    expect(evalNode('mixColor', { a, b, fac: 0.5 }, {}, 0, 0).color).toEqual([0.5, 0, 0.5]);
  });
});
