import type { GlareSettings } from '../core/scene/objectData';

/**
 * Camera Glare / bloom (UR10-2 Part B) — the PURE, reusable post-process seam.
 *
 * Operates on a LINEAR HDR RGB buffer (length w*h*3, row 0 = top): bright-pass
 * (luminance ≥ threshold) → separable Gaussian at `radius` → add ×strength, in
 * place. Deterministic — a pure function of the frame, no temporal state.
 *
 * The F12 tracer path (renderWindow.updateFrame) and the headless Ctrl+F12
 * anim-render path (animRender) both call this on the AVERAGED float radiance
 * buffer BEFORE the shared Reinhard tonemap, so the two seams glow identically.
 * The Rendered viewport uses an equivalent GL pass (glarePass.ts) instead — a
 * camera property applied only through-camera.
 */

/** Rec. 709 luminance of a linear RGB triple. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.4126 * b;
}

/**
 * Box-blur radius that approximates a Gaussian of standard deviation `sigma`
 * when applied in THREE passes (the standard n=3 box→Gaussian identity, ideal
 * width w = sqrt(12σ²/3 + 1)). Exported for the unit test.
 */
export function boxRadiusForSigma(sigma: number): number {
  if (!(sigma > 0)) return 0;
  const w = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  return Math.max(1, Math.round((w - 1) / 2));
}

/**
 * One separable box-blur pass with a sliding-window running sum — O(1) per pixel
 * regardless of radius (the key to staying fast for the wide bloom kernels a
 * live progressive render re-blurs every sample). Clamp-to-edge. `horizontal`
 * picks the axis; reads `src`, writes `dst` (both w*h*3).
 */
function boxBlurPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
): void {
  const norm = 1 / (radius * 2 + 1);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w * 3;
      let r = 0, g = 0, b = 0;
      // Prime the window [−radius, radius] at x = 0 (clamp-to-edge).
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(w - 1, Math.max(0, k)) * 3;
        r += src[row + sx]; g += src[row + sx + 1]; b += src[row + sx + 2];
      }
      for (let x = 0; x < w; x++) {
        const di = row + x * 3;
        dst[di] = r * norm; dst[di + 1] = g * norm; dst[di + 2] = b * norm;
        // Slide: add x+radius+1, drop x-radius.
        const addX = Math.min(w - 1, x + radius + 1) * 3;
        const subX = Math.min(w - 1, Math.max(0, x - radius)) * 3;
        r += src[row + addX] - src[row + subX];
        g += src[row + addX + 1] - src[row + subX + 1];
        b += src[row + addX + 2] - src[row + subX + 2];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      const col = x * 3;
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(h - 1, Math.max(0, k)) * w * 3;
        r += src[col + sy]; g += src[col + sy + 1]; b += src[col + sy + 2];
      }
      for (let y = 0; y < h; y++) {
        const di = y * w * 3 + col;
        dst[di] = r * norm; dst[di + 1] = g * norm; dst[di + 2] = b * norm;
        const addY = Math.min(h - 1, y + radius + 1) * w * 3;
        const subY = Math.min(h - 1, Math.max(0, y - radius)) * w * 3;
        r += src[col + addY] - src[col + subY];
        g += src[col + addY + 1] - src[col + subY + 1];
        b += src[col + addY + 2] - src[col + subY + 2];
      }
    }
  }
}

/** Three-pass separable box blur (≈ Gaussian) at the given per-pass box radius,
 *  in place on `buf` (using `tmp` as scratch, both w*h*3). */
function boxBlur3(buf: Float32Array, tmp: Float32Array, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(buf, tmp, w, h, radius, true);
    boxBlurPass(tmp, buf, w, h, radius, false);
  }
}

/**
 * Apply glare to a LINEAR HDR RGB buffer in place. No-op when disabled or when
 * strength ≤ 0. Pure aside from mutating `buf`.
 */
export function applyGlare(
  buf: Float32Array,
  w: number,
  h: number,
  glare: GlareSettings,
): void {
  if (!glare.enabled || !(glare.strength > 0) || w < 1 || h < 1) return;
  const n = w * h;
  // Bright-pass: keep only the energy above the threshold (soft knee = plain
  // subtract, clamped ≥ 0), preserving color ratio.
  const bright = new Float32Array(n * 3);
  const thr = glare.threshold;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const lum = luminance(buf[o], buf[o + 1], buf[o + 2]);
    if (lum > thr) {
      const k = (lum - thr) / Math.max(lum, 1e-6);
      bright[o] = buf[o] * k;
      bright[o + 1] = buf[o + 1] * k;
      bright[o + 2] = buf[o + 2] * k;
    }
  }
  // Separable blur at radius = fraction of image height, via a fast 3-pass box
  // blur (≈ Gaussian) — O(1) per pixel in the radius so a live progressive render
  // can re-blur every sample without stalling the tab.
  const sigma = glare.radius * h;
  const tmp = new Float32Array(n * 3);
  boxBlur3(bright, tmp, w, h, boxRadiusForSigma(sigma));
  // Additive composite.
  const s = glare.strength;
  for (let i = 0; i < n * 3; i++) buf[i] += bright[i] * s;
}
