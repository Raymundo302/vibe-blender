import { Shader } from '../gl/Shader';
import type { Mat4 } from '../../core/math/mat4';

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_faceN1; // adjacent face normals (object space);
layout(location = 2) in vec3 a_faceN2; // boundary edges carry n1 twice
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // view-space normal matrix (view * model)
uniform float u_zBias;    // NDC pull toward the camera, so wires win the depth
                          // fight against the faces they sit on (overlay /
                          // hidden-line modes); 0 for the classic wireframe.
uniform float u_hideBack; // 1 = cull edges whose BOTH faces face away. Without
                          // it, hidden edges poke through at shared silhouette
                          // corners: right at the corner vertex their depth
                          // equals the surface's, so the bias lets a short
                          // stub of each back edge win the depth test.
void main() {
  vec4 viewPos = u_view * u_model * vec4(a_position, 1.0);
  gl_Position = u_proj * viewPos;
  gl_Position.z -= u_zBias * gl_Position.w;
  if (u_hideBack > 0.5) {
    bool front1 = dot(u_normalMat * a_faceN1, viewPos.xyz) < 0.0;
    bool front2 = dot(u_normalMat * a_faceN2, viewPos.xyz) < 0.0;
    // Both adjacent faces away -> push the vertex far behind (same screen xy,
    // depth beyond everything) so the segment depth-fails everywhere.
    if (!front1 && !front2) gl_Position.z = gl_Position.w;
  }
}`;

// Solid dark lines, no fill. Depth test is on so nearer wires occlude the grid,
// but with no solid pass behind them every edge (front and back) stays visible —
// the classic wireframe look.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(0.05, 0.05, 0.06, 1.0);
}`;

/**
 * Wireframe solid pass: draws each object's unique edges as dark lines. The
 * per-object edge VertexArray (position-only) is owned + cached by the Renderer;
 * this pass only owns the shader and sets uniforms.
 */
export class WirePass {
  readonly shader: Shader;

  constructor(gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-wire');
  }

  /** Bind per-frame state; per-object uniforms are set by the caller.
   *  `zBias` > 0 pulls lines toward the camera (see u_zBias); `hideBack`
   *  culls edges with no camera-facing adjacent face (see u_hideBack). */
  begin(view: Mat4, proj: Mat4, zBias = 0, hideBack = false): void {
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setFloat('u_zBias', zBias);
    this.shader.setFloat('u_hideBack', hideBack ? 1 : 0);
  }

  setObject(model: Mat4, view: Mat4): void {
    this.shader.setMat4('u_model', model);
    this.shader.setMat3('u_normalMat', view.mul(model).normalMatrix());
  }
}
