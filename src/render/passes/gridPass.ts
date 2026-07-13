import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';

const EXTENT = 500;

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat4 u_plane;   // work-plane transform (identity = world XY floor)
out vec3 v_worldPos;
out vec2 v_coord;       // plane-local grid coordinates

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
  // a_position spans the big quad in plane-LOCAL space (XY); u_plane orients it
  // into the world. The grid pattern uses the local coords so a reoriented plane
  // draws its lines in-plane and centered on the plane origin.
  v_coord = a_position.xy;
  vec4 world = u_plane * vec4(a_position, 1.0);
  v_worldPos = world.xyz;
  vec4 viewPos = u_view * world;
  viewPos.xyz *= (1.0 + GRID_ZBIAS);   // radial push back: screen xy unchanged
  gl_Position = u_proj * viewPos;
}`;

// Antialiased 1-unit grid on the (plane-local) ground plane, axis lines tinted
// (local X / local Y — Blender's floor axis colors), fading with distance. The
// grey floor lines can be toggled off independently of the axis lines.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec2 v_coord;
uniform vec3 u_eye;
uniform vec3 u_gridColor;
uniform vec3 u_axisXColor;
uniform vec3 u_axisYColor;
uniform float u_fade;    // distance at which the grid fully fades (world units)
uniform float u_floor;   // 1 = show grey floor lines, 0 = axes only
out vec4 outColor;

float gridLine(vec2 coord) {
  vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main() {
  vec2 coord = v_coord;
  float minor = gridLine(coord);
  float major = gridLine(coord / 10.0);

  vec3 color = u_gridColor;
  float alpha = (minor * 0.35 + major * 0.45) * u_floor;

  // Axis lines through the (plane-local) origin — always drawn, floor or not.
  vec2 axisDist = abs(coord) / fwidth(coord);
  if (axisDist.y < 1.0) { // along local X (y ≈ 0)
    color = u_axisXColor;
    alpha = max(alpha, 1.0 - axisDist.y);
  }
  if (axisDist.x < 1.0) { // along local Y (x ≈ 0)
    color = u_axisYColor;
    alpha = max(alpha, 1.0 - axisDist.x);
  }

  float dist = length(v_worldPos - u_eye);
  alpha *= clamp(1.0 - dist / max(u_fade, 1.0), 0.0, 1.0);
  if (alpha < 0.002) discard;
  outColor = vec4(color, alpha);
}`;

/** Options for a grid draw — colors + fade come from overlay prefs, `plane`
 *  reorients the grid onto a work plane (identity = the world XY floor). */
export interface GridOptions {
  gridColor: Vec3;
  axisXColor: Vec3;
  axisYColor: Vec3;
  /** Distance (world units) at which the grid fully fades. */
  fade: number;
  /** Show the grey floor lines (axis lines are always drawn). */
  floor: boolean;
  /** Work-plane transform; identity draws the world XY floor grid. */
  plane?: Mat4;
}

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
  render(view: Mat4, proj: Mat4, eye: Vec3, opts: GridOptions): void {
    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setMat4('u_plane', opts.plane ?? Mat4.identity());
    this.shader.setVec3('u_eye', eye);
    this.shader.setVec3('u_gridColor', opts.gridColor);
    this.shader.setVec3('u_axisXColor', opts.axisXColor);
    this.shader.setVec3('u_axisYColor', opts.axisYColor);
    this.shader.setFloat('u_fade', opts.fade);
    this.shader.setFloat('u_floor', opts.floor ? 1 : 0);
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
