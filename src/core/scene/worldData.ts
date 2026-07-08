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
 * Two paths:
 *  - Radiance RGBE (.hdr): detected by the `#?` magic in the decoded bytes and
 *    parsed natively (parseRgbe) — real high-dynamic-range float pixels, no
 *    browser image decoder involved. Radiance stores LINEAR light already, so
 *    no sRGB conversion is applied.
 *  - Plain equirectangular PNG/JPEG (image/* data URL): drawn to a canvas, read
 *    back, and converted sRGB→linear.
 * The equirect *lighting* is genuine either way.
 */
export function decodeHdriDataUrl(dataUrl: string): Promise<HdriImage> {
  const rgbe = tryDecodeRgbeDataUrl(dataUrl);
  if (rgbe) return Promise.resolve(rgbe);
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

// --- Radiance RGBE (.hdr) parsing -------------------------------------------
//
// The Radiance HDR format: an ASCII header (starting `#?RADIANCE`/`#?RGBE`,
// variable lines, a blank line), a resolution line (`-Y H +X W`), then binary
// scanlines. Each pixel is 4 bytes R,G,B,E; the shared exponent E turns the
// mantissae into HDR floats: rgb = comp · 2^(E-136)  (E=0 ⇒ black). Scanlines
// come in three flavours we handle: new-format adaptive RLE (per-channel run/
// literal, the common case), old-format RLE ((1,1,1,n) repeats the last pixel),
// and flat uncompressed quads. Pure (no DOM) so the tracer can import it too.

/** Decode a data-URL payload to bytes and parse it as RGBE if it has the magic. */
function tryDecodeRgbeDataUrl(dataUrl: string): HdriImage | null {
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes || bytes.length < 2) return null;
  // '#' '?' — the Radiance magic (covers `#?RADIANCE` and `#?RGBE`).
  if (bytes[0] !== 0x23 || bytes[1] !== 0x3f) return null;
  return parseRgbe(bytes);
}

/** Extract the raw bytes of a `data:` URL (base64 or percent-encoded). */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const text = decodeURIComponent(payload);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Parse a Radiance RGBE (.hdr) byte buffer into a linear-light HdriImage
 * (row 0 = top, +Y up — matching the equirect convention). Supports new-format
 * adaptive RLE, old-format RLE, and flat uncompressed scanlines.
 */
export function parseRgbe(bytes: Uint8Array): HdriImage {
  let pos = 0;
  const readLine = (): string => {
    let s = '';
    while (pos < bytes.length) {
      const c = bytes[pos++];
      if (c === 0x0a) break; // '\n'
      s += String.fromCharCode(c);
    }
    return s;
  };

  const magic = readLine();
  if (!/^#\?(RADIANCE|RGBE)/.test(magic)) throw new Error('not a Radiance RGBE file');
  // Header variables until the blank separator line.
  for (let line = readLine(); line.length > 0; line = readLine()) { /* skip vars */ }

  // Resolution line, e.g. "-Y 4 +X 6". We support both axis orderings.
  const res = readLine();
  const m = /^([+-][XY])\s+(\d+)\s+([+-][XY])\s+(\d+)/.exec(res);
  if (!m) throw new Error('bad RGBE resolution line');
  const a1 = m[1], n1 = parseInt(m[2], 10), a2 = m[3], n2 = parseInt(m[4], 10);
  let width: number, height: number, yAxis: string;
  if (a1[1] === 'Y') { yAxis = a1; height = n1; width = n2; }
  else { yAxis = a2; width = n1; height = n2; }
  if (width <= 0 || height <= 0) throw new Error('bad RGBE dimensions');
  // `+Y` first ⇒ scanlines run bottom→top; the standard `-Y` runs top→bottom.
  const flipY = yAxis === '+Y';

  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4); // planar: [R…][G…][B…][E…]
  for (let y = 0; y < height; y++) {
    pos = readRgbeScanline(bytes, pos, scan, width);
    const row = flipY ? height - 1 - y : y;
    let di = row * width * 3;
    for (let x = 0; x < width; x++) {
      const e = scan[3 * width + x];
      if (e === 0) { data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; }
      else {
        const f = Math.pow(2, e - 136); // 2^(E-128) / 256
        data[di] = scan[x] * f;
        data[di + 1] = scan[width + x] * f;
        data[di + 2] = scan[2 * width + x] * f;
      }
      di += 3;
    }
  }
  return { width, height, data };
}

/** Read one scanline into the planar `scan` buffer; returns the new byte offset. */
function readRgbeScanline(bytes: Uint8Array, pos: number, scan: Uint8Array, width: number): number {
  // New-format adaptive RLE marker: 0x02 0x02 then the 16-bit width.
  if (width >= 8 && width <= 0x7fff &&
      bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2] & 0x80) === 0) {
    if (((bytes[pos + 2] << 8) | bytes[pos + 3]) !== width) {
      throw new Error('RGBE scanline width mismatch');
    }
    pos += 4;
    for (let ch = 0; ch < 4; ch++) {
      const base = ch * width;
      let x = 0;
      while (x < width) {
        let count = bytes[pos++];
        if (count > 128) { // run of (count-128) copies of the next byte
          count -= 128;
          const val = bytes[pos++];
          if (x + count > width) throw new Error('RGBE RLE run overflow');
          for (let i = 0; i < count; i++) scan[base + x++] = val;
        } else { // literal run of `count` bytes
          if (x + count > width) throw new Error('RGBE RLE literal overflow');
          for (let i = 0; i < count; i++) scan[base + x++] = bytes[pos++];
        }
      }
    }
    return pos;
  }
  // Flat / old-format: interleaved RGBE quads, with (1,1,1,n) old-RLE repeats.
  let x = 0, shift = 0;
  let pr = 0, pg = 0, pb = 0, pe = 0;
  while (x < width) {
    const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3];
    pos += 4;
    if (r === 1 && g === 1 && b === 1) {
      // Old RLE: repeat the previous pixel (e << 8·shift) times.
      let count = e << (shift * 8);
      shift++;
      while (count-- > 0 && x < width) {
        scan[x] = pr; scan[width + x] = pg; scan[2 * width + x] = pb; scan[3 * width + x] = pe;
        x++;
      }
    } else {
      pr = r; pg = g; pb = b; pe = e; shift = 0;
      scan[x] = r; scan[width + x] = g; scan[2 * width + x] = b; scan[3 * width + x] = e;
      x++;
    }
  }
  return pos;
}
