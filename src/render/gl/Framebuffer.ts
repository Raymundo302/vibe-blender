/** Single-channel formats supported in addition to the default RGBA8. `r16f`
 *  requires EXT_color_buffer_float — check with {@link floatColorRenderable}. */
export type FboFormat = 'rgba8' | 'r8' | 'r16f';

/** True once EXT_color_buffer_float has been enabled on this context (so an
 *  R16F color attachment is framebuffer-complete). Enables the extension as a
 *  side effect — safe to call repeatedly. */
export function floatColorRenderable(gl: WebGL2RenderingContext): boolean {
  return !!gl.getExtension('EXT_color_buffer_float');
}

function formatTriple(gl: WebGL2RenderingContext, fmt: FboFormat):
  { internal: number; format: number; type: number } {
  switch (fmt) {
    case 'r8': return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
    case 'r16f': return { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT };
    default: return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }
}

/** Offscreen render target: color texture (RGBA8 / R8 / R16F) + depth renderbuffer. */
export class Framebuffer {
  private fbo: WebGLFramebuffer;
  private colorTex: WebGLTexture;
  private depthRb: WebGLRenderbuffer | null = null;
  width = 0;
  height = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    private readonly withDepth: boolean,
    private format: FboFormat = 'rgba8',
  ) {
    this.fbo = gl.createFramebuffer()!;
    this.colorTex = gl.createTexture()!;
    this.allocate(width, height);
  }

  /** Switch the color attachment's pixel format, reallocating at the current
   *  size. NEAREST-filtered internal targets only (no float-linear needed). */
  setFormat(format: FboFormat): void {
    if (format === this.format) return;
    this.format = format;
    this.allocate(this.width, this.height);
  }

  private allocate(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;
    const { internal, format, type } = formatTriple(gl, this.format);

    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);

    if (this.withDepth) {
      if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
      this.depthRb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Reallocate if size changed. */
  resize(width: number, height: number): void {
    if (width !== this.width || height !== this.height) this.allocate(width, height);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  unbind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  get texture(): WebGLTexture {
    return this.colorTex;
  }

  /** Read one RGBA pixel (y measured from bottom, GL convention). */
  readPixel(x: number, y: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /**
   * Read a w×h block of RGBA pixels starting at GL coords (x, y) (bottom-left of
   * the block); rows come back bottom-up, same convention as readPixel.
   */
  readRegion(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
