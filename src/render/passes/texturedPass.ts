import { Shader } from '../gl/Shader';
import { Vec3 } from '../../core/math/vec3';
import type { Mat4 } from '../../core/math/mat4';
import type { Material } from '../../core/scene/objectData';

/**
 * UR8-3 — the SHADELESS TEXTURED draw shared by two features:
 *
 *  - **Always Textured (part C):** in matcap / studio / wireframe modes, objects
 *    whose material has `alwaysTextured` render with THIS pass (their base-color
 *    texture, unlit) instead of the matcap/studio shader, so an image / HTML
 *    plane looks like itself in every shading mode. In wireframe mode the
 *    textured fill draws FIRST, wires on top.
 *  - **Alpha blend (part B):** the fragment outputs the texture's ALPHA, so the
 *    same pass draws `alphaBlend` planes in a blended second pass (back-to-front,
 *    depth-write off) in EVERY solid mode incl. Rendered.
 *
 * The color math mirrors the RenderedPass shadeless branch exactly (baseColor ×
 * tint × texture, × screen-space AO, then gamma) so an opaque always-textured
 * plane reads identically whether it draws here or through Rendered mode.
 */

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 2) in vec3 a_color; // per-face tint (white when unset)
layout(location = 3) in vec2 a_uv;    // per-corner UV
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
out vec3 v_tint;
out vec2 v_uv;
void main() {
  v_tint = a_color;
  v_uv = a_uv;
  gl_Position = u_proj * u_view * u_model * vec4(a_position, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_tint;
in vec2 v_uv;
uniform int u_texKind;     // 0 none, 1 checker, 2 image
uniform int u_hasTex;      // 1 when an image texture is bound
uniform sampler2D u_tex;   // base-color image (sRGB-encoded → sampled linear + alpha)
uniform vec3 u_baseColor;
uniform sampler2D u_ao;    // blurred SSAO (white when off)
uniform vec2 u_aoTexel;
uniform float u_alphaOn;   // 1 = use texture alpha (blend), 0 = force opaque
out vec4 outColor;
void main() {
  vec3 base = u_baseColor * v_tint;
  float alpha = 1.0;
  if (u_texKind == 1) {
    float parity = mod(floor(v_uv.x * 8.0) + floor(v_uv.y * 8.0), 2.0);
    base *= mix(vec3(0.2), vec3(1.0), parity);
  } else if (u_texKind == 2 && u_hasTex == 1) {
    vec4 t = texture(u_tex, v_uv);
    base *= t.rgb;
    alpha = t.a;
  }
  base *= texture(u_ao, gl_FragCoord.xy * u_aoTexel).r;
  base = pow(base, vec3(1.0 / 2.2)); // gamma (baseColor is linear)
  float a = mix(1.0, alpha, u_alphaOn);
  outColor = vec4(base, a);
}`;

/** Shadeless textured solid pass (Always Textured + alpha blend). */
export class TexturedPass {
  readonly shader: Shader;
  private readonly white: WebGLTexture;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-textured');
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** Bind per-frame camera + AO. `ao` is the SSAO texture (or AoPass white). */
  begin(view: Mat4, proj: Mat4, ao: WebGLTexture, aoW: number, aoH: number): void {
    const gl = this.gl;
    const s = this.shader;
    s.use();
    s.setMat4('u_view', view);
    s.setMat4('u_proj', proj);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ao);
    gl.activeTexture(gl.TEXTURE0);
    s.setInt('u_ao', 1);
    s.setVec2('u_aoTexel', 1 / aoW, 1 / aoH);
  }

  /**
   * Set per-object state. `tex` is the material's base-color GL texture (or null
   * for checker/none → the 1×1 white fallback binds). `alphaBlend` gates whether
   * the texture alpha is written (true → blended pass) or forced to 1 (opaque).
   */
  setObject(model: Mat4, mat: Material, tex: WebGLTexture | null, alphaBlend: boolean): void {
    const gl = this.gl;
    const s = this.shader;
    s.setMat4('u_model', model);
    s.setVec3('u_baseColor', new Vec3(mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]));
    s.setInt('u_texKind', mat.texKind === 'checker' ? 1 : mat.texKind === 'image' ? 2 : 0);
    s.setFloat('u_alphaOn', alphaBlend ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex ?? this.white);
    s.setInt('u_hasTex', tex ? 1 : 0);
    s.setInt('u_tex', 0);
  }
}
