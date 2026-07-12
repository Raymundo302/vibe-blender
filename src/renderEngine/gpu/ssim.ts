/**
 * UR12-4 — Structural SIMilarity (SSIM) on luminance, pure + dependency-free.
 *
 * The GPU/CPU path-tracer parity harness (e2e/gpu-parity.mjs) uses this to score
 * how structurally alike two renders are. SSIM (Wang, Bovik, Sheikh & Simoncelli
 * 2004) is the right metric here because unbiased Monte-Carlo renders differ in
 * per-sample NOISE but share STRUCTURE — a plain mean-abs-diff punishes noise as
 * harshly as a real structural error, SSIM does not.
 *
 * Reference implementation: an 11×11 Gaussian window (σ = 1.5, the canonical
 * choice) slid over every fully-contained center; per-window luminance/contrast/
 * structure compared with the standard stabilisers C1 = (K1·L)², C2 = (K2·L)²,
 * K1 = 0.01, K2 = 0.03, dynamic range L = 1 (inputs are in [0,1]). The returned
 * score is the MEAN SSIM over all windows (a.k.a. MSSIM).
 *
 * Inputs are LUMINANCE arrays in [0,1] (row-major, length w·h). Callers tonemap
 * their HDR radiance and take the Rec.709 luma BEFORE calling — SSIM is a
 * display-domain metric. `luminanceOf` is exported for that.
 *
 * Pure: no globals, no I/O, deterministic. Unit-tested in ssim.test.ts.
 */

const WIN = 11; // window size (must be odd)
const SIGMA = 1.5;
const K1 = 0.01;
const K2 = 0.03;

/** Normalised 11×11 Gaussian kernel (σ=1.5), flattened row-major. Built once. */
const KERNEL: number[] = (() => {
  const r = (WIN - 1) / 2;
  const k: number[] = [];
  let sum = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const g = Math.exp(-(x * x + y * y) / (2 * SIGMA * SIGMA));
      k.push(g);
      sum += g;
    }
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
})();

/** Rec.709 tonemapped luminance (gamma 2.2, clamped) of an interleaved RGB
 *  (or RGBA — stride configurable) HDR buffer → a w·h luminance array in [0,1]. */
export function luminanceOf(
  rgb: Float32Array | number[],
  w: number,
  h: number,
  stride = 3,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * stride;
    const tone = (x: number) => Math.min(1, Math.max(0, Math.pow(Math.max(0, x), 1 / 2.2)));
    out[i] = 0.2126 * tone(rgb[o]) + 0.7152 * tone(rgb[o + 1]) + 0.0722 * tone(rgb[o + 2]);
  }
  return out;
}

/**
 * Mean SSIM between two luminance images (each in [0,1], length w·h).
 * Returns a scalar in roughly [-1, 1]; 1 = identical, near 0 = unrelated.
 * The dynamic range L defaults to 1 (matching [0,1] luminance inputs).
 */
export function ssimLuma(
  a: Float32Array | number[],
  b: Float32Array | number[],
  w: number,
  h: number,
  L = 1,
): number {
  if (a.length < w * h || b.length < w * h) {
    throw new Error(`ssimLuma: buffers too small for ${w}×${h}`);
  }
  const C1 = (K1 * L) * (K1 * L);
  const C2 = (K2 * L) * (K2 * L);
  const r = (WIN - 1) / 2;
  // Degenerate: image smaller than one window → single global window over what
  // fits is meaningless, so fall back to a whole-image SSIM (uniform weights).
  if (w < WIN || h < WIN) {
    return globalSsim(a, b, w, h, C1, C2);
  }

  let acc = 0;
  let count = 0;
  for (let cy = r; cy < h - r; cy++) {
    for (let cx = r; cx < w - r; cx++) {
      let muA = 0, muB = 0;
      let ki = 0;
      for (let dy = -r; dy <= r; dy++) {
        const row = (cy + dy) * w + cx;
        for (let dx = -r; dx <= r; dx++, ki++) {
          const wk = KERNEL[ki];
          muA += wk * a[row + dx];
          muB += wk * b[row + dx];
        }
      }
      let sA = 0, sB = 0, sAB = 0;
      ki = 0;
      for (let dy = -r; dy <= r; dy++) {
        const row = (cy + dy) * w + cx;
        for (let dx = -r; dx <= r; dx++, ki++) {
          const wk = KERNEL[ki];
          const da = a[row + dx] - muA;
          const db = b[row + dx] - muB;
          sA += wk * da * da;
          sB += wk * db * db;
          sAB += wk * da * db;
        }
      }
      const num = (2 * muA * muB + C1) * (2 * sAB + C2);
      const den = (muA * muA + muB * muB + C1) * (sA + sB + C2);
      acc += num / den;
      count++;
    }
  }
  return count > 0 ? acc / count : 1;
}

/** Whole-image single-window SSIM (uniform weights) — used only when an image is
 *  smaller than one 11×11 window. */
function globalSsim(
  a: Float32Array | number[],
  b: Float32Array | number[],
  w: number,
  h: number,
  C1: number,
  C2: number,
): number {
  const n = w * h;
  let muA = 0, muB = 0;
  for (let i = 0; i < n; i++) { muA += a[i]; muB += b[i]; }
  muA /= n; muB /= n;
  let sA = 0, sB = 0, sAB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - muA, db = b[i] - muB;
    sA += da * da; sB += db * db; sAB += da * db;
  }
  sA /= n - 1 || 1; sB /= n - 1 || 1; sAB /= n - 1 || 1;
  const num = (2 * muA * muB + C1) * (2 * sAB + C2);
  const den = (muA * muA + muB * muB + C1) * (sA + sB + C2);
  return num / den;
}
