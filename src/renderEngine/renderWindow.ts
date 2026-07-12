import './renderWindow.css';
import { applyGlare } from './glare';
import type { GlareSettings } from '../core/scene/objectData';
import type { RenderEngine } from '../render/viewPrefs';

/**
 * Reinhard tonemap + gamma 1/2.2 of an averaged path-tracer accumulation buffer
 * (length w*h*3, summed radiance over `sample` passes) into an RGBA byte buffer
 * (length w*h*4, alpha forced 255). Extracted so the live Render Result window
 * (updateFrame below) and the headless Render-Animation path (animRender.ts) map
 * traced radiance to pixels identically — the "headless driver seam" the anim
 * renderer reuses instead of forking the tracer's presentation math.
 *
 * Camera Glare (UR10-2 Part B) plugs in HERE, once, for both F12 and Ctrl+F12:
 * when `glare` is enabled the buffer is averaged into a linear HDR scratch, glare
 * is applied on that TRUE HDR radiance (bright emissives >1 bloom), then tonemap
 * runs. With no glare the original inline path is untouched (byte-identical to
 * every existing render / animRender test).
 */
export function tonemapAccumToRgba(
  accum: Float32Array,
  sample: number,
  out: Uint8ClampedArray,
  glareOpts?: { width: number; height: number; glare: GlareSettings | null | undefined },
): void {
  const inv = sample > 0 ? 1 / sample : 1;
  if (glareOpts && glareOpts.glare && glareOpts.glare.enabled) {
    // Average → glare on linear HDR → tonemap. (Extra buffer only when glaring.)
    const lin = new Float32Array(accum.length);
    for (let i = 0; i < accum.length; i++) lin[i] = accum[i] * inv;
    applyGlare(lin, glareOpts.width, glareOpts.height, glareOpts.glare);
    for (let i = 0, j = 0; i < lin.length; i += 3, j += 4) {
      let r = lin[i], g = lin[i + 1], b = lin[i + 2];
      r = r / (r + 1); g = g / (g + 1); b = b / (b + 1); // Reinhard
      out[j] = Math.min(255, Math.pow(r, 1 / 2.2) * 255);
      out[j + 1] = Math.min(255, Math.pow(g, 1 / 2.2) * 255);
      out[j + 2] = Math.min(255, Math.pow(b, 1 / 2.2) * 255);
      out[j + 3] = 255;
    }
    return;
  }
  for (let i = 0, j = 0; i < accum.length; i += 3, j += 4) {
    let r = accum[i] * inv;
    let g = accum[i + 1] * inv;
    let b = accum[i + 2] * inv;
    r = r / (r + 1); g = g / (g + 1); b = b / (b + 1); // Reinhard
    out[j] = Math.min(255, Math.pow(r, 1 / 2.2) * 255);
    out[j + 1] = Math.min(255, Math.pow(g, 1 / 2.2) * 255);
    out[j + 2] = Math.min(255, Math.pow(b, 1 / 2.2) * 255);
    out[j + 3] = 255;
  }
}

/**
 * DOM overlay "Render Result" window (P8-4). Owns a 2D canvas the tracer's
 * accumulation buffer is blitted into (Reinhard tonemap + gamma, matching
 * renderedPass), a sample/time readout, a Save PNG button, and a close ×.
 * Pure presentation — it holds no tracer state; init.ts drives it.
 */
export class RenderWindow {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  /** Output pixel dimensions. Mutable so the F12 driver can size the window to
   *  the scene's render resolution (UR5-5) via resize() before each render. */
  width: number;
  height: number;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly readout: HTMLDivElement;
  private imageData: ImageData;
  private readonly host: HTMLElement;
  private readonly apertureInput: HTMLInputElement;
  private readonly focusInput: HTMLInputElement;
  private readonly engineSel: HTMLSelectElement;
  private readonly gpuOption: HTMLOptionElement;

  isOpen = false;
  sample = 0;
  /**
   * Thin-lens depth of field. aperture 0 = pinhole (default). focusDistance
   * null = auto (use the snapshot's bounding-box focus). init.ts reads these
   * into the snapshot camera before each render.
   */
  aperture = 0;
  focusDistance: number | null = null;
  /** Active camera's Glare settings (UR10-2 Part B), set by init.ts before each
   *  render. null → no glare (byte-identical presentation). */
  glare: GlareSettings | null = null;
  /** Fired when the user clicks × (init.ts wires this to close+terminate). */
  onClose: () => void = () => {};
  /** Fired when aperture / focus distance change (init.ts re-renders). */
  onParamsChange: () => void = () => {};
  /** Selected path-tracer backend (UR12-3). init.ts reads this at render start
   *  and persists it; the GPU option disables itself when unavailable. */
  engine: RenderEngine = 'gpu';
  /** Fired when the user changes the Engine select (init.ts persists + restarts). */
  onEngineChange: () => void = () => {};

  constructor(host: HTMLElement, width = 960, height = 540) {
    this.host = host;
    this.width = width;
    this.height = height;

    this.root = document.createElement('div');
    this.root.className = 'render-win';

    const header = document.createElement('div');
    header.className = 'render-win-header';

    const title = document.createElement('div');
    title.className = 'render-win-title';
    title.textContent = 'Render Result';

    this.readout = document.createElement('div');
    this.readout.className = 'render-win-readout';
    this.readout.textContent = 'Sample 0';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'render-win-btn render-win-save';
    saveBtn.textContent = 'Save PNG';
    saveBtn.addEventListener('click', () => this.savePng());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'render-win-btn render-win-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.onClose());

    // Depth-of-field controls: aperture radius + focus distance.
    const dof = document.createElement('div');
    dof.className = 'render-win-dof';

    this.apertureInput = document.createElement('input');
    this.apertureInput.type = 'number';
    this.apertureInput.className = 'render-win-aperture';
    this.apertureInput.min = '0';
    this.apertureInput.step = '0.02';
    this.apertureInput.value = '0';
    this.apertureInput.title = 'Aperture radius (0 = pinhole)';
    this.apertureInput.addEventListener('change', () => {
      const v = parseFloat(this.apertureInput.value);
      this.aperture = Number.isFinite(v) && v > 0 ? v : 0;
      this.apertureInput.value = String(this.aperture);
      this.onParamsChange();
    });

    this.focusInput = document.createElement('input');
    this.focusInput.type = 'number';
    this.focusInput.className = 'render-win-focus';
    this.focusInput.min = '0';
    this.focusInput.step = '0.1';
    this.focusInput.title = 'Focus distance (blank = auto)';
    this.focusInput.addEventListener('change', () => {
      const v = parseFloat(this.focusInput.value);
      this.focusDistance = Number.isFinite(v) && v > 0 ? v : null;
      this.onParamsChange();
    });

    const apLabel = document.createElement('span');
    apLabel.className = 'render-win-dof-label';
    apLabel.textContent = 'f';
    apLabel.title = 'Aperture radius (0 = pinhole)';
    const fLabel = document.createElement('span');
    fLabel.className = 'render-win-dof-label';
    fLabel.textContent = '⟟';
    fLabel.title = 'Focus distance (blank = auto)';
    dof.append(apLabel, this.apertureInput, fLabel, this.focusInput);

    // Engine select: CPU (Web Worker tracer) | GPU (WebGL2 tracer, UR12).
    this.engineSel = document.createElement('select');
    this.engineSel.className = 'render-win-engine';
    this.engineSel.dataset.testid = 'render-engine';
    this.engineSel.title = 'Path-tracer backend';
    this.gpuOption = document.createElement('option');
    this.gpuOption.value = 'gpu';
    this.gpuOption.textContent = 'GPU';
    const cpuOption = document.createElement('option');
    cpuOption.value = 'cpu';
    cpuOption.textContent = 'CPU';
    this.engineSel.append(this.gpuOption, cpuOption);
    this.engineSel.value = this.engine;
    this.engineSel.addEventListener('change', () => {
      this.engine = this.engineSel.value === 'cpu' ? 'cpu' : 'gpu';
      this.onEngineChange();
    });

    header.append(title, this.readout, this.engineSel, dof, saveBtn, closeBtn);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'render-win-canvas';
    this.canvas.width = width;
    this.canvas.height = height;

    const c2d = this.canvas.getContext('2d');
    if (!c2d) throw new Error('render window: 2D context unavailable');
    this.ctx = c2d;
    this.imageData = this.ctx.createImageData(width, height);

    this.root.append(header, this.canvas);
    // Deliberately NOT appended to the DOM until open() — a detached window
    // keeps its <canvas> out of the document so unrelated code that counts
    // canvases (e.g. the workspace viewport-swap logic) isn't disturbed.
  }

  /**
   * Resize the output canvas + backing ImageData to w×h (UR5-5: the F12 driver
   * sets this to scene.renderSettings before a render). No-op when unchanged, so
   * repeated renders at the same resolution keep the retained last-render pixels.
   *
   * NOTE (Vega 7): very large frames (>4K, ~33M px) are slow to path-trace on the
   * integrated GPU / CPU tracer — this deliberately does NOT cap the size (the
   * resolution is the user's Output setting); document, don't gate.
   */
  resize(w: number, h: number): void {
    const nw = Math.max(1, Math.floor(w));
    const nh = Math.max(1, Math.floor(h));
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    this.canvas.width = nw;
    this.canvas.height = nh;
    this.imageData = this.ctx.createImageData(nw, nh);
  }

  open(): void {
    this.isOpen = true;
    this.root.classList.add('render-win-open');
    if (!this.root.isConnected) this.host.append(this.root);
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('render-win-open');
    this.root.remove();
  }

  /** Set the aperture radius and reflect it in the input (0 = pinhole). */
  setAperture(v: number): void {
    this.aperture = Number.isFinite(v) && v > 0 ? v : 0;
    this.apertureInput.value = String(this.aperture);
  }

  /** Set focus distance; null/≤0 = auto (blank field). */
  setFocusDistance(v: number | null): void {
    this.focusDistance = v !== null && Number.isFinite(v) && v > 0 ? v : null;
    this.focusInput.value = this.focusDistance === null ? '' : String(this.focusDistance);
  }

  /** Set the selected engine and reflect it in the select (no event fired). */
  setEngine(e: RenderEngine): void {
    this.engine = e;
    this.engineSel.value = e;
  }

  /**
   * Reflect GPU availability: when unavailable the GPU option is disabled and its
   * tooltip carries the reason (the render-window Engine select shows it), and the
   * select falls back to CPU if it was on GPU (UR12-3).
   */
  setGpuAvailability(available: boolean, reason: string | null): void {
    this.gpuOption.disabled = !available;
    this.gpuOption.title = available ? '' : (reason ?? 'GPU tracer unavailable');
    this.engineSel.title = available
      ? 'Path-tracer backend'
      : `GPU tracer unavailable: ${reason ?? 'unknown'} — using CPU`;
    if (!available && this.engine === 'gpu') this.setEngine('cpu');
  }

  /** Show the effective (auto) focus distance in the field without overriding
   * an explicit user value — a placeholder-style readout for pinhole default. */
  showAutoFocus(distance: number): void {
    if (this.focusDistance === null) this.focusInput.placeholder = distance.toFixed(2);
  }

  /** Clear the canvas + counters for a fresh render. */
  reset(): void {
    this.sample = 0;
    this.readout.textContent = 'Sample 0';
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Blit an accumulation buffer (length w*h*3, summed radiance over `sample`
   * passes) to the canvas: average, Reinhard tonemap, gamma 1/2.2.
   */
  updateFrame(accum: Float32Array, sample: number, elapsedMs: number): void {
    this.sample = sample;
    tonemapAccumToRgba(accum, sample, this.imageData.data,
      { width: this.width, height: this.height, glare: this.glare });
    this.ctx.putImageData(this.imageData, 0, 0);
    this.readout.textContent = `Sample ${sample} · ${(elapsedMs / 1000).toFixed(1)}s`;
  }

  private savePng(): void {
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `render-${Date.now()}.png`;
    a.click();
  }
}
