import { Shader } from '../gl/Shader';
import { Vec3 } from '../../core/math/vec3';
import type { Mat4 } from '../../core/math/mat4';

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec3 a_color; // per-face tint (white when unset)
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // view-space normal matrix
out vec3 v_viewNormal;
out vec3 v_tint;
void main() {
  v_viewNormal = u_normalMat * a_normal;
  v_tint = a_color;
  gl_Position = u_proj * u_view * u_model * vec4(a_position, 1.0);
}`;

// Flat two-light lambert "studio" shading. Both lights live in VIEW space, so
// they stay fixed relative to the camera as it orbits (like a studio rig bolted
// to the lens). Plain N·L (no half-lambert), no specular.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_viewNormal;
in vec3 v_tint;
uniform vec3 u_color; // per-object base albedo (0..1)
out vec4 outColor;
void main() {
  vec3 n = normalize(v_viewNormal);
  // Key light: warm white, from upper-right-front. Fill: cool, from lower-left-back.
  vec3 keyDir  = normalize(vec3(0.4, 0.6, 0.7));
  vec3 fillDir = normalize(vec3(-0.5, -0.2, -0.4));
  vec3 keyCol  = vec3(1.0, 0.96, 0.88) * 0.9;
  vec3 fillCol = vec3(0.78, 0.86, 1.0) * 0.35;
  float k = max(dot(n, keyDir), 0.0);
  float f = max(dot(n, fillDir), 0.0);
  vec3 lit = vec3(0.12) + keyCol * k + fillCol * f;
  vec3 base = u_color * v_tint;
  outColor = vec4(base * lit, 1.0);
}`;

/** Flat lambert solid pass with a fixed two-light view-space studio rig. */
export class StudioPass {
  readonly shader: Shader;

  constructor(gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-studio');
  }

  /** Bind per-frame state; per-object uniforms are set by the caller. */
  begin(view: Mat4, proj: Mat4): void {
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
  }

  setObject(model: Mat4, view: Mat4, color: readonly [number, number, number]): void {
    this.shader.setMat4('u_model', model);
    this.shader.setMat3('u_normalMat', view.mul(model).normalMatrix());
    this.shader.setVec3('u_color', new Vec3(color[0], color[1], color[2]));
  }
}
