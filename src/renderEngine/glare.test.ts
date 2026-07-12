import { describe, it, expect } from 'vitest';
import { applyGlare, boxRadiusForSigma } from './glare';
import type { GlareSettings } from '../core/scene/objectData';

const glare = (o: Partial<GlareSettings> = {}): GlareSettings => ({
  enabled: true, threshold: 1.0, strength: 0.5, radius: 0.05, ...o,
});

describe('boxRadiusForSigma', () => {
  it('grows monotonically with sigma and is 0 for sigma ≤ 0', () => {
    expect(boxRadiusForSigma(0)).toBe(0);
    expect(boxRadiusForSigma(-3)).toBe(0);
    expect(boxRadiusForSigma(2)).toBeGreaterThanOrEqual(1);
    expect(boxRadiusForSigma(30)).toBeGreaterThan(boxRadiusForSigma(5));
  });
});

describe('applyGlare bright-pass threshold', () => {
  it('leaves a below-threshold buffer untouched (nothing blooms)', () => {
    const w = 16, h = 16;
    const buf = new Float32Array(w * h * 3).fill(0.5); // lum 0.5 < 1.0
    const before = buf.slice();
    applyGlare(buf, w, h, glare());
    expect([...buf]).toEqual([...before]);
  });

  it('is a no-op when disabled or strength 0', () => {
    const w = 8, h = 8;
    const buf = new Float32Array(w * h * 3).fill(5);
    const before = buf.slice();
    applyGlare(buf, w, h, glare({ enabled: false }));
    expect([...buf]).toEqual([...before]);
    applyGlare(buf, w, h, glare({ strength: 0 }));
    expect([...buf]).toEqual([...before]);
  });

  it('spreads a bright pixel into its neighborhood (a halo)', () => {
    const w = 33, h = 33;
    const buf = new Float32Array(w * h * 3); // all zero
    const cx = 16, cy = 16;
    const ci = (cy * w + cx) * 3;
    buf[ci] = buf[ci + 1] = buf[ci + 2] = 20; // one very bright pixel
    applyGlare(buf, w, h, glare({ radius: 0.1 }));
    // A pixel 4 px away, previously black, now has bloom energy.
    const ni = (cy * w + (cx + 4)) * 3;
    expect(buf[ni]).toBeGreaterThan(0);
    // A far corner stays dark.
    const fi = (0 * w + 0) * 3;
    expect(buf[fi]).toBeLessThan(1e-3);
  });
});

describe('applyGlare energy conservation (±strength)', () => {
  it('adds ≈ strength × bright-pass energy back into the frame', () => {
    const w = 48, h = 48;
    const buf = new Float32Array(w * h * 3);
    // A bright block in the centre (well away from the clamp-to-edge borders so
    // the normalized Gaussian conserves the summed energy).
    for (let y = 20; y < 28; y++) {
      for (let x = 20; x < 28; x++) {
        const o = (y * w + x) * 3;
        buf[o] = buf[o + 1] = buf[o + 2] = 6;
      }
    }
    // Expected bright-pass energy = Σ color·(lum-thr)/lum over channels.
    const thr = 1.0;
    let brightEnergy = 0;
    for (let i = 0; i < buf.length; i += 3) {
      const lum = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.4126 * buf[i + 2];
      if (lum > thr) {
        const k = (lum - thr) / lum;
        brightEnergy += (buf[i] + buf[i + 1] + buf[i + 2]) * k;
      }
    }
    const sumBefore = buf.reduce((a, b) => a + b, 0);
    const strength = 0.5;
    applyGlare(buf, w, h, glare({ threshold: thr, strength, radius: 0.05 }));
    const sumAfter = buf.reduce((a, b) => a + b, 0);
    // The separable blur preserves the summed energy → added ≈ strength·bright.
    expect(sumAfter - sumBefore).toBeCloseTo(strength * brightEnergy, 1);
  });
});
