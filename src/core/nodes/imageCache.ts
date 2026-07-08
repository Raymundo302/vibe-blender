/**
 * Decoded-image cache for 'image' node params (F14-1 seam, filled by the
 * shader editor / P14 workers). Keyed by data-URL, RAW 0..1 decode (data, not
 * color — the F13-1 map convention). The bake path and the tracer snapshot
 * both read this map; decodeNodeImage fills it asynchronously (browser only).
 */
export interface DecodedImage { width: number; height: number; pixels: Float32Array }

const cache = new Map<string, DecodedImage>();

export function nodeImageCache(): Map<string, DecodedImage> {
  return cache;
}

/** Idempotent async RAW decode into the cache. Resolves when cached. */
export function decodeNodeImage(dataUrl: string): Promise<DecodedImage> {
  const hit = cache.get(dataUrl);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('2d context unavailable')); return; }
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const pixels = new Float32Array(w * h * 3);
      for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
        pixels[q] = rgba[p] / 255;
        pixels[q + 1] = rgba[p + 1] / 255;
        pixels[q + 2] = rgba[p + 2] / 255;
      }
      const decoded = { width: w, height: h, pixels };
      cache.set(dataUrl, decoded);
      resolve(decoded);
    };
    img.onerror = () => reject(new Error('failed to decode node image'));
    img.src = dataUrl;
  });
}
