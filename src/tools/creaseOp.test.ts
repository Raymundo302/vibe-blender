import { describe, it, expect } from 'vitest';
import { creaseWeightFromDrag, CREASE_SENSITIVITY } from './creaseOp';

describe('creaseWeightFromDrag', () => {
  it('adds dx × sensitivity to the base weight', () => {
    expect(creaseWeightFromDrag(0, 100)).toBeCloseTo(100 * CREASE_SENSITIVITY, 6);
    expect(creaseWeightFromDrag(0.2, 40, 0.01)).toBeCloseTo(0.6, 6);
  });

  it('clamps to [0, 1]', () => {
    expect(creaseWeightFromDrag(0, -50)).toBe(0);
    expect(creaseWeightFromDrag(1, 500)).toBe(1);
    expect(creaseWeightFromDrag(0.5, 1000)).toBe(1);
  });
});
