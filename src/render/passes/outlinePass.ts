import { Shader } from '../gl/Shader';
import { themeViewport } from '../../ui/themes';
import { Vec3 } from '../../core/math/vec3';
import { EmptyVao } from '../gl/VertexArray';
import { Framebuffer } from '../gl/Framebuffer';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Selection outline: selected objects are drawn as white silhouettes into a
 * mask FBO, then a fullscreen edge-detect pass draws Blender-orange where the
 * mask has an edge. Silhouette-only, ignores depth — matches Blender's look.
 */

const MASK_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_position, 1.0); }`;

const MASK_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

const EDGE_VERT = /* glsl */ `#version 300 es
// Fullscreen triangle from gl_VertexID — no attributes
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const EDGE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec2 u_texelSize;
uniform vec3 u_selectionColor;
out vec4 outColor;
// --- Outline width/smoothness constants (UR6-1; expect eyes-on tuning). ------
// OUTER_R is the outer sampling radius in texels ≈ px at DPR 1 → the outline
// reads ~3px (was 1.5, i.e. ~1.5–2× thicker). A double ring (8 taps at OUTER_R,
// 8 at INNER_FRAC·OUTER_R, angularly offset by 22.5°) samples coverage at two
// distances so the averaged falloff is smoother than the old single 8-tap ring.
const float OUTER_R = 3.0;
const float INNER_FRAC = 0.6;
const float COVERAGE_GAIN = 2.2; // averaged-coverage → alpha (kept from before)
void main() {
  vec2 uv = gl_FragCoord.xy * u_texelSize;
  float center = texture(u_mask, uv).r;
  if (center > 0.5) discard; // interior stays clear — outline sits just outside
  // 16-tap double-ring circular kernel: coverage (fraction of taps inside the
  // silhouette) falls off with distance, giving a soft, thicker anti-aliased
  // outline instead of a hard 1-bit staircase.
  const float C = 0.92388, S = 0.38268; // cos/sin 22.5° for the offset ring
  vec2 outer[8] = vec2[8](
    vec2( 1.0, 0.0), vec2( 0.70711, 0.70711), vec2(0.0,  1.0), vec2(-0.70711, 0.70711),
    vec2(-1.0, 0.0), vec2(-0.70711,-0.70711), vec2(0.0, -1.0), vec2( 0.70711,-0.70711));
  vec2 inner[8] = vec2[8](
    vec2( C, S), vec2( S, C), vec2(-S, C), vec2(-C, S),
    vec2(-C,-S), vec2(-S,-C), vec2( S,-C), vec2( C,-S));
  float n = 0.0;
  for (int i = 0; i < 8; i++) {
    n += texture(u_mask, uv + outer[i] * OUTER_R * u_texelSize).r;
    n += texture(u_mask, uv + inner[i] * (INNER_FRAC * OUTER_R) * u_texelSize).r;
  }
  float edge = n / 16.0; // fraction of the kernel inside the silhouette
  if (edge <= 0.001) discard;
  outColor = vec4(u_selectionColor, clamp(edge * COVERAGE_GAIN, 0.0, 1.0));
}`;

export class OutlinePass {
  private readonly maskShader: Shader;
  private readonly edgeShader: Shader;
  private readonly maskFbo: Framebuffer;
  private readonly fullscreen: EmptyVao;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.maskShader = new Shader(gl, MASK_VERT, MASK_FRAG, 'outline-mask');
    this.edgeShader = new Shader(gl, EDGE_VERT, EDGE_FRAG, 'outline-edge');
    this.maskFbo = new Framebuffer(gl, width, height, false);
    this.fullscreen = new EmptyVao(gl);
  }

  resize(width: number, height: number): void {
    this.maskFbo.resize(width, height);
  }

  /** Phase 1: render silhouettes. Call drawObject per selected object between begin/end. */
  beginMask(): void {
    const gl = this.gl;
    this.maskFbo.bind();
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.maskShader.use();
  }

  maskObject(mvp: Mat4): void {
    this.maskShader.setMat4('u_mvp', mvp);
  }

  endMask(canvasWidth: number, canvasHeight: number): void {
    const gl = this.gl;
    this.maskFbo.unbind();
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Phase 2: composite the orange edge onto the default framebuffer. */
  renderEdges(): void {
    const gl = this.gl;
    this.edgeShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskFbo.texture);
    this.edgeShader.setInt('u_mask', 0);
    this.edgeShader.setVec2('u_texelSize', 1 / this.maskFbo.width, 1 / this.maskFbo.height);
    const sel = themeViewport.selection;
    this.edgeShader.setVec3('u_selectionColor', new Vec3(sel[0], sel[1], sel[2]));
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.fullscreen.drawTriangles(3);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }
}
