import { Shader } from '../gl/Shader';
import { EmptyVao } from '../gl/VertexArray';
import { Framebuffer, floatColorRenderable } from '../gl/Framebuffer';
import type { GlareSettings } from '../../core/scene/objectData';

/**
 * Camera Glare / bloom for the Rendered viewport (UR10-2 Part B) — the GL twin of
 * the CPU glare that the F12/Ctrl+F12 tracer uses. Applied ONLY when looking
 * THROUGH a camera whose glare is enabled (a camera property, not a free-nav
 * viewport effect).
 *
 * Pipeline: the Renderer renders the whole Rendered-mode frame into `capture` (an
 * RGBA16F target, so emissive surfaces — which output emissive·strength HDR and
 * would otherwise clamp — keep their >1 values). Then composite():
 *   1. bright-pass  — keep luminance above threshold, into a HALF-res target.
 *   2. separable Gaussian blur (H then V) at `radius`·imageHeight.
 *   3. composite    — sceneColor + strength·bloom to the default framebuffer.
 *
 * `available` is false when EXT_color_buffer_float is missing (no HDR capture
 * possible) — the Renderer then skips glare and renders straight to the canvas.
 * Deterministic: a pure function of the captured frame, no temporal state.
 */

const FS_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

// Bright-pass: keep only the energy above the threshold, preserving color ratio.
const BRIGHT_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform vec2 u_texel;      // 1 / half-res size (this target)
uniform float u_threshold;
out vec4 outColor;
void main() {
  vec3 c = texture(u_src, gl_FragCoord.xy * u_texel).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.4126));
  vec3 b = lum > u_threshold ? c * ((lum - u_threshold) / max(lum, 1e-6)) : vec3(0.0);
  outColor = vec4(b, 1.0);
}`;

// Separable Gaussian, 13 taps. u_dir = per-tap uv offset along this pass's axis.
const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform vec2 u_texel;      // 1 / half-res size
uniform vec2 u_dir;        // per-tap uv step (already scaled by radius)
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    sum += texture(u_src, uv + u_dir * float(i)).rgb * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 1.0);
}`;

// Composite: sceneColor + strength·bloom to the default framebuffer.
const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_scene;  // full-res HDR capture
uniform highp sampler2D u_bloom;  // half-res blurred bright-pass (LINEAR)
uniform vec2 u_texel;             // 1 / full-res size
uniform float u_strength;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  vec3 scene = texture(u_scene, uv).rgb;
  vec3 bloom = texture(u_bloom, uv).rgb;
  outColor = vec4(scene + bloom * u_strength, 1.0);
}`;

export class GlarePass {
  readonly available: boolean;
  private capFbo: Framebuffer;
  private brightFbo: Framebuffer;
  private blurFbo: Framebuffer;
  private readonly brightShader: Shader;
  private readonly blurShader: Shader;
  private readonly compositeShader: Shader;
  private readonly fullscreen: EmptyVao;
  private width: number;
  private height: number;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.available = floatColorRenderable(gl);
    this.width = width;
    this.height = height;
    // Full-res HDR capture (with depth so the scene depth-tests normally).
    this.capFbo = new Framebuffer(gl, width, height, true, 'rgba16f');
    const hw = Math.max(1, Math.round(width / 2));
    const hh = Math.max(1, Math.round(height / 2));
    // Half-res bloom ping-pong, LINEAR so the upsample in composite is smooth.
    this.brightFbo = new Framebuffer(gl, hw, hh, false, 'rgba16f', true);
    this.blurFbo = new Framebuffer(gl, hw, hh, false, 'rgba16f', true);
    this.brightShader = new Shader(gl, FS_VERT, BRIGHT_FRAG, 'glare-bright');
    this.blurShader = new Shader(gl, FS_VERT, BLUR_FRAG, 'glare-blur');
    this.compositeShader = new Shader(gl, FS_VERT, COMPOSITE_FRAG, 'glare-composite');
    this.fullscreen = new EmptyVao(gl);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.capFbo.resize(width, height);
    const hw = Math.max(1, Math.round(width / 2));
    const hh = Math.max(1, Math.round(height / 2));
    this.brightFbo.resize(hw, hh);
    this.blurFbo.resize(hw, hh);
  }

  /** The HDR capture target — the Renderer binds this and renders the frame into
   *  it while glaring, then calls composite(). */
  get capture(): Framebuffer {
    return this.capFbo;
  }

  /**
   * Run bright-pass → separable Gaussian → additive composite of the captured
   * frame to the DEFAULT framebuffer (canvas). Leaves the default framebuffer
   * bound at full canvas resolution.
   */
  composite(glare: GlareSettings): void {
    const gl = this.gl;
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);
    const hw = this.brightFbo.width;
    const hh = this.brightFbo.height;

    // 1. bright-pass (full-res capture → half-res bright).
    this.brightFbo.bind();
    this.brightShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.capFbo.texture);
    this.brightShader.setInt('u_src', 0);
    this.brightShader.setVec2('u_texel', 1 / hw, 1 / hh);
    this.brightShader.setFloat('u_threshold', glare.threshold);
    this.fullscreen.drawTriangles(3);

    // 2. separable Gaussian. Per-tap spread (half-res texels) so the 6th tap sits
    //    at radius·imageHeight full-res px: perTapHalfTexels = radius·(H/2)/6.
    const perTap = (glare.radius * (this.height / 2)) / 6;
    this.blurShader.use();
    this.blurShader.setVec2('u_texel', 1 / hw, 1 / hh);
    // H pass: bright → blur.
    this.blurFbo.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.brightFbo.texture);
    this.blurShader.setInt('u_src', 0);
    this.blurShader.setVec2('u_dir', perTap / hw, 0);
    this.fullscreen.drawTriangles(3);
    // V pass: blur → bright.
    this.brightFbo.bind();
    gl.bindTexture(gl.TEXTURE_2D, this.blurFbo.texture);
    this.blurShader.setVec2('u_dir', 0, perTap / hh);
    this.fullscreen.drawTriangles(3);

    // 3. composite to the default framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.compositeShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.capFbo.texture);
    this.compositeShader.setInt('u_scene', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.brightFbo.texture);
    this.compositeShader.setInt('u_bloom', 1);
    gl.activeTexture(gl.TEXTURE0);
    this.compositeShader.setVec2('u_texel', 1 / this.width, 1 / this.height);
    this.compositeShader.setFloat('u_strength', glare.strength);
    this.fullscreen.drawTriangles(3);

    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }
}
