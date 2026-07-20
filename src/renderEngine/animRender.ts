import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Renderer } from '../render/Renderer';
import { applyAnimation } from '../core/anim/sampler';
import { buildSnapshot } from './snapshot';
import { prepareScene, renderSample } from './tracer';
import { getGpuTracer } from './gpu/sharedTracer';
import { initialRows, rowsForSample } from '../render/viewportRay';
import { tonemapAccumToRgba } from './renderWindow';
import { viewPrefs, saveViewPrefs, type AnimFormat } from '../render/viewPrefs';
import './animRender.css';

/**
 * P16-1 / UR5-3 — Render Animation (🎞 / Ctrl+F12).
 *
 * Loops the scene's frame range, poses each frame with applyAnimation, and
 * captures a final frame per frame from one of two ENGINES into one of three
 * FORMATS:
 *
 * Engines:
 *   - Viewport: forces a Rendered-mode renderer pass looking THROUGH the active
 *     camera (the original P16-1 behavior, pixel-identical).
 *   - Path Traced: reuses the EXISTING tracer (snapshot.ts + tracer.ts — the F12
 *     path) headlessly, N samples-per-pixel per frame, WITHOUT opening the
 *     Render Result window. The traced radiance is Reinhard+gamma mapped via the
 *     same tonemapAccumToRgba() the render window uses.
 *
 * Formats:
 *   - WebM / MP4 video: a single 2D "recording canvas" is the MediaRecorder
 *     captureStream(0) source; BOTH engines draw their final frame onto it (the
 *     viewport engine copies the GL canvas in, the tracer puts its RGBA in), one
 *     requestFrame per frame spaced at 1/fps. MP4 is offered only when the
 *     browser can record it (probeSupportedMp4). → single .webm / .mp4 download.
 *   - PNG sequence: the "exact pixels" path — viewport uses gl.readPixels, the
 *     tracer uses its RGBA buffer — each frame → toBlob → a STORE-only ZIP.
 *
 * A modal picks engine / samples / format / fps / start / end and shows a
 * progress bar + `frame i/total · sample s/N` counter + a working Cancel that
 * aborts mid-frame (the tracer sample loop checks the cancel flag between
 * passes). Prior frameCurrent, playing state and shading mode are restored when
 * the run ends (completed OR cancelled).
 *
 * The pure helpers (frameCount, crc32, buildStoreZip, seedForFrame,
 * probeSupportedMp4) are exported for unit tests; they touch no DOM.
 */

// ---------------------------------------------------------------------------
// Path-traced per-frame seed (pure, unit-tested).
// ---------------------------------------------------------------------------

/** Base RNG seed the live F12 render uses (init.ts posts seed 0x1234567). */
export const ANIM_SEED_BASE = 0x1234567;

/**
 * Per-frame tracer seed. The tracer is fully seeded, so a fixed base seed makes
 * every frame draw IDENTICAL noise — a static shot would show frozen grain. We
 * XOR the F12 base seed with the frame index times a large odd constant
 * (different from the tracer's internal per-sample constant, 0x9e3779b1, to
 * avoid structured correlation) so each frame decorrelates while staying fully
 * deterministic: the same frame index always yields the same seed, hence the
 * same image.
 */
export function seedForFrame(frame: number): number {
  return (ANIM_SEED_BASE ^ (Math.floor(frame) * 0x85ebca6b)) >>> 0;
}

// ---------------------------------------------------------------------------
// MP4 codec probe (pure, unit-tested with a stubbed isTypeSupported).
// ---------------------------------------------------------------------------

/**
 * MP4 (H.264/AVC) recording MIME shortlist, most-specific first. Chrome's
 * MediaRecorder accepts H.264 in an mp4 container only on some
 * platforms/builds, so we probe a shortlist and use the first that works.
 */
export const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=h264',
  'video/mp4',
];

/** First supported MP4 MIME from the shortlist, or null if none work. */
export function probeSupportedMp4(isSupported: (type: string) => boolean): string | null {
  for (const c of MP4_MIME_CANDIDATES) if (isSupported(c)) return c;
  return null;
}

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

/** Output format. 'webm'/'png' kept back-compatible with the P16-1 API. */
export type AnimRenderMode = 'webm' | 'mp4' | 'png';
/** Which engine produces each frame. 'pathtraced' = CPU tracer; 'gpu' = the
 *  WebGL2 fragment-shader tracer (UR12-3). */
export type AnimEngine = 'viewport' | 'pathtraced' | 'gpu';

export interface AnimRenderOptions {
  /** Output format. Default 'webm'. */
  mode: AnimRenderMode;
  /** Rendering engine. Default 'viewport'. */
  engine?: AnimEngine;
  /** Path-traced samples per pixel per frame (clamped 8..1024). Default 64. */
  samples?: number;
  start?: number;
  end?: number;
  fps?: number;
  /**
   * Path-traced output width/height override. Defaults to the viewport canvas
   * size ("current output resolution"); used by e2e to trace a tiny canvas.
   * Ignored by the viewport engine (which always uses the GL canvas size).
   */
  width?: number;
  height?: number;
}

export interface AnimRenderContext {
  scene: Scene;
  camera: OrbitCamera;
  renderer: Renderer;
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  setStatus: (text: string) => void;
  host: HTMLElement;
  /**
   * HTML-plane driver (UR7-1). When present, each frame AWAITS an exact page-clock
   * raster of every HTML plane before capture (deterministic animated pages), and
   * the live tick is suspended for the run so it can't race the frame loop.
   */
  htmlDriver?: {
    prepareFrame(frame: number): Promise<void>;
    suspend(): void;
    resume(): void;
  };
}

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AnimRender {
  private running = false;
  private cancelled = false;
  private scratch: HTMLCanvasElement | null = null;

  // Modal DOM (built lazily on first open).
  private modal: HTMLDivElement | null = null;
  private engineSel!: HTMLSelectElement;
  private samplesLabel!: HTMLDivElement;
  private samplesInput!: HTMLInputElement;
  private formatSel!: HTMLSelectElement;
  private hintEl!: HTMLDivElement;
  private fpsInput!: HTMLInputElement;
  private startInput!: HTMLInputElement;
  private endInput!: HTMLInputElement;
  private renderBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private progressFill!: HTMLDivElement;
  private counterEl!: HTMLDivElement;
  private msgEl!: HTMLDivElement;
  /** MP4 MIME the modal probe found supported, or null (option hidden). */
  private mp4Mime: string | null = null;

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
    // Probe MP4 support fresh on every open, then repopulate the format menu.
    this.refreshFormatOptions();
    this.updateSamplesVisibility();
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

    // Engine: Viewport (current) | Path Traced.
    this.engineSel = document.createElement('select');
    this.engineSel.className = 'anim-render-input';
    this.engineSel.dataset.testid = 'anim-engine';
    const engineOpts: [string, string][] = [['viewport', 'Viewport'], ['pathtraced', 'Path Traced (CPU)']];
    // GPU engine (UR12-3) only when the WebGL2 tracer probe succeeds.
    if (getGpuTracer().available) engineOpts.push(['gpu', 'Path Traced (GPU)']);
    for (const [val, label] of engineOpts) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      this.engineSel.appendChild(opt);
    }
    this.engineSel.addEventListener('change', () => this.updateSamplesVisibility());
    grid.append(this.label('Engine'), this.engineSel);

    // Samples (path-traced only) — spp per frame.
    this.samplesLabel = this.label('Samples');
    this.samplesInput = this.numberInput(8, 1024);
    this.samplesInput.value = '64';
    this.samplesInput.dataset.testid = 'anim-samples';
    grid.append(this.samplesLabel, this.samplesInput);

    // Format: WebM (default) | MP4 (conditional) | PNG sequence.
    this.formatSel = document.createElement('select');
    this.formatSel.className = 'anim-render-input';
    this.formatSel.dataset.testid = 'anim-format';
    this.formatSel.addEventListener('change', () => {
      // Persist so the Render tab's Output ▸ Animation select stays in sync (UR16-3).
      const v = this.formatSel.value;
      if (v === 'webm' || v === 'mp4' || v === 'png') {
        viewPrefs.animFormat = v as AnimFormat;
        saveViewPrefs();
      }
      this.updateHint();
    });
    grid.append(this.label('Format'), this.formatSel);

    // PNG assembly hint (full-width row under Format; shown only for PNG).
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'anim-render-hint';
    grid.append(this.hintEl);

    this.fpsInput = this.numberInput(1, 240);
    this.fpsInput.addEventListener('change', () => this.updateHint());
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

  /** Probe MP4 support and (re)populate the Format select. Runs at modal open. */
  private refreshFormatOptions(): void {
    this.mp4Mime =
      typeof MediaRecorder !== 'undefined'
        ? probeSupportedMp4((t) => MediaRecorder.isTypeSupported(t))
        : null;
    const sel = this.formatSel;
    const prev = sel.value;
    sel.textContent = '';
    const opts: [string, string][] = [['webm', 'WebM']];
    if (this.mp4Mime) opts.push(['mp4', 'MP4']);
    opts.push(['png', 'PNG sequence']);
    for (const [val, label] of opts) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    // Prefer the last-open selection, else the persisted Render-tab default (UR16-3).
    const want = prev || viewPrefs.animFormat;
    sel.value = opts.some(([v]) => v === want) ? want : 'webm';
    this.updateHint();
  }

  /** Show the Samples row for the path-traced engines (CPU + GPU). */
  private updateSamplesVisibility(): void {
    const show = this.engineSel.value === 'pathtraced' || this.engineSel.value === 'gpu';
    this.samplesLabel.style.display = show ? '' : 'none';
    this.samplesInput.style.display = show ? '' : 'none';
  }

  /** Show the ffmpeg assembly hint only for the PNG-sequence format. */
  private updateHint(): void {
    if (!this.hintEl) return;
    if (this.formatSel.value === 'png') {
      const fps = Math.max(1, Math.round(Number(this.fpsInput.value) || 24));
      this.hintEl.textContent = `PNG → assemble with: ffmpeg -framerate ${fps} -i frame_%04d.png out.mp4`;
      this.hintEl.style.display = '';
    } else {
      this.hintEl.textContent = '';
      this.hintEl.style.display = 'none';
    }
  }

  private async onRenderClick(): Promise<void> {
    const mode = this.formatSel.value as AnimRenderMode;
    const engine = this.engineSel.value as AnimEngine;
    const samples = Math.round(Number(this.samplesInput.value));
    const fps = Number(this.fpsInput.value);
    const start = Math.round(Number(this.startInput.value));
    const end = Math.round(Number(this.endInput.value));
    let blob: Blob | null = null;
    try {
      blob = await this.render({ mode, engine, samples, fps, start, end });
    } catch (err) {
      this.setMessage((err as Error).message);
      return;
    }
    if (!blob) return; // cancelled
    const ext = mode === 'png' ? 'zip' : mode; // webm | mp4 | zip
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

  /**
   * Progress readout. `done` drives the bar (completed frames / total). When
   * `sample`/`sampleTotal` are given (path-traced), `done` is the 1-based index
   * of the frame currently rendering and the counter shows the sample sub-step.
   */
  private setProgress(done: number, total: number, sample?: number, sampleTotal?: number): void {
    if (!this.progressFill) return;
    const pct = total > 0 ? (done / total) * 100 : 0;
    this.progressFill.style.width = `${pct}%`;
    if (total <= 0) { this.counterEl.textContent = ''; return; }
    this.counterEl.textContent =
      sample !== undefined && sampleTotal !== undefined
        ? `Frame ${done} / ${total} · sample ${sample} / ${sampleTotal}`
        : `Frame ${done} / ${total}`;
  }

  private setBusy(busy: boolean): void {
    if (!this.modal) return;
    this.renderBtn.disabled = busy;
    this.engineSel.disabled = busy;
    this.samplesInput.disabled = busy;
    this.formatSel.disabled = busy;
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
    const { scene, renderer, canvas } = this.ctx;
    const start = Math.round(opts.start ?? scene.frameStart);
    const end = Math.round(opts.end ?? scene.frameEnd);
    const fps = Math.max(1, Math.round(opts.fps ?? scene.fps));
    const engine: AnimEngine = opts.engine ?? 'viewport';
    const format: AnimRenderMode = opts.mode ?? 'webm';
    const samples = Math.max(8, Math.min(1024, Math.round(opts.samples ?? 64)));
    if (start >= end) {
      this.setMessage('Start frame must be before End frame');
      this.ctx.setStatus('Render Animation: start must be < end');
      throw new Error('start must be < end');
    }

    // Output resolution (UR5-5): the path-traced engine renders at the scene's
    // Output resolution (scene.renderSettings) — the real render frame — unless an
    // explicit override is passed (e2e). The viewport engine reads the live GL
    // canvas via readPixels, so it is physically bound to the canvas size (it
    // cannot exceed it without resizing the GL context); documented limitation.
    const rs = scene.renderSettings;
    const traced = engine === 'pathtraced' || engine === 'gpu';
    const tw = traced ? Math.round(opts.width ?? rs.width) : canvas.width;
    const th = traced ? Math.round(opts.height ?? rs.height) : canvas.height;

    // Resolve the video MIME up front so an unsupported format fails before we
    // touch scene state.
    let videoMime = '';
    let blobType = '';
    if (format !== 'png') {
      if (format === 'mp4') {
        const m = probeSupportedMp4((t) => MediaRecorder.isTypeSupported(t));
        if (!m) {
          this.setMessage('MP4 recording is not supported in this browser');
          throw new Error('MP4 recording not supported');
        }
        videoMime = m;
        blobType = 'video/mp4';
      } else {
        videoMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : 'video/webm';
        blobType = 'video/webm';
      }
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

    // Suspend the HTML-plane live tick so it can't race the deterministic frames.
    this.ctx.htmlDriver?.suspend();

    scene.playing = false;
    renderer.shadingMode = 'rendered';
    if (scene.activeCameraId !== null) renderer.cameraViewId = scene.activeCameraId;

    const total = frameCount(start, end);
    let blob: Blob | null = null;
    try {
      // Transparent film (UR16-3): only the PNG sequence carries alpha (WebM/MP4
      // have no alpha channel → the world is composited black, per the snapshot's
      // primary-miss skip). Documented in the modal hint below.
      const wantAlpha = format === 'png' && traced && (scene.renderSettings.transparent ?? false);
      if (format === 'png') blob = await this.renderPngSeq(engine, start, end, total, samples, tw, th, wantAlpha);
      else blob = await this.renderVideo(engine, videoMime, blobType, start, end, fps, total, samples, tw, th);
    } finally {
      renderer.shadingMode = saved.shading;
      renderer.cameraViewId = saved.cameraViewId;
      scene.playing = saved.playing;
      scene.frameCurrent = saved.frame;
      applyAnimation(scene, saved.frame);
      this.ctx.htmlDriver?.resume();
      this.running = false;
      this.setBusy(false);
    }

    if (this.cancelled) {
      this.setProgress(0, 0);
      this.setMessage('Cancelled');
      return null;
    }
    this.ctx.setStatus(`Rendered ${total} frames (${engine})`);
    return blob;
  }

  /** Pose + draw one frame in Rendered mode through the active camera. Awaits an
   *  exact page-clock raster of every HTML plane first (UR7-1) so animated pages
   *  are deterministic. */
  private async drawViewportFrame(frame: number): Promise<void> {
    const { scene, renderer, camera } = this.ctx;
    scene.frameCurrent = frame;
    applyAnimation(scene, frame);
    await this.ctx.htmlDriver?.prepareFrame(frame);
    renderer.render(scene, camera);
  }

  /**
   * Pose + path-trace one frame headlessly to `samples` spp, reusing the F12
   * tracer (buildSnapshot + prepareScene + renderSample) WITHOUT opening the
   * Render Result window. Returns a top-left-origin RGBA byte buffer (w*h*4), or
   * null if cancelled mid-frame. The sample loop checks the cancel flag between
   * passes and yields on a time budget so Cancel + progress stay live.
   */
  private async tracePathFrame(
    frame: number,
    w: number,
    h: number,
    samples: number,
    wantAlpha: boolean,
    onSample: (s: number, total: number) => void,
  ): Promise<Uint8ClampedArray | null> {
    const { scene, camera } = this.ctx;
    scene.frameCurrent = frame;
    applyAnimation(scene, frame);
    await this.ctx.htmlDriver?.prepareFrame(frame); // UR7-1: exact page-clock raster
    const traceScene = prepareScene(buildSnapshot(scene, camera));
    const accum = new Float32Array(w * h * 3);
    // Transparent film (UR16-3): accumulate coverage for straight-alpha PNG output.
    const coverage = wantAlpha ? new Float32Array(w * h) : null;
    const seed = seedForFrame(frame);
    let lastYield = performance.now();
    for (let s = 0; s < samples; s++) {
      if (this.cancelled) return null;
      renderSample(traceScene, accum, w, h, s, seed, coverage ?? undefined);
      const now = performance.now();
      // Yield (and refresh progress) on a ~30ms cadence so the click/timeout
      // that sets `cancelled` can run and the counter updates; always report the
      // final pass. renderSample is a full-frame pass, so this aborts mid-frame.
      if (now - lastYield > 30 || s === samples - 1) {
        onSample(s + 1, samples);
        await raf();
        lastYield = performance.now();
      }
    }
    if (this.cancelled) return null;
    const rgba = new Uint8ClampedArray(w * h * 4);
    // Camera Glare (UR10-2 Part B): same tonemap seam as F12 — the active
    // camera's glare blooms the HDR radiance before tonemap so an animation
    // render carries the identical halo. Transparent film (UR16-3): coverage →
    // straight alpha (glare is skipped on that path).
    tonemapAccumToRgba(accum, samples, rgba,
      { width: w, height: h, glare: scene.activeCamera?.camera?.glare ?? null, coverage });
    return rgba;
  }

  /**
   * Pose + path-trace one frame on the GPU (UR12-3): the shared WebGL2 tracer,
   * `samples` spp, at `w × h`, WITHOUT the render window. Per-frame it re-packs
   * ONLY what changed (fullRepack=false → geometry/materials/lights diff'd; a
   * camera-only fly-through frame re-packs NOTHING — see GpuTracer.setSnapshot),
   * except the FIRST frame which does a full rebuild. Deterministic: same frame +
   * spp → bit-identical bytes (fixed accumulation order + frame-indexed seed).
   * The prepareFrame await for HTML planes happens BEFORE packing (UR7-1). Returns
   * a top-left-origin RGBA byte buffer, or null if cancelled.
   */
  private async traceGpuFrame(
    frame: number,
    w: number,
    h: number,
    samples: number,
    fullRepack: boolean,
    wantAlpha: boolean,
    onSample: (s: number, total: number) => void,
  ): Promise<Uint8ClampedArray | null> {
    const { scene, camera } = this.ctx;
    scene.frameCurrent = frame;
    applyAnimation(scene, frame);
    await this.ctx.htmlDriver?.prepareFrame(frame); // UR7-1: raster BEFORE packing
    const tracer = getGpuTracer();
    if (!tracer.available) throw new Error('GPU tracer unavailable');
    const snap = buildSnapshot(scene, camera);
    tracer.setSnapshot(snap, !fullRepack); // incremental for frames after the first
    if (!tracer.beginProgressive(w, h, seedForFrame(frame))) return null;
    // Fenced row-slice pacing (2026-07-20): submission is async, so the old
    // 30ms wall-clock yield measured nothing and the whole frame could pile
    // onto the GPU queue (freezing the compositor and risking the amdgpu
    // watchdog). One scissored slice in flight at a time, fence-awaited; the
    // slice height is fixed within a sample and re-derived per sample from its
    // whole measured cost (per-slice growth is unsafe — region costs lie).
    let rows = initialRows(w, h);
    let sampleMs = 0;
    while (tracer.accumulatedSamples < samples) {
      if (this.cancelled) return null;
      if (tracer.contextLost) throw new Error('GPU context lost mid-render');
      const t0 = performance.now();
      tracer.accumulateRowsFenced(rows);
      while (tracer.batchPending()) {
        if (this.cancelled) return null;
        if (tracer.contextLost) throw new Error('GPU context lost mid-render');
        await raf();
      }
      const sliceMs = performance.now() - t0;
      sampleMs += sliceMs;
      if (sliceMs > 90) rows = Math.max(1, rows >> 1); // shrink-only mid-sample
      if (tracer.rowCursor === 0) {
        rows = rowsForSample(h, sampleMs);
        sampleMs = 0;
        onSample(Math.min(samples, tracer.accumulatedSamples), samples);
      }
    }
    if (this.cancelled) return null;
    const avg = tracer.readbackProgressive(); // averaged RGBA, top-left origin
    if (!avg) return null;
    // Route through the SAME tonemap seam as F12/CPU (glare parity): pass the
    // averaged radiance with sample count 1 (updateFrame's divide is a no-op),
    // so Camera Glare blooms the identical HDR before Reinhard+gamma.
    const rgb = new Float32Array(w * h * 3);
    // Transparent film (UR16-3): avg alpha is the coverage FRACTION; with sample
    // count 1 the coverage sum equals the fraction, so straight alpha comes out right.
    const coverage = wantAlpha ? new Float32Array(w * h) : null;
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = avg[i * 4];
      rgb[i * 3 + 1] = avg[i * 4 + 1];
      rgb[i * 3 + 2] = avg[i * 4 + 2];
      if (coverage) coverage[i] = avg[i * 4 + 3];
    }
    const rgba = new Uint8ClampedArray(w * h * 4);
    tonemapAccumToRgba(rgb, 1, rgba,
      { width: w, height: h, glare: scene.activeCamera?.camera?.glare ?? null, coverage });
    return rgba;
  }

  /** Trace one frame with the selected path-tracing engine (CPU or GPU),
   *  returning a top-left-origin RGBA buffer or null if cancelled. */
  private traceFrame(
    engine: AnimEngine,
    frame: number,
    w: number,
    h: number,
    samples: number,
    fullRepack: boolean,
    wantAlpha: boolean,
    onSample: (s: number, total: number) => void,
  ): Promise<Uint8ClampedArray | null> {
    return engine === 'gpu'
      ? this.traceGpuFrame(frame, w, h, samples, fullRepack, wantAlpha, onSample)
      : this.tracePathFrame(frame, w, h, samples, wantAlpha, onSample);
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
    const c2d = this.scratchCanvas(w, h);
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
    return this.scratch!;
  }

  /** Put a top-left-origin RGBA buffer onto the reused scratch canvas. */
  private putRgbaToScratch(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
    const c2d = this.scratchCanvas(w, h);
    const img = c2d.createImageData(w, h);
    img.data.set(rgba);
    c2d.putImageData(img, 0, 0);
    return this.scratch!;
  }

  /** The reused scratch 2D canvas, sized to w×h. */
  private scratchCanvas(w: number, h: number): CanvasRenderingContext2D {
    if (!this.scratch) this.scratch = document.createElement('canvas');
    if (this.scratch.width !== w) this.scratch.width = w;
    if (this.scratch.height !== h) this.scratch.height = h;
    return this.scratch.getContext('2d')!;
  }

  /** PNG-sequence sink — the "exact pixels" path for both engines. */
  private async renderPngSeq(
    engine: AnimEngine,
    start: number,
    end: number,
    total: number,
    samples: number,
    tw: number,
    th: number,
    wantAlpha: boolean,
  ): Promise<Blob | null> {
    const entries: ZipEntry[] = [];
    let done = 0;
    for (let f = start; f <= end; f++) {
      if (this.cancelled) break;
      let source: HTMLCanvasElement;
      if (engine === 'viewport') {
        await this.drawViewportFrame(f);
        source = this.captureToScratch();
      } else {
        const rgba = await this.traceFrame(engine, f, tw, th, samples, f === start, wantAlpha, (s, n) =>
          this.setProgress(done + 1, total, s, n));
        if (this.cancelled || !rgba) break;
        source = this.putRgbaToScratch(rgba, tw, th);
      }
      const png = await new Promise<Blob | null>((res) => source.toBlob((b) => res(b), 'image/png'));
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

  /**
   * Video sink (WebM / MP4). A single 2D "recording canvas" is the captureStream
   * source; both engines feed it. The viewport engine draws live (fast) and
   * spaces requestFrame by 1/fps. The tracer engine is two-phase: trace every
   * frame first (each takes far longer than 1/fps), then replay them onto the
   * recording canvas at 1/fps so the recorder timestamps at the target rate
   * instead of at trace speed.
   */
  private async renderVideo(
    engine: AnimEngine,
    videoMime: string,
    blobType: string,
    start: number,
    end: number,
    fps: number,
    total: number,
    samples: number,
    tw: number,
    th: number,
  ): Promise<Blob | null> {
    const recCanvas = document.createElement('canvas');
    recCanvas.width = tw;
    recCanvas.height = th;
    const recCtx = recCanvas.getContext('2d')!;
    const stream = recCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: videoMime });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise<void>((res) => { recorder.onstop = () => res(); });
    recorder.start();
    const frameMs = 1000 / fps;

    if (engine === 'viewport') {
      let done = 0;
      for (let f = start; f <= end; f++) {
        if (this.cancelled) break;
        await this.drawViewportFrame(f);
        // Copy the viewport canvas into the recording canvas (drawImage keeps
        // the correct top-left orientation — no manual flip needed).
        recCtx.drawImage(this.ctx.canvas, 0, 0);
        track.requestFrame();
        done++;
        this.setProgress(done, total);
        await delay(frameMs);
      }
    } else {
      // Phase 1: trace every frame into memory.
      const frames: Uint8ClampedArray[] = [];
      let done = 0;
      for (let f = start; f <= end; f++) {
        if (this.cancelled) break;
        // Video (WebM/MP4) has no alpha channel — trace opaque (world→black when
        // the film is transparent, per the snapshot's primary-miss skip).
        const rgba = await this.traceFrame(engine, f, tw, th, samples, f === start, false, (s, n) =>
          this.setProgress(done + 1, total, s, n));
        if (this.cancelled || !rgba) break;
        frames.push(rgba);
        done++;
        this.setProgress(done, total);
      }
      // Phase 2: replay at the target fps.
      if (!this.cancelled) {
        const replayImg = recCtx.createImageData(tw, th);
        for (let i = 0; i < frames.length; i++) {
          if (this.cancelled) break;
          replayImg.data.set(frames[i]);
          recCtx.putImageData(replayImg, 0, 0);
          track.requestFrame();
          await delay(frameMs);
        }
      }
    }

    recorder.stop();
    await stopped;
    track.stop();
    if (this.cancelled) return null;
    return new Blob(chunks, { type: blobType });
  }
}
