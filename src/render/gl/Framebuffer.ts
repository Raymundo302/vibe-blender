/** Offscreen render target: RGBA8 color texture + depth renderbuffer. */
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
  ) {
    this.fbo = gl.createFramebuffer()!;
    this.colorTex = gl.createTexture()!;
    this.allocate(width, height);
  }

  private allocate(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;

    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
