import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { encodeId } from './pickingPass';
import type { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';

/**
 * Screen-facing billboard icons for non-mesh objects (lights, cameras) — the
 * little viewport glyphs Blender shows, and their pick-buffer footprint so
 * they are click-selectable despite having no triangles.
 *
 * One icon = a constant-screen-size quad at the object's origin with a
 * procedural glyph in the fragment shader:
 *   shape 0 — point light  (circle + center dot)
 *   shape 1 — sun          (circle + rays)
 *   shape 2 — spot light   (downward cone)
 *   shape 3 — camera       (body + lens triangle)
 */

export type IconShape = 0 | 1 | 2 | 3;

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner; // -1..1 unit quad
uniform mat4 u_viewProj;
uniform vec3 u_center;    // world-space anchor
uniform float u_sizePx;   // icon half-size in device px
uniform vec2 u_viewport;  // device px
out vec2 v_uv;
void main() {
  vec4 clip = u_viewProj * vec4(u_center, 1.0);
  clip.xy += a_corner * (u_sizePx * 2.0 / u_viewport) * clip.w;
  v_uv = a_corner;
  gl_Position = clip;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_color;
uniform float u_shape;
uniform vec4 u_pickColor;  // a > 0 → pick mode: flat id color over the whole quad
out vec4 outColor;

// Signed "inside-ness" per glyph; alpha 0 outside.
float glyph(vec2 p, float shape) {
  float r = length(p);
  if (shape < 0.5) {                    // point: ring + dot
    float ring = smoothstep(0.08, 0.02, abs(r - 0.55));
    float dot_ = smoothstep(0.22, 0.16, r);
    return max(ring, dot_);
  } else if (shape < 1.5) {             // sun: ring + 8 rays
    float ring = smoothstep(0.08, 0.02, abs(r - 0.38));
    float ang = atan(p.y, p.x);
    float ray = smoothstep(0.35, 0.9, cos(ang * 8.0) * 0.5 + 0.5)
              * step(0.55, r) * step(r, 0.95);
    return max(ring, ray);
  } else if (shape < 2.5) {             // spot: cone (triangle opening down) + dot
    float inTri = step(abs(p.x), (0.45 - p.y * 0.5) * 0.9) * step(-0.6, p.y) * step(p.y, 0.5);
    float edge = inTri * (1.0 - step(abs(p.x), (0.45 - p.y * 0.5) * 0.9 - 0.14)
                                * step(-0.46, p.y) * step(p.y, 0.36));
    float dot_ = smoothstep(0.16, 0.10, length(p - vec2(0.0, 0.62)));
    return max(edge, dot_);
  }                                     // camera: body rect + lens triangle
  float body = step(abs(p.x + 0.15), 0.45) * step(abs(p.y), 0.35);
  float lens = step(0.3, p.x) * step(p.x, 0.75) * step(abs(p.y), (p.x - 0.3) * 0.8);
  float fill = max(body, lens);
  float inner = step(abs(p.x + 0.15), 0.31) * step(abs(p.y), 0.21);
  return max(fill - inner * 0.85, 0.0);
}

void main() {
  if (u_pickColor.a > 0.0) { outColor = vec4(u_pickColor.rgb, 1.0); return; }
  float a = glyph(v_uv, u_shape);
  if (a < 0.05) discard;
  outColor = vec4(u_color, a);
}`;

export class IconPass {
  private readonly shader: Shader;
  private readonly quad: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'object-icon');
    this.quad = new VertexArray(gl, [
      { location: 0, size: 2, data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]) },
    ]);
  }

  /** Bind per-frame state. Call once, then draw()/drawPick() per icon. */
  begin(viewProj: Mat4, viewportW: number, viewportH: number): void {
    this.shader.use();
    this.shader.setMat4('u_viewProj', viewProj);
    this.shader.setVec2('u_viewport', viewportW, viewportH);
  }

  /** Draw a visible icon (blended, depth-tested against the scene). */
  draw(center: Vec3, shape: IconShape, color: [number, number, number], sizePx = 14): void {
    const gl = this.gl;
    this.shader.setVec3('u_center', center);
    this.shader.setFloat('u_shape', shape);
    this.shader.setFloat('u_sizePx', sizePx);
    this.shader.setVec4('u_pickColor', 0, 0, 0, 0);
    this.shader.setVec3('u_color', new Vec3(color[0], color[1], color[2]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.quad.draw(gl.TRIANGLES);
    gl.disable(gl.BLEND);
  }

  /**
   * Draw the icon's pick footprint (the full quad, a fatter target than the
   * glyph) into the CURRENTLY BOUND picking framebuffer. Uses this pass's own
   * shader, so call between pickingPass.begin()/end() and re-`use()` the
   * picking shader afterwards if more picking geometry follows.
   */
  drawPick(center: Vec3, pickId: number, sizePx = 14): void {
    this.shader.use();
    this.shader.setVec3('u_center', center);
    this.shader.setFloat('u_sizePx', sizePx);
    const [r, g, b] = encodeId(pickId);
    this.shader.setVec4('u_pickColor', r, g, b, 1);
    this.quad.draw(this.gl.TRIANGLES);
  }
}
