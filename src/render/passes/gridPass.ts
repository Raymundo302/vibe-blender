import { Shader } from '../gl/Shader';
import { themeViewport } from '../../ui/themes';
import { VertexArray } from '../gl/VertexArray';
import type { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';

const EXTENT = 500;

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_view;
uniform mat4 u_proj;
out vec3 v_worldPos;

// FRACTIONAL depth push AWAY from the eye (opposite sign to wirePass's pull), so
// exactly-coplanar mesh faces at z=0 win the depth fight cleanly and the ground
// grid stops z-fighting into dashes under them (e.g. the donut's Table). Mirrors
// wirePass's convention: a fraction of view distance, NOT a constant NDC shift —
// NDC depth compresses far from the camera, so a fixed NDC bias would over-push
// once the camera steps back; a fixed fraction keeps the margin proportional at
// every range (grid loses only within ~bias*z of a surface, mm–cm scale). The
// grid still depth-TESTS, so geometry in front continues to occlude it.
const float GRID_ZBIAS = 0.0005;

void main() {
  v_worldPos = a_position;
  vec4 viewPos = u_view * vec4(a_position, 1.0);
  viewPos.xyz *= (1.0 + GRID_ZBIAS);   // radial push back: screen xy unchanged
  gl_Position = u_proj * viewPos;
}`;

// Antialiased 1-unit grid on the XY ground plane (Z-up world), axis lines
// tinted (X red, Y green — Blender's floor axis colors), fading with distance.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
uniform vec3 u_eye;
uniform vec3 u_gridColor;
uniform vec3 u_axisXColor;
uniform vec3 u_axisYColor;
out vec4 outColor;

float gridLine(vec2 coord) {
  vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec2 coord = v_worldPos.xy;
  float minor = gridLine(coord);
  float major = gridLine(coord / 10.0);

  vec3 color = u_gridColor;
  float alpha = minor * 0.35 + major * 0.45;

  // Axis lines through the origin
  vec2 axisDist = abs(coord) / fwidth(coord);
  if (axisDist.y < 1.0) { // along X (y ≈ 0)
    color = u_axisXColor;
    alpha = max(alpha, 1.0 - axisDist.y);
  }
  if (axisDist.x < 1.0) { // along Y (x ≈ 0)
    color = u_axisYColor;
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
          -e, -e, 0, e, -e, 0, e, e, 0,
          -e, -e, 0, e, e, 0, -e, e, 0,
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
    const tv = themeViewport;
    this.shader.setVec3('u_gridColor', new Vec3(tv.grid[0], tv.grid[1], tv.grid[2]));
    this.shader.setVec3('u_axisXColor', new Vec3(tv.axisX[0], tv.axisX[1], tv.axisX[2]));
    this.shader.setVec3('u_axisYColor', new Vec3(tv.axisY[0], tv.axisY[1], tv.axisY[2]));
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
