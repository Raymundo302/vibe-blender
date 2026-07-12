import { describe, it, expect } from 'vitest';
import { ssimLuma, luminanceOf } from './ssim';

/** Deterministic pseudo-random luminance image in [0,1] (mulberry32). */
function noiseImage(w: number, h: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rand();
  return out;
}

/** A smooth structured image (a couple of gradients + a disc) — the kind SSIM is
 *  designed for, so the noise-perturbation monotonicity below is meaningful. */
function structuredImage(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / (w - 1), gy = y / (h - 1);
      const dx = gx - 0.5, dy = gy - 0.5;
      const disc = Math.hypot(dx, dy) < 0.25 ? 0.6 : 0;
      out[y * w + x] = Math.min(1, 0.2 + 0.4 * gx + 0.3 * gy + disc);
    }
  }
  return out;
}

function addNoise(img: Float32Array, amp: number, seed: number): Float32Array {
  const n = noiseImage(1, img.length, seed);
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) {
    out[i] = Math.min(1, Math.max(0, img[i] + (n[i] - 0.5) * 2 * amp));
  }
  return out;
}

describe('ssimLuma', () => {
  const W = 48, H = 32;

  it('is exactly 1 for identical images', () => {
    const a = structuredImage(W, H);
    expect(ssimLuma(a, a, W, H)).toBeCloseTo(1, 6);
  });

  it('is symmetric', () => {
    const a = structuredImage(W, H);
    const b = addNoise(a, 0.1, 3);
    expect(ssimLuma(a, b, W, H)).toBeCloseTo(ssimLuma(b, a, W, H), 10);
  });

  it('drops sharply for an inverted (structurally opposite) image', () => {
    const a = structuredImage(W, H);
    const inv = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) inv[i] = 1 - a[i];
    // Inversion flips the covariance sign → structure term negative → low SSIM.
    expect(ssimLuma(a, inv, W, H)).toBeLessThan(0.3);
  });

  it('is near-zero for two independent noise fields', () => {
    const a = noiseImage(W, H, 11);
    const b = noiseImage(W, H, 99);
    const s = ssimLuma(a, b, W, H);
    expect(s).toBeGreaterThan(-0.2);
    expect(s).toBeLessThan(0.2);
  });

  it('decreases monotonically as noise amplitude grows', () => {
    const a = structuredImage(W, H);
    const s0 = ssimLuma(a, addNoise(a, 0.02, 1), W, H);
    const s1 = ssimLuma(a, addNoise(a, 0.08, 1), W, H);
    const s2 = ssimLuma(a, addNoise(a, 0.20, 1), W, H);
    expect(s0).toBeGreaterThan(s1);
    expect(s1).toBeGreaterThan(s2);
    // A lightly-noised structured image still scores high; a heavily-noised one low.
    expect(s0).toBeGreaterThan(0.85);
    expect(s2).toBeLessThan(0.7);
  });

  it('handles images smaller than one window via the global fallback', () => {
    const a = structuredImage(6, 6);
    expect(ssimLuma(a, a, 6, 6)).toBeCloseTo(1, 6);
    const b = addNoise(a, 0.3, 7);
    expect(ssimLuma(a, b, 6, 6)).toBeLessThan(0.99);
  });

  it('throws when a buffer is too small for the stated dimensions', () => {
    expect(() => ssimLuma(new Float32Array(10), new Float32Array(10), 48, 32)).toThrow();
  });
});

describe('luminanceOf', () => {
  it('tonemaps and weights RGB to Rec.709 luma', () => {
    // Pure white (1,1,1) → tone(1)=1 → luma 1.
    const white = luminanceOf([1, 1, 1], 1, 1);
    expect(white[0]).toBeCloseTo(1, 6);
    // Pure black → 0.
    expect(luminanceOf([0, 0, 0], 1, 1)[0]).toBeCloseTo(0, 6);
    // Green weighted highest (0.7152).
    const green = luminanceOf([0, 1, 0], 1, 1)[0];
    const red = luminanceOf([1, 0, 0], 1, 1)[0];
    expect(green).toBeGreaterThan(red);
  });

  it('respects a stride of 4 (RGBA input)', () => {
    const rgba = [1, 1, 1, 0.5, 0, 0, 0, 0.5];
    const lum = luminanceOf(rgba, 2, 1, 4);
    expect(lum[0]).toBeCloseTo(1, 6);
    expect(lum[1]).toBeCloseTo(0, 6);
  });
});
