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

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_viewNormal;
in vec3 v_tint;
uniform sampler2D u_matcap;
uniform vec3 u_color; // per-object viewport tint (0..1)
// Matcap exposure: 2.0 for the procedural Studio map (the historical constant),
// ~1.45 for image matcaps so a default-grey object shows them as authored
// (see render/matcaps.ts).
uniform float u_matcapGain;
uniform sampler2D u_ao;   // blurred SSAO, sampled by fragment coord (white when off)
uniform vec2 u_aoTexel;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_viewNormal);
  if (!gl_FrontFacing) n = -n; // two-sided solid shading — light the back face too
  vec2 uv = n.xy * 0.495 + 0.5;
  float ao = texture(u_ao, gl_FragCoord.xy * u_aoTexel).r;
  outColor = vec4(texture(u_matcap, uv).rgb * u_matcapGain * u_color * v_tint * ao, 1.0);
}`;

/** Matcap-shaded solid mesh pass. */
export class MeshPass {
  readonly shader: Shader;
  /** Matcap exposure multiplier (see FRAG comment); the gallery sets it with
   *  the texture so procedural vs image maps each display as authored. */
  private gain = 2.0;

  constructor(gl: WebGL2RenderingContext, private matcap: WebGLTexture) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-matcap');
    this.gl = gl;
  }
  private readonly gl: WebGL2RenderingContext;

  /** Swap the sampled matcap texture + its gain (the gallery's entry point). */
  setMatcap(tex: WebGLTexture, gain: number): void {
    this.matcap = tex;
    this.gain = gain;
  }

  /** Bind per-frame state; per-object uniforms are set by the caller.
   *  `ao` is the SSAO texture, or the AoPass 1×1 white when AO is off. */
  begin(view: Mat4, proj: Mat4, ao: WebGLTexture, aoW: number, aoH: number): void {
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.matcap);
    this.shader.setInt('u_matcap', 0);
    this.shader.setFloat('u_matcapGain', this.gain);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ao);
    gl.activeTexture(gl.TEXTURE0);
    this.shader.setInt('u_ao', 1);
    this.shader.setVec2('u_aoTexel', 1 / aoW, 1 / aoH);
  }

  setObject(model: Mat4, view: Mat4, color: readonly [number, number, number]): void {
    this.shader.setMat4('u_model', model);
    this.shader.setMat3('u_normalMat', view.mul(model).normalMatrix());
    this.shader.setVec3('u_color', new Vec3(color[0], color[1], color[2]));
  }
}
