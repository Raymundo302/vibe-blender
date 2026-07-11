/**
 * Glyph rasterization (canvas-bound — the only impure module in the pipeline).
 *
 * Draws one character (or word) with `ctx.fillText` at EM_PX px/em into an
 * offscreen canvas and returns the alpha bitmap plus metrics. Everything
 * downstream (trace/simplify/triangulate/layout) operates on the returned
 * arrays, so it is all testable without a canvas.
 */

export const EM_PX = 192;

/** Reusable offscreen canvas — one per (w,h) is wasteful, so we grow one. */
let sharedCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

function getCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (!sharedCanvas) {
    sharedCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
  }
  sharedCanvas.width = w;
  sharedCanvas.height = h;
  return sharedCanvas;
}

function ctx2d(c: HTMLCanvasElement | OffscreenCanvas): CanvasRenderingContext2D {
  return c.getContext('2d') as unknown as CanvasRenderingContext2D;
}

/** Is a font family actually available in the document? */
export function fontAvailable(name: string): boolean {
  try {
    return typeof document !== 'undefined' && document.fonts.check(`16px "${name}"`);
  } catch {
    return false;
  }
}

export interface GlyphRaster {
  width: number;
  height: number;
  /** Row-major alpha (0..255), length width*height. */
  alpha: Uint8Array;
  /** Pen origin x within the bitmap (px). */
  originX: number;
  /** Baseline y within the bitmap (px). */
  baselineY: number;
  /** Horizontal advance for this glyph (px). */
  advance: number;
  ascent: number;
  descent: number;
}

/**
 * Rasterize one glyph (or short word) at emPx px/em. Whitespace glyphs return
 * an all-zero bitmap with a valid advance so layout can still space them.
 */
export function rasterGlyph(char: string, font: string, emPx = EM_PX): GlyphRaster {
  const pad = Math.max(2, Math.ceil(emPx * 0.3));

  // Measure first (a 1x1 context is enough for metrics).
  const mctx = ctx2d(getCanvas(2, 2));
  mctx.font = `${emPx}px "${font}"`;
  mctx.textBaseline = 'alphabetic';
  const m = mctx.measureText(char);
  const advance = m.width;
  const ascent = m.actualBoundingBoxAscent ?? emPx * 0.8;
  const descent = m.actualBoundingBoxDescent ?? emPx * 0.2;
  const left = m.actualBoundingBoxLeft ?? 0;
  const right = m.actualBoundingBoxRight ?? advance;

  const inkW = Math.max(0, Math.ceil(left + right));
  const inkH = Math.max(0, Math.ceil(ascent + descent));
  const w = Math.max(1, inkW + pad * 2);
  const h = Math.max(1, inkH + pad * 2);
  const originX = pad + left;
  const baselineY = pad + ascent;

  const canvas = getCanvas(w, h);
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${emPx}px "${font}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(char, originX, baselineY);

  const img = ctx.getImageData(0, 0, w, h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = img.data[i * 4 + 3];

  return { width: w, height: h, alpha, originX, baselineY, advance, ascent, descent };
}
