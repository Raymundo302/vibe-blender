import { Shader } from '../gl/Shader';
import { EmptyVao } from '../gl/VertexArray';

/**
 * UR15-1 — draws the viewport raytraced accumulation (a byte RGBA image produced
 * off-context by viewportRay.ts) as a fullscreen textured quad in the VIEWPORT GL
 * context. The half-resolution interaction-degradation image is LINEAR-upscaled
 * to the canvas (min/mag LINEAR), so a moving camera reads as noisy-but-live and
 * a still camera converges crisply. Drawn with the depth test OFF (it fills the
 * whole frame and must not write depth — the Renderer primes real geometry depth
 * afterwards so overlays test correctly ON TOP of the traced image).
 *
 * The uploaded image has row 0 = TOP (image-natural); the fragment shader flips V
 * because gl_FragCoord.y is bottom-up.
 */

const VERT = /* glsl */ `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_img;
uniform vec2 u_texel;   // 1 / canvas size
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  outColor = vec4(texture(u_img, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0);
}`;

export class RayPresentPass {
  private readonly shader: Shader;
  private readonly quad: EmptyVao;
  private readonly tex: WebGLTexture;
  private texW = 0;
  private texH = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'ray-present');
    this.quad = new EmptyVao(gl);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Upload the traced RGBA byte image (row 0 = top) and draw it fullscreen over
   *  the whole `canvasW×canvasH` viewport. Restores depth-test state on exit. */
  draw(bytes: Uint8ClampedArray, imgW: number, imgH: number, canvasW: number, canvasH: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (imgW !== this.texW || imgH !== this.texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, imgW, imgH, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      this.texW = imgW;
      this.texH = imgH;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, imgW, imgH, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }

    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, canvasW, canvasH);
    this.shader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    this.shader.setInt('u_img', 0);
    this.shader.setVec2('u_texel', 1 / canvasW, 1 / canvasH);
    this.quad.drawTriangles(3);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }
}
