/**
 * Image Viewer (P13-2) — a workspace editor pane that displays 2D images with
 * zoom / pan / per-pixel readout, like Blender's Image Editor. Two source
 * kinds:
 *   - "Render Result": the last completed F12 path-traced frame (read from the
 *     render engine via `getLastRender()`), or a "No render yet" hint.
 *   - a material image slot (Base Color / Normal / Roughness / Metallic) —
 *     decoded from the material's packed data URL through a cached Image.
 *
 * A toolbar (source dropdown + zoom in/out + Fit + pixel readout) sits over a
 * canvas that fills the rest of the pane. Wheel zooms around the pointer, LMB
 * or MMB drag pans, Fit re-letterboxes. Upscales use nearest-neighbour so
 * pixels stay crisp above 1×.
 *
 * The pure view math (fit rect, zoom-around-point, screen↔image mapping) is
 * exported with no DOM dependency for unit testing.
 */
import type { Scene } from '../core/scene/Scene';
import { getLastRender } from '../renderEngine/init';
import './imageViewer.css';

// --- Pure view math (unit-tested) ------------------------------------------

/** Image→screen view: an image pixel (ix,iy) maps to CSS pixel
 *  (panX + ix*zoom, panY + iy*zoom). zoom is image-px → screen-px scale. */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 32;

export function clampZoom(z: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  return Math.max(min, Math.min(max, z));
}

/**
 * Letterbox an imgW×imgH image centred inside a viewW×viewH viewport: pick the
 * largest zoom that fits both axes, then centre. `pad` (0..1) leaves a margin.
 */
export function fitView(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  pad = 0.98,
): ViewTransform {
  if (imgW <= 0 || imgH <= 0 || viewW <= 0 || viewH <= 0) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const zoom = clampZoom(Math.min(viewW / imgW, viewH / imgH) * pad);
  return {
    zoom,
    panX: (viewW - imgW * zoom) / 2,
    panY: (viewH - imgH * zoom) / 2,
  };
}

/** Image-pixel coordinate under a canvas-local CSS point (may be fractional /
 *  out of range — callers floor + bounds-check). */
export function screenToImage(view: ViewTransform, sx: number, sy: number): [number, number] {
  return [(sx - view.panX) / view.zoom, (sy - view.panY) / view.zoom];
}

/** Canvas-local CSS point of an image-pixel coordinate. */
export function imageToScreen(view: ViewTransform, ix: number, iy: number): [number, number] {
  return [view.panX + ix * view.zoom, view.panY + iy * view.zoom];
}

/**
 * Multiply the zoom by `factor` while keeping the image point under screen
 * point (sx,sy) fixed (wheel-zoom-around-cursor). Returns a new transform.
 */
export function zoomAroundPoint(
  view: ViewTransform,
  sx: number,
  sy: number,
  factor: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
): ViewTransform {
  const nextZoom = clampZoom(view.zoom * factor, min, max);
  // Image point currently under (sx,sy) must stay under it afterwards.
  const [ix, iy] = screenToImage(view, sx, sy);
  return {
    zoom: nextZoom,
    panX: sx - ix * nextZoom,
    panY: sy - iy * nextZoom,
  };
}

// --- Source model -----------------------------------------------------------

type MaterialSlot = 'tex' | 'normal' | 'rough' | 'metal';

const SLOT_LABEL: Record<MaterialSlot, string> = {
  tex: 'Base Color',
  normal: 'Normal',
  rough: 'Roughness',
  metal: 'Metallic',
};

const SLOT_ORDER: MaterialSlot[] = ['tex', 'normal', 'rough', 'metal'];

interface SourceOption {
  key: string;
  label: string;
}

/** Data-URL field on a Material for a given slot. */
function slotUrl(mat: {
  texDataUrl: string | null;
  normalDataUrl: string | null;
  roughDataUrl: string | null;
  metalDataUrl: string | null;
}, slot: MaterialSlot): string | null {
  switch (slot) {
    case 'tex': return mat.texDataUrl;
    case 'normal': return mat.normalDataUrl;
    case 'rough': return mat.roughDataUrl;
    case 'metal': return mat.metalDataUrl;
  }
}

// --- The editor -------------------------------------------------------------

export interface ImageViewerDeps {
  scene: Scene;
}

export class ImageViewer {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly select: HTMLSelectElement;
  private readonly readout: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly scene: Scene;

  /** Offscreen canvas holding the current source at natural resolution — the
   *  read-back surface for the pixel readout. */
  private readonly srcCanvas: HTMLCanvasElement;
  private readonly srcCtx: CanvasRenderingContext2D;

  private view: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
  private cssW = 0;
  private cssH = 0;

  private sourceKey = 'render';
  private optionSig = '';
  private options: SourceOption[] = [];

  /** Decoded material images, keyed by data URL. */
  private readonly imgCache = new Map<string, HTMLImageElement>();

  /** Signature of the currently-drawn source (key + natural dims + freshness)
   *  so we auto-Fit only when the source content actually changes. */
  private lastDrawnSig = '';

  private pointer: { x: number; y: number } | null = null;
  private panning: { x: number; y: number } | null = null;

  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;

  constructor(deps: ImageViewerDeps) {
    this.scene = deps.scene;

    this.element = document.createElement('div');
    this.element.className = 'image-viewer';

    // Toolbar.
    const toolbar = document.createElement('div');
    toolbar.className = 'image-viewer-toolbar';

    this.select = document.createElement('select');
    this.select.className = 'image-viewer-source';
    this.select.addEventListener('change', () => this.setSource(this.select.value));

    const zoomOut = document.createElement('button');
    zoomOut.className = 'image-viewer-btn';
    zoomOut.textContent = '−';
    zoomOut.title = 'Zoom out';
    zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.25));

    const zoomIn = document.createElement('button');
    zoomIn.className = 'image-viewer-btn';
    zoomIn.textContent = '+';
    zoomIn.title = 'Zoom in';
    zoomIn.addEventListener('click', () => this.zoomBy(1.25));

    const fitBtn = document.createElement('button');
    fitBtn.className = 'image-viewer-btn image-viewer-fit';
    fitBtn.textContent = 'Fit';
    fitBtn.title = 'Fit image to view';
    fitBtn.addEventListener('click', () => this.fit());

    this.readout = document.createElement('div');
    this.readout.className = 'image-viewer-readout';
    this.readout.textContent = '';

    toolbar.append(this.select, zoomOut, zoomIn, fitBtn, this.readout);

    // Canvas.
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'image-viewer-canvas';
    const c2d = this.canvas.getContext('2d');
    if (!c2d) throw new Error('image viewer: 2D context unavailable');
    this.ctx2d = c2d;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'image-viewer-hint';
    this.hintEl.textContent = 'No render yet — press F12';

    const body = document.createElement('div');
    body.className = 'image-viewer-body';
    body.append(this.canvas, this.hintEl);

    this.element.append(toolbar, body);

    this.srcCanvas = document.createElement('canvas');
    const s2d = this.srcCanvas.getContext('2d', { willReadFrequently: true });
    if (!s2d) throw new Error('image viewer: source 2D context unavailable');
    this.srcCtx = s2d;

    // Interactions on the canvas (never global — this pane is self-contained).
    this.onWheel = (e) => this.handleWheel(e);
    this.onPointerDown = (e) => this.handlePointerDown(e);
    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.onPointerLeave = () => { this.pointer = null; };

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.rebuildOptions();

    // Debug handle for e2e (mirrors the __app / __uvEditor pattern).
    (this.element as unknown as Record<string, unknown>).__imageViewer = {
      canvas: this.canvas,
      sourceKey: () => this.sourceKey,
      optionKeys: () => this.options.map((o) => o.key),
      optionLabels: () => this.options.map((o) => o.label),
      zoom: () => this.view.zoom,
      setSource: (key: string) => { this.select.value = key; this.setSource(key); },
      fit: () => this.fit(),
      wheelAt: (cssX: number, cssY: number, deltaY: number) =>
        this.zoomAt(cssX, cssY, Math.exp(-deltaY * 0.0015)),
      pixelAt: (cssX: number, cssY: number) => this.pixelAt(cssX, cssY),
      readPixel: (cssX: number, cssY: number) => this.readSourcePixel(cssX, cssY),
      sourceSize: () => [this.srcCanvas.width, this.srcCanvas.height],
    };
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
  }

  // --- Source list ----------------------------------------------------------

  /** Cheap signature over the material image slots so we only rebuild the
   *  dropdown when the available images change (not every frame). */
  private materialSignature(): string {
    const parts: string[] = [];
    for (const m of this.scene.materials) {
      let mask = 0;
      SLOT_ORDER.forEach((slot, i) => { if (slotUrl(m, slot)) mask |= 1 << i; });
      if (mask) parts.push(`${m.id}:${m.name}:${mask}`);
    }
    return parts.join('|');
  }

  private rebuildOptions(): void {
    const opts: SourceOption[] = [{ key: 'render', label: 'Render Result' }];
    for (const m of this.scene.materials) {
      for (const slot of SLOT_ORDER) {
        if (slotUrl(m, slot)) {
          opts.push({ key: `mat:${m.id}:${slot}`, label: `${m.name} — ${SLOT_LABEL[slot]}` });
        }
      }
    }
    this.options = opts;
    this.select.textContent = '';
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.key;
      el.textContent = o.label;
      this.select.append(el);
    }
    // Keep the current selection if it still exists, else fall back to render.
    if (!opts.some((o) => o.key === this.sourceKey)) this.sourceKey = 'render';
    this.select.value = this.sourceKey;
  }

  private setSource(key: string): void {
    this.sourceKey = key;
    // Force an auto-Fit on the next draw for the freshly chosen source.
    this.lastDrawnSig = '';
  }

  // --- Resolving the current source to a drawable canvas --------------------

  /** Resolve the current source to a natural-size canvas, or null if none is
   *  available yet (no render / undecoded material image). */
  private resolveSource(): HTMLCanvasElement | null {
    if (this.sourceKey === 'render') {
      const rc = getLastRender();
      if (!rc) return null;
      this.blitToSource(rc, rc.width, rc.height);
      return this.srcCanvas;
    }
    const m = /^mat:(-?\d+):(tex|normal|rough|metal)$/.exec(this.sourceKey);
    if (!m) return null;
    const mat = this.scene.getMaterial(Number(m[1]));
    if (!mat) return null;
    const url = slotUrl(mat, m[2] as MaterialSlot);
    if (!url) return null;
    const img = this.decodedImage(url);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    this.blitToSource(img, img.naturalWidth, img.naturalHeight);
    return this.srcCanvas;
  }

  /** Decode a data URL through a cached Image element. */
  private decodedImage(url: string): HTMLImageElement | null {
    let img = this.imgCache.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      this.imgCache.set(url, img);
    }
    return img;
  }

  private blitToSource(src: CanvasImageSource, w: number, h: number): void {
    if (this.srcCanvas.width !== w) this.srcCanvas.width = w;
    if (this.srcCanvas.height !== h) this.srcCanvas.height = h;
    this.srcCtx.clearRect(0, 0, w, h);
    this.srcCtx.drawImage(src, 0, 0, w, h);
  }

  // --- View controls --------------------------------------------------------

  private fit(): void {
    this.view = fitView(this.srcCanvas.width, this.srcCanvas.height, this.cssW, this.cssH);
  }

  private zoomBy(factor: number): void {
    // Zoom around the viewport centre.
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }

  private zoomAt(cssX: number, cssY: number, factor: number): void {
    this.view = zoomAroundPoint(this.view, cssX, cssY, factor);
  }

  // --- Interaction ----------------------------------------------------------

  private localXY(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const [mx, my] = this.localXY(e);
    this.zoomAt(mx, my, Math.exp(-e.deltaY * 0.0015));
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      this.panning = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const [mx, my] = this.localXY(e);
    this.pointer = { x: mx, y: my };
    if (this.panning) {
      this.view = {
        ...this.view,
        panX: this.view.panX + (e.clientX - this.panning.x),
        panY: this.view.panY + (e.clientY - this.panning.y),
      };
      this.panning = { x: e.clientX, y: e.clientY };
    }
  }

  private handlePointerUp(_e: PointerEvent): void {
    this.panning = null;
  }

  // --- Pixel readout --------------------------------------------------------

  /** [ix, iy, r, g, b, a] of the image pixel under a canvas-local CSS point,
   *  or null if outside the image. Values are the source's stored 0–255. */
  private readSourcePixel(cssX: number, cssY: number): [number, number, number, number, number, number] | null {
    const w = this.srcCanvas.width;
    const h = this.srcCanvas.height;
    if (w === 0 || h === 0) return null;
    const [fx, fy] = screenToImage(this.view, cssX, cssY);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
    const d = this.srcCtx.getImageData(ix, iy, 1, 1).data;
    return [ix, iy, d[0], d[1], d[2], d[3]];
  }

  private updateReadout(): void {
    if (!this.pointer) { this.readout.textContent = ''; return; }
    const p = this.readSourcePixel(this.pointer.x, this.pointer.y);
    if (!p) { this.readout.textContent = ''; return; }
    const [ix, iy, r, g, b] = p;
    this.readout.textContent = `${ix}, ${iy}   ${r} ${g} ${b}`;
  }

  /** Read back a device pixel [r,g,b,a] of the VIEW canvas (e2e helper). */
  private pixelAt(cssX: number, cssY: number): [number, number, number, number] {
    const dpr = window.devicePixelRatio || 1;
    const d = this.ctx2d.getImageData(Math.round(cssX * dpr), Math.round(cssY * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  // --- Frame ----------------------------------------------------------------

  update(): void {
    this.resizeToBody();
    const sig = this.materialSignature();
    if (sig !== this.optionSig) {
      this.optionSig = sig;
      this.rebuildOptions();
    }

    const src = this.resolveSource();
    const hasImage = src !== null && src.width > 0 && src.height > 0;

    // Auto-Fit when the source content changes (first appearance, new image,
    // or a natural-size change). Signature folds the render's sample count in
    // so a progressive render doesn't re-fit on every frame.
    if (hasImage) {
      const fresh = this.sourceKey === 'render' ? String((getLastRender() ? 1 : 0)) : '1';
      const drawnSig = `${this.sourceKey}:${src!.width}x${src!.height}:${fresh}`;
      if (drawnSig !== this.lastDrawnSig) {
        this.lastDrawnSig = drawnSig;
        this.fit();
      }
    } else {
      this.lastDrawnSig = '';
    }

    const showHint = !hasImage && this.sourceKey === 'render';
    this.hintEl.style.display = showHint ? '' : 'none';
    this.hintEl.textContent = this.sourceKey === 'render'
      ? 'No render yet — press F12'
      : 'Image not available';

    this.updateReadout();
    this.draw(hasImage ? src : null);
  }

  private resizeToBody(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.cssW || h !== this.cssH || this.canvas.width !== Math.round(w * dpr)) {
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private draw(src: HTMLCanvasElement | null): void {
    const c = this.ctx2d;
    const W = this.cssW;
    const H = this.cssH;
    if (W === 0 || H === 0) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#101010';
    c.fillRect(0, 0, W, H);
    if (!src) return;

    // Crisp nearest-neighbour pixels above 1× (Blender-style pixel grid).
    c.imageSmoothingEnabled = this.view.zoom <= 1;
    const dw = src.width * this.view.zoom;
    const dh = src.height * this.view.zoom;
    c.drawImage(src, this.view.panX, this.view.panY, dw, dh);
  }
}
