import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import type { Mat4 } from '../../core/math/mat4';
import type { Vec3 } from '../../core/math/vec3';

const EXTENT = 500;

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_view;
uniform mat4 u_proj;
out vec3 v_worldPos;
void main() {
  v_worldPos = a_position;
  gl_Position = u_proj * u_view * vec4(a_position, 1.0);
}`;

// Antialiased 1-unit grid on the XZ ground plane, axis lines tinted
// (X red, Z green — Blender's floor axis colors), fading with distance.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
uniform vec3 u_eye;
out vec4 outColor;

float gridLine(vec2 coord) {
  vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec2 coord = v_worldPos.xz;
  float minor = gridLine(coord);
  float major = gridLine(coord / 10.0);

  vec3 color = vec3(0.32);
  float alpha = minor * 0.35 + major * 0.45;

  // Axis lines through the origin
  vec2 axisDist = abs(coord) / fwidth(coord);
  if (axisDist.y < 1.0) { // along X (z ≈ 0)
    color = vec3(0.65, 0.28, 0.32);
    alpha = max(alpha, 1.0 - axisDist.y);
  }
  if (axisDist.x < 1.0) { // along Z (x ≈ 0)
    color = vec3(0.35, 0.55, 0.28);
    alpha = max(alpha, 1.0 - axisDist.x);
  }

  float dist = length(v_worldPos - u_eye);
  alpha *= clamp(1.0 - dist / 120.0, 0.0, 1.0);
  if (alpha < 0.002) discard;
  outColor = vec4(color, alpha);
}`;

export class GridPass {
  private readonly shader: Shader;
  private readonly quad: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'grid');
    const e = EXTENT;
    this.quad = new VertexArray(gl, [
      {
        location: 0,
        size: 3,
        data: new Float32Array([
          -e, 0, -e, e, 0, -e, e, 0, e,
          -e, 0, -e, e, 0, e, -e, 0, e,
        ]),
      },
    ]);
  }

  /** Draw after opaque geometry: blended, depth-tested, no depth write. */
  render(view: Mat4, proj: Mat4, eye: Vec3): void {
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setVec3('u_eye', eye);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE); // grid is visible from below the floor too
    this.quad.draw(gl.TRIANGLES);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
