import { Shader } from '../gl/Shader';
import { Vec3 } from '../../core/math/vec3';
import { RIBBON_EXPAND_GLSL, WIRE_MIN_PX, WIRE_MAX_PX } from './ribbon';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Wireframe solid pass: draws each object's unique edges as anti-aliased screen-
 * space RIBBONS (UR6-1) — was 1px gl.LINES, which is jagged and whose lineWidth
 * is capped at 1 on ANGLE/core profiles. Each edge segment is expanded into two
 * triangles in the vertex shader (see ribbon.ts): the pixel width scales with
 * view proximity and the outer ~1px fades out for anti-aliasing. Applies to the
 * wireframe shading mode, the Wireframe overlay and Hidden Line.
 *
 * The per-object ribbon VertexArray (built by buildWireRibbon, cached by the
 * Renderer per gpuMesh version) carries, per ribbon vertex:
 *   location 0  a_position  this endpoint (object space)
 *   location 1  a_other     the segment's other endpoint (object space)
 *   location 2  a_param     [extrusion sign, geometric side]
 *   location 3  a_faceN1    adjacent face normal 1 (hideBack; boundary → repeat)
 *   location 4  a_faceN2    adjacent face normal 2
 *   location 5  a_color     per-endpoint tint (white for mesh wires)
 */

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_other;
layout(location = 2) in vec2 a_param;
layout(location = 3) in vec3 a_faceN1; // adjacent face normals (object space);
layout(location = 4) in vec3 a_faceN2; // boundary edges carry n1 twice
layout(location = 5) in vec3 a_color;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // view-space normal matrix (view * model)
uniform float u_zBias;    // FRACTIONAL view-space pull toward the eye, so wires
                          // win the depth fight against the faces they sit on
                          // (overlay / hidden-line modes); 0 for the classic
                          // wireframe. Fraction-of-distance, NOT a constant NDC
                          // shift: NDC depth compresses far from the camera, so
                          // a constant 0.002 NDC bias out-shifted the entire
                          // depth separation between OBJECTS a few units apart
                          // once the camera stepped back — edges of hidden
                          // geometry drew straight through the mesh in front.
                          // Pulling by a fixed fraction of view distance keeps
                          // the margin proportional at every range (leaks only
                          // within ~bias*z of a surface, mm–cm scale).
uniform float u_hideBack; // 1 = cull edges whose BOTH faces face away. Without
                          // it, hidden edges poke through at shared silhouette
                          // corners: right at the corner vertex their depth
                          // equals the surface's, so the bias lets a short
                          // stub of each back edge win the depth test.
uniform vec2 u_viewport;  // canvas size in px (ribbon width in px → clip)
uniform float u_refDist;  // camera orbit distance (proximity width reference)
uniform float u_minPx;    // ribbon clamp bounds (px) from prefs; proximity off
uniform float u_maxPx;    // passes both = wireMaxPx → constant width
out float v_side;
out float v_halfPx;
out vec3 v_color;
${RIBBON_EXPAND_GLSL}
vec4 clipOf(vec3 objP, out float viewDist) {
  vec4 viewPos = u_view * u_model * vec4(objP, 1.0);
  viewDist = length(viewPos.xyz);         // distance from the eye (view origin)
  viewPos.xyz *= (1.0 - u_zBias);         // radial: screen position unchanged
  vec4 c = u_proj * viewPos;
  c.z -= 2e-5 * c.w;                      // few-ULP epsilon for raster noise
  return c;
}
void main() {
  float dThis, dOther;
  vec4 c0 = clipOf(a_position, dThis);
  vec4 c1 = clipOf(a_other, dOther);
  float hp;
  gl_Position = wireExpandW(c0, c1, dThis, u_refDist, u_viewport, a_param.x, u_minPx, u_maxPx, hp);
  v_side = a_param.y;
  v_halfPx = hp;
  v_color = a_color;
  if (u_hideBack > 0.5) {
    vec3 vp = (u_view * u_model * vec4(a_position, 1.0)).xyz;
    bool front1 = dot(u_normalMat * a_faceN1, vp) < 0.0;
    bool front2 = dot(u_normalMat * a_faceN2, vp) < 0.0;
    // Both adjacent faces away -> push the vertex far behind (same screen xy,
    // depth beyond everything) so the segment depth-fails everywhere.
    if (!front1 && !front2) gl_Position.z = gl_Position.w;
  }
}`;

// Mesh-wire fragment: the shared RIBBON_FRAG AA (soft ~1px rim) plus an OPTIONAL
// cavity multiply. Cavity applies in wireframe HIDDEN-LINE mode — the wires sit
// exactly on the convex edges / concave creases the curvature signal is
// strongest at, so multiplying the wire color by the cavity factor reads the
// surface detail (ridges brighten, valleys darken). u_cavityOn defaults to 0 →
// bit-identical to RIBBON_FRAG for the wireframe/overlay/see-through paths that
// don't bind it (the edit cage keeps the shared RIBBON_FRAG untouched).
const WIRE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_side;
in float v_halfPx;
in vec3 v_color;
uniform vec3 u_color;
// highp: the factor reaches 4.0, past lowp's guaranteed range — sampler2D
// defaults to lowp in ES fragment shaders and radeonsi honors it (the AO-saga
// lesson, 2026-07-08).
uniform highp sampler2D u_cavity; // full-res AO·cavity factor (bound only when on)
uniform vec2 u_cavityTexel;      // 1 / canvas size
uniform float u_cavityOn;        // 1 → modulate wire color by cavity, 0 → no-op
out vec4 outColor;
void main() {
  float edgeDistPx = (1.0 - abs(v_side)) * v_halfPx;
  float alpha = clamp(edgeDistPx, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  vec3 col = u_color * v_color;
  if (u_cavityOn > 0.5) col *= texture(u_cavity, gl_FragCoord.xy * u_cavityTexel).r;
  outColor = vec4(col, alpha);
}`;

// Simple position-only depth-prime shader: draws the solid TRIANGLES into the
// depth buffer (color masked off by the caller) so hidden-line wireframe can
// depth-test its wires against the faces. Kept separate from the ribbon shader
// because the ribbon shader interprets locations 1/2 as a_other/a_param — the
// triangles VAO's normal/color at those slots would corrupt the expansion.
const PRIME_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_position, 1.0); }`;

const PRIME_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

const WIRE_DARK = new Vec3(0.05, 0.05, 0.06); // wireframe-mode theme color

export class WirePass {
  readonly shader: Shader;
  private readonly primeShader: Shader;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, WIRE_FRAG, 'mesh-wire');
    this.primeShader = new Shader(gl, PRIME_VERT, PRIME_FRAG, 'mesh-wire-prime');
  }

  /** Bind per-frame ribbon state; per-object uniforms are set by setObject.
   *  `zBias` > 0 pulls lines toward the camera (see u_zBias); `hideBack` culls
   *  edges with no camera-facing adjacent face; width/height = canvas px;
   *  `refDist` = camera orbit distance for the proximity width; `color` tints
   *  the ribbon (default dark for the classic wireframe look). */
  begin(
    view: Mat4, proj: Mat4, zBias = 0, hideBack = false,
    width = 1, height = 1, refDist = 8, color: Vec3 = WIRE_DARK,
    minPx = WIRE_MIN_PX, maxPx = WIRE_MAX_PX,
    /** Cavity (wireframe hidden-line): the full-res AO·cavity factor texture and
     *  canvas size. null → no cavity (u_cavityOn=0, bit-identical old behavior). */
    cavity: { texture: WebGLTexture; width: number; height: number } | null = null,
  ): void {
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setFloat('u_zBias', zBias);
    this.shader.setFloat('u_hideBack', hideBack ? 1 : 0);
    this.shader.setVec2('u_viewport', width, height);
    this.shader.setFloat('u_refDist', refDist);
    this.shader.setVec3('u_color', color);
    this.shader.setFloat('u_minPx', minPx);
    this.shader.setFloat('u_maxPx', maxPx);
    this.shader.setFloat('u_cavityOn', cavity ? 1 : 0);
    if (cavity) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, cavity.texture);
      this.shader.setInt('u_cavity', 1);
      this.shader.setVec2('u_cavityTexel', 1 / cavity.width, 1 / cavity.height);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  setObject(model: Mat4, view: Mat4): void {
    this.shader.setMat4('u_model', model);
    this.shader.setMat3('u_normalMat', view.mul(model).normalMatrix());
  }

  /** Depth-prime phase (hidden-line wireframe): draw the solid triangles into
   *  the depth buffer only. Bind, then call primeObject(mvp) per object and draw
   *  its TRIANGLES with the color mask off. */
  beginPrime(): void {
    this.primeShader.use();
  }

  primeObject(mvp: Mat4): void {
    this.primeShader.setMat4('u_mvp', mvp);
  }
}
