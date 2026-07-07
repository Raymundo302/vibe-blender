/**
 * World properties (P10-4): the scene's environment / sky. Three modes —
 *
 *   flat     : a single background color everywhere.
 *   gradient : a vertical horizon→zenith blend, keyed on the ray's Y.
 *   hdri     : an equirectangular image sampled by view-ray direction, giving
 *              genuine image-based lighting through the path tracer's bounces.
 *
 * The World is plain scene state (no active-object requirement) and lives on
 * Scene.world. `strength` scales the emitted energy (both the viewport
 * background and the tracer sky). `hdri` is the PACKED image, stored Blender-
 * style as a data-URL string so it survives save/load with the scene (see the
 * size tradeoff note in io/sceneJson.ts). `hdriImage` is the DECODED pixel
 * cache — runtime-only, NOT serialized; it is rebuilt from `hdri` on load.
 *
 * This module is pure (no DOM at import time) so the path tracer — which must
 * stay Node-importable — can reuse equirectUV/sampleEquirect. decodeHdriDataUrl
 * is the only browser-only helper and touches the DOM only when called.
 */

/** Decoded equirectangular image: linear RGB, row-major, row 0 = top (+Y). */
export interface HdriImage {
  width: number;
  height: number;
  /** length = width * height * 3, linear-light RGB. */
  data: Float32Array;
}

export interface World {
  mode: 'flat' | 'gradient' | 'hdri';
  /** Flat-mode background color, 0..1 linear RGB. */
  color: [number, number, number];
  /** Gradient-mode horizon (ray pointing at the horizon, Y≈0). */
  horizon: [number, number, number];
  /** Gradient-mode zenith (ray pointing straight up, Y=+1). */
  zenith: [number, number, number];
  /** Multiplies the emitted sky energy. Default 1, clamped ≥ 0 by the UI. */
  strength: number;
  /** Packed HDRI as a data URL (mode 'hdri'), or null. Serialized verbatim. */
  hdri: string | null;
  /** Decoded pixels for the packed HDRI — runtime cache, never serialized. */
  hdriImage?: HdriImage | null;
}

/**
 * The default world is a GRADIENT that reproduces the path tracer's original
 * hardcoded sky EXACTLY (the pre-P10-4 `sky()` lerped ground→up over
 * t = dy*0.5+0.5). Horizon = the old ground color (t=0), zenith = the old up
 * color (t=1), strength 1 — so scenes saved before World existed render byte-
 * identically. THIS IS THE REGRESSION BAR.
 */
export function defaultWorld(): World {
  return {
    mode: 'gradient',
    color: [0.05, 0.05, 0.05],
    horizon: [0.05, 0.05, 0.05],
    zenith: [0.11, 0.13, 0.16],
    strength: 1,
    hdri: null,
    hdriImage: null,
  };
}

/** Deep copy of a World (undo before/after snapshots must not alias). */
export function cloneWorld(w: World): World {
  return {
    mode: w.mode,
    color: [...w.color],
    horizon: [...w.horizon],
    zenith: [...w.zenith],
    strength: w.strength,
    hdri: w.hdri,
    // The decoded cache is a derived, immutable-per-URL blob: share it (it is
    // reproducible from `hdri` and never mutated in place).
    hdriImage: w.hdriImage ?? null,
  };
}

/** A representative average color of the world, for the ambient approximation. */
export function averageWorldColor(w: World): [number, number, number] {
  if (w.mode === 'flat') return [...w.color];
  if (w.mode === 'hdri' && w.hdriImage) {
    const d = w.hdriImage.data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 3;
    for (let i = 0; i < d.length; i += 3) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return n > 0 ? [r / n, g / n, b / n] : [0, 0, 0];
  }
  // gradient (also the hdri-not-yet-decoded fallback)
  return [
    (w.horizon[0] + w.zenith[0]) / 2,
    (w.horizon[1] + w.zenith[1]) / 2,
    (w.horizon[2] + w.zenith[2]) / 2,
  ];
}

/**
 * Equirectangular mapping: unit direction → (u, v) in [0,1].
 *   u = 0.5 + atan2(x, z)/2π   (azimuth; +Z is u=0.5, wraps seamlessly)
 *   v = 0.5 - asin(y)/π        (elevation; +Y up → v=0 top row, -Y → v=1)
 * Pure + deterministic — the unit tests pin known directions to known pixels.
 */
export function equirectUV(dx: number, dy: number, dz: number): { u: number; v: number } {
  const len = Math.hypot(dx, dy, dz) || 1;
  const y = Math.min(1, Math.max(-1, dy / len));
  const u = 0.5 + Math.atan2(dx / len, dz / len) / (2 * Math.PI);
  const v = 0.5 - Math.asin(y) / Math.PI;
  return { u, v };
}

/** Nearest-neighbour equirect sample of an HdriImage into `out` (linear RGB). */
export function sampleEquirect(
  img: HdriImage,
  dx: number, dy: number, dz: number,
  out: [number, number, number],
): void {
  const { u, v } = equirectUV(dx, dy, dz);
  // Wrap u (seam), clamp v (poles).
  let uu = u - Math.floor(u);
  const px = Math.min(img.width - 1, Math.max(0, Math.floor(uu * img.width)));
  const py = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
  const i = (py * img.width + px) * 3;
  out[0] = img.data[i];
  out[1] = img.data[i + 1];
  out[2] = img.data[i + 2];
}

/**
 * Decode a packed HDRI data URL into linear-light pixels (browser only).
 *
 * v1 supports a plain equirectangular PNG/JPEG (image/* data URL): drawn to a
 * canvas, read back, and converted sRGB→linear. Real Radiance .hdr (RGBE)
 * files are NOT parsed here — a .hdr dropped into the file input would need the
 * browser to decode it, which it can't; the UI documents PNG/JPEG equirect as
 * the supported format. The equirect *lighting* is genuine either way.
 */
export function decodeHdriDataUrl(dataUrl: string): Promise<HdriImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('2d context unavailable')); return; }
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const data = new Float32Array(w * h * 3);
        for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
          data[q] = srgbToLinear(rgba[p] / 255);
          data[q + 1] = srgbToLinear(rgba[p + 1] / 255);
          data[q + 2] = srgbToLinear(rgba[p + 2] / 255);
        }
        resolve({ width: w, height: h, data });
      } catch (e) {
        reject(e as Error);
      }
    };
    img.onerror = () => reject(new Error('failed to decode HDRI image'));
    img.src = dataUrl;
  });
}

/** Standard sRGB → linear transfer (the tracer works in linear light). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
