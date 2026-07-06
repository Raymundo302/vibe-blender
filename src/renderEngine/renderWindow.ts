import './renderWindow.css';

/**
 * DOM overlay "Render Result" window (P8-4). Owns a 2D canvas the tracer's
 * accumulation buffer is blitted into (Reinhard tonemap + gamma, matching
 * renderedPass), a sample/time readout, a Save PNG button, and a close ×.
 * Pure presentation — it holds no tracer state; init.ts drives it.
 */
export class RenderWindow {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly readout: HTMLDivElement;
  private readonly imageData: ImageData;
  private readonly host: HTMLElement;

  isOpen = false;
  sample = 0;
  /** Fired when the user clicks × (init.ts wires this to close+terminate). */
  onClose: () => void = () => {};

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

    header.append(title, this.readout, saveBtn, closeBtn);

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
    const inv = sample > 0 ? 1 / sample : 1;
    const px = this.imageData.data;
    for (let i = 0, j = 0; i < accum.length; i += 3, j += 4) {
      let r = accum[i] * inv;
      let g = accum[i + 1] * inv;
      let b = accum[i + 2] * inv;
      r = r / (r + 1); g = g / (g + 1); b = b / (b + 1); // Reinhard
      px[j] = Math.min(255, Math.pow(r, 1 / 2.2) * 255);
      px[j + 1] = Math.min(255, Math.pow(g, 1 / 2.2) * 255);
      px[j + 2] = Math.min(255, Math.pow(b, 1 / 2.2) * 255);
      px[j + 3] = 255;
    }
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
