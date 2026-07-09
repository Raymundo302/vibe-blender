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
uniform sampler2D u_ao;   // blurred SSAO, sampled by fragment coord (white when off)
uniform vec2 u_aoTexel;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_viewNormal);
  // Blender-studiolight-style rig: WRAPPED key + fill so shading rolls off
  // gently past the terminator, plus a hemispheric ambient. Hard N.L with a
  // small constant ambient left any face perpendicular to both lights nearly
  // black — whole cube faces went dark at certain orbit angles.
  vec3 keyDir  = normalize(vec3(0.35, 0.5, 0.78));   // upper-right, camera side
  vec3 fillDir = normalize(vec3(-0.65, -0.1, 0.3));  // opposite side, still frontal
  vec3 keyCol  = vec3(1.0, 0.97, 0.9) * 0.72;
  vec3 fillCol = vec3(0.8, 0.87, 1.0) * 0.24;
  const float WRAP = 0.4;
  float k = clamp((dot(n, keyDir) + WRAP) / (1.0 + WRAP), 0.0, 1.0);
  float f = clamp((dot(n, fillDir) + WRAP) / (1.0 + WRAP), 0.0, 1.0);
  // Hemispheric ambient: camera-facing surfaces sit a touch brighter.
  float hemi = mix(0.15, 0.26, n.z * 0.5 + 0.5);
  vec3 lit = vec3(hemi) + keyCol * k + fillCol * f;
  vec3 base = u_color * v_tint;
  float ao = texture(u_ao, gl_FragCoord.xy * u_aoTexel).r;
  outColor = vec4(base * lit * ao, 1.0);
}`;

/** Flat lambert solid pass with a fixed two-light view-space studio rig. */
export class StudioPass {
  readonly shader: Shader;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-studio');
  }

  /** Bind per-frame state; per-object uniforms are set by the caller.
   *  `ao` is the SSAO texture, or the AoPass 1×1 white when AO is off. */
  begin(view: Mat4, proj: Mat4, ao: WebGLTexture, aoW: number, aoH: number): void {
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ao);
    this.shader.setInt('u_ao', 0);
    this.shader.setVec2('u_aoTexel', 1 / aoW, 1 / aoH);
  }

  setObject(model: Mat4, view: Mat4, color: readonly [number, number, number]): void {
    this.shader.setMat4('u_model', model);
    this.shader.setMat3('u_normalMat', view.mul(model).normalMatrix());
    this.shader.setVec3('u_color', new Vec3(color[0], color[1], color[2]));
  }
}
