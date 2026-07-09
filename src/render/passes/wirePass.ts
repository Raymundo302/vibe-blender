import { Shader } from '../gl/Shader';
import type { Mat4 } from '../../core/math/mat4';

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_zBias; // NDC pull toward the camera, so wires win the depth
                       // fight against the faces they sit on (overlay /
                       // hidden-line modes); 0 for the classic wireframe.
void main() {
  gl_Position = u_proj * u_view * u_model * vec4(a_position, 1.0);
  gl_Position.z -= u_zBias * gl_Position.w;
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
   *  `zBias` > 0 pulls lines toward the camera (see u_zBias). */
  begin(view: Mat4, proj: Mat4, zBias = 0): void {
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setFloat('u_zBias', zBias);
  }

  setObject(model: Mat4): void {
    this.shader.setMat4('u_model', model);
  }
}
