import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';

/**
 * Plain-axes display for empty objects (UR5-7): three world-axis-aligned line
 * pairs through the object's origin, `displaySize` long in each direction, drawn
 * in the object's selection tint (like the light aim arrows in lightDirPass).
 * Rides the overlays.icons toggle. Kept DOM-free and scale-independent — the
 * empty's own scale/rotation don't skew the world-aligned cross (Blender's plain
 * axes are a fixed size handle).
 */

/** LINE-list vertices for a unit cross (scaled by displaySize in the model). */
function axesLineData(): Float32Array {
  return new Float32Array([
    -1, 0, 0, 1, 0, 0, // world X
    0, -1, 0, 0, 1, 0, // world Y
    0, 0, -1, 0, 0, 1, // world Z
  ]);
}

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_position, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

export class EmptyAxesPass {
  private readonly shader: Shader;
  private readonly lines: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'empty-axes');
    this.lines = new VertexArray(gl, [
      { location: 0, size: 3, data: axesLineData() },
    ]);
  }

  /** Bind the shader once, then draw() per empty. */
  begin(): void {
    this.shader.use();
  }

  /**
   * Draw one empty's plain axes. `position` is the empty's WORLD origin; the
   * cross is world-axis-aligned (no rotation) and scaled by `displaySize`.
   */
  draw(viewProj: Mat4, position: Vec3, displaySize: number, color: readonly [number, number, number]): void {
    const model = Mat4.translation(position).mul(Mat4.scaling(new Vec3(displaySize, displaySize, displaySize)));
    this.shader.setMat4('u_mvp', viewProj.mul(model));
    this.shader.setVec4('u_color', color[0], color[1], color[2], 1);
    this.lines.draw(this.gl.LINES);
  }
}
