import { describe, it, expect } from 'vitest';
import './coreNodes';
import './nodesB';
import { getNodeDef, type EvalContext, type NodeValue } from './nodeGraph';

// A 2×2 test image, row 0 = top: (0,0)=red (1,0)=green (0,1)=blue (1,1)=white.
// (Mirrors the fixture in renderEngine/textures.test.ts.)
const IMG = {
  width: 2,
  height: 2,
  pixels: new Float32Array([1, 0, 0, 0, 1, 0, /* row1 */ 0, 0, 1, 1, 1, 1]),
};
const URL = 'data:image/png;base64,TESTIMG';
const withImg: EvalContext = { u: 0, v: 0, images: new Map([[URL, IMG]]) };

const imgDef = () => getNodeDef('imageTexture')!;
const rampDef = () => getNodeDef('colorRamp')!;
const mathDef = () => getNodeDef('math')!;

const evalImg = (inputs: Record<string, NodeValue>, params: Record<string, unknown>, ctx: EvalContext) =>
  imgDef().eval(inputs, params, ctx).color as [number, number, number];

describe('imageTexture node', () => {
  it('registered with a uv input, image param and color output', () => {
    const d = imgDef();
    expect(d.inputs.map((s) => s.key)).toEqual(['uv']);
    expect(d.params.map((p) => p.kind)).toEqual(['image']);
    expect(d.outputs.map((s) => s.key)).toEqual(['color']);
    expect(d.params[0].default).toBeNull();
  });

  it('bilinear at texel centers returns each corner (raw v: v=0 = top row — the tracer/GLSL convention)', () => {
    // Sampling row = v directly. uv v=0.25 → TOP row (red left / green right).
    expect(evalImg({ uv: [0.25, 0.25, 0] }, { image: URL }, withImg)).toEqual([1, 0, 0]); // red, top-left
    expect(evalImg({ uv: [0.75, 0.25, 0] }, { image: URL }, withImg)).toEqual([0, 1, 0]); // green, top-right
    // uv v=0.75 → BOTTOM row (blue left / white right).
    expect(evalImg({ uv: [0.25, 0.75, 0] }, { image: URL }, withImg)).toEqual([0, 0, 1]); // blue, bottom-left
    expect(evalImg({ uv: [0.75, 0.75, 0] }, { image: URL }, withImg)).toEqual([1, 1, 1]); // white, bottom-right
  });

  it('center sample bilinearly averages all four corners', () => {
    const c = evalImg({ uv: [0.5, 0.5, 0] }, { image: URL }, withImg);
    // Average of red/green/blue/white = (0.5, 0.5, 0.5).
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0.5);
  });

  it('clamps to edge outside the unit square', () => {
    // v below 0 clamps to the top row; u<0 clamps left → red corner.
    expect(evalImg({ uv: [-0.5, -0.4, 0] }, { image: URL }, withImg)).toEqual([1, 0, 0]);
  });

  it('missing / null / undecoded image → neutral white', () => {
    expect(evalImg({ uv: [0.5, 0.5, 0] }, { image: null }, withImg)).toEqual([1, 1, 1]);
    expect(evalImg({ uv: [0.5, 0.5, 0] }, { image: 'data:not-in-cache' }, withImg)).toEqual([1, 1, 1]);
    expect(evalImg({ uv: [0.5, 0.5, 0] }, { image: URL }, { u: 0, v: 0 })).toEqual([1, 1, 1]);
  });

  it('uses ctx.u/ctx.v when the uv socket is unconnected (NaN sentinel default)', () => {
    const def = imgDef();
    const uvDefault = def.inputs[0].default; // the sentinel the evaluator passes through
    // ctx maps to the top-left red texel: u=0.25, v=0.25 (raw v).
    const ctx: EvalContext = { u: 0.25, v: 0.25, images: new Map([[URL, IMG]]) };
    expect(evalImg({ uv: uvDefault }, { image: URL }, ctx)).toEqual([1, 0, 0]);
  });

  it('prefers the connected uv socket over ctx when connected', () => {
    // ctx points at red (top-left) but the connected uv points at white (bottom-right).
    const ctx: EvalContext = { u: 0.25, v: 0.25, images: new Map([[URL, IMG]]) };
    expect(evalImg({ uv: [0.75, 0.75, 0] }, { image: URL }, ctx)).toEqual([1, 1, 1]);
  });
});

describe('colorRamp node', () => {
  const evalRamp = (fac: number, params: Record<string, unknown>) =>
    rampDef().eval({ fac }, params, { u: 0, v: 0 }).color as [number, number, number];
  const blackWhite = { ramp: { stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }] } };

  it('interpolates linearly between the default black→white stops', () => {
    const c = evalRamp(0.5, blackWhite);
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0.5);
    expect(evalRamp(0.25, blackWhite)[0]).toBeCloseTo(0.25);
  });

  it('returns exact stop colors at the endpoints', () => {
    expect(evalRamp(0, blackWhite)).toEqual([0, 0, 0]);
    expect(evalRamp(1, blackWhite)).toEqual([1, 1, 1]);
  });

  it('clamps fac to [first.pos, last.pos]', () => {
    expect(evalRamp(-5, blackWhite)).toEqual([0, 0, 0]);
    expect(evalRamp(9, blackWhite)).toEqual([1, 1, 1]);
  });

  it('interpolates across three unsorted stops (sorted internally)', () => {
    const ramp = { ramp: { stops: [
      { pos: 1, color: [0, 0, 1] },
      { pos: 0, color: [1, 0, 0] },
      { pos: 0.5, color: [0, 1, 0] },
    ] } };
    // fac 0.25 is halfway between red@0 and green@0.5 → (0.5, 0.5, 0).
    const c = evalRamp(0.25, ramp);
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0);
  });

  it('honors a non-[0,1] stop range for both interp and clamp', () => {
    const ramp = { ramp: { stops: [{ pos: 2, color: [0, 0, 0] }, { pos: 4, color: [1, 1, 1] }] } };
    expect(evalRamp(3, ramp)[0]).toBeCloseTo(0.5);
    expect(evalRamp(0, ramp)).toEqual([0, 0, 0]); // below first.pos → first color
    expect(evalRamp(10, ramp)).toEqual([1, 1, 1]); // above last.pos → last color
  });

  it('falls back to the default ramp on malformed params', () => {
    for (const bad of [
      undefined, null, {}, { stops: [] }, { stops: 'nope' },
      { stops: [{ pos: 'x', color: [0, 0, 0] }] },
      { stops: [{ pos: 0.5, color: [0, 1] }] },
      { stops: [{ pos: 0.5, color: [0, 1, NaN] }] },
    ]) {
      const c = evalRamp(0.5, { ramp: bad });
      expect(c[0]).toBeCloseTo(0.5); // default black→white → mid grey
      expect(c[1]).toBeCloseTo(0.5);
      expect(c[2]).toBeCloseTo(0.5);
    }
  });
});

describe('math node', () => {
  const evalMath = (a: number, b: number, op: string) =>
    mathDef().eval({ a, b }, { op }, { u: 0, v: 0 }).value as number;

  it('registers exactly the seven ops with multiply as default', () => {
    const d = mathDef();
    expect(d.params[0].options).toEqual(['add', 'subtract', 'multiply', 'divide', 'power', 'minimum', 'maximum']);
    expect(d.params[0].default).toBe('multiply');
  });

  it('computes every operation', () => {
    expect(evalMath(2, 3, 'add')).toBe(5);
    expect(evalMath(2, 3, 'subtract')).toBe(-1);
    expect(evalMath(2, 3, 'multiply')).toBe(6);
    expect(evalMath(6, 3, 'divide')).toBe(2);
    expect(evalMath(2, 3, 'power')).toBe(8);
    expect(evalMath(2, 3, 'minimum')).toBe(2);
    expect(evalMath(2, 3, 'maximum')).toBe(3);
  });

  it('unknown op falls back to multiply', () => {
    expect(evalMath(4, 5, 'bogus')).toBe(20);
  });

  it('divide by |b| < 1e-9 → 0', () => {
    expect(evalMath(5, 0, 'divide')).toBe(0);
    expect(evalMath(5, 1e-12, 'divide')).toBe(0);
    expect(evalMath(5, -1e-12, 'divide')).toBe(0);
    expect(evalMath(5, 1e-3, 'divide')).toBeCloseTo(5000);
  });

  it('power of a negative base with a fractional exponent → 0', () => {
    expect(evalMath(-2, 0.5, 'power')).toBe(0);
    expect(evalMath(-2, 2, 'power')).toBe(4); // integer exponent is fine
    expect(evalMath(-2, 3, 'power')).toBe(-8);
    expect(evalMath(4, 0.5, 'power')).toBe(2); // positive base fractional is fine
  });

  it('non-finite results are sanitized to 0', () => {
    expect(evalMath(0, 0, 'divide')).toBe(0);
  });

  it('uses socket defaults (0.5) for missing inputs', () => {
    const d = mathDef();
    expect(d.eval({}, { op: 'add' }, { u: 0, v: 0 }).value).toBeCloseTo(1);
  });
});
