import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import { applyAnimation } from '../core/anim/sampler';
import './animRender.css';

/**
 * P16-1 — Render Animation (🎞 / Ctrl+F12).
 *
 * Loops the scene's frame range, poses each frame with applyAnimation, forces a
 * Rendered-mode renderer pass looking THROUGH the active camera, and captures
 * the viewport canvas per frame into one of two outputs:
 *   - WebM video: canvas.captureStream(0) + MediaRecorder, one requestFrame per
 *     rendered frame, spaced at 1/fps so the recorder timestamps at the target
 *     rate. → single .webm download.
 *   - PNG sequence: gl.readPixels each frame → an offscreen 2D canvas → toBlob,
 *     packed into a minimal STORE-only (no compression) ZIP (implemented below,
 *     CRC32 table) → single .zip download.
 *
 * A small modal picks mode / fps / start / end and shows a progress bar + frame
 * counter + a working Cancel. Prior frameCurrent, playing state and shading mode
 * are restored when the run ends (completed OR cancelled).
 *
 * The pure helpers (frameCount, crc32, buildStoreZip) are exported for unit
 * tests; they touch no DOM.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — no DOM)
// ---------------------------------------------------------------------------

/** Inclusive frame count for a [start, end] range (integer frames). */
export function frameCount(start: number, end: number): number {
  return Math.floor(end) - Math.floor(start) + 1;
}

// CRC32 (IEEE 802.3, reflected) with a lazily-built lookup table.
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC32 of a byte array, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Build a STORE-only (uncompressed) ZIP archive from entries. Emits per-entry
 * local file headers + a central directory + end-of-central-directory record,
 * all little-endian per PKZIP APPNOTE. Deterministic (fixed DOS date/time), so
 * the same inputs always produce byte-identical output.
 */
export function buildStoreZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const LOCAL_SIG = 0x04034b50;
  const CEN_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  // Fixed DOS date/time (2020-01-01 00:00:00) for determinism.
  const DOS_TIME = 0;
  const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(e.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CEN_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); // compressed size
    cv.setUint32(24, size, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

// ---------------------------------------------------------------------------
// Render controller (DOM)
// ---------------------------------------------------------------------------

export type AnimRenderMode = 'webm' | 'png';

export interface AnimRenderOptions {
  mode: AnimRenderMode;
  start?: number;
  end?: number;
  fps?: number;
}

export interface AnimRenderContext {
  scene: Scene;
  camera: OrbitCamera;
  renderer: Renderer;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  setStatus: (text: string) => void;
  host: HTMLElement;
}

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AnimRender {
  private running = false;
  private cancelled = false;
  private scratch: HTMLCanvasElement | null = null;

  // Modal DOM (built lazily on first open).
  private modal: HTMLDivElement | null = null;
  private modeSel!: HTMLSelectElement;
  private fpsInput!: HTMLInputElement;
  private startInput!: HTMLInputElement;
  private endInput!: HTMLInputElement;
  private renderBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private progressFill!: HTMLDivElement;
  private counterEl!: HTMLDivElement;
  private msgEl!: HTMLDivElement;

  constructor(private readonly ctx: AnimRenderContext) {
    // Ctrl+F12 toggles the modal. Registered in the CAPTURE phase and
    // stopPropagation()'d so the render engine's plain-F12 window handler
    // (bubble phase, no modifier check) does not also fire.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'F12' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          this.toggle();
        }
      },
      true,
    );
  }

  // --- Modal ---------------------------------------------------------------

  toggle(): void {
    if (this.modal && this.modal.isConnected) this.closeModal();
    else this.openModal();
  }

  openModal(): void {
    if (!this.modal) this.buildModal();
    const s = this.ctx.scene;
    this.fpsInput.value = String(s.fps);
    this.startInput.value = String(s.frameStart);
    this.endInput.value = String(s.frameEnd);
    this.setMessage('');
    this.setProgress(0, 0);
    this.ctx.host.appendChild(this.modal!);
    this.setBusy(this.running);
  }

  closeModal(): void {
    if (this.modal && this.modal.isConnected) this.modal.remove();
  }

  private buildModal(): void {
    const modal = document.createElement('div');
    modal.className = 'anim-render-overlay';
    modal.dataset.testid = 'anim-render';

    const panel = document.createElement('div');
    panel.className = 'anim-render-panel';

    const title = document.createElement('div');
    title.className = 'anim-render-title';
    title.textContent = '🎞 Render Animation';

    const grid = document.createElement('div');
    grid.className = 'anim-render-grid';

    this.modeSel = document.createElement('select');
    this.modeSel.className = 'anim-render-input';
    for (const [val, label] of [['webm', 'WebM video'], ['png', 'PNG sequence']] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      this.modeSel.appendChild(opt);
    }
    grid.append(this.label('Mode'), this.modeSel);

    this.fpsInput = this.numberInput(1, 240);
    grid.append(this.label('FPS'), this.fpsInput);
    this.startInput = this.numberInput(-100000, 100000);
    grid.append(this.label('Start'), this.startInput);
    this.endInput = this.numberInput(-100000, 100000);
    grid.append(this.label('End'), this.endInput);

    const progress = document.createElement('div');
    progress.className = 'anim-render-progress';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'anim-render-progress-fill';
    progress.appendChild(this.progressFill);

    this.counterEl = document.createElement('div');
    this.counterEl.className = 'anim-render-counter';

    this.msgEl = document.createElement('div');
    this.msgEl.className = 'anim-render-msg';

    const buttons = document.createElement('div');
    buttons.className = 'anim-render-buttons';
    this.renderBtn = document.createElement('button');
    this.renderBtn.className = 'anim-render-btn anim-render-btn-primary';
    this.renderBtn.textContent = 'Render';
    this.renderBtn.addEventListener('click', () => void this.onRenderClick());
    this.cancelBtn = document.createElement('button');
    this.cancelBtn.className = 'anim-render-btn';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.addEventListener('click', () => {
      if (this.running) this.cancel();
      else this.closeModal();
    });
    buttons.append(this.renderBtn, this.cancelBtn);

    panel.append(title, grid, progress, this.counterEl, this.msgEl, buttons);
    modal.appendChild(panel);
    this.modal = modal;
  }

  private label(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'anim-render-label';
    el.textContent = text;
    return el;
  }

  private numberInput(min: number, max: number): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'anim-render-input';
    el.min = String(min);
    el.max = String(max);
    return el;
  }

  private async onRenderClick(): Promise<void> {
    const mode = this.modeSel.value as AnimRenderMode;
    const fps = Number(this.fpsInput.value);
    const start = Math.round(Number(this.startInput.value));
    const end = Math.round(Number(this.endInput.value));
    let blob: Blob | null = null;
    try {
      blob = await this.render({ mode, fps, start, end });
    } catch (err) {
      this.setMessage((err as Error).message);
      return;
    }
    if (!blob) return; // cancelled
    const ext = mode === 'webm' ? 'webm' : 'zip';
    this.download(blob, `animation.${ext}`);
    this.setMessage('Saved animation.' + ext);
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  private setMessage(text: string): void {
    if (this.msgEl) this.msgEl.textContent = text;
  }

  private setProgress(done: number, total: number): void {
    if (!this.progressFill) return;
    const pct = total > 0 ? (done / total) * 100 : 0;
    this.progressFill.style.width = `${pct}%`;
    this.counterEl.textContent = total > 0 ? `Frame ${done} / ${total}` : '';
  }

  private setBusy(busy: boolean): void {
    if (!this.modal) return;
    this.renderBtn.disabled = busy;
    this.modeSel.disabled = busy;
    this.fpsInput.disabled = busy;
    this.startInput.disabled = busy;
    this.endInput.disabled = busy;
    this.cancelBtn.textContent = busy ? 'Cancel' : 'Close';
  }

  // --- Rendering -----------------------------------------------------------

  /** True while a render is in flight. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Request the in-flight render to stop; the render() promise resolves null. */
  cancel(): void {
    if (this.running) {
      this.cancelled = true;
      this.ctx.setStatus('Render Animation cancelled');
    }
  }

  /**
   * Render the frame range to a Blob (webm video or store-only png zip).
   * Resolves null if cancelled. Rejects only on invalid input (start >= end).
   * Restores frameCurrent / playing / shading mode / camera view afterwards.
   */
  async render(opts: AnimRenderOptions): Promise<Blob | null> {
    if (this.running) throw new Error('A render is already in progress');
    const { scene, renderer } = this.ctx;
    const start = Math.round(opts.start ?? scene.frameStart);
    const end = Math.round(opts.end ?? scene.frameEnd);
    const fps = Math.max(1, Math.round(opts.fps ?? scene.fps));
    if (start >= end) {
      this.setMessage('Start frame must be before End frame');
      this.ctx.setStatus('Render Animation: start must be < end');
      throw new Error('start must be < end');
    }

    const saved = {
      frame: scene.frameCurrent,
      playing: scene.playing,
      shading: renderer.shadingMode,
      cameraViewId: renderer.cameraViewId,
    };

    this.running = true;
    this.cancelled = false;
    this.setBusy(true);
    this.setMessage('Rendering…');

    scene.playing = false;
    renderer.shadingMode = 'rendered';
    if (scene.activeCameraId !== null) renderer.cameraViewId = scene.activeCameraId;

    const total = frameCount(start, end);
    let blob: Blob | null = null;
    try {
      if (opts.mode === 'webm') blob = await this.renderWebm(start, end, fps, total);
      else blob = await this.renderPng(start, end, total);
    } finally {
      renderer.shadingMode = saved.shading;
      renderer.cameraViewId = saved.cameraViewId;
      scene.playing = saved.playing;
      scene.frameCurrent = saved.frame;
      applyAnimation(scene, saved.frame);
      this.running = false;
      this.setBusy(false);
    }

    if (this.cancelled) {
      this.setProgress(0, 0);
      this.setMessage('Cancelled');
      return null;
    }
    this.ctx.setStatus(`Rendered ${total} frames`);
    return blob;
  }

  /** Pose + draw one frame in Rendered mode through the active camera. */
  private drawFrame(frame: number): void {
    const { scene, renderer, camera } = this.ctx;
    scene.frameCurrent = frame;
    applyAnimation(scene, frame);
    renderer.render(scene, camera);
  }

  /**
   * Read the just-rendered WebGL buffer into a Y-flipped 2D canvas. readPixels
   * is synchronous, so this captures the exact frame regardless of the context's
   * preserveDrawingBuffer setting. Returns the 2D canvas (reused across frames).
   */
  private captureToScratch(): HTMLCanvasElement {
    const { gl, canvas } = this.ctx;
    const w = canvas.width;
    const h = canvas.height;
    if (!this.scratch) this.scratch = document.createElement('canvas');
    if (this.scratch.width !== w) this.scratch.width = w;
    if (this.scratch.height !== h) this.scratch.height = h;
    const c2d = this.scratch.getContext('2d')!;
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // GL origin is bottom-left; flip rows into an ImageData (top-left origin).
    const img = c2d.createImageData(w, h);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const src = y * rowBytes;
      const dst = (h - 1 - y) * rowBytes;
      img.data.set(pixels.subarray(src, src + rowBytes), dst);
    }
    c2d.putImageData(img, 0, 0);
    return this.scratch;
  }

  private async renderPng(start: number, end: number, total: number): Promise<Blob | null> {
    const entries: ZipEntry[] = [];
    let done = 0;
    for (let f = start; f <= end; f++) {
      if (this.cancelled) break;
      this.drawFrame(f);
      const scratch = this.captureToScratch();
      const png = await new Promise<Blob | null>((res) => scratch.toBlob((b) => res(b), 'image/png'));
      if (this.cancelled) break;
      if (png) {
        const buf = new Uint8Array(await png.arrayBuffer());
        entries.push({ name: `frame_${String(f).padStart(4, '0')}.png`, data: buf });
      }
      done++;
      this.setProgress(done, total);
      await raf();
    }
    if (this.cancelled) return null;
    return new Blob([buildStoreZip(entries) as unknown as BlobPart], { type: 'application/zip' });
  }

  private async renderWebm(start: number, end: number, fps: number, total: number): Promise<Blob | null> {
    const { canvas } = this.ctx;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise<void>((res) => { recorder.onstop = () => res(); });
    recorder.start();

    let done = 0;
    const frameMs = 1000 / fps;
    for (let f = start; f <= end; f++) {
      if (this.cancelled) break;
      this.drawFrame(f);
      // requestFrame captures the current drawing buffer synchronously.
      track.requestFrame();
      done++;
      this.setProgress(done, total);
      await delay(frameMs);
    }

    recorder.stop();
    await stopped;
    track.stop();
    if (this.cancelled) return null;
    return new Blob(chunks, { type: 'video/webm' });
  }
}
