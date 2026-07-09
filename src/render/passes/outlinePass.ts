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
void main() {
  vec2 uv = gl_FragCoord.xy * u_texelSize;
  float center = texture(u_mask, uv).r;
  if (center > 0.5) discard; // interior stays clear — outline sits just outside
  // Averaged 8-tap circular kernel instead of a binary max: coverage falls off
  // with distance from the silhouette, giving the outline a soft (anti-aliased)
  // edge instead of a hard 1-bit staircase.
  float w = 1.5;
  float d = w * 0.7071; // diagonal taps at the same radius → circular kernel
  float n = 0.0;
  n += texture(u_mask, uv + vec2( w, 0.0) * u_texelSize).r;
  n += texture(u_mask, uv + vec2(-w, 0.0) * u_texelSize).r;
  n += texture(u_mask, uv + vec2(0.0,  w) * u_texelSize).r;
  n += texture(u_mask, uv + vec2(0.0, -w) * u_texelSize).r;
  n += texture(u_mask, uv + vec2( d,  d) * u_texelSize).r;
  n += texture(u_mask, uv + vec2(-d,  d) * u_texelSize).r;
  n += texture(u_mask, uv + vec2( d, -d) * u_texelSize).r;
  n += texture(u_mask, uv + vec2(-d, -d) * u_texelSize).r;
  float edge = n / 8.0; // fraction of the kernel inside the silhouette
  if (edge <= 0.001) discard;
  outColor = vec4(u_selectionColor, clamp(edge * 2.2, 0.0, 1.0));
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
